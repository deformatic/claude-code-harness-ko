# <a
href="#chapter-4b-plan-mode--from-act-first-ask-later-to-look-before-you-leap"
class="header">4b장: 계획 모드 — "먼저 행동하고 나중에 묻기"에서 "도약하기 전에 살펴보기"까지</a>

> **포지셔닝**: 이 장에서는 완전한 "먼저 계획하고 두 번째 실행" 상태 머신인 Claude Code의 계획 모드를 분석합니다. 전제 조건: 3장(에이전트 루프), 4장(도구 실행 오케스트레이션). 사용 시기: CC가 인간 조정 계획 승인 메커니즘을 구현하는 방법을 이해하고 싶거나 자체 AI 에이전트에서 유사한 "실행 전 계획" 워크플로를 구현하고 싶습니다.

------------------------------------------------------------------------

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

AI 코딩 에이전트의 가장 큰 위험 중 하나는 잘못된 코드를 작성하는 것이 아니라 **잘못된 것에 대해 올바른 코드를 작성**하는 것입니다. 사용자가 "인증 모듈 리팩터링"이라고 말하면 에이전트는 사용자가 OAuth2를 염두에 두고 있는 동안 JWT를 선택할 수 있습니다. 에이전트가 즉시 구현을 시작하면 사용자가 방향이 잘못되었음을 발견할 때쯤에는 이미 수십 개의 파일이 수정된 상태입니다.

계획 모드는 **의도 정렬** 문제를 해결합니다. 에이전트가 코드를 수정하기 전에 먼저 코드베이스를 탐색하고 계획을 생성한 후 사용자 승인을 얻습니다. 이는 단순한 "실행 전 확인"이 아닙니다. 권한 모드 전환, 계획 파일 지속성, 워크플로 프롬프트 삽입, 팀 간 승인 프로토콜 및 자동 모드와의 복잡한 상호 작용을 포함하는 완전한 상태 시스템입니다.

엔지니어링 관점에서 볼 때 계획 모드는 세 가지 주요 설계 결정을 보여줍니다.

1. **행동 제약으로서의 권한 모드**: 계획 모드에 들어간 후 모델의 도구 세트는 "파일을 수정하지 마십시오"라는 프롬프트를 통해서가 아니라 도구 실행 전에 쓰기 작업을 가로채는 권한 시스템을 통해 읽기 전용으로 제한됩니다.
2. **정렬 수단으로서의 계획 파일**: 계획은 대화 컨텍스트에서 텍스트로 유지되지 않습니다. 계획은 사용자가 외부 편집기에서 편집할 수 있고 CCR 원격 세션이 로컬 터미널로 다시 전송할 수 있는 Markdown 파일로 디스크에 기록됩니다.
3. **부울 플래그가 아닌 상태 머신**: 계획 모드는 단순한 `isPlanMode` 플래그가 아닙니다. 각 전환에는 관리해야 할 부작용이 있는 진입, 탐색, 승인, 종료 및 복원을 포괄하는 완전한 상태 전환 체인입니다.

------------------------------------------------------------------------

## <a href="#4b1-the-plan-mode-state-machine-entry-and-exit"
class="header">4b.1 계획 ​​모드 상태 머신: 시작 및 종료</a>

계획 모드의 핵심에는 `EnterPlanMode` 및 `ExitPlanMode`라는 두 가지 도구와 해당 도구가 트리거하는 권한 모드 전환이 있습니다.

### <a href="#entering-plan-mode" class="header">계획 모드 들어가기</a>

계획 모드로 들어가는 경로는 두 가지가 있습니다.

1. **모델은 `EnterPlanMode` 도구를 사전에 호출합니다** — 사용자 확인이 필요합니다.
2. **사용자가 `/plan` 명령을 수동으로 입력합니다** — 즉시 적용됩니다.

두 경로 모두 궁극적으로 동일한 핵심 기능인 `prepareContextForPlanMode`를 호출합니다.

``` typescript
// restored-src/src/utils/permissions/permissionSetup.ts:1462-1492
export function prepareContextForPlanMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const currentMode = context.mode
  if (currentMode === 'plan') return context
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const planAutoMode = shouldPlanUseAutoMode()
    if (currentMode === 'auto') {
      if (planAutoMode) {
        return { ...context, prePlanMode: 'auto' }
      }
      // ... deactivate auto mode and restore permissions stripped by auto
    }
    if (planAutoMode && currentMode !== 'bypassPermissions') {
      autoModeStateModule?.setAutoModeActive(true)
      return {
        ...stripDangerousPermissionsForAutoMode(context),
        prePlanMode: currentMode,
      }
    }
  }
  return { ...context, prePlanMode: currentMode }
}
```

주요 설계: **`prePlanMode` 필드는 입력 전 모드를 저장합니다**. 이는 전형적인 "저장/복원" 패턴입니다. 계획 모드에 들어갈 때 현재 모드(`default`, `auto` 또는 `acceptEdits`일 수 있음)가 `prePlanMode`에 저장되고 종료 시 복원됩니다. 이렇게 하면 계획 모드가 사용자의 이전 권한 구성을 잃지 않는 **되돌릴 수 있는 작업**이 되도록 보장됩니다.

`EnterPlanMode` 도구 정의 자체는 몇 가지 중요한 제약 조건을 나타냅니다.

