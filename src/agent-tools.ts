// Tool surface for the Phase 2 consolidation agent. Codex runs a sandboxed sub-agent with
// WorkspaceWrite{writable_roots:[memory_root], network:false}; pi has no OS sandbox for extension
// code. These checks require a tree owned by the user, without hostile concurrent writers. Every tool resolves paths inside the memory
// root, rejects symlinks/junctions, and there is no shell or network tool at all.
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import { assertTrustedPath, atomicWrite, readBounded, withFileLock } from "../safety.js";
import { truncateBytes } from "./codex-truncate.ts";

const MAX_READ_BYTES = 200_000;
const MAX_GREP_HITS = 200;

export class RootJail {
  readonly root: string;
  constructor(root: string) {
    assertTrustedPath(root);
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error("memory root must not be a symlink");
    this.root = fs.realpathSync(root);
  }
  resolve(rel: string, { mustExist = true } = {}): string {
    assertTrustedPath(this.root);
    if (typeof rel !== "string" || !rel.trim()) throw new Error("path required");
    if (path.isAbsolute(rel) || rel.includes(":")) throw new Error("absolute paths are not allowed; use paths relative to the memory root");
    const target = path.resolve(this.root, rel);
    const relative = path.relative(this.root, target);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("path escapes memory root");
    const first = relative.split(path.sep)[0].toLowerCase();
    if (first === ".git") throw new Error(".git is not accessible");
    if (first.startsWith(".git") || first.startsWith(".memory-") || /\.tmp$/i.test(relative)) throw new Error("reserved path");
    // No symlink/junction anywhere along the existing prefix.
    let cur = this.root;
    for (const seg of relative.split(path.sep).filter(Boolean)) {
      cur = path.join(cur, seg);
      let st: fs.Stats; try { st = fs.lstatSync(cur); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; if (mustExist) throw new Error(`not found: ${rel}`); break; }
      if (st.isSymbolicLink()) throw new Error("symbolic links are not allowed in the memory root");
      if (st.isFile() && st.nlink > 1) throw new Error("hard links are not allowed in the memory root");
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
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out.push(jail.rel(p) + "/"); if (recursive) stack.push(p); }
      else if (e.isFile()) out.push(`${jail.rel(p)} (${fs.statSync(p).size} bytes)`);
    }
  }
  return out;
}

