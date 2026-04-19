# <a href="#chapter-20c-ultraplan----remote-multi-agent-planning"
class="header">20c장: 울트라플랜 - 원격 다중 에이전트 계획</a>

### <a href="#why-ultraplan-is-needed" class="header">울트라플랜이 필요한 이유</a>

이 장의 앞부분에서 설명한 다중 에이전트 오케스트레이션은 모두 **로컬**입니다. 즉, 에이전트는 사용자 터미널에서 실행되고 터미널 I/O를 점유하며 컨텍스트 창을 사용자와 공유합니다. Ultraplan은 다른 문제를 해결합니다. **계획 단계를 원격으로 오프로드**하여 사용자 터미널의 가용성을 유지합니다.

<div class="table-wrapper">

| 차원 | 로컬 계획 모드 | 울트라플랜 |
|----|----|----|
| 실행 위치 | 로컬 터미널 | CCR(웹상의 Claude Code) 원격 컨테이너 |
| 모델 | 현재 세션 모델 | 강제 Opus 4.6(GrowthBook `tengu_ultraplan_model` 구성) |
| 탐색 방법 | 단일 에이전트 순차 탐색 | 선택적 다중 에이전트 병렬 탐색(프롬프트 변형에 따라 다름) |
| 시간 초과 | 하드 타임아웃 없음 | 30분(GrowthBook `tengu_ultraplan_timeout_seconds`, 기본값 1800) |
| 사용자 단말기 | 막힌 | 사용 가능한 상태를 유지하며 사용자는 다른 작업을 계속할 수 있습니다. |
| 결과 전달 | 세션에서 직접 실행 | "원격으로 실행하고 PR 생성"또는 "실행을 위해 로컬 터미널로 다시 순간 이동" |
| 승인 | 터미널 대화상자 | 브라우저 계획 모달 |

</div>

### <a href="#architecture-overview" class="header">아키텍처 개요</a>

Ultraplan은 5개의 핵심 모듈로 구성됩니다.

┌───────────────────────────────────────────────────────────┐ │ 사용자 터미널(로컬) │ │ │ │ PromptInput.tsx processUserInput.ts │ │ ┌─────────────┐ ┌──────────────────┐ │ │ │ 키워드 │─→ Rainbow │ "ultraplan" │ │ │ │ 감지 │ 하이라이트 │ 교체 │ │ │ + 토스트 │ │ │ → /ultraplan cmd │ │ │ └─────────────┘ └────────┬─────────┘ │ │ ↓ │ │ 명령/ultraplan.tsx ──────────────────────── │ │ ┌───────────────────────────────────────────┐ │ │ │ launchUltraplan() │ │ │ ├─ checkRemoteAgentEligibility() │ │ │ │ ├─ buildUltraplanPrompt(blurb, Seed, id) │ │ │ │ ├─ teleportToRemote() ──→ CCR 세션 │ │ │ │ ├─registerRemoteAgentTask() │ │ │ │ └─ startDetachedPoll() ──→ 백그라운드 폴 │ │ │ └──────────────────────────┬────────────────┘ │ │ ↓ │ │ utils/ultraplan/ccrSession.ts │ │ ┌───────────────────────────────────────────┐ │ │ │ pollForApprovedExitPlanMode() │ │ │ │ ├─ 3초마다 원격 세션 이벤트 폴링 │ │ │ │ ├─ ExitPlanModeScanner.ingest() 상태 machine│ │ │ │ └─ 위상 감지: 실행 중 → need_input → 준비됨│ │ └─────────────────────────┬────────────────┘ │ │ ↓ │ │ 작업 시스템 알약 표시 │ │ ◇ ultraplan (실행 중) │ │ ◇ ultraplan 귀하의 입력이 필요합니다(원격 유휴) │ │ ◆ ultraplan 준비(계획 준비) │ └────────────────────────────────────────────────────────┘ ↕ HTTP 폴링 ┌───────────────────────────────────────────────────────────────────┐ │ CCR 원격 컨테이너 │ │ │ │ Opus 4.6 + 계획 모드 권한 │ │ ├─ 코드베이스 탐색(Glob/Grep/Read) │ │ ├─ 선택 사항: 작업 도구가 병렬 하위 에이전트 생성 │ │ ├─ ExitPlanMode를 호출하여 계획 제출 │ │ └─ 사용자 승인 대기(승인/거부/로컬로 순간 이동)│ └───────────────────────────────────────────────────────────┘

