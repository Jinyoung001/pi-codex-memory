// Git-baseline workspace diff. Mirrors codex-git-utils baseline.rs + memories/write/src/workspace.rs:
// the memory root is its own throwaway git repo; after each successful consolidation the repo is
// re-created with a single commit so history is never retained (deleted memories don't linger in objects).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { WORKSPACE_DIFF } from "./config.ts";
import { ensureLayout } from "./storage.ts";
import { assertTrustedPath, atomicWrite } from "../safety.js";

export type Change = { status: "added" | "modified" | "deleted" | "renamed" | "typechange" | "unknown"; path: string };
export type BaselineDiff = { changes: Change[]; unifiedDiff: string; diffTruncated?: boolean };

const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_ATTR_NOSYSTEM: '1' });
const IDENT = ["-c", "user.name=pi-codex-memory", "-c", "user.email=memory@localhost", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

function git(root: string, args: string[], opts: { allowFail?: boolean; gitDir?: string } = {}) {
  const r = spawnSync("git", ['--git-dir', opts.gitDir ?? path.join(root, '.git'), '--work-tree', root, ...IDENT, ...args], { cwd: root, encoding: "utf8", env: gitEnv(), timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r;
}

export function gitAvailable(): boolean {
  const r = spawnSync("git", ["--version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

function baselineUsable(root: string): boolean {
  if (!fs.existsSync(path.join(root, ".git"))) return false;
  validateRepository(root);
  return git(root, ["rev-parse", "--verify", "HEAD"], { allowFail: true }).status === 0;
}

const ownedMarker = 'pi-codex-memory-owned';
const paths = ['.', ':(exclude).git*', ':(exclude).memory-*', ':(exclude)*.tmp', `:(exclude)${WORKSPACE_DIFF.FILENAME}`];
function validateRepository(root: string, gitDir = path.join(root, '.git')) {
  assertTrustedPath(root);
  const stack = [gitDir];
  while (stack.length) {
    const current = stack.pop()!, stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('unsafe Git repository link');
    if (current === gitDir && !stat.isDirectory()) throw new Error('Git indirection is not allowed');
    if (stat.isDirectory()) for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
  }
  for (const f of ['commondir', 'objects/info/alternates']) if (fs.existsSync(path.join(gitDir, f))) throw new Error('external Git storage is not allowed');
  const config = git(root, ['config', '--no-includes', '--file', path.join(gitDir, 'config'), '--list'], { gitDir }).stdout;
  for (const line of config.trim().split('\n').filter(Boolean)) {
    if (!/^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|symlinks|precomposeunicode)=/i.test(line)) throw new Error('untrusted local Git configuration');
    if (/^core\.bare=/i.test(line) && line !== 'core.bare=false') throw new Error('bare Git workspace is not allowed');
  }
  const marker = path.join(gitDir, ownedMarker);
  if (fs.existsSync(marker)) {
    if (fs.readFileSync(marker, 'utf8') !== fs.realpathSync(root)) throw new Error(`foreign memory baseline (remove ${gitDir} to re-initialise)`);
  } else {
    // Adopt only the exact single-commit baseline produced by versions <= 0.2.1.
    const identity = git(root, ['log', '-1', '--format=%an%n%ae%n%s'], { gitDir, allowFail: true });
    const count = git(root, ['rev-list', '--count', 'HEAD'], { gitDir, allowFail: true });
    if (identity.status !== 0 || count.status !== 0 || identity.stdout.trim() !== 'pi-codex-memory\nmemory@localhost\nmemory baseline' || count.stdout.trim() !== '1') throw new Error(`repository is not an owned memory baseline (remove ${gitDir} to re-initialise)`);
    fs.writeFileSync(marker, fs.realpathSync(root), { flag: 'wx' });
  }
}

function initBaseline(root: string) {
  const current = path.join(root, '.git'), next = path.join(root, '.git-next'), previous = path.join(root, '.git-previous');
  if (fs.existsSync(current)) validateRepository(root);
  // .git-next is always a throwaway; .git-previous is only needed when .git itself is missing.
  if (fs.existsSync(next)) fs.rmSync(next, { recursive: true });
  if (fs.existsSync(previous)) { if (fs.existsSync(current)) fs.rmSync(previous, { recursive: true }); else throw new Error('unfinished baseline replacement; move .git-previous back to .git to recover'); }
  let moved = false;
  try {
    git(root, ['init', '-q', '--template='], { gitDir: next });
    // init under a non-.git dir records core.worktree; every command passes --work-tree, so drop it to keep config minimal.
    git(root, ['config', '--file', path.join(next, 'config'), '--unset', 'core.worktree'], { gitDir: next, allowFail: true });
    fs.writeFileSync(path.join(next, ownedMarker), fs.realpathSync(root));
    git(root, ['add', '-f', '-A', '--', ...paths], { gitDir: next });
    git(root, ['commit', '-q', '--allow-empty', '-m', 'memory baseline'], { gitDir: next });
    if (fs.existsSync(current)) { fs.renameSync(current, previous); moved = true; }
    try { fs.renameSync(next, current); }
    catch (e) { if (moved) fs.renameSync(previous, current); throw e; }
    if (moved) fs.rmSync(previous, { recursive: true });
  } finally { if (fs.existsSync(next)) fs.rmSync(next, { recursive: true }); }
}

/** prepare_memory_workspace: ensure layout, drop stale diff artifact, ensure usable baseline. */
export function prepareMemoryWorkspace(root: string) {
  ensureLayout(root);
  removeWorkspaceDiff(root);
  if (!baselineUsable(root)) initBaseline(root);
}

export function removeWorkspaceDiff(root: string) {
  fs.rmSync(path.join(root, WORKSPACE_DIFF.FILENAME), { force: true });
}

/** diff_since_latest_init: status + unified diff of worktree vs. the single baseline commit. */
export function memoryWorkspaceDiff(root: string): BaselineDiff {
  validateRepository(root);
  removeWorkspaceDiff(root);
  git(root, ["add", "-f", "-A", "-N", "--", ...paths]);
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths]).stdout;
  const changes: Change[] = [];
  const records = status.split('\0');
  for (let i = 0; i < records.length; i++) {
    const line = records[i]; if (!line) continue;
    const code = line.slice(0, 2), file = line.slice(3);
    let s: Change['status'] = 'unknown';
    if (/R|C/.test(code)) { s = 'renamed'; i++; }
    else if (/A|\?/.test(code)) s = 'added';
    else if (/D/.test(code)) s = 'deleted';
    else if (/T/.test(code)) s = 'typechange';
    else if (/M/.test(code)) s = 'modified';
    changes.push({ status: s, path: file });
  }
  if (!changes.length) return { changes, unifiedDiff: '' };
  // A child drains Git stdout while retaining only the bounded prefix. No giant parent buffer.
  const script = `const {spawn}=require('node:child_process');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const {args,limit}=JSON.parse(input);const p=spawn('git',args);let chunks=[],size=0,truncated=false,error='';p.stdout.on('data',b=>{const n=Math.min(b.length,limit-size);if(n)chunks.push(b.subarray(0,n));size+=n;if(n<b.length)truncated=true;});p.stderr.on('data',b=>{error=(error+b).slice(0,4096);});process.on('SIGTERM',()=>{p.kill();process.exit(1);});p.on('error',e=>{process.stderr.write(e.message);process.exitCode=1;});p.on('close',code=>{if(code!==0){process.stderr.write(error);process.exitCode=1;}else process.stdout.write(JSON.stringify({text:Buffer.concat(chunks).toString('utf8'),truncated}));});});`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: root, env: gitEnv(), input: JSON.stringify({ args: ['--git-dir', path.join(root, '.git'), '--work-tree', root, ...IDENT, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...paths], limit: WORKSPACE_DIFF.MAX_BYTES }), encoding: 'utf8', timeout: 120000, maxBuffer: WORKSPACE_DIFF.MAX_BYTES * 6 + 65536 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`git diff helper failed (status ${result.status ?? result.signal}): ${(result.stderr ?? '').trim()}`);
  const captured: { text: string; truncated: boolean } = JSON.parse(result.stdout);
  return { changes, unifiedDiff: captured.truncated ? captured.text.replace(/\uFFFD+$/, '') : captured.text, diffTruncated: captured.truncated };
}

export function renderWorkspaceDiffFile(diff: BaselineDiff): string {
  let out = "# Memory Workspace Diff\n\nGenerated by pi-codex-memory before Phase 2 memory consolidation. Read this file first and do not edit it.\n\n## Status\n";
  if (!diff.changes.length) return out + "- none\n";
  for (const c of diff.changes) out += `- ${c.status} ${c.path}\n`;
  out += "\n## Diff\n\n```diff\n";
  if (!diff.diffTruncated && Buffer.byteLength(diff.unifiedDiff) <= WORKSPACE_DIFF.MAX_BYTES) {
    out += diff.unifiedDiff.endsWith("\n") || !diff.unifiedDiff ? diff.unifiedDiff : diff.unifiedDiff + "\n";
  } else {
    out += Buffer.from(diff.unifiedDiff).subarray(0, WORKSPACE_DIFF.MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, "") + `\n\n[workspace diff truncated at ${WORKSPACE_DIFF.MAX_BYTES} bytes]\n`;
  }
  return out + "```\n";
}

export function writeWorkspaceDiff(root: string, diff: BaselineDiff) {
  atomicWrite(path.join(root, WORKSPACE_DIFF.FILENAME), renderWorkspaceDiffFile(diff));
}

/** reset_git_repository: remove the diff artifact, then re-create the repo with one commit. */
export function resetMemoryWorkspaceBaseline(root: string) {
  removeWorkspaceDiff(root);
  initBaseline(root);
}
