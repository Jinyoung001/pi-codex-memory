import type { Llm } from "./llm.ts";
import type { MemoriesConfig } from "./config.ts";
import { RootJail, consolidationTools } from "./agent-tools.ts";

/** Adapt the public extension registry to SDK streaming without loading a second auth store.
 * Complete responses are streamed as terminal events; compaction uses the same authenticated route. */
export function registryRuntime(llm: Llm, model: any, request: (model: any, context: any, options: any) => Promise<any>) {
  return {
    getModel: (provider: string, id: string) => llm.registry.find?.(provider,id) ?? model,
    getModels: () => [model], getAvailableSnapshot: () => [model], getError: () => undefined,
    hasConfiguredAuth: () => llm.registry.hasConfiguredAuth?.(model) ?? true,
    getAuth: async () => {const auth=await llm.registry.getProviderAuth?.(model.provider);return auth?{auth}:undefined;},
    isUsingOAuth: () => llm.registry.isUsingOAuth?.(model) ?? false,
    getProvider: (id: string) => llm.registry.getProvider?.(id),
    streamSimple(m: any, context: any, options: any) {
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

export async function runPiConsolidationSession(llm: Llm, model: any, cfg: MemoriesConfig, root: string, systemPrompt: string, prompt: string, signal: AbortSignal, guarded: <T>(fn:()=>T)=>T, onProgress?: (s:string)=>void) {
  const {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager}=await import("@earendil-works/pi-coding-agent");
  const settingsManager=SettingsManager.inMemory({compaction:{enabled:true},retry:{enabled:false},packages:[],extensions:[],skills:[],prompts:[],enableAnalytics:false,enableInstallTelemetry:false});
  const resourceLoader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt});
  await resourceLoader.reload();
  const runtime=registryRuntime(llm,model,async(m,context,options)=>{
    if(signal.aborted)throw new Error("aborted");
    guarded(()=>{});
    const response: any=await llm.registry.complete(m,context,{...options,reasoningEffort:cfg.consolidation_thinking==="off"?undefined:cfg.consolidation_thinking,signal:options?.signal?AbortSignal.any([signal,options.signal]):signal});
    // SDK expects complete pi message metadata; provider responses already contain it.
    return {api:m.api??"openai-completions",provider:m.provider,model:m.id,timestamp:Date.now(),...response,
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,...response.usage,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0,...response.usage?.cost}}};
  });
  const tools=consolidationTools(new RootJail(root)).map(t=>({name:t.def.name,label:t.def.name,description:t.def.description,parameters:t.def.parameters,
    execute:async(_id:string,args:any)=>{if(signal.aborted)throw new Error("aborted");const result=guarded(()=>t.run(args));onProgress?.(t.def.name);return {...result,details:{}};}}));
  const {session}=await createAgentSession({cwd:root,agentDir:root,model,modelRuntime:runtime as any,thinkingLevel:cfg.consolidation_thinking,resourceLoader,settingsManager,sessionManager:SessionManager.inMemory(root),tools:tools.map(t=>t.name),customTools:tools as any});
  const abort=()=>{void session.abort();};signal.addEventListener("abort",abort);
  let compactionFailure: string | undefined;
  const unsubscribe=session.subscribe((event:any)=>{
    if(event.type==="compaction_start")onProgress?.("compaction_start");
    if(event.type==="compaction_end"){
      if(event.errorMessage||event.aborted)compactionFailure=event.errorMessage??"compaction aborted";
      onProgress?.(event.errorMessage??"compaction_end");
    }
  });
  try {
    if(signal.aborted)throw new Error("aborted");
    await session.prompt(prompt);
    await session.waitForIdle();
    if(signal.aborted)throw new Error("aborted");
    if(compactionFailure)throw new Error(compactionFailure);
    const last=[...session.messages].reverse().find((m:any)=>m.role==="assistant") as any;
    if(last?.stopReason!=="stop")throw new Error(last?.errorMessage??"consolidation did not complete");
    return {completed:true};
  } finally {unsubscribe();signal.removeEventListener("abort",abort);await session.abort();session.dispose();}
}
