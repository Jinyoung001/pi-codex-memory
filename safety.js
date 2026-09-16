import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Pathname checks require trusted ancestors; they are not an OS sandbox. */
export function assertTrustedPath(target) {
  // Resolved chain: symlinked tmp/home ancestors (macOS /var -> /private/var) are not a memory-root escape.
  let current = path.resolve(target);
  try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink in memory path'); current = fs.realpathSync(current); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  while (true) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink in memory path'); }
    catch (e) { if (e.code !== 'ENOENT' && e.code !== 'EACCES' && e.code !== 'EPERM') throw e; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Fail closed on contention. Never steal a lock from a potentially live writer.
 * @template T
 * @param {string} file
 * @param {() => T} fn
 * @returns {T}
 */
export function withFileLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error(`Lock file exists: ${file}. Another process may be writing; if none is running, remove the lock file and retry.`, { cause: e });
    throw e;
  }
  try { return fn(); }
  finally {
    try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.unlinkSync(file); } catch { /* best effort; stale lock reported on next acquire */ }
  }
}

/** Bound allocation and reject hard links using the actual opened descriptor. */
export function readBounded(file, maxBytes = 8 * 1024 * 1024) {
  const pre = fs.lstatSync(file);
  if (!pre.isFile()) throw new Error('not a single-link regular file'); // also rejects symlinks where O_NOFOLLOW is unavailable (Windows) and FIFOs that would block open
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) throw new Error('not a single-link regular file');
    if (st.size > maxBytes) throw new Error(`file exceeds ${maxBytes} byte input limit`);
    const bytes = Buffer.alloc(Math.min(st.size + 1, maxBytes + 1));
    let used = 0, n;
    while (used < bytes.length && (n = fs.readSync(fd, bytes, used, bytes.length - used, null))) used += n;
    if (used > maxBytes || used !== st.size) throw new Error('file changed or exceeded input limit');
    return bytes.subarray(0, used);
  } finally { fs.closeSync(fd); }
}

/** Read JSON; a damaged store is an error, never an empty new store. */
export function readJson(file, initial) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return initial; throw error; }
}

/** Same-directory replacement keeps partial writes out of the published file. */
export function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

/** Existing Markdown files only. Requires a trusted root and ancestors: path checks
 * cannot prevent another process replacing a checked component before an open. */
export function memoryPath(root, name) {
  assertTrustedPath(root);
  if (!name || path.isAbsolute(name) || name.includes(':') || !name.endsWith('.md')) throw new Error('Invalid memory path');
  const base = fs.realpathSync(root);
  const target = path.resolve(base, name);
  const relative = path.relative(base, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path outside memory root');
  let current = base;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink in memory path');
  }
  if (!fs.statSync(target).isFile()) throw new Error('Memory path is not a file');
  return target;
}

/** Listing and searching share the same no-symlink boundary as reading. */
export function markdownFiles(root, dir = '') {
  assertTrustedPath(root);
  const out = [];
  if (path.isAbsolute(dir) || dir.includes(':') || dir.split(/[\\/]/).some(s => s === '..' || (s.startsWith('.') && s !== '.'))) throw new Error('Invalid memory directory');
  if (!fs.existsSync(root)) return out;
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('symlink in memory path');
  let current = root;
  for (const segment of dir.split(/[\\/]/).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink in memory path');
  }
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(root, name));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(name.split(path.sep).join('/'));
  }
  return out.sort();
}

/** Best effort only: never claim arbitrary secrets can be identified reliably. */
export function redact(text) {
  // Pinned codex-secrets sanitizer order and replacement text.
  return text
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [REDACTED_SECRET]')
    // Diverges from upstream: `_`/`-` for sk-proj keys; anchored so kebab identifiers (task-, flask-) survive.
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_SECRET]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_SECRET]')
    .replace(/\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)(["']?)[^\s"']{8,}/gi, '$1$2$3[REDACTED_SECRET]')
    // Keep the port's additional recognizable credential protections.
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-|pk-|rk-|gh[pousr]_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, '[REDACTED JWT]')
    .replace(/(\bauthorization\s*[:=]\s*)Bearer[ \t]+[^\s"',;]+/gi, '$1Bearer [REDACTED_SECRET]')
    .replace(/((?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED_SECRET]')
    .replace(/\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

/** Reject malformed extraction instead of coercing objects to '[object Object]'. */
export function extractionOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid extraction object');
  if (Object.keys(value).some(key => !['raw_memory', 'rollout_summary', 'rollout_slug'].includes(key))) throw new Error('Unknown extraction field');
  for (const key of ['raw_memory', 'rollout_summary']) {
    if (typeof value[key] !== 'string') throw new Error(`Invalid extraction field: ${key}`);
  }
  if (value.rollout_slug !== undefined && value.rollout_slug !== null && typeof value.rollout_slug !== 'string') throw new Error('Invalid extraction field: rollout_slug');
  return value;
}