export function consolidationTools(jail: RootJail) {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const tools: { def: { name: string; description: string; parameters: any }; run: (a: any) => { content: { type: "text"; text: string }[] } }[] = [
    {
      def: { name: "list", description: "List files under a directory of the memory root (relative path, '.' for root).", parameters: Type.Object({ path: Type.Optional(Type.String()), recursive: Type.Optional(Type.Boolean()) }) },
      run: a => text(listDir(jail, a.path ?? ".", a.recursive ?? false).join("\n") || "(empty)"),
    },
    {
      def: { name: "read", description: "Read a UTF-8 text file inside the memory root. Optional 1-based line range.", parameters: Type.Object({ path: Type.String(), start: Type.Optional(Type.Integer({ minimum: 1 })), end: Type.Optional(Type.Integer({ minimum: 1 })) }) },
      run: a => {
        const p = jail.resolve(a.path);
        if (!fs.statSync(p).isFile()) throw new Error("not a file");
        const buf = readBounded(p);
        const lines = buf.toString("utf8").split("\n");
        const s = Math.max(1, a.start ?? 1), e = Math.min(lines.length, a.end ?? lines.length);
        const body = lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join("\n");
        const out = truncateBytes(body, MAX_READ_BYTES - 96);
        return text(out === body ? out : out + `\n[... truncated at ${MAX_READ_BYTES} bytes; use start/end line ranges ...]`);
      },
    },
    {
      def: { name: "grep", description: "Case-insensitive substring/regex search across files under the memory root. Returns path:line: text.", parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), regex: Type.Optional(Type.Boolean()) }) },
      run: a => {
        const q = String(a.pattern).toLowerCase();
        let scanned = 0;
        const hits: string[] = [];
        const start = jail.resolve(a.path ?? ".");
        const files = fs.statSync(start).isFile() ? [start] : listDir(jail, a.path ?? ".", true).filter(l => !l.endsWith("/")).map(l => jail.resolve(l.replace(/ \(\d+ bytes\)$/, "")));
        for (const f of files) {
          if (hits.length >= MAX_GREP_HITS) break;
          let bytes: Buffer; try { bytes = readBounded(f); } catch { continue; }
          scanned += bytes.length;
          if (scanned > 32 * 1024 * 1024) throw new Error('grep scan budget exceeded; narrow path');
          const lines = bytes.toString('utf8').split('\n');
          let indices: number[];
          if (a.regex) {
            // Isolate backtracking from the host and enforce a killable deadline.
            try { new RegExp(a.pattern, 'i'); } catch (e) { throw new Error(`invalid regex: ${(e as Error).message}`); }
            const child = spawnSync(process.execPath, ['-e', "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const {pattern,lines,max}=JSON.parse(s),r=new RegExp(pattern,'i'),out=[];for(let i=0;i<lines.length&&out.length<max;i++)if(r.test(lines[i]))out.push(i);process.stdout.write(JSON.stringify(out));});"], { input: JSON.stringify({ pattern: a.pattern, lines, max: MAX_GREP_HITS }), encoding: 'utf8', timeout: 1000, maxBuffer: 65536 });
            if (child.error || child.status !== 0) throw new Error('regex search failed or timed out');
            indices = JSON.parse(child.stdout);
          } else indices = lines.flatMap((line, i) => line.toLowerCase().includes(q) ? [i] : []).slice(0, MAX_GREP_HITS);
          for (const i of indices) if (hits.length < MAX_GREP_HITS) hits.push(`${jail.rel(f)}:${i + 1}: ${lines[i].slice(0, 300)}`);
        }
        return text(hits.join("\n") || "(no matches)");
      },
    },
    {
      def: { name: "write", description: "Create or overwrite a text file inside the memory root (parent directories are created).", parameters: Type.Object({ path: Type.String(), content: Type.String() }) },
      run: a => withFileLock(path.join(jail.root, '.memory-write.lock'), () => { const p = jail.resolve(a.path, { mustExist: false }); atomicWrite(p, a.content); return text(`wrote ${jail.rel(p)} (${Buffer.byteLength(a.content)} bytes)`); }),
    },
    {
      def: { name: "edit", description: "Replace an exact, unique text block in a file inside the memory root.", parameters: Type.Object({ path: Type.String(), old: Type.String(), new: Type.String() }) },
      run: a => withFileLock(path.join(jail.root, '.memory-write.lock'), () => {
        const p = jail.resolve(a.path); const s = readBounded(p).toString('utf8');
        const i = s.indexOf(a.old); if (i < 0) throw new Error("old text not found"); if (s.indexOf(a.old, i + 1) >= 0) throw new Error("old text is not unique");
        atomicWrite(p, s.slice(0, i) + a.new + s.slice(i + a.old.length)); return text(`edited ${jail.rel(p)}`);
      }),
    },
    {
      def: { name: "delete", description: "Delete a file (or empty directory) inside the memory root. Never deletes ad-hoc notes or the workspace diff.", parameters: Type.Object({ path: Type.String() }) },
      run: a => withFileLock(path.join(jail.root, '.memory-write.lock'), () => {
        const p = jail.resolve(a.path); const rel = jail.rel(p), protectedPath = rel.toLowerCase();
        if (!rel || protectedPath === 'extensions/ad_hoc/notes' || protectedPath.startsWith("extensions/ad_hoc/notes/") || protectedPath === "phase2_workspace_diff.md") throw new Error("this file must not be deleted");
        const st = fs.lstatSync(p); if (st.isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p); return text(`deleted ${rel}`);
      }),
    },
    {
      def: { name: "mkdir", description: "Create a directory inside the memory root.", parameters: Type.Object({ path: Type.String() }) },
      run: a => { const p = jail.resolve(a.path, { mustExist: false }); fs.mkdirSync(p, { recursive: true }); return text(`created ${jail.rel(p)}/`); },
    },

  ];
  return tools;
}
