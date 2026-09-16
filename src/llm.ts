// Thin wrapper over pi's ModelRegistry.complete(). Snapshotting registry/model avoids using a stale
// ExtensionContext after session replacement (pi throws on that).
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Llm = { registry: ExtensionContext["modelRegistry"]; sessionModel: ExtensionContext["model"] };
export type MemoryModel = NonNullable<Llm['sessionModel']>;
export type CompletionContext = Parameters<Llm['registry']['complete']>[1];
export type CompletionOptions = NonNullable<Parameters<Llm['registry']['complete']>[2]>;
export type Completion = Awaited<ReturnType<Llm['registry']['complete']>>;
export const snap = (ctx: ExtensionContext): Llm => ({ registry: ctx.modelRegistry, sessionModel: ctx.model });

export function resolveMemoryModel(l: Llm, spec: string | null) {
  return {model:resolveModel(l,spec),selection:spec?"explicit":"session-default",reason:null};
}
export function extractionSchema(version: "v1" | "v2") {
  return {type:"object",properties:{rollout_summary:{type:"string"},rollout_slug:{type:version==="v1"?["string","null"]:"string"},...(version==="v1"?{raw_memory:{type:"string"}}:{})},required:version==="v1"?["rollout_summary","rollout_slug","raw_memory"]:["rollout_summary","rollout_slug"],additionalProperties:false};
}
export function outputMode(model: Pick<MemoryModel, 'provider' | 'api'>) {
  return model.provider==="openai" && ["openai-responses","openai-completions"].includes(model.api) ? "strict-request+local-validation" : "compatible-local-validation";
}
export function schemaPayload(model: MemoryModel, version: "v1" | "v2", payload: unknown) {
  if(outputMode(model)==="compatible-local-validation")return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid provider payload');
  const body = payload as Record<string, unknown>;
  const format={type:"json_schema",name:"memory_extraction",strict:true,schema:extractionSchema(version)};
  return model.api==="openai-responses" ? {...body,text:{...(typeof body.text === 'object' && body.text ? body.text : {}),format}} : {...body,response_format:{type:"json_schema",json_schema:{name:format.name,strict:true,schema:format.schema}}};
}

export function resolveModel(l: Llm, spec: string | null) {
  if (!spec) { if (!l.sessionModel) throw new Error("no session model"); return l.sessionModel; }
  const [prov, ...rest] = spec.split("/");
  const m = l.registry.find(prov, rest.join("/"));
  if (!m) throw new Error(`configured memory model unavailable: ${spec}`);
  if (!l.registry.hasConfiguredAuth(m)) throw new Error(`no auth for memory model: ${spec}`);
  return m;
}

export type Msg = CompletionContext['messages'][number];

export async function complete(l: Llm, model: MemoryModel, ctx: CompletionContext, thinking: Thinking, signal?: AbortSignal, sessionId = randomUUID(), version?: "v1" | "v2") {
  const res = await l.registry.complete(model, ctx, { reasoningEffort: thinking === "off" ? undefined : thinking, sessionId, signal,
    ...(version && outputMode(model)!=="compatible-local-validation" ? {onPayload:(payload:unknown)=>schemaPayload(model,version,payload)} : {}) });
  return res;
}

export const textOf = (msg: Completion): string => msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
export const toolCallsOf = (msg: Completion) => msg.content.filter(c => c.type === 'toolCall');

export function usageOf(msg: Completion) { return msg.usage ?? { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } }; }
