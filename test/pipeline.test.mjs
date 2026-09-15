// Pipeline tests: no model calls, temp dirs only. Run via `npm test` (node --experimental-strip-types).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { MemoryStore } from '../src/store.ts';
import { rolloutSummaryFileStem, syncRolloutSummaries, rebuildRawMemoriesFile, validateConsolidationArtifacts, ensureLayout } from '../src/storage.ts';
import { prepareMemoryWorkspace, memoryWorkspaceDiff, resetMemoryWorkspaceBaseline, gitAvailable, renderWorkspaceDiffFile } from '../src/workspace.ts';
import { parseMemoryCitation, extractCitationBlocks, threadIdsFromCitation } from '../src/read-path.ts';
import { RootJail, consolidationTools } from '../src/agent-tools.ts';
import { renderSession } from '../src/rollout.ts';
import * as phase2 from '../src/phase2.ts';
import * as phase1 from '../src/phase1.ts';
import { DEFAULTS } from '../src/config.ts';

// Cleanup order matters on Windows: the sqlite handle must close before the directory is removed.
const cleanups = new WeakMap();
const tmp = t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-'));
  const list = cleanups.get(t) ?? []; cleanups.set(t, list);
  if (!list.length) t.after(() => { for (const fn of list.splice(0).reverse()) { try { fn(); } catch {} } });
  list.push(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }));
  return d;
};
const openStore = (t, dir) => { const st = new MemoryStore(path.join(dir, 'm.sqlite')); cleanups.get(t).push(() => st.close()); return st; };
const sec = () => Math.floor(Date.now() / 1000);
const thread = (id, ageH = 24) => ({ id, rolloutPath: `C:/s/${id}.jsonl`, cwd: 'C:/proj', updatedAtMs: Date.now() - ageH * 3600e3, memoryMode: 'enabled', gitBranch: null });

test('stage1 claims respect idle window, age window, disabled threads, leases and up-to-date outputs', t => {
  const st = openStore(t, tmp(t));
  st.upsertThread(thread('a', 24)); st.upsertThread(thread('b', 1)); st.upsertThread(thread('c', 24 * 40)); st.upsertThread(thread('d', 24)); st.setThreadMemoryMode('d', 'disabled');
  st.upsertThread(thread('self', 24));
  const p = { currentThreadId: 'self', scanLimit: 100, maxClaimed: 10, maxAgeDays: 30, minIdleHours: 6, leaseSeconds: 3600 };
  const claims = st.claimStage1JobsForStartup(p);
  assert.deepEqual(claims.map(c => c.thread.id), ['a']);
  // second worker cannot claim a leased job
  assert.deepEqual(st.claimStage1JobsForStartup(p), []);
  // success stores output and marks up-to-date
  assert.ok(st.markStage1JobSucceeded('a', claims[0].ownershipToken, sec() - 86400, 'raw', 'sum', 'slug'));
  assert.deepEqual(st.claimStage1JobsForStartup(p), []);
  // newer session activity re-qualifies the thread
  st.upsertThread({ ...thread('a', 7), updatedAtMs: Date.now() - 7 * 3600e3 });
  assert.deepEqual(st.claimStage1JobsForStartup(p).map(c => c.thread.id), ['a']);
  // wrong token cannot finalize
  assert.equal(st.markStage1JobSucceeded('a', 'bogus', sec(), 'x', 'y', null), false);
});

test('no-output extraction deletes prior output and enqueues consolidation; failures back off', t => {
  const st = openStore(t, tmp(t));
  st.upsertThread(thread('a'));
  const p = { currentThreadId: 'self', scanLimit: 100, maxClaimed: 10, maxAgeDays: 30, minIdleHours: 6, leaseSeconds: 3600 };
  let [c] = st.claimStage1JobsForStartup(p);
  st.markStage1JobSucceeded('a', c.ownershipToken, sec() - 86400, 'raw', 'sum', null);
  assert.equal(st.stage1Count(), 1);
  st.upsertThread({ ...thread('a'), updatedAtMs: Date.now() - 7 * 3600e3 });
  [c] = st.claimStage1JobsForStartup(p);
  assert.ok(st.markStage1JobSucceededNoOutput('a', c.ownershipToken));
  assert.equal(st.stage1Count(), 0);
  assert.equal(st.phase2Status().status, 'pending');
  st.upsertThread({ ...thread('a'), updatedAtMs: Date.now() - 6.5 * 3600e3 });
  [c] = st.claimStage1JobsForStartup(p);
  assert.ok(st.markStage1JobFailed('a', c.ownershipToken, 'boom', 3600));
  assert.deepEqual(st.claimStage1JobsForStartup(p), [], 'retry_at blocks immediate re-claim');
});

