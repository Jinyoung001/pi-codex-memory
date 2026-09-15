// Thin wrapper over pi's ModelRegistry.complete(). Snapshotting registry/model avoids using a stale
// ExtensionContext after session replacement (pi throws on that).
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Llm = { registry: ExtensionContext["modelRegistry"]; sessionModel: ExtensionContext["model"] };
export const snap = (ctx: ExtensionContext): Llm => ({ registry: ctx.modelRegistry, sessionModel: ctx.model });

export function resolveModel(l: Llm, spec: string | null) {
  if (!spec) { if (!l.sessionModel) throw new Error("no session model"); return l.sessionModel; }
  const [prov, ...rest] = spec.split("/");
  const m = l.registry.find(prov, rest.join("/"));
  if (!m) throw new Error(`configured memory model unavailable: ${spec}`);
  if (!l.registry.hasConfiguredAuth(m)) throw new Error(`no auth for memory model: ${spec}`);
  return m;
}

export type Msg = any; // pi-ai Message union; kept loose to avoid importing internal types

export async function complete(l: Llm, model: any, ctx: { systemPrompt: string; messages: Msg[]; tools?: any[] }, thinking: Thinking, signal?: AbortSignal) {
  const res = await l.registry.complete(model, ctx as any, { reasoningEffort: thinking === "off" ? undefined : thinking, cacheRetention: "none", sessionId: randomUUID(), signal } as any);
  return res;
}

export const textOf = (msg: any): string => (Array.isArray(msg?.content) ? msg.content : []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
export const toolCallsOf = (msg: any): { id: string; name: string; arguments: Record<string, any> }[] => (Array.isArray(msg?.content) ? msg.content : []).filter((c: any) => c.type === "toolCall");

export function usageOf(msg: any) { return msg?.usage ?? { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } }; }
