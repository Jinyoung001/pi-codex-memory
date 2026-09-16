# Handoff — 리뷰 수정 중, 아직 배포 금지

작성일: 2026-09-16. Workspace: `C:\myprojects\pi-codex-memory`.

## 가장 먼저 확인할 상태

**현재 작업 트리는 미커밋·미완성이다.** 사용자가 “현재까지 작업을 핸드오프 작성해”라고 요청해 구현을 중단했다. 아래 변경을 보존하고 이어갈 것. 하단의 이전 68/68 통과 기록은 배포 당시 기록이며 현재 변경의 검증 결과가 아니다.

- HEAD `e22f12d` (`docs: document npm installation for pi`), 이전 기능 커밋 `022f212`. 이전 작업에서 둘 다 origin/master에 push 완료.
- 이전 턴에서 npm latest `0.2.1`, SHA1 `e27c0202646b3d8b91f05f29e15ca85a851ac28b` 확인. 이번 핸드오프에서는 registry 재조회하지 않음.
- **이번 리뷰 수정은 commit/push/publish하지 않았다.** package.json은 여전히 0.2.1.
- README 설치는 `pi install npm:pi-codex-memory`, 업데이트는 `pi update npm:pi-codex-memory`로 이미 수정됨.
- 배포물은 34파일/약 85KB. 테스트, DB, 로그, node_modules, .codegraph, HANDOFF, 비교용 Rust 원본 제외.
- 마지막 전체 테스트: **60 passed / 8 failed / 68 total**, 약 38.6초. 이후 수정이 더 있었고 전체 재실행은 안 함.
- 핸드오프 직전 `rtk proxy npm run check`: **exit 0, 통과**.
- 이번 변경의 `git diff --check`는 아직 실행하지 않음.
- 실행 중인 셸/테스트 없음. session 60822(전체 테스트), 63026(소스 읽기) 종료 결과 회수 완료.

## 사용자 결정 / 실행 규칙

- Codex 고정 커밋 `5bf132cd527311eb61bbec46562e3890eb49df80`을 기준으로 pi 독립 이식. QMD/별도 FTS/벡터/효율화 실험을 다시 추가하지 않는다.
- 모델 default는 **현재 pi 세션 모델**. 명시적인 extract_model/consolidation_model 우선, 호출 실패로 자동 모델 변경 금지. README에 저렴한 모델 설정 권장 있음.
- 원본 데이터/기존 DB 보존. 검증 전 동일성·완료 주장 금지. 유료 모델 호출 없음.
- 이전에 commit/push/npm publish까지 승인받았지만 **현재 불완전한 변경을 게시하면 안 된다**. 다음 배포는 새 버전 필요.
- npm 자동 CLI 게시 EOTP 발생 이력. 사용자가 직접 터미널의 browser 인증으로 게시했다. OTP/토큰을 채팅으로 받지 않는다.
- PowerShell 명령은 모두 `rtk` 접두사. unsupported 명령은 `rtk proxy <실행파일>`.
- `rtk proxy Get-Content`는 실패한다. Node fs로 UTF-8 읽기 또는 `rtk proxy powershell -NoProfile -Command ...` 사용.
- caveman full / ponytail 스킬 읽고 적용함. 한국어 간결히 소통. 명시 요청 없는 서브에이전트 금지, 이번에 사용 안 함.
- 개인 memory registry 검색은 관련 결과 없었고 개인 메모리는 수정하지 않았다.

## 리뷰 원문

**두 번째 첨부가 첫 목록 + 추가 런타임 지적 + Project Summary를 포함하는 전체 기준이다.** 문서가 약 1,006줄이라 한 번에 출력하면 잘린다. 범위별 UTF-8 읽기를 사용한다. 이 핸드오프만으로 전체 리뷰가 해결됐다고 판단하지 말 것.

1. `C:\Users\chunm\.codex\attachments\c086d0a9-0b3e-490f-9422-93ad97a9b695\pasted-text.txt`
2. **전체:** `C:\Users\chunm\.codex\attachments\be9daa71-6d76-4a60-ba99-b34c64bbfbd9\pasted-text.txt`

## 적용한 변경 — 아직 검증 완료 아님

### 파일 경계와 저장

