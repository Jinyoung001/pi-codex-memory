// Tool surface for the Phase 2 consolidation agent. Codex runs a sandboxed sub-agent with
// WorkspaceWrite{writable_roots:[memory_root], network:false}; pi has no OS sandbox for extension
// code, so the equivalent boundary is enforced here: every tool resolves paths inside the memory
// root, rejects symlinks/junctions, and there is no shell or network tool at all.
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";

const MAX_READ_BYTES = 200_000;
const MAX_GREP_HITS = 200;

export class RootJail {
  readonly root: string;
  constructor(root: string) { this.root = fs.realpathSync(root); }
  resolve(rel: string, { mustExist = true } = {}): string {
    if (typeof rel !== "string" || !rel.trim()) throw new Error("path required");
    if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error("absolute paths are not allowed; use paths relative to the memory root");
    const target = path.resolve(this.root, rel);
    const relative = path.relative(this.root, target);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("path escapes memory root");
    if (relative.split(path.sep)[0] === ".git") throw new Error(".git is not accessible");
    // No symlink/junction anywhere along the existing prefix.
    let cur = this.root;
    for (const seg of relative.split(path.sep).filter(Boolean)) {
      cur = path.join(cur, seg);
      let st: fs.Stats; try { st = fs.lstatSync(cur); } catch { if (mustExist) throw new Error(`not found: ${rel}`); break; }
      if (st.isSymbolicLink()) throw new Error("symbolic links are not allowed in the memory root");
    }
    return target;
  }
  rel(abs: string) { return path.relative(this.root, abs).split(path.sep).join("/"); }
}

function listDir(jail: RootJail, dirRel: string, recursive: boolean): string[] {
  const out: string[] = [];
  const start = jail.resolve(dirRel || ".");
  const stack = [start];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git" || e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out.push(jail.rel(p) + "/"); if (recursive) stack.push(p); }
      else if (e.isFile()) out.push(`${jail.rel(p)} (${fs.statSync(p).size} bytes)`);
    }
  }
  return out;
}

export function consolidationTools(jail: RootJail) {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const tools: { def: { name: string; description: string; parameters: any }; run: (a: any) => Promise<{ content: { type: "text"; text: string }[] }> }[] = [
    {
      def: { name: "list", description: "List files under a directory of the memory root (relative path, '.' for root).", parameters: Type.Object({ path: Type.Optional(Type.String()), recursive: Type.Optional(Type.Boolean()) }) },
      run: async a => text(listDir(jail, a.path ?? ".", a.recursive ?? false).join("\n") || "(empty)"),
    },
    {
      def: { name: "read", description: "Read a UTF-8 text file inside the memory root. Optional 1-based line range.", parameters: Type.Object({ path: Type.String(), start: Type.Optional(Type.Integer({ minimum: 1 })), end: Type.Optional(Type.Integer({ minimum: 1 })) }) },
      run: async a => {
        const p = jail.resolve(a.path);
        if (!fs.statSync(p).isFile()) throw new Error("not a file");
        const buf = fs.readFileSync(p);
        if (buf.length > MAX_READ_BYTES && !a.start) return text(buf.subarray(0, MAX_READ_BYTES).toString("utf8") + `\n[... truncated at ${MAX_READ_BYTES} bytes; use start/end line ranges ...]`);
        const lines = buf.toString("utf8").split("\n");
        const s = Math.max(1, a.start ?? 1), e = Math.min(lines.length, a.end ?? lines.length);
        return text(lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join("\n"));
      },
    },
    {
      def: { name: "grep", description: "Case-insensitive substring/regex search across files under the memory root. Returns path:line: text.", parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), regex: Type.Optional(Type.Boolean()) }) },
      run: async a => {
        const re = a.regex ? new RegExp(a.pattern, "i") : null; const q = String(a.pattern).toLowerCase();
        const hits: string[] = [];
        const start = jail.resolve(a.path ?? ".");
        const files = fs.statSync(start).isFile() ? [start] : listDir(jail, a.path ?? ".", true).filter(l => !l.endsWith("/")).map(l => jail.resolve(l.replace(/ \(\d+ bytes\)$/, "")));
        for (const f of files) {
          if (hits.length >= MAX_GREP_HITS) break;
          let content: string; try { content = fs.readFileSync(f, "utf8"); } catch { continue; }
          content.split("\n").forEach((line, i) => { if (hits.length < MAX_GREP_HITS && (re ? re.test(line) : line.toLowerCase().includes(q))) hits.push(`${jail.rel(f)}:${i + 1}: ${line.slice(0, 300)}`); });
        }
        return text(hits.join("\n") || "(no matches)");
      },
    },
    {
      def: { name: "write", description: "Create or overwrite a text file inside the memory root (parent directories are created).", parameters: Type.Object({ path: Type.String(), content: Type.String() }) },
      run: async a => { const p = jail.resolve(a.path, { mustExist: false }); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, a.content); return text(`wrote ${jail.rel(p)} (${Buffer.byteLength(a.content)} bytes)`); },
    },
    {
      def: { name: "edit", description: "Replace an exact, unique text block in a file inside the memory root.", parameters: Type.Object({ path: Type.String(), old: Type.String(), new: Type.String() }) },
      run: async a => {
        const p = jail.resolve(a.path); const s = fs.readFileSync(p, "utf8");
        const i = s.indexOf(a.old); if (i < 0) throw new Error("old text not found"); if (s.indexOf(a.old, i + 1) >= 0) throw new Error("old text is not unique");
        fs.writeFileSync(p, s.slice(0, i) + a.new + s.slice(i + a.old.length)); return text(`edited ${jail.rel(p)}`);
      },
    },
    {
      def: { name: "delete", description: "Delete a file (or empty directory) inside the memory root. Never deletes ad-hoc notes or the workspace diff.", parameters: Type.Object({ path: Type.String() }) },
      run: async a => {
        const p = jail.resolve(a.path); const rel = jail.rel(p);
        if (rel.startsWith("extensions/ad_hoc/notes/") || rel === "phase2_workspace_diff.md") throw new Error("this file must not be deleted");
        const st = fs.lstatSync(p); if (st.isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p); return text(`deleted ${rel}`);
      },
    },
    {
      def: { name: "mkdir", description: "Create a directory inside the memory root.", parameters: Type.Object({ path: Type.String() }) },
      run: async a => { const p = jail.resolve(a.path, { mustExist: false }); fs.mkdirSync(p, { recursive: true }); return text(`created ${jail.rel(p)}/`); },
    },
    {
      def: { name: "done", description: "Call exactly once when consolidation is complete and MEMORY.md + memory_summary.md are final.", parameters: Type.Object({ summary: Type.String({ description: "One paragraph: what changed" }) }) },
      run: async a => text(`done: ${a.summary}`),
    },
  ];
  return tools;
}