### <a href="#what-ccr-is----the-meaning-of-working-remotely"
class="header">CCR이란? - "원격 근무"의 의미</a>

아키텍처 다이어그램의 "CCR Remote Container"는 **Claude Code Remote**(웹상의 Claude Code)를 나타내며, 본질적으로 Anthropic 서버에서 실행되는 완전한 Claude Code 인스턴스입니다.

귀하의 터미널(로컬 CLI 클라이언트) 인류 클라우드(CCR 컨테이너) ┌─────────────────────┐ ┌─────────────────────────┐ │ 오직 책임: │ │ 실행: │ │ · 번들 및 업로드 │──HTTP──→ │ · Claude 코드 완료 │ │ 코드베이스 │ │ 인스턴스 │ │ · 작업 표시 Pill │ │ · Opus 4.6 모델(강제) │ │ · 3초마다 상태 폴링│←─poll── │ · 코드베이스 복사본 │ │ · 최종 계획 수신 │ │ (번들) │ │ │ │ · Glob/Grep/Read 등 도구 │ │ 계속할 수 있음 │ │ · 선택 사항: 여러 │ │ 다른 작업 │ │ 하위 에이전트 병렬 │ │ │ │ · 계획 모드 권한 │ │ │ │ (읽기 전용) │ └────────────────────┘ └─────────────────────────┘

CCR 컨테이너는 `teleportToRemote()`를 통해 생성됩니다. 실행 시 코드베이스가 번들로 제공되어 업로드되며 원격 측에서는 전체 코드 액세스 권한을 얻습니다. 원격 에이전트 루프는 Claude Code를 로컬에서 사용할 때와 정확히 동일하게 Claude API에 요청을 보냅니다. 차이점은 Opus 4.6 모델을 사용하고 Anthropic의 인프라에서 실행되며 터미널을 차지하지 않는다는 것입니다.

### <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

**트리거 방법**:

1. **키워드 트리거** -- 프롬프트에 자연스럽게 "ultraplan"이라고 씁니다.

Ultraplan은 OAuth2 및 API 키 방법을 모두 지원하도록 인증 모듈을 리팩터링합니다.

2. **슬래시 명령** -- `/ultraplan <description>`를 명시적으로 호출합니다.

**전제조건**(`checkRemoteAgentEligibility()` 확인):

- OAuth를 통해 Claude Code에 로그인했습니다.
- 구독 수준은 원격 에이전트(Pro/Max/Team/Enterprise)를 지원합니다.
- 계정에 기능 플래그 `ULTRAPLAN`가 활성화되었습니다(GrowthBook 서버 측 제어).

**사용 가능 여부 확인**: "ultraplan"이 포함된 텍스트를 입력한 후 키워드가 무지개색으로 강조 표시되고 "이 프롬프트는 웹의 Claude Code에서 ultraplan 세션을 시작합니다."라는 토스트 알림이 나타나면 기능이 활성화된 것입니다. 반응이 없다는 것은 귀하의 계정에 대해 기능 플래그가 활성화되지 않았음을 의미합니다.

**사용 흐름**:

    1. "ultraplan"이 포함된 프롬프트를 입력하세요.
    2. 실행 대화상자 확인
    3. 터미널에 CCR URL이 표시되면 다른 작업을 계속할 수 있습니다.
    4. 작업 표시줄 Pill에 진행 상황이 표시됩니다. ◇ ultraplan → 원격 탐색 코드베이스 ◇ ultraplan에 입력 필요 → 브라우저에서 실행 필요 ◆ ultraplan 준비 → 계획 준비, 승인 대기 중
    5. 브라우저에서 계획을 승인합니다. 승인 → 원격으로 실행 및 Pull Request 생성 b. Reject + 피드백 → 피드백을 바탕으로 원격 수정 후 재제출 c. 로컬로 텔레포트 → 실행을 위해 계획이 터미널로 반환됩니다.
    6. 도중에 중지하려면 작업 시스템을 통해 취소하세요.

