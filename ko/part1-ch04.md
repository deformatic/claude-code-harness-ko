# <a
href="#chapter-4-tool-execution-orchestration--permissions-concurrency-streaming-and-interrupts"
class="header">4장: 도구 실행 오케스트레이션 - 권한, 동시성, 스트리밍 및 인터럽트</a>

> **포지셔닝**: 이 장에서는 CC가 파티션 스케줄링, 권한 결정 체인, 스트리밍 실행기 및 대규모 결과 지속성과 같은 도구 호출을 동시에 실행하는 방법을 분석합니다. 전제 조건: 2장(도구 시스템), 3장(에이전트 루프). 대상 독자: CC가 도구 호출, 권한 확인 및 스트리밍 출력을 동시에 실행하는 방법을 이해하려는 독자.

> 3장에서는 Agent Loop의 전체 수명주기를 분석했습니다. 모델이 `tool_use` 유형의 콘텐츠 블록을 반환하면 루프는 "도구 실행 단계"로 들어갑니다. 이 장에서는 이 단계의 내부 구현, 즉 도구 호출을 분할하고 예약하는 방법, 단일 도구 실행이 거치는 수명주기 단계, 권한 결정 체인이 계층별로 필터링하는 방법, 큰 결과가 유지되는 방법, 스트리밍 실행기가 동시성과 인터럽트를 처리하는 방법에 대해 자세히 설명합니다.

## <a href="#41-why-tool-execution-orchestration-is-critical"
class="header">4.1 도구 실행 조정이 중요한 이유</a>

단일 에이전트 루프 반복에서 모델은 여러 도구 호출을 동시에 요청할 수 있습니다. 예를 들어, 모델은 서로 다른 파일을 읽기 위해 세 번의 `Read` 호출을 발행한 다음 테스트를 실행하기 위해 `Bash` 호출을 발행할 수 있습니다. 이러한 호출은 모두 병렬로 실행될 수 없습니다. 읽기 작업은 안전하지만 `git checkout`가 작업 디렉터리 상태를 변경하여 병렬 읽기가 일관되지 않은 결과를 얻을 수 있습니다.

Claude Code의 도구 오케스트레이션 계층은 세 가지 핵심 문제를 해결합니다.

1. **안전한 동시성**: 읽기 전용 도구를 병렬로 실행하여 처리량을 향상할 수 있습니다. 쓰기 도구는 일관성을 보장하기 위해 순차적으로 실행되어야 합니다.
2. **권한 게이팅**: 모든 도구는 실행 전에 권한 결정 체인을 통과해야 하므로 사용자가 위험한 작업을 계속 제어할 수 있습니다.
3. **결과 관리**: 도구 출력이 엄청날 수 있으므로(`cat` 명령은 수십만 개의 문자를 반환할 수 있음) 컨텍스트 창 오버플로를 방지하기 위해 지능적인 트리밍이 필요합니다.

이 세 가지 문제에 대한 솔루션은 `toolOrchestration.ts`(배치 예약), `toolExecution.ts`(단일 도구 수명 주기) 및 `StreamingToolExecutor.ts`(스트리밍 동시 실행기)의 세 가지 핵심 파일에 분산되어 있습니다.

## <a href="#42-partitiontoolcalls-tool-call-partitioning"
class="header">4.2 partitionToolCalls: 도구 호출 분할</a>

### <a href="#421-the-partitioning-algorithm" class="header">4.2.1 분할 알고리즘</a>

에이전트 루프가 `ToolUseBlock` 배치를 오케스트레이션 계층에 전달하는 경우 첫 번째 단계는 이를 "동시성 안전 배치"와 "직렬 배치"로 번갈아 분할하는 것입니다. 이는 `partitionToolCalls` 기능의 책임입니다.

``` mermaid
flowchart TD
    Input["Model's tool call sequence (in order)<br/>[Read A] [Read B] [Grep C] [Bash D] [Read E] [Edit F]"]
    Input -->|partitionToolCalls| B1
    B1["Batch 1 (concurrency-safe)<br/>Read A, Read B, Grep C<br/>Three read-only tools merged into one batch"]
    B1 --> B2["Batch 2 (serial)<br/>Bash D<br/>Write tool gets exclusive batch"]
    B2 --> B3["Batch 3 (concurrency-safe)<br/>Read E<br/>New read-only batch"]
    B3 --> B4["Batch 4 (serial)<br/>Edit F<br/>Write tool gets exclusive batch"]

    style B1 fill:#d4edda,stroke:#28a745
    style B3 fill:#d4edda,stroke:#28a745
    style B2 fill:#f8d7da,stroke:#dc3545
    style B4 fill:#f8d7da,stroke:#dc3545
```

**그림 4-1: partitionToolCalls 파티셔닝 논리.** 연속적인 동시성 안전 도구는 동일한 배치(녹색)로 병합됩니다. 동시성이 안전하지 않은 도구는 각각 고유한 배타적 배치(빨간색)를 갖습니다.

분할 논리의 핵심은 `reduce` 작업(`restored-src/src/services/tools/toolOrchestration.ts:91-116`)입니다.

``` typescript
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data))
          } catch {
            return false  // Conservative strategy: parse failure = unsafe
          }
        })()
      : false
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)  // Merge into previous concurrent batch
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })  // Create new batch
    }
    return acc
  }, [])
}
```

주요 설계 결정:

