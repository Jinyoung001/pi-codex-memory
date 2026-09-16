import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-life-'));
process.env.PI_CODEX_MEMORY_HOME = home;
process.env.PI_CODEX_MEMORY_SESSIONS = path.join(home, 'sessions');
const { default: extension } = await import('../index.ts');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('thread exclusion and pollution survive switching memory versions; off applies immediately', async () => {
  const { saveConfig, memoryDbFor } = await import('../src/config.ts');
  const { MemoryStore } = await import('../src/store.ts');
  saveConfig({ enabled: true, use_memories: true, dedicated_tools: true, dual_write: true, disable_on_external_context: true });
  const file = path.join(home, 'controls.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'controls', cwd: home }) + '\n');
  const events = {}, tools = {}, commands = {};
  extension({ on(n, h) { events[n] = h; }, registerTool(t) { tools[t.name] = t; }, registerCommand(n, c) { commands[n] = c; }, getAllTools() { return [{ name: 'lookup', sourceInfo: { source: 'npm:pi-mcp-adapter', path: 'adapter/index.ts' } }]; } });
  const ctx = { hasUI: true, ui: { notify() {} }, sessionManager: { getSessionFile() { return file; }, getSessionId() { return 'controls'; } }, model: { provider: 'fake', id: 'unused' }, modelRegistry: {} };
  try {
    await events.session_start({}, ctx);
    await commands.memories.handler('thread off', ctx);
    for (const version of ['v1', 'v2']) {
      const store = new MemoryStore(memoryDbFor(version));
      try { assert.equal(store.threadMemoryMode('controls'), 'disabled', version); } finally { store.close(); }
    }
    for (const toolName of ['web_search', 'lookup']) {
      await commands.memories.handler('thread on', ctx);
      await events.tool_execution_end({ toolName });
      for (const version of ['v1', 'v2']) {
        const store = new MemoryStore(memoryDbFor(version));
        try { assert.equal(store.threadMemoryMode('controls'), 'polluted', `${version}/${toolName}`); } finally { store.close(); }
      }
    }
    await commands.memories.handler('off', ctx);
    await assert.rejects(tools.memories_list.execute('id', {}), /disabled/);
  } finally { await events.session_shutdown(); saveConfig({ enabled: true, use_memories: true, dual_write: false, disable_on_external_context: false }); }
});

test('shutdown cancels deferred startup and use off rejects existing tools', async () => {
  const { saveConfig } = await import('../src/config.ts');
  saveConfig({ profile: 'codex' });
  const events = {}, tools = {}, commands = {};
  extension({ on(name, handler) { events[name] = handler; }, registerTool(tool) { tools[tool.name] = tool; }, registerCommand(name, command) { commands[name] = command; } });
  const ctx = { hasUI: true, ui: { notify() {} }, sessionManager: { getSessionFile() { return path.join(home, 'session.jsonl'); }, getSessionId() { return 'test'; } }, model: { provider: 'fake', id: 'unused' }, modelRegistry: { complete() { throw new Error('unexpected model call'); } } };
  await events.session_start({}, ctx);
  await commands.memories.handler('use off', ctx);
  await assert.rejects(tools.memories_list.execute('id', {}), /disabled/);
  await events.before_agent_start({ systemPrompt: '' }, ctx);
  await events.session_shutdown();
  await new Promise(resolve => setTimeout(resolve, 1650));
  assert.equal(fs.existsSync(path.join(home, 'memories', 'rollout_summaries')), false);
});

test('dual-write command consolidates both isolated roots through registered lifecycle', async () => {
  const { saveConfig, memoryRootFor, memoryDbFor } = await import('../src/config.ts');
  const { MemoryStore } = await import('../src/store.ts');
  saveConfig({ enabled: true, use_memories: true, dual_write: true, generate_memories: false });
  const events = {}, commands = {};
  extension({ on(n, h) { events[n] = h; }, registerTool() {}, registerCommand(n, c) { commands[n] = c; } });
  let calls = 0, extractions = 0;
  const sessionDir = path.join(home, 'sessions', 'workspace');
  fs.mkdirSync(sessionDir, { recursive: true });
  const history = path.join(sessionDir, 'history.jsonl');
  fs.writeFileSync(history, [
    { type: 'session', id: 'history', cwd: home },
    { type: 'message', id: 'user', parentId: null, message: { role: 'user', content: 'remember this workflow' } },
  ].map(JSON.stringify).join('\n'));
  const old = new Date(Date.now() - 86400e3); fs.utimesSync(history, old, old);
  const summary = "v1\n## User Profile\n## User preferences\n## General Tips\n## What's in Memory\n";
  const ctx = { hasUI: true, ui: { notify() {} }, sessionManager: { getSessionFile() { return path.join(home, 'controls.jsonl'); }, getSessionId() { return 'controls'; } }, model: { provider: 'fake', id: 'unused' }, modelRegistry: {
    async complete(_model, context) {
      if (!context.tools) {
        extractions++;
        const output = { rollout_summary: 'historical workflow', rollout_slug: 'workflow', ...(extractions === 1 ? { raw_memory: 'user workflow' } : {}) };
        return { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(output) }], stopReason: 'stop' };
      }
      if(context.messages.some(m=>m.role==='toolResult'))return {role:'assistant',content:[],stopReason:'stop'};
      calls++;
      const content = [{ type: 'toolCall', id: 'summary', name: 'write', arguments: { path: 'memory_summary.md', content: summary } }];
      if (calls === 1) content.push({ type: 'toolCall', id: 'handbook', name: 'write', arguments: { path: 'MEMORY.md', content: '# Memory\n' } });
      return { role: 'assistant', content, stopReason: 'stop' };
    }
  } };
  try {
    await events.session_start({}, ctx);
    await commands.memories.handler('run', ctx);
    assert.equal(calls, 2);
    assert.equal(extractions, 2, 'generate=false must not suppress old eligible source threads');
    for (const version of ['v1', 'v2']) {
      assert.equal(fs.readFileSync(path.join(memoryRootFor(version), 'memory_summary.md'), 'utf8'), summary);
      const store = new MemoryStore(memoryDbFor(version));
      try { assert.equal(store.phase2Status().status, 'done'); assert.equal(store.stage1Count(), 1); } finally { store.close(); }
    }
    assert.equal(fs.existsSync(path.join(memoryRootFor('v2'), 'raw_memories.md')), false);
    assert.equal(fs.existsSync(path.join(memoryRootFor('v2'), 'MEMORY.md')), false);
  } finally { await events.session_shutdown(); }
});
