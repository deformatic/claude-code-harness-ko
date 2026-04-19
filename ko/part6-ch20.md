# <a href="#chapter-20-agent-spawning-and-orchestration"
class="header">20장: 에이전트 생성 및 오케스트레이션</a>

> **포지셔닝**: 이 장에서는 Claude Code가 하위 에이전트, 포크 및 코디네이터의 세 가지 모드를 통해 다중 에이전트 생성 및 오케스트레이션을 구현하는 방법을 분석합니다. 전제 조건: 3장 및 4장. 대상 독자: CC가 하위 에이전트(하위 에이전트/포크/코디네이터)를 생성하는 방법을 이해하려는 독자 또는 다중 에이전트 시스템을 구축하는 개발자.

## <a href="#why-multiple-agents-are-needed" class="header">여러 에이전트가 필요한 이유</a>

단일 에이전트 루프의 컨텍스트 창은 유한한 리소스입니다. 작업 규모가 단일 대화가 수용할 수 있는 수준을 초과하는 경우(예: "이 버그의 근본 원인 조사, 수정, 테스트 실행, PR 작성") 단일 에이전트는 중간 결과를 컨텍스트에 집어넣거나 반복적으로 압축하고 세부정보를 잃어야 합니다. 더 근본적인 문제는 **단일 에이전트는 병렬화할 수 없지만** 소프트웨어 엔지니어링 작업은 당연히 분할 정복에 적합하다는 것입니다.

Claude Code는 **하위 에이전트**, **포크 모드** 및 **코디네이터 모드**라는 세 가지 점점 더 많은 다중 에이전트 패턴을 제공합니다. 이들은 단일 진입점(`AgentTool`)을 공유하지만 컨텍스트 상속, 실행 모델 및 수명주기 관리에서 근본적인 차이점이 있습니다. 이 장에서는 이 세 가지 모드를 계층별로 분석하고 이를 중심으로 구축된 검증 에이전트 및 도구 풀 어셈블리 논리를 살펴보겠습니다.

Teams 시스템은 20b장에서 다루고 Ultraplan 원격 계획은 20c장에서 다룹니다.

------------------------------------------------------------------------

> **대화형 버전**: [에이전트 생성 애니메이션을 보려면 클릭하세요.](agent-spawn-viz.html) - 기본 에이전트가 3개의 하위 에이전트를 생성하여 컨텍스트 전달 및 격리를 통해 병렬로 작동하는 모습을 지켜보세요.

## <a href="#201-agenttool-the-unified-agent-spawning-entry-point"
class="header">20.1 AgentTool: 통합 에이전트 생성 진입점</a>

모든 에이전트 생성은 단일 도구를 통해 이루어집니다. `AgentTool`는 `tools/AgentTool/AgentTool.tsx`에 정의되어 있으며, `name`는 `'Agent'`(라인 226)로 설정되고 기존 `'Task'`(라인 228)에 대한 별칭입니다.

### <a href="#dynamic-schema-composition" class="header">동적 스키마 구성</a>

AgentTool의 입력 스키마는 정적이 아닙니다. 기능 플래그 및 런타임 조건을 기반으로 동적으로 구성됩니다.

``` typescript
// tools/AgentTool/AgentTool.tsx:82-88
const baseInputSchema = lazySchema(() => z.object({
  description: z.string().describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  subagent_type: z.string().optional(),
  model: z.enum(['sonnet', 'opus', 'haiku']).optional(),
  run_in_background: z.boolean().optional()
}));
```

기본 스키마에는 5개의 필드가 포함되어 있습니다. 다중 에이전트 기능(에이전트 스웜)이 활성화되면 `name`, `team_name` 및 `mode` 필드도 병합됩니다(93-97행). `isolation` 필드는 `'worktree'`(모든 빌드) 또는 `'remote'`(내부 빌드)를 지원합니다. 백그라운드 작업이 비활성화되거나 포크 모드가 활성화되면 `run_in_background` 필드가 `.omit()` 제거됩니다(라인 122-124).

이 동적 스키마 구성에는 중요한 설계 의도가 있습니다. **모델이 보는 매개변수 목록은 현재 사용할 수 있는 기능을 정확하게 반영합니다**. 포크 모드가 활성화되면 모델은 `run_in_background`를 볼 수 없습니다. 왜냐하면 포크 모드에서는 모든 에이전트가 자동으로 백그라운드로 설정되기 때문입니다(라인 557). 모델은 이를 명시적으로 제어할 필요도 없고 제어해서도 안 됩니다.

### <a href="#asynclocalstorage-context-isolation"
class="header">AsyncLocalStorage 컨텍스트 격리</a>

여러 에이전트가 동일한 프로세스에서 동시에 실행되는 경우(예: 사용자가 Ctrl+B를 눌러 한 에이전트를 백그라운드로 실행하고 다른 에이전트를 즉시 시작하는 경우) 해당 ID 정보를 어떻게 격리합니까? 대답은 `AsyncLocalStorage`입니다.

