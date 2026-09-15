# Codex memory compatibility

## Reference

Repository: https://github.com/openai/codex — pinned commit `4e6450bbfd60bdfa845182f30aaa9d6f068e8bbd` (2026-09-15T00:42:31Z).
Vendored sources for review: `vendor/codex/src/*.rs`, overview `vendor/codex/MEMORIES.md`, prompt checksums `vendor/codex/reference.json` (verified by `npm test`).

Codex ships two memory versions; `MemoryVersion::V1` is the default and is what this package ports. V2 (`memories_v2`, summary-only extraction) is not implemented.

## Feature matrix

| Area | Codex (pinned) | pi-codex-memory | Status |
|---|---|---|---|
| Trigger | root, non-ephemeral, non-subagent session; after first user turn starts | `before_agent_start` on first turn; skipped when no session file (`--no-session`) or `PI_SUBAGENT*` env | ✅ |
| Rate-limit guard | Codex-backend quota only; other auth → allowed | N/A (no Codex backend). Documented, not faked. | ➖ |
| Thread index | `threads` table maintained by core | session `.jsonl` headers indexed into `threads` at startup (`rollout.ts`) | ✅ (pi-specific source) |
| Phase 1 claims | idle ≥ `min_rollout_idle_hours`, age ≤ `max_rollout_age_days`, `memory_mode='enabled'`, not current thread, lease 1h, retry backoff 1h, 3 retries, scan limit 5000 | same (`store.ts`) | ✅ |
| Phase 1 input | filtered response items, developer/AGENTS/skill fragments dropped, secrets redacted, head+tail truncation to 70% of context window | active-branch walk; drops custom_message/compaction/thinking, injected user fragments; redact; head+tail truncation to 70% of `model.contextWindow` | ✅ |
| Phase 1 output | strict JSON `{raw_memory, rollout_summary, rollout_slug}`, empty → `succeeded_no_output` deletes prior row + enqueues consolidation | same, schema validated; fenced/prose-wrapped JSON tolerated | ✅ |
| Phase 1 prompts | `stage_one_system.md`, `stage_one_input.md` | byte-identical (LF-normalized), checksum test | ✅ |
| Phase 1 model/effort | `extract_model` or provider preferred; effort Low; concurrency 8 | `extract_model` or session model; `extract_thinking` (default low); concurrency 8 | ✅ |
| Prune | `prune_stage1_outputs_for_retention(max_unused_days, 200)` before phase 1 | same | ✅ |
| Phase 2 lock | global job row, 1h lease, 90s heartbeat, 6h success cooldown, retry backoff, `failed_if_unowned` | same (`store.ts`) | ✅ |
| Phase 2 selection | top-N by `usage_count` desc, `COALESCE(last_usage, source_updated_at)` desc; `max_unused_days` cutoff; enabled threads only; stable thread-id order | same | ✅ |
| Workspace sync | `rollout_summaries/<stem>.md` (uuid-v7 timestamp + 4-char hash + slug), `raw_memories.md`, prune stale summaries, prune extension resources > 7 days | same (`storage.ts`) | ✅ |
| Change detection | memory root is a git repo; diff vs. single baseline commit; clean → succeed without agent; `phase2_workspace_diff.md` written for agent; baseline reset = re-init repo (no history) | same (`workspace.ts`), `.git/info/exclude` hides the diff file | ✅ |
| Consolidation agent | internal sub-agent, cwd = memory root, WorkspaceWrite sandbox (memory root only), no network, no approvals, no collab/MCP/apps, effort Medium | tool-loop over `modelRegistry.complete` with jailed tools (list/read/grep/write/edit/delete/mkdir/done); no shell/network tool exists; `consolidation_thinking` (default medium); bounded by `consolidation_max_turns` | ✅ (jail is in-process, not OS sandbox) |
| Consolidation prompt | `consolidation.md` + extension blocks | byte-identical template + same substitutions; short harness note appended describing the tool surface | ✅ |
| skills/ | agent may write `skills/<name>/SKILL.md` + scripts | same; scripts are stored, never executed by this package. Not auto-registered as pi skills. | ✅ / ⚠ |
| Artifact validation | no symlinks; `MEMORY.md` is a file; `memory_summary.md` first line `v1` | same | ✅ |
| Read path | `read_path.md` with `base_path` + summary truncated to 2,500 tokens, injected as developer instructions when `use_memories` | byte-identical template, appended to system prompt in `before_agent_start` | ✅ |
| Citations | `<oai-mem-citation>` parser; rollout ids bump `usage_count`/`last_usage` per completed response item | port of `citations.rs`; recorded on `message_end` per assistant message | ✅ |
| Dedicated tools | `memories.list/search/read/add_ad_hoc_note` when `dedicated_tools` | `memories_list/search/read/add_ad_hoc_note`; search: multi-query, any/all_on_line, context lines, cursor paging, 200 cap; note filename `YYYY-MM-DDTHH-MM-SS-<slug>.md`, create-new only | ✅ (default **on**; Codex default off because Codex can grep via shell) |
| Ad-hoc extension | seeds `extensions/ad_hoc/instructions.md`; notes never deleted | same | ✅ |
| Pollution | web search / image gen / MCP output marks thread `polluted` when `disable_on_external_context` | `tool_execution_end` for web/fetch/MCP-prefixed tools marks thread polluted when enabled | ✅ |
| Controls | `[features] memories`, `generate_memories`, `use_memories`, `/memories` thread toggle, reset | `~/.pi/agent/memories.json` (`enabled`, `generate_memories`, `use_memories`, …); `/memories on|off|generate|use|thread|run|force|reset|status` | ✅ |
| Reset | clears memory roots, refuses symlinked root | same + clears DB | ✅ |
| Shutdown | cancels background task | `session_shutdown` aborts; in-flight jobs marked failed → retried by a later startup | ✅ |
| Version experiment / dual_write / V2 | present | not implemented | ❌ |
| Metrics/telemetry | OTel counters | log file only | ➖ |
| Config defaults | max_rollouts_per_startup=2, max_rollout_age_days=10 | 16 / 30 (values in current public docs) — override in `memories.json` | ⚠ documented |

## Known differences that matter

- **Sandbox**: the consolidation agent's boundary is a path jail inside the pi process, not an OS sandbox. It has no shell/network tool, but a pi extension itself runs unsandboxed.
- **Models/cost**: extraction and consolidation call whatever provider `extract_model` / session model resolve to. Codex uses its own backend. Costs and data flow are yours; see README.
- **Thread source**: Codex knows session source/agent role from its DB. pi sub-agent detection relies on `PI_SUBAGENT*` env markers.
- **Extraction input** is rendered from pi's session tree (active branch only), not Codex `ResponseItem` JSON.
- **Skills** generated under the memory root are not loaded as pi skills automatically.

## Validation

`npm test` — 19 tests, temp dirs, no model calls: store lease/claim/cooldown semantics, selection ranking + prune, file stems, git diff/baseline reset, citation parser, tool jail, session rendering, phase1+phase2 end-to-end with a fake model, failure paths.

Live smoke (2026-09-15, isolated home via `PI_CODEX_MEMORY_HOME`, 2 copied sessions, deepseek-v4.1-flash extraction, session model consolidation): phase1 2/2, phase2 `succeeded` in 6 agent turns, produced `MEMORY.md`, `memory_summary.md` (v1), 2 rollout summaries, 2 skills; second session injected the summary and citations bumped usage.
