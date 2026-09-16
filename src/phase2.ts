// Phase 2: global consolidation. Mirrors codex memories/write/src/phase2.rs step order:
// claim lock → prepare git workspace → load selection → sync inputs → diff → (clean? succeed) →
// write diff file → run consolidation agent (heartbeating lease) → validate → reset baseline → succeed.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runPiConsolidationSession } from "./consolidation-session.ts";
import { STAGE2, WORKSPACE_DIFF, type MemoriesConfig } from "./config.ts";
import { resolveMemoryModel, type Llm } from "./llm.ts";
import { extensionsRoot, pruneOldExtensionResources, rebuildRawMemoriesFile, removeMemorySymlinks, syncRolloutSummaries, validateConsolidationArtifacts } from "./storage.ts";
import { memoryWorkspaceDiff, prepareMemoryWorkspace, resetMemoryWorkspaceBaseline, writeWorkspaceDiff } from "./workspace.ts";
import type { MemoryStore, Stage1Output } from "./store.ts";
import type { Log } from "./phase1.ts";
import { redact } from '../safety.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

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
export function buildConsolidationPrompt(root: string, version: "v1" | "v2" = "v1"): string {
  const tpl = fs.readFileSync(path.join(PROMPTS, version === "v2" ? "consolidation_v2.md" : "consolidation.md"), "utf8");
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
When everything is written, finish with your final response.`;

export type Phase2Result = "claimed_failed" | "skipped_running" | "skipped_cooldown" | "skipped_retry_unavailable" | "succeeded_no_workspace_changes" | "succeeded" | `failed_${string}`;

export async function run(store: MemoryStore, cfg: MemoriesConfig, llm: Llm, root: string, workerId: string, log: Log, opts: { force?: boolean; signal?: AbortSignal; onProgress?: (s: string) => void } = {}): Promise<Phase2Result> {
  if (opts.signal?.aborted) return 'failed_aborted';
  let ownedToken: string | undefined;
  const report: Log = message => { try { log(redact(message)); } catch {} };
  const fail = (reason: string): Phase2Result => {
    reason = redact(reason); report(`phase2: ${reason}`);
    try { if (ownedToken) store.markGlobalPhase2JobFailed(ownedToken, reason, STAGE2.JOB_RETRY_DELAY_SECONDS); } catch { report('phase2: failure persistence unavailable; lease recovery required'); }
    return `failed_${reason}`;
  };
  try {
  // 1. Claim global lock.
  const claim = store.tryClaimGlobalPhase2Job(workerId, STAGE2.JOB_LEASE_SECONDS, { ignoreCooldown: opts.force });
  if (claim.outcome !== "claimed") return claim.outcome;
  const token = claim.ownershipToken;
  ownedToken = token;
  const guarded = <T>(fn: () => T): T => store.withMutation(() => {
    if (opts.signal?.aborted) throw new Error('aborted');
    if (!store.heartbeatGlobalPhase2Job(token, STAGE2.JOB_LEASE_SECONDS)) throw new Error("lost phase2 ownership");
    return fn();
  });

  // 2. Git baseline.
  try { guarded(() => prepareMemoryWorkspace(root)); } catch (e) { return fail(`prepare_workspace: ${(e as Error).message}`); }

  // 3. Agent config: model must resolve before we mutate anything.
  let model: ReturnType<typeof resolveMemoryModel>['model'];
  try { const selection=resolveMemoryModel(llm,cfg.consolidation_model); model=selection.model; store.setSetting("runtime:consolidation",JSON.stringify({model:`${model.provider}/${model.id}`,selection:selection.selection,reason:selection.reason})); } catch (e) { return fail(`agent_config: ${(e as Error).message}`); }

  // 4. Load inputs.
  let selected: Stage1Output[];
  try { selected = store.getPhase2InputSelection(cfg.max_raw_memories_for_consolidation, cfg.max_unused_days); } catch (e) { return fail(`load_stage1_outputs: ${(e as Error).message}`); }
  const newWatermark = Math.max(claim.inputWatermark, ...selected.map(s => s.sourceUpdatedAt), 0);

  // 5. Sync workspace inputs.
  try { guarded(() => { syncRolloutSummaries(root, selected); if (cfg.version !== "v2") rebuildRawMemoriesFile(root, selected); pruneOldExtensionResources(root); }); }
  catch (e) { return fail(`sync_workspace_inputs: ${(e as Error).message}`); }

  // 6. Diff decides whether the agent runs.
  let diff; try { diff = guarded(() => memoryWorkspaceDiff(root)); } catch (e) { return fail(`workspace_status: ${(e as Error).message}`); }
  let artifactsValid = true; try { guarded(() => validateConsolidationArtifacts(root, cfg.version)); } catch { artifactsValid = false; }
  if (!diff.changes.length && artifactsValid && !opts.force) {
    if (opts.signal?.aborted) return fail('aborted');
    if (!store.markGlobalPhase2JobSucceeded(token, newWatermark, selected)) return "failed_lost_ownership";
    return "succeeded_no_workspace_changes";
  }

  // 7. Persist diff for the agent.
  try { guarded(() => writeWorkspaceDiff(root, diff)); } catch (e) { return fail(`workspace_diff_file: ${(e as Error).message}`); }

  // 8+9. Run agent with heartbeats.
  const hb = setInterval(() => { try { if (!store.heartbeatGlobalPhase2Job(token, STAGE2.JOB_LEASE_SECONDS)) { report("phase2: lost lease during heartbeat"); ac.abort(); } } catch (e) { report(`phase2: heartbeat failed: ${String(e)}`); ac.abort(); } }, STAGE2.JOB_HEARTBEAT_SECONDS * 1000);
  const ac = new AbortController();
  const onAbort = () => ac.abort(); opts.signal?.addEventListener("abort", onAbort);
  if (opts.signal?.aborted) ac.abort();
  let completed = false, agentError = "";
  try {
    const r = await runConsolidationAgent(llm, model, cfg, root, log, ac.signal, opts.onProgress, guarded);
    completed = r.completed; agentError = r.error ?? "";
  } catch (e) { agentError = e instanceof Error ? e.message : String(e); }
  finally { clearInterval(hb); opts.signal?.removeEventListener("abort", onAbort); }
  if (opts.signal?.aborted || ac.signal.aborted) return fail('aborted');

  if (!completed) { try { guarded(() => removeMemorySymlinks(root)); } catch {} return fail(`agent: ${agentError || "did not complete"}`); }
  try { guarded(() => validateConsolidationArtifacts(root, cfg.version)); } catch (e) { return fail(`invalid_artifacts: ${(e as Error).message}`); }
  if (!store.heartbeatGlobalPhase2Job(token, STAGE2.JOB_LEASE_SECONDS)) return fail("lost_ownership_before_baseline_reset");
  try { guarded(() => resetMemoryWorkspaceBaseline(root)); } catch (e) { return fail(`workspace_commit: ${(e as Error).message}`); }
  if (!store.markGlobalPhase2JobSucceeded(token, newWatermark, selected)) return "failed_lost_ownership";
  return "succeeded";
  } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
}

async function runConsolidationAgent(llm: Llm, model: ReturnType<typeof resolveMemoryModel>['model'], cfg: MemoriesConfig, root: string, log: Log, signal: AbortSignal, onProgress: ((s: string) => void) | undefined, guarded: <T>(fn: () => T) => T): Promise<{ completed: boolean; error?: string }> {
  return runPiConsolidationSession(llm,model,cfg,root,buildConsolidationPrompt(root,cfg.version)+HARNESS_NOTE(root),`Begin. Read ${WORKSPACE_DIFF.FILENAME} first.`,signal,guarded,onProgress);
}