``` typescript
// utils/agentContext.ts:24
import { AsyncLocalStorage } from 'async_hooks'

// utils/agentContext.ts:93
const agentContextStorage = new AsyncLocalStorage<AgentContext>()

// utils/agentContext.ts:108-109
export function runWithAgentContext<T>(context: AgentContext, fn: () => T): T {
  return agentContextStorage.run(context, fn)
}
```

소스 코드 주석(`agentContext.ts` 행 17-21)은 `AppState`가 사용되지 않는 이유를 직접 설명합니다.

> 에이전트가 백그라운드(ctrl+b)되면 동일한 프로세스에서 여러 에이전트가 동시에 실행될 수 있습니다. AppState는 덮어쓰여지는 단일 공유 상태이므로 에이전트 A의 이벤트가 에이전트 B의 컨텍스트를 잘못 사용하게 됩니다. AsyncLocalStorage는 각 비동기 실행 체인을 격리하므로 동시 에이전트가 서로 간섭하지 않습니다.

`AgentContext`는 `agentType` 필드로 구별되는 구별된 공용체 유형입니다.

<div class="table-wrapper">

| 컨텍스트 유형 | `agentType` 값 | 목적 | 주요 필드 |
|:--:|:--:|:---|:---|
| `SubagentContext` | `'subagent'` | 에이전트 도구에 의해 생성된 하위 에이전트 | `agentId`, `subagentName`, `isBuiltIn` |
| `TeammateAgentContext` | `'teammate'` | Teammate Agent(Swarm 멤버) | `agentName`, `teamName`, `planModeRequired`, `isTeamLead` |

</div>

두 컨텍스트 유형 모두 이 에이전트를 생성한 사람을 추적하는 데 사용되는 `invokingRequestId` 필드(43-49행, 77-83행)를 가지고 있습니다. `consumeInvokingRequestId()` 함수(163-178행)는 "스파스 에지" 의미 체계를 구현합니다. 각 생성/재개는 첫 번째 API 이벤트에서만 `invokingRequestId`를 내보낸 다음 중복 표시를 피하기 위해 나중에 `undefined`를 반환합니다.

------------------------------------------------------------------------

## <a href="#202-three-agent-modes" class="header">20.2 세 가지 에이전트 모드</a>

### <a href="#mode-one-standard-subagent" class="header">모드 1: 표준 하위 에이전트</a>

가장 기본적인 모드입니다. 모델은 `Agent` 도구를 호출할 때 `subagent_type`를 지정하고, AgentTool은 등록된 에이전트 정의에서 일치하는 정의를 찾은 다음 **새로운** 대화를 시작합니다.

라우팅 논리는 `AgentTool.tsx` 라인 322-356에 있습니다.

``` typescript
// tools/AgentTool/AgentTool.tsx:322-323
const effectiveType = subagent_type
  ?? (isForkSubagentEnabled() ? undefined : GENERAL_PURPOSE_AGENT.agentType);
```

`subagent_type`가 지정되지 않고 포크 모드가 꺼진 경우 기본 `general-purpose` 유형이 사용됩니다.

내장 에이전트 정의는 다음을 포함하여 `builtInAgents.ts`(45-72행)에 등록됩니다.

<div class="table-wrapper">

| 에이전트 유형 | 목적 | 도구 제한사항 | 모델 |
|:--:|:---|:---|:--:|
| `general-purpose` | 일반 업무: 검색, 분석, 다단계 작업 | 모든 도구 | 기본 |
| `verification` | 구현 정확성 확인 | 편집 도구 금지 | 상속됨 |
| `Explore` | 코드 탐색 | \- | \- |
| `Plan` | 작업 계획 | \- | \- |
| `claude-code-guide` | 이용안내 | \- | \- |

</div>

하위 에이전트의 주요 특징은 **컨텍스트 격리**입니다. 하위 에이전트는 처음부터 시작하여 상위 에이전트가 전달한 `prompt`만 볼 수 있습니다. 시스템 프롬프트도 독립적으로 생성됩니다(518-534행). 이는 하위 에이전트가 상위 에이전트의 대화 내역을 모른다는 것을 의미합니다. 마치 "방금 방에 들어온 똑똑한 동료"와 같습니다.

### <a href="#mode-two-fork-mode" class="header">모드 2: 포크 모드</a>

포크 모드는 `feature('FORK_SUBAGENT')` 및 런타임 조건을 통한 빌드 타임 게이팅에 의해 공동으로 제어되는 실험적 기능입니다.

``` typescript
// tools/AgentTool/forkSubagent.ts:32-39
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    if (isCoordinatorMode()) return false
    if (getIsNonInteractiveSession()) return false
    return true
  }
  return false
}
```

포크 모드와 표준 하위 에이전트의 근본적인 차이점은 **컨텍스트 상속**입니다. Fork 하위 프로세스는 상위 에이전트의 전체 대화 컨텍스트 및 시스템 프롬프트를 상속합니다.