test('phase2 global lock: running lease blocks, cooldown after success, failure allows retry after delay', t => {
  const st = openStore(t, tmp(t));
  const c1 = st.tryClaimGlobalPhase2Job('w1', 3600); assert.equal(c1.outcome, 'claimed');
  assert.equal(st.tryClaimGlobalPhase2Job('w2', 3600).outcome, 'skipped_running');
  assert.ok(st.heartbeatGlobalPhase2Job(c1.ownershipToken, 3600));
  assert.equal(st.heartbeatGlobalPhase2Job('bogus', 3600), false);
  assert.ok(st.markGlobalPhase2JobSucceeded(c1.ownershipToken, 10, []));
  assert.equal(st.tryClaimGlobalPhase2Job('w2', 3600).outcome, 'skipped_cooldown');
  assert.equal(st.tryClaimGlobalPhase2Job('w2', 3600, { ignoreCooldown: true }).outcome, 'claimed');
  const c3 = st.phase2Status(); assert.equal(c3.status, 'running');
  const tok = st.tryClaimGlobalPhase2Job('w3', 3600); assert.equal(tok.outcome, 'skipped_running');
});

test('phase2 selection ranks usage then recency, honors max_unused_days, stable thread order', t => {
  const st = openStore(t, tmp(t));
  for (const id of ['z', 'y', 'x']) st.upsertThread(thread(id));
  const p = { currentThreadId: 'self', scanLimit: 100, maxClaimed: 10, maxAgeDays: 30, minIdleHours: 6, leaseSeconds: 3600 };
  for (const c of st.claimStage1JobsForStartup(p)) st.markStage1JobSucceeded(c.thread.id, c.ownershipToken, sec() - 86400, `raw ${c.thread.id}`, `sum ${c.thread.id}`, null);
  st.recordStage1OutputUsage(['x']);
  const sel = st.getPhase2InputSelection(2, 30);
  assert.deepEqual(sel.map(s => s.threadId).sort(), sel.map(s => s.threadId), 'stable ascending order');
  assert.ok(sel.some(s => s.threadId === 'x'), 'used memory selected');
  // max_unused_days=0: cutoff is now. Never-used rows (source_updated_at = yesterday) drop out; the just-used row 'x' (last_usage = now) survives.
  assert.deepEqual(st.getPhase2InputSelection(10, 0).map(s => s.threadId), ['x']);
  // prune leaves selected rows alone
  const c = st.tryClaimGlobalPhase2Job('w', 3600); st.markGlobalPhase2JobSucceeded(c.ownershipToken, 1, sel);
  assert.equal(st.pruneStage1OutputsForRetention(0, 100), 1, 'only the unselected row is pruned');
});

test('rollout summary stem follows codex format and syncing prunes stale files', t => {
  const root = tmp(t);
  const stem = rolloutSummaryFileStem('01a09d51-f37d-7615-9b9d-7317f66f7b20', sec(), 'Hello World!');
  assert.match(stem, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-zA-Z]{4}-hello_world$/);
  assert.equal(stem.slice(0, 19), '2026-09-14T00-29-48', 'uuid v7 timestamp used');
  const m = { threadId: 'abc', sourceUpdatedAt: sec(), rawMemory: 'R', rolloutSummary: 'S', rolloutSlug: 's', generatedAt: sec(), usageCount: 0, lastUsage: null, cwd: 'C:/p', rolloutPath: 'C:/p/x.jsonl', gitBranch: 'main' };
  syncRolloutSummaries(root, [m]);
  fs.writeFileSync(path.join(root, 'rollout_summaries', 'stale.md'), 'old');
  syncRolloutSummaries(root, [m]);
  assert.deepEqual(fs.readdirSync(path.join(root, 'rollout_summaries')).length, 1);
  rebuildRawMemoriesFile(root, []);
  assert.match(fs.readFileSync(path.join(root, 'raw_memories.md'), 'utf8'), /No raw memories yet/);
});

