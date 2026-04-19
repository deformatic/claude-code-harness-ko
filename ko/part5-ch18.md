# <a href="#chapter-18-hooks--user-defined-interception-points"
class="header">18장: 후크 — 사용자 정의 차단 지점</a>

[중국어 원문 보기](../../part5/ch18.html)

> **포지셔닝**: 이 장에서는 에이전트 수명 주기의 26개 이벤트 지점에서 사용자 정의 셸 명령, LLM 프롬프트 또는 HTTP 요청을 등록하는 메커니즘인 Hooks 시스템을 분석합니다. 전제 조건: 16장(권한 시스템). 대상 독자: CC의 사용자 정의 차단 지점 메커니즘을 이해하려는 독자 또는 자신의 에이전트에 후크 시스템을 구현하려는 개발자.

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

Claude Code의 권한 시스템(16장)과 YOLO 분류자(17장)는 내장된 보안 방어 기능을 제공하지만 모두 "사전 구성"되어 있으므로 사용자는 도구 실행 파이프라인의 중요한 노드에 자신의 논리를 삽입할 수 없습니다. Hooks 시스템은 이러한 격차를 해소합니다. 이를 통해 사용자는 AI 에이전트 수명 주기의 26개 이벤트 지점에서 사용자 정의 셸 명령, LLM 프롬프트, HTTP 요청 또는 에이전트 유효성 검사기를 등록할 수 있으므로 "형식 확인"에서 "자동 배포"까지 워크플로 사용자 정의가 가능해집니다.

이는 단순한 "콜백 함수" 메커니즘이 아닙니다. Hooks 시스템은 네 가지 핵심 과제를 해결해야 합니다. 신뢰 — 임의 명령 실행을 위한 보안 경계는 어디에 있습니까? 시간 초과 — 후크가 중단될 때 전체 에이전트 루프가 차단되는 것을 방지하는 방법은 무엇입니까? 의미론 — Hook의 종료 코드는 어떻게 "허용" 또는 "차단" 결정으로 해석됩니까? 그리고 구성 격리 — 여러 소스의 Hook 구성이 서로 간섭하지 않고 어떻게 병합됩니까?

이 장에서는 이 메커니즘을 소스 코드 수준에서 철저하게 분석할 것입니다.

### <a href="#hook-event-lifecycle-overview" class="header">후크 이벤트 수명주기 개요</a>

``` mermaid
flowchart LR
    subgraph SESSION ["Session Lifecycle"]
        direction TB
        SS["SessionStart"] --> SETUP["Setup"]
    end

    subgraph TOOL ["Tool Execution Lifecycle"]
        direction TB
        PRE["PreToolUse"] --> PERM{"Permission check"}
        PERM -- Needs confirmation --> PR["PermissionRequest"]
        PERM -- Pass --> EXEC["Execute tool"]
        PR -- Allow --> EXEC
        PR -- Deny --> PD["PermissionDenied"]
        EXEC -- Success --> POST["PostToolUse"]
        EXEC -- Failure --> POSTF["PostToolUseFailure"]
    end

    subgraph RESPOND ["Response Lifecycle"]
        direction TB
        UPS["UserPromptSubmit"] --> TOOL2["Tool call loop"]
        TOOL2 --> STOP["Stop"]
        STOP -- "Exit code 2" --> TOOL2
    end

    subgraph END_PHASE ["Ending"]
        direction TB
        SE["SessionEnd<br/>Timeout: 1.5s"]
    end

    SESSION --> RESPOND
    RESPOND --> END_PHASE
```

------------------------------------------------------------------------

## <a href="#181-complete-list-of-hook-event-types" class="header">18.1 후크 이벤트 유형의 전체 목록</a>

Hooks 시스템은 `hooksConfigManager.ts`의 `getHookEventMetadata` 함수(28-264행)에 정의된 26가지 이벤트 유형을 지원합니다. 수명주기 단계에 따라 다섯 가지 범주로 그룹화할 수 있습니다.

### <a href="#tool-execution-lifecycle" class="header">도구 실행 수명주기</a>

<div class="table-wrapper">

| 이벤트 | 트리거 타이밍 | 매처 필드 | 종료 코드 2 동작 |
|----|----|----|----|
| `PreToolUse` | 도구 실행 전 | `tool_name` | 도구 호출을 차단합니다. 표준 오류가 모델로 전송됨 |
| `PostToolUse` | 성공적인 도구 실행 후 | `tool_name` | stderr는 즉시 모델에게 전송됩니다. |
| `PostToolUseFailure` | 도구 실행 실패 후 | `tool_name` | stderr는 즉시 모델에게 전송됩니다. |
| `PermissionRequest` | 권한 대화 상자가 표시되는 경우 | `tool_name` | Hook의 결정을 사용합니다. |
| `PermissionDenied` | 자동 모드 분류자가 도구 호출을 거부한 후 | `tool_name` | — |

</div>

`PreToolUse`는 가장 일반적으로 사용되는 Hook 포인트입니다. `hookSpecificOutput`는 세 가지 권한 결정을 지원합니다(72-78행, `types/hooks.ts`).

``` typescript
// types/hooks.ts:72-78
z.object({
  hookEventName: z.literal('PreToolUse'),
  permissionDecision: permissionBehaviorSchema().optional(),
  permissionDecisionReason: z.string().optional(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  additionalContext: z.string().optional(),
})
```

`updatedInput` 필드를 참고하세요. 후크는 "허용 여부"를 결정할 수 있을 뿐만 아니라 도구의 입력 매개변수도 수정할 수 있습니다. 이를 통해 "명령 다시 쓰기"가 가능해집니다. 예를 들어 모든 `git push` 앞에 `--no-verify`를 자동으로 추가합니다.

### <a href="#session-lifecycle" class="header">세션 수명주기</a>

<div class="table-wrapper">

| 이벤트 | 트리거 타이밍 | 매처 필드 | 특별한 행동 |
|----|----|----|----|
| `SessionStart` | 새 세션/이력서/삭제/압축 | `source`(시작/재개/지우기/컴팩트) | stdout이 Claude에게 전송되었습니다. 차단 오류가 무시되었습니다. |
| `SessionEnd` | 세션이 종료되면 | `reason`(클리어/로그아웃/prompt_input_exit/기타) | 시간 초과는 1.5초에 불과합니다. |
| `Setup` | repo 초기화 및 유지 관리 중 | `trigger`(초기화/유지관리) | stdout이 Claude에게 전송됨 |
| `Stop` | 클로드가 응답을 끝내기 전에 | — | 종료 코드 2는 대화를 계속합니다. |
| `StopFailure` | API 오류로 인해 턴이 종료되는 경우 | `error`(속도_제한/인증_실패/...) | 실행하고 잊어버리세요 |
| `UserPromptSubmit` | 사용자가 프롬프트를 제출할 때 | — | 종료 코드 2는 처리를 차단하고 원래 프롬프트를 지웁니다. |

</div>

`SessionStart` Hook에는 고유한 기능이 있습니다. `CLAUDE_ENV_FILE` 환경 변수를 통해 Hooks는 bash 내보내기 문을 지정된 파일에 쓸 수 있으며 이러한 환경 변수는 모든 후속 BashTool 명령(917-926행, `hooks.ts`)에 적용됩니다.

``` typescript
// hooks.ts:917-926
if (
  !isPowerShell &&
  (hookEvent === 'SessionStart' ||
    hookEvent === 'Setup' ||
    hookEvent === 'CwdChanged' ||
    hookEvent === 'FileChanged') &&
  hookIndex !== undefined
) {
  envVars.CLAUDE_ENV_FILE = await getHookEnvFilePath(hookEvent, hookIndex)
}
```

### <a href="#multi-agent-lifecycle" class="header">다중 에이전트 수명주기</a>

<div class="table-wrapper">

| 이벤트 | 트리거 타이밍 | 매처 필드 |
|-----------------|----------------------------------------------|---------------|
| `SubagentStart` | 하위 Agent가 시작될 때 | `agent_type` |
| `SubagentStop` | 하위 Agent가 응답을 종료하기 전 | `agent_type` |
| `TeammateIdle` | 팀원이 유휴 상태에 들어가려고 할 때 | — |
| `TaskCreated` | 작업이 생성되면 | — |
| `TaskCompleted` | 작업이 완료되면 | — |

