// Phase 2: global consolidation. Mirrors codex memories/write/src/phase2.rs step order:
// claim lock → prepare git workspace → load selection → sync inputs → diff → (clean? succeed) →
// write diff file → run consolidation agent (heartbeating lease) → validate → reset baseline → succeed.
import * as fs from "node:fs";
import * as path from "node:path";
import { STAGE2, WORKSPACE_DIFF, type MemoriesConfig } from "./config.ts";
import { complete, resolveModel, textOf, toolCallsOf, usageOf, type Llm } from "./llm.ts";
import { RootJail, consolidationTools } from "./agent-tools.ts";
import { extensionsRoot, pruneOldExtensionResources, rebuildRawMemoriesFile, removeMemorySymlinks, syncRolloutSummaries, validateConsolidationArtifacts } from "./storage.ts";
import { memoryWorkspaceDiff, prepareMemoryWorkspace, resetMemoryWorkspaceBaseline, writeWorkspaceDiff } from "./workspace.ts";
import type { MemoryStore, Stage1Output } from "./store.ts";
import type { Log } from "./phase1.ts";

const PROMPTS = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "prompts");

const EXT_FOLDER_STRUCTURE = (extRoot: string) => `
Memory extensions (under ${extRoot}/):

- <extension_name>/instructions.md
  - Source-specific guidance for interpreting additional memory signals. If an
    extension folder exists, you must read its instructions.md to determine how to use this memory
    source.

If the user has any memory extensions, you MUST read the instructions for each extension to
determine how to use the memory source. If the workspace diff shows deleted extension resource files,
remove stale memories derived only from those resources. If it has no extension folders, continue
with the standard memory inputs only.
`;
const EXT_PRIMARY_INPUTS = (extRoot: string) => `
Optional source-specific inputs:
Under \`${extRoot}/\`:

- \`<extension_name>/instructions.md\`
  - If extension folders exist, read each instructions.md first and follow it when interpreting
    that extension's memory source.

If the workspace diff shows deleted memory extension resources, use that extension-specific deletion
signal to remove stale memories derived only from those resources.
`;

/** prompts.rs build_consolidation_prompt_for_version(V1) — same substitutions as Codex. */
export function buildConsolidationPrompt(root: string): string {
  const tpl = fs.readFileSync(path.join(PROMPTS, "consolidation.md"), "utf8");
  const extRoot = extensionsRoot(root);
  const hasExt = fs.existsSync(extRoot) && fs.statSync(extRoot).isDirectory();
  return tpl
    .replace(/\{\{\s*memory_root\s*\}\}/g, root)
    .replace(/\{\{\s*memory_extensions_folder_structure\s*\}\}/g, hasExt ? EXT_FOLDER_STRUCTURE(extRoot) : "")
    .replace(/\{\{\s*memory_extensions_primary_inputs\s*\}\}/g, hasExt ? EXT_PRIMARY_INPUTS(extRoot) : "")
    .replace(/\{\{\s*phase2_workspace_diff_file\s*\}\}/g, WORKSPACE_DIFF.FILENAME);
}

// pi-specific harness note: Codex's agent has a shell + file tools in a sandbox; ours has only the
// jailed tools below. Tell the model that, without changing the consolidation rules.
const HARNESS_NOTE = (root: string) => `

## Execution environment (pi harness)

You are running as an internal consolidation worker with file tools scoped to the memory root
\`${root}\`. All paths you pass to tools are relative to that root (e.g. \`MEMORY.md\`,
\`rollout_summaries/\`, \`skills/<name>/SKILL.md\`). There is no shell and no network. Do not try
to run scripts. Any script you place under \`skills/*/scripts/\` is stored only; it is never executed here.
When everything is written and validated, call the \`done\` tool once with a one-paragraph summary.`;

export type Phase2Result = "claimed_failed" | "skipped_running" | "skipped_cooldown" | "skipped_retry_unavailable" | "succeeded_no_workspace_changes" | "succeeded" | `failed_${string}`;

