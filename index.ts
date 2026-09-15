// pi-codex-memory — Codex-style two-phase memory for pi.
//
// Phase 1 (per session, cheap model): idle session .jsonl → { raw_memory, rollout_summary, rollout_slug }
// Phase 2 (global, main model):       raw_memories + summaries → MEMORY.md + memory_summary.md
// Read path: memory_summary.md injected into system prompt; tools memories_list/search/read/add_note.
//
// Layout: ~/.pi/agent/memories/
//   memory_summary.md   injected every turn (first line "v1")
//   MEMORY.md           grep handbook (Task Group blocks)
//   raw_memories.md     merged phase-1 outputs (phase-2 input)
//   rollout_summaries/  one .md per session
//   notes/              ad-hoc notes from memories_add_note (consumed by phase 2)
//   state.json          phase-1 outputs + usage + watermarks (ponytail: JSON instead of sqlite)

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------- config ----------
const HOME = path.join(os.homedir(), ".pi", "agent");
const ROOT = path.join(HOME, "memories");
const SESSIONS_DIR = path.join(HOME, "sessions");
const PROMPTS = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "prompts");

const CFG = {
  extractModel: "openrouter/deepseek/deepseek-v4.1-flash",
  consolidateModel: "" as string, // "" = current session model
  minIdleHours: 6,
  maxAgeDays: 30,
  maxPerStartup: 8,
  concurrency: 4,
  maxUnusedDays: 30,
  phase2CooldownHours: 6,
  maxPhase2Inputs: 256,
  summaryCharCap: 10_000, // ~2.5k tokens
  minSessionChars: 1_500,
};

// ---------- state ----------
type Stage1 = {
  sessionId: string;
  file: string;
  cwd: string;
  updatedAt: number;   // session file mtime at extraction
  extractedAt: number;
  rawMemory: string;
  rolloutSummary: string;
  slug: string;
  usageCount: number;
  lastUsage: number;
};
type State = {
  stage1: Record<string, Stage1>;    // by sessionId
  phase2: { lastSuccess: number; running: boolean; startedAt: number };
  disabledSessions: string[];        // /memories toggle: don't extract from these
};
const STATE_FILE = path.join(ROOT, "state.json");

function loadState(): State {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { stage1: {}, phase2: { lastSuccess: 0, running: false, startedAt: 0 }, disabledSessions: [] }; }
}
function saveState(s: State) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}
const read = (p: string) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const prompt = (n: string) => read(path.join(PROMPTS, n));

// ---------- secret redaction ----------
const SECRET_RES = [
  /\b(sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[abp]|AKIA|AIza)[A-Za-z0-9_\-]{16,}\b/g,
  /\b[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{20,}\b/g, // jwt
  /(api[_-]?key|token|secret|password|passwd|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
  /\b(postgres|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^\s"']+:[^\s"']+@/gi,
];
function redact(s: string) {
  return SECRET_RES.reduce((acc, re) => acc.replace(re, (m, a, b) => (b ? `${a}${b}[REDACTED]` : "[REDACTED]")), s);
}

// ---------- session rendering ----------
type Entry = { type: string; timestamp?: string; message?: { role: string; content: unknown; toolName?: string; isError?: boolean } };
function renderSession(file: string): { cwd: string; text: string; id: string } {
  const lines = read(file).split("\n").filter(Boolean);
  let cwd = "", id = "";
  const out: string[] = [];
  for (const l of lines) {
    let e: any; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === "session") { cwd = e.cwd ?? ""; id = e.id ?? ""; continue; }
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    const c = m.content;
    const txt = (x: unknown): string => typeof x === "string" ? x
      : Array.isArray(x) ? x.map((p: any) => p?.type === "text" ? p.text
        : p?.type === "toolCall" ? `[tool ${p.name}] ${JSON.stringify(p.arguments).slice(0, 600)}`
        : p?.type === "thinking" ? "" : "").filter(Boolean).join("\n") : "";
    if (m.role === "user") out.push(`USER:\n${txt(c)}`);
    else if (m.role === "assistant") out.push(`ASSISTANT:\n${txt(c)}`);
    else if (m.role === "toolResult") out.push(`TOOL_RESULT(${m.toolName}${m.isError ? ", error" : ""}):\n${txt(c).slice(0, 1500)}`);
  }
  return { cwd, id, text: out.join("\n\n") };
}

// ---------- LLM helper ----------
// Snapshot of what the pipeline needs from ctx; ctx itself goes stale after session replacement.
type Llm = { registry: ExtensionContext["modelRegistry"]; model: ExtensionContext["model"] };
const snap = (ctx: ExtensionContext): Llm => ({ registry: ctx.modelRegistry, model: ctx.model });

async function llm(ctx: Llm, modelSpec: string, system: string, user: string, effort: "low" | "medium" | "high" = "medium") {
  let model = ctx.model;
  if (modelSpec) {
    const [prov, ...rest] = modelSpec.split("/");
    model = ctx.registry.find(prov, rest.join("/")) ?? ctx.model;
  }
  if (!model) throw new Error("no model");
  const res = await ctx.registry.complete(
    model,
    { systemPrompt: system, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: user }], timestamp: Date.now() }] },
    { reasoningEffort: effort, cacheRetention: "none", sessionId: randomUUID() },
  );
  return res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}
