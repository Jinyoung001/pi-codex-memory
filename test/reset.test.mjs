import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/store.ts';
import { memoryTools } from '../src/read-path.ts';

test('reset refuses running jobs and serializes filesystem deletion with note writes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-reset-'));
  const root = path.join(dir, 'memories'), file = path.join(dir, 'state.sqlite');
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'MEMORY.md'), 'keep');
  const a = new MemoryStore(file), peer = new DatabaseSync(file);
  try {
    const claim = a.tryClaimGlobalPhase2Job('owner', 0);
    assert.throws(() => a.clearAll(() => fs.rmSync(root, { recursive: true })), /still running/);
    assert.equal(fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8'), 'keep');
    a.markGlobalPhase2JobFailed(claim.ownershipToken, 'stopped', 0);
    a.clearAll(() => {
      // Another connection cannot start a writer in the check/delete gap.
      assert.throws(() => peer.exec('BEGIN IMMEDIATE'), /locked/);
      fs.rmSync(root, { recursive: true });
    });
    assert.equal(a.phase2Status(), undefined);
    assert.equal(fs.existsSync(root), false);
    const note = memoryTools(root, fn => a.withMutation(fn)).find(t => t.name === 'memories_add_ad_hoc_note');
    await note.execute('id', { filename: '2026-09-15T00-00-00-note.md', note: 'verbatim token=not-a-secret' });
    assert.equal(fs.readFileSync(path.join(root, 'extensions/ad_hoc/notes/2026-09-15T00-00-00-note.md'), 'utf8'), 'verbatim token=not-a-secret');
  } finally { peer.close(); a.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
