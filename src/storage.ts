// Filesystem artifacts. Mirrors codex memories/write/src/storage.rs + extensions/{ad_hoc,prune}.rs.
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWrite, assertTrustedPath, readBounded } from "../safety.js";
import { createHash } from "node:crypto";
import { RootJail } from "./agent-tools.ts";
import { EXTENSION_RESOURCES } from "./config.ts";
import type { Stage1Output } from "./store.ts";

export const rolloutSummariesDir = (root: string) => path.join(root, "rollout_summaries");
export const extensionsRoot = (root: string) => path.join(root, "extensions");
export const rawMemoriesFile = (root: string) => path.join(root, "raw_memories.md");
export const adHocNotesDir = (root: string) => path.join(extensionsRoot(root), "ad_hoc", "notes");

export function ensureLayout(root: string) {
  assertTrustedPath(root);
  fs.mkdirSync(root, { recursive: true });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`memory root cannot be a symbolic link: ${root}`);
  removeMemorySymlinks(root);
  fs.mkdirSync(rolloutSummariesDir(root), { recursive: true });
}

/** Codex removes every symlink under the memory root (workspace.rs remove_memory_symlinks). Returns count. */
export function removeMemorySymlinks(root: string): number {
  assertTrustedPath(root);
  let removed = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    if (path.basename(dir) === ".git") continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) { fs.rmSync(p, { force: true, recursive: false }); removed++; }
      else if (e.isDirectory()) stack.push(p);
    }
  }
  return removed;
}

// ---- ad-hoc extension (seeded instructions, note lifecycle) ----
export function seedExtensionInstructions(root: string, instructions: string) {
  const dir = new RootJail(root).resolve('extensions/ad_hoc', { mustExist: false });
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "instructions.md");
  try { fs.writeFileSync(f, instructions, { flag: "wx" }); } catch (e: any) { if (e.code !== "EEXIST") throw e; }
}

/** Codex prunes `extensions/<ext>/resources/*` older than RETENTION_DAYS by filename timestamp. Notes are never deleted. */
export function pruneOldExtensionResources(root: string, nowMs = Date.now()) {
  const jail = new RootJail(root);
  const cutoff = nowMs - EXTENSION_RESOURCES.RETENTION_DAYS * 86400e3;
  const ext = jail.resolve('extensions', { mustExist: false });
  if (!fs.existsSync(ext)) return;
  for (const e of fs.readdirSync(ext, { withFileTypes: true })) {
    if (!e.isDirectory() || !fs.existsSync(path.join(ext, e.name, "instructions.md"))) continue;
    const res = jail.resolve(`extensions/${e.name}/resources`, { mustExist: false });
    if (!fs.existsSync(res)) continue;
    for (const f of fs.readdirSync(res)) {
      if (!f.endsWith(".md") || !fs.lstatSync(path.join(res, f)).isFile()) continue;
      const m = f.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
      if (!m) continue;
      const ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      if (new Date(ts).toISOString().slice(0, 19).replace(/:/g, "-") !== f.slice(0, 19)) continue;
      if (ts <= cutoff) fs.rmSync(path.join(res, f), { force: true });
    }
  }
}

// ---- rollout summaries + raw_memories.md ----
const SHORT_HASH_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SHORT_HASH_SPACE = 14_776_336; // 62^4

function fmtTs(ms: number) { return new Date(ms).toISOString().slice(0, 19).replace(/:/g, "-"); }

/** Port of rollout_summary_file_stem_from_parts. UUIDv7 timestamp when parseable, else source_updated_at. */
export function rolloutSummaryFileStem(threadId: string, sourceUpdatedAtSec: number, slug: string | null): string {
  let tsMs = sourceUpdatedAtSec * 1000, seed = 0;
  const hex = threadId.replace(/-/g, "");
  if (/^[0-9a-f]{32}$/i.test(hex)) {
    if (hex[12] === "7") tsMs = parseInt(hex.slice(0, 12), 16);           // uuid v7 → unix ms
    seed = parseInt(hex.slice(24, 32), 16) >>> 0;                            // low 32 bits
  } else {
    for (const b of Buffer.from(threadId)) seed = (Math.imul(seed, 31) + b) >>> 0;
  }
  let v = seed % SHORT_HASH_SPACE;
  const chars = ["0", "0", "0", "0"];
  for (let i = 3; i >= 0; i--) { chars[i] = SHORT_HASH_ALPHABET[v % 62]; v = Math.floor(v / 62); }
  const prefix = `${fmtTs(tsMs)}-${chars.join("")}`;
  if (!slug) return prefix;
  let s = "";
  for (const ch of slug) { if (s.length >= 60) break; s += /[a-zA-Z0-9]/.test(ch) ? ch.toLowerCase() : "_"; }
  s = s.replace(/_+$/, "");
  return s ? `${prefix}-${s}` : prefix;
}