``` typescript
// restored-src/src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:36-102
export const EnterPlanModeTool: Tool<InputSchema, Output> = buildTool({
  name: ENTER_PLAN_MODE_TOOL_NAME,
  shouldDefer: true,
  isEnabled() {
    // Disabled when --channels is active, preventing plan mode from becoming a trap
    if ((feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
        getAllowedChannels().length > 0) {
      return false
    }
    return true
  },
  isConcurrencySafe() { return true },
  isReadOnly() { return true },
  async call(_input, context) {
    if (context.agentId) {
      throw new Error('EnterPlanMode tool cannot be used in agent contexts')
    }
    // ... execute mode switch
  },
})
```

주목할 만한 세 가지 제약 조건:

<div class="table-wrapper">

| 강제 | 암호 | 이유 |
|----|----|----|
| `shouldDefer: true` | 도구 정의 | 지연된 로딩 — 초기 스키마 공간을 소비하지 않습니다(2장 참조). |
| 에이전트 컨텍스트에서는 금지됨 | `context.agentId` 확인 | 하위 에이전트는 스스로 계획 모드에 들어가서는 안 됩니다. 이는 기본 세션 권한입니다. |
| 채널이 활성화되면 비활성화됩니다. | `getAllowedChannels()` 확인 | KAIROS 모드에서 사용자는 텔레그램/디스코드에 접속하여 승인 대화 상자를 볼 수 없습니다. 종료할 방법이 없는 플랜 모드에 들어가면 "트랩"이 생성됩니다. |

</div>

### <a href="#exiting-plan-mode" class="header">계획 모드 종료</a>

나가는 것은 들어가는 것보다 훨씬 더 복잡합니다. `ExitPlanModeV2Tool`에는 세 가지 실행 경로가 있습니다.

``` mermaid
flowchart TD
    A[ExitPlanMode called] --> B{Caller identity?}
    B -->|Non-teammate| C{Current mode is plan?}
    C -->|No| D[Reject: not in plan mode]
    C -->|Yes| E[Show approval dialog]
    E --> F{User choice?}
    F -->|Approve| G[Restore prePlanMode]
    F -->|Reject| H[Stay in plan mode]
    G --> I[Return plan content]
    
    B -->|Teammate + planModeRequired| J{Plan file exists?}
    J -->|No| K[Throw error]
    J -->|Yes| L[Send plan_approval_request to team-lead mailbox]
    L --> M[Wait for leader approval]
    
    B -->|Teammate voluntary plan| N[Exit directly, no approval needed]
```

종료 시 가장 복잡한 부분은 **권한 복원**입니다.

``` typescript
// restored-src/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:357-403
context.setAppState(prev => {
  if (prev.toolPermissionContext.mode !== 'plan') return prev
  setHasExitedPlanMode(true)
  setNeedsPlanModeExitAttachment(true)
  let restoreMode = prev.toolPermissionContext.prePlanMode ?? 'default'
  
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // Circuit breaker defense: if auto mode gate is disabled, fall back to default
    if (restoreMode === 'auto' &&
        !(permissionSetupModule?.isAutoModeGateEnabled() ?? false)) {
      restoreMode = 'default'
    }
    // ... sync auto mode activation state
  }
  
  // Non-auto mode: restore dangerous permissions that were stripped
  const restoringToAuto = restoreMode === 'auto'
  if (restoringToAuto) {
    baseContext = permissionSetupModule?.stripDangerousPermissionsForAutoMode(baseContext)
  } else if (prev.toolPermissionContext.strippedDangerousRules) {
    baseContext = permissionSetupModule?.restoreDangerousPermissions(baseContext)
  }
  
  return {
    ...prev,
    toolPermissionContext: {
      ...baseContext,
      mode: restoreMode,
      prePlanMode: undefined, // clear the saved mode
    },
  }
})
```

이 코드는 **회로 차단기 방어 패턴**을 보여줍니다. 사용자가 자동 ​​모드에서 계획을 입력했지만 계획 중에 자동 모드 회로 차단기가 작동한 경우(예: 연속 거부가 한도를 초과함) 종료 계획은 자동으로 복원되지 않고 대신 `default`로 돌아갑니다. 이렇게 하면 위험한 시나리오를 방지할 수 있습니다. 즉, 회로 차단기를 우회하여 계획 모드를 종료하여 자동 모드를 직접 복원합니다.

### <a href="#state-transition-debouncing" class="header">상태 전환 디바운싱</a>

사용자는 신속하게 계획 모드를 전환할 수 있습니다(입력 → 즉시 종료 → 다시 입력). `handlePlanModeTransition`는 다음과 같은 극단적인 경우를 처리합니다.

``` typescript
// restored-src/src/bootstrap/state.ts:1349-1363
export function handlePlanModeTransition(fromMode: string, toMode: string): void {
  // When switching TO plan, clear any pending exit attachment — prevents sending both enter and exit notifications
  if (toMode === 'plan' && fromMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = false
  }
  // When leaving plan, mark that an exit attachment needs to be sent
  if (fromMode === 'plan' && toMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = true
  }
}
```

이는 전형적인 **일회성 알림** 디자인입니다. 첨부 플래그는 소비 후 즉시 지워져 중복 전송을 방지합니다.

------------------------------------------------------------------------

## <a href="#4b2-plan-files-persistent-intent-alignment"
class="header">4b.2 계획 파일: 지속적인 의도 정렬</a>

