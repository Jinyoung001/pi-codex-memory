// pi-codex-memory — port of OpenAI Codex memories (pinned commit in vendor/codex/reference.json).
//
// Startup pipeline (background, root non-ephemeral sessions, dispatched on the first user turn):
//   ensure layout → seed ad_hoc extension → prune stale stage-1 rows → Phase 1 → Phase 2
// Read path: read_path.md + memory_summary.md injected as developer instructions; citations bump usage.
// Controls: /memories [status|run|force|on|off|generate on|off|use on|off|reset]
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { redact, atomicWrite } from "./safety.js";
import { createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE, memoryRootFor, memoryDbFor, ensureConfigFile, migrateLegacyConfig, loadConfig, saveConfig, type MemoriesConfig, type MemoryVersion } from "./src/config.ts";
import { MemoryStore } from "./src/store.ts";
import { indexSessions, readSessionHeader } from "./src/rollout.ts";
import { ensureLayout, seedExtensionInstructions, memoryReadiness } from "./src/storage.ts";
import { gitAvailable } from "./src/workspace.ts";
import { snap, type Llm } from "./src/llm.ts";
import * as phase1 from "./src/phase1.ts";
import * as phase2 from "./src/phase2.ts";
import { buildDeveloperInstructions, extractCitationBlocks, memoryTools, parseMemoryCitation, threadIdsFromCitation } from "./src/read-path.ts";

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");
const LOG_FILE = path.join(memoryRootFor("v1"), "..", "memories.log");
const POLLUTION_DIR = path.join(path.dirname(memoryRootFor('v1')), 'memory-polluted-threads');
// Tools whose output is external context (codex: web search / image gen / MCP mark the thread polluted).
const EXTERNAL_CONTEXT_TOOLS = /^(web_search|fetch_content|source_check|get_search_content|ctx_fetch_and_index|image_gen|generate_image|mcp$|mcpScript$|mcp__|mcp_)/;

