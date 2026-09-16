import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MemoryStore } from '../src/store.ts';

test('two OS processes share stage1 capacity and a single phase2 owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-process-'));
  const file = path.join(dir, 'state.sqlite');
  const store = new MemoryStore(file);
  for (const id of ['a', 'b']) store.upsertThread({ id, rolloutPath: id, cwd: dir, updatedAtMs: Date.now() - 86400e3, memoryMode: 'enabled', gitBranch: null });
  store.close();
  const moduleUrl = new URL('../src/store.ts', import.meta.url).href;
  const code = `import { MemoryStore } from ${JSON.stringify(moduleUrl)};
    const store = new MemoryStore(${JSON.stringify(file)});
    const claims = store.claimStage1JobsForStartup({ currentThreadId: String(process.pid), scanLimit: 10, maxClaimed: 1, maxAgeDays: 30, minIdleHours: 6, leaseSeconds: 3600 });
    const p2 = store.tryClaimGlobalPhase2Job(String(process.pid), 3600);
    console.log(JSON.stringify({ count: claims.length, p2: p2.outcome })); store.close();`;
  function worker() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code]);
      let output = '', error = '';
      child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
      child.on('error', reject);
      child.on('close', status => { if (status) reject(new Error(error)); else { try { resolve(JSON.parse(output)); } catch (e) { reject(e); } } });
    });
  }
  try {
    const results = await Promise.all([worker(), worker()]);
    assert.equal(results.reduce((n, r) => n + r.count, 0), 1);
    assert.equal(results.filter(r => r.p2 === 'claimed').length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
