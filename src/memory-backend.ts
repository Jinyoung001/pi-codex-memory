// Local Codex memory-tool contract. No hidden files, traversal, symlinks or invalid UTF-8.
import * as fs from "node:fs";
import * as path from "node:path";
import { RootJail } from "./agent-tools.ts";
import { truncateTokens as truncateToTokens } from "./codex-truncate.ts";
import { readBounded } from '../safety.js';

const decode = (file: string) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readBounded(file));
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function scoped(root: string, relative = ".") {
  if (relative.split(/[\\/]/).some(p => p === ".." || (p.startsWith(".") && p !== "."))) throw new Error("invalid memory path");
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("memory root must not be a symlink");
  return new RootJail(root).resolve(relative || ".");
}
function page<T>(items: T[], cursor: string | undefined, max: number, cap: number) {
  const start = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(start) || start < 0 || start > items.length || (cursor !== undefined && !/^\+?\d+$/.test(cursor))) throw new Error("invalid cursor");
  if (!Number.isSafeInteger(max) || max < 1) throw new Error("max_results must be positive");
  const end = Math.min(items.length, start + Math.min(max, cap));
  return { items: items.slice(start, end), next_cursor: end < items.length ? String(end) : null, truncated: end < items.length };
}
function children(dir: string) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith(".") && !e.isSymbolicLink() && (e.isFile() || e.isDirectory())).sort((a, b) => compare(a.name, b.name));
}
export function listMemories(root: string, p: { path?: string; cursor?: string; max_results?: number }) {
  const target = scoped(root, p.path), jail = new RootJail(root);
  const entries = fs.statSync(target).isFile() ? [{ path: jail.rel(target), entry_type: "file" }] : children(target).map(e => ({ path: jail.rel(path.join(target, e.name)), entry_type: e.isDirectory() ? "directory" : "file" }));
  const result = page(entries, p.cursor, p.max_results ?? 2000, 2000);
  return { path: p.path ?? null, entries: result.items, next_cursor: result.next_cursor, truncated: result.truncated };
}
export function readMemory(root: string, p: { path: string; line_offset?: number; max_lines?: number; max_tokens?: number }) {
  const file = scoped(root, p.path);
  if (!fs.statSync(file).isFile()) throw new Error("not a file");
  const original = decode(file), offset = p.line_offset ?? 1;
  if (!Number.isSafeInteger(offset) || offset < 1) throw new Error("line_offset must be positive");
  if (p.max_lines !== undefined && (!Number.isSafeInteger(p.max_lines) || p.max_lines < 1)) throw new Error("max_lines must be positive");
  let start = 0;
  for (let line = 1; line < offset; line++) { const i = original.indexOf("\n", start); if (i < 0) throw new Error("line_offset exceeds file length"); start = i + 1; }
  let end = original.length;
  if (p.max_lines !== undefined) {
    let position = start;
    for (let line = 0; line < p.max_lines; line++) { const i = original.indexOf("\n", position); if (i < 0) break; position = i + 1; if (line + 1 === p.max_lines) end = position; }
  }
  const tokens = p.max_tokens === undefined || p.max_tokens === 0 ? 20000 : p.max_tokens;
  if (!Number.isSafeInteger(tokens) || tokens < 1) throw new Error("max_tokens must be positive");
  const selected = original.slice(start, end), content = truncateToTokens(selected, tokens);
  return { path: p.path, start_line_number: offset, content, truncated: end < original.length || content !== selected };
}
export type MatchMode = { type: "any" } | { type: "all_on_same_line" } | { type: "all_within_lines"; line_count: number };
export function searchMemories(root: string, p: { queries: string[]; match_mode?: MatchMode; path?: string; cursor?: string; context_lines?: number; case_sensitive?: boolean; normalized?: boolean; max_results?: number }) {
  const offset = p.cursor === undefined ? 0 : Number(p.cursor), limit = Math.min(p.max_results ?? 200, 200);
  if (!Number.isSafeInteger(offset) || offset < 0 || (p.cursor !== undefined && !/^\+?\d+$/.test(p.cursor))) throw new Error('invalid cursor');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('max_results must be positive');
  if (!Array.isArray(p.queries) || !p.queries.length || p.queries.some(q => typeof q !== "string" || !q.trim())) throw new Error("queries must not be empty");
  const queries = p.queries.map(q => q.trim()), mode = p.match_mode ?? { type: "any" };
  const normalize = (s: string) => { const value = p.case_sensitive === false ? s.toLowerCase() : s; return p.normalized ? value.replace(/[^\p{Alphabetic}\p{N}]/gu, "") : value; };
  const prepared = queries.map(normalize);
  if (prepared.some(q => !q)) throw new Error("normalized queries must not be empty");
  const size = mode.type === "all_within_lines" ? mode.line_count : 1, context = p.context_lines ?? 0;
  if (!["any", "all_on_same_line", "all_within_lines"].includes(mode.type) || !Number.isSafeInteger(size) || size < 1) throw new Error("invalid match window");
  if (!Number.isSafeInteger(context) || context < 0) throw new Error("invalid context_lines");
  if (size > 1000 || context > 1000 || queries.length > 100 || queries.some(q => q.length > 10000)) throw new Error('search input budget exceeded; narrow query');
  const start = scoped(root, p.path), jail = new RootJail(root), files: string[] = [], pending = [start];
  let entries = 0;
  while (pending.length) { if (++entries > 10000) throw new Error('search file budget exceeded; narrow path'); const current = scoped(root, jail.rel(pending.pop()!) || '.'); if (fs.statSync(current).isFile()) files.push(current); else for (const entry of children(current)) pending.push(path.join(current, entry.name)); }
  const matches: { path: string; match_line_number: number; content_start_line_number: number; content: string; matched_queries: string[] }[] = [];
  let seen = 0, scanned = 0, hasMore = false;
  filesLoop: for (const file of files.sort(compare)) {
    let content: string;
    try { content = decode(scoped(root, jail.rel(file))); } catch (e) { if (e instanceof TypeError) continue; throw e; }
    scanned += Buffer.byteLength(content);
    if (scanned > 32 * 1024 * 1024) throw new Error('search byte budget exceeded; narrow path');
    const lines = content ? content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
    const flags = lines.map(line => { const text = normalize(line); return prepared.map(q => text.includes(q)); });
    const windows: { start: number; end: number; found: boolean[] }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!flags[i].some(Boolean)) continue;
      const found = prepared.map(() => false);
      for (let j = i; j < Math.min(lines.length, i + size); j++) {
        flags[j].forEach((yes, k) => { found[k] ||= yes; });
        if (mode.type === "any" ? found.some(Boolean) : found.every(Boolean)) { windows.push({ start: i, end: j, found }); break; }
      }
    }
    const minimal = new Set<number>(); let nextEnd = Infinity;
    for (let i = windows.length - 1; i >= 0; i--) { if (windows[i].end < nextEnd) minimal.add(i); nextEnd = Math.min(nextEnd, windows[i].end); }
    for (let i = 0; i < windows.length; i++) {
      if (!minimal.has(i)) continue;
      if (seen++ < offset) continue;
      if (matches.length === limit) { hasMore = true; break filesLoop; }
      const window = windows[i];
      const from = Math.max(0, window.start - context), to = Math.min(lines.length, window.end + context + 1);
      matches.push({ path: jail.rel(file), match_line_number: window.start + 1, content_start_line_number: from + 1, content: lines.slice(from, to).join("\n"), matched_queries: queries.filter((_, i) => window.found[i]) });
    }
  }
  if (offset > seen) throw new Error('invalid cursor');
  return { queries, match_mode: mode, path: p.path ?? null, matches, next_cursor: hasMore ? String(offset + matches.length) : null, truncated: hasMore };
}