- safety.js: `assertTrustedPath`(조상 symlink 검사), `readBounded`(descriptor fstat, hardlink 거부, 기본 8MiB), `withFileLock`(wx 독점, 경합 시 실패) 추가.
- markdownFiles의 exported dir traversal/직접 symlink 검사, memoryPath root 조상 검사. `sk-` credential의 `_`/`-` suffix까지 마스킹.
- codex-truncate: NaN 거부, 제거 구간 문자 수 집계는 전체 배열 생성 대신 UTF-8 leading byte 계수.
- agent-tools: root 조상/hardlink 검사, ENOENT 외 resolve 오류 전파, bounded read 및 line range 사용 시에도 반환량 제한.
- grep: 파일별 8MiB/전체 32MiB 입력 상한. regex는 Node 자식에서 1초 timeout. substring 경로 유지.
- write/edit: `.memory-write.lock` + atomic replacement. root 삭제 및 보호 경로 대소문자 우회 거부.
- storage: cleanup root 검사, extension/resources jail 검사. summary 본문 사전 계산, replacement 쓰기 후 obsolete 삭제. stem 충돌에 thread SHA256 suffix, raw_memories도 같은 map 참조. artifact fatal UTF-8 decode.
- **pathname 검사는 적대적인 로컬 프로세스의 동시 바꿔치기를 완전히 차단하지 못한다.** OS sandbox 동등성 주장 금지. trusted root/ancestor 전제를 README/CODEX_PARITY에 아직 반영해야 함(코드 주석 일부만 반영).

### Git workspace — 즉시 수정할 회귀 있음

- 매 실행마다 상속 `GIT_*` 제거, explicit git-dir/work-tree 지정.
- `.git` indirection/symlink/hardlink, alternates/commondir 거부. local config allowlist 및 owned marker 추가.
- legacy baseline은 단일 commit의 author/email/message 조건 확인 후 marker 기록.
- `.git-next`에 init/add/commit 성공 후 기존 `.git`을 `.git-previous`로 옮겨 swap. 생성 실패 시 이전 baseline 유지.
- force-add로 ignore 우회, `.git*`, `.memory-*`, workspace diff 제외. porcelain `-z` 처리, rename/copy 상태에만 추가 record 소비.
- diff는 Node helper가 Git stdout을 drain하며 4MiB만 보관, diffTruncated로 artifact 표시.
- **현재 회귀:** 새 Git init이 `core.worktree=<root>`를 기록하는데 allowlist가 이를 거부한다. 정상 phase2가 `failed_workspace_status: untrusted local Git configuration`으로 실패한다. `core.worktree`를 정확한 현재 root일 때만 허용하거나 새 repo에서 안전하게 제거할 것. 무조건 허용하면 원래 취약점이 재발한다.
- 재현용 임시 디렉터리 남아 있음: `C:\Users\chunm\AppData\Local\Temp\pcm-git-debug-gEErjG`. config의 core 항목: repositoryformatversion=0, filemode=false, bare=false, logallrefupdates=true, worktree=해당 root, symlinks=false, ignorecase=true.
- 추가 점검: interrupted swap 복구, legacy ownership 증명, `.git*`가 일반 메모리 파일까지 숨기는지, diff helper timeout 때 Git 자식까지 종료되는지. 전용 회귀 테스트 아직 없음.

### 설정 / 상태 / evidence

- config: load/save 공유 validator, JSON object 검사, save/migrate/init config lock, create-if-absent 초기화. stale lock 복구 정책/문서와 경합 테스트 필요.
- store: stage1 claim transaction 내부에서 thread 존재/모드/source/archive/시간 재검증, 최신 row 반영. stage1 heartbeat 및 retry 소모 없는 release 추가.
- phase1: parse unknown, 실패 로그 redact/null rejection 방어, logger/실패 저장 예외 격리, workers allSettled. pending claims를 90초마다 갱신, 실행 전/응답 후 ownership 확인. provider signal 55분 timeout. 미실행 취소는 release + released 통계.
- phase2: 사전 취소면 claim 안 함, guarded 취소 검사, mutating diff도 guarded로 실행, agent 후 취소 검사, outer error boundary 및 best-effort 실패 저장.
- index: openStore를 버전별 try 내부로 이동, dual-write allSettled. 오염 기록을 root 부모 `memory-polluted-threads/<sha256(sessionId)>.json`에 먼저 저장, store별 실패 격리, pipeline에서 journal 재적용.
- **오염 journal 미검증:** explicit thread on/reset 의미, journal 저장 실패 후 재시작, 다른 프로세스 진행 중 추출, journal 검증/복구 정책을 점검해야 함.
- rollout: null/nonobject JSONL 무시, null content part 방어. V1도 harness/other-agent attribution 유지.
- read-path: 빈 citation path/0 기반/역순 range 거부. **note의 명시적 승인 강제는 아직 미구현**.
- v2: byte constants 명명, priority if/return, 실제 omitted runs 기준 marker 계산, 작은 완전한 row 우선, unknown validator.

