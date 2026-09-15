// Phase 1: per-rollout extraction. Mirrors codex memories/write/src/phase1.rs (V1).
import * as fs from "node:fs";
import * as path from "node:path";
import { redact, extractionOutput } from "../safety.js";
import { STAGE1, type MemoriesConfig } from "./config.ts";
import { complete, resolveModel, textOf, usageOf, type Llm } from "./llm.ts";
import { renderSession, rolloutTokenLimit, truncateToTokens } from "./rollout.ts";
import type { MemoryStore, Stage1Claim } from "./store.ts";

export type Log = (s: string) => void;
export type Phase1Stats = { claimed: number; withOutput: number; noOutput: number; failed: number; tokens: number };

const PROMPTS = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "prompts");
const readPrompt = (n: string) => fs.readFileSync(path.join(PROMPTS, n), "utf8");

export function parseJsonObject(s: string): any {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (fence) s = fence[1];
  const start = s.indexOf("{"); if (start < 0) throw new Error("no json object in output");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error("unterminated json object");
}

export function prune(store: MemoryStore, cfg: MemoriesConfig, log: Log) {
  const n = store.pruneStage1OutputsForRetention(cfg.max_unused_days, STAGE1.PRUNE_BATCH_SIZE);
  if (n) log(`phase1: pruned ${n} stale stage-1 output row(s) older than ${cfg.max_unused_days} days`);
}

export async function run(store: MemoryStore, cfg: MemoriesConfig, llm: Llm, currentThreadId: string, log: Log, signal?: AbortSignal): Promise<Phase1Stats> {
  const stats: Phase1Stats = { claimed: 0, withOutput: 0, noOutput: 0, failed: 0, tokens: 0 };
  const claims = store.claimStage1JobsForStartup({
    currentThreadId, scanLimit: STAGE1.THREAD_SCAN_LIMIT, maxClaimed: cfg.max_rollouts_per_startup,
    maxAgeDays: cfg.max_rollout_age_days, minIdleHours: cfg.min_rollout_idle_hours, leaseSeconds: STAGE1.JOB_LEASE_SECONDS,
  });
  stats.claimed = claims.length;
  if (!claims.length) return stats;

  const model = resolveModel(llm, cfg.extract_model);
  const system = readPrompt("stage_one_system.md");
  const inputTpl = readPrompt("stage_one_input.md");
  const tokenLimit = rolloutTokenLimit(model.contextWindow);

  const job = async (claim: Stage1Claim) => {
    const { thread, ownershipToken } = claim;
    try {
      if (signal?.aborted) throw new Error("aborted");
      const r = renderSession(thread.rolloutPath);
      if (!r.id) throw new Error("session header unreadable");
      const contents = truncateToTokens(r.text, tokenLimit);
      const user = inputTpl.replace("{{ rollout_path }}", thread.rolloutPath).replace("{{ rollout_cwd }}", thread.cwd).replace("{{ rollout_contents }}", contents);
      const res = await complete(llm, model, { systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] }, cfg.extract_thinking, signal);
      stats.tokens += usageOf(res).totalTokens ?? 0;
      if (res.stopReason !== "stop") throw new Error(`model stop reason: ${res.stopReason}${res.errorMessage ? ` (${res.errorMessage})` : ""}`);
      const out = extractionOutput(parseJsonObject(textOf(res)));
      const raw = redact(out.raw_memory), summary = redact(out.rollout_summary), slug = out.rollout_slug ? redact(out.rollout_slug) : null;
      if (!raw.trim() || !summary.trim()) {
        if (store.markStage1JobSucceededNoOutput(thread.id, ownershipToken)) stats.noOutput++; else stats.failed++;
        return;
      }
      if (store.markStage1JobSucceeded(thread.id, ownershipToken, Math.floor(thread.updatedAtMs / 1000), raw, summary, slug)) stats.withOutput++; else stats.failed++;
    } catch (e) {
      stats.failed++;
      const reason = (e as Error).message;
      log(`phase1: job failed for thread ${thread.id}: ${reason}`);
      store.markStage1JobFailed(thread.id, ownershipToken, reason, STAGE1.JOB_RETRY_DELAY_SECONDS);
    }
  };
  const q = [...claims];
  await Promise.all(Array.from({ length: Math.min(STAGE1.CONCURRENCY_LIMIT, q.length) }, async () => { while (q.length && !signal?.aborted) await job(q.shift()!); }));
  // Claims left unprocessed on abort: release so the next startup can retry immediately.
  for (const c of q) store.markStage1JobFailed(c.thread.id, c.ownershipToken, "aborted before start", 0);
  log(`phase1: ${stats.claimed} claimed, ${stats.withOutput} with output, ${stats.noOutput} no output, ${stats.failed} failed, ${stats.tokens} tokens`);
  return stats;
}
