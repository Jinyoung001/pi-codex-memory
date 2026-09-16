// Phase 1: per-rollout extraction. Mirrors codex memories/write/src/phase1.rs (V1).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { redact, extractionOutput } from "../safety.js";
import { STAGE1, type MemoriesConfig } from "./config.ts";
import { complete, resolveMemoryModel, outputMode, textOf, usageOf, type Llm } from "./llm.ts";
import { renderSession, rolloutTokenLimit } from "./rollout.ts";
import { truncateTokens as truncateToTokens } from "./codex-truncate.ts";
import type { MemoryStore, Stage1Claim } from "./store.ts";
import { tieredEvidence, evidenceMessages, v2Output } from "./v2.ts";

export type Log = (s: string) => void;
export type Phase1Stats = { claimed: number; withOutput: number; noOutput: number; failed: number; released: number; tokens: number };

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");
const readPrompt = (n: string) => fs.readFileSync(path.join(PROMPTS, n), "utf8");

// Codex deserializes the complete response; fenced JSON or trailing prose is an error.
export function parseJsonObject(source: string): unknown {
  try { return JSON.parse(source); }
  catch { throw new Error("invalid extraction JSON"); } // Do not log JSON.parse's raw response excerpt.
}

export function prune(store: MemoryStore, cfg: MemoriesConfig, log: Log) {
  const n = store.pruneStage1OutputsForRetention(cfg.max_unused_days, STAGE1.PRUNE_BATCH_SIZE);
  if (n) log(`phase1: pruned ${n} stale stage-1 output row(s) older than ${cfg.max_unused_days} days`);
}