function parseJson(s: string): any {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (fence) s = fence[1];
  const start = s.indexOf("{"); if (start < 0) throw new Error("no json");
  // walk to the matching close brace (string-aware) — greedy regex breaks on trailing prose
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error("unterminated json");
}

// ---------- Phase 1 ----------
function listSessionFiles(): { file: string; mtime: number }[] {
  const out: { file: string; mtime: number }[] = [];
  if (!fs.existsSync(SESSIONS_DIR)) return out;
  for (const d of fs.readdirSync(SESSIONS_DIR)) {
    const dir = path.join(SESSIONS_DIR, d);
    let st: fs.Stats; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".jsonl")) {
      const p = path.join(dir, f);
      out.push({ file: p, mtime: fs.statSync(p).mtimeMs });
    }
  }
  return out;
}

async function phase1(ctx: Llm, state: State, currentFile: string | undefined, log: (s: string) => void) {
  const now = Date.now();
  const idleMs = CFG.minIdleHours * 3600e3, ageMs = CFG.maxAgeDays * 86400e3;
  const candidates = listSessionFiles()
    .filter(s => s.file !== currentFile && now - s.mtime > idleMs && now - s.mtime < ageMs)
    .filter(s => {
      const id = path.basename(s.file).replace(/^.*?_/, "").replace(/\.jsonl$/, "");
      if (state.disabledSessions.includes(id)) return false;
      const prev = state.stage1[id];
      return !prev || prev.updatedAt < s.mtime;
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, CFG.maxPerStartup);
  if (!candidates.length) return 0;

  const sys = prompt("stage_one_system.md");
  const inputTpl = prompt("stage_one_input.md");
  let done = 0;
  const work = async (c: { file: string; mtime: number }) => {
    const r = renderSession(c.file);
    if (!r.id || r.text.length < CFG.minSessionChars) { // too small: mark processed, no memory
      if (r.id) { delete state.stage1[r.id]; }
      return;
    }
    const user = inputTpl
      .replace("{{ rollout_path }}", c.file)
      .replace("{{ rollout_cwd }}", r.cwd)
      .replace("{{ rollout_contents }}", r.text.slice(0, 200_000));
    try {
      const j = parseJson(await llm(ctx, CFG.extractModel, sys, user, "high"));
      const raw = redact(String(j.raw_memory ?? "")).trim();
      const sum = redact(String(j.rollout_summary ?? "")).trim();
      if (!raw && !sum) { delete state.stage1[r.id]; return; }
      const prev = state.stage1[r.id];
      state.stage1[r.id] = {
        sessionId: r.id, file: c.file, cwd: r.cwd, updatedAt: c.mtime, extractedAt: now,
        rawMemory: raw, rolloutSummary: sum,
        slug: String(j.rollout_slug ?? "").replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 60),
        usageCount: prev?.usageCount ?? 0, lastUsage: prev?.lastUsage ?? 0,
      };
      done++;
    } catch (e) { log(`phase1 fail ${path.basename(c.file)}: ${(e as Error).message}`); }
  };
  // ponytail: simple pool
  const q = [...candidates];
  await Promise.all(Array.from({ length: CFG.concurrency }, async () => { while (q.length) await work(q.shift()!); }));
  saveState(state);
  return done;
}

