// Session (.jsonl) indexing and stage-1 input rendering.
// Mirrors codex memories/write/src/rollout_input.rs sanitize_response_item_for_memories (V1 path):
// drop developer/system-injected content, keep user/assistant/tool items, redact, truncate to token budget.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { redact } from "../safety.js";
import { truncateTokens } from "./codex-truncate.ts";
import { SESSIONS_DIR, STAGE1 } from "./config.ts";
import type { ThreadRow } from "./store.ts";

export type SessionMeta = { id: string; cwd: string; file: string; mtimeMs: number; parentSession?: string };

export function listSessionFiles(): { file: string; mtimeMs: number }[] {
  const out: { file: string; mtimeMs: number }[] = [];
  if (!fs.existsSync(SESSIONS_DIR)) return out;
  for (const d of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || d.isSymbolicLink()) continue;
    const dir = path.join(SESSIONS_DIR, d.name);
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const p = path.join(dir, f.name);
      try { out.push({ file: p, mtimeMs: fs.statSync(p).mtimeMs }); } catch { /* vanished */ }
    }
  }
  return out;
}

/** Read only the header line: cheap enough to run for every session at startup. */
export function readSessionHeader(file: string, mtimeMs: number): SessionMeta | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const line = buf.toString("utf8", 0, n).split("\n", 1)[0];
    const h = JSON.parse(line);
    if (h?.type !== "session" || typeof h.id !== "string") return null;
    return { id: h.id, cwd: String(h.cwd ?? ""), file, mtimeMs, parentSession: h.parentSession };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function indexSessions(upsert: (t: ThreadRow) => void): number {
  let n = 0;
  for (const s of listSessionFiles()) {
    const meta = readSessionHeader(s.file, s.mtimeMs);
    if (!meta) continue;
    upsert({ id: meta.id, rolloutPath: meta.file, cwd: meta.cwd, updatedAtMs: meta.mtimeMs, memoryMode: "enabled", gitBranch: null });
    n++;
  }
  return n;
}

// ---- rendering ----
type Part = { type?: string; text?: string; name?: string; arguments?: unknown; thinking?: string };

/** pi custom entries injected by extensions (memory summaries, plan contracts, AGENTS.md) are not user evidence. */
export function isInjectedUserText(text: string): boolean {
  const t = text.trim();
  return t.startsWith("# Memories (local recall layer)") || t.startsWith("## Memory\n")
    || t.startsWith("[PI PLAN MODE CONTRACT")
    || (/^# AGENTS\.md instructions/i.test(t) && /<\/INSTRUCTIONS>$/i.test(t))
    || (/^<skill>/i.test(t) && /<\/skill>$/i.test(t));
}

function textOf(content: unknown, opts: { toolCalls: boolean; user?: boolean }): string {
  if (typeof content === "string") return opts.user && isInjectedUserText(content) ? "" : content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content as Part[]) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string" && !(opts.user && isInjectedUserText(p.text))) parts.push(p.text);
    else if (p.type === "image") parts.push("[image omitted]");
    else if (p.type === "audio") parts.push("[audio omitted]");
    else if (p.type === "toolCall" && opts.toolCalls) parts.push(`[tool_call ${p.name}] ${JSON.stringify(p.arguments ?? {})}`);
    // thinking blocks are never persisted into memory input
  }
  return parts.join("\n");
}

/**
 * Walk the active branch of a pi session file (entries form a tree via parentId; the last entry's
 * ancestor chain is the branch the user ended on) and render it as memory-relevant text.
 */
export type Evidence = { id:string; parentId:string|null; branchHead:string|null; role:string; source:string; phase:string|null; message:any };
export function normalizeSession(file: string): {id:string;cwd:string;evidence:Evidence[]} {
  const raw = fs.readFileSync(file, "utf8");
  let id = "", cwd = "";
  const byId = new Map<string, any>();
  let last: any = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    if (e.type === "session") { id = e.id ?? ""; cwd = e.cwd ?? ""; continue; }
    if (typeof e.id !== "string") continue;
    byId.set(e.id, e); last = e;
  }
  // Active branch = chain from last entry to root.
  const branch: any[] = [], seen = new Set<string>();
  for (let cur = last; cur; cur = cur.parentId ? byId.get(cur.parentId) : null) {
    if (seen.has(cur.id)) throw new Error("cyclic session branch");
    seen.add(cur.id); branch.push(cur);
  }
  branch.reverse();

  const evidence:Evidence[]=branch.filter(e=>e.type==="message"&&e.message).map(e=>({
    id:e.id,parentId:e.parentId??null,branchHead:last?.id??null,role:e.message.role,
    source:typeof e.message.source==="string"?e.message.source:typeof e.source==="string"?e.source:"unknown",
    phase:typeof e.message.phase==="string"?e.message.phase:null,message:e.message,
  }));
  return {id,cwd,evidence};
}

