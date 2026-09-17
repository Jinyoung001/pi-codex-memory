**English** | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

# pi-codex-memory

A standalone pi extension porting the memory behavior of [OpenAI Codex](https://github.com/openai/codex/tree/5bf132cd527311eb61bbec46562e3890eb49df80/codex-rs/memories), pinned to commit `5bf132cd527311eb61bbec46562e3890eb49df80`. Uses pi sessions, model registry and authentication; no Codex installation or account is required. Host differences and verification: [CODEX_PARITY.md](CODEX_PARITY.md).

## Installation

Requires Node >=22.13, pi >=0.85.1 and Git.

Install the published extension with pi:

```sh
pi install npm:pi-codex-memory
```

Restart pi or run `/reload` in an existing session, then use `/memories status` to check the extension. The current pi session model is used by default; no separate model configuration is required.

Update an existing npm installation:

```sh
pi update npm:pi-codex-memory
```

Reload pi after updating. For local development, install a checkout with `pi install /path/to/pi-codex-memory`. The pinned Codex upstream source is not updated automatically at runtime.

## Behavior

- An eligible persistent root session dispatches the background pipeline on its first user turn. Ephemeral and subagent sessions are excluded.
- Phase 1 selects recent idle interactive sessions, claims SQLite jobs, sanitizes the active branch, requests structured extraction, and stores the validated result. Leases, bounded concurrency and retry backoff prevent duplicate work.
- Phase 2 claims one global job per memory version, selects evidence by usage/recency, synchronizes rollout summaries and V1 raw memories, prunes resources, and computes a Git workspace diff. No changes plus valid artifacts means no consolidation model call.
- When changes exist, an isolated pi SDK agent session consolidates memory through jailed file tools. General extensions, ambient project instructions, shell/network tools and recursive delegation are not loaded. SDK compaction and cancellation use the same pi model/auth route. This is tool-level containment, not Codex's OS sandbox.
- The read path injects upstream instructions and the bounded memory summary. Citation rollout IDs update usage counts. Dedicated retrieval/note tools are optional and follow the pinned contracts.
- V1 and V2 keep separate roots/databases. Dual-write dispatches both pipelines independently. Readiness reports the V2 threshold and summary validity; it does not change the active version.

There is no separate efficient profile, FTS/vector index, QMD model, semantic retrieval, custom core snapshot or daily delta-distillation budget.

## Configuration

Saved in `~/.pi/agent/memories.json`:

```json
{
  "version": "v1",
  "dual_write": false,
  "enabled": true,
  "generate_memories": true,
  "use_memories": true,
  "dedicated_tools": false,
  "disable_on_external_context": false,
  "max_raw_memories_for_consolidation": 256,
  "max_unused_days": 30,
  "max_rollout_age_days": 10,
  "max_rollouts_per_startup": 2,
  "min_rollout_idle_hours": 6,
  "extract_model": null,
  "consolidation_model": null,
  "tool_result_token_budget": 1000,
  "extract_thinking": "low",
  "consolidation_thinking": "medium"
}
```

### Reducing background token cost

Stage 1 re-reads whole rollouts, and on real sessions roughly 70% of a rollout is tool output (file reads, command stdout). Two levers, both dependency-free:

1. **Cheaper model** — `extract_model` / `consolidation_model` (above). This is by far the largest saving.
2. **`tool_result_token_budget`** (host addition, not in Codex; default `1000`, `0` disables) — before extraction each tool result is capped to this many tokens with head+tail retained (errors keep 3x), runs of identical lines are folded to `[… same line ×N]`, and a repeated identical result becomes `[identical to tool result #N: <first line>]` (tool rows are numbered `[tool name #N]`). User and assistant text is never altered, so the extractor sees the whole conversation instead of losing its tail to one large file dump.

Measure on your own sessions without any model calls:

```bash
node --experimental-strip-types --no-warnings scripts/bench-compaction.mjs [budget=1000] [maxSessions=40]
```

Example from a local machine (5 sessions, 745K rendered tokens, OpenRouter list prices at the time):

| | rendered rollout | sent to stage 1 (150K cap) | stage-1 cost |
|---|---|---|---|
| session model (`gpt-6-astra` / `claude-fable-5.1`, $10/$50 per M), raw | 745K | 321K | $3.58 |
| same model, budget 1000 | 485K (-35%) | 275K (-14%) | $3.12 |
| `deepseek/deepseek-v4.1-flash` ($0.30/$1.20 per M), raw | 745K | 321K | $0.105 |
| flash, budget 1000 | 485K | 275K | **$0.092 (×39 cheaper)** |

Budget 500 cuts rendered rollouts by ~47% at the cost of shorter non-error tool output. Sessions already above the 150K cap do not get cheaper — they get a better-balanced input. Set `BENCH_PRICES='{"name":{"in":..,"out":..}}'` to compare other models.

**What compaction can and cannot save.** The saving is bounded by the share of tool output in a rollout: `≈ tool_share × (1 − 1/compression)`, and zero for sessions that still exceed the 150K cap afterwards. Sessions dominated by file reads and command output (typically 70–90% tool output) save 30–60%; sessions that are mostly assistant code and pasted text, or whose tool output was already compacted live (e.g. by an `rtk`-style shell filter), save little. This is expected: live filters cut the same bytes once at the source, and stage 1 reads each rollout only once, so there is no per-turn multiplier to amplify the gain.

End-to-end check (`scripts/bench-pipeline.sh`, real phase 1 + phase 2 in an isolated home, same two claimed sessions, `gpt-6-astra`, thinking low): budget 0 → phase 1 223K tokens, phase 2 42K input / 132K cached / 5.3K output; budget 1000 → phase 1 225K, phase 2 31K / 164K / 6.0K. No stage-1 saving there because the large session was 10% tool output and stayed above the cap. The model choice dominated instead: the same run on `deepseek-v4.1-flash` cost roughly 11× less (thinking `max`) to 30–40× less (thinking `low`).

```bash
# real model calls, costs money; label extract_model consolidation_model extract_thinking consolidation_thinking budget [provider/model for the session]
scripts/bench-pipeline.sh G1 null null low low 1000 openai-codex/gpt-6-astra
```

Every pipeline run appends `phase1: … N tokens` and `phase2: usage requests=… input=… cacheRead=… output=…` to `memories.log`, so you can read your own numbers after normal use.

Models accept `provider/model-id`. By default, both stages use the current pi session model (`null`); an explicit setting overrides it for that stage. Codex's preferred models are not selected automatically. Explicit settings fail if unavailable or unauthenticated; request errors never trigger a model switch. `/memories status` shows the last selected provider/model, `session-default` or `explicit`, and extraction output enforcement.

### Choosing a memory model

**We recommend explicitly choosing a lower-cost model for background memory extraction and consolidation**, especially when your interactive session uses an expensive model. These stages and SDK compaction make additional model requests. Choose a model that reliably produces the required JSON and handles consolidation file tools; check its results before relying on it.

1. Configure and authenticate the provider in pi, then copy the model's exact `provider/model-id` from pi's model selector.
2. Edit `~/.pi/agent/memories.json` (Windows: `%USERPROFILE%\.pi\agent\memories.json`) and set either or both fields below. Replace the placeholder values with registered model IDs; both stages may use the same model.

```json
{
  "extract_model": "your-provider/your-lower-cost-model-id",
  "consolidation_model": "your-provider/your-lower-cost-model-id"
}
```

3. Reload pi, then check `/memories status` after the next memory run to confirm the selected models and validation mode.

Set either field back to `null` to use the current session model for that stage. Existing explicit settings remain unchanged when upgrading. Model choice is a pi host adaptation; the pinned Codex memory processing rules remain unchanged.

Verified OpenAI Responses and Chat Completions requests carry the upstream strict JSON Schema. Other providers use local schema validation and are reported as compatibility mode. All outputs are locally validated. Consolidation finishes on a normal SDK assistant stop plus artifact validation; there is no custom completion tool or turn cap. No Codex account quota API is implemented.

`generate_memories: false` excludes new sessions; older eligible sessions can still be processed, as upstream does. `use_memories: false` disables summary injection and tool execution. `enabled: false` disables and cancels this process's pipeline. Version and tool registration changes require reload.

## Commands and tools

`/memories [status|readiness [minimum]|run|force|on|off|generate on|off|use on|off|thread on|off|reset]`

`run` respects cooldown; `force` is an explicit pi override to run despite cooldown/no-change. `thread off` excludes that session and removes its extraction. Reset requires confirmation and refuses running jobs. Original pi session files are never deleted by reset.

With `dedicated_tools: true`, `enabled: true`, and `use_memories: true`:

| Tool | Contract |
|---|---|
| `memories_list` | Visible memory files; default/max 2,000 entries |
| `memories_search` | Structured matching, windows and paging; default/max 200 matches |
| `memories_read` | UTF-8 files, line offset and limits; default 20,000 reference tokens |
| `memories_add_ad_hoc_note` | Explicit timestamped note for a later consolidation |

Summary injection has the upstream 2,500-token budget. Search does not invoke an embedding model.

## Data and migration

V1: `~/.pi/agent/memories/`, `memories_1.sqlite`. V2: `memories_v2/`, `memories_2.sqlite`. Artifacts include `memory_summary.md`, rollout summaries, skills, extensions and (V1) `MEMORY.md` / `raw_memories.md`.

At session start, retired profile/recall/core/tidy settings and `consolidation_max_turns` are removed after backing up the original config as `memories.json.before-codex-only.bak` (numbered suffix if a backup already exists). One migration notice is emitted. Provider choices and other settings remain intact. Legacy schemas/status labels are upgraded after a SQLite snapshot backup `*.before-codex-schema.bak`; old `failed` jobs become upstream `error` jobs. Existing experimental tables remain untouched and unused. Downloaded experimental model caches are not deleted automatically.

Extraction sends historical session content to the configured pi provider; consolidation sends selected memory artifacts through the same provider interface. Redaction is best effort. SDK compaction can make additional provider requests. No live paid-provider validation is claimed.

## Validation

`npm run check` · `npm test` · `git diff --check` · `npm pack --dry-run --json --ignore-scripts`

Tests use temporary state, fixed model responses, actual pi SDK sessions (65 tool turns, cancellation, overflow compaction and resume), local HTTP payload capture, concurrent processes, and an installed-package smoke test. Literal upstream test vectors cover filtering, truncation, citations and eligibility. Source/prompt hashes bind tests to the pinned commit. See the parity matrix for coverage and host limitations.

Isolation overrides: `PI_CODEX_MEMORY_HOME`, `PI_CODEX_MEMORY_SESSIONS`. `PI_CODEX_MEMORY_WAIT_ON_SHUTDOWN=1` drains running work in headless smoke runs.

## License

Original implementation MIT; vendored Codex sources/templates Apache-2.0. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