``` typescript
// tools/AgentTool/forkSubagent.ts:60-71
export const FORK_AGENT = {
  agentType: FORK_SUBAGENT_TYPE,
  tools: ['*'],
  maxTurns: 200,
  model: 'inherit',
  permissionMode: 'bubble',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => '',  // Not used -- inherits parent's system prompt
} satisfies BuiltInAgentDefinition
```

참고 `model: 'inherit'` 및 `getSystemPrompt: () => ''` -- 포크 하위 프로세스는 상위 에이전트의 모델(일관적인 컨텍스트 길이 유지)과 상위 에이전트의 이미 렌더링된 시스템 프롬프트(프롬프트 캐시 적중을 최대화하기 위해 바이트 동일한 콘텐츠 유지)를 사용합니다.

#### <a href="#prompt-cache-sharing" class="header">신속한 캐시 공유</a>

Fork 모드의 핵심 가치는 **신속한 캐시 공유**에 있습니다. `buildForkedMessages()` 함수(`forkSubagent.ts` 라인 107-164)는 모든 Fork 하위 프로세스가 바이트와 동일한 API 요청 접두사를 생성하도록 보장하는 메시지 구조를 구성합니다.

1. 상위 에이전트의 전체 보조 메시지(모든 `tool_use` 블록, 생각, 텍스트)를 보존합니다.
2. 각 `tool_use` 블록에 대해 동일한 자리 표시자 `tool_result`를 생성합니다(142-150행, 고정 텍스트 `'Fork started — processing in background'` 사용).
3. 끝에는 하위별 지침 텍스트 블록만 추가하세요.

<!-- -->

[...기록 메시지, 보조자(모든 tool_use 블록), 사용자(자리 표시자 tool_results..., 지침)]

마지막 텍스트 블록만 자식마다 다르므로 캐시 적중률이 극대화됩니다.

#### <a href="#recursive-fork-protection" class="header">재귀 포크 보호</a>

Fork 하위 프로세스는 캐시 일관성을 위해 도구 풀에 `Agent` 도구를 유지하지만 호출 시 호출이 차단됩니다(332-334행).

``` typescript
// tools/AgentTool/AgentTool.tsx:332-334
if (toolUseContext.options.querySource === `agent:builtin:${FORK_AGENT.agentType}`
    || isInForkChild(toolUseContext.messages)) {
  throw new Error('Fork is not available inside a forked worker.');
}
```

감지 메커니즘에는 두 개의 레이어가 있습니다. 기본 검사는 `querySource`(압축 방지 - 자동 압축으로 메시지를 다시 작성하더라도 손실되지 않음)를 사용하고 백업 검사는 메시지에서 `<fork-boilerplate>` 태그(78-89행)를 검색합니다.

### <a href="#mode-three-coordinator-mode" class="header">모드 3: 코디네이터 모드</a>

코디네이터 모드는 환경 변수 `CLAUDE_CODE_COORDINATOR_MODE`를 통해 활성화됩니다.

