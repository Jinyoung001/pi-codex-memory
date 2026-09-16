import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
test('packed package loads from a Unicode/spaced path with isolated state and runtime dependencies', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm package 한글 '));
  const run = (exe, args, options = {}) => {
    const result = spawnSync(exe, args, { cwd: project, encoding: 'utf8', timeout: 180000, ...options });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  try {
    const npm = process.env.npm_execpath;
    assert.ok(npm, 'run this packaging check through npm test');
    const [packed] = JSON.parse(run(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', temp]));
    fs.writeFileSync(path.join(temp,'package.json'),JSON.stringify({name:'memory-install-smoke',private:true}));
    run(process.execPath,[npm,'install','--offline','--ignore-scripts','--legacy-peer-deps','--no-audit','--no-fund',path.join(temp,packed.filename)],{cwd:temp});
    const pkg = path.join(temp, 'node_modules','pi-codex-memory');
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
    assert.ok(manifest.dependencies.typebox);
    assert.equal(manifest.engines.node, '>=22.13');
    fs.mkdirSync(path.join(temp, 'node_modules', '@earendil-works'));
    // The host peer is supplied by pi, not installed as an extension dependency.
    fs.symlinkSync(path.join(project, 'node_modules', '@earendil-works', 'pi-coding-agent'), path.join(temp, 'node_modules', '@earendil-works', 'pi-coding-agent'), process.platform === 'win32' ? 'junction' : 'dir');
    const code = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      const base = pathToFileURL(process.env.PCM_PACKAGE_ROOT + '/');
      // Installed TS packages must use pi's Jiti loader (Node intentionally refuses
      // native type stripping in node_modules). Use the SDK loader's dependency.
      const { createRequire } = await import('node:module');
      const sdkRequire=createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
      const {createJiti}=sdkRequire('jiti');
      const jiti=createJiti(import.meta.url,{tryNative:false,nativeModules:['@earendil-works/pi-coding-agent','typebox']});
      const load=p=>jiti.import(new URL(p,base).href);
      const { default: extension } = await load('index.ts');
      const { DEFAULTS } = await load('src/config.ts');
      const { MemoryStore } = await load('src/store.ts');
      const { run } = await load('src/phase1.ts');
      const { buildConsolidationPrompt } = await load('src/phase2.ts');
      const home = process.env.PI_CODEX_MEMORY_HOME;
      const store = new MemoryStore(path.join(home, 'smoke.sqlite'));
      try {
        for (const version of ['v1', 'v2']) {
          assert.ok(buildConsolidationPrompt(home, version).length > 100);
          const result = await run(store, { ...DEFAULTS, version }, { registry: {}, sessionModel: { provider: 'fake', id: 'fake' } }, 'self', () => {});
          assert.equal(result.claimed, 0);
        }
      } finally { store.close(); }
      let tools = 0;
      extension({ on() {}, registerTool() { tools++; }, registerCommand() {} });
      assert.equal(tools, 0, 'upstream dedicated tools default off');
      const {runPiConsolidationSession}=await load('src/consolidation-session.ts');
      const model={id:'fake',provider:'fake',api:'openai-completions',contextWindow:128000,maxTokens:4096,input:['text'],reasoning:false};
      const llm={sessionModel:model,registry:{find:()=>model,hasConfiguredAuth:()=>true,complete:async()=>({role:'assistant',content:[],stopReason:'stop',usage:{totalTokens:1}})}};
      const completed=await runPiConsolidationSession(llm,model,DEFAULTS,home,'Consolidate only.','Begin.',new AbortController().signal,fn=>fn());
      assert.equal(completed.completed,true);
      console.log('isolated packaged V1/V2 smoke passed');
    `;
    assert.match(run(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code], { env: { ...process.env, PCM_PACKAGE_ROOT: pkg, PI_CODEX_MEMORY_HOME: path.join(temp, 'state'), PI_CODEX_MEMORY_SESSIONS: path.join(temp, 'sessions') } }), /smoke passed/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
