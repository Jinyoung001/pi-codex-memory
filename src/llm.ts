// Thin wrapper over pi's ModelRegistry.complete(). Snapshotting registry/model avoids using a stale
// ExtensionContext after session replacement (pi throws on that).
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Llm = { registry: ExtensionContext["modelRegistry"]; sessionModel: ExtensionContext["model"] };
export const snap = (ctx: ExtensionContext): Llm => ({ registry: ctx.modelRegistry, sessionModel: ctx.model });

export function resolveMemoryModel(l: Llm, spec: string | null) {
  return {model:resolveModel(l,spec),selection:spec?"explicit":"session-default",reason:null};
}
export function extractionSchema(version: "v1" | "v2") {
  return {type:"object",properties:{rollout_summary:{type:"string"},rollout_slug:{type:version==="v1"?["string","null"]:"string"},...(version==="v1"?{raw_memory:{type:"string"}}:{})},required:version==="v1"?["rollout_summary","rollout_slug","raw_memory"]:["rollout_summary","rollout_slug"],additionalProperties:false};
}
export function outputMode(model: any) {
  return model.provider==="openai" && ["openai-responses","openai-completions"].includes(model.api) ? "strict-request+local-validation" : "compatible-local-validation";
}
export function schemaPayload(model: any, version: "v1" | "v2", payload: any) {
  if(outputMode(model)==="compatible-local-validation")return payload;
  const format={type:"json_schema",name:"memory_extraction",strict:true,schema:extractionSchema(version)};
  return model.api==="openai-responses" ? {...payload,text:{...payload.text,format}} : {...payload,response_format:{type:"json_schema",json_schema:{name:format.name,strict:true,schema:format.schema}}};
}

export function resolveModel(l: Llm, spec: string | null) {
  if (!spec) { if (!l.sessionModel) throw new Error("no session model"); return l.sessionModel; }
  const [prov, ...rest] = spec.split("/");
  const m = l.registry.find(prov, rest.join("/"));
  if (!m) throw new Error(`configured memory model unavailable: ${spec}`);
  if (!l.registry.hasConfiguredAuth(m)) throw new Error(`no auth for memory model: ${spec}`);
  return m;
}

export type Msg = any; // pi-ai Message union; kept loose to avoid importing internal types

export async function complete(l: Llm, model: any, ctx: { systemPrompt: string; messages: Msg[]; tools?: any[] }, thinking: Thinking, signal?: AbortSignal, sessionId = randomUUID(), version?: "v1" | "v2") {
  const res = await l.registry.complete(model, ctx as any, { reasoningEffort: thinking === "off" ? undefined : thinking, sessionId, signal,
    ...(version && outputMode(model)!=="compatible-local-validation" ? {onPayload:(payload:unknown)=>schemaPayload(model,version,payload)} : {}) } as any);
  return res;
}

export const textOf = (msg: any): string => (Array.isArray(msg?.content) ? msg.content : []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
export const toolCallsOf = (msg: any): { id: string; name: string; arguments: Record<string, any> }[] => (Array.isArray(msg?.content) ? msg.content : []).filter((c: any) => c.type === "toolCall");

export function usageOf(msg: any) { return msg?.usage ?? { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } }; }
