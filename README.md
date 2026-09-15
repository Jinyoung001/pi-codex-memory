# pi-codex-memory

Port of OpenAI Codex's memory system (`codex-rs/memories`, V1 pipeline) to the [pi](https://github.com/earendil-works/pi) coding agent. Pinned upstream commit and per-feature status: [CODEX_PARITY.md](CODEX_PARITY.md).

```bash
pi install npm:pi-codex-memory
```

Requires Node ≥ 22 (`node:sqlite`) and `git` on PATH (memory workspace baseline).

## What it does

```
first user turn of a persistent root session → background:
  index ~/.pi/agent/sessions/**/*.jsonl → threads table (SQLite)
  prune stale stage-1 rows
  Phase 1  claim idle sessions (≥6h idle, ≤30d old, max 16/startup, 8 parallel, 1h lease)
           render active branch → redact → extraction model → {raw_memory, rollout_summary, rollout_slug}
  Phase 2  global lease (1h, 90s heartbeat, 6h cooldown after success)
           select top-256 by usage/recency → sync raw_memories.md + rollout_summaries/
           git diff vs. baseline; if changed → consolidation agent (jailed file tools, no shell/network)
           → MEMORY.md, memory_summary.md (v1), skills/ → validate → reset baseline
every turn   read_path.md + memory_summary.md (≤2,500 tokens) appended to the system prompt
each reply   <oai-mem-citation> rollout ids → usage_count++ (drives retention)
```

Prompts in `prompts/` are byte-identical to upstream (checksums in `vendor/codex/reference.json`, verified by `npm test`).

## Files

| Path | |
|---|---|
| `~/.pi/agent/memories/` | memory root (git repo managed by the pipeline) |
| `  memory_summary.md` | injected every turn |
| `  MEMORY.md` | retrieval handbook (Task Group blocks) |
| `  raw_memories.md`, `rollout_summaries/` | Phase 2 inputs |
| `  skills/` | procedures the consolidation agent chose to write |
| `  extensions/ad_hoc/notes/` | explicit user "remember/forget" notes |
| `~/.pi/agent/memories_1.sqlite` | stage-1 outputs, jobs, threads |
| `~/.pi/agent/memories.json` | config |
| `~/.pi/agent/memories.log` | pipeline log |

## Config `~/.pi/agent/memories.json`

```json
{
  "enabled": true,
  "generate_memories": true,
  "use_memories": true,
  "dedicated_tools": true,
  "disable_on_external_context": false,
  "max_raw_memories_for_consolidation": 256,
  "max_unused_days": 30,
  "max_rollout_age_days": 30,
  "max_rollouts_per_startup": 16,
  "min_rollout_idle_hours": 6,
  "extract_model": null,
  "consolidation_model": null,
  "extract_thinking": "low",
  "consolidation_thinking": "medium",
  "consolidation_max_turns": 60
}
```

`extract_model` / `consolidation_model`: `"provider/model-id"` (e.g. `"openrouter/deepseek/deepseek-v4.1-flash"`), `null` = current session model.

## Commands and tools

`/memories` status · `run` · `force` (ignore cooldown, always run the agent) · `on|off` · `generate on|off` · `use on|off` · `thread on|off` (exclude this session; `off` also deletes its extraction) · `reset`

Tools (when `dedicated_tools`): `memories_list`, `memories_search`, `memories_read`, `memories_add_ad_hoc_note`.

## Privacy and cost

Past session content is sent to the extraction model provider; extracted memories and the memory workspace are sent to the consolidation model provider. Secret redaction is best-effort. This is not local-only processing. Review `~/.pi/agent/memories/` before sharing it.

## Development

```
npm run check   # tsc
npm test        # node --test, temp dirs, no model calls
```

Env for isolated live runs: `PI_CODEX_MEMORY_HOME=<dir>` (memory root/db/config), `PI_CODEX_MEMORY_SESSIONS=<dir>`, `PI_CODEX_MEMORY_WAIT_ON_SHUTDOWN=1` (drain pipeline before exit in `-p` mode).

## License

Original code MIT. `prompts/` and `vendor/codex/` are from OpenAI Codex under Apache-2.0 — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
