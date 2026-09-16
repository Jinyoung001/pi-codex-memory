import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/store.ts';
import { DatabaseSync } from 'node:sqlite';
import { readSessionHeader, renderSession } from '../src/rollout.ts';

const params = { currentThreadId: 'self', scanLimit: 100, maxClaimed: 20, maxAgeDays: 30, minIdleHours: 6, leaseSeconds: 3600 };
test('source migration preserves existing thread memory modes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-migrate-'));
  const file = path.join(dir, 'state.sqlite');
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, memory_mode TEXT NOT NULL DEFAULT 'enabled', git_branch TEXT); INSERT INTO threads VALUES ('old', 'old.jsonl', '.', 0, 'disabled', NULL)");
  old.close();
  const store = new MemoryStore(file);
  try {
    const backup=new DatabaseSync(file+'.before-codex-schema.bak');
    try { assert.equal(backup.prepare("SELECT memory_mode FROM threads WHERE id='old'").get().memory_mode,'disabled'); }
    finally { backup.close(); }
    assert.equal(store.threadMemoryMode('old'), 'disabled');
    store.upsertThread({ id: 'old', rolloutPath: 'old.jsonl', cwd: dir, updatedAtMs: Date.now() - 86400e3, memoryMode: 'enabled', gitBranch: null });
    assert.equal(store.threadMemoryMode('old'), 'disabled');
    assert.equal(store.claimStage1JobsForStartup(params).length, 0);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('source catalog excludes noninteractive, archived and disabled threads and preserves known provenance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-source-'));
  const store = new MemoryStore(path.join(dir, 'state.sqlite'));
  try {
    for (const id of ['interactive', 'fork', 'exec', 'subagent', 'archived', 'disabled', 'deleted']) {
      const file = path.join(dir, id + '.jsonl');
      fs.writeFileSync(file, JSON.stringify({ type: 'session', id, cwd: dir, ...(id === 'fork' ? { parentSession: path.join(dir, 'interactive.jsonl') } : {}) }) + '\n');
      const row = { id, rolloutPath: file, cwd: dir, updatedAtMs: Date.now() - 86400e3, memoryMode: id === 'disabled' ? 'disabled' : 'enabled', gitBranch: null, source: ['exec', 'subagent'].includes(id) ? id : 'interactive', archived: id === 'archived' };
      store.upsertThread(row);
      if (id === 'subagent' || id === 'disabled') {
        const { source, ...rediscovered } = row;
        store.upsertThread({ ...rediscovered, memoryMode: 'enabled' });
      }
      if (id === 'deleted') fs.unlinkSync(file);
    }
    assert.ok(readSessionHeader(path.join(dir, 'fork.jsonl'), Date.now()).parentSession);
    store.archiveMissingThreadFiles();
    const claims = store.claimStage1JobsForStartup(params);
    assert.deepEqual(claims.map(c => c.thread.id).sort(), ['fork', 'interactive']);
    assert.equal(store.threadMemoryMode('disabled'), 'disabled');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mixed user content retains human evidence, media and V2 provenance without instructions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-evidence-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    const entries = [
      { type: 'session', id: 'evidence', cwd: dir },
      { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: [
        { type: 'text', text: '<skill>private injected instructions</skill>' },
        { type: 'text', text: 'real user preference' }, { type: 'image', data: 'not evidence' },
      ] } },
      { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', stopReason: 'toolUse', content: [
        { type: 'text', text: 'checking now' }, { type: 'toolCall', name: 'read', arguments: { path: 'file' } },
      ] } },
      { type: 'message', id: 'c', parentId: 'b', message: { role: 'user', content: '<subagent_notification>agent report</subagent_notification>' } },
      { type: 'message', id: 'd', parentId: 'c', message: { role: 'user', content: '<environment_context>workspace</environment_context>' } },
    ];
    fs.writeFileSync(file, entries.map(JSON.stringify).join('\n'));
    const result = renderSession(file);
    assert.match(result.text, /real user preference/);
    assert.doesNotMatch(result.text, /private injected instructions|not evidence/);
    assert.match(result.text, /\[image omitted\]/);
    assert.deepEqual(result.rows.map(row => row.split('\n')[0]), ['[human user]', '[assistant final]', '[tool call]', '[other agent]', '[harness context]']);
    assert.equal(result.evidence[1].phase,null);
    assert.equal(result.evidence[1].source,'unknown');
    assert.equal(result.evidence[1].id,'b');assert.equal(result.evidence[1].parentId,'a');assert.equal(result.evidence[1].branchHead,'d');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('malformed session branches fail rather than looping forever', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-cycle-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, [
      { type: 'session', id: 'cycle', cwd: dir },
      { type: 'message', id: 'a', parentId: 'b', message: { role: 'user', content: 'a' } },
      { type: 'message', id: 'b', parentId: 'a', message: { role: 'user', content: 'b' } },
    ].map(JSON.stringify).join('\n'));
    assert.throws(() => renderSession(file), /cyclic/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
