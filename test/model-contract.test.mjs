import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { complete, resolveMemoryModel, outputMode } from '../src/llm.ts';

test('memory defaults to the session model; explicit settings and request failures never reselect',async()=>{
  const sessionModel={provider:'openai',id:'session'};
  let available=true,auth=true,calls=0;
  const llm={sessionModel,registry:{find:(provider,id)=>available?{provider,id}:undefined,hasConfiguredAuth:()=>auth,complete:async()=>{calls++;throw Error('request failed');}}};
  assert.equal(resolveMemoryModel(llm,'openai/custom').model.id,'custom');
  assert.equal(resolveMemoryModel(llm,'openai/custom').selection,'explicit');
  assert.equal(resolveMemoryModel(llm,null).model,sessionModel);
  assert.equal(resolveMemoryModel(llm,null).selection,'session-default');
  auth=false;assert.throws(()=>resolveMemoryModel(llm,'openai/custom'),/no auth/);
  available=false;assert.equal(resolveMemoryModel(llm,null).model,sessionModel);
  assert.throws(()=>resolveMemoryModel(llm,'openai/custom'),/unavailable/);
  await assert.rejects(complete(llm,sessionModel,{systemPrompt:'',messages:[]},'off'),/request failed/);
  assert.equal(calls,1);
  assert.equal(outputMode({provider:'unknown',api:'openai-responses'}),'compatible-local-validation');
  auth=true;llm.registry.getAll=()=>[{provider:'openai-codex',id:'gpt-5.6-luna'}];
  assert.equal(resolveMemoryModel(llm,null).model,sessionModel,'available Codex models do not override session choice');
  assert.throws(()=>resolveMemoryModel({...llm,sessionModel:undefined},null),/no session model/);
});

for(const api of ['openai-responses','openai-completions'])for(const version of ['v1','v2'])test(`${api} ${version}: strict schema survives real pi HTTP serialization`,async t=>{
  let body;
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    body=JSON.parse(raw);
    res.writeHead(200,{'content-type':'text/event-stream'});
    if(api==='openai-completions')res.end('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:0,model:'test',choices:[{index:0,delta:{content:'{}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    else res.end('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'test',status:'completed',output:[],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}})+'\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const {streamSimple}=await import(`../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/${api}.js`);
  const model={provider:'openai',api,id:'gpt-test',name:'test',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,contextWindow:128000,maxTokens:4096,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const llm={sessionModel:model,registry:{complete:(m,c,o)=>streamSimple(m,c,{...o,apiKey:'local-test-key'}).result()}};
  const result=await complete(llm,model,{systemPrompt:'Extract.',messages:[{role:'user',content:'test',timestamp:0}]},'off',undefined,'test-session',version);
  assert.notEqual(result.stopReason,'error',result.errorMessage);
  const format=api==='openai-responses'?body.text.format:body.response_format.json_schema;
  // Literal contracts from pinned phase1_output.rs::output_schema, independent of the implementation.
  const expected=version==='v1'
    ? {type:'object',properties:{rollout_summary:{type:'string'},rollout_slug:{type:['string','null']},raw_memory:{type:'string'}},required:['rollout_summary','rollout_slug','raw_memory'],additionalProperties:false}
    : {type:'object',properties:{rollout_summary:{type:'string'},rollout_slug:{type:'string'}},required:['rollout_summary','rollout_slug'],additionalProperties:false};
  assert.equal(format.strict,true);assert.deepEqual(format.schema,expected);
});
