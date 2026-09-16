// Codex V1 read prompt, citations, and structured local retrieval tools.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { SUMMARY_TOKEN_LIMIT } from "./config.ts";
import { RootJail } from "./agent-tools.ts";
import { truncateTokens as truncateToTokens } from "./codex-truncate.ts";
import { listMemories, readMemory, searchMemories } from "./memory-backend.ts";

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");
export function buildDeveloperInstructions(root: string, version: "v1" | "v2" = "v1"): string | undefined {
  let summary: string;
  try { summary = fs.readFileSync(new RootJail(root).resolve("memory_summary.md"), "utf8").trim(); } catch { return undefined; }
  summary = truncateToTokens(summary, SUMMARY_TOKEN_LIMIT);
  if (!summary) return undefined;
  return fs.readFileSync(path.join(PROMPTS, version === "v2" ? "read_path_v2.md" : "read_path.md"), "utf8")
    .replace(/\{\{\s*base_path\s*\}\}/g, () => root)
    .replace(/\{\{\s*memory_summary\s*\}\}/g, () => summary);
}

export type CitationEntry = { path: string; lineStart: number; lineEnd: number; note: string };
export type MemoryCitation = { entries: CitationEntry[]; rolloutIds: string[] };
function block(text: string, open: string, close: string): string | undefined {
  const i = text.indexOf(open); if (i < 0) return undefined;
  const rest = text.slice(i + open.length), j = rest.indexOf(close);
  return j < 0 ? undefined : rest.slice(0, j);
}
function parseEntry(line: string): CitationEntry | undefined {
  const match = line.trim().match(/^(.*):(\d+)\s*-\s*(\d+)\|note=\[(.*)\]$/);
  if (!match) return undefined;
  const s = Number(match[2]), e = Number(match[3]);
  if (!match[1].trim() || !Number.isSafeInteger(s) || !Number.isSafeInteger(e) || s < 1 || e < s) return undefined;
  return { path: match[1].trim(), lineStart: s, lineEnd: e, note: match[4].trim() };
}
export function parseMemoryCitation(texts: string[]): MemoryCitation | undefined {
  const entries: CitationEntry[] = [], rolloutIds: string[] = [], seen = new Set<string>();
  for (const t of texts) {
    const eb = block(t, "<citation_entries>", "</citation_entries>");
    if (eb) for (const l of eb.split("\n")) { const e = parseEntry(l); if (e) entries.push(e); }
    const ib = block(t, "<rollout_ids>", "</rollout_ids>") ?? block(t, "<thread_ids>", "</thread_ids>");
    if (ib) for (const raw of ib.split("\n")) { const id = raw.trim(); if (id && !seen.has(id)) { seen.add(id); rolloutIds.push(id); } }
  }
  return entries.length || rolloutIds.length ? { entries, rolloutIds } : undefined;
}
export const CITATION_OPEN = "<oai-mem-citation>", CITATION_CLOSE = "</oai-mem-citation>";
export function extractCitationBlocks(text: string): string[] {
  const out: string[] = []; let i = 0;
  while ((i = text.indexOf(CITATION_OPEN, i)) >= 0) { const j = text.indexOf(CITATION_CLOSE, i); if (j < 0) break; out.push(text.slice(i, j + CITATION_CLOSE.length)); i = j + CITATION_CLOSE.length; }
  return out;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const threadIdsFromCitation = (c: MemoryCitation) => c.rolloutIds.filter(id => UUID_RE.test(id));
const json = (value: object) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
const object = (properties: Record<string, any>) => Type.Object(properties, { additionalProperties: false });
const paging = { path: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()), max_results: Type.Optional(Type.Integer({ minimum: 1 })) };

export function memoryTools(root: string, mutate: (fn: () => any) => any = fn => fn()) {
  return [
    { name: "memories_list", label: "Memories: list", description: "List visible memory files and directories with cursor pagination.", parameters: object(paging),
      async execute(_id: string, p: any) { return json(listMemories(root, p)); } },
    { name: "memories_search", label: "Memories: search", description: "Substring search with optional separator normalization and same-line or minimal line-window AND matching.",
      parameters: object({ ...paging, queries: Type.Array(Type.String(), { minItems: 1 }),
        match_mode: Type.Optional(Type.Union([object({ type: Type.Literal("any") }), object({ type: Type.Literal("all_on_same_line") }), object({ type: Type.Literal("all_within_lines"), line_count: Type.Integer({ minimum: 1 }) })])),
        context_lines: Type.Optional(Type.Integer({ minimum: 0 })), case_sensitive: Type.Optional(Type.Boolean()), normalized: Type.Optional(Type.Boolean()) }),
      async execute(_id: string, p: any) { return json(searchMemories(root, p)); } },
    { name: "memories_read", label: "Memories: read", description: "Read a visible UTF-8 memory file from a 1-based line_offset, bounded by max_lines and max_tokens.",
      parameters: object({ path: Type.String(), line_offset: Type.Optional(Type.Integer({ minimum: 1 })), max_lines: Type.Optional(Type.Integer({ minimum: 1 })), max_tokens: Type.Optional(Type.Integer({ minimum: 1 })) }),
      async execute(_id: string, p: any) { return json(readMemory(root, p)); } },
    { name: "memories_add_ad_hoc_note", label: "Memories: add ad-hoc note", description: "Create one append-only verbatim Markdown note only after an explicit user request to remember, forget, or update something.",
      parameters: object({ filename: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-[a-z0-9][a-z0-9-]{0,79}\\.md$", minLength: 24, maxLength: 128 }), note: Type.String({ minLength: 1 }) }),
      async execute(_id: string, p: { filename: string; note: string }) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,79}\.md$/.test(p.filename) || Buffer.byteLength(p.filename) > 128) throw new Error("invalid filename");
        if (typeof p.note !== "string" || !p.note.trim()) throw new Error("note must not be empty");
        return mutate(() => {
          fs.mkdirSync(root, { recursive: true });
          if (fs.lstatSync(root).isSymbolicLink()) throw new Error("memory root must not be a symlink");
          const jail = new RootJail(root), relative = `extensions/ad_hoc/notes/${p.filename}`;
          const f = jail.resolve(relative, { mustExist: false });
          fs.mkdirSync(path.dirname(f), { recursive: true }); jail.resolve(relative, { mustExist: false });
          fs.writeFileSync(f, p.note, { flag: "wx" });
          return json({});
        });
      } },
  ];
}
