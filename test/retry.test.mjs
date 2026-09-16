import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/store.ts';

test('new evidence resets exhausted retries and bypasses backoff, but never an active lease', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-retry-'));
  const store = new MemoryStore(path.join(dir, 'state.sqlite'));
  try {
    const base = Date.now() - 24 * 3600e3;
    const update = delta => store.upsertThread({ id: 'session', rolloutPath: 'unused.jsonl', cwd: dir, updatedAtMs: base + delta, memoryMode: 'enabled', gitBranch: null });
    const claim = () => store.claimStage1JobsForStartup({ currentThreadId: 'worker', scanLimit: 10, maxClaimed: 1, maxAgeDays: 30, minIdleHours: 6, leaseSeconds: 3600 });
    update(0);
    for (let i = 0; i < 3; i++) {
      const [job] = claim(); assert.ok(job);
      assert.equal(store.markStage1JobFailed('session', job.ownershipToken, 'failed', 0), true);
    }
    assert.equal(claim().length, 0, 'same evidence stays exhausted');
    update(1000);
    const [fresh] = claim(); assert.ok(fresh, 'new evidence resets exhaustion');
    update(2000);
    assert.equal(claim().length, 0, 'new evidence cannot steal an active lease');
    store.markStage1JobFailed('session', fresh.ownershipToken, 'failed', 3600);
    const [advanced] = claim(); assert.ok(advanced, 'new evidence bypasses backoff');
    store.markStage1JobFailed('session', advanced.ownershipToken, 'failed', 3600);
    assert.equal(claim().length, 0, 'unchanged evidence respects backoff');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