- **분류 전 검증**: 입력은 `isConcurrencySafe`가 호출되기 전에 Zod 스키마 검증을 통과해야 합니다. 모델이 잘못된 입력을 생성하는 경우 도구는 동시성이 안전하지 않은 것으로 보수적으로 표시됩니다.
- **예외는 안전하지 않음을 의미**: `isConcurrencySafe` 자체에서 예외가 발생하는 경우(예: `shell-quote`가 Bash 명령을 구문 분석하지 못함) 직렬 실행으로 대체됩니다. 이는 전형적인 "실패 시 폐쇄" 보안 패턴입니다.
- **탐욕스러운 병합**: 안전하지 않은 도구가 발견될 때까지 연속적인 동시성 안전 도구가 동일한 배치로 병합됩니다. 이는 병렬성을 최대화하면서 상대 호출 순서를 유지합니다.

### <a href="#422-isconcurrencysafe-determination-logic"
class="header">4.2.2 isConcurrencySafe 결정 논리</a>

`isConcurrencySafe`는 `false`(`restored-src/src/Tool.ts:759`)를 반환하는 기본 구현을 사용하여 `Tool` 인터페이스(`restored-src/src/Tool.ts:402`)의 필수 메서드입니다. 각 도구는 의미 체계에 따라 자체 구현을 제공합니다.

<div class="table-wrapper">

| 도구 | 동시성이 안전한가요? | 이유 |
|----|----|----|
| FileRead, Glob, Grep | 항상 `true` | 순수한 읽기, 부작용 없음 |
| Bash도구 | 명령에 따라 다름 | `isReadOnly(input)`에 위임하고 명령이 읽기 전용인지 분석합니다. |
| 파일편집, 파일쓰기 | `false` | 파일 시스템 수정 |
| AgentTool | `false` | 하위 에이전트를 생성하고 상태를 수정할 수 있습니다. |

</div>

`BashTool`를 예로 들면(`restored-src/src/tools/BashTool/BashTool.tsx:434-436`):

``` typescript
isConcurrencySafe(input) {
  return this.isReadOnly?.(input) ?? false;
},
```

Bash 도구의 동시성 안전성은 전적으로 명령 내용에 따라 달라집니다. `ls`, `cat`, `git log`는 안전하지만 `rm`, `git checkout`, `npm install`는 안전하지 않습니다. `isReadOnly`는 명령 구조를 구문 분석하여 이러한 결정을 내립니다.

## <a href="#43-runtools-the-batch-scheduling-engine" class="header">4.3 runTools: 배치 예약 엔진</a>

`runTools`(`restored-src/src/services/tools/toolOrchestration.ts:19-82`)는 오케스트레이션 레이어의 진입점입니다. 이는 분할된 배치를 반복하여 동시성이 안전한 배치의 경우 `runToolsConcurrently`를 호출하고 직렬 배치의 경우 `runToolsSerially`를 호출합니다.

### <a href="#431-concurrent-execution-path" class="header">4.3.1 동시 실행 경로</a>

동시 경로는 `all()` 유틸리티 함수(`restored-src/src/utils/generators.ts:32`)를 사용하여 동시성 제한을 통해 여러 비동기 생성기를 하나로 병합합니다.

``` typescript
async function* runToolsConcurrently(...) {
  yield* all(
    toolUseMessages.map(async function* (toolUse) {
      yield* runToolUse(toolUse, ...)
      markToolUseAsComplete(toolUseContext, toolUse.id)
    }),
    getMaxToolUseConcurrency(),  // Default 10, overridable via env var
  )
}
```

