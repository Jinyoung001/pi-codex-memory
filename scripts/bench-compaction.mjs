// Measures stage-1 input reduction and cost on real local pi sessions. Read-only; no model calls.
// Usage: node --experimental-strip-types --no-warnings scripts/bench-compaction.mjs [budget=1000] [maxSessions=40]
// Prices are USD per 1M tokens (input/output); edit PRICES or pass JSON via BENCH_PRICES to compare your own models.
import { listSessionFiles, renderSession, rolloutTokenLimit } from '../src/rollout.ts';
import { truncateTokens } from '../src/codex-truncate.ts';

const budget = Number(process.argv[2] ?? 1000), max = Number(process.argv[3] ?? 40), cap = rolloutTokenLimit(undefined);
const PRICES = process.env.BENCH_PRICES ? JSON.parse(process.env.BENCH_PRICES) : {
  'session model (gpt-6-astra / claude-fable-5.1)': { in: 10, out: 50 },
  'deepseek-v4.1-flash': { in: 0.30, out: 1.20 },
};
const P1_OUT_TOKENS = 1500; // typical stage-1 JSON (raw_memory + rollout_summary); thinking adds on top, ignored here
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

console.log(`\nstage-1 cost for these ${rows.length} sessions (input tokens actually sent + ${P1_OUT_TOKENS} output tokens each):`);
const cost = (p, inTok) => (inTok * p.in + rows.length * P1_OUT_TOKENS * p.out) / 1e6;
const base = cost(Object.values(PRICES)[0], sum('sentRaw'));
for (const [name, p] of Object.entries(PRICES)) {
  const a = cost(p, sum('sentRaw')), b = cost(p, sum('sentSmall'));
  console.log(`  ${name.padEnd(48)} raw $${a.toFixed(4)}  compacted $${b.toFixed(4)}  (x${(base / b).toFixed(1)} cheaper than baseline raw)`);
}
