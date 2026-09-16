import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/store.ts';
import { run as consolidate } from '../src/phase2.ts';
import { DEFAULTS } from '../src/config.ts';

test('expired consolidation cannot write or clean up a replacement owner workspace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-stale-workspace-'));
  const root = path.join(dir, 'memory'), outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  const file = path.join(dir, 'state.sqlite');
  const store = new MemoryStore(file), peer = new MemoryStore(file), sql = new DatabaseSync(file);
  try {
    let replacement;
    const llm = { sessionModel: { provider: 'fake', id: 'fake' }, registry: { async complete() {
      sql.exec("UPDATE jobs SET lease_until=0");
      replacement = peer.tryClaimGlobalPhase2Job('peer', 3600);
      assert.equal(replacement.outcome, 'claimed');
      fs.writeFileSync(path.join(root, 'memory_summary.md'), 'replacement owner');
      fs.symlinkSync(outside, path.join(root, 'peer-link'), process.platform === 'win32' ? 'junction' : 'dir');
      return { role: 'assistant', stopReason: 'stop', content: [
        { type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'memory_summary.md', content: 'stale owner' } },
      ] };
    } } };
    assert.match(await consolidate(store, { ...DEFAULTS }, llm, root, 'old', () => {}), /^failed_/);
    assert.equal(fs.readFileSync(path.join(root, 'memory_summary.md'), 'utf8'), 'replacement owner');
    assert.equal(fs.lstatSync(path.join(root, 'peer-link')).isSymbolicLink(), true);
    assert.equal(peer.phase2Status().status, 'running');
  } finally { sql.close(); peer.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// Two independent connections simulate workers; force lease expiry without sleeps.
test('stale phase2 failure cannot overwrite another owner, completed job, or previous failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-owner-'));
  const file = path.join(dir, 'state.sqlite');
  const a = new MemoryStore(file), b = new MemoryStore(file), sql = new DatabaseSync(file);
  try {
    const first = a.tryClaimGlobalPhase2Job('a', 3600);
    sql.exec("UPDATE jobs SET lease_until=0");
    const second = b.tryClaimGlobalPhase2Job('b', 3600);
    assert.equal(second.outcome, 'claimed');
    assert.equal(a.markGlobalPhase2JobFailed(first.ownershipToken, 'late failure', 3600), false);
    // Even an expired foreign lease belongs to that worker until reclaimed.
    sql.exec("UPDATE jobs SET lease_until=0");
    assert.equal(a.markGlobalPhase2JobFailed(first.ownershipToken, 'late failure', 3600), false);
    assert.equal(b.markGlobalPhase2JobSucceeded(second.ownershipToken, 1, []), true);
    const completed = b.phase2Status();
    assert.equal(a.markGlobalPhase2JobFailed(first.ownershipToken, 'late failure', 3600), false);
    assert.deepEqual(b.phase2Status(), completed);
    const third = b.tryClaimGlobalPhase2Job('b', 3600, { ignoreCooldown: true });
    assert.equal(b.markGlobalPhase2JobFailed(third.ownershipToken, 'real failure', 3600), true);
    const failed = b.phase2Status();
    assert.equal(a.markGlobalPhase2JobFailed(first.ownershipToken, 'late failure', 0), false);
    assert.deepEqual(b.phase2Status(), failed);
    // Codex fallback only recovers an unowned running row.
    sql.exec("UPDATE jobs SET status='running', ownership_token=NULL");
    assert.equal(a.markGlobalPhase2JobFailed(first.ownershipToken, 'unowned', 0), true);
    assert.equal(b.phase2Status().last_error, 'unowned');
    sql.exec("UPDATE jobs SET status='running', ownership_token=NULL");
    a.markGlobalPhase2JobFailed(first.ownershipToken, 'provider error: Bearer abcdefghijklmnopqrstuvwxyz', 0);
    assert.equal(b.phase2Status().last_error, 'provider error: Bearer [REDACTED_SECRET]');
  } finally {
    sql.close(); b.close(); a.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