export async function run(store: MemoryStore, cfg: MemoriesConfig, llm: Llm, root: string, workerId: string, log: Log, opts: { force?: boolean; signal?: AbortSignal; onProgress?: (s: string) => void } = {}): Promise<Phase2Result> {
  // 1. Claim global lock.
  const claim = store.tryClaimGlobalPhase2Job(workerId, STAGE2.JOB_LEASE_SECONDS, { ignoreCooldown: opts.force });
  if (claim.outcome !== "claimed") return claim.outcome;
  const token = claim.ownershipToken;
  const fail = (reason: string): Phase2Result => { log(`phase2: ${reason}`); store.markGlobalPhase2JobFailed(token, reason, STAGE2.JOB_RETRY_DELAY_SECONDS); return `failed_${reason}` as Phase2Result; };

  // 2. Git baseline.
  try { prepareMemoryWorkspace(root); } catch (e) { return fail(`prepare_workspace: ${(e as Error).message}`); }

  // 3. Agent config: model must resolve before we mutate anything.
  let model: any;
  try { model = resolveModel(llm, cfg.consolidation_model); } catch (e) { return fail(`agent_config: ${(e as Error).message}`); }

  // 4. Load inputs.
  let selected: Stage1Output[];
  try { selected = store.getPhase2InputSelection(cfg.max_raw_memories_for_consolidation, cfg.max_unused_days); } catch (e) { return fail(`load_stage1_outputs: ${(e as Error).message}`); }
  const newWatermark = Math.max(claim.inputWatermark, ...selected.map(s => s.sourceUpdatedAt), 0);

  // 5. Sync workspace inputs.
  try { syncRolloutSummaries(root, selected); rebuildRawMemoriesFile(root, selected); pruneOldExtensionResources(root); }
  catch (e) { return fail(`sync_workspace_inputs: ${(e as Error).message}`); }

  // 6. Diff decides whether the agent runs.
  let diff; try { diff = memoryWorkspaceDiff(root); } catch (e) { return fail(`workspace_status: ${(e as Error).message}`); }
  let artifactsValid = true; try { validateConsolidationArtifacts(root); } catch { artifactsValid = false; }
  if (!diff.changes.length && artifactsValid && !opts.force) {
    store.markGlobalPhase2JobSucceededPreservingSelection(token, newWatermark);
    return "succeeded_no_workspace_changes";
  }

  // 7. Persist diff for the agent.
  try { writeWorkspaceDiff(root, diff); } catch (e) { return fail(`workspace_diff_file: ${(e as Error).message}`); }

  // 8+9. Run agent with heartbeats.
  const hb = setInterval(() => { try { if (!store.heartbeatGlobalPhase2Job(token, STAGE2.JOB_LEASE_SECONDS)) { log("phase2: lost lease during heartbeat"); ac.abort(); } } catch (e) { log(`phase2: heartbeat failed: ${(e as Error).message}`); ac.abort(); } }, STAGE2.JOB_HEARTBEAT_SECONDS * 1000);
  const ac = new AbortController();
  const onAbort = () => ac.abort(); opts.signal?.addEventListener("abort", onAbort);
  let completed = false, agentError = "";
  try {
    const r = await runConsolidationAgent(llm, model, cfg, root, log, ac.signal, opts.onProgress);
    completed = r.completed; agentError = r.error ?? "";
  } catch (e) { agentError = (e as Error).message; }
  finally { clearInterval(hb); opts.signal?.removeEventListener("abort", onAbort); }

  if (!completed) { try { removeMemorySymlinks(root); } catch {} return fail(`agent: ${agentError || "did not complete"}`); }
  try { validateConsolidationArtifacts(root); } catch (e) { return fail(`invalid_artifacts: ${(e as Error).message}`); }
  if (!store.heartbeatGlobalPhase2Job(token, STAGE2.JOB_LEASE_SECONDS)) return fail("lost_ownership_before_baseline_reset");
  try { resetMemoryWorkspaceBaseline(root); } catch (e) { return fail(`workspace_commit: ${(e as Error).message}`); }
  if (!store.markGlobalPhase2JobSucceeded(token, newWatermark, selected)) log("phase2: failed marking job succeeded after baseline reset");
  return "succeeded";
}

async function runConsolidationAgent(llm: Llm, model: any, cfg: MemoriesConfig, root: string, log: Log, signal: AbortSignal, onProgress?: (s: string) => void): Promise<{ completed: boolean; error?: string }> {
  const jail = new RootJail(root);
  const tools = consolidationTools(jail);
  const toolDefs = tools.map(t => t.def);
  const byName = new Map(tools.map(t => [t.def.name, t.run]));
  const systemPrompt = buildConsolidationPrompt(root) + HARNESS_NOTE(root);
  const messages: any[] = [{ role: "user", content: [{ type: "text", text: `Begin. Read \`${WORKSPACE_DIFF.FILENAME}\` first.` }], timestamp: Date.now() }];
  let tokens = 0;

  for (let turn = 0; turn < cfg.consolidation_max_turns; turn++) {
    if (signal.aborted) return { completed: false, error: "aborted" };
    const res = await complete(llm, model, { systemPrompt, messages, tools: toolDefs }, cfg.consolidation_thinking, signal);
    tokens += usageOf(res).totalTokens ?? 0;
    messages.push(res);
    const calls = toolCallsOf(res);
    if (res.stopReason === "error" || res.stopReason === "aborted") return { completed: false, error: res.errorMessage ?? res.stopReason };
    if (!calls.length) {
      if (res.stopReason === "stop") {
        // Model ended without calling done: treat as complete only if artifacts validate (Codex checks artifacts after AgentStatus::Completed).
        try { validateConsolidationArtifacts(root); return { completed: true }; } catch (e) { return { completed: false, error: `ended without done and artifacts invalid: ${(e as Error).message}` }; }
      }
      return { completed: false, error: `unexpected stop: ${res.stopReason}` };
    }
    let done = false;
    for (const call of calls) {
      const run = byName.get(call.name);
      let out: string, isError = false;
      if (!run) { out = `unknown tool: ${call.name}`; isError = true; }
      else { try { out = (await run(call.arguments ?? {})).content.map(c => c.text).join("\n"); } catch (e) { out = `error: ${(e as Error).message}`; isError = true; } }
      onProgress?.(`${call.name} ${JSON.stringify(call.arguments ?? {}).slice(0, 80)}`);
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: out.slice(0, 60_000) }], isError, timestamp: Date.now() });
      if (call.name === "done" && !isError) done = true;
    }
    if (done) { log(`phase2: agent done after ${turn + 1} turn(s), ${tokens} tokens`); return { completed: true }; }
  }
  return { completed: false, error: `exceeded consolidation_max_turns=${cfg.consolidation_max_turns}` };
}
