import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/store.ts';
import { DEFAULTS } from '../src/config.ts';
import { runPiConsolidationSession, registryRuntime } from '../src/consolidation-session.ts';

test('fixed upstream audited sources retain recorded hashes',()=>{
  const reference=JSON.parse(fs.readFileSync(new URL('../vendor/codex/reference.json',import.meta.url),'utf8'));
  assert.equal(reference.commit,'5bf132cd527311eb61bbec46562e3890eb49df80');
  for(const [file,entry] of Object.entries(reference.auditedSources)){
    const bytes=fs.readFileSync(new URL('../vendor/codex/src/'+file,import.meta.url),'utf8').replace(/\r\n/g,'\n');
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),entry.sha256,file);
  }
});

test('retired experimental state is preserved and never instantiated by the Codex store',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pcm-retired-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'state.sqlite');const db=new DatabaseSync(file);
  db.exec("CREATE TABLE recall_documents(key TEXT PRIMARY KEY,text TEXT);INSERT INTO recall_documents VALUES('old','retained');");db.close();
  const store=new MemoryStore(file);store.close();const check=new DatabaseSync(file);
  try {assert.equal(check.prepare('SELECT text FROM recall_documents').get().text,'retained');assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='recall_fts'").get(),undefined);}finally{check.close();}
});

test('SDK consolidation loads only jailed tools and no ambient project instructions',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pcm-sdk-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'AGENTS.md'),'AMBIENT_CANARY_DO_NOT_LOAD');
  let calls=0;
  const model={id:'fake',provider:'fake',api:'openai-completions',contextWindow:128000,maxTokens:4096,input:['text'],reasoning:false,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const llm={sessionModel:model,registry:{find:()=>model,hasConfiguredAuth:()=>true,complete:async(_m,context)=>{
    calls++;assert.doesNotMatch(context.systemPrompt,/AMBIENT_CANARY/);assert.ok(context.tools.every(t=>['list','read','write','edit','delete','mkdir','done','grep'].includes(t.name)));assert.ok(!context.tools.some(t=>t.name==='bash'));
    return {role:'assistant',content:[{type:'text',text:'Finished.'}],stopReason:'stop',usage:{input:10,output:5,totalTokens:15}};
  }}};
  assert.equal((await runPiConsolidationSession(llm,model,DEFAULTS,root,'Only consolidate memory.','Begin.',new AbortController().signal,fn=>fn())).completed,true);
  assert.equal(calls,1);
});

test('registry stream exposes terminal results for SDK compaction and propagates cancellation',async()=>{
  const ac=new AbortController(),response={role:'assistant',content:[],stopReason:'stop'};
  const runtime=registryRuntime({registry:{},sessionModel:{}},{},async(_m,_c,options)=>{if(options.signal.aborted)throw Error('aborted');return response;});
  const stream=runtime.streamSimple({}, {}, {signal:ac.signal});assert.equal(await stream.result(),response);
  const events=[];for await(const e of stream)events.push(e.type);assert.deepEqual(events,['start','done']);
  ac.abort();await assert.rejects(runtime.streamSimple({}, {}, {signal:ac.signal}).result(),/aborted/);
});

test('legacy failed jobs migrate to upstream error without losing the pre-migration record',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pcm-job-migration-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'state.sqlite');const first=new MemoryStore(file);
  const claim=first.tryClaimGlobalPhase2Job('worker',60);first.markGlobalPhase2JobFailed(claim.ownershipToken,'test',60);first.close();
  const legacy=new DatabaseSync(file);legacy.exec("UPDATE jobs SET status='failed'");legacy.close();
  const migrated=new MemoryStore(file);try{assert.equal(migrated.phase2Status().status,'error');}finally{migrated.close();}
  const backup=new DatabaseSync(file+'.before-codex-schema.bak');try{assert.equal(backup.prepare('SELECT status FROM jobs').get().status,'failed');}finally{backup.close();}
});