동시성 한도는 환경 변수 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`(`restored-src/src/services/tools/toolOrchestration.ts:8-11`)를 통해 구성되며 기본값은 10입니다.

중요한 세부 사항은 **컨텍스트 수정자의 적용 지연**입니다. 동시에 실행되는 도구는 각각 컨텍스트 수정(예: 사용 가능한 도구 목록 업데이트)을 생성할 수 있지만 이러한 수정은 동시 실행 중에 즉시 적용될 수 없으므로 경쟁 조건이 발생할 수 있습니다. 따라서 수정자는 전체 동시 배치가 완료된 후(`restored-src/src/services/tools/toolOrchestration.ts:31-63`) 도구 표시 순서에 따라 순차적으로 대기열에 수집되고 적용됩니다.

### <a href="#432-serial-execution-path" class="header">4.3.2 직렬 실행 경로</a>

직렬 경로는 각 도구를 순서대로 직접 실행하여 각 실행 후 즉시 컨텍스트 수정 사항을 적용합니다.

``` typescript
for (const toolUse of toolUseMessages) {
  for await (const update of runToolUse(toolUse, ...)) {
    if (update.contextModifier) {
      currentContext = update.contextModifier.modifyContext(currentContext)
    }
    yield { message: update.message, newContext: currentContext }
  }
}
```

이는 쓰기 도구가 이전 도구에 의해 수정된 컨텍스트 상태를 볼 수 있음을 보장합니다.

## <a href="#44-single-tool-execution-lifecycle" class="header">4.4 단일 도구 실행 수명주기</a>

동시 또는 직렬 경로를 통해 모든 도구 호출은 궁극적으로 `runToolUse`(`restored-src/src/services/tools/toolExecution.ts:337`) 및 `checkPermissionsAndCallTool`(`restored-src/src/services/tools/toolExecution.ts:599`)로 들어갑니다. 이 두 기능은 단일 도구의 전체 수명주기를 구성합니다.

┌─────────────────────────────────────────────────────────────┐ │ 단일 도구 실행 수명 주기 │ │ │ │ ① 도구 조회 ──→ ② 스키마 유효성 검사 ──→ ③ 입력 유효성 검사 │ │ │ │ │ │ │ 도구를 찾을 수 없습니까? 유효성 검사에 실패했나요? 유효성 검사에 실패했나요?          │ │ ↓ 반환 오류 ↓ 반환 오류 ↓ 반환 오류 │ │ │ │ ④ PreToolUse Hooks ──→ 5 권한 결정 ──→ 6 tool.call() │ │ │ │ │ │ │ Hook이 차단되었습니까?        허가가 거부되었나요? 실행 오류?       │ │ ↓ 반환 오류 ↓ 반환 오류 ↓ 반환 오류 │ │ │ │ 7 결과 매핑 ──→ 8 큰 결과 지속성 ──→ 9 PostToolUse 후크 │ │ │ │ │ 후크가 계속을 방해합니까?    │ │ ↓ 후속 루프 중지 │ └──────────────────────────────────────────────────────────────────┘

**그림 4-2: 단일 도구 수명 주기 흐름.** 각 단계에서는 흐름을 종료하는 오류 메시지가 생성될 수 있습니다. 성공 경로는 왼쪽에서 오른쪽으로 9단계를 모두 통과합니다.

### <a href="#441-phase-1-tool-lookup-and-input-validation"
class="header">4.4.1 1단계: 도구 조회 및 입력 검증</a>

`runToolUse`는 먼저 사용 가능한 도구 세트(`restored-src/src/services/tools/toolExecution.ts:345-356`)에서 대상 도구를 검색합니다. 찾을 수 없는 경우 더 이상 사용되지 않는 도구 별칭도 확인합니다. 이렇게 하면 이전 세션 기록의 도구 호출이 계속 실행될 수 있습니다.

입력 유효성 검사에는 두 단계가 있습니다.

1. **스키마 검증**: 모델의 출력 매개변수(`restored-src/src/services/tools/toolExecution.ts:615-616`)에 대한 유형 검사를 위해 Zod의 `safeParse`를 사용합니다. 모델 생성 매개변수 유형이 항상 올바른 것은 아닙니다. 예를 들어 배열이어야 하는 매개변수에 대한 문자열을 출력할 수 있습니다.

2. **의미론적 검증**: `tool.validateInput()`(`restored-src/src/services/tools/toolExecution.ts:683-684`)를 통한 도구별 비즈니스 로직 검증. 예를 들어 FileEdit 도구는 대상 파일이 존재하는지 확인할 수 있습니다.

주목할만한 세부 사항: 도구가 지연된 도구이고 해당 스키마가 API로 전송되지 않은 경우 시스템은 재시도하기 전에 먼저 `ToolSearch`를 통해 도구 스키마를 로드하도록 모델을 안내하는 Zod 오류 메시지에 힌트를 추가합니다(`restored-src/src/services/tools/toolExecution.ts:578-597`).

### <a href="#442-phase-2-speculative-classifier-launch"
class="header">4.4.2 2단계: 추측 분류기 출시</a>

권한 확인을 시작하기 전에 현재 도구가 Bash 도구인 경우 시스템은 **추측적으로 허용 분류자**(추측적 분류자 확인, `restored-src/src/services/tools/toolExecution.ts:740-752`)를 시작합니다. 이 분류자는 PreToolUse Hooks와 병렬로 실행되므로 사용자가 권한 결정을 내려야 할 때 결과가 이미 준비되어 있을 수 있습니다. 이는 사용자가 분류자 대기 시간을 기다리지 않도록 하는 최적화입니다.

### <a href="#443-phase-3-pretooluse-hooks" class="header">4.4.3 3단계: PreToolUse 후크</a>

시스템은 등록된 모든 `PreToolUse` 후크(`restored-src/src/services/tools/toolExecution.ts:800-862`)를 실행합니다. 후크는 다음과 같은 효과를 생성할 수 있습니다.

- **입력 수정**: 원래 매개변수를 바꾸려면 `updatedInput`를 반환하세요.
- **권한 결정**: `allow`, `deny` 또는 `ask`를 반환하여 후속 권한 확인에 영향을 줍니다.
- **실행 차단**: `preventContinuation` 플래그를 설정합니다.
- **컨텍스트 추가**: 모델 참조를 위한 추가 정보 삽입

중단 신호로 인해 후크 실행이 중단되면 시스템은 즉시 종료되고 취소 메시지를 반환합니다.

### <a href="#444-phase-4-permission-decision-chain" class="header">4.4.4 4단계: 허가 결정 체인</a>

권한 시스템은 도구 실행 수명 주기에서 가장 복잡한 부분입니다. 의사결정 체인은 다음 우선순위에 따라 `resolveHookPermissionDecision`(`restored-src/src/services/tools/toolHooks.ts:332-433`)에 의해 조정됩니다.

┌──────────────────────────────────────────────────────────────┐ │ 권한 결정 체인 │ │ │ PreToolUse 후크 결정 │ │ ├─ 허용 ──→ 규칙 권한 확인(settings.json 거부/요청) │ │ │ ├─ 일치 규칙 없음 ──→ 허용(사용자 프롬프트 건너뛰기) │ │ │ ├─ 규칙 거부 ──→ 거부(규칙이 후크보다 우선) │ │ │ └─ 규칙 묻기 ──→ 사용자에게 프롬프트(규칙이 후크보다 우선) │ │ ├─ 거부 ──→ 직접 거부 │ │ └─ 질문 ──→ 일반 권한 입력 흐름(후크 사용 │ │ forceDecision) │ │ │ │ 후크 결정 없음 ──→ 일반 권한 흐름 │ │ ├─ 도구 자체 checkPermissions │ │ ├─ 일반 규칙 일치(settings.json) │ │ ├─ YOLO/자동 분류자(17장 참조) │ │ └─ 사용자 대화형 프롬프트(16장 참조) │ └──────────────────────────────────────────────────────────────┘

**그림 4-3: 권한 결정 체인 다이어그램.** Hook의 `allow`는 settings.json의 `deny` 규칙을 재정의할 수 없습니다. 이는 심층 방어가 실행되는 것입니다.

결정 체인의 주요 불변성: **Hook의 `allow` 결정은 settings.json의 거부/요청 규칙을 우회할 수 없습니다**. 후크가 작업을 승인하더라도 settings.json에 명시적 거부 규칙이 포함되어 있으면 작업이 계속 거부됩니다. 이를 통해 사용자가 구성한 보안 경계가 항상 유효합니다(`restored-src/src/services/tools/toolHooks.ts:373-405`).

권한 시스템의 전체 아키텍처는 16장에서 다룹니다. YOLO 분류기 구현은 17장에서 다룹니다.

### <a href="#445-phase-5-tool-execution" class="header">4.4.5 5단계: 도구 실행</a>

권한이 통과된 후 시스템은 `tool.call()`(`restored-src/src/services/tools/toolExecution.ts:1207-1222`)를 호출합니다. 활성 세션 상태를 추적하기 위해 `startSessionActivity('tool_exec')`와 `stopSessionActivity('tool_exec')` 사이에 실행이 래핑됩니다.

도구 실행 중 진행 이벤트는 `Stream` 개체(`restored-src/src/services/tools/toolExecution.ts:509`)를 통해 전달됩니다. `streamedCheckPermissionsAndCallTool`는 `checkPermissionsAndCallTool` Promise 결과와 실시간 진행 이벤트를 동일한 비동기 반복 가능 항목으로 병합하여 호출자가 진행 업데이트와 최종 결과를 모두 받을 수 있도록 합니다.

### <a href="#446-phase-6-posttooluse-hooks-and-result-processing"
class="header">4.4.6 6단계: PostToolUse 후크 및 결과 처리</a>

도구 실행이 성공적으로 완료되면 시스템은 다음을 순차적으로 수행합니다.

1. **결과 매핑**: `tool.mapToolResultToToolResultBlockParam()`(`restored-src/src/services/tools/toolExecution.ts:1292-1293`)를 통해 도구 출력을 API 형식으로 변환합니다.
2. **대규모 결과 지속성**: 결과가 임계값을 초과하면 이를 디스크에 기록하고 요약으로 대체합니다(섹션 4.6 참조).
3. **PostToolUse Hooks**: MCP 도구 출력을 수정하거나 후속 루프 연속을 방지할 수 있는 포스트 후크를 실행합니다(`restored-src/src/services/tools/toolExecution.ts:1483-1531`).

MCP 도구의 경우 후크는 `updatedMCPToolOutput`를 반환하여 도구 출력을 수정할 수 있습니다. 이 수정 사항은 `addToolResult` 호출 전에 적용되므로 수정된 버전이 메시지 기록에 저장됩니다. 비MCP 도구의 경우 결과 매핑은 후크 전에 완료되므로 후크는 정보를 추가만 할 수 있고 결과를 수정할 수는 없습니다.

도구 실행이 실패하면 시스템은 대신 `PostToolUseFailure` 후크(`restored-src/src/services/tools/toolExecution.ts:1700-1713`)를 실행하여 후크가 오류를 검사하고 추가 컨텍스트를 주입할 수 있도록 합니다.

## <a href="#45-streamingtoolexecutor-the-streaming-concurrent-executor"
class="header">4.5 StreamingToolExecutor: 스트리밍 동시 실행자</a>

위에 설명된 `runTools`는 배치 모드에서 작동합니다. 즉, 파티셔닝 및 실행을 시작하기 전에 모든 `tool_use` 블록이 도착할 때까지 기다립니다. 그러나 스트리밍 응답 시나리오에서는 도구 호출 블록이 API 스트림에서 하나씩 구문 분석됩니다. `StreamingToolExecutor`(`restored-src/src/services/tools/StreamingToolExecutor.ts`)는 다른 전략을 구현합니다. **모든 것이 준비될 때까지 기다리지 않고 도구 호출이 도착하자마자 실행을 시작합니다**.

### <a href="#451-state-machine-model" class="header">4.5.1 상태 머신 모델</a>

`StreamingToolExecutor`는 각 도구에 대해 4가지 상태의 수명주기를 유지합니다.

대기 중 ──→ 실행 ──→ 완료 ──→ 양보

- **대기 중**: 도구가 등록되었지만 아직 시작되지 않았습니다.
- **실행 중**: 현재 실행 중인 도구
- **완료**: 도구 완료, 결과 버퍼링
- **yielded**: 호출자가 결과를 소비함

상태 전환은 `processQueue()`(`restored-src/src/services/tools/StreamingToolExecutor.ts:140-151`)에 의해 구동됩니다. 도구가 완료되거나 새 도구가 대기열에 포함될 때마다 대기열 프로세서가 깨어나 다음 실행 가능한 도구를 시작하려고 시도합니다.

### <a href="#452-concurrency-control" class="header">4.5.2 동시성 제어</a>

`canExecuteTool` 메서드(`restored-src/src/services/tools/StreamingToolExecutor.ts:129-135`)는 핵심 동시성 전략을 구현합니다.

``` typescript
private canExecuteTool(isConcurrencySafe: boolean): boolean {
  const executingTools = this.tools.filter(t => t.status === 'executing')
  return (
    executingTools.length === 0 ||
    (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
  )
}
```

규칙은 간결합니다.

- 실행 중인 도구가 없으면 모든 도구를 시작할 수 있습니다.
- 도구가 실행 중인 경우 새 도구는 자체 도구와 현재 실행 중인 모든 도구가 동시성이 안전한 경우에만 시작할 수 있습니다.
- 동시성에 안전하지 않은 도구에는 독점적인 액세스가 필요합니다.

### <a href="#453-bash-error-cascade-abort" class="header">4.5.3 Bash 오류 계단식 중단</a>

`StreamingToolExecutor`는 우아한 오류 처리 메커니즘을 구현합니다. 즉, Bash 도구에 오류가 발생하면 모든 형제 병렬 Bash 도구가 취소됩니다(`restored-src/src/services/tools/StreamingToolExecutor.ts:357-363`).

``` typescript
if (tool.block.name === BASH_TOOL_NAME) {
  this.hasErrored = true
  this.erroredToolDescription = this.getToolDescription(tool)
  this.siblingAbortController.abort('sibling_error')
}
```

이 디자인은 실용적인 관찰을 기반으로 합니다. Bash 명령에는 일반적으로 암시적 종속성 체인이 있습니다. `mkdir`가 실패하면 후속 `cp` 명령도 실패하게 됩니다. 각 명령이 독립적으로 오류를 보고하도록 하는 대신 사전에 취소하는 것이 좋습니다. 그러나 이 전략은 **Bash 도구에만 적용됩니다** — `Read`, `WebFetch` 및 유사한 도구는 독립적입니다. 한 사람의 실패가 다른 사람에게 영향을 주어서는 안 됩니다.

오류 계단식은 `toolUseContext.abortController`의 하위 컨트롤러인 `siblingAbortController`를 사용합니다. 형제 컨트롤러를 중단하면 실행 중인 하위 프로세스가 취소되지만 상위 컨트롤러는 중단되지 않습니다. 즉, 에이전트 루프 자체는 단일 Bash 오류로 인해 현재 턴을 종료하지 않습니다.

### <a href="#454-interrupt-behavior" class="header">4.5.4 인터럽트 동작</a>

각 도구는 자체 인터럽트 동작(`'cancel'` 또는 `'block'`(`restored-src/src/Tool.ts:416`))을 선언할 수 있습니다. 사용자가 인터럽트 신호를 보낼 때:

- **취소** 도구: 즉시 취소 메시지를 받습니다. 결과는 합성된 REJECT_MESSAGE로 대체됩니다.
- **차단** 도구: 완료될 때까지 계속 실행(인터럽트에 응답하지 않음)

`StreamingToolExecutor`는 현재 실행 중인 모든 도구가 `updateInterruptibleState()`(`restored-src/src/services/tools/StreamingToolExecutor.ts:254-259`)를 통해 중단 가능한지 여부를 추적합니다. 이 정보는 UI 레이어로 전달되어 "취소하려면 ESC를 누르세요."를 표시할지 여부를 결정합니다.

### <a href="#455-immediate-delivery-of-progress-messages"
class="header">4.5.5 진행 메시지의 즉각적인 전달</a>

일반 도구 결과는 순서대로 전달되어야 하지만(순서 의미 보존) **진행 메시지는 즉시 전달될 수 있습니다**(`restored-src/src/services/tools/StreamingToolExecutor.ts:417-420`). `StreamingToolExecutor`는 별도의 `pendingProgress` 대기열에 진행 메시지를 저장합니다. `getCompletedResults()`는 도구 완료 순서에 구애받지 않고 도구 목록을 스캔할 때 먼저 진행 메시지를 표시합니다.

완료된 결과는 없지만 도구가 실행 중인 경우 `getRemainingResults()`는 `Promise.race`를 사용하여 도구가 완료될 때까지 기다리거나 **새 진행 메시지**가 도착할 때까지 기다리므로(`restored-src/src/services/tools/StreamingToolExecutor.ts:476-481`) 불필요한 폴링을 방지합니다.

## <a href="#46-tool-result-management-budgets-and-persistence"
class="header">4.6 도구 결과 관리: 예산 및 지속성</a>

### <a href="#461-large-result-persistence" class="header">4.6.1 대규모 결과 지속성</a>

`Bash` 도구의 `cat` 명령은 수십만 개의 문자를 반환할 수 있습니다. 이러한 엄청난 결과를 컨텍스트 창에 직접 입력하면 토큰 예산이 낭비될 뿐만 아니라 모델의 주의가 분산될 수 있습니다. `toolResultStorage.ts`는 대규모 결과 지속성 메커니즘을 구현합니다.

지속성 임계값 결정은 이 우선순위(`restored-src/src/utils/toolResultStorage.ts:55-78`)를 따릅니다.

1. **GrowthBook 재정의**: 운영 팀은 기능 플래그(`tengu_satin_quoll`)를 통해 특정 도구에 대한 사용자 정의 임계값을 설정할 수 있습니다.
2. **도구 선언 값**: 각 도구의 `maxResultSizeChars` 속성
3. **전체 한도**: `DEFAULT_MAX_RESULT_SIZE_CHARS = 50,000` 문자(`restored-src/src/constants/toolLimits.ts:13`)

최종 임계값은 도구 선언 값과 전역 상한선 중 작은 값입니다. 그러나 도구가 `Infinity`를 선언하면 지속성은 건너뜁니다. 예를 들어 `Read` 도구는 자체 출력 경계를 관리하고 모델 `Read`를 갖기 위해서만 출력을 파일에 유지하면 순환 참조가 됩니다.

결과가 임계값을 초과하면 `persistToolResult`(`restored-src/src/utils/toolResultStorage.ts:137`)는 세션 디렉터리 아래의 `tool-results/` 하위 디렉터리에 전체 콘텐츠를 쓴 다음 미리보기가 포함된 요약 메시지를 생성합니다.

<persisted-output> 출력이 너무 큽니다(245.0KB). 전체 출력은 /path/to/tool-results/abc123.txt에 저장됩니다.

미리보기(처음 2.0KB): [콘텐츠의 처음 2000바이트...] ... </persisted-output>

미리보기 생성(`restored-src/src/utils/toolResultStorage.ts:339-356`)은 줄 중간에서 잘림을 방지하기 위해 개행 경계에서 잘리려고 시도합니다. 잘림 지점 검색 범위는 임계값의 50%와 100% 사이의 마지막 줄 바꿈입니다.

### <a href="#462-per-message-aggregate-budget" class="header">4.6.2 메시지별 집계 예산</a>

단일 도구 크기 제한 외에도 시스템은 **메시지당 총 예산**을 유지합니다. 단일 회전에서 여러 병렬 도구가 각각 임계값에 가까운 결과를 반환하는 경우 해당 합계는 합리적인 제한을 훨씬 초과할 수 있습니다(예: 각각 40K = 400K 문자를 반환하는 10개의 도구).

총 예산의 기본값은 200,000자(`restored-src/src/constants/toolLimits.ts:49`)이며 GrowthBook 플래그(`tengu_hawthorn_window`)를 통해 재정의할 수 있습니다. 초과하면 시스템은 총계가 예산 범위 내로 떨어질 때까지 가장 큰 도구 결과부터 시작하여 결과를 유지합니다.

**신속한 캐시 안정성**을 유지하기 위해 총예산 시스템은 `ContentReplacementState`(`restored-src/src/utils/toolResultStorage.ts:390-393`)를 유지하여 어떤 도구 결과가 유지되었는지 기록합니다. 한 평가에서 결과가 지속되면 이후의 모든 평가에서 동일한 지속 버전이 사용됩니다. 이는 전체가 후속 차례에서 예산을 초과하지 않는 경우에도 마찬가지입니다. 이렇게 하면 "캐시 스래싱"을 방지할 수 있습니다. 즉, 동일한 메시지가 API 호출 전반에 걸쳐 서로 다른 콘텐츠를 가지게 되어 접두사 캐시 무효화가 발생하는 것입니다.

### <a href="#463-empty-result-padding" class="header">4.6.3 빈 결과 패딩</a>

쉽게 간과되는 세부 사항: 빈 `tool_result` 콘텐츠로 인해 일부 모델(특히 Capybara)이 이를 회전 경계로 잘못 해석하여 `\n\nHuman:` 정지 시퀀스를 출력하고 응답(`restored-src/src/utils/toolResultStorage.ts:280-295`)을 종료할 수 있습니다. 시스템은 빈 결과를 감지하고 자리 표시자 텍스트(예: `(Bash completed with no output)`)를 삽입하여 이를 방지합니다.

## <a href="#47-stop-hooks-interruption-points-after-tool-execution"
class="header">4.7 중지 후크: 도구 실행 후 중단 지점</a>

PreToolUse 및 PostToolUse 후크는 모두 **후속 루프 연속 중지**(연속 방지)를 요청할 수 있습니다. 이는 `preventContinuation` 플래그를 통해 구현됩니다.

PreToolUse 후크가 이 플래그(`restored-src/src/services/tools/toolHooks.ts:500-508`)를 설정하면 도구는 계속 실행되지만(거부 결정도 반환되지 않는 한) 실행이 완료된 후 시스템은 `hook_stopped_continuation` 유형 첨부 메시지를 메시지 목록(`restored-src/src/services/tools/toolExecution.ts:1572-1582`)에 추가합니다. 에이전트 루프는 이 메시지 유형을 감지하고 현재 반복을 종료하며 더 이상 다음 추론 라운드를 위해 모델에 결과를 보내지 않습니다.

PostToolUse 후크는 유사하게 연속을 방지할 수 있으며(`restored-src/src/services/tools/toolHooks.ts:118-129`) 보다 일반적인 사용 사례입니다. 예를 들어 후크는 위험한 작업의 결과를 감지한 후 에이전트 루프를 중단하기로 결정할 수 있습니다.

## <a href="#48-pattern-extraction" class="header">4.8 패턴 추출</a>

### <a href="#pattern-1-greedy-merge-pipeline-partitioning"
class="header">패턴 1: Greedy-Merge 파이프라인 분할</a>

도구 호출 분할은 "탐욕스러운 병합" 전략을 사용합니다. 즉, 연속된 동일한 유형의 도구가 동일한 배치로 병합되고 유형 전환 지점이 배치 경계가 됩니다. 이 패턴의 핵심 통찰력은 — **순서 보장과 병렬 효율성 사이에서 단순한 중간 지점을 선택**하는 것입니다. 완전 병렬성(순서 무시)은 불일치를 일으킬 수 있습니다. 전체 직렬화(유형 무시)는 성능을 낭비합니다. Greedy 병합은 상대적 순서를 유지하면서 거의 최적의 병렬성을 달성합니다.

### <a href="#pattern-2-fail-closed-safety-defaults" class="header">패턴 2: 페일클로즈 안전 기본값</a>

구문 분석 실패 또는 예외 시 `isConcurrencySafe`는 기본적으로 `false`로 설정됩니다. `Tool` 인터페이스의 기본 구현도 `false`입니다. 권한 후크의 `allow`는 거부 규칙을 재정의할 수 없습니다. 이는 모두 "페일클로즈" 패턴의 표현입니다. **시스템이 안전성을 확인할 수 없는 경우 보다 보수적인 동작을 선택하세요**. AI 에이전트 시스템에서는 이 원칙이 특히 중요합니다. 모델 출력은 예측할 수 없으며 "이런 일이 일반적으로 발생하지 않을 것"이라고 가정하는 낙관적 설계는 보안 취약점이 될 수 있습니다.

### <a href="#pattern-3-layered-error-cascade" class="header">패턴 3: 계층적 오류 계단식</a>

Bash 오류는 형제 Bash 도구를 취소하지만 Read/Grep 및 기타 독립 도구에는 영향을 미치지 않습니다. 형제 중단 컨트롤러는 하위 프로세스를 취소하지만 상위 에이전트 루프를 중단하지 않습니다. 이 **선택적 계단식**은 두 가지 극단적인 상황, 즉 완전한 격리(오류 무시) 또는 전역 중단(하나의 작은 오류로 인해 전체 세션이 중단됨)을 방지합니다.

### <a href="#pattern-4-cache-stable-result-management"
class="header">패턴 4: 캐시 안정성 결과 관리</a>

대규모 결과 지속성 시스템은 `ContentReplacementState`를 사용하여 동일한 결과가 항상 다른 API 호출에서 동일한 대체 콘텐츠를 사용하도록 보장합니다. 이것이 신속한 캐시 최적화의 핵심입니다. **성능을 위해서는 결정성을 유지하기 위해 약간의 논리적 단순성을 희생하세요**. 비슷한 캐시 안정성 설계가 13~15장의 캐싱 아키텍처 전반에 걸쳐 반복됩니다.

------------------------------------------------------------------------

## <a href="#what-you-can-do" class="header">당신이 할 수 있는 일</a>

다음은 다중 도구 호출을 조정해야 하는 모든 AI 에이전트 시스템에 적용할 수 있는 Claude Code의 도구 실행 조정에서 추출된 실행 가능한 권장 사항입니다.

- **입력 기반 동시성 파티셔닝을 구현합니다.** 단순히 모든 도구 호출을 직렬화하지 마세요. 실제 입력을 기반으로 각 도구 호출이 읽기 전용인지/동시성이 안전한지 판단하고, 연속적인 안전 호출을 동시 배치로 병합하고, 처리량을 최대화합니다.
- **동시성 안전을 위해 "fail-closed" 기본값을 설정합니다.** 입력 구문 분석이 실패하거나 `isConcurrencySafe`에서 예외가 발생하는 경우 기본값은 직렬 실행입니다. 불확실할 때 동시성이 안전하다고 가정하지 마십시오.
- **Bash 오류에 대한 선택적 계단식 중단을 구현합니다.** 셸 명령이 실패하면 형제 셸 명령을 취소합니다(암시적 종속성이 있을 수 있음). 하지만 독립적인 읽기 전용 도구(예: `Read`, `Grep`)는 취소하지 마세요. 전체 에이전트 루프가 중단되지 않도록 하려면 하위 `AbortController`를 사용하십시오.
- **대규모 결과를 얻으려면 2단계 예산 관리를 구현하세요.** 단일 도구 결과에는 글자 수 제한이 있습니다. 단일 메시지의 모든 도구 결과에도 집계 제한이 있습니다. 예산을 초과하는 경우 가장 큰 결과부터 시작하여 디스크를 유지하고 미리 보기를 반환합니다.
- **결과 교체의 결정성을 유지합니다.** 도구 결과가 유지되고 교체되면 현재 총 예산이 초과되지 않더라도 모든 후속 API 호출에서 동일한 교체 버전을 사용합니다. 이는 신속한 캐시 적중률에 매우 중요합니다.
- **빈 도구 결과에 자리 표시자 텍스트를 삽입합니다.** 비어 있는 `tool_result`는 모델에서 회전 경계로 잘못 해석될 수 있습니다. 모델이 예기치 않게 응답을 종료하는 것을 방지하려면 `(Bash completed with no output)`와 같은 텍스트를 삽입하세요.
- **심층 방어를 위한 설계 권한 확인.** 후크의 `allow` 결정은 사용자가 구성한 `deny` 규칙을 우회해서는 안 됩니다. 다층 권한 검사(후크 -\> 도구 자체 -\> 규칙 일치 -\> 사용자 상호 작용)는 보안 경계가 항상 효과적인지 확인합니다.

------------------------------------------------------------------------

이 장에서는 도구 실행 조정 계층이 동시 효율성, 안전 제어 및 컨텍스트 관리의 균형을 유지하는 방법을 보여주었습니다. 다음 장에서는 2부로 들어가 모델 동작을 활용하기 위한 또 다른 주요 제어 표면인 시스템 프롬프트 아키텍처를 분석합니다.

------------------------------------------------------------------------

### <a href="#version-evolution-v2192-changes" class="header">버전 진화: v2.1.92 변경 사항</a>

> 다음 분석은 완전한 소스 코드 증거 없이 v2.1.92 번들 문자열 신호 추론을 기반으로 합니다. v2.1.91(`staleReadFileStateHint` 파일 상태 추적 등)에 대해 이미 문서화된 변경 사항은 여기서 반복되지 않습니다.

#### <a href="#advisortool--the-first-non-execution-tool"
class="header">AdvisorTool — 최초의 비실행 도구</a>

v2.1.92의 도구 목록에는 `AdvisorTool`라는 새로운 이름이 나타납니다. 번들의 이벤트 신호(`tengu_advisor_command`, `tengu_advisor_dialog_shown`, `tengu_advisor_tool_call`, `tengu_advisor_result`) 및 관련 식별자 `advisor_model`, `advisor_redacted_result`, `advisor_tool_token_usage`와 함께 이 에이전트는 **임베디드 어드바이저 에이전트**임을 추론할 수 있습니다. 자체 독립 모델 콜 체인이 있습니다. (`advisor_model`는 별도의 모델 또는 구성을 의미함) 도구 호출을 생성하고(`advisor_tool_call`) 결과가 수정될 수 있습니다(`advisor_redacted_result`).

이는 v2.1.88의 40개 이상의 도구 시스템에서는 전례가 없습니다(2장 참조). v2.1.88의 모든 도구는 **실행 유형**입니다. Read는 파일을 읽고, Bash는 명령을 실행하고, Edit는 파일을 수정하고, Grep은 콘텐츠를 검색합니다. 이들의 공통된 특성은 환경 상태를 직접 변경하거나 환경 데이터를 반환하는 것입니다. AdvisorTool은 이 패턴을 깨뜨립니다. 외부 작업을 실행하지 않고 오히려 **사용자나 상담원에게 제안을 제공**합니다.

이 설계 선택은 에이전트 시스템의 진화 방향을 반영합니다. **"일만 수행"에서 "먼저 제안한 다음 작업 수행"으로.** 이는 실행 전에 의도를 정렬하는 계획 모드(20c장 참조)의 철학과 일치합니다. 차이점은 계획 모드는 사용자가 시작하는 워크플로인 반면 AdvisorTool은 에이전트 작업 중에 자동으로 트리거될 수 있다는 것입니다(`advisor_dialog_shown`에서는 대화 상자 팝업을 제안함).

`CLAUDE_CODE_DISABLE_ADVISOR_TOOL` 환경 변수가 존재한다는 것은 이 기능이 비활성화될 수 있음을 나타냅니다. 이는 Claude Code의 확립된 "점진적 자율성" 원칙(27장 참조)과 일치합니다. 즉, 새로운 기능은 기본적으로 활성화되지만 선택 해제됩니다.

#### <a
href="#tool-result-deduplication--a-new-defense-line-for-context-hygiene"
class="header">도구 결과 중복 제거 - 컨텍스트 위생을 위한 새로운 방어선</a>

`tengu_tool_result_dedup` 이벤트는 도구 결과 계층에서 중복 제거 메커니즘을 보여줍니다. v2.1.88에서 컨텍스트 위생은 주로 단일 도구 결과 잘림(`DEFAULT_MAX_RESULT_SIZE_CHARS = 50,000`, `restored-src/src/constants/toolLimits.ts:13` 참조)과 압축(11장 참조)이라는 두 가지 방어선에 의존했습니다. v2.1.92에는 세 번째 기능인 **도구 결과 중복 제거**가 추가되었습니다.

이는 v2.1.91에 새로 추가된 `tengu_file_read_reread`(반복 파일 읽기 감지)와 완전한 체인을 형성합니다. `file_read_reread`는 입력 측에서 "동일한 파일을 다시 읽습니다"를 감지하고 `tool_result_dedup`는 출력 측에서 "이 결과는 이전과 동일하며 컨텍스트 창을 중복적으로 점유할 필요가 없습니다."를 처리합니다.

설계 철학: 컨텍스트는 에이전트의 가장 귀중한 리소스이며 모든 계층에는 입력 중복 제거, 출력 중복 제거, 압축과 같은 중복 제거 및 정리 메커니즘이 있어야 합니다. 이 세 가지 방어선은 각각 서로 다른 단계를 보호하며 전체적으로 컨텍스트 위생을 유지합니다.

## <a href="#version-evolution-v2191-changes" class="header">버전 진화: v2.1.91 변경 사항</a>

> 다음 분석은 v2.1.91 번들 신호 비교를 기반으로 합니다.

v2.1.91의 `sdk-tools.d.ts`는 도구 결과 메타데이터에 새로운 `staleReadFileStateHint` 필드를 추가했습니다. 도구 실행으로 인해 이전에 읽은 파일의 mtime이 변경되면 시스템이 자동으로 부실 힌트를 생성합니다. 이는 도구 실행 조정 계층을 위한 새로운 출력 채널로, 모델이 파일 시스템에서 자체 작업의 부작용을 인식할 수 있도록 해줍니다.