계획 모드의 주요 디자인 결정은 다음과 같습니다. **계획은 대화 컨텍스트에 머무르지 않고 디스크 파일에 기록됩니다**. 이는 세 가지 이점을 제공합니다.

1. 사용자는 외부 편집기에서 계획을 수정할 수 있습니다(`/plan open`).
2. 계획은 손실 없이 컨텍스트 압축을 유지합니다(10장 참조).
3. CCR 원격 세션의 계획을 로컬 터미널로 다시 전송할 수 있습니다.

### <a href="#file-naming-and-storage" class="header">파일 이름 지정 및 저장</a>

``` typescript
// restored-src/src/utils/plans.ts:79-128
export const getPlansDirectory = memoize(function getPlansDirectory(): string {
  const settings = getInitialSettings()
  const settingsDir = settings.plansDirectory
  let plansPath: string

  if (settingsDir) {
    const cwd = getCwd()
    const resolved = resolve(cwd, settingsDir)
    // Path traversal defense
    if (!resolved.startsWith(cwd + sep) && resolved !== cwd) {
      logError(new Error(`plansDirectory must be within project root: ${settingsDir}`))
      plansPath = join(getClaudeConfigHomeDir(), 'plans')
    } else {
      plansPath = resolved
    }
  } else {
    plansPath = join(getClaudeConfigHomeDir(), 'plans')
  }
  // ...
})

export function getPlanFilePath(agentId?: AgentId): string {
  const planSlug = getPlanSlug(getSessionId())
  if (!agentId) {
    return join(getPlansDirectory(), `${planSlug}.md`)  // main session
  }
  return join(getPlansDirectory(), `${planSlug}-agent-${agentId}.md`)  // sub-agent
}
```

<div class="table-wrapper">

