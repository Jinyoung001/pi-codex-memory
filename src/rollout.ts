// Session (.jsonl) indexing and stage-1 input rendering.
// Mirrors codex memories/write/src/rollout_input.rs sanitize_response_item_for_memories (V1 path):
// drop developer/system-injected content, keep user/assistant/tool items, redact, truncate to token budget.
import * as fs from "node:fs";
import * as path from "node:path";
import { redact } from "../safety.js";
import { SESSIONS_DIR, STAGE1 } from "./config.ts";
import type { ThreadRow } from "./store.ts";

export type SessionMeta = { id: string; cwd: string; file: string; mtimeMs: number; parentSession?: string };

const BYTES_PER_TOKEN = 4; // codex_utils_output_truncation::approx_bytes_for_tokens

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
function isInjectedUserText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("# Memories (local recall layer)") || t.startsWith("## Memory\n")
    || t.startsWith("[PI PLAN MODE CONTRACT") || t.startsWith("# AGENTS.md instructions")
    || t.startsWith("<skill>") || t.startsWith("<system-reminder>") || t.startsWith("<environment_context>");
}

function textOf(content: unknown, opts: { toolCalls: boolean }): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content as Part[]) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
    else if (p.type === "image") parts.push("[image omitted]");
    else if (p.type === "toolCall" && opts.toolCalls) parts.push(`[tool_call ${p.name}] ${JSON.stringify(p.arguments ?? {})}`);
    // thinking blocks are never persisted into memory input
  }
  return parts.join("\n");
}

/**
 * Walk the active branch of a pi session file (entries form a tree via parentId; the last entry's
 * ancestor chain is the branch the user ended on) and render it as memory-relevant text.
 */
export function renderSession(file: string): { id: string; cwd: string; text: string } {
  const raw = fs.readFileSync(file, "utf8");
  let id = "", cwd = "";
  const byId = new Map<string, any>();
  let last: any = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "session") { id = e.id ?? ""; cwd = e.cwd ?? ""; continue; }
    if (typeof e.id !== "string") continue;
    byId.set(e.id, e); last = e;
  }
  // Active branch = chain from last entry to root.
  const branch: any[] = [];
  for (let cur = last; cur; cur = cur.parentId ? byId.get(cur.parentId) : null) branch.push(cur);
  branch.reverse();

  const out: string[] = [];
  for (const e of branch) {
    if (e.type === "custom_message") continue;           // extension-injected context
    if (e.type === "compaction") continue;               // codex drops Compacted items
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    if (m.role === "user") {
      const t = textOf(m.content, { toolCalls: false });
      if (!t.trim() || isInjectedUserText(t)) continue;
      out.push(`[human user]\n${t}`);
    } else if (m.role === "assistant") {
      const t = textOf(m.content, { toolCalls: true });
      if (t.trim()) out.push(`[assistant]\n${t}`);
    } else if (m.role === "toolResult") {
      const t = textOf(m.content, { toolCalls: false });
      const capped = t.length > 8_000 ? t.slice(0, 8_000) + "\n[... tool output truncated ...]" : t; // ~2k tokens, codex TOOL_OUTPUT_TOKENS
      out.push(`[tool ${m.toolName}${m.isError ? " (error)" : ""}]\n${capped}`);
    }
  }
  return { id, cwd, text: redact(out.join("\n\n")) };
}

/** Head+tail truncation to a token budget (codex truncate_text TruncationPolicy::Tokens). */
export function truncateToTokens(text: string, tokenLimit: number): string {
  const max = tokenLimit * BYTES_PER_TOKEN;
  if (Buffer.byteLength(text) <= max) return text;
  const head = Math.floor(max * 0.5), tail = max - head;
  return text.slice(0, head) + "\n[... rollout truncated ...]\n" + text.slice(-tail);
}

export function rolloutTokenLimit(contextWindow: number | undefined): number {
  if (!contextWindow || contextWindow <= 0) return STAGE1.DEFAULT_ROLLOUT_TOKEN_LIMIT;
  return Math.max(1, Math.floor(contextWindow * STAGE1.CONTEXT_WINDOW_PERCENT / 100));
}
