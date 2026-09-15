// Read path: developer-instruction injection, citation parsing, dedicated memory tools.
// Mirrors codex-rs/ext/memories (prompts.rs, local/{list,read,search,ad_hoc_note}.rs) and
// codex-rs/memories/read/src/citations.rs.
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { markdownFiles, memoryPath, redact } from "../safety.js";
import { SUMMARY_TOKEN_LIMIT } from "./config.ts";
import { adHocNotesDir } from "./storage.ts";
import { truncateToTokens } from "./rollout.ts";

const PROMPTS = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "prompts");

/** build_memory_tool_developer_instructions: None when summary missing/empty. */
export function buildDeveloperInstructions(root: string): string | undefined {
  let summary: string; try { summary = fs.readFileSync(path.join(root, "memory_summary.md"), "utf8").trim(); } catch { return undefined; }
  summary = truncateToTokens(summary, SUMMARY_TOKEN_LIMIT);
  if (!summary) return undefined;
  return fs.readFileSync(path.join(PROMPTS, "read_path.md"), "utf8")
    .replace(/\{\{\s*base_path\s*\}\}/g, root)
    .replace(/\{\{\s*memory_summary\s*\}\}/g, summary);
}

// ---- citations (citations.rs) ----
export type CitationEntry = { path: string; lineStart: number; lineEnd: number; note: string };
export type MemoryCitation = { entries: CitationEntry[]; rolloutIds: string[] };

function block(text: string, open: string, close: string): string | undefined {
  const i = text.indexOf(open); if (i < 0) return undefined;
  const rest = text.slice(i + open.length); const j = rest.indexOf(close); if (j < 0) return undefined;
  return rest.slice(0, j);
}
function parseEntry(line: string): CitationEntry | undefined {
  line = line.trim(); if (!line) return undefined;
  const k = line.lastIndexOf("|note=["); if (k < 0) return undefined;
  const location = line.slice(0, k), noteRaw = line.slice(k + 7);
  if (!noteRaw.endsWith("]")) return undefined;
  const note = noteRaw.slice(0, -1).trim();
  const c = location.lastIndexOf(":"); if (c < 0) return undefined;
  const p = location.slice(0, c).trim(), range = location.slice(c + 1);
  const d = range.indexOf("-"); if (d < 0) return undefined;
  const s = Number.parseInt(range.slice(0, d).trim(), 10), e = Number.parseInt(range.slice(d + 1).trim(), 10);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return undefined;
  return { path: p, lineStart: s, lineEnd: e, note };
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

// ---- dedicated tools (memories.list/search/read/add_ad_hoc_note) ----
const MAX_SEARCH_RESULTS = 200, DEFAULT_SEARCH_MAX_RESULTS = 50;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

export function memoryTools(root: string) {
  return [
    {
      name: "memories_list", label: "Memories: list",
      description: "List memory files under the memory root (optionally under a relative sub-path).",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      async execute(_id: string, p: { path?: string }) {
        const files = (markdownFiles(root) as string[]).filter(f => !p.path || f.startsWith(p.path.replace(/\\/g, "/").replace(/\/?$/, "/")) || f === p.path);
        return text(files.join("\n") || "(empty)");
      },
    },
    {
      name: "memories_search", label: "Memories: search",
      description: "Search memory files for substring matches. Every query is trimmed and must be non-empty; match_mode 'any' (default) matches lines containing any query, 'all_on_line' requires all queries on the same line. Returns path:line: text with optional context lines.",
      parameters: Type.Object({
        queries: Type.Array(Type.String(), { minItems: 1 }),
        match_mode: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all_on_line")])),
        path: Type.Optional(Type.String()), context_lines: Type.Optional(Type.Integer({ minimum: 0 })),
        case_sensitive: Type.Optional(Type.Boolean()), max_results: Type.Optional(Type.Integer({ minimum: 1 })), cursor: Type.Optional(Type.String()),
      }),
      async execute(_id: string, p: any) {
        const queries: string[] = (p.queries ?? []).map((q: string) => String(q).trim());
        if (!queries.length || queries.some(q => !q)) throw new Error("queries must be non-empty");
        const cs = !!p.case_sensitive, norm = (s: string) => cs ? s : s.toLowerCase();
        const qs = queries.map(norm);
        const max = Math.min(MAX_SEARCH_RESULTS, p.max_results ?? DEFAULT_SEARCH_MAX_RESULTS);
        const start = p.cursor ? Number.parseInt(p.cursor, 10) : 0;
        if (!Number.isFinite(start) || start < 0) throw new Error("invalid cursor");
        const ctxN = p.context_lines ?? 0;
        const hits: string[] = [];
        for (const f of markdownFiles(root)) {
          if (p.path && !(f === p.path || f.startsWith(p.path.replace(/\/?$/, "/")))) continue;
          const lines = fs.readFileSync(memoryPath(root, f), "utf8").split("\n");
          lines.forEach((line, i) => {
            const l = norm(line);
            const ok = p.match_mode === "all_on_line" ? qs.every(q => l.includes(q)) : qs.some(q => l.includes(q));
            if (!ok) return;
            const s = Math.max(0, i - ctxN), e = Math.min(lines.length - 1, i + ctxN);
            hits.push(lines.slice(s, e + 1).map((x, k) => `${f}:${s + k + 1}${s + k === i ? ":" : "-"} ${x.slice(0, 300)}`).join("\n"));
          });
        }
        if (start > hits.length) throw new Error("cursor exceeds result count");
        const page = hits.slice(start, start + max);
        const next = start + max < hits.length ? `\n[next_cursor=${start + max}]` : "";
        return text((page.join("\n") || "(no matches)") + next);
      },
    },
    {
      name: "memories_read", label: "Memories: read",
      description: "Read a memory file (path relative to the memory root), optionally a 1-based line range.",
      parameters: Type.Object({ path: Type.String(), start: Type.Optional(Type.Integer({ minimum: 1 })), end: Type.Optional(Type.Integer({ minimum: 1 })) }),
      async execute(_id: string, p: { path: string; start?: number; end?: number }) {
        const lines = fs.readFileSync(memoryPath(root, p.path), "utf8").split("\n");
        const s = Math.max(1, p.start ?? 1), e = Math.min(lines.length, p.end ?? lines.length);
        return text(lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join("\n") || "(empty)");
      },
    },
    {
      name: "memories_add_ad_hoc_note", label: "Memories: add ad-hoc note",
      description: "Create one append-only ad-hoc memory note after the user explicitly asks to remember, forget, or update something. Never use it without such a direct request. The note is consolidated into memory on the next background consolidation.",
      parameters: Type.Object({
        filename: Type.String({ description: "YYYY-MM-DDTHH-MM-SS-<slug>.md; slug = lowercase ASCII letters, digits, hyphens", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-[a-z0-9][a-z0-9-]{0,79}\\.md$" }),
        note: Type.String({ minLength: 1, description: "Verbatim Markdown note" }),
      }),
      async execute(_id: string, p: { filename: string; note: string }) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,79}\.md$/.test(p.filename) || Buffer.byteLength(p.filename) > 128) throw new Error("invalid filename");
        if (!p.note.trim()) throw new Error("note must not be empty");
        const dir = adHocNotesDir(root); fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, p.filename);
        fs.writeFileSync(f, redact(p.note), { flag: "wx" }); // create_new: refuse overwrite
        return text(`created extensions/ad_hoc/notes/${p.filename}`);
      },
    },
  ];
}
