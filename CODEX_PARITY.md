# Codex memory parity: pinned implementation and host boundaries

Source: [openai/codex @ 5bf132cd527311eb61bbec46562e3890eb49df80](https://github.com/openai/codex/tree/5bf132cd527311eb61bbec46562e3890eb49df80), 2026-09-16. Actual source and tests take precedence over stale README paths. `vendor/codex/reference.json` records upstream paths and hashes. No claim of byte-identical model output or complete Codex runtime equivalence.

## Source → implementation → verification

All upstream paths below are relative to `codex-rs/` at the pinned commit.

| Behavior | Upstream source | pi implementation | Verification |
|---|---|---|---|
| Defaults, version and feature controls | config/src/types.rs; memories/write/src/start.rs | config.ts; index.ts | config.test; lifecycle.test; v2.test |
| Startup eligibility and parallel dual-write | memories/write/src/start.rs | index.ts; rollout.ts | lifecycle.test; source.test |
| Job claims, leases, retries and source advancement | state/src/runtime/memories.rs | store.ts | pipeline.test; processes.test; retry.test; ownership.test |
| Input filtering, budgets, redaction and schema validation | memories/write/src/rollout_input.rs; phase1_output.rs; phase1.rs | rollout.ts; phase1.ts; safety.js; v2.ts | source.test; safety.test; hardening.test; pipeline.test; v2.test |
| Model selection and extraction | memories/write/src/runtime.rs; phase1.rs; phase1_output.rs | llm.ts; phase1.ts | model-contract.test (actual HTTP payload, both APIs/versions); config.test; pipeline.test |
| Usage-ranked selection, snapshot commit and watermarks | state/src/runtime/memories.rs; memories/write/src/phase2.rs | store.ts; phase2.ts | pipeline.test; ownership.test; hardening.test |
| Artifact sync, pruning, Git diff and baseline replacement | memories/write/src/storage.rs; workspace.rs; extensions/ | storage.ts; workspace.ts | pipeline.test; v2.test; reset.test |
| No-change skips and artifact validation | memories/write/src/phase2.rs | phase2.ts | pipeline.test; v2.test |
| Consolidation session, completion, heartbeat and cancellation | memories/write/src/runtime.rs; phase2.rs | consolidation-session.ts; phase2.ts | sdk-lifecycle.test (65 tool turns, cancel, real overflow compaction/resume); pipeline.test; ownership.test |
| Summary/read instructions and citations | ext/memories/src/prompts.rs; memories/read/src/citations.rs | read-path.ts; index.ts | pipeline.test; safety.test; read-tools.test |
| List/read/search/note contracts | ext/memories/src/local/; tools/; schema.rs | memory-backend.ts; read-path.ts | read-tools.test; safety.test; hardening.test |
| V2 readiness and independent storage | state/src/runtime/memory_readiness.rs; app-server/src/request_processors/memory_status.rs | storage.ts; store.ts; index.ts | v2.test; lifecycle.test |
| Existing-data upgrade, reset and removed experiments | Local compatibility layer | config.ts; store.ts | config.test; source.test; reset.test; codex-only.test |
| Pinned prompts/sources and distributable package | reference.json; upstream templates | prompts/; package.json | safety.test; codex-only.test; package.test |

Test filenames are under `test/`, implementation files under `src/` unless shown otherwise. Fixtures port representative upstream contracts; this is not an exhaustive Rust-versus-TypeScript differential suite.

## Deliberate host adaptations

- Pi JSONL branches replace Codex ResponseItems. IDs, parent IDs, active branch, role, source and phase are normalized before rendering. Missing source is `unknown`; missing phase stays null and follows upstream's non-commentary priority, never inferred from `toolUse`. Explicit metadata and request_user_input question/answer links determine available tiers. Native pi text serialization remains a verified host adaptation; missing historical metadata cannot be reconstructed.
- The first pi user-turn hook dispatches startup on the next event-loop turn. Shutdown/replacement cancels this process's work. Dual-write uses concurrent per-version pipelines, separate databases and shared cancellation.
- By user choice, explicit models take precedence over the current pi session model; upstream preferred IDs are not selected automatically. A request failure never changes models. The selected model/reason and output mode are persisted in local status. OpenAI Responses and Completions strict schema payloads are tested at the HTTP boundary. Other providers use explicitly reported compatible local validation; all routes validate output locally.
- Consolidation uses a fresh in-memory pi SDK session with actual automatic compaction. The registry adapter delivers terminal stream events and the result interface used by compaction through existing provider authentication. No ambient extensions, skills or context files load. Jailed file operations are the only tools; this is not OS sandbox enforcement. Normal assistant stop and artifact validation determine success. No `done` tool, fabricated response or turn cap remains. Compaction errors/cancellation and lost ownership fail the job.
- Read policy is appended to pi's system prompt because there is no equivalent developer-policy-fragment API. Upstream templates themselves remain checksum-pinned. Tool names flatten the Codex namespace into `memories_*`.
- Database records use pi session identifiers and local schema; they are not interchangeable with a Codex database. Failure status now matches upstream `error`; migration backs up existing state. Reset uses two database transactions and guarded file operations, not crash-atomic cross-database/filesystem rollback.
- Codex account quota polling, its remote memory service and telemetry exporter are unsupported and are not simulated. Local status reports pipeline state. Generated skills remain readable artifacts; automatic insertion into the parent pi skill loader is not implemented.
- The explicit pi `force` command bypasses cooldown/no-change; normal startup does not. Additional credential redaction and path/junction checks remain defensive differences.

## Removed product branches

Only the Codex path remains. Efficient profile, FTS/vector recall, QMD, core snapshots, incremental tidy quotas, custom recall/evidence tools and their benchmark/dependencies were removed. Legacy settings are backed up and retired once; historical files/databases and unused experimental tables are preserved.

## Verification limits

Automated tests exercise fixed provider responses and real SDK orchestration without paid calls or personal memory data. Source hashes, successful tests and packaging do not establish identical probabilistic outputs. SDK overflow recovery is exercised with enough tool history to produce a real checkpoint, then resume; assertions cover tool pairs, instructions, file effects and per-request ownership guards.

| Classification | Scope and evidence |
|---|---|
| Upstream match | Strict output schemas, local V1/V2 validation, byte/token truncation markers, filter/chunk vectors, eligibility and citation vectors; `model-contract.test`, `upstream-fixtures.test`, `safety.test`, `pipeline.test` |
| Verified compatible behavior | Pi registry/auth and approved session-model default, other-provider post-validation, normalized pi evidence rendering, SDK compaction/completion and jailed file tools, system-prompt read policy; `sdk-lifecycle.test`, `source.test`, `config.test`, `read-tools.test`, `package.test` |
| Unsupported | Codex account-only quota/remote/telemetry services, Codex OS sandbox, historical metadata never recorded by pi |
| Unverified | Paid live-model output comparisons and arbitrary provider-specific overflow/schema behavior. Not part of the automated acceptance claim. |

Literal upstream vectors are transcribed from `rollout_input_tests.rs`, `string_truncate_tests.rs`, `citations_tests.rs`, `ext_tests.rs` (read and multiple/windowed search), and `state_memories.rs::claim_stage1_jobs_filters_by_age_idle_and_current_thread` (CLI origin mapped to pi interactive). Their expected values come from Rust source, not from this TypeScript port. Existing state/lease/no-change/read tests cover additional source contracts; they are not an exhaustive execution of the Rust suite.
