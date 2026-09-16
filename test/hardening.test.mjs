import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/store.ts';
import { truncateToTokens } from '../src/rollout.ts';
import { memoryTools, buildDeveloperInstructions } from '../src/read-path.ts';
import { RootJail } from '../src/agent-tools.ts';

test('summary injection and consolidation jail reject a junction memory root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-root-'));
  const root = path.join(dir, 'memory'), outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'memory_summary.md'), 'private outside content');
  fs.symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.equal(buildDeveloperInstructions(root), undefined);
    assert.throws(() => new RootJail(root), /symlink/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('upstream UTF-8 retained-byte budgets preserve boundaries with an additional marker', () => {
  for (const input of ['한글'.repeat(1000), '😀'.repeat(1000), 'ascii'.repeat(1000)]) {
    for (const budget of [0, 1, 10, 100, 500]) {
      const result = truncateToTokens(input, budget);
      assert.ok(Buffer.byteLength(result.replace(/…\d+ tokens truncated…/,'')) <= budget * 4);
      assert.ok(!result.includes('\ufffd'));
    }
  }
});

test('global stage1 cap and phase2 enqueue preserve success cooldown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-cap-'));
  const store = new MemoryStore(path.join(dir, 'state.sqlite'));
  const peer = new MemoryStore(path.join(dir, 'state.sqlite'));
  try {
    for (const id of ['a', 'b']) store.upsertThread({ id, rolloutPath: id, cwd: dir, updatedAtMs: Date.now() - 86400e3, memoryMode: 'enabled', gitBranch: null });
    const params = { currentThreadId: 'worker', scanLimit: 10, maxClaimed: 1, maxAgeDays: 30, minIdleHours: 6, leaseSeconds: 3600 };
    const [job] = store.claimStage1JobsForStartup(params);
    assert.equal(peer.claimStage1JobsForStartup(params).length, 0);
    const p2 = store.tryClaimGlobalPhase2Job('worker', 3600);
    store.markGlobalPhase2JobSucceeded(p2.ownershipToken, 0, []);
    store.markStage1JobSucceeded(job.thread.id, job.ownershipToken, Math.floor(job.thread.updatedAtMs / 1000), 'raw', 'summary', null);
    assert.equal(store.tryClaimGlobalPhase2Job('worker', 3600).outcome, 'skipped_cooldown');
  } finally { peer.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('note tool refuses junction ancestors without writing outside root', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-note-'));
  const root = path.join(dir, 'memory'), outside = path.join(dir, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'extensions'), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const tool = memoryTools(root).find(t => t.name === 'memories_add_ad_hoc_note');
    await assert.rejects(tool.execute('id', { filename: '2026-09-15T00-00-00-test.md', note: 'test' }), /symbolic/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
