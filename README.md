# pi-codex-memory

Codex-style two-phase memory for pi. Port of `openai/codex` `codex-rs/memories` pipeline; prompts in `prompts/` are the upstream originals (stage_one_system.md, stage_one_input.md, consolidation.md) with a runtime adaptation appended for single-shot JSON output.

## Flow

```
session_start (background, 1.5s delay)
  Phase 1  idle ≥6h, ≤30d sessions (max 8/startup, 4 parallel)
           → deepseek-v4.1-flash → {raw_memory, rollout_summary, slug} → redact → state.json
  Phase 2  cooldown 6h, top-256 by usage/recency
           → sync raw_memories.md + rollout_summaries/ → if changed: session model
           → MEMORY.md + memory_summary.md (v1)
before_agent_start  inject memory_summary.md (≤10k chars) + read-path rules
agent_end           <memory_citation>{"rollouts":[...]}</memory_citation> → usage_count++
```

## Files `~/.pi/agent/memories/`

| | |
|---|---|
| `memory_summary.md` | injected every turn |
| `MEMORY.md` | grep handbook (Task Group blocks) |
| `raw_memories.md` | phase-2 input |
| `rollout_summaries/*.md` | per-session recap |
| `notes/*.md` | ad-hoc notes, consumed by next phase 2 |
| `state.json` | phase-1 outputs, usage, watermarks |
| `log.txt` | pipeline log |

## Tools

`memories_list`, `memories_search {query, file?}`, `memories_read {file, start?, end?}`, `memories_add_note {note}` (only on explicit user request).

## Commands

`/memories` status · `/memories run` · `/memories force` (ignore cooldown/clean check) · `/memories off|on` (exclude/include current session) · `/memories reset`

Test from shell: `PI_CODEX_MEMORY_FORCE=1 pi -p --no-session -e ~/.pi/agent/extensions/pi-codex-memory/index.ts "ok"`

## Config

Edit `CFG` at top of `index.ts`. `consolidateModel: ""` = current session model.

## Differences from Codex

- JSON state file instead of SQLite; no git-baseline diff (compares raw_memories.md content + removed files)
- Phase 2 is one `complete()` call with inputs inline, not a file-browsing subagent → no `skills/` generation
- Sessions < 1500 chars skipped
