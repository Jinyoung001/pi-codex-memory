import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

/** Existing Markdown files only. Reject traversal, sibling prefixes, symlinks and junctions. */
export function memoryPath(root, name) {
  if (!name || path.isAbsolute(name) || name.includes(':') || !name.endsWith('.md')) throw new Error('Invalid memory path');
  const base = fs.realpathSync(root);
  const target = path.resolve(base, name);
  const relative = path.relative(base, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path outside memory root');
  let current = base;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlink in memory path');
  }
  if (!fs.statSync(target).isFile()) throw new Error('Memory path is not a file');
  return target;
}

/** Listing and searching share the same no-symlink boundary as reading. */
export function markdownFiles(root, dir = '') {
  const out = [];
  if (!fs.existsSync(root)) return out;
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
  return text
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-|pk-|rk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|AIza)[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, '[REDACTED JWT]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

/** Reject malformed extraction instead of coercing objects to '[object Object]'. */
export function extractionOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid extraction object');
  for (const key of ['raw_memory', 'rollout_summary', 'rollout_slug']) {
    if (typeof value[key] !== 'string') throw new Error(`Invalid extraction field: ${key}`);
  }
  if (Boolean(value.raw_memory.trim()) !== Boolean(value.rollout_summary.trim())) throw new Error('Incomplete extraction');
  return value;
}