| 차원 | 디자인 결정 | 이유 |
|----|----|----|
| 기본 위치 | `~/.claude/plans/` | 프로젝트 독립적인 전역 디렉터리 — 코드 저장소를 오염시키지 않습니다. |
| 구성 가능 | `settings.plansDirectory` | 팀은 `.claude/plans/`와 같은 프로젝트 로컬 디렉터리로 구성할 수 있습니다. |
| 경로 순회 방어 | `resolved.startsWith(cwd + sep)` | 구성된 경로가 프로젝트 루트를 벗어나는 것을 방지합니다. |
| 파일 이름 | `{wordSlug}.md` | UUID 대신 단어 슬러그(예: `brave-fox.md`)를 사용합니다. — 사람이 읽을 수 있습니다. |
| 하위 에이전트 격리 | `{wordSlug}-agent-{agentId}.md` | 각 하위 에이전트는 덮어쓰기를 방지하기 위해 독립적인 계획 파일을 얻습니다. |
| 메모 | `memoize(getPlansDirectory)` | 모든 도구 렌더링에서 `mkdirSync` 시스템 호출 트리거를 방지합니다(#20005 회귀 수정). |

</div>

### <a href="#plan-slug-generation" class="header">슬러그 생성 계획</a>

각 세션은 `planSlugCache`에 캐시된 고유한 단어 슬러그를 생성합니다.

``` typescript
// restored-src/src/utils/plans.ts:32-49
export function getPlanSlug(sessionId?: SessionId): string {
  const id = sessionId ?? getSessionId()
  const cache = getPlanSlugCache()
  let slug = cache.get(id)
  if (!slug) {
    const plansDir = getPlansDirectory()
    for (let i = 0; i < MAX_SLUG_RETRIES; i++) {
      slug = generateWordSlug()
      const filePath = join(plansDir, `${slug}.md`)
      if (!getFsImplementation().existsSync(filePath)) {
        break  // found a non-conflicting slug
      }
    }
    cache.set(id, slug!)
  }
  return slug!
}
```

충돌 감지는 최대 10회까지 재시도됩니다(`MAX_SLUG_RETRIES = 10`). `generateWordSlug()`는 `adjective-noun` 조합(일반적으로 각 단어 유형에 대해 수천 개의 어휘 크기, 수백만 개의 가능한 조합 생성)을 사용하므로 자주 사용되는 디렉토리에서도 충돌 확률이 매우 낮습니다.

### <a href="#the-plan-command" class="header"><code>/plan</code> 명령</a>

사용자는 `/plan` 명령을 통해 계획과 상호 작용합니다.

``` typescript
// restored-src/src/commands/plan/plan.tsx:64-121
export async function call(onDone, context, args) {
  const currentMode = appState.toolPermissionContext.mode
  
  // If not in plan mode, enable it
  if (currentMode !== 'plan') {
    handlePlanModeTransition(currentMode, 'plan')
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: applyPermissionUpdate(
        prepareContextForPlanMode(prev.toolPermissionContext),
        { type: 'setMode', mode: 'plan', destination: 'session' },
      ),
    }))
    const description = args.trim()
    if (description && description !== 'open') {
      onDone('Enabled plan mode', { shouldQuery: true })  // with description → trigger query
    } else {
      onDone('Enabled plan mode')
    }
    return null
  }
  
  // Already in plan mode — show current plan or open in editor
  if (argList[0] === 'open') {
    const result = await editFileInEditor(planPath)
    // ...
  }
}
```

`/plan` 명령에는 네 가지 동작이 있습니다.

- `/plan` — 계획 모드 활성화(아직 계획 모드에 있지 않은 경우)
- `/plan <description>` — 설명과 함께 계획 모드 활성화(`shouldQuery: true`는 모델을 트리거하여 계획을 시작함)
- `/plan`(이미 계획 모드에 있음) — 현재 계획 콘텐츠 및 파일 경로를 표시합니다. 계획이 없으면 "아직 작성된 계획 없음"이 표시됩니다.
- `/plan open` — 외부 편집기에서 계획 파일을 엽니다.

------------------------------------------------------------------------

## <a href="#4b3-plan-prompt-injection-the-5-phase-workflow"
class="header">4b.3 계획 프롬프트 주입: 5단계 작업 흐름</a>

계획 모드에 들어간 후 시스템은 **첨부 메시지**를 통해 모델에 워크플로 지침을 삽입합니다. 이것이 계획 모드의 핵심 동작 제약입니다. 도구 제한을 사용하여 모델에 "무엇을 할 수 없는지"를 알려주는 대신 프롬프트가 모델에 "무엇을 해야 하는지"를 알려줍니다.

### <a href="#attachment-types" class="header">첨부파일 유형</a>

계획 모드에서는 세 가지 첨부 파일 유형을 사용합니다.

<div class="table-wrapper">

| 첨부파일 유형 | 방아쇠 | 콘텐츠 |
|----|----|----|
| `plan_mode` | N번의 휴먼 메시지 턴마다 주입됨 | 전체 또는 스파스 워크플로 지침 |
| `plan_mode_reentry` | 종료 후 계획 모드로 다시 진입 | "이전에 계획 모드를 종료했습니다. 먼저 기존 계획을 확인하세요." |
| `plan_mode_exit` | 계획 모드 종료 후 첫 번째 턴 | "계획 모드를 종료했습니다. 이제 구현을 시작할 수 있습니다." |

</div>

### <a href="#full-vs-sparse-throttling" class="header">전체 조절과 스파스 조절</a>

``` typescript
// restored-src/src/utils/attachments.ts:1195-1241
function getPlanModeAttachments(messages, toolUseContext) {
  // Check how many human turns since the last plan_mode attachment
  const { turnCount, foundPlanModeAttachment } = 
    getPlanModeAttachmentTurnCount(messages)
  
  // Already have an attachment and interval too short → skip
  if (foundPlanModeAttachment &&
      turnCount < PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS) {
    return []
  }
  
  // Decide full or sparse
  const attachmentCount = countPlanModeAttachmentsSinceLastExit(messages)
  const reminderType = attachmentCount %
    PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS === 1
    ? 'full' : 'sparse'
  
  attachments.push({ type: 'plan_mode', reminderType, isSubAgent, planFilePath, planExists })
  return attachments
}
```

**전체 첨부 파일**에는 전체 5단계 작업 흐름 지침(최대 2,000자 이상)이 포함되어 있습니다. **희소 첨부 파일**은 한 줄 알림입니다.

계획 모드는 여전히 활성 상태입니다(대화 앞부분의 전체 지침 참조). 계획 파일({planFilePath})을 제외하고 읽기 전용입니다. 5단계 작업흐름을 따르세요.

이것은 **토큰 비용 최적화**입니다. 전체 지침은 1번째, 6번째, 11번째... 발생에만 주입됩니다. 다른 모든 턴은 sparse를 사용합니다. 카운터는 시간 계획 모드가 종료될 때마다 재설정됩니다.

### <a href="#the-5-phase-workflow-standard-mode" class="header">5단계 작업 흐름(표준 모드)</a>

`isPlanModeInterviewPhaseEnabled()`가 `false`를 반환하면 모델은 5단계 지침을 받습니다.

``` mermaid
flowchart LR
    P1["Phase 1<br/>Initial Understanding<br/>Launch Explore agents"] --> P2["Phase 2<br/>Design<br/>Launch Plan agents"]
    P2 --> P3["Phase 3<br/>Review<br/>Read critical files"]
    P3 --> P4["Phase 4<br/>Final Plan<br/>Write to plan file"]
    P4 --> P5["Phase 5<br/>ExitPlanMode<br/>Submit for approval"]
```

``` typescript
// restored-src/src/utils/messages.ts:3227-3292 (core instructions, simplified)
const content = `Plan mode is active. The user indicated that they do not want 
you to execute yet -- you MUST NOT make any edits (with the exception of the 
plan file mentioned below)...

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request...
Launch up to ${exploreAgentCount} Explore agents IN PARALLEL...

### Phase 2: Design
Launch Plan agent(s) to design the implementation...
You can launch up to ${agentCount} agent(s) in parallel.

### Phase 3: Review
Read the critical files identified by agents...
Use AskUserQuestion to clarify any remaining questions.

### Phase 4: Final Plan
Write your final plan to the plan file (the only file you can edit).

### Phase 5: Call ExitPlanMode
Once you are happy with your final plan file - call ExitPlanMode.
This is critical - your turn should only end with either AskUserQuestion OR ExitPlanMode.`
```

에이전트 수는 구독 등급에 따라 동적으로 조정됩니다.

``` typescript
// restored-src/src/utils/planModeV2.ts:5-29
export function getPlanModeV2AgentCount(): number {
  // Environment variable override
  if (process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT) { /* ... */ }
  // Max 20x subscription → 3 agents
  if (subscriptionType === 'max' && rateLimitTier === 'default_claude_max_20x') return 3
  // Enterprise/Team → 3 agents
  if (subscriptionType === 'enterprise' || subscriptionType === 'team') return 3
  // Others → 1 agent
  return 1
}
```

<div class="table-wrapper">

| 구독 등급 | 계획 대리인 | 에이전트 살펴보기 |
|-------------------|-------------|----------------|
| 최대(20x) | 3 | 3 |
| 기업/팀 | 3 | 3 |
| 기타 | 1 | 3 |

</div>

### <a href="#interview-workflow-iterative-mode" class="header">인터뷰 워크플로(반복 모드)</a>

`isPlanModeInterviewPhaseEnabled()`가 `true`를 반환하면(Anthropic 내부 사용자의 경우 항상 true) 다른 작업 흐름이 사용됩니다.

``` typescript
// restored-src/src/utils/messages.ts:3323-3378
const content = `Plan mode is active...

## Iterative Planning Workflow

You are pair-planning with the user. Explore the code to build context, 
ask the user questions when you hit decisions you can't make alone, and 
write your findings into the plan file as you go.

### The Loop
Repeat this cycle until the plan is complete:
1. **Explore** — Use Read, Glob, Grep to read code...
2. **Update the plan file** — After each discovery, immediately capture what you learned.
3. **Ask the user** — When you hit an ambiguity, use AskUserQuestion. Then go back to step 1.

### First Turn
Start by quickly scanning a few key files... Then write a skeleton plan and 
ask the user your first round of questions. Don't explore exhaustively before engaging the user.

### Asking Good Questions
- Never ask what you could find out by reading the code
- Batch related questions together
- Focus on things only the user can answer: requirements, preferences, tradeoffs`
```

인터뷰 모드와 표준 5단계 모드의 주요 차이점:

<div class="table-wrapper">

| 차원 | 5상 모드 | 인터뷰 모드 |
|----|----|----|
| 상호작용 스타일 | 완전히 탐색한 후 계획을 제출하세요. | 탐색하고 반복적으로 질문하세요. |
| 에이전트 사용량 | 탐색/계획 에이전트 강제 사용 | 직접 도구 사용 권장, 상담원 선택 사항 |
| 계획 파일 | 4단계에서 한 번 작성됨 | 발견할 때마다 점진적으로 업데이트됨 |
| 사용자 참여 | 5단계 최종 승인 | 지속적인 참여, 다단계 대화 |
| 대상 사용자 | 외부 사용자(더 자동화됨) | 내부 사용자(더 협력적) |

</div>

### <a href="#pewter-ledger-experiment-plan-file-length-optimization"
class="header">Pewter Ledger 실험: 파일 길이 최적화 계획</a>

계획 모드의 흥미로운 A/B 실험은 계획 파일 구조와 길이를 최적화하는 `tengu_pewter_ledger`입니다.

``` typescript
// restored-src/src/utils/planModeV2.ts:66-95
// Baseline (control, 14d ending 2026-03-02, N=26.3M):
//   p50 4,906 chars | p90 11,617 | mean 6,207 | 82% Opus 4.6
//   Reject rate monotonic with size: 20% at <2K → 50% at 20K+
//
// Primary: session-level Avg Cost
export function getPewterLedgerVariant(): PewterLedgerVariant {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE('tengu_pewter_ledger', null)
  if (raw === 'trim' || raw === 'cut' || raw === 'cap') return raw
  return null
}
```

4개의 실험 부문이 4단계 지침을 점진적으로 강화합니다.

<div class="table-wrapper">

| 팔 | 주요 지시사항 | 표적 효과 |
|----|----|----|
| **제어** | "컨텍스트 섹션으로 시작하세요... 빠르게 스캔할 수 있을 만큼 간결합니다." | 기준: 평균 6,207자 |
| **손질** | "한 줄 컨텍스트... 단일 확인 명령" | 가벼운 압축 |
| **자르다** | "컨텍스트/배경을 쓰지 마십시오... 40줄 미만의 가장 좋은 계획입니다." | 적당한 압축 |
| **캡** | "엄격한 제한: 40줄. 더 길면 파일 경로가 아닌 문장을 삭제하세요." | 하드캡 |

</div>

댓글에 기록된 기본 데이터는 다음과 같은 주요 결과를 보여줍니다. **거부율은 계획 기간과 단조로운 상관관계가 있습니다** — 2,000자 미만의 계획은 거부율이 20%인 반면, 20,000개 이상의 계획은 거부율이 50%입니다. 더 긴 계획이 더 나은 계획을 의미하지는 않습니다.

### <a href="#different-trigger-thresholds-for-internal-vs-external-users"
class="header">내부 사용자와 외부 사용자에 대한 다양한 트리거 임계값</a>

EnterPlanMode 도구 프롬프트에는 두 가지 버전이 있습니다.

``` typescript
// restored-src/src/tools/EnterPlanModeTool/prompt.ts:166-170
export function getEnterPlanModeToolPrompt(): string {
  return process.env.USER_TYPE === 'ant'
    ? getEnterPlanModeToolPromptAnt()
    : getEnterPlanModeToolPromptExternal()
}
```

<div class="table-wrapper">

| 차원 | 외부 버전 | 내부 버전 |
|----|----|----|
| 트리거 임계값 | **낮음** — "간단하지 않은 경우 구현 작업에 EnterPlanMode 사용을 선호합니다." | **높음** — "접근 방식이 정말로 불분명할 때 계획 모드가 유용합니다." |
| 예시 차이점 | "삭제 버튼 추가" → **계획해야 함**(확인 대화상자, API, 상태 포함) | "삭제 버튼 추가" → **하지 말아야 할** 계획 ("구현 경로가 명확함") |
| 기본 환경설정 | "확실하지 않다면 계획을 잘못 세우세요" | "작업 시작 및 AskUserQuestion 사용을 선호합니다." |

</div>

이러한 내부/외부 차이점은 제품 전략을 반영합니다. 외부 사용자는 더 많은 정렬 보호(에이전트가 분기될 때 비용이 많이 드는 재작업 방지)가 필요한 반면, 내부 사용자는 도구 동작에 더 익숙하고 빠른 실행을 선호합니다.

------------------------------------------------------------------------

## <a
href="#4b4-the-approval-flow-the-critical-human-ai-collaboration-point"
class="header">4b.4 승인 흐름: 중요한 인간-AI ​​협업 지점</a>

### <a href="#user-approval-standard-flow" class="header">사용자 승인(표준 흐름)</a>

모델이 `ExitPlanMode`를 호출하면 팀원이 아닌 시나리오에 대해 사용자 승인 대화 상자가 트리거됩니다.

``` typescript
// restored-src/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:221-238
async checkPermissions(input, context) {
  if (isTeammate()) {
    return { behavior: 'allow' as const, updatedInput: input }
  }
  return {
    behavior: 'ask' as const,
    message: 'Exit plan mode?',
    updatedInput: input,
  }
}
```

승인 후 `mapToolResultToToolResultBlockParam`는 승인된 계획을 tool_result에 삽입합니다.

``` typescript
// restored-src/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:481-492
return {
  type: 'tool_result',
  content: `User has approved your plan. You can now start coding. Start with updating your todo list if applicable

Your plan has been saved to: ${filePath}
You can refer back to it if needed during implementation.${teamHint}

## ${planLabel}:
${plan}`,
  tool_use_id: toolUseID,
}
```

사용자가 CCR 웹 UI에서 계획을 편집한 경우 `planWasEdited` 플래그는 모델이 콘텐츠가 수정되었음을 알 수 있도록 보장합니다.

``` typescript
// restored-src/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:477-478
const planLabel = planWasEdited
  ? 'Approved Plan (edited by user)'
  : 'Approved Plan'
```

### <a href="#team-leader-approval" class="header">팀장 승인</a>

팀 모드에서 팀원 에이전트의 계획에는 팀 리더의 승인이 필요합니다(20b장 참조). `ExitPlanModeV2Tool`는 사서함 시스템을 통해 승인 요청을 보냅니다.

``` typescript
// restored-src/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:264-312
if (isTeammate() && isPlanModeRequired()) {
  const approvalRequest = {
    type: 'plan_approval_request',
    from: agentName,
    timestamp: new Date().toISOString(),
    planFilePath: filePath,
    planContent: plan,
    requestId,
  }
  
  await writeToMailbox('team-lead', {
    from: agentName,
    text: jsonStringify(approvalRequest),
    timestamp: new Date().toISOString(),
  }, teamName)
  
  return {
    data: {
      plan, isAgent: true, filePath,
      awaitingLeaderApproval: true,
      requestId,
    },
  }
}
```

승인 요청은 팀장의 메일함 파일(`~/.claude/teams/{team}/inboxes/team-lead.json`)에 기록된 JSON 메시지입니다. 메시지는 동시성 안전을 위해 `proper-lockfile`를 사용합니다.

### <a href="#plan-execution-verification" class="header">계획 실행 검증</a>

ExitPlanMode 반환 값에는 `hasTaskTool` 플래그가 포함됩니다.

``` typescript
// restored-src/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:405-408
const hasTaskTool =
  isAgentSwarmsEnabled() &&
  context.options.tools.some(t => toolMatchesName(t, AGENT_TOOL_NAME))
```

Agent Swarm을 사용할 수 있으면 tool_result에 힌트가 추가됩니다.

> 이 계획을 여러 개의 독립적인 작업으로 나눌 수 있는 경우 TeamCreate 도구를 사용하여 팀을 만들고 작업을 병렬화하는 것을 고려해 보세요.

이는 계획 모드 출력을 다중 에이전트 실행에 **완벽하게 연결**합니다(20b장 참조).

------------------------------------------------------------------------

## <a href="#4b5-auto-mode-and-plan-mode-interaction" class="header">4b.5 자동 모드와 계획 모드 상호 작용</a>

자동 모드(YOLO 분류자, 17장 참조)와 계획 모드 상호 작용은 CC 권한 시스템의 가장 복잡한 부분 중 하나입니다.

### <a href="#permission-saving-on-entry" class="header">입장시 권한 절약</a>

사용자가 자동 ​​모드에서 계획 모드로 들어갈 때 두 가지 전략이 있습니다.

``` typescript
// restored-src/src/utils/permissions/permissionSetup.ts:1469-1486
if (currentMode === 'auto') {
  if (planAutoMode) {
    // Keep auto active → classifier continues working during plan
    return { ...context, prePlanMode: 'auto' }
  }
  // Deactivate auto → strip dangerous permissions
  // ...
}
```

`shouldPlanUseAutoMode()`는 사용자 설정에 따라 계획 모드 중에 분류자를 활성 상태로 유지할지 여부를 결정합니다. 활성 상태로 유지되면 계획 모드에서 모델의 읽기 전용 작업은 분류자에 의해 계속 자동 승인됩니다. 비활성화되면 모든 작업에 사용자 확인이 필요합니다.

### <a href="#circuit-breaker-check-on-exit" class="header">출구에서 회로 차단기 확인</a>

``` typescript
// restored-src/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:328-346
if (feature('TRANSCRIPT_CLASSIFIER')) {
  const prePlanRaw = appState.toolPermissionContext.prePlanMode ?? 'default'
  if (prePlanRaw === 'auto' &&
      !(permissionSetupModule?.isAutoModeGateEnabled() ?? false)) {
    const reason = permissionSetupModule?.getAutoModeUnavailableReason() ?? 'circuit-breaker'
    gateFallbackNotification = 
      permissionSetupModule?.getAutoModeUnavailableNotification(reason) ??
      'auto mode unavailable'
  }
}
```

이 논리는 다음을 보장합니다. **계획 모드 중에 자동 모드 회로 차단기가 작동하는 경우(예: 분류자가 연속 거부 제한을 초과한 경우) 종료 계획은 자동으로 복원되지 않고 대신 기본값으로 저하됩니다**. 사용자에게 알림이 표시됩니다.

> 계획 종료 → 기본 · 자동 모드 사용 불가

### <a href="#mid-session-settings-changes" class="header">세션 중간 설정 변경</a>

사용자가 계획 모드에서 `useAutoModeDuringPlan` 설정을 수정하면 `transitionPlanAutoMode`가 즉시 적용됩니다.

``` typescript
// restored-src/src/utils/permissions/permissionSetup.ts:1502-1517
export function transitionPlanAutoMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  if (context.mode !== 'plan') return context
  // Plan entered from bypassPermissions doesn't allow auto activation
  if (context.prePlanMode === 'bypassPermissions') return context
  
  const want = shouldPlanUseAutoMode()
  const have = autoModeStateModule?.isAutoModeActive() ?? false
  // Activate or deactivate auto based on want/have
}
```

------------------------------------------------------------------------

## <a href="#4b6-the-plan-agent-a-read-only-architect" class="header">4b.6 계획 에이전트: 읽기 전용 설계자</a>

계획 모드의 5단계 워크플로는 2단계에서 내장된 계획 에이전트를 사용합니다(에이전트 시스템은 20장 참조). 이 에이전트의 정의는 도구 제한을 통해 읽기 전용 동작이 어떻게 적용되는지 보여줍니다.

``` typescript
// restored-src/src/tools/AgentTool/built-in/planAgent.ts:73-92
export const PLAN_AGENT: BuiltInAgentDefinition = {
  agentType: 'Plan',
  disallowedTools: [
    AGENT_TOOL_NAME,      // cannot spawn sub-agents
    EXIT_PLAN_MODE_TOOL_NAME,  // cannot exit plan mode
    FILE_EDIT_TOOL_NAME,  // cannot edit files
    FILE_WRITE_TOOL_NAME, // cannot write files
    NOTEBOOK_EDIT_TOOL_NAME,
  ],
  tools: EXPLORE_AGENT.tools,
  omitClaudeMd: true,     // don't inject CLAUDE.md, saves tokens
  getSystemPrompt: () => getPlanV2SystemPrompt(),
}
```

계획 에이전트의 시스템 프롬프트는 읽기 전용 제약 조건을 더욱 강화합니다.

=== 중요: 읽기 전용 모드 - 파일 수정 없음 === 이것은 읽기 전용 계획 작업입니다. 다음은 엄격히 금지됩니다. - 새 파일 생성(쓰기, 터치 또는 모든 종류의 파일 생성 금지) - 기존 파일 수정(편집 작업 금지) - 리디렉션 연산자(>, >>, |) 또는 heredocs를 사용하여 파일에 쓰기 - 시스템 상태를 변경하는 모든 명령 실행

이중 제약 조건(도구 차단 목록 + 프롬프트 금지)은 모델이 도구 제한 사항을 "잊은" 경우에도 프롬프트가 쓰기 작업 시도를 방지하도록 보장합니다.

------------------------------------------------------------------------

## <a href="#pattern-extraction" class="header">패턴 추출</a>

계획 모드 구현에서 다음과 같은 재사용 가능한 AI 에이전트 디자인 패턴을 추출할 수 있습니다.

### <a href="#pattern-1-saverestore-permission-mode" class="header">패턴 1: 저장/복원 권한 모드</a>

**문제**: 일시적으로 제한 모드에 진입한 후 이전 상태를 정확하게 복원해야 합니다.

**해결책**: 권한 컨텍스트에 `prePlanMode` 필드를 추가합니다. 입력 시 저장하고 종료 시 복원합니다.

항목: context.prePlanMode = context.mode; context.mode = 'plan' 종료: context.mode = context.prePlanMode; context.prePlanMode = 정의되지 않음

**전제 조건**: 종료 시 외부 조건(회로 차단기 등)이 여전히 원래 모드로의 복원을 허용하는지 확인해야 합니다. 그렇지 않은 경우 안전한 기본값으로 저하합니다.

### <a href="#pattern-2-plan-file-as-alignment-vehicle"
class="header">패턴 2: 정렬 차량으로서의 계획 파일</a>

**문제**: 압축 중에 대화 컨텍스트의 계획이 손실됩니다. 사용자는 에이전트 외부에서 이를 보거나 편집할 수 없습니다.

**해결책**: 사람이 읽을 수 있는 이름 지정(워드 슬러그)을 사용하여 디스크 파일에 계획을 작성하여 외부 편집 및 세션 간 복구를 지원합니다.

**전제 조건**: 원격 세션에 대한 경로 통과 방어, 충돌 감지 및 스냅샷 지속성이 필요합니다.

### <a href="#pattern-3-fullsparse-throttling" class="header">패턴 3: 전체/희소 조절</a>

**문제**: 매 턴 전체 워크플로 지침을 주입하면 토큰이 낭비되지만 모델에 전혀 상기시키지 않으면 워크플로 드리프트가 발생합니다.

**해결책**: 처음 발생할 때 전체 지침을 삽입하고 이후에는 희소 알림을 사용하고 N번마다 전체 지침을 다시 삽입합니다. 상태 전환 시 카운터를 재설정합니다.

**전제 조건**: 사람의 회전으로 계산합니다(도구 호출 회전 아님). 그렇지 않으면 10번의 도구 호출이 반복 알림을 트리거합니다.

### <a href="#pattern-4-internalexternal-behavioral-calibration"
class="header">패턴 4: 내부/외부 행동 교정</a>

**문제**: 사용자 집단마다 상담사 자율성에 대한 기대치가 다릅니다. 외부 사용자에게는 더 많은 정렬 보호가 필요합니다. 내부 사용자에게는 더 많은 실행 효율성이 필요합니다.

**해결책**: `USER_TYPE`를 통해 프롬프트 변형을 차별화합니다. 외부 버전은 트리거 임계값을 낮춥니다("확실하지 않은 경우 계획"). 내부 버전에서는 이를 제기합니다("작업을 시작하고 구체적인 질문을 하십시오").

**전제 조건**: 다양한 임계값이 사용자 만족도 및 재작업 비율에 미치는 영향을 검증하려면 A/B 테스트 인프라가 필요합니다.

### <a href="#pattern-5-state-transition-debouncing" class="header">패턴 5: 상태 전환 디바운싱</a>

**문제**: 빠른 모드 전환(계획 → 일반 → 계획)으로 인해 중복되거나 모순되는 알림이 발생할 수 있습니다.

**해결책**: 단일 소비 플래그(`needsPlanModeExitAttachment`)를 사용합니다. 입장 시 보류 중인 종료 알림을 모두 지웁니다. 종료 시 새 알림을 설정하세요.

**전제 조건**: 플래그는 소비(첨부 파일 전송) 후 즉시 지워야 하며, 진입/퇴출 작업은 플래그에 대해 상호 배타적으로 작동해야 합니다.

------------------------------------------------------------------------

## <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

### <a href="#basic-usage" class="header">기본 사용법</a>

<div class="table-wrapper">

| 행동 | 어떻게 |
|----|----|
| 계획 모드 시작 | `/plan` 또는 `/plan <description>` 또는 모델이 자체적으로 `EnterPlanMode`를 호출하도록 허용 |
| 현재 계획 보기 | `/plan`를 다시 입력하세요. |
| 편집기에서 계획 편집 | `/plan open` |
| 계획 모드 종료 | 모델이 `ExitPlanMode`를 호출 → 사용자가 승인 대화상자에서 확인 |

</div>

### <a href="#configuration-options" class="header">구성 옵션</a>

<div class="table-wrapper">

| 환경 | 효과 |
|----|----|
| `settings.plansDirectory` | 사용자 정의 계획 파일 저장 디렉터리(프로젝트 루트 기준) |
| `CLAUDE_CODE_PLAN_V2_AGENT_COUNT` | 재정의 계획 상담원 수(1~10) |
| `CLAUDE_CODE_PLAN_V2_EXPLORE_AGENT_COUNT` | Explore 에이전트 수 재정의(1-10) |
| `CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE` | 인터뷰 워크플로 활성화(`true`/`false`) |

</div>

### <a href="#usage-recommendations" class="header">사용 권장 사항</a>

1. **대규모 리팩터링에는 계획 모드 선호**: 3개 이상의 파일을 변경하는 경우 `/plan refactor the auth system`로 시작하여 모델이 접근 방식을 생성하도록 한 다음 실행하기 전에 확인하세요.
2. **재계획보다는 계획 편집**: 계획이 대부분 맞지만 조정이 필요한 경우 `/plan open`를 사용하여 편집기에서 직접 편집하십시오. 모델을 재계획하는 것보다 더 효율적입니다.
3. **에이전트 시작 시 `mode: 'plan'` 지정**: 에이전트 도구의 `mode` 매개변수를 통해 하위 에이전트가 계획 모드에서 작동하도록 하여 대규모 작업이 실행 전에 승인을 거치도록 할 수 있습니다.

------------------------------------------------------------------------

## <a href="#version-evolution-note" class="header">버전 진화 참고</a>

> 이 장의 핵심 분석은 Claude Code v2.1.88을 기반으로 합니다. 계획 모드는 적극적으로 진화하는 하위 시스템입니다. 인터뷰 워크플로(`tengu_plan_mode_interview_phase`)와 계획 기간 실험(`tengu_pewter_ledger`)은 분석 당시에도 여전히 A/B 테스트를 진행 중이었습니다. Plan 모드의 원격 확장인 Ultraplan(원격 계획 모드)은 20c장에서 다룹니다.