**소스 코드 위치**:

<div class="table-wrapper">

| 파일 | 윤곽 | 책임 |
|----|----|----|
| `commands/ultraplan.tsx` | 470 | 주요 명령: 시작, 폴링, 중지, 오류 처리 |
| `utils/ultraplan/ccrSession.ts` | 350 | 폴링 상태 머신, ExitPlanModeScanner, 위상 감지 |
| `utils/ultraplan/keyword.ts` | 128 | 키워드 감지: 트리거 규칙, 컨텍스트 제외 |
| `state/AppStateStore.ts` | -- | 상태 필드: `ultraplanSessionUrl`, `ultraplanPendingChoice` 등 |
| `tasks/RemoteAgentTask/` | -- | 원격 작업 등록 및 수명주기 관리 |
| `components/PromptInput/PromptInput.tsx` | -- | 키워드 레인보우 하이라이트 + 토스트 |

</div>

### <a href="#keyword-trigger-system" class="header">키워드 트리거 시스템</a>

사용자는 `/ultraplan`를 입력할 필요가 없습니다. 프롬프트에 자연스럽게 "ultraplan"을 쓰기만 하면 트리거됩니다.

``` typescript
// restored-src/src/utils/ultraplan/keyword.ts
export function findUltraplanTriggerPositions(text: string): TriggerPosition[]
export function hasUltraplanKeyword(text: string): boolean
export function replaceUltraplanKeyword(text: string): string
```

**제외 규칙** -- 다음 컨텍스트의 "ultraplan"은 트리거되지 않습니다.

<div class="table-wrapper">

| 문맥 | 예 | 이유 |
|----|----|----|
| 따옴표/백틱 내부 | `` `ultraplan` `` | 코드 참조 |
| 경로에서 | `src/ultraplan/foo.ts` | 파일 경로 |
| 식별자에서 | `--ultraplan-mode` | CLI 인수 |
| 파일 확장자 이전 | `ultraplan.tsx` | 파일 이름 |
| 물음표 뒤 | `ultraplan?` | 트리거하지 않고 기능에 대해 묻기 |
| `/`로 시작 | `/ultraplan` | 슬래시 명령 경로를 통과합니다. |

</div>

트리거된 후 `processUserInput.ts`는 키워드를 `/ultraplan {rewritten prompt}`로 바꾸고 명령 처리기로 경로를 지정합니다.

### <a href="#state-machine-lifecycle-management" class="header">상태 머신: 수명 주기 관리</a>

Ultraplan은 5개의 AppState 필드를 사용하여 라이프사이클을 관리합니다.

``` typescript
// restored-src/src/state/AppStateStore.ts
ultraplanLaunching?: boolean         // Launching (prevents duplicate launches, ~5s window)
ultraplanSessionUrl?: string         // Active session URL (disables keyword trigger when present)
ultraplanPendingChoice?: {           // Approved plan awaiting user's execution location choice
  plan: string
  sessionId: string
  taskId: string
}
ultraplanLaunchPending?: {           // Pre-launch confirmation dialog state
  blurb: string
}
isUltraplanMode?: boolean            // Remote-side flag (set via set_permission_mode)
```

**상태 전이 다이어그램**:

``` mermaid
stateDiagram-v2
    [*] --> IDLE
    IDLE --> LAUNCHING: User enters "ultraplan" keyword
    LAUNCHING --> RUNNING: teleportToRemote() succeeds<br/>sets ultraplanSessionUrl
    LAUNCHING --> IDLE: Launch failed<br/>(auth/eligibility/network)

    RUNNING --> RUNNING: phase=running (remote working)
    RUNNING --> NEEDS_INPUT: phase=needs_input (remote idle)
    RUNNING --> PLAN_READY: phase=plan_ready (ExitPlanMode called)
    NEEDS_INPUT --> RUNNING: Remote resumes work
    NEEDS_INPUT --> PLAN_READY: ExitPlanMode called

    PLAN_READY --> REMOTE_EXEC: User approves in browser → remote execution
    PLAN_READY --> PENDING_CHOICE: User rejects + TELEPORT_SENTINEL
    PLAN_READY --> RUNNING: User rejects + feedback → remote revises plan

    REMOTE_EXEC --> IDLE: Task complete, URL cleared
    PENDING_CHOICE --> IDLE: User chooses "execute locally"
    PENDING_CHOICE --> RUNNING: User chooses "continue remote"

    RUNNING --> IDLE: Timeout(30min) / Network failure(5x) / User stops
```