// ---------- Phase 2 ----------
function summaryFile(s: Stage1) {
  const d = new Date(s.updatedAt).toISOString().slice(0, 10);
  return `${d}-${s.slug || s.sessionId.slice(0, 8)}.md`;
}
function selectForPhase2(state: State) {
  const cut = Date.now() - CFG.maxUnusedDays * 86400e3;
  return Object.values(state.stage1)
    .filter(s => Math.max(s.lastUsage, s.updatedAt) > cut)
    .sort((a, b) => (b.usageCount - a.usageCount) || (b.updatedAt - a.updatedAt))
    .slice(0, CFG.maxPhase2Inputs);
}
function syncWorkspace(selected: Stage1[]) {
  const rsDir = path.join(ROOT, "rollout_summaries");
  fs.mkdirSync(rsDir, { recursive: true });
  const keep = new Set<string>();
  for (const s of selected) {
    const f = summaryFile(s); keep.add(f);
    const body = `# ${s.slug || s.sessionId}\n\ncwd: ${s.cwd}\nrollout_path: ${s.file}\nthread_id: ${s.sessionId}\nupdated_at: ${new Date(s.updatedAt).toISOString()}\n\n${s.rolloutSummary}\n`;
    const p = path.join(rsDir, f);
    if (read(p) !== body) fs.writeFileSync(p, body);
  }
  const removed: string[] = [];
  for (const f of fs.readdirSync(rsDir)) if (!keep.has(f)) { removed.push(f); fs.unlinkSync(path.join(rsDir, f)); }
  const raw = selected.map(s => `## ${summaryFile(s)}\ncwd: ${s.cwd}\nrollout_path: ${s.file}\nthread_id: ${s.sessionId}\nupdated_at: ${new Date(s.updatedAt).toISOString()}\n\n${s.rawMemory}\n`).join("\n---\n\n");
  fs.writeFileSync(path.join(ROOT, "raw_memories.md"), raw);
  return { removed, raw };
}
function collectNotes(): { text: string; files: string[] } {
  const d = path.join(ROOT, "notes"); if (!fs.existsSync(d)) return { text: "", files: [] };
  const files = fs.readdirSync(d).filter(f => f.endsWith(".md")).sort();
  return { text: files.map(f => `### ${f}\n${read(path.join(d, f))}`).join("\n\n"), files: files.map(f => path.join(d, f)) };
}

async function phase2(ctx: Llm, state: State, force: boolean, log: (s: string) => void) {
  const now = Date.now();
  if (state.phase2.running && now - state.phase2.startedAt < 30 * 60e3) return "running";
  if (!force && now - state.phase2.lastSuccess < CFG.phase2CooldownHours * 3600e3) return "cooldown";
  const selected = selectForPhase2(state);
  const notes = collectNotes();
  if (!selected.length && !notes.files.length) return "nothing";

  state.phase2.running = true; state.phase2.startedAt = now; saveState(state);
  try {
    const prevRaw = read(path.join(ROOT, "raw_memories.md"));
    const { removed, raw } = syncWorkspace(selected);
    const memory = read(path.join(ROOT, "MEMORY.md"));
    const summary = read(path.join(ROOT, "memory_summary.md"));
    if (!force && raw === prevRaw && !removed.length && !notes.files.length && memory && summary.startsWith("v1")) {
      state.phase2.lastSuccess = now; return "clean";
    }
    // Adapted single-shot version of Codex consolidation prompt: inputs inline, outputs as JSON.
    const sys = prompt("consolidation.md")
      .replace(/\{\{\s*memory_root\s*\}\}/g, ROOT)
      .replace(/\{\{\s*memory_extensions_folder_structure\s*\}\}/g, "")
      .replace(/\{\{\s*memory_extensions_primary_inputs\s*\}\}/g, "")
      .replace(/\{\{\s*phase2_workspace_diff_file\s*\}\}/g, "the WORKSPACE CHANGES section")
      + `\n\n============================================================
RUNTIME ADAPTATION (OVERRIDES ABOVE WHERE CONFLICTING)
============================================================
You cannot browse files or run tools. All inputs are provided inline below.
Return ONLY a JSON object: {"MEMORY_md": "<full new content>", "memory_summary_md": "<full new content>"}.
Both must be complete files (not diffs). memory_summary.md must start with the line "v1".
Do not produce skills/. Keep memory_summary.md under ${CFG.summaryCharCap} characters.
Ad-hoc notes are explicit user requests to remember/update/forget; apply them, they outrank rollout evidence.`;
    const user = [
      `MODE: ${memory ? "INCREMENTAL UPDATE" : "INIT"}`,
      `\n## WORKSPACE CHANGES\nremoved rollout_summaries: ${removed.length ? removed.join(", ") : "(none)"}\nraw_memories.md changed: ${raw !== prevRaw}`,
      `\n## EXISTING MEMORY.md\n${memory || "(empty)"}`,
      `\n## EXISTING memory_summary.md\n${summary || "(empty)"}`,
      notes.text ? `\n## AD-HOC NOTES (user requests)\n${notes.text}` : "",
      `\n## raw_memories.md\n${raw.slice(0, 400_000)}`,
    ].join("\n");
    const j = parseJson(await llm(ctx, CFG.consolidateModel, sys, user, "high"));
    const newMem = String(j.MEMORY_md ?? "").trim(), newSum = String(j.memory_summary_md ?? "").trim();
    if (!newMem || !newSum.startsWith("v1")) throw new Error("bad consolidation output");
    fs.writeFileSync(path.join(ROOT, "MEMORY.md"), newMem + "\n");
    fs.writeFileSync(path.join(ROOT, "memory_summary.md"), newSum + "\n");
    for (const f of notes.files) fs.unlinkSync(f);
    state.phase2.lastSuccess = Date.now();
    // prune stage1 rows that fell out of selection and are stale
    const keep = new Set(selected.map(s => s.sessionId));
    const cut = Date.now() - CFG.maxUnusedDays * 86400e3;
    for (const id of Object.keys(state.stage1)) if (!keep.has(id) && Math.max(state.stage1[id].lastUsage, state.stage1[id].updatedAt) < cut) delete state.stage1[id];
    return "updated";
  } catch (e) { log(`phase2 fail: ${(e as Error).message}`); return "failed"; }
  finally { state.phase2.running = false; saveState(state); }
}

