import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, readJson, memoryPath, markdownFiles, redact, extractionOutput, assertTrustedPath, withFileLock, readBounded } from '../safety.js';

test('vendored prompts match the pinned Codex commit (LF normalized)', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../vendor/codex/reference.json', import.meta.url), 'utf8'));
  for (const [file, expected] of Object.entries(manifest.promptsSha256)) {
    const text = fs.readFileSync(new URL('../prompts/' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(text).digest('hex'), expected, file);
  }
  for (const [file, reference] of Object.entries(manifest.auditedSources)) {
    const text = fs.readFileSync(new URL('../vendor/codex/src/' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(text).digest('hex'), reference.sha256, file);
  }
});

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-codex-memory-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}
test('corrupt JSON is not silently replaced with empty state', t => {
  const file = path.join(fixture(t), 'state.json');
  assert.deepEqual(readJson(file, {}), {});
  atomicWrite(file, '{broken');
  assert.throws(() => readJson(file, {}), SyntaxError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('atomic writes replace complete files without leaving temp artifacts', t => {
  const dir = fixture(t), file = path.join(dir, 'state.json');
  atomicWrite(file, '{"version":1}');
  atomicWrite(file, '{"version":2}');
  assert.deepEqual(readJson(file, {}), { version: 2 });
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});
test('read boundary rejects traversal, sibling prefixes and non-memory state', t => {
  const base = fixture(t), root = path.join(base, 'memories');
  atomicWrite(path.join(root, 'MEMORY.md'), 'ok');
  atomicWrite(path.join(root, 'state.json'), '{}');
  atomicWrite(path.join(base, 'memories-other', 'secret.md'), 'secret');
  assert.equal(memoryPath(root, 'MEMORY.md'), fs.realpathSync(path.join(root, 'MEMORY.md')));
  for (const p of ['../memories-other/secret.md', '..\\memories-other\\secret.md']) assert.throws(() => memoryPath(root, p), /Path outside memory root/);
  for (const p of ['state.json', 'C:/secrets.md']) assert.throws(() => memoryPath(root, p), /Invalid memory path/);
  assert.throws(() => markdownFiles(root, '../memories-other'), /Invalid memory directory/);
  assert.throws(() => markdownFiles(root, '.hidden'), /Invalid memory directory/);
});
test('trusted-path, lock and bounded-read boundaries', t => {
  const base = fixture(t), root = path.join(base, 'memories'), outside = path.join(base, 'outside');
  atomicWrite(path.join(root, 'a.md'), 'aaaa');
  atomicWrite(path.join(outside, 'x.md'), 'x');
  fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertTrustedPath(path.join(root, 'link')), /symlink/i);
  assertTrustedPath(path.join(root, 'a.md'));
  assertTrustedPath(path.join(root, 'link', 'x.md')); // symlinked ancestors (macOS /var, symlinked $HOME) are tolerated; per-component checks live in the jail
  assert.throws(() => readBounded(path.join(root, 'a.md'), 3), /input limit/);
  assert.equal(readBounded(path.join(root, 'a.md')).toString(), 'aaaa');
  fs.linkSync(path.join(root, 'a.md'), path.join(root, 'b.md'));
  assert.throws(() => readBounded(path.join(root, 'b.md')), /single-link/);
  const lock = path.join(root, '.lock');
  assert.throws(() => withFileLock(lock, () => { assert.throws(() => withFileLock(lock, () => {}), /Lock file exists/); throw new Error('inner'); }), /inner/);
  assert.equal(fs.existsSync(lock), false);
});
test('junctions are neither listed nor readable', t => {
  const base = fixture(t), root = path.join(base, 'memories'), outside = path.join(base, 'outside');
  atomicWrite(path.join(root, 'MEMORY.md'), 'ok');
  atomicWrite(path.join(outside, 'secret.md'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(markdownFiles(root), ['MEMORY.md']);
  assert.throws(() => markdownFiles(root, 'escape'), /symlink/i);
  assert.throws(() => markdownFiles(root, 'escape/nested'), /symlink/i);
  assert.throws(() => memoryPath(root, 'escape/secret.md'));
});
test('redaction removes credential values without callback-offset leakage', () => {
  for (const secret of ['sk-abcdefghijklmnopqrst_PRIVATE_SUFFIX', 'sk-abcdefghijklmnopqrst-private-suffix_', 'sk-abcdefghijklmnopqrstuvwxyz123', 'ghp_abcdefghijklmnopqrstuvwxyz123', 'github_pat_abcdefghijklmnopqrstuvwxyz123']) {
    const result = redact(`prefix ${secret} suffix`);
    assert.equal(result, 'prefix [REDACTED_SECRET] suffix');
  }
  for (const plain of ['task-run-2026-09-16-abcdef', 'flask-sqlalchemy-migrate-plugin']) assert.equal(redact(plain), plain);
  assert.equal(redact('postgres://user:password@host/db'), 'postgres://[REDACTED]@host/db');
  assert.equal(redact('mongodb+srv://user:password@host/db'), 'mongodb+srv://[REDACTED]@host/db');
  assert.equal(redact('Authorization: Bearer abc123'), 'Authorization: Bearer [REDACTED_SECRET]');
  assert.equal(redact('-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'), '[REDACTED PRIVATE KEY]');
});
test('pinned sanitizer bearer cases redact complete values and avoid prose false positives', () => {
  for (const input of ['Bearer abcde+fghijklmnopqrstuvwxyz012345', 'Bearer abcdefghijklmnop+secret_suffix', 'Bearer sk-abcdefghijklmnopqrst+secret_suffix', 'Bearer AKIAABCDEFGHIJKLMNOP/~secret_suffix', 'Bearer   abcdefghijklmnop']) {
    assert.equal(redact(input), 'Bearer [REDACTED_SECRET]');
  }
  assert.equal(redact('Bearer AbcdefghijklMN09._~+/-==; echo done'), 'Bearer [REDACTED_SECRET]; echo done');
  assert.equal(redact('authorization: bEaReR\tabcdefghijklmnop'), 'authorization: Bearer [REDACTED_SECRET]');
  for (const input of ['Bearer of good news', 'Bearer abcdefghijklmno', 'NotABearer abcdefghijklmnop', 'Bearerabcdefghijklmnop', 'Bearer\nabcdefghijklmnop', 'Bearer\u00a0abcdefghijklmnop', 'Bearer abcdefghijklmno\u212a']) assert.equal(redact(input), input);
});

test('extraction accepts V1 nullable slug and empty output, rejects malformed objects', () => {
  assert.deepEqual(extractionOutput({ raw_memory: '', rollout_summary: '', rollout_slug: '' }), { raw_memory: '', rollout_summary: '', rollout_slug: '' });
  assert.throws(() => extractionOutput({ raw_memory: {}, rollout_summary: '', rollout_slug: '' }));
  assert.equal(extractionOutput({ raw_memory: 'fact', rollout_summary: '', rollout_slug: null }).rollout_slug, null);
  assert.throws(() => extractionOutput({ raw_memory: '', rollout_summary: '', extra: true }));
});