### <a href="#polling-and-phase-detection" class="header">폴링 및 위상 감지</a>

`startDetachedPoll()`는 터미널을 차단하지 않고 백그라운드 비동기 IIFE로 실행됩니다.

``` typescript
// restored-src/src/utils/ultraplan/ccrSession.ts

const POLL_INTERVAL_MS = 3000             // Poll every 3 seconds
const MAX_CONSECUTIVE_FAILURES = 5        // Give up after 5 consecutive network errors
const ULTRAPLAN_TIMEOUT_MS = 30 * 60 * 1000  // 30-minute timeout
```

**ExitPlanModeScanner**는 원격 세션 이벤트 스트림에서 신호를 추출하는 순수 상태 비저장 이벤트 프로세서입니다.

``` typescript
// Scan result types
type ScanResult =
  | { kind: 'approved'; plan: string }    // User approved (remote execution)
  | { kind: 'teleport'; plan: string }    // User rejected + teleport marker (local execution)
  | { kind: 'rejected'; id: string }      // Normal rejection (revise and resubmit)
  | { kind: 'pending' }                   // ExitPlanMode called, awaiting approval
  | { kind: 'terminated'; subtype: string } // Session terminated
  | { kind: 'unchanged' }                 // No new signals
```

**위상 감지 로직**:

``` typescript
// Determine current phase of remote session
const quietIdle =
  (sessionStatus === 'idle' || sessionStatus === 'requires_action') &&
  newEvents.length === 0

const phase: UltraplanPhase = scanner.hasPendingPlan
  ? 'plan_ready'      // ExitPlanMode called, awaiting browser approval
  : quietIdle
    ? 'needs_input'    // Remote idle, may need user input
    : 'running'        // Working normally
```

### <a href="#growthbook-driven-prompt-variants-new-in-v2191"
class="header">GrowthBook 기반 프롬프트 변형(v2.1.91의 새로운 기능)</a>

v2.1.91에는 **GrowthBook 제어 프롬프트 변형 시스템**을 노출하는 `tengu_ultraplan_prompt_identifier` 이벤트가 도입되었습니다. 번들에서 최소 3개의 프롬프트 변형이 추출되었습니다.

**변형 1: `simple_plan`(기본값)** -- 경량 단일 에이전트 계획

원격 계획 세션을 실행 중입니다. 일반 계획 모드에서와 마찬가지로 경량 계획 프로세스를 실행합니다. - Glob, Grep 및 Read를 사용하여 코드베이스를 직접 탐색합니다. - 하위 에이전트를 생성하지 마십시오. 접근 방식을 결정했으면 계획과 함께 ExitPlanMode를 호출하세요.

**변형 2: 다중 에이전트 탐색** -- 작업 도구를 사용하여 병렬 하위 에이전트 생성

다중 에이전트 탐색을 사용하여 매우 철저한 구현 계획을 생성합니다. 지침: 1. 작업 도구를 사용하여 병렬 에이전트를 생성하여 코드베이스의 다양한 측면을 동시에 탐색합니다. - 관련 기존 코드 및 아키텍처를 이해하는 에이전트 하나 - 수정이 필요한 모든 파일을 찾는 에이전트 하나 - 잠재적인 위험, 극단적인 사례 및 종속성을 식별하는 에이전트 하나 2. 결과를 상세한 단계별 계획으로 종합합니다. 3. 작업 도구를 사용하여 계획을 검토할 비평 에이전트를 생성합니다. 4. 비평 피드백을 통합한 다음 ExitPlanMode를 호출합니다.

**변형 전환 메커니즘**:

``` typescript
// v2.1.91 bundle reverse engineering
function getPromptIdentifier(): string {
  // Read from GrowthBook, default "simple_plan"
  let id = getFeatureValue('tengu_ultraplan_prompt_identifier', 'simple_plan')
  return isValidId(id) ? id : 'simple_plan'
}

function getTimeout(): number {
  // Read from GrowthBook, default 1800 seconds (30 minutes)
  return getFeatureValue('tengu_ultraplan_timeout_seconds', 1800) * 1000
}
```

이는 Anthropic이 새로운 릴리스를 출시하지 않고도 GrowthBook을 통해 다양한 계획 전략을 A/B 테스트할 수 있음을 의미합니다. `tengu_ultraplan_config` 이벤트는 각 실행 시 사용된 특정 구성 조합을 기록합니다.

### <a href="#plan-teleport-protocol" class="header">텔레포트 프로토콜 계획</a>

사용자가 브라우저에서 계획을 거부했지만 "로컬 터미널로 다시 순간 이동"을 선택하면 브라우저는 피드백에 감시 문자열을 삽입합니다.

``` typescript
const ULTRAPLAN_TELEPORT_SENTINEL = '__ULTRAPLAN_TELEPORT_LOCAL__'
```

원격 측 프롬프트는 모델에 이 센티널을 인식하도록 명시적으로 지시합니다.

> 피드백에 `__ULTRAPLAN_TELEPORT_LOCAL__`가 포함되어 있으면 구현하지 마십시오. 계획이 사용자의 로컬 터미널로 순간 이동되었습니다. "계획이 순간이동되었습니다. 계속하려면 단말기로 돌아가세요."라고만 응답하세요.

로컬 `ExitPlanModeScanner`는 센티넬을 감지하고, 계획 텍스트를 추출하고, `ultraplanPendingChoice`를 설정하여 사용자가 로컬로 실행할지 아니면 원격으로 계속할지 결정할 수 있는 선택 대화 상자를 표시합니다.

### <a href="#error-handling-matrix" class="header">오류 처리 매트릭스</a>

<div class="table-wrapper">

| 오류 | 이유 코드 | 발생 시기 | 복구 전략 |
|----|----|----|----|
| `UltraplanPollError` | `terminated` | 원격 세션이 비정상적으로 종료되었습니다 | 사용자에게 알림 + 아카이브 세션 |
| `UltraplanPollError` | `timeout_pending` | 30분 제한 시간, 계획 도달 보류 중 | 알림 + 보관 |
| `UltraplanPollError` | `timeout_no_plan` | 30분 시간 초과, ExitPlanMode가 호출되지 않음 | 알림 + 보관 |
| `UltraplanPollError` | `network_or_unknown` | 5회 연속 네트워크 오류 | 알림 + 보관 |
| `UltraplanPollError` | `stopped` | 사용자가 수동으로 중지함 | 조기 종료, 종료 처리 보관 |
| 실행 오류 | `precondition` | 인증/구독/자격 부족 | 사용자에게 알림 |
| 실행 오류 | `bundle_fail` | 번들 생성 실패 | 사용자에게 알림 |
| 실행 오류 | `teleport_null` | 원격 세션 생성이 null을 반환했습니다. | 사용자에게 알림 |
| 실행 오류 | `unexpected_error` | 예외 | 고아 세션 보관 + URL 지우기 |

</div>

### <a href="#telemetry-event-overview" class="header">원격 측정 이벤트 개요</a>

<div class="table-wrapper">