``` typescript
// coordinator/coordinatorMode.ts:36-41
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

이 모드에서 기본 에이전트는 **직접 코딩하지 않는 코디네이터**가 되며 해당 도구 세트는 조정 도구인 `Agent`(작업자 생성), `SendMessage`(작업자에게 후속 지침 보내기), `TaskStop`(작업자 중지) 등으로 축소됩니다. 작업자는 실제 코딩 도구를 갖습니다.

코디네이터의 시스템 프롬프트(`coordinatorMode.ts` 행 111-368)는 4단계 작업 흐름을 정의하는 세부 조정 프로토콜입니다.

<div class="table-wrapper">

| 단계 | 집행자 | 목적 |
|:--:|:--:|:---|
| 연구 | 작업자(병렬) | 코드베이스를 조사하고 문제를 찾아보세요 |
| 합성 | **조정자** | 결과 읽기, 문제 이해, 구현 사양 작성 |
| 구현 | 노동자 | 사양에 따라 코드 수정, 커밋 |
| 확인 | 노동자 | 변경 사항이 올바른지 테스트 |

</div>

프롬프트에서 가장 강조되는 원칙은 **"이해를 위임하지 마십시오"**입니다(256-259행).

> 절대로 "당신의 발견에 기초하여" 또는 "연구에 기초하여"라고 쓰지 마십시오. 이 문구는 스스로 작업을 수행하는 대신 작업자에게 이해를 위임합니다.

`getCoordinatorUserContext()` 함수(80-109행)는 작업자가 사용할 수 있는 도구 및 MCP 서버 목록을 포함하여 작업자 도구 컨텍스트 정보를 생성합니다. Scratchpad 기능이 활성화되면 공유 디렉터리가 작업자 간 지식 지속성을 위해 사용될 수 있음을 코디네이터에게 알립니다(104-106행).

### <a href="#supplement-btw-side-question-as-a-tool-less-fork"
class="header">보충 자료: <code>/btw</code> 도구가 필요 없는 포크로서의 측면 질문</a>

`/btw`는 네 번째 에이전트 모드는 아니지만 Claude Code의 기능 매트릭스를 이해하는 데 매우 중요한 **사이드 채널 특수 사례**입니다. 명령 정의 자체는 `local-jsx` 및 `immediate: true`이므로 일반 도구 UI에 포함되지 않고 기본 스레드가 출력을 스트리밍하는 동안 독립적인 오버레이를 유지할 수 있습니다.

실행 경로에서 `/btw`는 기본 루프에 대기열에 넣지 않고 대신 `runSideQuestion()`가 `runForkedAgent()`를 호출합니다. 상위 세션의 캐시 안전 접두사 및 현재 대화 컨텍스트를 상속하지만 `canUseTool`를 통해 모든 도구를 명시적으로 거부하고 `maxTurns`를 1로 제한하며 `skipCacheWrite`를 설정하여 새 캐시 접두사 작성을 방지합니다. 이 일회성 접미사. 즉, `/btw`는 "전체 컨텍스트 + 도구 없음 + 단일 회전 응답" 차원이 축소된 버전입니다.

기능 매트릭스 관점에서 보면 표준 하위 에이전트와 대칭 관계를 형성합니다.

- **표준 하위 에이전트**: 도구 기능을 유지하지만 일반적으로 새로운 컨텍스트에서 시작됩니다.
- **`/btw`**: 컨텍스트 기능은 유지하지만 도구 및 다중 회전 실행을 제거합니다.

이러한 대칭은 Claude Code의 위임 시스템이 이진 스위치가 아니라 "컨텍스트, 도구 및 회전 수"라는 3차원을 따라 독립적으로 조정된다는 점을 보여주기 때문에 중요합니다. 사용자는 항상 "모든 것을 할 수 있는 다른 에이전트"를 원하는 것은 아닙니다. 때로는 "현재 컨텍스트를 사용하여 부작용이 없는 부가적인 질문에 대한 답변"을 원하는 경우도 있습니다.

### <a href="#three-mode-comparison" class="header">3가지 모드 비교</a>

``` mermaid
graph TB
    subgraph StandardSubagent["Standard Subagent"]
        SA1["Context: Fresh conversation"]
        SA2["Prompt: Agent definition's own"]
        SA3["Execution: Foreground/Background"]
        SA4["Cache: No sharing"]
        SA5["Recursion: Allowed"]
        SA6["Scenario: Independent small tasks"]
    end

    subgraph ForkMode["Fork Mode"]
        FK1["Context: Full parent inheritance"]
        FK2["Prompt: Inherited from parent"]
        FK3["Execution: Forced background"]
        FK4["Cache: Shared with parent"]
        FK5["Recursion: Prohibited"]
        FK6["Scenario: Context-aware parallel exploration"]
    end

    subgraph CoordinatorMode["Coordinator Mode"]
        CO1["Context: Workers independent"]
        CO2["Prompt: Coordinator-specific"]
        CO3["Execution: Forced background"]
        CO4["Cache: No sharing"]
        CO5["Recursion: Workers cannot re-spawn"]
        CO6["Scenario: Complex multi-step projects"]
    end

    AgentTool["AgentTool Unified Entry"] --> StandardSubagent
    AgentTool --> ForkMode
    AgentTool --> CoordinatorMode

    style AgentTool fill:#f9f,stroke:#333,stroke-width:2px
