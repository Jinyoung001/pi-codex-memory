import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPiConsolidationSession } from '../src/consolidation-session.ts';
import { DEFAULTS } from '../src/config.ts';
const model={id:'fake',provider:'fake',api:'openai-completions',contextWindow:128000,maxTokens:4096,input:['text'],reasoning:false,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const reply=(content,stopReason='stop')=>({role:'assistant',content,stopReason,usage:{input:10,output:5,totalTokens:15}});
function setup(t,request){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pcm-sdk-life-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,llm:{sessionModel:model,registry:{find:()=>model,hasConfiguredAuth:()=>true,complete:request}}};}
test('real SDK finishes after 65 tool turns without done or synthetic completion',{timeout:60000},async t=>{
  let calls=0,guards=0;
  const {root,llm}=setup(t,async(_m,context)=>{
    assert.ok(!context.tools.some(x=>x.name==='done'));
    calls++;
    return calls<=65?reply([{type:'toolCall',id:`write-${calls}`,name:'write',arguments:{path:'memory_summary.md',content:`turn ${calls}`}}],'toolUse'):reply([{type:'text',text:'Complete.'}]);
  });
  await runPiConsolidationSession(llm,model,DEFAULTS,root,'Consolidate.','Begin.',new AbortController().signal,fn=>{guards++;return fn();});
  assert.equal(calls,66);assert.equal(guards,131);assert.equal(fs.readFileSync(path.join(root,'memory_summary.md'),'utf8'),'turn 65');
});
test('real SDK propagates cancellation during provider request',{timeout:60000},async t=>{
  const ac=new AbortController();
  const {root,llm}=setup(t,async(_m,_c,o)=>{queueMicrotask(()=>ac.abort());await new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));});
  await assert.rejects(runPiConsolidationSession(llm,model,DEFAULTS,root,'Consolidate.','Begin.',ac.signal,fn=>fn()),/aborted/);
});
test('real SDK overflow compaction preserves instructions, file effects, tool pairs and guarded model route',{timeout:60000},async t=>{
  let requests=0,summaries=0,resumed=false,guards=0,authCalls=0;
  const {root,llm}=setup(t,async(m,context,options)=>{
    requests++;assert.equal(m.id,model.id);
    if(!context.tools?.length){summaries++;assert.equal(options.apiKey,'memory-test-key');return reply([{type:'text',text:'## Goal\nConsolidate memory.\n## Progress\nWrote memory_summary.md. Continue with final validation.'}]);}
    assert.match(context.systemPrompt,/INSTRUCTION_CANARY/);
    if(requests===1)return reply([{type:'toolCall',id:'first',name:'write',arguments:{path:'memory_summary.md',content:'preserved'.repeat(12000)}}],'toolUse');
    if(requests===2)return {...reply([],'error'),errorMessage:'maximum context length exceeded'};
    resumed=true;assert.ok(summaries>0);
    const ids=new Set(context.messages.flatMap(m=>(m.content??[]).filter?.(p=>p.type==='toolCall').map(p=>p.id)??[]));
    for(const message of context.messages)if(message.role==='toolResult')assert.ok(ids.has(message.toolCallId));
    assert.equal(fs.readFileSync(path.join(root,'memory_summary.md'),'utf8'),'preserved'.repeat(12000));
    return reply([{type:'text',text:'Complete.'}]);
  });
  llm.registry.getProviderAuth=async(provider)=>{authCalls++;assert.equal(provider,model.provider);return {apiKey:'memory-test-key'};};
  await runPiConsolidationSession(llm,model,DEFAULTS,root,'INSTRUCTION_CANARY: consolidate memory.','Begin. '+ 'original evidence '.repeat(10000),new AbortController().signal,fn=>{guards++;return fn();});
  assert.ok(resumed);assert.ok(summaries>0);assert.ok(authCalls>0);assert.equal(guards,requests+1);
});
test('real SDK compaction provider error fails instead of accepting an incomplete run',{timeout:60000},async t=>{
  let requests=0,summaries=0;
  const {root,llm}=setup(t,async(_m,context)=>{
    if(!context.tools?.length){summaries++;throw Error('compaction provider failure');}
    requests++;
    if(requests===1)return reply([{type:'toolCall',id:'large',name:'write',arguments:{path:'memory_summary.md',content:'evidence'.repeat(14000)}}],'toolUse');
    return {...reply([],'error'),errorMessage:'maximum context length exceeded'};
  });
  await assert.rejects(runPiConsolidationSession(llm,model,DEFAULTS,root,'Consolidate.','Begin.',new AbortController().signal,fn=>fn()),/compaction provider failure/);
  assert.equal(summaries,1);
});