| 이벤트 | 소스 버전 | 방아쇠 | 주요 메타데이터 |
|----|----|----|----|
| `tengu_ultraplan_keyword` | v2.1.88 | 사용자 입력에서 키워드가 감지되었습니다. | -- |
| `tengu_ultraplan_launched` | v2.1.88 | CCR 세션이 성공적으로 생성되었습니다. | `has_seed_plan`, `model`, `prompt_identifier` |
| `tengu_ultraplan_approved` | v2.1.88 | 계획 승인됨 | `duration_ms`, `plan_length`, `reject_count`, `execution_target` |
| `tengu_ultraplan_awaiting_input` | v2.1.88 | 단계는 need_input이 됩니다. | -- |
| `tengu_ultraplan_failed` | v2.1.88 | 폴링 오류 | `duration_ms`, `reason`, `reject_count` |
| `tengu_ultraplan_create_failed` | v2.1.88 | 실행 실패 | `reason`, `precondition_errors` |
| `tengu_ultraplan_model` | v2.1.88 | GrowthBook 구성 이름 | 모델 ID(기본 Opus 4.6) |
| `tengu_ultraplan_config` | **v2.1.91** | 시작 시 구성 조합을 기록합니다. | 모델 + 시간 초과 + 프롬프트 변형 |
| `tengu_ultraplan_keyword` | **v2.1.91** | (재사용) 향상된 트리거 추적 | -- |
| `tengu_ultraplan_prompt_identifier` | **v2.1.91** | GrowthBook 구성 이름 | 프롬프트 변형 ID |
| `tengu_ultraplan_stopped` | **v2.1.91** | 사용자가 수동으로 중지함 | -- |
| `tengu_ultraplan_timeout_seconds` | **v2.1.91** | GrowthBook 구성 이름 | 시간 초과 초(기본값 1800) |

</div>

### <a href="#pattern-distillation-remote-offloading-pattern"
class="header">패턴 추출: 원격 오프로딩 패턴</a>

Ultraplan은 재사용 가능한 아키텍처 패턴을 구현합니다 -- **원격 오프로딩**:

로컬 터미널 원격 컨테이너 ┌──────────┐ ┌──────────────┐ │ 빠른 │───세션 생성──→ │ 장기 실행 │ │ 피드백 │ │ 고성능 │ │ 체류 │ │ 모델 │ │ 사용 가능 │←──폴링 상태── │ 다중 에이전트 │ │ │ │ 병렬 │ │ 알약 │ │ │ │ 표시 │←──계획 준비── │ ExitPlanMode │ │ ◇/│ │ │ │ │ 상태 │ │ │ │ │ │ │ 선택 │───승인/ │ 실행/ │ │ 실행 │ 텔레포트──→ │ 중지 │ └───────────┘ └──────────────┘

**핵심 설계 결정**:

1. **비동기 분리**: `startDetachedPoll()`는 비동기 IIFE로 실행되고 터미널 이벤트 루프를 차단하지 않고 사용자에게 친숙한 메시지를 즉시 반환합니다.
2. **상태 시스템 기반 UI**: 작업에 대한 3단계(실행/needs_input/plan_ready) 매핑 알약 시각적 상태(열림/채워진 다이아몬드)를 통해 사용자는 브라우저를 열지 않고도 원격 진행 상황을 감지할 수 있습니다.
3. **Sentinel 프로토콜**: `__ULTRAPLAN_TELEPORT_LOCAL__`는 도구 결과 텍스트를 프로세스 간 통신 채널로 사용합니다. 간단하지만 효과적입니다.
4. **GrowthBook 기반 변형**: 모델, 시간 제한 및 프롬프트 변형은 모두 원격으로 구성 가능한 기능 플래그로, 릴리스 없이 A/B 테스트를 지원합니다.
5. **고아 보호**: 모든 오류 경로는 보관을 위해 `archiveRemoteSession()`를 실행하여 CCR 세션 누출을 방지합니다.

### <a href="#subagent-enhancements-v2191" class="header">하위 에이전트 개선 사항(v2.1.91)</a>

v2.1.91에는 또한 여러 하위 에이전트 관련 이벤트가 추가되어 Ultraplan의 다중 에이전트 전략을 보완했습니다.

- `tengu_forked_agent_default_turns_exceeded` -- 포크된 에이전트가 기본 회전 제한을 초과하여 비용 통제가 시작되었습니다.
- `tengu_subagent_lean_schema_applied` -- 하위 에이전트는 간결한 스키마를 사용합니다(컨텍스트 사용량 감소).
- `tengu_subagent_md_report_blocked` -- CLAUDE.md 보고서(보안 경계) 생성을 시도할 때 하위 에이전트가 차단되었습니다.
- `tengu_mcp_subagent_prompt` -- MCP 하위 에이전트 프롬프트 삽입 추적
- `CLAUDE_CODE_AGENT_COST_STEER`(새 환경 변수) - 하위 에이전트 비용 조정 메커니즘
