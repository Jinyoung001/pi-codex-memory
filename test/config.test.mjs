import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set before importing config: never read or write the user's real configuration.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-config-'));
process.env.PI_CODEX_MEMORY_HOME = home;
const { loadConfig, CONFIG_FILE } = await import('../src/config.ts');
const { resolveModel } = await import('../src/llm.ts');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('invalid configuration fails closed instead of re-enabling defaults', () => {
  for (const invalid of [null, [], 'text', { enabled: 'false' }, { generate_memories: null }, { max_rollouts_per_startup: '2' }]) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(invalid));
    assert.throws(() => loadConfig(), /must be/);
  }
  fs.writeFileSync(CONFIG_FILE, '{}');
  const defaults = loadConfig();
  assert.equal(defaults.dedicated_tools, false);
  assert.equal(defaults.max_rollouts_per_startup, 2);
  assert.equal(defaults.max_rollout_age_days, 10);
});

test('retired turn cap migration makes a fresh backup while preserving explicit models',async()=>{
  const {migrateLegacyConfig}=await import('../src/config.ts');
  const original={consolidation_max_turns:60,extract_model:'custom/extractor',consolidation_model:'custom/consolidator'};
  fs.writeFileSync(CONFIG_FILE,JSON.stringify(original));
  assert.deepEqual(migrateLegacyConfig(),['consolidation_max_turns']);
  const backups=fs.readdirSync(home).filter(name=>name.includes('.before-codex-only'));
  assert.ok(backups.some(name=>JSON.stringify(JSON.parse(fs.readFileSync(path.join(home,name),'utf8')))===JSON.stringify(original)));
  assert.equal(loadConfig().extract_model,'custom/extractor');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')),'consolidation_max_turns'),false);
});

test('configured extraction and consolidation models survive loading and resolve through registry', () => {
  const extraction = 'openrouter/deepseek/deepseek-v4.1-flash';
  const consolidation = 'fake/consolidator';
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ extract_model: extraction, consolidation_model: consolidation }));
  const cfg = loadConfig();
  assert.equal(cfg.extract_model, extraction);
  assert.equal(cfg.consolidation_model, consolidation);
  const calls = [];
  const llm = { sessionModel: { id: 'must-not-use' }, registry: {
    find(provider, id) { calls.push([provider, id]); return { provider, id }; },
    hasConfiguredAuth() { return true; },
  } };
  assert.equal(resolveModel(llm, cfg.extract_model).id, 'deepseek/deepseek-v4.1-flash');
  assert.equal(resolveModel(llm, cfg.consolidation_model).id, 'consolidator');
  assert.equal(calls.length, 2);
});

test('null model selects session; invalid model values fail instead of silently changing provider', () => {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ extract_model: null }));
  assert.equal(loadConfig().extract_model, null);
  for (const invalid of ['', '  ', 123, {}, true]) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ extract_model: invalid }));
    assert.throws(() => loadConfig(), /extract_model/);
  }
});

test('legacy efficient config is backed up, retired once, and keeps provider and enable flags',async()=>{
  const {migrateLegacyConfig}=await import('../src/config.ts');
  const original={profile:'efficient',recall_semantic:true,core_max_tokens:256,memory_daily_calls:4,enabled:false,extract_model:'custom/model'};
  fs.writeFileSync(CONFIG_FILE,JSON.stringify(original));
  assert.ok(migrateLegacyConfig().includes('profile'));
  assert.ok(fs.readdirSync(home).filter(name=>name.includes('.before-codex-only')).some(name=>JSON.stringify(JSON.parse(fs.readFileSync(path.join(home,name),'utf8')))===JSON.stringify(original)));
  assert.deepEqual(migrateLegacyConfig(),[]);
  assert.equal(loadConfig().enabled,false);assert.equal(loadConfig().extract_model,'custom/model');
  assert.equal(Object.hasOwn(loadConfig(),'profile'),false);
});