### 검색 / SDK

- backend: bounded decoder, pagination 선검증, page+lookahead content만 생성, minimal-window suppression reverse pass로 선형화.
- search 상한: entries 10,000, scanned 32MiB, 파일 8MiB, query 100개, query당 10,000 chars, window/context 1,000 lines.
- **남은 비용:** flags/windows 전체 생성, 큰 window 연산, 반복 context 생성에 추가 work/response 상한 필요 여부 확인. 새 상한의 계약 차이 문서화 필요.
- llm: SDK registry Parameters/ReturnType로 모델/context/options/message 연결, payload unknown narrowing.
- consolidation-session: SDK ToolDefinition/event/message 타입, concrete ModelRuntime private fields 때문에 필요한 adapter cast에 근거 주석.
- progress observer 예외 격리, abort listener rejection 처리, abort 실패해도 dispose.
- 중간 TS2783 duplicate spread 오류는 Object.assign/default 순서 변경으로 해결. 최신 typecheck 통과.
- agent-tools/read-path/store/rollout/index tool wrapper의 any 및 일부 느슨한 비교는 아직 남음. 원문 low 항목 미완료.

## 테스트 현황과 다음 순서

현재 변경한 테스트는 **test/safety.test.mjs, test/package.test.mjs뿐**이다.

- safety: 실제 state.json, validation error, exported dir traversal/symlink, credential suffix exact redaction.
- package: smoke child cwd를 실제 temp installation으로 변경.
- 중간 전체 test 60/68 통과. 로그 출력이 잘려 8실패의 세부를 모두 보존하지 못함.
- 확인된 실패: hardening expected `/symlink/` vs 실제 `symbolic link`(이후 `symlink (symbolic link)`로 메시지 수정, 재검증 필요); lifecycle calls 0 vs 2; ownership; V2 E2E의 Git local config rejection.
- Git 회귀가 여러 실패 원인으로 보이나 모든 실패가 같은 원인이라고 단정하지 말 것.
- 중간 SDK 65-turn/cancellation/compaction은 통과했지만 이후 코드 변경이 있어 다시 검증해야 함.

다음 순서:

1. 현재 diff와 전체 원문 검토. core.worktree 회귀부터 해결하고 pipeline/ownership/V2 정상 경로 복구.
2. 새로운 런타임 경로에 재현 테스트: 외부 삭제, Git 환경/config/filter/redirection, baseline 실패 보존, 대형 diff, 취소/queued release, claim 재검증.
3. 아래 미처리 테스트 요구를 전체 원문과 대조해 반영.
4. README/CODEX_PARITY: 보안 전제, 상한, 잠금, journal 및 승인 동작 차이 갱신.
5. typecheck, 전체 tests(실제 설치 smoke 포함), diff --check. 필요한 재검증 후에만 commit/release.

### 미처리 테스트 요구 목록

