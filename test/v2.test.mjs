import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/store.ts';
import { DEFAULTS } from '../src/config.ts';
import { run as extract } from '../src/phase1.ts';
import { run as consolidate } from '../src/phase2.ts';
import { tieredEvidence, evidenceMessages, v2Output } from '../src/v2.ts';
import { buildDeveloperInstructions } from '../src/read-path.ts';
import { validateConsolidationArtifacts, memoryReadiness } from '../src/storage.ts';

const validSummary = 'v1\n## User Profile\n## User preferences\n## General Tips\n## What\'s in Memory\n';
test('local readiness requires 20 consolidated sources and a valid summary; progress survives pruning but not reset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-ready-'));
  const store = new MemoryStore(path.join(dir, 'state.sqlite'));
  try {
    assert.deepEqual(memoryReadiness(dir, 20), { v2_consolidated_threads: 20, v2_ready: false });
    fs.writeFileSync(path.join(dir, 'memory_summary.md'), validSummary);
    assert.equal(memoryReadiness(dir, 19).v2_ready, false);
    assert.equal(memoryReadiness(dir, 20).v2_ready, true);
    for (const minimum of [0, -1, 4097, NaN, 1.5]) assert.throws(() => memoryReadiness(dir, 20, minimum), /between 1 and 4096/);
    const claim = store.tryClaimGlobalPhase2Job('worker', 3600);
    assert.equal(store.markGlobalPhase2JobSucceeded(claim.ownershipToken, 0, Array.from({ length: 20 }, (_, i) => ({ threadId: `thread-${i}`, sourceUpdatedAt: 1 }))), true);
    assert.equal(store.maxConsolidatedThreadCount(), 20);
    const next = store.tryClaimGlobalPhase2Job('worker', 3600, { ignoreCooldown: true });
    store.markGlobalPhase2JobSucceeded(next.ownershipToken, 0, []);
    store.pruneStage1OutputsForRetention(0, 200);
    assert.equal(store.maxConsolidatedThreadCount(), 20);
    fs.writeFileSync(path.join(dir, 'memory_summary.md'), validSummary + 'x'.repeat(10000 - Buffer.byteLength(validSummary)));
    assert.equal(memoryReadiness(dir, 20).v2_ready, false);
    store.clearAll();
    assert.equal(store.maxConsolidatedThreadCount(), 0);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('V2 evidence budgets preserve human priority and UTF-8 chunks; output excludes raw memory', () => {
  const evidence = tieredEvidence(['[human user]\nimportant request', '[tool bash]\n' + 'x'.repeat(50000)], 100);
  assert.match(evidence, /important request/); assert.ok(Buffer.byteLength(evidence) <= 400);
  const input = '한글😀'.repeat(5000), chunks = evidenceMessages(input);
  assert.equal(chunks.map(m => m.content[0].text).join(''), input);
  assert.ok(chunks.every(m => Buffer.byteLength(m.content[0].text) <= 8900));
  assert.throws(() => v2Output({ raw_memory: 'not allowed', rollout_summary: '', rollout_slug: '' }));
  const sanitized = v2Output({ rollout_summary: 'sk-' + 'a'.repeat(20000), rollout_slug: 'example' });
  assert.ok(sanitized.rollout_summary.length < 100, 'redaction must precede truncation so credential tails cannot survive');
});

test('V2 extraction and consolidation work without MEMORY.md or raw_memories.md', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-v2-')), root = path.join(dir, 'memories_v2');
  const store = new MemoryStore(path.join(dir, 'v2.sqlite'));
  try {
    const session = path.join(dir, 's.jsonl');
    fs.writeFileSync(session, JSON.stringify({ type: 'session', id: 'v2-thread', cwd: dir }) + '\n' + JSON.stringify({ type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'remember my coding workflow' } }));
    store.upsertThread({ id: 'v2-thread', rolloutPath: session, cwd: dir, updatedAtMs: Date.now() - 86400e3, memoryMode: 'enabled', gitBranch: null });
    const model = { provider: 'fake', id: 'v2', contextWindow: 100000 };
    let calls = 0;
    const llm = { sessionModel: model, registry: { complete: async (_model, context) => {
      calls++;
      if(calls>2)return {role:'assistant',content:[],stopReason:'stop'};
      const content = calls === 1 ? [{ type: 'text', text: JSON.stringify({ rollout_summary: 'useful history', rollout_slug: 'workflow' }) }] : [{ type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'memory_summary.md', content: validSummary } }];
      assert.ok(!context.systemPrompt.includes('undefined'));
      return { role: 'assistant', content, stopReason: 'stop', usage: { totalTokens: 1 } };
    } } };
    const cfg = { ...DEFAULTS, version: 'v2' };
    assert.equal((await extract(store, cfg, llm, 'self', () => {})).withOutput, 1);
    assert.equal(await consolidate(store, cfg, llm, root, 'self', () => {}), 'succeeded');
    assert.equal(fs.existsSync(path.join(root, 'MEMORY.md')), false);
    assert.equal(fs.existsSync(path.join(root, 'raw_memories.md')), false);
    validateConsolidationArtifacts(root, 'v2');
    assert.match(buildDeveloperInstructions(root, 'v2'), /Do not cite `memory_summary.md`/);
    fs.writeFileSync(path.join(root, 'memory_summary.md'), 'v1\nmissing headings');
    assert.throws(() => validateConsolidationArtifacts(root, 'v2'));
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
