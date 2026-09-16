// Measures stage-1 input reduction from tool-result compaction on real local pi sessions. Read-only; no model calls.
// Usage: node --experimental-strip-types --no-warnings scripts/bench-compaction.mjs [budget=1000] [maxSessions=40]
import { listSessionFiles, renderSession, rolloutTokenLimit } from '../src/rollout.ts';
import { truncateTokens } from '../src/codex-truncate.ts';

const budget = Number(process.argv[2] ?? 1000), max = Number(process.argv[3] ?? 40), cap = rolloutTokenLimit(undefined);
const tok = s => Math.ceil(Buffer.byteLength(s) / 4);
const rows = [];
for (const { file } of listSessionFiles().slice(0, max)) {
  let raw, small;
  try { raw = renderSession(file).text; small = renderSession(file, budget).text; } catch { continue; }
  const r = tok(raw), s = tok(small);
  if (r < 1000) continue;
  rows.push({ raw: r, small: s, sentRaw: tok(truncateTokens(raw, cap)), sentSmall: tok(truncateTokens(small, cap)) });
}
const sum = k => rows.reduce((a, x) => a + x[k], 0), pct = (a, b) => `${(100 * (1 - a / b)).toFixed(1)}%`;
console.log(`sessions=${rows.length} budget=${budget} cap=${cap}`);
console.log(`rendered:   ${sum('raw')} -> ${sum('small')} tok  (-${pct(sum('small'), sum('raw'))})`);
console.log(`sent to P1: ${sum('sentRaw')} -> ${sum('sentSmall')} tok  (-${pct(sum('sentSmall'), sum('sentRaw'))})  over-cap before/after: ${rows.filter(x => x.raw > cap).length}/${rows.filter(x => x.small > cap).length}`);
const med = a => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`median per-session reduction: ${pct(med(rows.map(x => x.small / x.raw)) * 1, 1)}`);
