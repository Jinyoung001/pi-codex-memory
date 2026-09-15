// pi-codex-memory — port of OpenAI Codex memories (pinned commit in vendor/codex/reference.json).
//
// Startup pipeline (background, root non-ephemeral sessions, dispatched on the first user turn):
//   ensure layout → seed ad_hoc extension → prune stale stage-1 rows → Phase 1 → Phase 2
// Read path: read_path.md + memory_summary.md injected as developer instructions; citations bump usage.
// Controls: /memories [status|run|force|on|off|generate on|off|use on|off|reset]
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE, DB_FILE, MEMORY_ROOT, ensureConfigFile, loadConfig, saveConfig, type MemoriesConfig } from "./src/config.ts";
import { MemoryStore } from "./src/store.ts";
import { indexSessions, readSessionHeader } from "./src/rollout.ts";
import { ensureLayout, seedExtensionInstructions } from "./src/storage.ts";
import { gitAvailable } from "./src/workspace.ts";
import { snap, type Llm } from "./src/llm.ts";
import * as phase1 from "./src/phase1.ts";
import * as phase2 from "./src/phase2.ts";
import { buildDeveloperInstructions, extractCitationBlocks, memoryTools, parseMemoryCitation, threadIdsFromCitation } from "./src/read-path.ts";

const PROMPTS = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "prompts");
const LOG_FILE = path.join(MEMORY_ROOT, "..", "memories.log");
// Tools whose output is external context (codex: web search / image gen / MCP mark the thread polluted).
const EXTERNAL_CONTEXT_TOOLS = /^(web_search|fetch_content|source_check|get_search_content|ctx_fetch_and_index|mcp__|mcp_)/;