</div>

### <a href="#file-and-configuration-changes" class="header">파일 및 구성 변경</a>

<div class="table-wrapper">

| 이벤트 | 트리거 타이밍 | 매처 필드 |
|----|----|----|
| `FileChanged` | 감시된 파일이 변경되는 경우 | 파일 이름(예: `.envrc|.env`) |
| `CwdChanged` | 작업 디렉토리 변경 후 | — |
| `ConfigChange` | 세션 중에 구성 파일이 변경되는 경우 | `source`(사용자_설정/프로젝트_설정/...) |
| `InstructionsLoaded` | CLAUDE.md 또는 규칙 파일이 로드될 때 | `load_reason`(session_start/path_glob_match/...) |

</div>

### <a href="#compaction-mcp-interaction-and-worktree"
class="header">압축, MCP 상호 작용 및 작업 트리</a>

<div class="table-wrapper">

| 이벤트 | 트리거 타이밍 | 매처 필드 |
|----|----|----|
| `PreCompact` | 대화 압축 전 | `trigger`(수동/자동) |
| `PostCompact` | 대화 압축 후 | `trigger`(수동/자동) |
| `Elicitation` | MCP 서버가 사용자 입력을 요청할 때 | `mcp_server_name` |
| `ElicitationResult` | 사용자가 MCP 유도에 응답한 후 | `mcp_server_name` |
| `WorktreeCreate` | 격리된 작업 트리를 생성하는 경우 | — |
| `WorktreeRemove` | 작업 트리를 제거하는 경우 | — |

</div>

------------------------------------------------------------------------

## <a href="#182-four-hook-types" class="header">18.2 네 가지 후크 유형</a>

Hooks 시스템은 지속 가능한 Hook 유형 4개와 런타임에 등록된 내부 유형 2개를 지원합니다. 모든 지속 가능한 유형 스키마는 `schemas/hooks.ts`의 `buildHookSchemas` 함수(31-163행)에 정의되어 있습니다.

### <a href="#command-type-shell-commands" class="header">명령 유형: 쉘 명령</a>

가장 기본적이고 일반적으로 사용되는 유형:

``` typescript
// schemas/hooks.ts:32-65
const BashCommandHookSchema = z.object({
  type: z.literal('command'),
  command: z.string(),
  if: IfConditionSchema(),
  shell: z.enum(SHELL_TYPES).optional(),   // 'bash' | 'powershell'
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),            // Remove after single execution
  async: z.boolean().optional(),           // Background execution, non-blocking
  asyncRewake: z.boolean().optional(),     // Background execution, rewake model on exit code 2
})
```

`shell` 필드는 인터프리터 선택을 제어합니다(790-791행, `hooks.ts`). 기본값은 `bash`입니다(실제로 `$SHELL`를 사용하고 bash/zsh/sh를 지원함). `powershell`는 `pwsh`를 사용합니다. 두 실행 경로는 완전히 별개입니다. bash 경로는 Windows Git Bash 경로 변환(`C:\Users\foo` -\> `/c/Users/foo`), `.sh` 파일에 대한 자동 `bash` 접두사 및 `CLAUDE_CODE_SHELL_PREFIX` 래핑을 처리합니다. PowerShell 경로는 기본 Windows 경로를 사용하여 이러한 모든 경로를 건너뜁니다.

`if` 필드는 세분화된 조건부 필터링을 제공합니다. 생성 이후가 아닌 후크 일치 단계에서 평가되는 권한 규칙 구문(예: `Bash(git *)`)을 사용하여 일치하지 않는 명령에 대해 쓸모 없는 프로세스가 생성되는 것을 방지합니다(라인 1390-1421, `hooks.ts`).

``` typescript
// hooks.ts:1390-1421
async function prepareIfConditionMatcher(
  hookInput: HookInput,
  tools: Tools | undefined,
): Promise<IfConditionMatcher | undefined> {
  if (
    hookInput.hook_event_name !== 'PreToolUse' &&
    hookInput.hook_event_name !== 'PostToolUse' &&
    hookInput.hook_event_name !== 'PostToolUseFailure' &&
    hookInput.hook_event_name !== 'PermissionRequest'
  ) {
    return undefined
  }
  // ...reuses permission rule parser and tool's preparePermissionMatcher
}
```

### <a href="#prompt-type-llm-evaluation" class="header">프롬프트 유형: LLM 평가</a>

평가를 위해 경량 LLM에 Hook 입력을 보냅니다.

