# <a
href="#chapter-3-agent-loop--the-full-lifecycle-from-user-input-to-model-response"
class="header">3장: 에이전트 루프 - 사용자 입력부터 모델 응답까지의 전체 수명주기</a>

> *"모든 반복이 실행되는 세계를 재구성할 때 루프는 루프가 아닙니다."*

이 장은 책 전체의 닻이다. 5장의 API 호출 구성부터 9장의 자동 압축 전략, 13장의 스트리밍 응답 처리부터 16장의 권한 확인 시스템까지, 후속 장에서 논의되는 거의 모든 하위 시스템은 궁극적으로 `queryLoop()` 코어 루프 내에서 조정, 조정 및 구동됩니다. 이 루프를 이해한다는 것은 AI 에이전트로서 Claude Code의 고동치는 심장을 이해한다는 것을 의미합니다.

## <a href="#31-why-the-agent-loop-is-not-a-simple-repl" class="header">3.1 에이전트 루프가 단순한 REPL이 아닌 이유</a>

전통적인 REPL(Read-Eval-Print Loop)은 상태 비저장 3단계 주기(입력 읽기, 평가, 결과 인쇄)입니다. 반복 간에 컨텍스트 전달이 없고 자동 복구도 없으며 자체 상태에 대한 인식도 없습니다.

에이전트 루프는 근본적으로 다릅니다. 다음 비교표를 고려해보세요.

<div class="table-wrapper">

| 차원 | 기존 REPL | 클로드 코드 에이전트 루프 |
|----|----|----|
| 상태 모델 | 무국적 또는 기록 전용 | 10개의 변경 가능한 필드가 있는 `State` 유형, 반복 전반에 걸쳐 전달됨 |
| 루프 종료 | 사용자가 명시적으로 종료함 | `Continue` 전환 7개 + `Terminal` 종료 이유 10개 |
| 오류 처리 | 오류를 인쇄하고 계속하세요 | 자동 저하, 모델 전환, 반응성 컴팩트, 재시도 제한 |
| 컨텍스트 관리 | 없음 | snip -\> microcompact -\> 컨텍스트 축소 -\> 자동 압축 4단계 파이프라인 |
| 도구 실행 | 없음 | 스트리밍 병렬 실행, 권한 확인, 결과 예산 트리밍 |
| 대화능력 | OOM까지 무제한으로 성장 | 토큰 예산 추적, 자동 압축, 차단 한도 하드 캡 |

</div>

에이전트 루프가 반복될 때마다 자체 작동 조건이 변경될 수 있습니다. 압축으로 인해 메시지 배열이 줄어들고, 모델 성능이 저하되어 추론 백엔드가 전환되고, 중지 후크가 새로운 제약 조건 메시지를 삽입합니다. 이것은 루프가 아닙니다. **자체 수정 상태 머신**입니다.

## <a href="#32-queryloop-state-machine-overview" class="header">3.2 queryLoop 상태 머신 개요</a>

### <a href="#321-entry-query-and-queryloop" class="header">3.2.1 항목: <code>query()</code> 및 <code>queryLoop()</code></a>

입력 함수 `query()`는 얇은 래퍼입니다. `queryLoop()`를 호출하여 결과를 얻은 다음 사용된 모든 명령에 수명 주기 완료를 알립니다.

복원된-src/src/query.ts:219-238