export const stemOf = (m: Stage1Output) => rolloutSummaryFileStem(m.threadId, m.sourceUpdatedAt, m.rolloutSlug);

function summaryNames(memories: Stage1Output[]) {
  const counts = new Map<string, number>();
  for (const m of memories) counts.set(stemOf(m), (counts.get(stemOf(m)) ?? 0) + 1);
  return new Map(memories.map(m => [m.threadId, stemOf(m) + ((counts.get(stemOf(m)) ?? 0) > 1 ? '-' + createHash('sha256').update(m.threadId).digest('hex') : '')]));
}

export function syncRolloutSummaries(root: string, memories: Stage1Output[]) {
  const names = summaryNames(memories);
  const replacements = memories.map(m => {
    const body = [
      `thread_id: ${m.threadId}`,
      `updated_at: ${new Date(m.sourceUpdatedAt * 1000).toISOString()}`,
      `rollout_path: ${m.rolloutPath}`,
      `cwd: ${m.cwd}`,
      ...(m.gitBranch ? [`git_branch: ${m.gitBranch}`] : []),
      "", m.rolloutSummary, "",
    ].join("\n");
    return { name: names.get(m.threadId)!, body };
  });
  ensureLayout(root);
  const dir = rolloutSummariesDir(root), keep = new Set(names.values());
  for (const { name, body } of replacements) {
    const p = path.join(dir, `${name}.md`);
    if (!fs.existsSync(p) || fs.readFileSync(p, "utf8") !== body) atomicWrite(p, body);
  }
  // Old summaries remain recoverable until all replacement writes succeed.
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.md') && !keep.has(f.slice(0, -3))) fs.rmSync(path.join(dir, f), { force: true });
}

export function rebuildRawMemoriesFile(root: string, memories: Stage1Output[]) {
  const names = summaryNames(memories);
  let body = "# Raw Memories\n\n";
  if (!memories.length) body += "No raw memories yet.\n";
  else {
    body += "Merged stage-1 raw memories (stable ascending thread-id order):\n\n";
    for (const m of memories) {
      body += `## Thread \`${m.threadId}\`\nupdated_at: ${new Date(m.sourceUpdatedAt * 1000).toISOString()}\ncwd: ${m.cwd}\nrollout_path: ${m.rolloutPath}\nrollout_summary_file: ${names.get(m.threadId)}.md\n\n${m.rawMemory.trim()}\n\n`;
    }
  }
  const p = rawMemoriesFile(root);
  if (!fs.existsSync(p) || fs.readFileSync(p, "utf8") !== body) atomicWrite(p, body);
}

// Pinned workspace.rs::is_valid_v2_summary, also used by local readiness status.
export function isValidV2Summary(content: string): boolean {
  const lines = content.split(/\r?\n/);
  return lines[0] === "v1" && Buffer.byteLength(content) < 10000
    && ["## User Profile", "## User preferences", "## General Tips", "## What's in Memory"].every(h => lines.some(line => line.trim() === h));
}

/** Local equivalent of app-server memory/status. No server or automatic version switch. */
export function memoryReadiness(root: string, consolidatedThreads: number, minimum = 20) {
  if (!Number.isSafeInteger(minimum) || minimum < 1 || minimum > 4096) throw new Error("minConsolidatedThreads must be between 1 and 4096");
  let valid = false;
  try { valid = isValidV2Summary(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(new RootJail(root).resolve("memory_summary.md")))); } catch { /* Missing or unsafe summary is not ready. */ }
  return { v2_consolidated_threads: consolidatedThreads, v2_ready: consolidatedThreads >= minimum && valid };
}

/** workspace.rs validate_consolidation_artifacts. */
export function validateConsolidationArtifacts(root: string, version: "v1" | "v2" = "v1") {
  const removed = removeMemorySymlinks(root);
  if (removed) throw new Error(`removed ${removed} symbolic links from consolidated memory workspace`);
  const mem = path.join(root, "MEMORY.md");
  if (version === "v1" && (!fs.existsSync(mem) || !fs.statSync(mem).isFile())) throw new Error(`consolidated memory artifact missing: ${mem}`);
  const sum = path.join(root, "memory_summary.md");
  if (!fs.existsSync(sum)) throw new Error(`memory summary artifact missing: ${sum}`);
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readBounded(new RootJail(root).resolve('memory_summary.md')));
  if (version === "v2" && !isValidV2Summary(content)) throw new Error("invalid V2 summary");
  const first = content.split(/\r?\n/, 1)[0];
  if (first !== "v1") throw new Error(`memory summary artifact does not start with v1: ${sum}`);
}