export default function (pi: ExtensionAPI) {
  const log = (s: string) => { try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${s}\n`); } catch {} };
  let store: MemoryStore | undefined;
  let cfg: MemoriesConfig = loadConfig();
  let sessionId = "", sessionFile: string | undefined, isEphemeral = false, dispatched = false;
  let running: { ac: AbortController; promise: Promise<void> } | undefined;
  let llm: Llm | undefined;

  const openStore = () => { if (!store) store = new MemoryStore(DB_FILE); return store; };
  const isSubagent = () => !!(process.env.PI_SUBAGENT || process.env.PI_SUBAGENT_RUN_ID || process.env.PI_PARENT_SESSION);

  async function pipeline(l: Llm, force: boolean, notify?: (m: string) => void) {
    if (running) { notify?.("memories: pipeline already running"); return; }
    const ac = new AbortController();
    const task = (async () => {
      const st = openStore();
      try {
        ensureLayout(MEMORY_ROOT);
        seedExtensionInstructions(MEMORY_ROOT, fs.readFileSync(path.join(PROMPTS, "extensions", "ad_hoc", "instructions.md"), "utf8"));
        const n = indexSessions(t => st.upsertThread(t));
        log(`startup: indexed ${n} session file(s)`);
        phase1.prune(st, cfg, log);
        let p1 = { claimed: 0, withOutput: 0, noOutput: 0, failed: 0, tokens: 0 };
        if (cfg.generate_memories) p1 = await phase1.run(st, cfg, l, sessionId, log, ac.signal);
        if (ac.signal.aborted) return;
        if (!gitAvailable()) { log("phase2: git not available; consolidation skipped"); notify?.("memories: git not found, consolidation skipped"); return; }
        const r = cfg.generate_memories || force ? await phase2.run(st, cfg, l, MEMORY_ROOT, sessionId, log, { force, signal: ac.signal }) : "skipped_generate_disabled";
        log(`pipeline: phase1 claimed=${p1.claimed} out=${p1.withOutput} none=${p1.noOutput} failed=${p1.failed}; phase2=${r}`);
        if (notify && (p1.claimed || r === "succeeded" || force || r.startsWith("failed"))) notify(`memories: phase1 ${p1.withOutput}/${p1.claimed} extracted, phase2 ${r}`);
      } catch (e) { log(`pipeline error: ${(e as Error).stack ?? e}`); notify?.(`memories: pipeline error: ${(e as Error).message}`); }
    })();
    running = { ac, promise: task };
    try { await task; } finally { running = undefined; }
  }

  // ---------- lifecycle ----------
  pi.on("session_start", async (_e, ctx) => {
    cfg = loadConfig(); ensureConfigFile();
    sessionFile = ctx.sessionManager.getSessionFile?.() ?? undefined;
    isEphemeral = !sessionFile;
    sessionId = ctx.sessionManager.getSessionId?.() ?? "";
    dispatched = false;
    llm = snap(ctx);
  });

  // Codex dispatches after the first user turn with input has started (not at raw session start).
  pi.on("before_agent_start", async (event, ctx) => {
    llm = snap(ctx);
    const l = llm;
    if (!dispatched && cfg.enabled && !isEphemeral && !isSubagent() && sessionId) {
      dispatched = true;
      setTimeout(() => { pipeline(l, false, m => { try { if (ctx.hasUI) ctx.ui.notify(m, "info"); } catch {} }).catch(e => log(`dispatch error: ${e}`)); }, 1500);
    }
    if (!cfg.enabled || !cfg.use_memories) return;
    const ins = buildDeveloperInstructions(MEMORY_ROOT);
    if (!ins) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + ins };
  });

  pi.on("session_shutdown", async () => {
    // Default: cancel background work (leases are marked failed and retried on a later startup).
    // PI_CODEX_MEMORY_WAIT_ON_SHUTDOWN=1 lets headless smoke runs drain the pipeline instead.
    if (running && process.env.PI_CODEX_MEMORY_WAIT_ON_SHUTDOWN === "1") { try { await running.promise; } catch {} }
    running?.ac.abort();
    try { await Promise.race([running?.promise, new Promise(r => setTimeout(r, 3000))]); } catch {}
    store?.close(); store = undefined;
  });

  // External context → mark this thread polluted so it is never extracted (codex disable_on_external_context).
  pi.on("tool_execution_end", async (event: any) => {
    if (!cfg.disable_on_external_context || !sessionId) return;
    if (EXTERNAL_CONTEXT_TOOLS.test(String(event.toolName ?? ""))) {
      try { if (openStore().setThreadMemoryMode(sessionId, "polluted")) log(`thread ${sessionId} marked polluted by ${event.toolName}`); } catch (e) { log(`pollution mark failed: ${e}`); }
    }
  });

  // Citations in each completed assistant message → usage_count / last_usage.
  // message_end fires once per finalized message: the analogue of Codex record_completed_response_item.
  pi.on("message_end", async (event: any) => {
    if (!cfg.enabled || !cfg.use_memories) return;
    const last = event.message;
    if (!last || last.role !== "assistant") return;
    const text = (Array.isArray(last.content) ? last.content : []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    const blocks = extractCitationBlocks(text); if (!blocks.length) return;
    const cit = parseMemoryCitation(blocks); if (!cit) return;
    const ids = threadIdsFromCitation(cit); if (!ids.length) return;
    try { const n = openStore().recordStage1OutputUsage(ids); log(`citation: ${n} stage-1 row(s) bumped (${ids.join(",")})`); } catch (e) { log(`citation usage failed: ${e}`); }
  });

  // ---------- tools ----------
  if (cfg.enabled && cfg.dedicated_tools) for (const t of memoryTools(MEMORY_ROOT)) pi.registerTool(t as any);

  // ---------- command ----------
  pi.registerCommand("memories", {
    description: "Memory: /memories [status|run|force|on|off|generate on|off|use on|off|thread on|off|reset]",
    handler: async (args, ctx: ExtensionContext) => {
      const a = (args ?? "").trim().split(/\s+/);
      const say = (m: string, t: "info" | "warning" | "error" = "info") => { if (ctx.hasUI) ctx.ui.notify(m, t); else console.log(m); };
      cfg = loadConfig();
      const l = snap(ctx);
      switch (a[0]) {
        case "run": case "force": {
          if (!cfg.enabled) return say("memories: feature disabled (set enabled=true in memories.json)", "warning");
          say("memories: running pipeline…"); await pipeline(l, a[0] === "force", say); return;
        }
        case "on": case "off": saveConfig({ enabled: a[0] === "on" }); return say(`memories: ${a[0]} (restart or /reload to apply tool registration)`);
        case "generate": case "use": {
          if (a[1] !== "on" && a[1] !== "off") return say(`usage: /memories ${a[0]} on|off`, "warning");
          saveConfig(a[0] === "generate" ? { generate_memories: a[1] === "on" } : { use_memories: a[1] === "on" }); cfg = loadConfig();
          return say(`memories: ${a[0]}_memories=${a[1] === "on"}`);
        }
        case "thread": {
          if (!sessionId) return say("memories: no persistent session", "warning");
          if (a[1] !== "on" && a[1] !== "off") return say("usage: /memories thread on|off", "warning");
          const st = openStore();
          if (sessionFile) { const h = readSessionHeader(sessionFile, Date.now()); if (h) st.upsertThread({ id: h.id, rolloutPath: h.file, cwd: h.cwd, updatedAtMs: h.mtimeMs, memoryMode: "enabled", gitBranch: null }); }
          if (a[1] === "off") { st.setThreadMemoryMode(sessionId, "disabled"); st.deleteThreadMemory(sessionId); }
          else st.setThreadMemoryMode(sessionId, "enabled");
          return say(`memories: this thread ${a[1] === "on" ? "may contribute to" : "is excluded from"} future memories`);
        }
        case "reset": {
          const ok = ctx.hasUI ? await ctx.ui.confirm("Reset memories?", `Delete all memory files under ${MEMORY_ROOT} and the memory database?`) : false;
          if (!ok) return say("memories: reset cancelled");
          running?.ac.abort();
          if (fs.existsSync(MEMORY_ROOT) && fs.lstatSync(MEMORY_ROOT).isSymbolicLink()) return say("memories: refusing to clear symlinked memory root", "error");
          fs.rmSync(MEMORY_ROOT, { recursive: true, force: true }); fs.mkdirSync(MEMORY_ROOT, { recursive: true });
          openStore().clearAll();
          return say("memories: reset complete");
        }
        default: {
          const st = openStore(); const p2 = st.phase2Status();
          const sum = path.join(MEMORY_ROOT, "memory_summary.md");
          const sumInfo = fs.existsSync(sum) ? `${fs.statSync(sum).size} bytes` : "none";
          say([
            `memories: enabled=${cfg.enabled} generate=${cfg.generate_memories} use=${cfg.use_memories} tools=${cfg.dedicated_tools}`,
            `root=${MEMORY_ROOT}  db=${DB_FILE}  config=${CONFIG_FILE}`,
            `stage1 rows=${st.stage1Count()}  summary=${sumInfo}  thread=${sessionId ? st.threadMemoryMode(sessionId) ?? "not indexed yet" : "ephemeral"}`,
            `phase2: ${p2 ? `${p2.status}${p2.last_error ? ` (${p2.last_error})` : ""} finished=${p2.finished_at ? new Date(p2.finished_at * 1000).toLocaleString() : "never"}` : "never run"}${running ? "  [pipeline running]" : ""}`,
            `models: extract=${cfg.extract_model ?? "(session)"}:${cfg.extract_thinking} consolidate=${cfg.consolidation_model ?? "(session)"}:${cfg.consolidation_thinking}`,
          ].join("\n"));
        }
      }
    },
  });
}