``` typescript
export async function* query(params: QueryParams): AsyncGenerator<...> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

실제 상태 머신은 `queryLoop()`(`restored-src/src/query.ts:241`)에 있습니다. `state = next; continue`를 통해 다음 반복에 들어가거나 `return { reason: '...' }`를 통해 종료되는 `while (true)` 루프입니다.

### <a href="#322-the-state-type-mutable-state-across-iterations"
class="header">3.2.2 상태 유형: 반복 전반에 걸쳐 변경 가능한 상태</a>

`State` 유형은 루프가 반복 간에 전달해야 하는 모든 변경 가능한 상태를 정의합니다(`restored-src/src/query.ts:204-217`):

<div class="table-wrapper">

| 필드 | 유형 | 의미론 |
|----|----|----|
| `messages` | `Message[]` | 현재 대화 메시지 배열; 각 반복 후에 보조 응답 및 도구 결과가 추가됩니다. |
| `toolUseContext` | `ToolUseContext` | 사용 가능한 도구 목록, 권한 모드, 중단 신호 등을 포함한 도구 실행 컨텍스트 |
| `autoCompactTracking` | `AutoCompactTrackingState | undefined` | 자동 압축 추적 상태, 압축 실행 여부 및 연속 실패 횟수를 기록합니다. |
| `maxOutputTokensRecoveryCount` | `number` | 지금까지 수행된 max_output_tokens 복구 시도 횟수(최대 3회) |
| `hasAttemptedReactiveCompact` | `boolean` | 반응성 압축이 시도되었는지 여부, 재시도 사망 루프 방지 |
| `maxOutputTokensOverride` | `number | undefined` | 에스컬레이션 재시도에 사용되는 기본 max_output_tokens 값 재정의(예: 8k -\> 64k) |
| `pendingToolUseSummary` | `Promise<...> | undefined` | 이전 라운드의 도구 실행 요약에 대한 약속, 다음 라운드의 모델 스트리밍 중에 병렬로 대기 |
| `stopHookActive` | `boolean | undefined` | 중지 후크가 활성화되어 있는지 여부를 표시하여 중복 트리거를 방지합니다. |
| `turnCount` | `number` | `maxTurns` 한계 확인에 사용되는 현재 회전 수 |
| `transition` | `Continue | undefined` | 이전 반복이 계속된 이유 - 복구 경로가 실제로 실행되었음을 테스트 및 디버깅에서 확인할 수 있습니다. |

</div>

주요 설계 결정에 유의하십시오. 소스 주석에는 "9개의 개별 할당 대신 `state = { ... }`를 계속 작성하십시오"(`restored-src/src/query.ts:267`)라고 명시적으로 명시되어 있습니다. 이는 모든 연속 지점이 완전한 `State` 객체를 명시적으로 구성해야 함을 의미합니다. 이 접근 방식은 "필드 재설정을 잊어버린" 버그 클래스를 제거합니다. 7개의 연속 지점이 있는 루프에서 이는 이론적인 위험이 아니라 피할 수 없는 사고입니다.

### <a href="#323-continue-transition-types" class="header">3.2.3 계속 전환 유형</a>

루프에는 내부적으로 7개의 `continue` 사이트가 있으며 각 사이트는 전환 이유를 기록합니다. 소스 코드에서 추출된 전체 열거형:

<div class="table-wrapper">

| `Continue.reason` | 트리거 조건 | 일반적인 행동 |
|----|----|----|
| `next_turn` | 모델이 `tool_use` 블록을 반환했습니다. | 보조자 + tool_result 추가, TurnCount 증가, 다음 회전 시작 |
| `max_output_tokens_escalate` | 모델 출력이 잘렸으며 아직 에스컬레이션되지 않았습니다. | maxOutputTokensOverride를 64k로 설정하고 동일한 요청을 그대로 재시도합니다. |
| `max_output_tokens_recovery` | 출력 잘림, 에스컬레이션 사용됨, 복구 횟수 \< 3 | Inject meta message asking model to continue, increment recovery count |
| PHXCODE00051PHX | prompt-too-long or media-size error | Trigger reactive compact then retry |
| PHXCODE00052PHX | prompt-too-long with pending context collapse submissions | Execute all staged collapses, then retry |
| PHXCODE00053PHX | stop hook returned a blocking error | Inject blocking error into message stream, let model correct |
| PHXCODE00054PHX | token budget not yet exhausted | Inject nudge message encouraging model to continue working |

</div>

### <a href="#324-terminal-termination-reasons" class="header">3.2.4 단말기 종료 사유</a>

루프는 `reason` 필드가 포함된 반환 값과 함께 `return`를 통해 종료됩니다. 소스 코드에서 추출된 전체 열거형:

<div class="table-wrapper">

| `Terminal.reason` | 의미론 |
|----|----|
| `completed` | 모델이 정상적으로 완료되었거나(tool_use 없음), API 오류가 발생했지만 복구가 소진되었습니다. |
| `blocking_limit` | 토큰 수가 한도에 도달하여 계속할 수 없습니다. |
| `prompt_too_long` | 프롬프트가 너무 길어서 모든 복구 수단(붕괴 배수 + 반응성 컴팩트)이 실패했습니다. |
| `image_error` | 이미지 크기/형식 오류 |
| `model_error` | 모델 호출에서 예기치 않은 예외가 발생했습니다. |
| `aborted_streaming` | 스트리밍 응답 중에 사용자가 중단되었습니다. |
| `aborted_tools` | 도구 실행 중 사용자가 중단됨 |
| `stop_hook_prevented` | 스톱 훅으로 인해 계속 진행되지 않음 |
| `hook_stopped` | 후크로 인해 도구 실행 중 후속 작업이 방지되었습니다. |
| `max_turns` | 최대 회전 제한에 도달했습니다. |

</div>

> **대화형 버전**: [에이전트 루프 애니메이션 시각화를 보려면 클릭하세요](agent-loop-viz.html) — 전체 "버그 수정 도움말" 대화가 상태 시스템을 통해 어떻게 흐르는지 확인하세요. 각 단계를 클릭하면 소스 참조 및 자세한 설명을 볼 수 있습니다.

아래 흐름도는 상태 머신의 전체 토폴로지를 보여줍니다.

``` mermaid
flowchart TD
    Entry["queryLoop() Entry<br/>Initialize State, budgetTracker, config"] --> Loop

    subgraph Loop["while (true)"]
        direction TB
        Start["Destructure state<br/>yield stream_request_start"] --> Phase1
        Phase1["Phase 1: Context Preprocessing<br/>applyToolResultBudget → snipCompact<br/>→ microcompact → contextCollapse<br/>→ autocompact"] --> Phase2
        Phase2{"Phase 2: Blocking limit<br/>token count > hard limit?"}
        Phase2 -->|YES| T_Blocking["return blocking_limit"]
        Phase2 -->|NO| Phase3
        Phase3["Phase 3: API Call<br/>callModel + attemptWithFallback<br/>Stream response → assistantMessages + toolUseBlocks"] --> Phase4
        Phase4{"Phase 4: Abort check<br/>aborted?"}
        Phase4 -->|YES| T_Aborted["return aborted_*"]
        Phase4 -->|NO| Branch
        Branch{"needsFollowUp?"}
        Branch -->|"false (no tool_use)"| Phase5
        Branch -->|"true (has tool_use)"| Phase6

        Phase5["Phase 5: Recovery & Termination Decision<br/>prompt-too-long → collapse drain / reactive compact<br/>max_output_tokens → escalate / recovery x3<br/>stop hooks → blocking errors injection<br/>token budget → nudge continuation"]
        Phase5 -->|Recovery succeeded| Continue1["state = next; continue"]
        Phase5 -->|All exhausted| T_Completed["return completed"]

        Phase6["Phase 6: Tool Execution<br/>StreamingToolExecutor / runTools"] --> Phase7
        Phase7["Phase 7: Attachment Injection<br/>memory prefetch / skill discovery / commands"] --> Phase8
        Phase8{"Phase 8: Continuation Decision<br/>maxTurns?"}
        Phase8 -->|Below limit| Continue2["state = next_turn; continue"]
        Phase8 -->|At limit| T_MaxTurns["return max_turns"]
    end

    Continue1 --> Start
    Continue2 --> Start