// ---------- read path ----------
const READ_PATH = (summary: string) => `
# Memories (local recall layer)
You have a local memory folder at ${ROOT}. Below is memory_summary.md, a compact index.
- For clearly self-contained tasks, ignore memory.
- For relevant or ambiguous tasks: pick keywords from the summary, call memories_search on MEMORY.md, then memories_read at most 1-2 referenced rollout_summaries.
- Memory is recall, not authority: AGENTS.md, repo docs, config, and current code win on conflict.
- Never edit MEMORY.md or memory_summary.md directly. Only after an explicit user request to remember/update/forget, call memories_add_note.
- When memory materially helped, cite it once at the end of your final answer as: <memory_citation>{"rollouts":["<thread_id>", ...]}</memory_citation>

<memory_summary>
${summary}
</memory_summary>
`.trim();

// ---------- extension ----------
export default function (pi: ExtensionAPI) {
  let state = loadState();
  let sessionFile: string | undefined;
  const log = (s: string) => { try { fs.appendFileSync(path.join(ROOT, "log.txt"), `${new Date().toISOString()} ${s}\n`); } catch {} };

  async function runPipeline(ctx: ExtensionContext, force = false) {
    state = loadState();
    const l = snap(ctx);
    const n = await phase1(l, state, sessionFile, log);
    const r = await phase2(l, state, force, log);
    log(`pipeline: phase1=${n} phase2=${r}`);
    return { n, r };
  }

  pi.on("session_start", async (_e, ctx) => {
    fs.mkdirSync(ROOT, { recursive: true });
    sessionFile = ctx.sessionManager.getSessionFile?.() ?? undefined;
    // background, never block startup
    const force = process.env.PI_CODEX_MEMORY_FORCE === "1";
    setTimeout(() => runPipeline(ctx, force).then(({ n, r }) => {
      try { if (ctx.hasUI && (n || r === "updated")) ctx.ui.notify(`memories: extracted ${n}, consolidation ${r}`, "info"); } catch {}
    }).catch(e => log(`pipeline error: ${e}`)), 1500);
  });

  pi.on("before_agent_start", async (event) => {
    const summary = read(path.join(ROOT, "memory_summary.md"));
    if (!summary.startsWith("v1")) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + READ_PATH(summary.slice(0, CFG.summaryCharCap)) };
  });

  // citations → usage
  pi.on("agent_end", async (event: any) => {
    const msgs = event.messages ?? [];
    const last = [...msgs].reverse().find((m: any) => m.role === "assistant");
    if (!last) return;
    const text = (Array.isArray(last.content) ? last.content : []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    const m = text.match(/<memory_citation>([\s\S]*?)<\/memory_citation>/);
    if (!m) return;
    try {
      const ids: string[] = JSON.parse(m[1]).rollouts ?? [];
      state = loadState();
      for (const id of ids) if (state.stage1[id]) { state.stage1[id].usageCount++; state.stage1[id].lastUsage = Date.now(); }
      saveState(state);
    } catch {}
  });

  // ---------- tools ----------
  const safe = (p: string) => {
    const abs = path.resolve(ROOT, p);
    if (!abs.startsWith(ROOT)) throw new Error("path outside memory root");
    return abs;
  };
  pi.registerTool({
    name: "memories_list", label: "Memories: list", description: "List files in the local memory folder.",
    parameters: Type.Object({}),
    async execute() {
      const out: string[] = [];
      const walk = (d: string, rel = "") => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p, rel + f + "/"); else if (f.endsWith(".md")) out.push(rel + f); } };
      if (fs.existsSync(ROOT)) walk(ROOT);
      return { content: [{ type: "text", text: out.join("\n") || "(empty)" }], details: {} };
    },
  });
  pi.registerTool({
    name: "memories_search", label: "Memories: search", description: "Case-insensitive substring search across memory files. Returns file:line matches.",
    parameters: Type.Object({ query: Type.String(), file: Type.Optional(Type.String({ description: "Restrict to one file, e.g. MEMORY.md" })) }),
    async execute(_id, p) {
      const q = p.query.toLowerCase(); const hits: string[] = [];
      const walk = (d: string, rel = "") => { for (const f of fs.readdirSync(d)) { const full = path.join(d, f); if (fs.statSync(full).isDirectory()) walk(full, rel + f + "/"); else if (f.endsWith(".md") && (!p.file || rel + f === p.file)) read(full).split("\n").forEach((l, i) => { if (l.toLowerCase().includes(q)) hits.push(`${rel + f}:${i + 1}: ${l.trim().slice(0, 200)}`); }); } };
      if (fs.existsSync(ROOT)) walk(ROOT);
      return { content: [{ type: "text", text: hits.slice(0, 80).join("\n") || "(no matches)" }], details: {} };
    },
  });
  pi.registerTool({
    name: "memories_read", label: "Memories: read", description: "Read a memory file (optionally a line range).",
    parameters: Type.Object({ file: Type.String(), start: Type.Optional(Type.Integer()), end: Type.Optional(Type.Integer()) }),
    async execute(_id, p) {
      const lines = read(safe(p.file)).split("\n");
      const s = Math.max(1, p.start ?? 1), e = Math.min(lines.length, p.end ?? lines.length);
      return { content: [{ type: "text", text: lines.slice(s - 1, e).join("\n") || "(empty)" }], details: {} };
    },
  });
  pi.registerTool({
    name: "memories_add_note", label: "Memories: add note",
    description: "Only after an explicit user request to remember, update, or forget something. Appends a timestamped note consumed by the next consolidation.",
    parameters: Type.Object({ note: Type.String({ description: "What to remember / update / forget, in plain markdown" }) }),
    async execute(_id, p) {
      const d = path.join(ROOT, "notes"); fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
      if (fs.existsSync(f)) throw new Error("note exists");
      fs.writeFileSync(f, redact(p.note).trim() + "\n");
      return { content: [{ type: "text", text: `note saved: ${path.basename(f)} (applied on next consolidation)` }], details: {} };
    },
  });

  // ---------- commands ----------
  pi.registerCommand("memories", {
    description: "Memory pipeline: /memories [status|run|force|off|on|reset]",
    handler: async (args, ctx) => {
      const a = (args ?? "").trim();
      state = loadState();
      const notify = (m: string, t: "info" | "warning" | "error" = "info") => ctx.hasUI ? ctx.ui.notify(m, t) : console.log(m);
      if (a === "run" || a === "force") { notify("memories: running pipeline…"); const { n, r } = await runPipeline(ctx, a === "force"); return notify(`memories: extracted ${n}, consolidation ${r}`); }
      if (a === "off" || a === "on") {
        const id = ctx.sessionManager.getSessionId?.(); if (!id) return notify("no session id", "warning");
        state.disabledSessions = state.disabledSessions.filter(x => x !== id); if (a === "off") state.disabledSessions.push(id);
        saveState(state); return notify(`memories: this session ${a === "off" ? "excluded from" : "included in"} extraction`);
      }
      if (a === "reset") {
        const ok = ctx.hasUI ? await ctx.ui.confirm("Reset memories?", `Delete everything under ${ROOT}?`) : false;
        if (!ok) return; fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); return notify("memories: reset");
      }
      const sum = read(path.join(ROOT, "memory_summary.md"));
      notify(`memories: root=${ROOT}\nstage1=${Object.keys(state.stage1).length} summary=${sum ? sum.length + " chars" : "none"} lastPhase2=${state.phase2.lastSuccess ? new Date(state.phase2.lastSuccess).toLocaleString() : "never"}\nextract=${CFG.extractModel} consolidate=${CFG.consolidateModel || "(session model)"}`);
    },
  });
}