export async function run(store: MemoryStore, cfg: MemoriesConfig, llm: Llm, currentThreadId: string, log: Log, signal?: AbortSignal): Promise<Phase1Stats> {
  const stats: Phase1Stats = { claimed: 0, withOutput: 0, noOutput: 0, failed: 0, released: 0, tokens: 0 };
  if (signal?.aborted) return stats;
  const report = (message: string) => { try { log(redact(message)); } catch {} };
  const selection = resolveMemoryModel(llm, cfg.extract_model);
  const model = selection.model;
  store.setSetting("runtime:extraction",JSON.stringify({model:`${model.provider}/${model.id}`,selection:selection.selection,reason:selection.reason,output:outputMode(model)}));
  const system = readPrompt(cfg.version === "v2" ? "stage_one_system_v2.md" : "stage_one_system.md");
  const inputTpl = readPrompt(cfg.version === "v2" ? "stage_one_input_v2.md" : "stage_one_input.md");
  const claims = store.claimStage1JobsForStartup({
    currentThreadId, scanLimit: STAGE1.THREAD_SCAN_LIMIT, maxClaimed: cfg.max_rollouts_per_startup,
    maxAgeDays: cfg.max_rollout_age_days, minIdleHours: cfg.min_rollout_idle_hours, leaseSeconds: STAGE1.JOB_LEASE_SECONDS,
  });
  stats.claimed = claims.length;
  if (!claims.length) return stats;

  const tokenLimit = rolloutTokenLimit(model.contextWindow);
  const controllers = new Map(claims.map(c => [c.ownershipToken, new AbortController()]));
  const pending = new Set(claims);
  const heartbeat = setInterval(() => {
    for (const c of pending) try {
      if (!store.heartbeatStage1Job(c.thread.id, c.ownershipToken, STAGE1.JOB_LEASE_SECONDS)) controllers.get(c.ownershipToken)!.abort();
    } catch { controllers.get(c.ownershipToken)!.abort(); }
  }, STAGE1.JOB_HEARTBEAT_SECONDS * 1000);

  const job = async (claim: Stage1Claim) => {
    const { thread, ownershipToken } = claim;
    try {
      if (signal?.aborted) throw new Error("aborted");
      if (!store.heartbeatStage1Job(thread.id, ownershipToken, STAGE1.JOB_LEASE_SECONDS)) throw new Error('lost stage1 ownership');
      const requestSignal = AbortSignal.any([controllers.get(ownershipToken)!.signal, AbortSignal.timeout(STAGE1.REQUEST_TIMEOUT_SECONDS * 1000), ...(signal ? [signal] : [])]);
      const r = renderSession(thread.rolloutPath, cfg.tool_result_token_budget);
      if (r.id !== thread.id) throw new Error("session header identity mismatch");
      const contents = cfg.version === "v2" ? tieredEvidence(r.rows, tokenLimit) : truncateToTokens(r.text, tokenLimit);
      const user = inputTpl.replace("{{ rollout_path }}", () => thread.rolloutPath).replace("{{ rollout_cwd }}", () => thread.cwd).replace("{{ rollout_contents }}", () => contents).replace("{{ rollout_git_branch }}", () => thread.gitBranch ?? "unknown");
      const res = await complete(llm, model, { systemPrompt: system, messages: cfg.version === "v2" ? evidenceMessages(user) : [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] }, cfg.extract_thinking, requestSignal, undefined, cfg.version);
      if (requestSignal.aborted) throw new Error(requestSignal.reason instanceof Error && requestSignal.reason.name === 'TimeoutError' ? 'request timeout' : 'aborted');
      if (!store.heartbeatStage1Job(thread.id, ownershipToken, STAGE1.JOB_LEASE_SECONDS)) throw new Error('lost stage1 ownership');
      stats.tokens += usageOf(res).totalTokens ?? 0;
      if (res.stopReason !== "stop") throw new Error(`model stop reason: ${res.stopReason}${res.errorMessage ? ` (${res.errorMessage})` : ""}`);
      const parsed = parseJsonObject(textOf(res));
      const out = cfg.version === "v2" ? v2Output(parsed) : extractionOutput(parsed);
      const raw = redact(out.raw_memory), summary = redact(out.rollout_summary), slug = out.rollout_slug ? redact(out.rollout_slug) : null;
      if ((cfg.version !== "v2" && !raw.trim()) || !summary.trim()) {
        if (store.markStage1JobSucceededNoOutput(thread.id, ownershipToken)) stats.noOutput++; else stats.failed++;
        return;
      }
      if (store.markStage1JobSucceeded(thread.id, ownershipToken, Math.floor(thread.updatedAtMs / 1000), raw, summary, slug)) stats.withOutput++; else stats.failed++;
    } catch (e) {
      const reason = redact(e instanceof Error ? e.message : String(e));
      if (signal?.aborted) {
        // Shutdown cancellation is not a rollout failure: release without consuming retries or backoff.
        try { if (store.releaseStage1Job(thread.id, ownershipToken)) { stats.released++; return; } } catch {}
        stats.failed++; report(`phase1: could not release ${thread.id}; lease recovery required`); return;
      }
      stats.failed++;
      report(`phase1: job failed for thread ${thread.id}: ${reason}`);
      try { store.markStage1JobFailed(thread.id, ownershipToken, reason, STAGE1.JOB_RETRY_DELAY_SECONDS); }
      catch { report(`phase1: could not persist failure for ${thread.id}; lease recovery required`); }
    } finally { pending.delete(claim); }
  };
  const q = [...claims];
  try { await Promise.allSettled(Array.from({ length: Math.min(STAGE1.CONCURRENCY_LIMIT, q.length) }, async () => { while (q.length && !signal?.aborted) await job(q.shift()!); })); }
  finally {
    clearInterval(heartbeat);
    for (const c of q) try { if (store.releaseStage1Job(c.thread.id, c.ownershipToken)) stats.released++; else stats.failed++; }
    catch { stats.failed++; report(`phase1: could not release ${c.thread.id}; lease recovery required`); }
  }
  report(`phase1: ${stats.claimed} claimed, ${stats.withOutput} with output, ${stats.noOutput} no output, ${stats.failed} failed, ${stats.released} released, ${stats.tokens} tokens`);
  return stats;
}
