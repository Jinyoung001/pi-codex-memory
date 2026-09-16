// Pinned V2 tier order and byte budgets over pi-rendered rows.
// Native pi roles/stop reasons and upstream notification markers supply available provenance.
import { truncateBytes } from "./codex-truncate.ts";
import { redact } from "../safety.js";
const TRUNCATION_RESERVE = 96; // Additional UTF-8 marker bytes, outside retained body budget.
const TOOL_BODY_BYTES = 8000 - TRUNCATION_RESERVE;
const MESSAGE_BODY_BYTES = 10000 - TRUNCATION_RESERVE;
const EVIDENCE_CHUNK_BYTES = 8900;
const SUMMARY_BODY_BYTES = 9000; // Excludes the additional truncation marker.
export function tieredEvidence(rows: string[], tokens: number): string {
  const marker = "[... response items omitted ...]\n";
  if (!Number.isFinite(tokens) || tokens < 0) throw new Error('invalid evidence budget');
  let used = rows.length ? Buffer.byteLength(marker) : 0;
  const selected = new Map<number, string>();
  const tier = (row: string) => {
    if (row.startsWith('[human user]')) return 0;
    if (row.startsWith('[assistant final]') || row.startsWith('[assistant]')) return 1;
    if (row.startsWith('[other agent]')) return 2;
    if (row.startsWith('[assistant commentary]')) return 3;
    if (row.startsWith('[harness context]')) return 4;
    return 5;
  };
  const capped = rows.map(row => {
    const split = row.indexOf("\n"), label = split < 0 ? "[tool]" : row.slice(0, split);
    const cap = tier(row) === 5 && !row.startsWith("[tool call]") ? TOOL_BODY_BYTES : MESSAGE_BODY_BYTES;
    return label + "\n" + truncateBytes(split < 0 ? row : row.slice(split + 1), cap) + "\n";
  });
  for (let priority = 0; priority < 6; priority++) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (tier(rows[i]) !== priority) continue;
      const left = i === 0 || selected.has(i - 1), right = i === rows.length - 1 || selected.has(i + 1);
      const gapChange = (1 - Number(left) - Number(right)) * Buffer.byteLength(marker);
      const budget = Math.floor(tokens * 4) - used - gapChange;
      let text = capped[i];
      if (Buffer.byteLength(text) > budget) {
        if (budget <= TRUNCATION_RESERVE) continue;
        text = truncateBytes(text, budget - TRUNCATION_RESERVE);
      }
      selected.set(i, text);
      used += Buffer.byteLength(text) + gapChange;
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
    let end = Math.min(start + EVIDENCE_CHUNK_BYTES, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    messages.push({ role: "user" as const, content: [{ type: "text" as const, text: bytes.subarray(start, end).toString("utf8") }], timestamp: Date.now() });
    start = end;
  }
  return messages;
}
export function v2Output(value: unknown): { raw_memory: string; rollout_summary: string; rollout_slug: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid V2 extraction output');
  if (Object.keys(value).some(k => k !== 'rollout_summary' && k !== 'rollout_slug') || !('rollout_summary' in value) || !('rollout_slug' in value) || typeof value.rollout_summary !== 'string' || typeof value.rollout_slug !== 'string') throw new Error('invalid V2 extraction output');
  return { raw_memory: "", rollout_summary: truncateBytes(redact(value.rollout_summary), SUMMARY_BODY_BYTES), rollout_slug: redact(value.rollout_slug) };
}