```

<div class="table-wrapper">

| 차원 | 표준 하위 에이전트 | 포크 모드 | 코디네이터 모드 |
|:--:|:--:|:--:|:--:|
| 컨텍스트 상속 | 없음(신선한 대화) | 완전 상속 | 없음(근로자 독립) |
| 시스템 프롬프트 | 에이전트 정의 자체 | 부모로부터 상속됨 | 코디네이터별 프롬프트 |
| 모델 선택 | 재정의 가능 | 부모로부터 상속됨 | 재정의할 수 없음 |
| 실행 모드 | 전경/배경 | 강제 배경 | 강제 배경 |
| 캐시 공유 | 없음 | 부모와 공유됨 | 없음 |
| 도구 풀 | 독립적으로 조립됨 | 부모로부터 상속됨 | 노동자들이 독립적으로 모였다 |
| 재귀적 산란 | 허용된 | 금지 | 작업자는 다시 생성될 수 없습니다. |
| 게이팅 방법 | 항상 사용 가능 | 빌드 + 런타임 | 빌드 + 환경 변수 |
| 사용 사례 | 독립적인 작은 작업 | 상황 인식 병렬 탐색 | 복잡한 다단계 프로젝트 |

</div>

------------------------------------------------------------------------

## <a href="#204-verification-agent" class="header">20.4 검증 에이전트</a>

검증 에이전트는 내장된 에이전트 중에서 가장 우아하게 디자인되었습니다. 시스템 프롬프트(`built-in/verificationAgent.ts` 라인 10-128)는 약 120라인에 걸쳐 있습니다. 이는 본질적으로 "실제 검증을 수행하는 방법"에 대한 엔지니어링 사양입니다.

### <a href="#core-design-principles" class="header">핵심 설계 원칙</a>

검증 에이전트에는 명시적으로 명시된 두 가지 실패 모드가 있습니다(라인 12-13):

1. **검증 회피**: 검사에 직면했을 때 실행하지 않을 변명 찾기(코드 읽기, 테스트 단계 설명, 'PASS' 작성 후 계속 진행)
2. **처음 80%에 속음**: 버튼의 절반이 작동하지 않는다는 사실을 인지하지 못한 채 멋진 UI를 보거나 테스트 스위트를 통과하고 통과하는 경향이 있음

### <a href="#strict-read-only-constraints" class="header">엄격한 읽기 전용 제약</a>

검증 에이전트는 프로젝트를 수정하는 것이 명시적으로 금지되어 있습니다.

``` typescript
// built-in/verificationAgent.ts:139-145
disallowedTools: [
  AGENT_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
],
```

그러나 임시 디렉토리(`/tmp`)에 임시 테스트 스크립트를 작성할 수 **있습니다**. 이 권한은 프로젝트를 오염시키지 않고 임시 테스트 도구를 작성하는 데 충분합니다.

### <a href="#verdict-determination" class="header">평결 결정</a>

확인 에이전트의 출력은 엄격한 형식의 결과(117~128행)로 끝나야 합니다.

<div class="table-wrapper">

| 평결 | 의미 |
|:--:|:---|
| `VERDICT: PASS` | 확인 통과 |
| `VERDICT: FAIL` | 특정 오류 출력 및 재현 단계를 포함하여 발견된 문제 |
| `VERDICT: PARTIAL` | 환경 제한으로 인해 전체 검증이 불가능함("불확실함" 아님) |

</div>

`PARTIAL`는 환경 제한(테스트 프레임워크 없음, 도구 사용 불가, 서버 시작 안 됨)에만 해당됩니다. "이것이 버그인지 확실하지 않습니다."에는 사용할 수 없습니다.

### <a href="#adversarial-probing" class="header">적대적 조사</a>

확인 에이전트의 프롬프트에서는 동시 요청, 경계 값, 멱등성, 고아 작업 등 적어도 하나의 적대적 프로브(63-69행)를 실행해야 합니다. 모든 확인이 단순히 "200 반환" 또는 "테스트 스위트 통과"인 경우 이는 행복한 경로만 확인하고 실제 확인으로 간주되지 않습니다.

------------------------------------------------------------------------

## <a href="#207-independent-tool-pool-assembly" class="header">20.7 독립적인 도구 풀 조립</a>

각 작업자의 도구 풀은 상위 에이전트의 제한 사항을 상속하지 않고 독립적으로 조립됩니다(573-577행).

``` typescript
// tools/AgentTool/AgentTool.tsx:573-577
const workerPermissionContext = {
  ...appState.toolPermissionContext,
  mode: selectedAgent.permissionMode ?? 'acceptEdits'
};
const workerTools = assembleToolPool(workerPermissionContext, appState.mcp.tools);
```

유일한 예외는 포크 모드입니다. 도구 정의의 차이로 인해 프롬프트 캐시가 손상될 수 있으므로 포크 하위 프로세스는 상위의 정확한 도구 배열(`useExactTools: true`, 631-633행)을 사용합니다.

### <a href="#mcp-server-waiting-and-validation" class="header">MCP 서버 대기 및 유효성 검사</a>

에이전트 정의는 필수 MCP 서버(`requiredMcpServers`)를 선언할 수 있습니다. AgentTool은 시작하기 전에 이러한 서버를 사용할 수 있는지 확인하고(369-409행) MCP 서버가 연결되어 있는 동안(379-391행) 조기 ​​종료 논리를 사용하여 최대 30초 동안 기다립니다. 즉, 필수 서버에 이미 오류가 발생한 경우 다른 서버에 대한 대기를 중지합니다.

------------------------------------------------------------------------

## <a href="#208-design-insights" class="header">20.8 디자인 통찰력</a>

**하나가 아닌 세 가지 모드가 필요한 이유는 무엇입니까?** 이는 **컨텍스트 공유와 실행 격리**라는 근본적인 균형에서 비롯됩니다. 표준 하위 에이전트는 최대 격리를 제공하지만 컨텍스트는 제공하지 않습니다. Fork는 최대 컨텍스트 공유를 제공하지만 재귀할 수는 없습니다. 코디네이터 모드는 그 사이에 위치합니다. 작업자는 격리되지만 코디네이터는 전역 보기를 유지합니다. 단일 범용 솔루션은 모든 시나리오를 만족시킬 수 없습니다.

**평평한 팀 구조 설계 철학.** 팀원이 팀원을 생성하는 것을 금지하는 것은 단순한 기술적 제약이 아니라 조직 원칙을 반영합니다. 효과적인 팀에서는 조정이 임의로 깊은 위임 체인을 형성하는 대신 하나의 노드(리더)에 중앙 집중화되어야 합니다. 이는 소프트웨어 엔지니어링에서 "지나치게 깊은 호출 스택 방지"라는 직관과 일치합니다.

**검증 에이전트의 "반패턴 체크리스트" 설계.** 검증 에이전트의 프롬프트에는 검증자 역할을 하는 LLM의 일반적인 실패 모드가 명시적으로 나열되어 있으며(53-61행) "자신의 합리화 변명을 인식"하도록 요구합니다. 이 메타인지 프롬프트는 LLM의 고유한 약점에 대한 엔지니어링 보상입니다. 즉, 모델이 이러한 실수를 하지 않을 것이라고 기대하는 것이 아니라 모델이 이러한 실수를 저지르는 경향이 있음을 인식하게 만드는 것입니다.

------------------------------------------------------------------------

## <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

**다중 에이전트 모드를 활용하여 작업 효율성을 높입니다.**

1. **독립적인 조사를 위해 하위 에이전트를 사용합니다.** 주요 대화 컨텍스트를 방해하지 않고 독립적인 하위 작업을 완료해야 하는 경우(예: "이 API의 모든 호출자 찾기") 모델이 하위 에이전트를 시작하도록 하는 것이 최선의 선택입니다. 하위 에이전트에는 자체 컨텍스트 창이 있고 완료 시 요약을 반환하며 기본 대화를 오염시키지 않습니다.

2. **코디네이터 모드의 4단계 워크플로를 이해합니다.** 조직에서 코디네이터 모드(`CLAUDE_CODE_COORDINATOR_MODE=true`)를 활성화한 경우 연구 -\> 합성 -\> 구현 -\> 검증 4단계 워크플로를 이해하면 협업이 더 잘 이루어집니다. 특히 코디네이터는 직접 코딩하지 않으며 문제 이해 및 작업 할당만 처리합니다.

3. **품질 게이트를 위해 검증 에이전트를 사용하세요.** 복잡한 변경을 완료한 후 검증 에이전트 실행을 명시적으로 요청할 수 있습니다. 읽기 전용 제약 조건과 적대적 탐색 설계 덕분에 신뢰할 수 있는 "두 번째 눈 쌍"이 되었습니다.

4. **작업 트리 격리는 기본 분기를 보호합니다.** 에이전트가 `isolation: 'worktree'`를 사용하면 모든 수정 사항이 임시 git 작업 트리에서 발생합니다. 변경 사항이 없는 작업 트리는 자동으로 정리되고, 변경 사항이 있는 작업 트리는 분기를 유지합니다. 즉, 에이전트가 자신 있게 실험적 수정을 시도하도록 할 수 있습니다.

------------------------------------------------------------------------

## <a href="#209-remote-execution-bridge-architecture" class="header">20.9 원격 실행: 브리지 아키텍처</a>

이전 섹션에서는 세 가지 에이전트 생성 모드(서브에이전트, 포크, 코디네이터)를 분석했습니다. 모두 로컬 프로세스에서 실행됩니다. 그러나 Claude Code는 단순한 로컬 CLI 도구 그 이상입니다. 브리지 하위 시스템(`restored-src/src/bridge/`, 총 33개 파일)은 네트워크 경계를 넘어 에이전트 실행 기능을 확장하므로 사용자는 clude.ai 웹 인터페이스에서 로컬 시스템의 에이전트 세션을 원격으로 트리거할 수 있습니다. Fork가 "로컬 시스템에서 프로세스 수준 에이전트 분할"인 경우 Bridge는 "네트워크 간 에이전트 프로젝션"입니다.

### <a href="#three-component-architecture" class="header">3개 구성요소 아키텍처</a>

Bridge의 디자인은 고전적인 클라이언트-서버-작업자 패턴을 따릅니다. 전체 시스템은 세 가지 구성 요소로 구성됩니다.

``` mermaid
flowchart LR
    subgraph Web ["claude.ai Web Interface"]
        User["User Browser"]
    end

    subgraph Server ["Anthropic Server"]
        API["Sessions API<br/>/v1/sessions/*"]
        Env["Environments API<br/>Environment registration & work dispatch"]
    end

    subgraph Local ["Local Machine"]
        Bridge["Bridge Main Loop<br/>bridgeMain.ts"]
        Session1["Session Runner #1<br/>Subprocess claude --print"]
        Session2["Session Runner #2<br/>Subprocess claude --print"]
    end

    User -->|"Create session"| API
    API -->|"Dispatch work"| Env
    Bridge -->|"Poll for work<br/>pollForWork()"| Env
    Bridge -->|"Register environment<br/>registerBridgeEnvironment()"| Env
    Bridge -->|"Spawn subprocess"| Session1
    Bridge -->|"Spawn subprocess"| Session2
    Session1 -->|"NDJSON stdout"| Bridge
    Session2 -->|"NDJSON stdout"| Bridge
    Bridge -->|"Heartbeat & status reporting"| Env
    User -->|"Permission decisions"| API
    API -->|"control_response"| Bridge
    Bridge -->|"stdin forwarding"| Session1