``` typescript
// schemas/hooks.ts:67-95
const PromptHookSchema = z.object({
  type: z.literal('prompt'),
  prompt: z.string(),     // Uses $ARGUMENTS placeholder to inject Hook input JSON
  if: IfConditionSchema(),
  model: z.string().optional(),  // Defaults to small fast model
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

### <a href="#agent-type-agent-validator" class="header">에이전트 유형: 에이전트 유효성 검사기</a>

프롬프트보다 더 강력합니다. 조건을 확인하기 위해 완전한 에이전트 루프를 시작합니다.

``` typescript
// schemas/hooks.ts:128-163
const AgentHookSchema = z.object({
  type: z.literal('agent'),
  prompt: z.string(),     // "Verify that unit tests ran and passed."
  if: IfConditionSchema(),
  timeout: z.number().positive().optional(),  // Default 60 seconds
  model: z.string().optional(),  // Defaults to Haiku
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

소스 코드에는 중요한 설계 참고 사항(130-141행)이 있습니다. `prompt` 필드는 이전에 `.transform()`에 의해 함수로 래핑되어 `JSON.stringify` 중에 손실이 발생했습니다. 이 버그는 gh-24920/CC-79로 추적되어 수정되었습니다.

### <a href="#http-type-webhook" class="header">http 유형: 웹훅</a>

POSTs 지정된 URL에 대한 후크 입력:

``` typescript
// schemas/hooks.ts:97-126
const HttpHookSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  if: IfConditionSchema(),
  timeout: z.number().positive().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  allowedEnvVars: z.array(z.string()).optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```

`headers`는 환경 변수 보간(`$VAR_NAME` 또는 `${VAR_NAME}`)을 지원하지만 `allowedEnvVars`에 나열된 변수만 확인됩니다. 즉, 민감한 환경 변수가 실수로 누출되는 것을 방지하기 위한 명시적인 화이트리스트 메커니즘입니다.

참고: HTTP Hooks는 `SessionStart` 및 `Setup` 이벤트(라인 1853-1864, `hooks.ts`)를 지원하지 않습니다. 샌드박스 요청 콜백이 헤드리스 모드에서 교착 상태에 빠지기 때문입니다.

### <a href="#internal-types-callback-and-function" class="header">내부 유형: 콜백 및 함수</a>

이 두 가지 유형은 구성 파일을 통해 정의할 수 없습니다. SDK 및 내부 구성 요소 등록에만 사용됩니다. `callback` 유형은 속성 후크, 세션 파일 액세스 후크 및 기타 내부 기능에 사용됩니다. `function` 유형은 에이전트 프론트매터를 통해 등록된 구조화된 출력 집행자에 의해 사용됩니다.

------------------------------------------------------------------------

## <a href="#183-execution-model" class="header">18.3 실행 모델</a>

### <a href="#async-generator-architecture" class="header">비동기 생성기 아키텍처</a>

`executeHooks`는 `async function*`(비동기 생성기)로 선언된 전체 시스템(라인 1952-2098, `hooks.ts`)의 핵심 기능입니다.

``` typescript
// hooks.ts:1952-1977
async function* executeHooks({
  hookInput,
  toolUseID,
  matchQuery,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  toolUseContext,
  messages,
  forceSyncExecution,
  requestPrompt,
  toolInputSummary,
}: { /* ... */ }): AsyncGenerator<AggregatedHookResult> {
```

이 설계를 통해 호출자는 `for await...of`를 통해 점진적으로 Hook 실행 결과를 수신할 수 있으므로 스트리밍 처리가 가능합니다. 각 Hook은 실행 전에 진행 메시지를 생성하고 완료 후 최종 결과를 생성합니다.

### <a href="#timeout-strategy" class="header">타임아웃 전략</a>

시간 초과 전략은 이벤트 유형에 따라 두 가지 계층으로 나뉩니다.

**기본 제한 시간: 10분.** 166행에 정의됨:

``` typescript
// hooks.ts:166
const TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000
```

이 긴 시간 제한은 대부분의 후크 이벤트에 적용됩니다. 즉, 사용자 CI 스크립트, 테스트 모음 및 빌드 명령은 몇 분 정도 걸릴 수 있습니다.

**SessionEnd 시간 초과: 1.5초.** 175-182행에 정의됨:

``` typescript
// hooks.ts:174-182
const SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500
export function getSessionEndHookTimeoutMs(): number {
  const raw = process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SESSION_END_HOOK_TIMEOUT_MS_DEFAULT
}
```

SessionEnd 후크는 닫기/지우기 중에 실행되며 매우 엄격한 시간 초과 제약 조건을 가져야 합니다. 그렇지 않으면 사용자가 종료하기 전에 Ctrl+C를 누른 후 10분을 기다려야 합니다. 1.5초는 개별 Hook의 기본 시간 제한과 전체 AbortSignal 제한(모든 Hook이 병렬로 실행되기 때문에) 역할을 합니다. 사용자는 `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` 환경 변수를 통해 재정의할 수 있습니다.

각 후크는 `timeout` 필드(초)를 통해 자체 시간 제한을 지정할 수도 있으며, 이는 기본값(877-879행)을 재정의합니다.

``` typescript
// hooks.ts:877-879
const hookTimeoutMs = hook.timeout
  ? hook.timeout * 1000
  : TOOL_HOOK_EXECUTION_TIMEOUT_MS
```

### <a href="#async-background-hooks" class="header">비동기 배경 후크</a>

후크는 두 가지 방법으로 백그라운드 실행을 시작할 수 있습니다.

1. **구성 선언**: `async: true` 또는 `asyncRewake: true` 설정(995-1029행)
2. **런타임 선언**: 후크는 첫 번째 줄(라인 1117-1164)에 `{"async": true}` JSON을 출력합니다.

주요 차이점은 `asyncRewake`입니다. 이 플래그가 설정되면 백그라운드 후크가 비동기 레지스트리에 등록되지 않습니다. 대신 완료 시 종료 코드를 확인합니다. 종료 코드가 2인 경우 `enqueuePendingNotification`를 통해 오류 메시지를 `task-notification`로 대기열에 추가하고 모델을 다시 활성화하여 처리를 계속합니다(205-244행).

백그라운드 Hook 실행 중 미묘한 세부 사항: stdin은 백그라운드 전에 작성되어야 합니다. 그렇지 않으면 bash의 `read -r line`는 EOF로 인해 종료 코드 1을 반환합니다. 이 버그는 gh-30509/CC-161(1001-1008행의 주석)로 추적되었습니다.

### <a href="#prompt-request-protocol" class="header">프롬프트 요청 프로토콜</a>

Hook 명령 유형은 양방향 상호 작용 프로토콜을 지원합니다. Hook 프로세스는 JSON 형식의 프롬프트 요청을 stdout에 작성할 수 있고 Claude Code는 사용자에게 선택 대화 상자를 표시하며 사용자의 선택은 stdin을 통해 다시 전송됩니다.

``` typescript
// types/hooks.ts:28-40
export const promptRequestSchema = lazySchema(() =>
  z.object({
    prompt: z.string(),       // Request ID
    message: z.string(),      // Message displayed to user
    options: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    ),
  }),
)
```

이 프로토콜은 직렬화되어 있습니다. 여러 프롬프트 요청이 순차적으로 처리되므로(라인 1064의 `promptChain`) 응답이 순서대로 도착하지 않습니다.

------------------------------------------------------------------------

## <a href="#184-exit-code-semantics" class="header">18.4 종료 코드 의미</a>

종료 코드는 Hooks와 Claude Code 사이의 기본 통신 프로토콜입니다.

<div class="table-wrapper">

| 종료 코드 | 의미론 | 행동 |
|----|----|----|
| **0** | 성공/허용 | stdout/stderr이 표시되지 않음(또는 기록 모드에서만 표시됨) |
| **2** | 차단 오류 | 표준 오류가 모델로 전송되었습니다. 현재 작업을 차단합니다 |
| **다른** | 비차단 오류 | stderr은 사용자에게만 표시됩니다. 작업은 계속됩니다 |

</div>

그러나 이벤트 유형에 따라 종료 코드가 다르게 해석됩니다. 주요 차이점은 다음과 같습니다.

- **PreToolUse**: 종료 코드 2는 도구 호출을 차단하고 stderr을 모델에 보냅니다. 종료 코드 0의 stdout/stderr이 표시되지 않습니다.
- **중지**: 종료 코드 2는 stderr을 모델에 보내고 **대화를 계속**합니다(종료하지 않고). 이는 "계속 코딩" 모드의 구현 기반입니다.
- **UserPromptSubmit**: 종료 코드 2는 처리를 차단하고 **원래 프롬프트를 지우고** 사용자에게 stderr만 표시합니다.
- **SessionStart/Setup**: 차단 오류는 무시됩니다. 이러한 이벤트는 Hooks가 시작 흐름을 차단하는 것을 허용하지 않습니다.
- **StopFailure**: 실행 후 잊어버리기; 모든 출력 및 종료 코드가 무시됩니다.

### <a href="#json-output-protocol" class="header">JSON 출력 프로토콜</a>

종료 코드 외에도 Hooks는 stdout JSON 출력을 통해 구조화된 정보를 전달할 수도 있습니다. `parseHookOutput` 함수(399-451행) 논리는 다음과 같습니다. stdout이 `{`로 시작하는 경우 JSON 구문 분석 및 Zod 스키마 유효성 검사를 시도합니다. 그렇지 않으면 일반 텍스트로 처리됩니다.

전체 JSON 출력 스키마는 `types/hooks.ts:50-176`에 정의되어 있습니다. 핵심 분야는 다음과 같습니다:

``` typescript
// types/hooks.ts:50-66
export const syncHookResponseSchema = lazySchema(() =>
  z.object({
    continue: z.boolean().optional(),       // false = stop execution
    suppressOutput: z.boolean().optional(), // true = hide stdout
    stopReason: z.string().optional(),      // Message when continue=false
    decision: z.enum(['approve', 'block']).optional(),
    reason: z.string().optional(),
    systemMessage: z.string().optional(),   // Warning displayed to user
    hookSpecificOutput: z.union([/* per-event-type specific output */]).optional(),
  }),
)
```

`hookSpecificOutput`는 각 이벤트 유형에 고유한 전문 필드가 있는 구별된 공용체입니다. 예를 들어 `PermissionRequest` 이벤트(121-133행)는 `allow`/`deny` 결정 및 권한 업데이트를 지원합니다.

``` typescript
// types/hooks.ts:121-133
z.object({
  hookEventName: z.literal('PermissionRequest'),
  decision: z.union([
    z.object({
      behavior: z.literal('allow'),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      updatedPermissions: z.array(permissionUpdateSchema()).optional(),
    }),
    z.object({
      behavior: z.literal('deny'),
      message: z.string().optional(),
      interrupt: z.boolean().optional(),
    }),
  ]),
})
```

------------------------------------------------------------------------

## <a href="#185-trust-gating" class="header">18.5 신뢰 게이팅</a>

후크 실행을 위한 보안 게이트는 `shouldSkipHookDueToTrust` 함수(286-296행)에 의해 구현됩니다.

``` typescript
// hooks.ts:286-296
export function shouldSkipHookDueToTrust(): boolean {
  const isInteractive = !getIsNonInteractiveSession()
  if (!isInteractive) {
    return false  // Trust is implicit in SDK mode
  }
  const hasTrust = checkHasTrustDialogAccepted()
  return !hasTrust
}
```

규칙은 간단하지만 중요합니다.

1. **비대화형 모드(SDK)**: 신뢰는 암시적입니다. 모든 Hook은 직접 실행됩니다.
2. **대화형 모드**: **모든** 후크에는 신뢰 대화 상자 확인이 필요합니다.

코드 주석(267-285행)은 "모두 이유"에 대해 자세히 설명합니다. 후크 구성은 신뢰 대화 상자가 표시되기 전에 발생하는 `captureHooksConfigSnapshot()` 단계에서 캡처됩니다. 대부분의 후크는 정상적인 프로그램 흐름을 통해 신뢰 확인 전에 실행되지 않지만 역사적으로 두 가지 취약점이 있었습니다. 사용자가 신뢰를 거부한 경우에도 실행되는 `SessionEnd` 후크와 신뢰 확인 전에 하위 에이전트가 완료될 때 `SubagentStop` 후크가 실행되었습니다. 심층 방어 원칙에서는 모든 Hook에 대해 균일한 검사가 필요합니다.

`executeHooks` 함수는 실행 전에 중앙 집중식 검사도 수행합니다(라인 1993-1999).

``` typescript
// hooks.ts:1993-1999
if (shouldSkipHookDueToTrust()) {
  logForDebugging(
    `Skipping ${hookName} hook execution - workspace trust not accepted`,
  )
  return
}
```

또한 `disableAllHooks` 설정은 보다 극단적인 제어 기능을 제공합니다(1978-1979행). 정책 설정에 설정하면 관리되는 후크를 포함한 모든 후크가 비활성화됩니다. 관리되지 않는 설정으로 설정된 경우 관리되지 않는 후크만 비활성화됩니다(관리되는 후크는 계속 실행됨).

------------------------------------------------------------------------

## <a href="#186-configuration-snapshot-tracking" class="header">18.6 구성 스냅샷 추적</a>

후크 구성은 실행될 때마다 실시간으로 읽히지 않지만 스냅샷 메커니즘을 통해 관리됩니다. `hooksConfigSnapshot.ts`는 이 시스템을 정의합니다.

### <a href="#snapshot-capture" class="header">스냅샷 캡처</a>

`captureHooksConfigSnapshot()`(라인 95-97)는 애플리케이션 시작 시 한 번 호출됩니다.

``` typescript
// hooksConfigSnapshot.ts:95-97
export function captureHooksConfigSnapshot(): void {
  initialHooksConfig = getHooksFromAllowedSources()
}
```

### <a href="#source-filtering" class="header">소스 필터링</a>

`getHooksFromAllowedSources()`(18-53행)은 다중 계층 필터링 논리를 구현합니다.

1. 정책 설정이 `disableAllHooks: true`를 설정하는 경우 빈 구성을 반환합니다.
2. 정책 설정이 `allowManagedHooksOnly: true`를 설정하는 경우 관리형 후크만 반환
3. `strictPluginOnlyCustomization` 정책이 활성화된 경우 사용자/프로젝트/로컬 설정에서 후크를 차단합니다.
4. 관리되지 않는 설정이 `disableAllHooks`로 설정된 경우 관리되는 후크만 실행됩니다.
5. 그렇지 않으면 모든 소스에서 병합된 구성을 반환합니다.

### <a href="#snapshot-updates" class="header">스냅샷 업데이트</a>

사용자가 `/hooks` 명령을 통해 후크 구성을 수정하면 `updateHooksConfigSnapshot()`(라인 104-112)가 호출됩니다.

``` typescript
// hooksConfigSnapshot.ts:104-112
export function updateHooksConfigSnapshot(): void {
  resetSettingsCache()  // Ensure reading latest settings from disk
  initialHooksConfig = getHooksFromAllowedSources()
}
```

`resetSettingsCache()` 호출에 유의하세요. 호출이 없으면 스냅샷이 오래된 캐시 설정을 사용할 수 있습니다. 이는 파일 감시자의 안정성 임계값이 아직 트리거되지 않았을 수 있기 때문입니다(주석에서 이에 대해 언급함).

------------------------------------------------------------------------

## <a href="#187-matching-and-deduplication" class="header">18.7 일치 및 중복 제거</a>

### <a href="#matcher-patterns" class="header">일치 패턴</a>

각 후크 구성은 정확한 트리거 조건 필터링을 위해 `matcher` 필드를 지정할 수 있습니다. `matchesPattern` ​​함수(라인 1346-1381)는 세 가지 모드를 지원합니다.

1. **정확히 일치**: `Write`는 도구 이름 `Write`와만 일치합니다.
2. **파이프 분리**: `Write|Edit`는 `Write` 또는 `Edit`와 일치합니다.
3. **정규식**: `^Write.*`는 `Write`로 시작하는 모든 도구 이름과 일치합니다.

결정은 문자열 내용을 기반으로 합니다. `[a-zA-Z0-9_|]`만 포함된 경우 단순 일치로 처리됩니다. 그렇지 않으면 정규식으로.

### <a href="#deduplication-mechanism" class="header">중복 제거 메커니즘</a>

동일한 명령이 여러 구성 소스(사용자/프로젝트/로컬)에 정의될 수 있습니다. 중복 제거는 `hookDedupKey` 함수(라인 1453-1455)에 의해 처리됩니다.

``` typescript
// hooks.ts:1453-1455
function hookDedupKey(m: MatchedHook, payload: string): string {
  return `${m.pluginRoot ?? m.skillRoot ?? ''}\0${payload}`
}
```

주요 설계: 중복 제거 키는 소스 컨텍스트에 따라 네임스페이스가 지정됩니다. 다른 플러그인 디렉터리에 있는 동일한 `echo hello` 명령은 중복 제거되지 않지만(`${CLAUDE_PLUGIN_ROOT}`를 확장하면 다른 파일을 가리키기 때문에) 동일한 소스 내의 사용자/프로젝트/로컬 설정 전체에서 동일한 명령이 하나로 병합됩니다.

`callback` 및 `function` 유형 후크는 중복 제거를 건너뜁니다. 각 인스턴스는 고유합니다. 일치하는 모든 Hooks가 콜백/함수 유형인 경우 6라운드 필터링 및 맵 구성을 완전히 건너뛰는 빠른 경로(1723-1729행)도 있습니다. 마이크로 벤치마크에서는 44배의 성능 향상을 보여줍니다.

------------------------------------------------------------------------

## <a href="#188-practical-configuration-examples" class="header">18.8 실제 구성 예</a>

### <a href="#example-1-pretooluse-format-check" class="header">예 1: PreToolUse 형식 확인</a>

모든 TypeScript 파일을 쓰기 전에 자동으로 형식 확인을 실행합니다.

``` json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "FILE=$(echo $ARGUMENTS | jq -r '.file_path') && prettier --check \"$CLAUDE_PROJECT_DIR/$FILE\" 2>&1 || echo '{\"decision\":\"block\",\"reason\":\"File does not pass prettier formatting\"}'",
            "if": "Write(*.ts)",
            "statusMessage": "Checking formatting..."
          }
        ]
      }
    ]
  }
}
```

이 구성은 몇 가지 주요 기능을 보여줍니다.

- `matcher: "Write|Edit"`는 파이프 분리를 사용하여 두 도구를 일치시킵니다.
- `if: "Write(*.ts)"`는 추가 필터링을 위해 권한 규칙 구문을 사용합니다. 이 예에서는 `.ts` 파일에만 적용됩니다. `if` 필드는 git 명령만 일치하는 `"Bash(git *)"`, src 디렉터리의 편집 내용만 일치하는 `"Edit(src/**)"`, Python 파일 읽기만 일치하는 `"Read(*.py)"`와 같은 모든 권한 규칙 패턴을 지원합니다.
- `$CLAUDE_PROJECT_DIR` 환경 변수는 자동으로 프로젝트 루트 디렉터리로 설정됩니다(라인 813-816).
- 후크 입력 JSON은 stdin을 통해 전달됩니다. Hook은 `$ARGUMENTS`로 이를 참조하거나 stdin에서 직접 읽을 수 있습니다.
- JSON 출력 프로토콜의 `decision: "block"`는 부적합 쓰기를 차단합니다.

### <a
href="#example-2-sessionstart-environment-init--stop-auto-verification"
class="header">예시 2: SessionStart 환경 초기화 + 자동 확인 중지</a>

SessionStart 및 Stop Hooks를 결합하여 "자동 개발 환경"을 구현합니다.

``` json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'export NODE_ENV=development' >> $CLAUDE_ENV_FILE && echo '{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"Dev environment configured. Node: '$(node -v)'\"}}'",
            "statusMessage": "Setting up dev environment..."
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "agent",
            "prompt": "Check if there are uncommitted changes. If so, create an appropriate commit message and commit them. Verify the commit was successful.",
            "timeout": 120,
            "model": "claude-sonnet-4-6",
            "statusMessage": "Auto-committing changes..."
          }
        ]
      }
    ]
  }
}
```

이 예에서는 다음을 보여줍니다.

- SessionStart Hook은 `CLAUDE_ENV_FILE`를 사용하여 후속 Bash 명령에 환경 변수를 삽입합니다.
- `additionalContext`는 정보를 Claude에게 컨텍스트로 보냅니다.
- Stop Hook은 `agent` 유형을 사용하여 완전한 확인 에이전트를 시작합니다.
- `timeout: 120`는 기본 60초 제한 시간을 재정의합니다.

------------------------------------------------------------------------

## <a href="#189-hook-source-hierarchy-and-merging" class="header">18.9 후크 소스 계층 구조 및 병합</a>

`getHooksConfig` 기능(라인 1492-1566)은 다양한 소스의 후크 구성을 통합 목록으로 병합하는 역할을 합니다. 가장 높은 우선순위에서 가장 낮은 우선순위로 순위가 매겨진 소스:

1. **구성 스냅샷**(settings.json 병합 결과): `getHooksConfigFromSnapshot()`를 통해 획득
2. **등록된 후크**(SDK 콜백 + 플러그인 네이티브 후크): `getRegisteredHooks()`를 통해 획득
3. **세션 후크**(에이전트 전면에 등록된 후크): `getSessionHooks()`를 통해 획득
4. **세션 기능 후크**(구조화된 출력 시행자 등): `getSessionFunctionHooks()`를 통해 획득

`allowManagedHooksOnly` 정책이 활성화되면 소스 2~4의 관리되지 않는 후크를 건너뜁니다. 이 필터링은 실행 단계가 아닌 병합 단계에서 발생합니다. 즉, 관리되지 않는 Hook이 실행 파이프라인에 진입하는 것을 근본적으로 차단합니다.

`hasHookForEvent` 함수(1582-1593행)는 간단한 존재 확인입니다. 완전한 병합 목록을 작성하지는 않지만 첫 번째 일치 항목을 찾은 후 즉시 반환합니다. 이는 핫 경로(예: `InstructionsLoaded` 및 `WorktreeCreate` 이벤트)의 단락 최적화에 사용되어 후크 구성이 없을 때 불필요한 `createBaseHookInput` 및 `getMatchingHooks` 호출을 방지합니다.

------------------------------------------------------------------------

## <a href="#1810-process-management-and-shell-branching"
class="header">18.10 프로세스 관리와 쉘 분기</a>

후크 프로세스 생성 논리(940-984행)는 셸 유형에 따라 완전히 독립적인 두 개의 경로로 나뉩니다.

**배시 경로:**

``` typescript
// hooks.ts:976-983
const shell = isWindows ? findGitBashPath() : true
child = spawn(finalCommand, [], {
  env: envVars,
  cwd: safeCwd,
  shell,
  windowsHide: true,
})
```

Windows에서는 cmd.exe 대신 Git Bash가 사용됩니다. 즉, 모든 경로는 POSIX 형식이어야 합니다. `windowsPathToPosixPath()`는 순수 JS 정규식 변환(LRU-500 캐시 포함)으로, cygpath에 대한 쉘아웃이 필요하지 않습니다.

**PowerShell 경로:**

``` typescript
// hooks.ts:967-972
child = spawn(pwshPath, buildPowerShellArgs(finalCommand), {
  env: envVars,
  cwd: safeCwd,
  windowsHide: true,
})
```

`-NoProfile -NonInteractive -Command` 인수를 사용합니다. 사용자 프로필 스크립트를 건너뛰고(더 빠르고 결정적) 입력이 필요할 때 중단되지 않고 빠르게 실패합니다.

미묘한 안전 검사: 생성되기 전에 `getCwd()`에서 반환된 디렉터리가 존재하는지 확인합니다(라인 931-938). 에이전트 작업 트리가 제거되면 AsyncLocalStorage가 삭제된 경로를 반환할 수 있습니다. 이 경우 `getOriginalCwd()`로 대체됩니다.

### <a href="#plugin-hook-variable-substitution" class="header">플러그인 후크 변수 대체</a>

후크가 플러그인에서 나오면 명령 문자열의 템플릿 변수가 생성되기 전에 대체됩니다(라인 818-857).

- `${CLAUDE_PLUGIN_ROOT}`: 플러그인 설치 디렉터리
- `${CLAUDE_PLUGIN_DATA}`: 플러그인의 영구 데이터 디렉터리
- `${user_config.X}`: `/plugin`를 통해 사용자가 구성한 옵션 값

교체 순서가 중요합니다. 플러그인 변수는 사용자 구성 변수보다 먼저 교체됩니다. 이를 통해 사용자 구성 값의 `${CLAUDE_PLUGIN_ROOT}` 리터럴이 이중 구문 분석되는 것을 방지할 수 있습니다. 플러그인 디렉터리가 존재하지 않는 경우(GC 경주 또는 동시 세션 삭제로 인해) 코드는 스크립트를 찾지 못한 후 코드 2로 명령이 종료되도록 하는 대신 생성 전에 명시적인 오류를 발생시킵니다(라인 831-836). 이는 "의도적인 차단"으로 잘못 해석됩니다.

플러그인 옵션은 `CLAUDE_PLUGIN_OPTION_<KEY>` 형식으로 명명된 환경 변수(898-906행)로도 노출됩니다. 여기서 KEY는 밑줄로 대체된 비식별자 문자로 대문자로 표시됩니다. 이를 통해 Hook 스크립트는 명령 문자열에서 `${user_config.X}` 템플릿을 사용하는 대신 환경 변수를 통해 구성을 읽을 수 있습니다.

------------------------------------------------------------------------

## <a href="#1811-case-study-building-langsmith-runtime-tracing-with-hooks"
class="header">18.11 사례 연구: 후크를 사용하여 LangSmith 런타임 추적 구축</a>

오픈 소스 프로젝트 `langsmith-claude-code-plugins`는 매우 대표적인 사례를 제공합니다. **Claude Code 소스 코드를 수정하지도 않고 Anthropic API 요청을 프록시하지도 않지만 회전, 도구 호출, 하위 에이전트 및 압축 이벤트를 추적할 수 있습니다.** 이는 Hooks 시스템의 가치가 "일부 이벤트 지점에서 스크립트 실행"을 넘어 외부 통합 표면을 구성하기에 충분하다는 것을 보여줍니다.

플러그인의 핵심 아이디어는 한 문장으로 요약할 수 있습니다.

> **후크를 사용하여 수명 주기 신호를 수집하고, 기록을 사실 로그로 사용하고, 로컬 상태 시스템을 사용하여 분산된 신호를 완전한 추적 트리로 재조립합니다.**

이는 흑마술이 아니라 Claude Code가 공식적으로 공개한 여러 기능에 의존합니다.

1. 플러그인에는 자체 `hooks/hooks.json`가 포함될 수 있으며 여러 수명 주기 이벤트에 명령 유형 후크를 장착할 수 있습니다.
2. 후크는 모호한 환경 변수가 아닌 stdin을 통해 구조화된 JSON을 수신합니다.
3. 모든 후크 입력에는 `session_id`, `transcript_path`, `cwd`가 포함됩니다.
4. `Stop` / `SubagentStop`는 `last_assistant_message`, `agent_transcript_path`와 같은 높은 가치 필드를 추가로 전달합니다.
5. 후크 명령은 `${CLAUDE_PLUGIN_ROOT}`를 사용하여 플러그인의 자체 번들 디렉토리를 참조할 수 있습니다.
6. `async: true`를 사용하면 플러그인이 기본 상호 작용 경로를 차단하지 않고 백그라운드에서 네트워크 전달을 수행할 수 있습니다.

### <a href="#how-an-external-plugin-assembles-a-complete-trace"
class="header">외부 플러그인이 완전한 추적을 수집하는 방법</a>

LangSmith 플러그인은 9개의 Hook 이벤트를 등록합니다.

<div class="table-wrapper">

| 후크 이벤트 | 목적 |
|----|----|
| `UserPromptSubmit` | 현재 차례에 대한 LangSmith 루트 실행을 생성합니다. |
| `PreToolUse` | 기록 도구의 실제 시작 시간 |
| `PostToolUse` | 일반 도구를 추적합니다. 에이전트 도구에 대한 상위 실행 예약 |
| `Stop` | 증분 기록 읽기, 회전/LLM/도구 계층 구조 재구성 |
| `StopFailure` | API 오류 시 닫기 댕글링 실행 |
| `SubagentStop` | 하위 에이전트 기록 경로를 기록하고 통합 처리를 위해 기본 `Stop`를 따릅니다. |
| `PreCompact` | 기록 압축 시작 시간 |
| `PostCompact` | 추적 압축 이벤트 및 요약 |
| `SessionEnd` | 사용자 종료 또는 `/clear`에서 정리하여 중단된 회전 완료 |

</div>

이들의 협력관계는 다음과 같습니다.

``` mermaid
flowchart TD
    A["UserPromptSubmit<br/>Create turn root run"] --> B["state.json<br/>current_turn_run_id / trace_id / dotted_order"]
    B --> C["PreToolUse<br/>Record tool_start_times"]
    C --> D["PostToolUse<br/>Trace normal tools directly"]
    C --> E["PostToolUse<br/>Agent tools only register task_run_map"]
    E --> F["SubagentStop<br/>Register pending_subagent_traces"]
    D --> G["Stop<br/>Incrementally read transcript"]
    F --> G
    B --> G
    G --> H["traceTurn()<br/>Reconstruct Claude / Tool / Claude"]
    G --> I["tracePendingSubagents()<br/>Attach sub-Agents under Agent tool"]
    J["PreCompact"] --> K["PostCompact<br/>Record compaction run"]
    L["SessionEnd / StopFailure"] --> M["Close dangling runs / interrupted turns"]
```

이 흐름의 가장 주목할만한 측면은 **단일 후크가 독립적으로 추적을 완료할 수 없습니다**입니다. 실제 디자인은 "Stop에서 기록을 읽고 완료하는 것"이 ​​아니라 각 수명 주기 이벤트에서 제공되는 부분 신호를 조립하는 것입니다.

### <a href="#core-one-userpromptsubmit-establishes-the-root-node-first"
class="header">핵심 1: UserPromptSubmit이 루트 노드를 먼저 설정합니다.</a>

플러그인은 `UserPromptSubmit` 이벤트가 발생할 때 `Claude Code Turn` 루트 실행을 생성하고 다음 상태를 로컬 상태 파일에 씁니다.

- `current_turn_run_id`
- `current_trace_id`
- `current_dotted_order`
- `current_turn_number`
- `last_line`

이런 방식으로 후속 `PostToolUse`, `Stop` 및 `PostCompact`는 모두 실행을 연결할 상위 노드를 알고 있습니다.

이는 중요한 디자인 선택입니다. 많은 사람들이 "모든 것을 한 번에 생성"하기 위해 직관적으로 `Stop`에 추적을 배치하지만 두 가지 기능이 손실됩니다.

1. **진행 중인 턴**에 대해 안정적인 상위 실행 식별자를 제공할 수 없습니다.
2. 현재 차례에서 후속 비동기 이벤트(예: 도구 실행, 압축)를 올바르게 연결할 수 없습니다.

`UserPromptSubmit`의 의미는 "사용자가 메시지를 보냈습니다"가 아니라 **이 상호 작용 라운드에 대한 전역 앵커를 설정**하는 것입니다.

### <a
href="#core-two-transcript-is-the-fact-log-hooks-are-just-auxiliary-signals"
class="header">핵심 2: 기록은 사실 기록이고, 후크는 보조 신호일 뿐입니다.</a>

실제 콘텐츠 재구성은 `Stop` Hook에서 발생합니다.

플러그인은 전체 회전 추적을 구성하기 위해 후크 입력의 단일 필드에 의존하지 않습니다. 대신 `transcript_path`를 신뢰할 수 있는 이벤트 로그로 처리하여 마지막 처리 이후 새로운 JSONL 줄을 점진적으로 읽은 후 다음을 수행합니다.

1. `message.id`로 보조 스트리밍 청크를 병합합니다.
2. `tool_use`를 후속 `tool_result`와 페어링합니다.
3. 한 라운드의 사용자 입력을 `Turn`로 구성합니다.
4. `Turn`를 LangSmith의 계층 구조: `Claude Code Turn -> Claude(llm) -> Tool -> Claude(llm) ...`로 변환합니다.

이 접근 방식의 기초에는 중요한 판단이 깔려 있습니다. **후크는 특정 시점을 제공합니다. 성적표는 사실적 순서를 제공합니다.**

Hook에만 의존하는 경우:

- "일부 도구가 실행되었습니다"라는 것을 알고 있습니다.
- 그러나 어떤 LLM 호출을 따랐는지 모를 수도 있습니다.
- 도구 호출 전후의 전체 컨텍스트를 정확하게 복구하는 것도 어렵습니다.

성적표에만 의존하는 경우:

- 메시지 및 도구 순서를 복구할 수 있습니다.
- 하지만 도구의 실제 벽시계 시작/종료 시간은 알 수 없습니다.
- 또한 압축, 세션 종료, API 실패와 같은 호스트 수준 이벤트를 즉시 감지할 수 없습니다.

따라서 플러그인의 실제 기술은 스크립트나 후크가 아니라 **역할 분리**입니다.

- 성적 증명서는 **의미론적 진실**을 담당합니다.
- 후크는 **런타임 메타데이터**를 담당합니다.

### <a href="#core-three-why-pretooluse--posttooluse-are-still-needed"
class="header">핵심 3: PreToolUse / PostToolUse가 여전히 필요한 이유</a>

`Stop`가 이미 기록에서 도구 호출을 복구할 수 있는 경우 `PreToolUse`/`PostToolUse`가 여전히 필요한 이유는 무엇입니까?

대답: 녹취록은 **정확한 도구 타이머**라기보다는 **메시지 기록**에 더 가깝기 때문입니다.

LangSmith 플러그인은 두 가지 용도로 이 두 Hook을 사용합니다.

1. `PreToolUse`는 `tool_use_id -> start_time`를 기록합니다.
2. `PostToolUse`는 완료 시 일반 도구에 대한 도구 실행을 즉시 생성하고 `tool_use_id`를 `traced_tool_use_ids`에 기록합니다.

이런 방식으로 `Stop`는 기록 재생 중에 이미 추적된 일반 도구를 건너뛰어 중복 실행 생성을 방지할 수 있습니다. 또한 `last_tool_end_time`는 `Stop`가 기록 플러시 대기 시간으로 인해 발생하는 타이밍 오류를 수정하는 데 도움이 됩니다.

다시 말해서:

- `Stop`는 **의미적 재구성**을 해결합니다.
- `Pre/PostToolUse`는 **타이밍 정밀도**를 해결합니다.

이는 매우 일반적인 호스트 확장 패턴입니다. **의미론적 로그와 성능 타이밍은 서로 다른 신호 소스에서 나오며 강제로 하나의 소스로 병합될 수 없습니다.**

### <a href="#core-four-why-sub-agent-tracking-must-be-in-three-stages"
class="header">핵심 4: 하위 상담원 추적이 3단계로 이루어져야 하는 이유</a>

플러그인의 가장 멋진 부분은 하위 에이전트를 추적하는 방법입니다.

Claude Code는 공식적으로 두 가지 핵심 퍼즐 조각을 제공합니다.

1. `SubagentStop` 이벤트
2. `agent_transcript_path`

이 두 가지만으로는 충분하지 않습니다. 플러그인은 또한 다음 사항을 알아야 합니다. **이 하위 에이전트를 어떤 에이전트 도구에서 실행해야 합니까?**

따라서 3단계 설계를 채택합니다.

**1단계: PostToolUse가 에이전트 도구를 처리**

도구 반환에 `agentId`가 포함된 경우 플러그인은 최종 에이전트 도구 실행을 즉시 생성하지 않지만 `task_run_map`에 다음을 등록합니다.

- `run_id`
- `dotted_order`
- `deferred.start_time`
- `deferred.end_time`
- `deferred.inputs / outputs`

**2단계: SubagentStop만 대기열, 즉시 추적하지 않음**

`SubagentStop`가 `agent_id`, `agent_type` 및 `agent_transcript_path`를 수신한 후에는 LangSmith 요청을 즉시 수행하지 않고 `pending_subagent_traces`에만 추가됩니다.

**3단계: 주 정류장이 통합 정산을 수행합니다**

메인 스레드 `Stop`가 턴을 완료한 후:

1. 공유 상태를 다시 읽습니다.
2. `task_run_map` 병합
3. `pending_subagent_traces`를 검색합니다.
4. 하위 에이전트 기록을 읽습니다.
5. 에이전트 도구 실행 시 중간 `Subagent` 체인을 생성합니다.
6. 각 하위 Agent의 내부 턴을 하나씩 추적합니다.

이 세 단계를 수행하는 이유는 `PostToolUse` 및 `SubagentStop`가 모두 경쟁 조건이 있는 비동기 후크일 수 있기 때문입니다. `SubagentStop`가 기록 경로를 수신하자마자 즉시 추적하는 경우 다음이 발생할 수 있습니다.

- 아직 해당 에이전트 도구 실행 ID가 없습니다.
- 상위 점선 순서를 모릅니다.
- 결국 매달린 하위 에이전트 추적이 생성됩니다.

이 사례는 다음을 매우 명확하게 보여줍니다. **Claude Code의 Hook 시스템은 선형 콜백 모델이 아니라 동시 이벤트 소스입니다. 외부 플러그인은 자체 상태 조정 레이어를 제공해야 합니다.**

### <a href="#core-five-why-it-can-track-compaction-runs"
class="header">핵심 5: 다짐 실행을 추적할 수 있는 이유</a>

압축 추적은 플러그인이 기록에서 추측하는 것이 아닙니다. 두 가지 공식 이벤트 `PreCompact` / `PostCompact`를 직접 활용합니다.

그 접근 방식은 간단하지만 효과적입니다.

1. `PreCompact`는 현재 시간을 `compaction_start_time`로 기록합니다.
2. `PostCompact`는 `trigger` 및 `compact_summary`를 읽습니다.
3. 이 세 가지 정보를 사용하여 `Context Compaction` 실행을 생성합니다.

이는 Claude Code가 플러그인에 노출하는 것이 단지 "도구 전후"의 고전적인 후크 포인트가 아니라 컨텍스트 압축과 같은 **에이전트 내부 자체 유지 관리 동작**도 일류 이벤트로 노출된다는 것을 보여줍니다. 이것이 바로 외부 관찰성 플러그인이 "압축 실행"을 추적할 수 있는 이유입니다.

### <a href="#what-claude-code-actually-provides-this-plugin"
class="header">Claude Code가 실제로 이 플러그인을 제공하는 것</a>

소스 코드 분석에서 LangSmith 플러그인이 활용하는 정말 중요한 Claude Code "기능"은 6가지입니다.

<div class="table-wrapper">

| 호스트 기능 | 이것이 중요한 이유 |
|----|----|
| `hooks/hooks.json` 플러그인 항목 | 플러그인이 호스트 라이프사이클에 명령 유형 후크를 등록할 수 있도록 허용합니다. |
| 구조화된 표준 입력 JSON | Hooks는 필드 구조의 입력을 받습니다. 로그 텍스트 자체를 구문 분석할 필요가 없습니다. |
| `transcript_path` | 플러그인은 증분 읽기를 위한 지속 가능한 이벤트 로그로 기록을 처리할 수 있습니다. |
| `last_assistant_message` | `Stop`는 아직 완전히 기록되지 않은 꼬리 응답을 패치할 수 있습니다. |
| `agent_transcript_path` + `SubagentStop` | 메인 스레드에서 작업 도구만 보는 것이 아니라 하위 에이전트 추적이 가능해졌습니다. |
| `${CLAUDE_PLUGIN_ROOT}` + `async: true` | 플러그인은 자체 번들을 안정적으로 참조하고 백그라운드에서 네트워크 전달을 수행할 수 있습니다. |

</div>

이것이 일반적인 "터미널 레코더"가 아닌 이유이기도 합니다. 이는 우연히 사용할 수 있는 부작용이 아닌 **Claude Code가 의도적으로 설계한 플러그인 호스트 인터페이스**에 의존합니다.

### <a href="#boundary-its-not-api-level-tracing" class="header">경계: API 수준 추적이 아닙니다.</a>

이 플러그인은 매우 완전한 런타임 추적을 생성할 수 있지만 그 경계도 명확합니다.

1. **기본 API의 원시 요청이 아닌 Claude Code 런타임을 추적합니다.** 그것이 보는 것은 Anthropic API의 모든 원시 필드가 아니라 기록 및 후크 입력에서 재구성된 구조입니다.

2. **하위 에이전트는 현재 완료 후에만 추적할 수 있습니다.** 이는 플러그인 작성자가 게으른 것이 아니라 신호 표면에 의해 결정됩니다. `SubagentStop`가 발생할 때만 플러그인이 완전한 `agent_transcript_path`를 가져옵니다. 사용자가 하위 에이전트 실행 도중 중단하는 경우 README에서는 해당 하위 에이전트 실행이 추적되지 않음을 명시적으로 인정합니다.

3. **압축 이벤트는 압축 내의 모든 중간 상태가 아닌 요약만 표시합니다.** `PostCompact`는 관찰 가능성에는 충분하지만 완전한 압축 디버그 덤프는 아닌 `trigger + compact_summary`를 노출합니다.

### <a href="#what-this-means-for-agent-builders" class="header">Agent Builder에 대한 의미</a>

이 사례에서 가장 중요한 점은 "LangSmith와 통합하는 방법"이 아니라 다음과 같은 보다 일반적인 아키텍처 원칙입니다.

> **호스트가 이미 라이프사이클 후크 및 영구 기록을 제공하는 경우 외부 플러그인은 기본 시스템을 패치하지 않고도 고품질 런타임 관찰을 재구성할 수 있습니다.**

이 내용의 기초에는 재사용 가능한 세 가지 교훈이 있습니다.

1. **패킷 캡처가 아닌 호스트의 노출된 구조적 이벤트 표면을 먼저 살펴보세요.**
2. **녹취록을 사실 로그로 취급하고 Hooks를 메타 이벤트 패치로 취급합니다.**
3. **동시 후크를 위한 로컬 상태 시스템을 설계하고 중복 제거, 페어링 및 지연 결제를 처리합니다.**

자체 에이전트 시스템에 대한 외부 관찰성을 제공하려는 경우 이 사례는 거의 템플릿 역할을 할 수 있습니다. **전체 내부 상태 머신을 노출하려고 서두르지 마세요. 몇 가지 주요 Hook 필드와 내구성 있는 기록만 노출하면 제3자가 매우 강력한 통합을 구축할 수 있습니다.**

------------------------------------------------------------------------

### <a href="#version-evolution-v2192--dynamic-stop-hook-management"
class="header">버전 발전: v2.1.92 — 동적 중지 후크 관리</a>

> 다음 분석은 완전한 소스 코드 증거 없이 v2.1.92 번들 문자열 신호 추론을 기반으로 합니다.

v2.1.92에는 `tengu_stop_hook_added`, `tengu_stop_hook_command`, `tengu_stop_hook_removed`라는 세 가지 새로운 이벤트가 추가되었습니다. 이는 중요한 아키텍처 발전을 보여줍니다. **후크 구성이 순전히 정적 구성에서 런타임 관리 가능**으로 이동하고 있습니다.

#### <a href="#from-static-to-dynamic" class="header">정적에서 동적으로</a>

v2.1.88(이 장의 모든 이전 분석의 기초)에서 Hook 구성은 완전히 정적이었습니다. 세션 시작 시 로드되고 세션 중에 변경할 수 없는 `settings.json`, `.claude/settings.json` 또는 `plugin.json`에 후크를 정의했습니다. 후크를 변경하고 싶으신가요? 구성 파일을 편집하고 세션을 다시 시작하십시오.

v2.1.92는 적어도 Stop Hooks에 대해서는 이 제한을 깨뜨렸습니다. 세 가지 새로운 이벤트는 전체 CRUD 수명 주기의 세 가지 작업에 해당합니다.

- `stop_hook_added`: 런타임에 중지 후크 추가
- `stop_hook_command`: 정지 후크가 실행되었습니다.
- `stop_hook_removed`: 런타임 시 중지 후크 제거

즉, 사용자는 세션 중간에 "지금부터 중지할 때마다 테스트를 실행합니다"라고 말할 수 있으며, 에이전트는 중지 후크를 등록하기 위해 몇 가지 명령을 호출하고 그 후 에이전트 루프가 중지될 때마다 해당 후크가 트리거됩니다. 즉, 세션을 종료하거나 구성을 편집하고 다시 들어갈 필요가 없습니다.

#### <a href="#why-stop-hooks-got-dynamic-management-first"
class="header">Stop Hooks가 동적 관리를 먼저 받은 이유</a>

이 선택은 우연이 아닙니다. 중지 후크에는 동적 관리에 가장 적합한 세 가지 특성이 있습니다.

1. **강력한 작업 관련성**: Stop Hooks의 일반적인 용도는 "에이전트가 라운드를 완료한 후 수행할 작업"(테스트 실행, 자동 커밋, 코드 형식 지정, 알림 보내기)입니다. 이러한 요구 사항은 작업에 따라 변경됩니다. 코드를 작성할 때 `cargo check`가 자동으로 실행되기를 원합니다. 문서를 작성할 때는 그렇지 않습니다.

2. **낮은 보안 위험**: 에이전트가 중지된 후에 중지 후크가 트리거되며 에이전트의 결정 프로세스에 영향을 주지 않습니다. 대조적으로 PreToolUse Hooks는 도구 실행을 차단할 수 있습니다(섹션 18.3 참조). 이를 동적으로 수정하면 보안 위험이 발생할 수 있습니다. 공격자는 프롬프트 주입을 사용하여 에이전트가 안전 확인 후크를 제거하도록 할 수 있습니다.

3. **명확한 사용자 의도**: 중지 후크를 추가하고 제거하는 것은 에이전트의 자율적인 결정이 아니라 사용자의 명시적인 작업입니다. 이벤트 이름의 `added` 및 `removed`(`auto_added`가 아님)는 이것이 사용자 중심 작업임을 나타냅니다.

#### <a href="#design-philosophy-gradual-opening-of-hook-management"
class="header">디자인 철학: Hook Management의 점진적 개방</a>

Hook 시스템의 전체 아키텍처의 맥락에서 이 변경 사항을 적용하면 v2.1.88의 Hooks에는 명령 유형(settings.json), SDK 콜백, 등록된(`getRegisteredHooks`) 및 플러그인 네이티브(plugin Hooks.json)의 네 가지 소스가 있습니다(섹션 18.6 참조). 네 가지 모두 정적 구성이었습니다.

v2.1.92의 동적 Stop Hooks는 **다섯 번째 소스 — 런타임 사용자 명령**으로 볼 수 있습니다. 이는 "점진적 자율성" 철학(27장 참조)과 일치합니다. 사용자는 세션이 시작되기 전에 모든 구성을 완전히 계획할 필요 없이 세션 중에 에이전트의 동작을 점진적으로 조정합니다.

Stop Hooks의 동적 관리가 성공한 것으로 입증되면 PostToolUse Hooks로 확장될 수 있습니다("이 작업의 경우 모든 파일 쓰기 후에 lint를 실행"). 그러나 PreToolUse Hooks의 동적 관리는 보안 정책에 직접적인 영향을 미치기 때문에 더욱 주의해야 합니다.

------------------------------------------------------------------------

## <a href="#pattern-distillation" class="header">패턴 증류</a>

### <a href="#pattern-one-exit-code-as-protocol" class="header">패턴 1: 프로토콜로서의 종료 코드</a>

**문제 해결**: 셸 명령과 호스트 프로세스 간에 가벼운 의미 통신 메커니즘이 필요합니다.

**코드 템플릿**: 명확한 종료 코드 의미 정의 — `0`는 성공/허용을 의미하고, `2`는 차단 오류(stderr가 모델에 전송됨)를 의미하며, 다른 값은 비차단 오류(사용자에게만 표시됨)를 의미합니다. 다양한 이벤트 유형은 동일한 종료 코드에 다양한 의미를 할당할 수 있습니다(예: 중지 이벤트의 종료 코드 2는 "대화 계속"을 의미함).

**전제 조건**: 후크 개발자는 문서화된 종료 코드 계약이 필요합니다.

### <a href="#pattern-two-config-snapshot-isolation" class="header">패턴 2: 구성 스냅샷 격리</a>

**문제 해결**: 런타임 시 구성 파일이 수정되어 일관되지 않은 동작이 발생할 수 있습니다.

**코드 템플릿**: 시작 시 구성 스냅샷을 캡처합니다(`captureHooksConfigSnapshot`). 실시간으로 읽는 대신 런타임에 스냅샷을 사용합니다. 명시적인 사용자 수정 시에만 스냅샷을 업데이트합니다(`updateHooksConfigSnapshot`). 최신 값을 읽을 수 있도록 업데이트하기 전에 설정 캐시를 재설정하세요.

**전제 조건**: 구성 변경 빈도가 실행 빈도보다 낮습니다.

### <a href="#pattern-three-namespaced-deduplication" class="header">패턴 3: 네임스페이스 중복 제거</a>

**문제 해결**: 동일한 Hook 명령이 여러 구성 소스에 나타날 수 있으며, 컨텍스트 간 병합 없이 중복 제거가 필요할 수 있습니다.

**코드 템플릿**: 중복 제거 키에는 소스 컨텍스트(예: 플러그인 디렉터리 경로)가 포함됩니다. 다른 플러그인의 동일한 명령은 독립적으로 유지되는 반면, 동일한 소스 내의 사용자/프로젝트/로컬 계층 전체의 동일한 명령은 병합됩니다.

**전제 조건**: 후크에는 명확한 소스 식별자가 있습니다.

### <a href="#pattern-four-host-signal-reconstruction"
class="header">패턴 4: 호스트 신호 재구성</a>

**문제 해결**: 외부 플러그인은 고품질 추적을 구축하려고 하지만 호스트는 미리 만들어진 추적 트리가 아닌 분산된 수명 주기 이벤트를 노출합니다.

**코드 템플릿**: 후크를 사용하여 메타 이벤트(시작 시간, 종료 시간, 하위 작업 경로, 압축 요약)를 수집하고 기록을 의미 순서 재생을 위한 사실 로그로 사용한 다음 로컬 상태 파일을 통해 커서, 상위-하위 매핑 및 보류 중인 대기열을 유지 관리하여 궁극적으로 외부 시스템의 전체 계층 구조를 재구성합니다.

**전제 조건**: 호스트는 최소한의 구조화된 Hook 입력과 점진적으로 읽을 수 있는 기록을 노출합니다.

------------------------------------------------------------------------

## <a href="#summary" class="header">요약</a>

Hooks 시스템의 설계에는 여러 가지 엔지니어링 균형이 반영되어 있습니다.

1. **유연성 대 보안**: 신뢰 게이팅 및 종료 코드 의미 체계를 통해 "임의 명령 실행 허용"과 "악의적인 악용 방지"의 균형을 유지합니다.
2. **동기식 대 비동기식**: 비동기 생성기 + 백그라운드 후크 + asyncRewake의 3단계 전략을 통해 사용자는 차단 수준을 선택할 수 있습니다.
3. **단순함 vs. 강력함**: 간단한 셸 명령부터 완전한 에이전트 유효성 검사기에 이르기까지 4가지 유형이 다양한 복잡성 요구 사항을 충족합니다.
4. **격리 대 공유**: 구성 스냅샷 메커니즘 + 네임스페이스 중복 제거 키는 다중 소스 구성이 서로 간섭하지 않도록 보장합니다.
5. **호스트 인터페이스 대 심층 침입**: Hook 표면과 사본이 잘 설계되어 있는 한 외부 플러그인은 기본 시스템을 패치하지 않고도 강력한 관찰성을 달성할 수 있습니다.

다음 장에서는 코드 실행을 통해 동작에 영향을 주지 않고 자연어 명령을 통해 모델 출력을 직접 제어하는 ​​CLAUDE.md 명령 시스템이라는 또 다른 사용자 정의 메커니즘을 살펴보겠습니다.
