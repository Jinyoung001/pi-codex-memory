[English](README.md) | **한국어** | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

# pi-codex-memory

[OpenAI Codex](https://github.com/openai/codex/tree/5bf132cd527311eb61bbec46562e3890eb49df80/codex-rs/memories)의 메모리 동작을 이식한 독립 pi 확장입니다. 커밋 `5bf132cd527311eb61bbec46562e3890eb49df80`에 고정되어 있습니다. pi의 세션, 모델 레지스트리, 인증을 그대로 사용하며 Codex 설치나 계정은 필요 없습니다. 호스트 차이점과 검증 내역: [CODEX_PARITY.md](CODEX_PARITY.md).

## 설치

Node >=22.13, pi >=0.85.1, Git이 필요합니다.

배포된 확장을 pi로 설치:

```sh
pi install npm:pi-codex-memory
```

pi를 재시작하거나 기존 세션에서 `/reload`를 실행한 뒤 `/memories status`로 확장 상태를 확인합니다. 기본적으로 현재 pi 세션 모델을 사용하므로 별도 모델 설정은 필요 없습니다.

기존 npm 설치 업데이트:

```sh
pi update npm:pi-codex-memory
```

업데이트 후 pi를 다시 로드하세요. 로컬 개발 시에는 `pi install /path/to/pi-codex-memory`로 체크아웃을 설치합니다. 고정된 Codex 업스트림 소스는 런타임에 자동 갱신되지 않습니다.

## 동작

- 자격을 갖춘 영속 루트 세션이 첫 사용자 턴에서 백그라운드 파이프라인을 디스패치합니다. 임시 세션과 서브에이전트 세션은 제외됩니다.
- 1단계는 최근 유휴 상태의 대화형 세션을 선택해 SQLite 작업을 점유하고, 활성 브랜치를 정제한 뒤 구조화된 추출을 요청하고 검증된 결과를 저장합니다. 리스, 동시성 제한, 재시도 백오프로 중복 작업을 막습니다.
- 2단계는 메모리 버전당 전역 작업 하나를 점유하고, 사용량/최신성 기준으로 증거를 고르고, 롤아웃 요약과 V1 원시 메모리를 동기화하고, 리소스를 정리하고, Git 워크스페이스 diff를 계산합니다. 변경이 없고 아티팩트가 유효하면 통합 모델 호출은 일어나지 않습니다.
- 변경이 있으면 격리된 pi SDK 에이전트 세션이 jail된 파일 도구로 메모리를 통합합니다. 일반 확장, 프로젝트 지침, 셸/네트워크 도구, 재귀 위임은 로드되지 않습니다. SDK 압축과 취소는 같은 pi 모델/인증 경로를 사용합니다. 이는 도구 수준 격리이며 Codex의 OS 샌드박스가 아닙니다.
- 읽기 경로는 업스트림 지침과 제한된 크기의 메모리 요약을 주입합니다. 인용된 롤아웃 ID는 사용 횟수를 갱신합니다. 전용 검색/노트 도구는 선택 사항이며 고정된 계약을 따릅니다.
- V1과 V2는 별도 루트/데이터베이스를 사용합니다. 이중 쓰기는 두 파이프라인을 독립적으로 디스패치합니다. 준비 상태 보고는 V2 임계값과 요약 유효성을 알려줄 뿐 활성 버전을 바꾸지 않습니다.

별도의 효율 프로필, FTS/벡터 인덱스, QMD 모델, 의미 검색, 커스텀 코어 스냅샷, 일일 델타 증류 예산은 없습니다.

## 설정

`~/.pi/agent/memories.json`에 저장됩니다:

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

### 백그라운드 토큰 비용 줄이기

1단계는 롤아웃 전체를 다시 읽는데, 실제 세션에서는 롤아웃의 약 70%가 도구 출력(파일 읽기, 명령 stdout)입니다. 의존성 없는 두 가지 수단이 있습니다:

1. **더 저렴한 모델** — `extract_model` / `consolidation_model` (위 참조). 단연 가장 큰 절감입니다.
2. **`tool_result_token_budget`** (호스트 추가 기능, Codex에는 없음; 기본 `1000`, `0`이면 비활성) — 추출 전에 각 도구 결과를 이 토큰 수로 제한하되 앞/뒤를 유지하고(오류는 3배 허용), 동일한 줄의 반복은 `[… same line ×N]`으로 접고, 동일한 결과가 반복되면 `[identical to tool result #N: <첫 줄>]`로 대체합니다(도구 행은 `[tool name #N]`으로 번호가 붙음). 사용자와 어시스턴트 텍스트는 절대 변경되지 않으므로, 추출기가 큰 파일 덤프 하나 때문에 대화 뒷부분을 잃는 대신 전체 대화를 봅니다.

모델 호출 없이 자신의 세션으로 측정:

```bash
node --experimental-strip-types --no-warnings scripts/bench-compaction.mjs [budget=1000] [maxSessions=40]
```

로컬 머신 예시(세션 5개, 렌더링 745K 토큰, 당시 OpenRouter 표시 가격):

| | 렌더링된 롤아웃 | 1단계 전송(150K 상한) | 1단계 비용 |
|---|---|---|---|
| 세션 모델(`gpt-6-astra` / `claude-fable-5.1`, $10/$50 per M), 원본 | 745K | 321K | $3.58 |
| 같은 모델, budget 1000 | 485K (-35%) | 275K (-14%) | $3.12 |
| `deepseek/deepseek-v4.1-flash` ($0.30/$1.20 per M), 원본 | 745K | 321K | $0.105 |
| flash, budget 1000 | 485K | 275K | **$0.092 (×39 저렴)** |

Budget 500은 오류가 아닌 도구 출력이 짧아지는 대신 렌더링된 롤아웃을 약 47% 줄입니다. 이미 150K 상한을 넘는 세션은 더 저렴해지지 않고, 더 균형 잡힌 입력을 얻을 뿐입니다. 다른 모델과 비교하려면 `BENCH_PRICES='{"name":{"in":..,"out":..}}'`를 설정하세요.

**압축이 절감할 수 있는 것과 없는 것.** 절감은 롤아웃 내 도구 출력 비중에 의해 제한됩니다: `≈ tool_share × (1 − 1/compression)`, 압축 후에도 150K 상한을 넘는 세션은 0입니다. 파일 읽기와 명령 출력이 지배적인 세션(보통 도구 출력 70–90%)은 30–60% 절감하고, 어시스턴트 코드와 붙여넣은 텍스트가 대부분이거나 도구 출력이 이미 실시간으로 압축된 세션(예: `rtk` 방식의 셸 필터)은 거의 절감이 없습니다. 이는 예상된 결과입니다: 실시간 필터는 같은 바이트를 소스에서 한 번 잘라내고, 1단계는 각 롤아웃을 한 번만 읽으므로 이득을 증폭할 턴당 배수가 없습니다.

종단 간 확인(`scripts/bench-pipeline.sh`, 격리된 홈에서 실제 1단계 + 2단계, 동일한 두 세션 점유, `gpt-6-astra`, thinking low): budget 0 → 1단계 223K 토큰, 2단계 42K 입력 / 132K 캐시 / 5.3K 출력; budget 1000 → 1단계 225K, 2단계 31K / 164K / 6.0K. 큰 세션이 도구 출력 10%에 그치고 상한을 넘은 상태라 1단계 절감은 없었습니다. 대신 모델 선택이 지배적이었습니다: 같은 실행을 `deepseek-v4.1-flash`로 하면 약 11배(thinking `max`)에서 30–40배(thinking `low`) 저렴했습니다.

```bash
# 실제 모델 호출, 비용 발생; label extract_model consolidation_model extract_thinking consolidation_thinking budget [세션용 provider/model]
scripts/bench-pipeline.sh G1 null null low low 1000 openai-codex/gpt-6-astra
```

모든 파이프라인 실행은 `memories.log`에 `phase1: … N tokens`와 `phase2: usage requests=… input=… cacheRead=… output=…`를 기록하므로, 일상 사용 후 자신의 수치를 확인할 수 있습니다.

모델은 `provider/model-id` 형식입니다. 기본적으로 두 단계 모두 현재 pi 세션 모델(`null`)을 사용하며, 명시적 설정은 해당 단계만 덮어씁니다. Codex가 선호하는 모델은 자동 선택되지 않습니다. 명시적 설정은 사용 불가하거나 인증되지 않으면 실패하며, 요청 오류가 모델 전환을 유발하지 않습니다. `/memories status`는 마지막으로 선택된 provider/model, `session-default` 또는 `explicit`, 추출 출력 강제 방식을 보여줍니다.

### 메모리 모델 선택

**백그라운드 메모리 추출과 통합에는 저비용 모델을 명시적으로 선택할 것을 권장합니다.** 특히 대화형 세션이 비싼 모델을 쓸 때 그렇습니다. 이 단계들과 SDK 압축은 추가 모델 요청을 발생시킵니다. 요구되는 JSON을 안정적으로 생성하고 통합 파일 도구를 다룰 수 있는 모델을 고르고, 의존하기 전에 결과를 확인하세요.

1. pi에서 제공자를 설정·인증한 뒤, pi 모델 선택기에서 정확한 `provider/model-id`를 복사합니다.
2. `~/.pi/agent/memories.json`(Windows: `%USERPROFILE%\.pi\agent\memories.json`)을 편집해 아래 필드 중 하나 또는 둘 다 설정합니다. 자리표시자를 등록된 모델 ID로 교체하세요. 두 단계가 같은 모델을 써도 됩니다.

```json
{
  "extract_model": "your-provider/your-lower-cost-model-id",
  "consolidation_model": "your-provider/your-lower-cost-model-id"
}
```

3. pi를 다시 로드하고, 다음 메모리 실행 후 `/memories status`로 선택된 모델과 검증 모드를 확인합니다.

해당 단계에 현재 세션 모델을 쓰려면 필드를 `null`로 되돌리세요. 기존 명시적 설정은 업그레이드 시 유지됩니다. 모델 선택은 pi 호스트 적응이며 고정된 Codex 메모리 처리 규칙은 변경되지 않습니다.

검증된 OpenAI Responses 및 Chat Completions 요청은 업스트림의 strict JSON Schema를 실어 보냅니다. 다른 제공자는 로컬 스키마 검증을 사용하며 호환 모드로 보고됩니다. 모든 출력은 로컬에서 검증됩니다. 통합은 정상적인 SDK 어시스턴트 정지와 아티팩트 검증으로 완료되며, 커스텀 완료 도구나 턴 상한은 없습니다. Codex 계정 할당량 API는 구현되어 있지 않습니다.

`generate_memories: false`는 새 세션을 제외하지만, 업스트림과 마찬가지로 이전의 자격 있는 세션은 여전히 처리될 수 있습니다. `use_memories: false`는 요약 주입과 도구 실행을 비활성화합니다. `enabled: false`는 이 프로세스의 파이프라인을 비활성화하고 취소합니다. 버전 및 도구 등록 변경은 다시 로드가 필요합니다.

## 명령과 도구

`/memories [status|readiness [minimum]|run|force|on|off|generate on|off|use on|off|thread on|off|reset]`

`run`은 쿨다운을 존중하고, `force`는 쿨다운/변경 없음에도 실행하는 명시적 pi 재정의입니다. `thread off`는 해당 세션을 제외하고 추출 결과를 제거합니다. Reset은 확인이 필요하며 실행 중인 작업이 있으면 거부됩니다. 원본 pi 세션 파일은 reset으로 삭제되지 않습니다.

`dedicated_tools: true`, `enabled: true`, `use_memories: true`일 때:

| 도구 | 계약 |
|---|---|
| `memories_list` | 보이는 메모리 파일; 기본/최대 2,000개 |
| `memories_search` | 구조화된 매칭, 윈도우, 페이징; 기본/최대 200개 일치 |
| `memories_read` | UTF-8 파일, 줄 오프셋과 제한; 기본 20,000 참조 토큰 |
| `memories_add_ad_hoc_note` | 이후 통합을 위한 명시적 타임스탬프 노트 |

요약 주입은 업스트림의 2,500 토큰 예산을 따릅니다. 검색은 임베딩 모델을 호출하지 않습니다.

## 데이터와 마이그레이션

V1: `~/.pi/agent/memories/`, `memories_1.sqlite`. V2: `memories_v2/`, `memories_2.sqlite`. 아티팩트에는 `memory_summary.md`, 롤아웃 요약, 스킬, 확장, (V1) `MEMORY.md` / `raw_memories.md`가 포함됩니다.

세션 시작 시 폐기된 profile/recall/core/tidy 설정과 `consolidation_max_turns`는 원본 설정을 `memories.json.before-codex-only.bak`(이미 있으면 번호 접미사)으로 백업한 뒤 제거됩니다. 마이그레이션 알림이 한 번 표시됩니다. 제공자 선택과 기타 설정은 그대로 유지됩니다. 레거시 스키마/상태 라벨은 SQLite 스냅샷 백업 `*.before-codex-schema.bak` 후 업그레이드되며, 이전 `failed` 작업은 업스트림 `error` 작업이 됩니다. 기존 실험 테이블은 손대지 않고 사용하지 않습니다. 다운로드된 실험 모델 캐시는 자동 삭제되지 않습니다.

추출은 과거 세션 내용을 설정된 pi 제공자에 보내고, 통합은 선택된 메모리 아티팩트를 같은 제공자 인터페이스로 보냅니다. 민감 정보 제거는 최선 노력 방식입니다. SDK 압축은 추가 제공자 요청을 만들 수 있습니다. 유료 제공자에 대한 실시간 검증은 보장하지 않습니다.

## 검증

`npm run check` · `npm test` · `git diff --check` · `npm pack --dry-run --json --ignore-scripts`

테스트는 임시 상태, 고정된 모델 응답, 실제 pi SDK 세션(65 도구 턴, 취소, 오버플로 압축과 재개), 로컬 HTTP 페이로드 캡처, 동시 프로세스, 설치된 패키지 스모크 테스트를 사용합니다. 업스트림 테스트 벡터 원문이 필터링, 절단, 인용, 자격 판정을 검증합니다. 소스/프롬프트 해시가 테스트를 고정 커밋에 묶습니다. 커버리지와 호스트 제한은 parity 매트릭스를 참고하세요.

격리 재정의: `PI_CODEX_MEMORY_HOME`, `PI_CODEX_MEMORY_SESSIONS`. `PI_CODEX_MEMORY_WAIT_ON_SHUTDOWN=1`은 헤드리스 스모크 실행에서 진행 중인 작업을 완료할 때까지 기다립니다.

## 라이선스

자체 구현은 MIT, 벤더링된 Codex 소스/템플릿은 Apache-2.0입니다. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참고하세요.