```

**브리지 메인 루프**(`bridgeMain.ts`)는 핵심 오케스트레이터입니다. `runBridgeLoop()`(라인 141)를 통해 지속적인 폴링 루프를 시작합니다. 즉, 로컬 환경을 서버에 등록한 다음 `pollForWork()`를 반복적으로 호출하여 새 세션 요청을 받습니다. 새 작업이 도착할 때마다 Bridge는 `SessionSpawner`를 사용하여 하위 Claude Code 프로세스를 생성하여 실제 에이전트 작업을 실행합니다.

**Session Runner**(`sessionRunner.ts`)는 각 하위 프로세스의 수명주기를 관리합니다. `createSessionSpawner()`(라인 248)를 통해 팩토리를 생성합니다. 각 `.spawn()` 호출은 `--input-format stream-json --output-format stream-json` NDJSON 스트리밍 모드(287-299행)에서 구성된 새로운 `claude --print` 하위 프로세스를 시작합니다. 하위 프로세스의 stdout은 `readline`를 통해 한 줄씩 구문 분석되어 도구 호출 활동(`extractActivities`) 및 권한 요청(`control_request`)을 추출합니다.

### <a href="#jwt-authentication-flow" class="header">JWT 인증 흐름</a>

브리지 인증은 2계층 JWT(JSON 웹 토큰) 시스템을 기반으로 합니다. 외부 계층은 환경 등록 및 관리 API를 위한 OAuth 토큰입니다. 내부 계층은 하위 프로세스의 실제 추론 요청을 위한 세션 수신 토큰(접두사 `sk-ant-si-`)입니다.

`jwtUtils.ts`의 `createTokenRefreshScheduler()`(라인 72)는 우아한 토큰 갱신 스케줄러를 구현합니다. 핵심 논리:

1. **JWT 만료를 디코딩**. `decodeJwtPayload()` 함수(라인 21)는 `sk-ant-si-` 접두사를 제거한 다음 Base64url로 인코딩된 페이로드 세그먼트를 디코딩하여 `exp` 클레임을 추출합니다. 여기서는 **서명이 확인되지 않습니다**. -- Bridge는 만료 시간만 알아야 합니다. 확인은 서버 측에서 수행됩니다.

2. **사전 갱신**. 스케줄러는 토큰 만료(`TOKEN_REFRESH_BUFFER_MS`, 52행) 5분 전에 사전에 새로 고침을 시작하여 만료된 토큰을 사용하여 실패한 요청을 방지합니다.

3. **레이스를 방지하기 위한 세대 계산**. 각 세션은 생성 카운터(라인 94)를 유지합니다. `schedule()` 및 `cancel()`는 모두 세대 번호를 증가시킵니다. 비동기 `doRefresh()`가 완료되면 현재 세대가 시작 시 세대와 일치하는지 확인합니다(라인 178). 그렇지 않은 경우 세션 일정이 변경되거나 취소되고 새로 고침 결과가 삭제되어야 합니다. 이 패턴은 동시 새로 고침으로 인해 발생하는 고아 타이머 문제를 효과적으로 방지합니다.

4. **회로 차단을 통한 실패 재시도**. 3회 연속 실패 후(`MAX_REFRESH_FAILURES`, 58행) 토큰 소스를 완전히 사용할 수 없을 때 무한 루프를 피하기 위해 재시도를 중지합니다. 각 실패는 재시도하기 전에 60초를 기다립니다.

### <a href="#session-forwarding-and-permission-proxying"
class="header">세션 전달 및 권한 프록시</a>

Bridge의 가장 우아한 디자인은 원격 권한 프록시에 있습니다. 하위 프로세스가 민감한 작업(예: 파일 쓰기 또는 셸 명령 실행)을 수행해야 하는 경우 stdout을 통해 `control_request` 메시지를 내보냅니다. `sessionRunner.ts`의 NDJSON 파서는 이러한 메시지(417-431행)를 감지하고 `onPermissionRequest` 콜백을 호출하여 요청을 서버에 전달합니다.

`bridgePermissionCallbacks.ts`는 권한 프록시의 유형 계약을 정의합니다.

``` typescript
// restored-src/src/bridge/bridgePermissionCallbacks.ts:3-8
type BridgePermissionResponse = {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: PermissionUpdate[]
  message?: string
}
```

웹 인터페이스에서 이루어진 사용자의 허용/거부 결정은 `control_response` 메시지를 통해 Bridge로 다시 전달되며, Bridge는 하위 프로세스의 stdin을 통해 Session Runner로 전달됩니다. 이는 완전한 권한 루프를 형성합니다. 하위 프로세스 요청 -\> 브리지 전달 -\> 서버 -\> 웹 인터페이스 -\> 사용자 결정 -\> 동일한 경로를 통해 반환합니다.

토큰 업데이트도 stdin을 통해 수행됩니다. `SessionHandle.updateAccessToken()`(`sessionRunner.ts` 라인 527)는 새 토큰을 하위 프로세스의 stdin에 기록된 `update_environment_variables` 메시지로 래핑합니다. 하위 프로세스의 StructuredIO 핸들러는 `process.env`를 직접 설정하므로 후속 인증 헤더는 자동으로 새 토큰을 사용합니다.

### <a href="#capacity-management" class="header">용량 관리</a>

Bridge는 여러 동시 세션에 대한 용량 문제를 처리해야 합니다. `types.ts`는 세 가지 생성 모드를 정의합니다(SpawnMode, 68-69행):

<div class="table-wrapper">

| 방법 | 행동 | 사용 사례 |
|----|----|----|
| `single-session` | 단일 세션, 완료 시 종료 | 기본 모드, 가장 간단함 |
| `worktree` | 세션당 독립적인 Git 작업 트리 | 병렬 다중 세션, 간섭 없음 |
| `same-dir` | 모든 세션은 작업 디렉터리를 공유합니다. | 가볍지만 충돌이 발생하기 쉬움 |

</div>

`bridgeMain.ts`의 기본 최대 동시 세션은 32(`SPAWN_SESSIONS_DEFAULT`, 83행)이며 다중 세션 기능은 GrowthBook Feature Gate(`tengu_ccr_bridge_multi_session`, 97행)를 통해 점진적으로 출시됩니다.

`capacityWake.ts`는 용량 웨이크 프리미티브(라인 28의 `createCapacityWake()`)를 구현합니다. 모든 세션 슬롯이 가득 차면 폴링 루프가 절전 모드로 전환됩니다. 두 가지 이벤트가 이를 깨웁니다. (a) 외부 중단 신호(종료) 또는 (b) 세션 완료 및 슬롯 해제입니다. 이 모듈은 `bridgeMain.ts` 및 `replBridge.ts`에서 이전에 복제된 깨우기 논리를 공유 프리미티브로 추상화합니다. 설명에 따르면 "두 폴링 모두 이전에 복제된 바이트 단위로 루프를 반복합니다"(라인 8).

각 세션에는 기본적으로 24시간(`DEFAULT_SESSION_TIMEOUT_MS`, `types.ts` 라인 2)의 시간 초과 보호 기능도 있습니다. 시간 초과된 세션은 Bridge의 감시 장치에 의해 사전에 종료되며 먼저 SIGTERM을 보낸 다음 유예 기간 후에 SIGKILL을 보냅니다.

### <a href="#relationship-to-agent-spawning" class="header">에이전트 생성과의 관계</a>

브리지는 이 장의 전반부에서 네트워크 측면에서 논의한 에이전트 생성 메커니즘을 자연스럽게 확장한 것입니다. 세 가지 에이전트 모드와 브리지를 동일한 스펙트럼에 배치하는 경우:

<div class="table-wrapper">

| 차원 | 하위 에이전트 | 포크 | 조정자 | 다리 |
|----|----|----|----|----|
| 실행 위치 | 동일한 프로세스 | 하위 프로세스 | 하위 프로세스 그룹 | 원격 하위 프로세스 |
| 컨텍스트 상속 | 없음 | 전체 스냅샷 | 요약 통과 | 없음(독립 세션) |
| 트리거 소스 | LLM 자율 | LLM 자율 | LLM 자율 | 웹을 통한 사용자 |
| 권한 모델 | 상위 상속 | 상위 상속 | 상위 상속 | 원격 프록시 반환 |
| 수명주기 | 부모가 관리함 | 부모가 관리함 | 코디네이터 관리 | 브리지 폴링 루프 관리 |

</div>

Bridge 세션은 기본적으로 컨텍스트 상속이 없는 원격 하위 에이전트입니다. 이는 정확히 동일한 `claude --print` 실행 모드를 사용하지만 세션 생성, 권한 결정 및 수명 주기 관리는 모두 네트워크 경계를 넘습니다. `sessionRunner.ts`의 `createSessionSpawner()`는 개념적으로 AgentTool의 하위 프로세스 생성과 동일하며 트리거 소스와 통신 채널만 다릅니다.

이 설계의 장점은 에이전트가 로컬로 실행되든 원격으로 실행되든 상관없이 핵심 에이전트 루프(3장 참조)가 전혀 변경될 필요가 없다는 사실에 있습니다. Bridge는 루프 외부에 네트워크 전송 및 인증 프로토콜 계층을 래핑하여 커널의 단순성을 유지합니다.