```

다음은 일반 텍스트 읽기 환경이 필요한 독자를 위한 원래 ASCII 버전입니다.

ASCII 흐름도(확대하려면 클릭)

┌──────────────────────────────────────────────────────────────────────────┐ │ queryLoop() 항목 │ │ 초기화 상태, 예산 추적기, config, 보류 중인MemoryPrefetch │ └──────────────┬───────────────────────────────────────────────────┘ │ ▼ ┌────────────────────────────────────────────────┐ │ while (true) { │ │ 상태 → 메시지, toolUseContext, ...│ │ 항복 { type: 'stream_request_start' } │ ├────────────────────────────────────────────────┤ │ │ │ ┌─────────────────────────────────────┐ │ │ │ 페이즈 1: 컨텍스트 전처리 │ │ │ │ applyToolResultBudget │ │ │ │ → snipCompact (HISTORY_SNIP) │ │ │ │ → microcompact │ │ │ │ → contextCollapse (CONTEXT_COLLAPSE) │ │ │ │ → autocompact ───── Ch.9 참조 ────────── │ │ │ └──────────────┬──────────────────────────┘ │ │ │ │ │ ▼ │ │ ┌────────────────────────────────────┐ │ │ │ │ 2단계: 차단 한도 확인 │ │ │ │ 토큰 수 > 하드 한도 ? │ │ │ │ 예 → 반환 {이유:'blocking_limit'} │ │ │ └─────────────┬───────────────────────┘ │ │ │ 아니요 │ │ ▼ │ │ ┌────────────────────────────────────────┐ │ │ │ 3단계: API 호출 ── Ch.5 및 Ch.13 참조 ── │ │ │ │ tryWithFallback 루프 │ │ │ │ callModel({ │ │ │ │ 메시지: prependUserContext(...) │ │ │ │ systemPrompt:appendSystemContext(...) │ │ │ │ }) │ │ │ │ │ │ │ 스트림 응답 → AssistantMessages[] │ │ │ → toolUseBlocks[] │ │ │ │ FallbackTriggeredError → 모델 전환 │ │ │ └──────────────┬──────────────────────────┘ │ │ │ │ │ ▼ │ │ ┌─────────────────────────────────────┐ │ │ │ │ 4단계: 검사 중단 │ │ │ │ abortController.signal.aborted ?│ │ │ │ 예 → 반환 {이유:'aborted_*'} │ │ │ └─────────────┬───────────────────────┘ │ │ │ 아니요 │ │ ▼ │ │ ┌────────────────────────────────────────┐ │ │ 5단계: needFollowUp == false 분기 │ │ │ │ (모델이 tool_use를 반환하지 않음) │ │ │ │ │ │ │ ┌─ 프롬프트가 너무 긴 복구 ──────────┐ │ │ │ │ │ 붕괴 배수 → 반응성 컴팩트 │ │ │ │ │ │ 성공 → 상태=다음; 계속 │ │ │ │ └────────────────────────────────────┘ │ │ │ │ ┌─ max_output_tokens 복구 ────────┐ │ │ │ │ │ 에스컬레이션(8k→64k) → 복구(×3) │ │ │ │ │ │ 성공 → 상태=다음; 계속 │ │ │ │ └────────────────────────────────────-┘ │ │ │ │ ┌─ 중지 후크 ── Ch.16 참조 ──────────┐ │ │ │ │ │ BlockingErrors → state=next;continue│ │ │ │ │ └─────────────────────────────────────┘ │ │ │ │ ┌─ 토큰 예산 확인 ───────────────┐ │ │ │ │ │ 남은 예산 → 상태=다음;      │ │ │ │ │ │ 계속 │ │ │ │ └───────────────────────────────────┘ │ │ │ │ │ │ │ 반환 { 이유: '완료' } │ │ │ └────────────────────────────────────────┘ │ │ │ │ needFollowUp == true │ │ │ │ │ ▼ │ │ ┌────────────────────────────────────────┐ │ │ 6 단계: 도구 실행 │ │ │ │ StreamingToolExecutor.getRemainingResults│ │ │ │ 또는 runTools() ── Ch.4 참조 ────────────── │ │ │ │ → 도구결과[] │ │ │ └──────────────┬───────────────────────┘ │ │ │ │ │ ▼ │ │ ┌────────────────────────────────────────┐ │ │ 7단계: 첨부 파일 주입 │ │ │ │ getAttachmentMessages() │ │ │ │ 보류 중인MemoryPrefetch 소비 │ │ │ │ SkillDiscoveryPrefetch 소비 │ │ │ │ queuedCommands 배수 │ │ │ └──────────────┬─────────────────────────┘ │ │ │ │ │ ▼ │ │ ┌───────────────────────────────────────┐ │ │ │ 8단계: 지속 결정 │ │ │ │ maxTurns 확인 │ │ │ │ 상태 = { 이유: 'next_turn', ... } │ │ │ │ 계속 │ │ │ └───────────────────────────────────────┘ │ │ │ └──────────────────────────────────────────┘

## <a href="#33-complete-flow-of-a-single-iteration" class="header">3.3 단일 반복의 전체 흐름</a>

단일 반복의 모든 단계를 처음부터 끝까지 추적해 보겠습니다.

### <a href="#331-context-preprocessing-pipeline" class="header">3.3.1 컨텍스트 전처리 파이프라인</a>

각 반복이 시작될 때 원시 `messages` 어레이는 API로 전송되기 전에 4~5단계의 처리를 거쳐야 합니다. 이러한 단계는 엄격한 순서로 실행되며 순서는 바뀔 수 없습니다.

**레벨 1: 도구 결과 예산 조정**

복원된-src/src/query.ts:379-394

`applyToolResultBudget()`는 집계된 도구 결과에 크기 제한을 적용합니다. 후속 캐시된 마이크로 컴팩트는 콘텐츠 검사 없이 `tool_use_id`에서만 작동하므로 모든 압축 단계 전에 실행됩니다. 콘텐츠를 먼저 트리밍해도 방해가 되지 않습니다.

**레벨 2: 기록 캡처**

복원된-src/src/query.ts:401-410

`snipCompactIfNeeded()`는 경량 압축입니다. 기록에서 오래된 메시지를 여유 토큰 공간으로 잘라냅니다. 결정적으로 `tokensFreed` 값을 반환합니다. 이 값은 자동 압축으로 전달되므로 임계값 결정은 이미 캡처로 확보된 공간을 설명할 수 있습니다.

**레벨 3: 초소형**

복원된-src/src/query.ts:414-426

Microcompact는 자동 압축 전에 실행되는 세분화된 압축입니다. 또한 API의 캐시 삭제 메커니즘을 활용하여 추가 API 호출 압축이 필요 없는 "캐시 편집" 모드(`CACHED_MICROCOMPACT`)도 지원합니다.

**레벨 4: 컨텍스트 축소**

복원된-src/src/query.ts:440-447

컨텍스트 축소는 읽기 시간 프로젝션 메커니즘입니다. 소스 댓글은 우아한 디자인을 보여줍니다.

> *"아무것도 생성되지 않습니다. 축소된 뷰는 REPL의 전체 기록에 대한 읽기 시간 투영입니다. 요약 메시지는 REPL 배열이 아닌 축소 저장소에 있습니다."* (`restored-src/src/query.ts:434-436`)

이는 축소가 원래 메시지 배열을 수정하지 않고 각 반복마다 다시 투영됨을 의미합니다. 축소된 결과는 연속 지점에서 `state.messages`를 통해 전달됩니다. 다음 `projectView()`는 보관된 메시지가 이미 입력에 없기 때문에 작동하지 않습니다.

**레벨 5: 자동 압축**(9장 참조)

복원된-src/src/query.ts:454-468

자동 압축은 가장 무거운 전처리 단계입니다. 컨텍스트 축소 후에 실행됩니다. 축소로 인해 토큰 수가 이미 임계값 아래로 감소한 경우 자동 압축은 작동하지 않고 단일 요약을 생성하는 대신 더 세부적인 컨텍스트를 유지합니다.

이 5단계 파이프라인의 설계는 **가벼운 것에서 무거운 것으로, 로컬에서 글로벌로**라는 한 가지 원칙을 따릅니다. 각 레벨은 너무 많은 정보를 잃지 않으면서 여유 공간을 확보하려고 노력합니다. 이전 레벨이 충분하지 않은 경우에만 이후 레벨이 활성화됩니다.

### <a
href="#332-context-injection-prependusercontext-and-appendsystemcontext"
class="header">3.3.2 컨텍스트 주입: prependUserContext 및 AppendSystemContext</a>

메시지 사전 처리가 완료된 후 다음 두 가지 기능을 통해 컨텍스트가 API 요청에 주입됩니다.

**`appendSystemContext`** (`restored-src/src/utils/api.ts:437-447`):

``` typescript
export function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}
```

시스템 컨텍스트는 시스템 프롬프트 끝에 추가됩니다. 현재 날짜, 작업 디렉터리 등과 같은 이 콘텐츠는 시스템 프롬프트의 특별한 캐싱 위치로부터 이점을 얻습니다. API의 프롬프트 캐싱은 시스템 프롬프트에 가장 친숙합니다.

**`prependUserContext`** (`restored-src/src/utils/api.ts:449-474`):

``` typescript
export function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  // ...
  return [
    createUserMessage({
      content: `<system-reminder>\n...\n</system-reminder>\n`,
      isMeta: true,
    }),
    ...messages,
  ]
}
```

사용자 컨텍스트는 `<system-reminder>` 태그로 래핑되고 **첫 번째 사용자 메시지로** 메시지 배열에 추가됩니다. 이 위치 선택은 임의적이지 않습니다. 모든 대화 전에 컨텍스트가 나타나도록 하고 `isMeta: true`(사용자 UI에 표시되지 않음)로 표시됩니다. 중요한 프롬프트 텍스트가 포함됩니다. "이 컨텍스트는 작업과 관련이 있을 수도 있고 아닐 수도 있습니다." - 이를 통해 모델은 관련 없는 컨텍스트를 자유롭게 무시할 수 있습니다.

통화 타이밍을 참고하세요(`restored-src/src/query.ts:660`):

``` typescript
messages: prependUserContext(messagesForQuery, userContext),
systemPrompt: fullSystemPrompt,  // already appendSystemContext'd
```

`prependUserContext`는 전처리 파이프라인이 아닌 API 호출 시 실행됩니다. 이는 사용자 컨텍스트가 토큰 계산이나 압축 결정에 참여하지 않는다는 것을 의미합니다. 이는 "투명한" 주입입니다.

### <a href="#333-message-normalization-pipeline" class="header">3.3.3 메시지 정규화 파이프라인</a>

API 호출 구성 단계(`restored-src/src/services/api/claude.ts:1259-1314`) 중에 메시지는 4단계 정규화 파이프라인을 통과합니다. 이 파이프라인의 책임은 Claude Code의 풍부한 내부 메시지 유형을 Anthropic API에서 허용하는 엄격한 형식으로 변환하는 것입니다.

**1단계: `normalizeMessagesForAPI()`** (`restored-src/src/utils/messages.ts:1989`)

이는 가장 복잡한 정규화 단계입니다. 다음 작업을 수행합니다.

1. **첨부 파일 재정렬**: `reorderAttachmentsForAPI()`를 통해 tool_result 또는 보조 메시지에 도달할 때까지 첨부 파일 메시지를 위쪽으로 이동합니다.
2. **가상 메시지 필터링**: 표시 전용인 `isVirtual`로 표시된 메시지를 제거합니다(예: REPL 내부 도구 호출).
3. **시스템/진행 메시지 제거**: `progress` 유형 메시지 및 비 `local_command` `system` 메시지를 필터링합니다.
4. **합성 오류 메시지 처리**: PDF/이미지/너무 큰 요청 오류를 감지하고 뒤로 검색하여 소스 사용자 메시지에서 해당 미디어 블록을 제거합니다.
5. **공구 입력 정규화**: `normalizeToolInputForAPI`를 통해 공구 입력 형식을 처리합니다.
6. **메시지 병합**: 인접한 동일한 역할 메시지가 병합됩니다(API에는 엄격한 사용자/보조 교체가 필요함)

**2단계: `ensureToolResultPairing()`** (`restored-src/src/utils/messages.ts:5133`)

`tool_use` / `tool_result` 페어링 불일치를 수정합니다. 이러한 불일치는 원격 세션(원격/원격 이동 세션)을 복구할 때 특히 일반적입니다. 고아 `tool_use` 블록에 대해 합성 오류 `tool_result`를 삽입하고 존재하지 않는 `tool_use`를 참조하는 고아 `tool_result` 블록을 제거합니다.

**3단계: `stripAdvisorBlocks()`** (`restored-src/src/utils/messages.ts:5466`)

Advisor 블록을 제거합니다. 이러한 블록에는 API(`restored-src/src/services/api/claude.ts:1304`)가 승인하려면 특정 베타 헤더가 필요합니다.

``` typescript
if (!betas.includes(ADVISOR_BETA_HEADER)) {
  messagesForAPI = stripAdvisorBlocks(messagesForAPI)
}
```

**4단계: `stripExcessMediaItems()`** (`restored-src/src/services/api/claude.ts:956`)

API는 각 요청을 최대 100개의 미디어 항목(이미지 + 문서)으로 제한합니다. 이 기능은 오류를 발생시키는 대신 가장 오래된 메시지부터 시작하여 초과 미디어 항목을 자동으로 제거합니다. 이는 하드 오류를 복구하기 어려운 Cowork/CCD 시나리오에서 중요합니다.

이 파이프라인의 실행 순서는 임의적이지 않습니다. 소스 의견에서는 정규화가 `ensureToolResultPairing`(`restored-src/src/services/api/claude.ts:1272-1276`) 앞에 와야 하는 이유를 설명합니다.

> *"normalizeMessagesForAPI는 최대 20개 위치(분석, 피드백, 공유 등)에서 호출되기 때문에 isToolSearchEnabledNoModelCheck()를 사용하며 그 중 대부분은 모델 컨텍스트가 없습니다."*

이는 구조적 사실을 드러냅니다. `normalizeMessagesForAPI`는 인터페이스가 추가 매개변수를 임의로 받아들일 수 없는 널리 재사용되는 기능입니다. 모델별 후처리(예: 도구 검색 필드 제거)는 이후에 독립적인 단계로 실행되어야 합니다.

### <a href="#334-api-call-phase-see-chapter-5-and-chapter-13"
class="header">3.3.4 API 호출 단계(5장 및 13장 참조)</a>

API 호출은 `attemptWithFallback` 루프(`restored-src/src/query.ts:650-953`)로 래핑됩니다.

``` typescript
let attemptWithFallback = true
while (attemptWithFallback) {
  attemptWithFallback = false
  try {
    for await (const message of deps.callModel({
      messages: prependUserContext(messagesForQuery, userContext),
      systemPrompt: fullSystemPrompt,
      // ...
    })) {
      // Process streaming response messages
    }
  } catch (innerError) {
    if (innerError instanceof FallbackTriggeredError && fallbackModel) {
      currentModel = fallbackModel
      attemptWithFallback = true
      // Clean up orphaned messages, reset executor
      continue
    }
    throw innerError
  }
}
```

여기에서는 몇 가지 우아한 디자인을 주목할 가치가 있습니다.

**메시지 불변성.** 스트리밍 메시지는 생성 전에 복제됩니다. 원본 `message`는 `assistantMessages` 배열로 푸시되고(API로 다시 전송됨) 복제된 버전(백필된 관찰 가능한 입력 포함)은 SDK 호출자에게 생성됩니다. 소스 주석(`restored-src/src/query.ts:744-746`)은 "변경하면 프롬프트 캐싱(바이트 불일치)이 중단됩니다"라는 이유를 직접적으로 설명합니다.

**오류 보류 메커니즘.** 복구 가능한 오류(너무 긴 메시지 표시, 최대 출력 토큰 수, 미디어 크기)는 스트리밍 단계 동안 보류되며 호출자에게 즉시 전달되지 않습니다. 후속 복구 논리에서 복구가 불가능하다고 확인한 경우에만 호출자에게 해제됩니다. 이렇게 하면 SDK 소비자(예: 데스크톱/Cowork)가 세션을 조기에 종료하는 것을 방지할 수 있습니다.

**삭제 표시 처리.** 스트리밍 폴백이 발생하면 부분적으로 생성된 메시지는 삭제 표시(`restored-src/src/query.ts:716-718`)로 삭제하라는 알림을 받습니다. 이는 미묘한 문제를 해결합니다. 부분 메시지(특히 사고 블록)에는 성능 저하 후 API가 "사고 블록을 수정할 수 없음" 오류를 보고하게 하는 서명이 포함되어 있습니다.

### <a href="#335-tool-execution-phase-see-chapter-4" class="header">3.3.5 도구 실행 단계(4장 참조)</a>

모델 응답이 완료된 후 `tool_use` 블록이 있으면 루프는 도구 실행 단계(`restored-src/src/query.ts:1363-1408`)로 들어갑니다.

Claude Code는 두 가지 도구 실행 모드를 지원합니다.

1. **스트리밍 병렬 실행**(`StreamingToolExecutor`): 모델이 스트리밍되는 동안 도구 실행이 시작됩니다. API 호출 단계 동안 각 `tool_use` 블록은 도착 시 실행자(`restored-src/src/query.ts:841-843`)에 `addTool()`'됩니다. 스트리밍이 종료되면 `getRemainingResults()`는 완료된 결과와 보류 중인 결과를 모두 수집합니다.
2. **일괄 실행** (`runTools()`): 모든 tool_use 블록이 먼저 수집된 다음 일괄적으로 실행됩니다.

도구 실행 결과는 `normalizeMessagesForAPI`를 통해 정규화되고 `toolResults` 배열에 추가됩니다.

### <a href="#336-stop-hooks-and-continuation-decision" class="header">3.3.6 Stop Hook과 계속 결정</a>

모델 응답에 tool_use(`needsFollowUp == false`)가 포함되어 있지 않으면 루프가 종료 결정 경로로 들어갑니다. 이 경로에는 여러 계층의 복구 논리 및 후크 검사가 포함됩니다.

**훅 중지**(`restored-src/src/query.ts:1267-1306`):

``` typescript
const stopHookResult = yield* handleStopHooks(
  messagesForQuery, assistantMessages,
  systemPrompt, userContext, systemContext,
  toolUseContext, querySource, stopHookActive,
)
```

중지 후크가 `blockingErrors`를 반환하면 루프는 이러한 오류 메시지를 삽입하고 계속(`transition: { reason: 'stop_hook_blocking' }`)하여 모델에 수정할 기회를 제공합니다. 이는 Claude Code 권한 시스템의 핵심 실행 지점입니다. 16장을 참조하세요.

**토큰 예산 확인** (`restored-src/src/query.ts:1308-1355`):

`TOKEN_BUDGET` 기능이 활성화되면 루프는 현재 턴의 토큰 소비가 예산 내에 있는지 확인합니다. 모델이 "조기 완료"되었지만 예산이 남아 있는 경우 루프는 모델이 계속 작동하도록 격려하는 넛지 메시지(`transition: { reason: 'token_budget_continuation' }`)를 삽입합니다. 이 메커니즘은 또한 "수익률 감소" 감지도 지원합니다. 즉, 모델의 증분 출력이 더 이상 실질적으로 기여하지 않는 경우 예산이 소진되지 않더라도 조기에 중지됩니다.

### <a href="#337-attachment-injection-and-turn-preparation"
class="header">3.3.7 어태치먼트 주입 및 턴 준비</a>

도구 실행이 완료된 후 루프는 다음 차례(`restored-src/src/query.ts:1580-1628`)에 들어가기 전에 부착물을 삽입합니다.

1. **대기 중인 명령 처리**: 현재 에이전트 주소에 대한 전역 명령 대기열에서 명령을 가져와(기본 스레드와 하위 에이전트 구분) 첨부 메시지로 변환합니다.
2. **메모리 프리페치 소비**: 메모리 프리페치(루프 항목에서 `startRelevantMemoryPrefetch`에서 시작됨)가 완료되고 이번 차례에 소비되지 않은 경우 결과를 삽입합니다.
3. **스킬 디스커버리 소비**: 스킬 디스커버리 프리페치가 완료되면 결과 주입

이러한 주입은 모델 스트리밍 및 도구 실행의 대기 시간을 활용합니다. 백그라운드에서 병렬로 실행되며 일반적으로 이 시점에 완료됩니다.

## <a href="#34-abortretrydegradation" class="header">3.4 중단/재시도/성능 저하</a>

### <a href="#341-fallbacktriggerederror-and-model-switching"
class="header">3.4.1 FallbackTriggeredError 및 모델 전환</a>

높은 로드 또는 유사한 이유로 인해 API 호출이 실패하면 `FallbackTriggeredError`가 발생합니다(`restored-src/src/query.ts:894-950`). 처리 흐름:

1. `currentModel`를 `fallbackModel`로 전환하세요.
2. `assistantMessages`, `toolResults`, `toolUseBlocks` 지우기
3. `StreamingToolExecutor`를 폐기하고 다시 빌드합니다(고립된 tool_result 누출 방지).
4. `toolUseContext.options.mainLoopModel` 업데이트
5. Strip Thinking 서명 블록(모델에 바인딩되어 있으며 성능이 저하된 모델에서 400 오류가 발생하기 때문)
6. 사용자에게 알리는 시스템 메시지 생성

결정적으로 이러한 성능 저하가 `attemptWithFallback` 루프 내부에서 발생합니다. `attemptWithFallback = true` 및 `continue`를 설정하고 동일한 반복 내에서 즉시 재시도하므로 외부 `while (true)` 루프를 다시 입력할 필요가 없습니다.

### <a href="#342-max_output_tokens-recovery-three-chances"
class="header">3.4.2 max_output_tokens 복구: 세 가지 기회</a>

모델 출력이 잘리면 복구 전략에는 두 가지 계층이 있습니다.

**레이어 1: 에스컬레이션.** 현재 기본 8k 제한을 사용하고 재정의가 적용되지 않은 경우 `maxOutputTokensOverride`를 64k(`ESCALATED_MAX_TOKENS`)로 직접 설정하고 동일한 요청을 다시 시도하세요. 이것은 "무료" 복구입니다. 여러 차례 대화가 필요하지 않습니다.

**레이어 2: 다중 턴 복구.** 에스컬레이션 후에도 잘림이 지속되면 메타 메시지를 삽입합니다.

"출력 토큰 한도에 도달했습니다. 바로 재개하세요. 사과도 없고, 하고 있던 일을 요약하지도 않습니다. 컷이 발생한 곳이라면 중간에 생각해 보세요. 남은 작업을 더 작은 조각으로 나눕니다."

이 메시지는 사과 없음(토큰 낭비), 요약 없음(정보 반복), 작업 중단(출력당 수요 감소) 등 신중하게 표현되었습니다. 최대 3회 재시도(`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`, `restored-src/src/query.ts:164`).

### <a
href="#343-reactive-compact-the-last-line-of-defense-for-prompt-too-long"
class="header">3.4.3 리액티브 컴팩트: 너무 긴 프롬프트에 대한 최후의 방어선</a>

API가 프롬프트가 너무 긴 오류를 반환하는 경우 복구 전략에도 두 가지 계층이 있습니다.

1. **컨텍스트 축소 드레이닝**: 모든 단계적 컨텍스트 축소를 제출하려는 첫 번째 시도입니다. 이는 세분화된 컨텍스트를 유지하는 저렴한 작업입니다.
2. **리액티브 컴팩트**: 배수가 충분하지 않은 경우 전체 반응 컴팩트를 실행합니다. 재시도 사망 루프를 방지하려면 `hasAttemptedReactiveCompact = true`를 표시하세요.

둘 다 실패하면 오류가 호출자에게 공개되고 루프가 종료됩니다. 소스 설명에서는 여기서 중지 후크를 실행할 수 없는 이유를 특히 강조합니다(`restored-src/src/query.ts:1169-1172`).

> *"후크를 중지하기 위해 넘어지지 마십시오. 모델이 유효한 응답을 생성하지 않았으므로 후크를 평가할 의미가 없습니다. 너무 긴 프롬프트에서 중지 후크를 실행하면 죽음의 나선이 생성됩니다. 오류 -\> 후크 차단 -\> 재시도 -\> 오류 -\> ..."*

## <a href="#35-single-iteration-sequence-diagram" class="header">3.5 단일 반복 시퀀스 다이어그램</a>

사용자 queryLoop 전처리 API 도구 StopHooks │ │ │ │ │ │ │ 메시지 │ │ │ │ │ │───────────────>│ │ │ │ │ │ │ │ │ │ │ applyToolResult │ │ │ │ │ │ 예산 │ │ │ │ │ │─────────────────>│ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │────────────────>│ │ │ │ │ │ │ │ │ │ 마이크로컴팩트 │ │ │ │ │ │─────────────────>│ │ │ │ │ │ │ │ │ │ │ context접기 │ │ │ │ │─────────────────>│ │ │ │ │ │ │ │ │ │ 자동 압축 │ │ │ │ │ │─────────────────>│ │ │ │ │ │ 메시지ForQuery│ │ │ │ │ │<─────────────────│              │              │              │
     │                │                  │              │              │              │
     │                │ prependUserContext               │              │              │
     │                │ appendSystemContext              │              │              │
     │                │                  │              │              │              │
     │                │  callModel(...)  │              │              │              │
     │                │────────────────────────────────>│ │ │ │ │ │ │ │ │ │ 스트림 메시지 │ │ │ │ │<───────────────│<────────────────────────────────│              │              │
     │  (yield)       │                  │              │              │              │
     │                │                  │              │  tool_use?   │              │
     │                │                  │              │              │              │
     │                │──────── needsFollowUp ─────────────────────────>│ │ │ │ runTools / StreamingToolExecutor │ │ │<───────────────│<───────────────────────────────────────────────│              │
     │  (yield results)                  │              │              │              │
     │                │                  │              │              │              │
     │                │  attachments (memory, skills, commands)        │              │
     │                │                  │              │              │              │
     │                │   state = { reason: 'next_turn', ... }        │              │
     │                │   continue ──────────────────────────> 다음 반복 │ │ │ │ │ │ │ ──── OR ── needFollowUp == false ──────────────────>│ │ │ │ │ │ │ │ handlerStopHooks │ │ │ │ │ │────────────────────────────────────────────────────────>│ │ │ 차단 오류? │ │ │ │ │ │<───────────────────────────────────────────────────────────│
     │                │                  │              │              │              │
     │                │  return { reason: 'completed' }│              │              │
     │<───────────────│                  │              │              │              │

## <a href="#36-pattern-extraction" class="header">3.6 패턴 추출</a>

`queryLoop()` 소스 코드의 1,730줄을 읽은 후 몇 가지 심층적인 패턴이 나타납니다.

### <a
href="#pattern-1-explicit-state-reconstruction-over-incremental-modification"
class="header">패턴 1: 증분 수정에 대한 명시적 상태 재구성</a>

모든 `continue` 사이트는 완전히 새로운 `State` 개체를 구성합니다. `state.maxOutputTokensRecoveryCount++`는 없고 `state = { ..., maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1, ... }`만 있습니다. 이는 세 가지 이점을 제공합니다.

1. **면책 상실**: 필드 재설정을 잊는 것은 불가능합니다.
2. **감사 가능성**: 각 연속 지점의 전체 의도는 단일 객체 리터럴에서 볼 수 있습니다.
3. **테스트 가능성**: `transition` 필드를 사용하면 복구 경로가 실제로 실행되었는지 여부를 테스트할 수 있습니다.

### <a href="#pattern-2-withhold-release" class="header">패턴 2: 보류-해제</a>

복구 가능한 오류는 소비자에게 즉시 노출되지 않습니다. 보류(`assistantMessages`로 푸시되지만 양보되지 않음)되며 모든 복구 수단이 소진된 경우에만 해제됩니다. 이 패턴은 실제 문제를 해결합니다. SDK 소비자(Desktop, Cowork)는 오류를 발견하면 세션을 종료합니다. 복구가 성공하면 조기에 오류를 노출하는 것은 불필요한 중단이었습니다.

### <a href="#pattern-3-light-to-heavy-layered-recovery"
class="header">패턴 3: 가벼운 수준에서 무거운 수준의 계층형 복구</a>

컨텍스트 압축(snip -\> microcompact -\>collapse -\> autocompact)이든 오류 복구(escalate -\> multi-turn -\> Reactive Compact)이든 전략은 항상 가장 가벼운 수단(최소 정보 손실)에서 시작하여 점진적으로 확대됩니다. 이는 단순한 성능 최적화가 아니라 정보 보존 전략입니다. 각 수준은 "최대 공간에 대한 최소 비용"을 거래합니다.

### <a href="#pattern-4-background-parallelizations-sliding-window"
class="header">패턴 4: 배경 병렬화의 슬라이딩 윈도우</a>

메모리 프리페치는 루프 항목에서 시작되고, 도구 요약은 도구 실행 후 비동기적으로 시작되고, 기술 검색은 반복 시작 시 비동기적으로 시작됩니다. 모델이 스트리밍 응답을 생성하는 동안 5~30초 동안 모두 완료됩니다. 이 "대기 중 준비 작업 완료" 패턴은 대기 시간을 거의 눈에 띄지 않게 숨깁니다.

### <a href="#pattern-5-death-loop-protection-via-single-attempt-guards"
class="header">패턴 5: 단일 시도 가드를 통한 죽음의 고리 보호</a>

`hasAttemptedReactiveCompact`, `maxOutputTokensRecoveryCount`, `state.transition?.reason !== 'collapse_drain_retry'` — 이 가드는 각 복구 전략이 최대 한 번(또는 제한된 횟수) 실행되도록 보장합니다. `while (true)` 루프에서는 이러한 가드가 없으면 무한 루프에 대한 초대입니다. 소스 댓글(`restored-src/src/query.ts:1171`, `1295`)에서 반복되는 "죽음의 나선"이라는 문구는 이것이 이론적인 문제가 아님을 나타냅니다. 이 경비원은 실제 생산 사고에서 배웠습니다.

## <a href="#what-you-can-do" class="header">당신이 할 수 있는 일</a>

자체 AI 에이전트 시스템을 구축하는 경우 `queryLoop()`의 디자인에서 직접 빌릴 수 있는 사례는 다음과 같습니다.

- **모든 복구 전략에 대해 단일 시도 보호를 설정합니다.** `while (true)` 루프에서 모든 자동 복구(압축, 재시도, 성능 저하)에는 무한 루프를 방지하기 위해 부울 플래그 또는 카운터가 있어야 합니다. 의도를 명확하게 하기 위해 이름을 `hasAttempted*`로 지정합니다.
- **"가벼운 것부터 무거운 것까지" 계층화된 압축 전략을 채택하십시오.** 컨텍스트가 한계를 초과하는 경우 곧바로 전체 요약으로 넘어가지 마십시오. 먼저 오래된 메시지를 잘라내고(snip), 마이크로 압축하고 축소한 다음 전체 압축(자동 압축)을 시도합니다. 각 레이어는 가능한 한 많은 컨텍스트 정보를 보존합니다.
- **증분 수정을 전체 상태 재구성으로 대체합니다.** 루프의 모든 `continue` 사이트에서 필드를 하나씩 수정하는 대신 완전히 새로운 상태 개체를 구성합니다. 이는 특히 연속 경로가 여러 개인 경우 "필드를 재설정하는 것을 잊음" 버그 클래스를 제거합니다.
- **복구 가능한 오류를 보류합니다.** 기회가 있을 때마다 상위 수준 소비자에게 오류를 노출하지 마세요. 먼저 모든 복구 수단을 시도해 보십시오. 모든 시도가 실패한 후에만 오류를 해제하십시오. 이는 상위 계층이 오류를 발견했을 때 세션을 조기에 종료하는 것을 방지합니다.
- **병렬 프리페치를 위해 모델 응답 대기 창을 활용합니다.** API 호출과 동시에 메모리 프리페치, 기술 검색 및 기타 비동기 작업을 시작합니다. 모델이 응답을 생성하는 동안 5~30초는 "무료" 계산 시간입니다.
- **전환 이유를 기록합니다.** 루프가 해당 상태에서 계속되는 이유를 기록합니다(예: `next_turn`, `reactive_compact_retry`). 이는 디버깅에 도움이 되며 자동화된 테스트를 통해 특정 복구 경로가 트리거되었는지 여부를 확인할 수 있습니다.

## <a href="#37-chapter-summary" class="header">3.7 장 요약</a>

`queryLoop()`는 클로드 코드의 심장박동입니다. 단순히 사용자와 모델 간에 메시지를 전달하는 것이 아닙니다. 대신 컨텍스트 용량을 적극적으로 관리하고, 도구 실행을 조정하고, 오류 복구를 처리하고, 반복할 때마다 권한 확인을 실행합니다. 이 루프의 토폴로지와 전환 의미 체계를 이해하면 이후 장에서 설명하는 모든 하위 시스템(자동 압축(9장), API 호출 구성(5장), 스트리밍 응답 처리(13장), 권한 확인(16장))이 호출되는 정확한 위치와 타이밍에서 멘탈 모델에 정확하게 위치할 수 있습니다.

이 루프의 가장 심오한 디자인 특징은 실패할 수도 있다는 것을 알고 이에 대비한다는 것입니다. 낙관적인 '만약 모든 일이 잘된다면'의 길이 아니라, '일이 잘못됐을 때 어떻게 우아하게 회복할 것인가'에 대한 방어적인 설계입니다. 이것이 바로 데모 수준의 AI 채팅 인터페이스를 프로덕션 수준의 AI 에이전트로 변환하는 핵심 엔지니어링 결정입니다.