test('git workspace baseline: diff reflects add/modify/delete and reset clears it', { skip: !gitAvailable() }, t => {
  const root = tmp(t);
  ensureLayout(root);
  fs.writeFileSync(path.join(root, 'MEMORY.md'), 'a\n');
  prepareMemoryWorkspace(root);
  assert.deepEqual(memoryWorkspaceDiff(root).changes, []);
  fs.writeFileSync(path.join(root, 'MEMORY.md'), 'b\n');
  fs.writeFileSync(path.join(root, 'rollout_summaries', 'n.md'), 'new\n');
  const d = memoryWorkspaceDiff(root);
  assert.deepEqual(d.changes.map(c => `${c.status} ${c.path}`).sort(), ['added rollout_summaries/n.md', 'modified MEMORY.md']);
  assert.match(renderWorkspaceDiffFile(d), /```diff[\s\S]*-a[\s\S]*\+b/);
  resetMemoryWorkspaceBaseline(root);
  assert.deepEqual(memoryWorkspaceDiff(root).changes, []);
  fs.rmSync(path.join(root, 'rollout_summaries', 'n.md'));
  assert.deepEqual(memoryWorkspaceDiff(root).changes, [{ status: 'deleted', path: 'rollout_summaries/n.md' }]);
  // git log has exactly one commit: history is not retained
  assert.equal(execSync('git rev-list --count HEAD', { cwd: root, encoding: 'utf8' }).trim(), '1');
});

test('citation parser matches codex format', () => {
  const txt = 'answer\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:234-236|note=[code pointer]\nrollout_summaries/x.md:10-12|note=[fmt]\nbad line\n</citation_entries>\n<rollout_ids>\n019c6e27-e55b-73d1-87d8-4e01f1f75043\n019c6e27-e55b-73d1-87d8-4e01f1f75043\nnot-a-uuid\n</rollout_ids>\n</oai-mem-citation>';
  const c = parseMemoryCitation(extractCitationBlocks(txt));
  assert.equal(c.entries.length, 2);
  assert.deepEqual(c.entries[0], { path: 'MEMORY.md', lineStart: 234, lineEnd: 236, note: 'code pointer' });
  assert.deepEqual(c.rolloutIds, ['019c6e27-e55b-73d1-87d8-4e01f1f75043', 'not-a-uuid']);
  assert.deepEqual(threadIdsFromCitation(c), ['019c6e27-e55b-73d1-87d8-4e01f1f75043']);
  assert.equal(parseMemoryCitation(['nothing']), undefined);
});

test('consolidation tool jail blocks escapes, .git, symlinks, and protected deletes', async t => {
  const root = tmp(t); ensureLayout(root); fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'MEMORY.md'), 'x');
  const outside = path.join(path.dirname(root), 'outside-' + path.basename(root)); fs.mkdirSync(outside); t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const tools = Object.fromEntries(consolidationTools(new RootJail(root)).map(x => [x.def.name, x.run]));
  await assert.rejects(tools.read({ path: '../secret.md' }));
  await assert.rejects(tools.read({ path: 'C:/Windows/win.ini' }));
  await assert.rejects(tools.read({ path: '.git/config' }));
  await assert.rejects(tools.write({ path: 'link/pwned.md', content: 'x' }));
  await assert.rejects(tools.delete({ path: 'extensions/ad_hoc/notes/n.md' }));
  assert.match((await tools.list({ path: '.' })).content[0].text, /MEMORY\.md/);
  assert.doesNotMatch((await tools.list({ path: '.', recursive: true })).content[0].text, /link/);
  await tools.write({ path: 'skills/demo/SKILL.md', content: '---\nname: demo\n---\n' });
  assert.ok(fs.existsSync(path.join(root, 'skills', 'demo', 'SKILL.md')));
});

test('renderSession follows the active branch and drops injected/developer content', t => {
  const f = path.join(tmp(t), 's.jsonl');
  const lines = [
    { type: 'session', version: 3, id: 'sid', timestamp: 't', cwd: 'C:/p' },
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: '# Memories (local recall layer)\ninjected' } },
    { type: 'message', id: 'u2', parentId: 'u1', message: { role: 'user', content: 'real question with token=abcdefgh12345678' } },
    { type: 'message', id: 'a1', parentId: 'u2', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thoughts' }, { type: 'text', text: 'answer' }, { type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'ls' } }] } },
    { type: 'message', id: 'dead', parentId: 'u1', message: { role: 'user', content: 'abandoned branch' } },
    { type: 'message', id: 'r1', parentId: 'a1', message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'out' }] } },
  ];
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const r = renderSession(f);
  assert.equal(r.id, 'sid'); assert.equal(r.cwd, 'C:/p');
  assert.doesNotMatch(r.text, /injected|abandoned|secret thoughts|abcdefgh12345678/);
  assert.match(r.text, /\[human user\]\nreal question with token=\[REDACTED\]/);
  assert.match(r.text, /\[tool_call bash\]/); assert.match(r.text, /\[tool bash\]\nout/);
});

// ---- end-to-end with a fake model (no network) ----
function fakeRegistry(script) {
  let i = 0;
  const model = { provider: 'fake', id: 'm', contextWindow: 100000 };
  return { registry: {
    find: () => model, hasConfiguredAuth: () => true,
    complete: async (_m, ctx) => { const step = script[Math.min(i++, script.length - 1)]; return typeof step === 'function' ? step(ctx) : step; },
  }, sessionModel: model };
}
const asst = (text, calls = []) => ({ role: 'assistant', content: [{ type: 'text', text }, ...calls.map((c, k) => ({ type: 'toolCall', id: `c${k}`, name: c.name, arguments: c.args }))], stopReason: 'stop', usage: { totalTokens: 10 } });

test('phase1 + phase2 end-to-end with fake model: extraction stored, agent writes artifacts, baseline reset', { skip: !gitAvailable() }, async t => {
  const dir = tmp(t); const root = path.join(dir, 'memories'); const st = openStore(t, dir);
  const sf = path.join(dir, 's.jsonl');
  fs.writeFileSync(sf, [{ type: 'session', version: 3, id: '01a09d51-f37d-7615-9b9d-7317f66f7b20', cwd: 'C:/p' }, { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'x'.repeat(50) } }].map(l => JSON.stringify(l)).join('\n'));
  st.upsertThread({ id: '01a09d51-f37d-7615-9b9d-7317f66f7b20', rolloutPath: sf, cwd: 'C:/p', updatedAtMs: Date.now() - 24 * 3600e3, memoryMode: 'enabled', gitBranch: null });
  const cfg = { ...DEFAULTS, extract_model: null, consolidation_model: null, consolidation_max_turns: 10 };
  const log = [];
  const llm = fakeRegistry([
    asst('```json\n{"raw_memory":"user prefers pnpm","rollout_summary":"set up repo","rollout_slug":"repo-setup"}\n```'),
    // phase 2 agent: read diff, write both artifacts, done
    asst('', [{ name: 'read', args: { path: 'phase2_workspace_diff.md' } }]),
    asst('', [{ name: 'write', args: { path: 'MEMORY.md', content: '# Task Group: repo\n\nscope: x\napplies_to: cwd=C:/p\n\n## Task 1: setup\n### rollout_summary_files\n- rollout_summaries/x.md\n### keywords\n- pnpm\n' } }, { name: 'write', args: { path: 'memory_summary.md', content: 'v1\n\n## User Profile\nprefers pnpm\n' } }]),
    asst('', [{ name: 'done', args: { summary: 'wrote memory' } }]),
  ]);
  const s1 = await phase1.run(st, cfg, llm, 'self', m => log.push(m));
  assert.equal(s1.withOutput, 1);
  const r = await phase2.run(st, cfg, llm, root, 'self', m => log.push(m));
  assert.equal(r, 'succeeded', log.join('\n'));
  assert.equal(fs.readFileSync(path.join(root, 'memory_summary.md'), 'utf8').split('\n')[0], 'v1');
  assert.ok(fs.existsSync(path.join(root, 'raw_memories.md')));
  assert.equal(fs.readdirSync(path.join(root, 'rollout_summaries')).length, 1);
  assert.ok(!fs.existsSync(path.join(root, 'phase2_workspace_diff.md')), 'diff artifact removed after baseline reset');
  assert.equal(memoryWorkspaceDiff(root).changes.length, 0, 'baseline reset');
  // second run with nothing new: no agent call, clean success
  const r2 = await phase2.run(st, cfg, llm, root, 'self', m => log.push(m), { force: false });
  assert.equal(r2, 'skipped_cooldown');
});

test('phase2 failure paths: agent that never finishes → failed, baseline preserved, lease released for retry later', { skip: !gitAvailable() }, async t => {
  const dir = tmp(t); const root = path.join(dir, 'memories'); const st = openStore(t, dir);
  st.upsertThread(thread('a')); const [c] = st.claimStage1JobsForStartup({ currentThreadId: 'self', scanLimit: 10, maxClaimed: 10, maxAgeDays: 30, minIdleHours: 6, leaseSeconds: 3600 });
  st.markStage1JobSucceeded('a', c.ownershipToken, sec() - 86400, 'raw', 'sum', null);
  const cfg = { ...DEFAULTS, consolidation_max_turns: 2 };
  const llm = fakeRegistry([asst('', [{ name: 'list', args: {} }])]); // loops forever listing
  const r = await phase2.run(st, cfg, llm, root, 'self', () => {});
  assert.match(r, /^failed_agent/);
  assert.equal(st.phase2Status().status, 'failed');
  assert.ok(fs.existsSync(path.join(root, 'raw_memories.md')), 'synced inputs remain');
  assert.equal(st.tryClaimGlobalPhase2Job('w', 3600).outcome, 'skipped_retry_unavailable');
  // invalid artifacts after "done" → failed_invalid_artifacts
  const llm2 = fakeRegistry([asst('', [{ name: 'done', args: { summary: 'lied' } }])]);
  const r2 = await phase2.run(st, { ...cfg }, llm2, root, 'self', () => {}, { force: true });
  assert.match(r2, /^failed_invalid_artifacts/);
});