export default function (pi: ExtensionAPI) {
  const log = (s: string) => { try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${redact(s)}\n`); } catch {} };
  const stores = new Map<MemoryVersion, MemoryStore>();
  let cfg: MemoriesConfig = loadConfig();
  const activeVersion = cfg.version;
  const MEMORY_ROOT = memoryRootFor(activeVersion), DB_FILE = memoryDbFor(activeVersion);
  let sessionId = "", sessionFile: string | undefined, isEphemeral = false, dispatched = false;
  let running: { ac: AbortController; promise: Promise<void> } | undefined;
  let llm: Llm | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const openStore = (version: MemoryVersion = activeVersion) => { let store = stores.get(version); if (!store) { store = new MemoryStore(memoryDbFor(version)); stores.set(version, store); } return store; };
  const pollutionFile = (id: string) => path.join(POLLUTION_DIR, createHash('sha256').update(id).digest('hex') + '.json');
  function readPollutionJournal(): string[] {
    if (!fs.existsSync(POLLUTION_DIR)) return [];
    const ids: string[] = [];
    for (const file of fs.readdirSync(POLLUTION_DIR)) {
      if (!file.endsWith('.json')) continue; // atomicWrite .tmp leftovers must not wedge the pipeline
      const id: unknown = JSON.parse(fs.readFileSync(path.join(POLLUTION_DIR, file), 'utf8'));
      if (typeof id !== 'string' || !id) throw new Error('invalid pollution exclusion record');
      ids.push(id);
    }
    return ids;
  }
  const isSubagent = () => !!(process.env.PI_SUBAGENT || process.env.PI_SUBAGENT_RUN_ID || process.env.PI_PARENT_SESSION);

  function registerCurrentThread(ctx: ExtensionContext) {
    if (!cfg.enabled || !sessionId || !sessionFile) return;
    const header = readSessionHeader(sessionFile, Date.now());
    for (const version of ["v1", "v2"] as const) openStore(version).upsertThread({
      id: sessionId, rolloutPath: sessionFile, cwd: header?.cwd ?? ctx.cwd ?? path.dirname(sessionFile),
      updatedAtMs: Date.now(), gitBranch: null, memoryMode: cfg.generate_memories ? "enabled" : "disabled",
      source: isSubagent() ? "subagent" : ctx.hasUI ? "interactive" : "exec",
    });
  }

  async function pipeline(l: Llm, force: boolean, notify?: (m: string) => void) {
    if (running) { notify?.("memories: pipeline already running"); return; }
    const ac = new AbortController();
    const task = (async () => {
      const versions: MemoryVersion[] = cfg.dual_write ? ["v1", "v2"] : [activeVersion];
      const pollutedIds = readPollutionJournal();
      await Promise.allSettled(versions.map(async version => {
      if (ac.signal.aborted) return;
      try {
        const st = openStore(version), root = memoryRootFor(version), config = { ...cfg, version };
        st.withMutation(() => {
          ensureLayout(root);
          seedExtensionInstructions(root, fs.readFileSync(path.join(PROMPTS, "extensions", "ad_hoc", "instructions.md"), "utf8"));
        });
        const n = indexSessions(t => st.upsertThread(t));
        for (const id of pollutedIds) st.setThreadMemoryMode(id, 'polluted');
        st.archiveMissingThreadFiles();
        log(`startup: indexed ${n} session file(s)`);
        phase1.prune(st, config, log);
        // generate_memories controls newly created thread eligibility, not extraction of older eligible threads.
        const p1 = await phase1.run(st, config, l, sessionId, log, ac.signal);
        if (ac.signal.aborted) return;
        if (!gitAvailable()) { log("phase2: git not available; consolidation skipped"); notify?.("memories: git not found, consolidation skipped"); return; }
        const r = await phase2.run(st, config, l, root, sessionId, log, { force, signal: ac.signal });
        log(`pipeline: phase1 claimed=${p1.claimed} out=${p1.withOutput} none=${p1.noOutput} failed=${p1.failed} tokens=${p1.tokens}; phase2=${r}`);
        if (notify && (p1.claimed || r === "succeeded" || force || r.startsWith("failed"))) notify(`memories: phase1 ${p1.withOutput}/${p1.claimed} extracted, phase2 ${r}`);
      } catch (e) { log(`pipeline ${version} error: ${(e as Error).stack ?? e}`); notify?.(`memories: pipeline error: ${(e as Error).message}`); }
      }));
    })();
    running = { ac, promise: task };
    try { await task; } finally { running = undefined; }
  }

  // ---------- lifecycle ----------
  pi.on("session_start", async (_e, ctx) => {
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = undefined;
    running?.ac.abort();
    if (running) await running.promise;
    const removed=migrateLegacyConfig();
    if(removed.length) { const message=`memories: switched to Codex-only; retired settings: ${removed.join(", ")}. Original config backed up.`; log(message); if(ctx.hasUI)ctx.ui.notify(message,"info"); }
    cfg = loadConfig(); ensureConfigFile();
    sessionFile = ctx.sessionManager.getSessionFile?.() ?? undefined;
    isEphemeral = !sessionFile;
    sessionId = ctx.sessionManager.getSessionId?.() ?? "";
    dispatched = false;
    llm = snap(ctx);
    registerCurrentThread(ctx);
  });

  // Codex dispatches after the first user turn with input has started (not at raw session start).
  pi.on("before_agent_start", async (event, ctx) => {
    llm = snap(ctx);
    const l = llm;
    if (!dispatched && cfg.enabled && !isEphemeral && !isSubagent() && sessionId) {
      dispatched = true;
      startupTimer = setTimeout(() => { startupTimer = undefined; pipeline(l, false, m => { try { if (ctx.hasUI) ctx.ui.notify(m, "info"); } catch {} }).catch(e => log(`dispatch error: ${e}`)); }, 0);
    }
    if (!cfg.enabled) return;
    if (!cfg.use_memories) return;
    const ins = buildDeveloperInstructions(MEMORY_ROOT, activeVersion);
    if (!ins) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + ins };
  });

  pi.on("session_shutdown", async () => {
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = undefined;
    // Default: cancel background work (leases are marked failed and retried on a later startup).
    // PI_CODEX_MEMORY_WAIT_ON_SHUTDOWN=1 lets headless smoke runs drain the pipeline instead.
    if (running && process.env.PI_CODEX_MEMORY_WAIT_ON_SHUTDOWN === "1") { try { await running.promise; } catch {} }
    running?.ac.abort();
    try { await running?.promise; } catch {}
    for (const store of stores.values()) store.close(); stores.clear();
  });

  // External context → mark this thread polluted so it is never extracted (codex disable_on_external_context).
  pi.on("tool_execution_end", async event => {
    if (!cfg.enabled || !cfg.disable_on_external_context || !sessionId || isEphemeral) return;
    const name = String(event.toolName ?? "");
    const source = pi.getAllTools?.().find(tool => tool.name === name)?.sourceInfo;
    const mcpSource = source && (source.source.startsWith("mcp:") || /(?:^npm:|[\\/])pi-mcp-adapter(?:@|[\\/]|$)/i.test(source.source) || /[\\/]pi-mcp-adapter[\\/]/i.test(source.path));
    if (EXTERNAL_CONTEXT_TOOLS.test(name) || mcpSource) {
      try {
        atomicWrite(pollutionFile(sessionId), JSON.stringify(sessionId));
      } catch (e) {
        running?.ac.abort();
        try { saveConfig({ enabled: false }); } catch {}
        cfg.enabled = false;
        log(`pollution exclusion persistence failed; extension disabled: ${String(e)}`);
        return;
      }
      for (const version of ["v1", "v2"] as const) {
        try {
          const st = openStore(version);
          if (sessionFile) { const h = readSessionHeader(sessionFile, Date.now()); if (h) st.upsertThread({ id: h.id, rolloutPath: h.file, cwd: h.cwd, updatedAtMs: h.mtimeMs, memoryMode: "enabled", gitBranch: null }); }
          if (st.setThreadMemoryMode(sessionId, "polluted")) log(`thread ${sessionId} marked polluted (${version}) by ${event.toolName}`);
        } catch (e) { log(`pollution mark failed (${version}); durable exclusion retained: ${String(e)}`); }
      }
    }
  });

  // Citations in each completed assistant message → usage_count / last_usage.
  // message_end fires once per finalized message: the analogue of Codex record_completed_response_item.
  pi.on("message_end", async event => {
    if (!cfg.enabled) return;
    const last = event.message;
    if (!last || last.role !== "assistant") return;
    const text = last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (!cfg.use_memories) return;
    const blocks = extractCitationBlocks(text); if (!blocks.length) return;
    const cit = parseMemoryCitation(blocks); if (!cit) return;
    const ids = threadIdsFromCitation(cit); if (!ids.length) return;
    try { const n = openStore().recordStage1OutputUsage(ids); log(`citation: ${n} stage-1 row(s) bumped (${ids.join(",")})`); } catch (e) { log(`citation usage failed: ${e}`); }
  });

  // ---------- tools ----------
  if (cfg.enabled && cfg.use_memories && cfg.dedicated_tools) for (const t of memoryTools(MEMORY_ROOT, fn => openStore().withMutation(fn))) pi.registerTool({ ...t, execute: async (...args: any[]) => {
    if (!cfg.enabled || !cfg.use_memories || !cfg.dedicated_tools) throw new Error("memory tools disabled");
    return (t.execute as any)(...args);
  }} as any);

  // ---------- command ----------
  pi.registerCommand("memories", {
    description: "Memory: /memories [status|readiness [minimum]|run|force|on|off|generate on|off|use on|off|thread on|off|reset]",
    handler: async (args, ctx: ExtensionContext) => {
      const a = (args ?? "").trim().split(/\s+/);
      const say = (m: string, t: "info" | "warning" | "error" = "info") => { if (ctx.hasUI) ctx.ui.notify(m, t); else console.log(m); };
      cfg = loadConfig();
      const l = snap(ctx);
      switch (a[0]) {
        case "readiness": {
          try { return say(JSON.stringify(memoryReadiness(memoryRootFor("v2"), openStore("v2").maxConsolidatedThreadCount(), a[1] === undefined ? 20 : Number(a[1])))); }
          catch (e) { return say(`memories: ${(e as Error).message}`, "error"); }
        }
        case "run": case "force": {
          if (!cfg.enabled) return say("memories: feature disabled (set enabled=true in memories.json)", "warning");
          say("memories: running pipeline…"); await pipeline(l, a[0] === "force", say); return;
        }
        case "on": case "off":
          saveConfig({ enabled: a[0] === "on" }); cfg = loadConfig();
          if (!cfg.enabled) {
            if (startupTimer) clearTimeout(startupTimer);
            startupTimer = undefined;
            running?.ac.abort();
            if (running) await running.promise;
          }
          return say(`memories: ${a[0]} (restart or /reload to apply tool registration)`);
        case "generate": case "use": {
          if (a[1] !== "on" && a[1] !== "off") return say(`usage: /memories ${a[0]} on|off`, "warning");
          saveConfig(a[0] === "generate" ? { generate_memories: a[1] === "on" } : { use_memories: a[1] === "on" }); cfg = loadConfig();
          return say(`memories: ${a[0]}_memories=${a[1] === "on"}${a[0] === "generate" ? " (new sessions; use /memories off to stop the pipeline)" : ""}`);
        }
        case "thread": {
          if (!sessionId) return say("memories: no persistent session", "warning");
          if (a[1] !== "on" && a[1] !== "off") return say("usage: /memories thread on|off", "warning");
          if (a[1] === "on") fs.rmSync(pollutionFile(sessionId), { force: true }); // otherwise journal replay re-pollutes on next run
          for (const version of ["v1", "v2"] as const) {
            const st = openStore(version);
            if (sessionFile) { const h = readSessionHeader(sessionFile, Date.now()); if (h) st.upsertThread({ id: h.id, rolloutPath: h.file, cwd: h.cwd, updatedAtMs: h.mtimeMs, memoryMode: "enabled", gitBranch: null }); }
            if (a[1] === "off") { st.setThreadMemoryMode(sessionId, "disabled"); st.deleteThreadMemory(sessionId); }
            else st.setThreadMemoryMode(sessionId, "enabled");
          }
          return say(`memories: this thread ${a[1] === "on" ? "may contribute to" : "is excluded from"} future memories`);
        }
        case "reset": {
          const ok = ctx.hasUI ? await ctx.ui.confirm("Reset memories?", `Delete both V1 and V2 memory files and databases under ${path.dirname(MEMORY_ROOT)}?`) : false;
          if (!ok) return say("memories: reset cancelled");
          if (startupTimer) clearTimeout(startupTimer);
          startupTimer = undefined;
          running?.ac.abort();
          if (running) await running.promise;
          try {
            openStore("v1").clearAll(() => openStore("v2").clearAll(() => {
              const roots = [memoryRootFor("v1"), memoryRootFor("v2")];
              for (const root of roots) if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error("refusing to clear symlinked memory root");
              for (const root of roots) { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); }
            }));
          } catch (e) { return say(`memories: ${(e as Error).message}`, "error"); }
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
            `runtime extraction: ${st.getSetting("runtime:extraction") ?? "not selected yet"}`,
            `runtime consolidation: ${st.getSetting("runtime:consolidation") ?? "not selected yet"}`,
            `models: extract=${cfg.extract_model ?? "(session)"}:${cfg.extract_thinking} consolidate=${cfg.consolidation_model ?? "(session)"}:${cfg.consolidation_thinking}`,
          ].join("\n"));
        }
      }
    },
  });
}