- ownership: 정확한 ownership-loss 실패, write tool call 전달 기록, setup 성공을 catch 밖에서 검증.
- model-contract: session/explicit 모델 객체 identity와 원래 오류/1회 호출, HTTP fixture catch/종료/timeout.
- codex-only: manifest와 독립된 audited filename 전체 집합, messages까지 ambient canary, 실제 in-flight stream abort 및 iterator/result settlement.
- config: 두 migration을 한 test로, 이전 backup 불변/새 backup 구분, raw JSON exact 제거 keys/no-op 불변, provider routing exact, null resolve 실제 호출, invalid save/경합.
- hardening/read-tools: Unicode 원문 head/tail/marker count/roundtrip, 80,000byte default 경계, exact claims/success 반환/enqueue watermark.
- processes: 초기화 후 stage1/phase2 각각 barrier 동시 출발, 여러 fresh round, child deadline/kill/close await, signal 종료 실패, 정확한 claimed/skipped_running 조합.
- source: acquisition 직후 cleanup. cycle은 killable child/worker + 부모 timeout으로 검증.
- pipeline: active-chain developer sentinel, 실제 lease 만료/reclaim과 stale token fencing, retry_at 이후 재시도, partial write 후 실패에서 baseline hash/diff 보존.
- 원문의 iteration-budget exhaustion은 사용자 결정으로 삭제한 60턴 상한과 충돌. cap 복원 금지. 대신 지속 작업의 취소를 검증하고 적용 불가 이유 기록.
- lifecycle: 각 test 설정 독립, finally shutdown, 실제 V1/V2 reload 후 exclusion 유지, 호출 순서 대신 request로 version 구분, V1 raw/MEMORY positive control.
- retry: 모든 transition boolean, 새 evidence 이후 동일 evidence로 3회 retry 가능, spare capacity에서 active lease, backoff 시간 경과.
- reset: thread/output/progress seed, refusal 불변, filesystem 실패 rollback/lock 해제, peer note가 reset 중 거절되고 이후 성공.
- SDK: provider abort/settlement 증명, retained tool pairs 순서/중복/완료, guard 단계별 fault injection, error-valued compaction response, observer/cleanup 실패.
- upstream fixtures: 8,900byte 경계 내부 각 UTF-8 절단, current/age 독립 exclusion.
- V2: 실제 prune>0 후 readiness count 유지, 큰 tool 앞/human 뒤, redaction exact, 작은 예산/연속 row.

## 작업 파일

핸드오프 전 diff: 18파일, 약 +398/-146. index.ts, safety.js, src/{agent-tools,codex-truncate,config,consolidation-session,llm,memory-backend,phase1,phase2,read-path,rollout,storage,store,v2,workspace}.ts, test/{package,safety}.test.mjs. 이 HANDOFF.md가 추가 변경됨.

---

## 이전 릴리스 기록 — 아래 검증은 현재 미커밋 변경 이전의 결과

The user replaced the efficiency experiment with a faithful standalone pi port of OpenAI Codex memory. Pinned commit: 5bf132cd527311eb61bbec46562e3890eb49df80. See README.md and CODEX_PARITY.md for behavior, migration, test coverage and explicit host differences.

Removed the efficient/QMD/FTS/core/delta-tidy path and experimental dependencies. Existing data is preserved; retired config is backed up and migrated on session start. Schema upgrades back up SQLite; legacy failed statuses become error. Consolidation now runs in an isolated pi SDK session through the existing pi registry, with automatic compaction and cancellation, only jailed tools and no ambient extensions/context. Dual-write pipelines dispatch concurrently.

Changes include earlier authorized Codex fixes and the Codex-only port. The user authorized committing, pushing and publishing version 0.2.0; check Git and the npm registry for release status. No personal memory migration has been performed. Development validation uses temporary roots and fixed provider replies. Real provider parity and Codex account/remote services are not claimed.

Remaining-behavior pass: current pi session model by default with explicit per-stage overrides (user-approved host adaptation); strict Responses/Completions JSON Schema via onPayload; local validation on every route; runtime model/output status; no custom done or 60-turn cap. Actual SDK tests cover 65 tool turns, cancellation and real overflow compaction/resume. Normalized evidence keeps pi branch/source/phase metadata without guessing commentary from toolUse. Truncation now uses pinned Codex markers/retained-byte rules for extraction and summary prompts. Removed turn-cap configuration receives a fresh numbered backup when needed. See CODEX_PARITY.md for classifications and source-derived fixtures.

2026-09-16 validation: `npm run check` passed; final `npm test` passed 68/68 (including actual offline npm installation, Jiti-loaded package and SDK run); `git diff --check` passed. HTTP schema checks used localhost, SDK tests used fixed replies, no paid inference. Suite concurrency is 2 to avoid SDK startup contention; package subprocess timeout is 180 seconds. Earlier failed runs were corrected and superseded by the all-green run.
