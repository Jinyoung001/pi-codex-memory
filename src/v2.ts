// Pinned V2 tier order and byte budgets over pi-rendered rows.
// Native pi roles/stop reasons and upstream notification markers supply available provenance.
import { truncateBytes } from "./codex-truncate.ts";
import { redact } from "../safety.js";
export function tieredEvidence(rows: string[], tokens: number): string {
  const marker = "[... response items omitted ...]\n";
  let remaining = Math.max(0, tokens * 4 - Buffer.byteLength(marker));
  const selected = new Map<number, string>();
  const tier = (row: string) => row.startsWith("[human user]") ? 0
    : row.startsWith("[assistant final]") || row.startsWith("[assistant]") ? 1
    : row.startsWith("[other agent]") ? 2 : row.startsWith("[assistant commentary]") ? 3
    : row.startsWith("[harness context]") ? 4 : 5;
  const capped = rows.map(row => {
    const split = row.indexOf("\n"), label = split < 0 ? "[tool]" : row.slice(0, split);
    const cap = tier(row) === 5 && !row.startsWith("[tool call]") ? 7904 : 9904;
    return label + "\n" + truncateBytes(split < 0 ? row : row.slice(split + 1), cap) + "\n";
  });
  for (let priority = 0; priority < 6; priority++) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (tier(rows[i]) !== priority || remaining <= Buffer.byteLength(marker) + 96) continue;
      const budget = remaining - Buffer.byteLength(marker);
      const text = Buffer.byteLength(capped[i]) <= budget ? capped[i] : truncateBytes(capped[i], budget - 96);
      selected.set(i, text);
      remaining -= Buffer.byteLength(text) + Buffer.byteLength(marker);
    }
  }
  let result = "", gap = false;
  for (let i = 0; i < rows.length; i++) {
    if (selected.has(i)) { result += selected.get(i); gap = false; }
    else if (!gap) { result += marker; gap = true; }
  }
  return Buffer.byteLength(result) <= tokens * 4 ? result : "";
}
export function evidenceMessages(text: string) {
  const messages = [];
  const bytes = Buffer.from(text);
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + 8900, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    messages.push({ role: "user", content: [{ type: "text", text: bytes.subarray(start, end).toString("utf8") }], timestamp: Date.now() });
    start = end;
  }
  return messages;
}
export function v2Output(value: any): { raw_memory: string; rollout_summary: string; rollout_slug: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => k !== "rollout_summary" && k !== "rollout_slug") || typeof value.rollout_summary !== "string" || typeof value.rollout_slug !== "string") throw new Error("invalid V2 extraction output");
  return { raw_memory: "", rollout_summary: truncateBytes(redact(value.rollout_summary), 9000), rollout_slug: redact(value.rollout_slug) };
}
