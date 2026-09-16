import type { Llm, MemoryModel, CompletionContext, CompletionOptions, Completion } from "./llm.ts";
import type { ModelRuntime, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { MemoriesConfig } from "./config.ts";
import { RootJail, consolidationTools } from "./agent-tools.ts";

/** Adapt the public extension registry to SDK streaming without loading a second auth store.
 * Complete responses are streamed as terminal events; compaction uses the same authenticated route. */
export function registryRuntime(llm: Llm, model: MemoryModel, request: (model: MemoryModel, context: CompletionContext, options: CompletionOptions) => Promise<Completion>) {
  return {
    getModel: (provider: string, id: string) => llm.registry.find?.(provider,id) ?? model,
    getModels: () => [model], getAvailableSnapshot: () => [model], getError: () => undefined,
    hasConfiguredAuth: () => llm.registry.hasConfiguredAuth?.(model) ?? true,
    getAuth: async () => {const auth=await llm.registry.getProviderAuth?.(model.provider);return auth?{auth}:undefined;},
    isUsingOAuth: () => llm.registry.isUsingOAuth?.(model) ?? false,
    getProvider: (id: string) => llm.registry.getProvider?.(id),
    streamSimple(m: MemoryModel, context: CompletionContext, options: CompletionOptions) {
      const result=request(m,context,options);
      return { result:()=>result, async *[Symbol.asyncIterator]() {
        const message=await result;
        yield {type:"start",partial:{...message,content:[]}};
        if(message.stopReason==="error"||message.stopReason==="aborted") yield {type:"error",reason:message.stopReason,error:message};
        else yield {type:"done",reason:message.stopReason,message};
      }};
    },
  };
}

export async function runPiConsolidationSession(llm: Llm, model: MemoryModel, cfg: MemoriesConfig, root: string, systemPrompt: string, prompt: string, signal: AbortSignal, guarded: <T>(fn:()=>T)=>T, onProgress?: (s:string)=>void) {
  const progress = (message: string) => { try { onProgress?.(message); } catch { /* Observers must not change tool outcomes. */ } };
  const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager}=await import("@earendil-works/pi-coding-agent");
  const settingsManager=SettingsManager.inMemory({compaction:{enabled:true},retry:{enabled:false},packages:[],extensions:[],skills:[],prompts:[],enableAnalytics:false,enableInstallTelemetry:false});
  const resourceLoader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt});
  await resourceLoader.reload();
  const usage = { requests: 0, input: 0, output: 0, cacheRead: 0, totalTokens: 0 };
  const runtime=registryRuntime(llm,model,async(m,context,options)=>{
    if(signal.aborted)throw new Error("aborted");
    guarded(()=>{});
    const response=await llm.registry.complete(m,context,{...options,reasoningEffort:cfg.consolidation_thinking==="off"?undefined:cfg.consolidation_thinking,signal:options?.signal?AbortSignal.any([signal,options.signal]):signal});
    usage.requests++; usage.input += response.usage?.input ?? 0; usage.output += response.usage?.output ?? 0; usage.cacheRead += response.usage?.cacheRead ?? 0; usage.totalTokens += response.usage?.totalTokens ?? 0;
    // SDK expects complete pi message metadata; provider responses already contain it.
    return {...response, api:response.api ?? m.api, provider:response.provider ?? m.provider, model:response.model ?? m.id, timestamp:response.timestamp ?? Date.now(),
      usage:Object.assign({input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0},response.usage,{cost:Object.assign({input:0,output:0,cacheRead:0,cacheWrite:0,total:0},response.usage?.cost)})};
  });
  const tools: ToolDefinition[]=consolidationTools(new RootJail(root)).map(t=>({name:t.def.name,label:t.def.name,description:t.def.description,parameters:t.def.parameters,
    execute:async(_id,args)=>{if(signal.aborted)throw new Error("aborted");const result=guarded(()=>t.run(args));progress(t.def.name);return {...result,details:{}};}}));
  // SDK accepts only its concrete class (including private fields); this adapter implements
  // the public subset used by an isolated session. Contract/lifecycle tests exercise that subset.
  const {session}=await createAgentSession({cwd:root,agentDir:root,model,modelRuntime:runtime as unknown as ModelRuntime,thinkingLevel:cfg.consolidation_thinking,resourceLoader,settingsManager,sessionManager:SessionManager.inMemory(root),tools:tools.map(t=>t.name),customTools:tools});
  let abortError: unknown;
  const abort=()=>{void session.abort().catch(e => { abortError = e; });};signal.addEventListener("abort",abort);
  let compactionFailure: string | undefined;
  const unsubscribe=session.subscribe(event=>{
    if(event.type==="compaction_start")progress("compaction_start");
    if(event.type==="compaction_end"){
      if(event.errorMessage||event.aborted)compactionFailure=event.errorMessage??"compaction aborted";
      progress(event.errorMessage??"compaction_end");
    }
  });
  try {
    if(signal.aborted)throw new Error("aborted");
    await session.prompt(prompt);
    await session.waitForIdle();
    if(signal.aborted)throw new Error("aborted");
    if(compactionFailure)throw new Error(compactionFailure);
    const last=[...session.messages].reverse().find(m=>m.role==="assistant");
    if(last?.stopReason!=="stop")throw new Error(last?.errorMessage??"consolidation did not complete");
    return {completed:true, usage};
  } finally {
    unsubscribe();signal.removeEventListener("abort",abort);
    try { await session.abort(); } catch (e) { abortError = e; }
    finally { session.dispose(); }
    if (abortError) progress('session abort cleanup failed');
  }
}