// Host addition (not upstream): shrink tool results before stage-1 extraction. Tool output is ~70% of a
// rollout and mostly file dumps/command noise; user and assistant text is never touched. Errors keep a
// larger budget because failures are what memory is for. Deterministic, no external tools.
export const ERROR_BUDGET_MULTIPLIER = 3;
export function compactToolResult(text: string, budget: number, isError: boolean, seen: Map<string, number>, index: number): string {
  if (!(budget > 0)) return text;
  if (text.length > 200) {
    const key = createHash('sha256').update(text).digest('hex');
    const first = seen.get(key);
    if (first !== undefined) return `[identical to tool result #${first}]`;
    seen.set(key, index);
  }
  // Fold runs of identical non-blank lines (rtk-style dedup): progress bars, repeated warnings, log spam.
  const lines = text.split('\n'), folded: string[] = [];
  for (let i = 0; i < lines.length; i++) { let n = 1; while (i + n < lines.length && lines[i + n] === lines[i]) n++; folded.push(n > 2 && lines[i].trim() ? `${lines[i]}\n[… same line ×${n}]` : lines.slice(i, i + n).join('\n')); i += n - 1; }
  return truncateTokens(folded.join('\n'), isError ? budget * ERROR_BUDGET_MULTIPLIER : budget);
}

export function renderSession(file: string, toolResultTokenBudget = 0): { id: string; cwd: string; text: string; rows: string[]; evidence:Evidence[] } {
  const {id,cwd,evidence}=normalizeSession(file);

  const out: string[] = [], rows: string[] = [];
  const questions=new Map<string,string>();
  const seenResults = new Map<string, number>(); let resultIndex = 0;
  for (const e of evidence) {
    const m = e.message;
    const kinds=m.internal_chat_message_metadata_passthrough?.content_item_kinds;
    const agentKinds=Array.isArray(kinds)&&kinds.some((k:any)=>typeof k==="string"&&k.startsWith("multi_agent."));
    if (m.role === "user") {
      const t = textOf(m.content, { toolCalls: false, user: true });
      if (!t.trim()) continue;
      const agent = agentKinds || t.trimStart().startsWith("<subagent_notification>") || /^Message Type:.*\nTask name:.*\nSender:.*\nPayload:\s*(?:\n|$)/.test(t.trimStart());
      const context = (Array.isArray(kinds)&&kinds.length>0&&kinds.every((k:any)=>typeof k==="string"&&!k.startsWith("user."))) || (Array.isArray(m.content)?m.content:[{text:t}]).some((p:any)=>p && typeof p.text==="string"&&/^<environment_context>[\s\S]*<\/environment_context>$/i.test(p.text.trim()));
      const row = `[${agent ? "other agent" : context ? "harness context" : "human user"}]\n${t}`;
      out.push(row); rows.push(row);
    } else if (m.role === "assistant") {
      const t = textOf(m.content, { toolCalls: true });
      if (t.trim()) out.push(`[assistant]\n${t}`);
      const prose = textOf(m.content, { toolCalls: false });
      // Missing phase stays unknown; upstream assigns non-commentary messages to Final.
      if (prose.trim()) rows.push(`[${agentKinds?"other agent":e.phase === "commentary" ? "assistant commentary" : "assistant final"}]\n${prose}`);
      if (Array.isArray(m.content)) for (const part of m.content) {
        if (part?.type === "toolCall") {
          if(part.name==="request_user_input"&&(!part.namespace||part.namespace==="functions"))questions.set(part.id,JSON.stringify(part.arguments??{}));
          rows.push(`[tool call]\n${JSON.stringify({ name: part.name, arguments: part.arguments ?? {} })}`);
        }
      }
    } else if (m.role === "toolResult") {
      // Human replies to request_user_input are user evidence: never compacted, checked on the raw text.
      const rawText = textOf(m.content, { toolCalls: false });
      const index = ++resultIndex;
      const t = questions.has(m.toolCallId) ? rawText : compactToolResult(rawText, toolResultTokenBudget, !!m.isError, seenResults, index);
      const row = `[tool ${m.toolName}${toolResultTokenBudget > 0 ? ` #${index}` : ""}${m.isError ? " (error)" : ""}]\n${t}`;
      out.push(row);
      let human=false;
      try {const value=JSON.parse(t);human=questions.has(m.toolCallId)&&Object.values(value.answers??{}).some((a:any)=>Array.isArray(a.answers)&&a.answers.some((s:any)=>typeof s==="string"&&s.trim()));}catch{/* ordinary tool output */}
      if(human){rows.push(`[human user]\nAssistant question: ${questions.get(m.toolCallId)}\nHuman reply: ${t}`);questions.delete(m.toolCallId);}else rows.push(row);
    }
  }
  return { id, cwd, text: redact(out.join("\n\n")), rows: rows.map(redact), evidence };
}

export { truncateTokens as truncateToTokens } from "./codex-truncate.ts";

export function rolloutTokenLimit(contextWindow: number | undefined): number {
  if (!contextWindow || contextWindow <= 0) return STAGE1.DEFAULT_ROLLOUT_TOKEN_LIMIT;
  return Math.max(1, Math.floor(contextWindow * STAGE1.CONTEXT_WINDOW_PERCENT / 100));
}
