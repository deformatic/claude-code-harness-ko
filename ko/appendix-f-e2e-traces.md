# <a href="#appendix-f-end-to-end-case-traces" class="header">부록 F: 전체 사례 추적</a>

> 이 부록은 세 가지 완전한 요청 수명 주기 추적을 통해 모든 장의 분석을 연결합니다. 각 사례는 사용자 입력에서 시작하여 여러 하위 시스템을 통과하고 최종 출력으로 끝납니다. 이러한 사례를 읽을 때 각 단계의 내부 메커니즘에 대한 더 깊은 이해를 위해 인용된 장을 상호 참조하는 것이 좋습니다.

------------------------------------------------------------------------

## <a href="#case-1-the-complete-journey-of-a-commit" class="header">사례 1: <code>/commit</code>의 전체 여정</a>

> 연결된 장: 3장(에이전트 루프) -\> 5장(시스템 프롬프트) -\> 4장(도구 오케스트레이션) -\> 16장(권한 시스템) -\> 17장(YOLO 분류자) -\> 13장(캐시 적중)

### <a href="#scenario" class="header">대본</a>

사용자는 git 저장소에 `/commit`를 입력합니다. Claude Code는 작업 공간 상태 확인, 커밋 메시지 생성, git commit 실행을 수행해야 합니다. 전체적으로 화이트리스트에 있는 git 명령을 자동으로 승인합니다.

### <a href="#request-flow" class="header">요청 흐름</a>

``` mermaid
sequenceDiagram
    participant U as User
    participant QE as QueryEngine
    participant CMD as commit.ts
    participant API as Claude API
    participant BT as BashTool
    participant PM as Permission System
    participant YOLO as YOLO Classifier

    U->>QE: Type "/commit"
    QE->>CMD: Parse slash command
    CMD->>CMD: executeShellCommandsInPrompt()<br/>Execute git status / git diff
    CMD->>QE: Return prompt + allowedTools
    QE->>QE: Update alwaysAllowRules<br/>Inject whitelist
    QE->>API: Send message (system prompt + commit context)
    API-->>QE: Streaming response: tool_use [Bash: git add]
    QE->>PM: Permission check: Bash(git add:*)
    PM->>PM: Match alwaysAllowRules
    PM-->>QE: Auto-approved (command-level whitelist)
    QE->>BT: Execute git add
    BT-->>QE: Tool result
    QE->>API: Send tool result
    API-->>QE: tool_use [Bash: git commit -m "..."]
    QE->>PM: Permission check
    PM->>YOLO: Not in whitelist? Hand to classifier
    YOLO-->>PM: Safe (git commit is a write-only operation)
    PM-->>QE: Auto-approved
    QE->>BT: Execute git commit
    BT-->>QE: Commit successful
    QE->>API: Send final result
    API-->>U: "Created commit abc1234"
```

### <a href="#subsystem-interaction-details" class="header">하위 시스템 상호 작용 세부 정보</a>

**1단계: 명령 구문 분석(3장)**

사용자가 `/commit`를 입력하면 `QueryEngine.processUserInput()`는 슬래시 명령 접두어를 인식하고 명령 레지스트리(`restored-src/src/commands/commit.ts:6-82`)에서 `commit` 명령 정의를 조회합니다. 명령 정의에는 두 가지 주요 필드가 포함되어 있습니다.

- `allowedTools`: `['Bash(git add:*)', 'Bash(git status:*)', 'Bash(git commit:*)']` — 모델을 이 세 가지 유형의 git 명령으로만 제한합니다.
- `getPromptContent()`: API로 보내기 전에 `executeShellCommandsInPrompt()`를 통해 `git status` 및 `git diff HEAD`를 로컬에서 실행하여 실제 저장소 상태를 프롬프트에 포함시킵니다.

이는 모델이 모호한 "커밋을 도와주세요"라는 지시를 받는 것이 아니라 현재 차이점을 포함한 완전한 컨텍스트를 받는다는 것을 의미합니다.

**2단계: 권한 주입(16장)**

API를 호출하기 전에 `QueryEngine`는 `allowedTools`를 `AppState.toolPermissionContext.alwaysAllowRules.command`(`restored-src/src/QueryEngine.ts:477-486`)에 씁니다. 효과: 이 대화 차례 동안 `Bash(git add:*)` 패턴과 일치하는 모든 도구 호출은 사용자 확인 없이 자동으로 승인됩니다.

**3단계: API 호출 및 캐싱(5장, 13장)**

시스템 프롬프트는 API 호출(`restored-src/src/utils/api.ts:72-84`) 중에 `cache_control` 마커를 사용하여 여러 블록으로 분할됩니다. 사용자가 이전에 다른 명령을 실행한 경우 시스템 프롬프트의 접두사 부분(도구 정의, 기본 규칙)이 프롬프트 캐시에 적중할 수 있으며 `/commit`에 의해 삽입된 새 컨텍스트만 재처리되어야 합니다.

**4단계: 도구 실행 및 분류(4장, 17장)**

모델이 `tool_use` 블록을 반환한 후 권한 시스템은 우선순위에 따라 확인합니다.

1. 먼저 `alwaysAllowRules`를 확인하세요. `git add` 및 `git status`가 화이트리스트와 직접 일치합니다.
2. `git commit`의 경우 화이트리스트에 없으면 안전성 평가를 위해 YOLO 분류자(`restored-src/src/utils/permissions/yoloClassifier.ts:54-68`)에 전달하세요.
3. `BashTool`는 실제 명령을 실행하여 `bashPermissions.ts`를 통해 AST 수준 명령 구문 분석을 수행합니다.

**5단계: 기여도 계산**

커밋이 완료된 후 `commitAttribution.ts`(`restored-src/src/utils/commitAttribution.ts:548-743`)는 Claude의 문자 기여 비율을 계산하여 `Co-Authored-By` 서명을 커밋 메시지에 추가할지 여부를 결정합니다.

### <a href="#what-this-case-demonstrates" class="header">이 사례가 보여주는 것</a>

간단한 `/commit` 뒤에는 최소 6개의 하위 시스템이 협력합니다. 명령 시스템은 컨텍스트 주입을 제공하고, 권한 시스템은 화이트리스트 자동 승인을 제공하고, YOLO 분류자는 대체 평가를 제공하고, BashTool은 실제 명령을 실행하고, 프롬프트 캐싱은 중복 계산을 줄이고, 속성 모듈은 저작자를 처리합니다. 이것이 하네스 엔지니어링의 핵심입니다. 각 하위 시스템은 Agent Loop의 통합 주기를 통해 조정되어 해당 역할을 수행합니다.

------------------------------------------------------------------------

## <a href="#case-2-a-long-conversation-triggering-auto-compaction"
class="header">사례 2: 자동 압축을 유발하는 긴 대화</a>

> 연결된 장: 9장(자동 압축) -\> 10장(파일 상태 보존) -\> 11장(마이크로 압축) -\> 12장(토큰 예산) -\> 13장(캐시 아키텍처) -\> 26장(컨텍스트 관리 원칙)

### <a href="#scenario-1" class="header">대본</a>

사용자는 대규모 코드베이스에서 긴 리팩토링 대화를 나누고 있습니다. 약 40번의 상호 작용 후에 컨텍스트 창이 200K 토큰 제한에 접근하여 자동 압축을 트리거합니다.

### <a href="#token-consumption-timeline" class="header">토큰 소비 타임라인</a>

``` mermaid
graph LR
    subgraph "200K Context Window"
        direction TB
        A["Turns 1-10<br/>~40K tokens<br/>Safe zone"] --> B["Turns 11-25<br/>~100K tokens<br/>Normal growth"]
        B --> C["Turns 26-35<br/>~140K tokens<br/>Approaching warning line"]
        C --> D["Turns 36-38<br/>~160K tokens<br/>Warning: 15% remaining"]
        D --> E["Turn 39<br/>~170K tokens<br/>Threshold exceeded"]
        E --> F["Auto-compaction triggered<br/>~50K tokens<br/>Space recovered"]
    end

    style A fill:#3fb950,stroke:#30363d
    style B fill:#3fb950,stroke:#30363d
    style C fill:#d29922,stroke:#30363d
    style D fill:#f47067,stroke:#30363d
    style E fill:#f47067,stroke:#30363d,stroke-width:3px
    style F fill:#58a6ff,stroke:#30363d
```

### <a href="#key-thresholds" class="header">주요 임계값</a>

<div class="table-wrapper">

| 한계점 | 계산 | 대략. 값 | 목적 |
|----|----|----|----|
| 컨텍스트 창 | `MODEL_CONTEXT_WINDOW_DEFAULT` | 200,000 | 모델 최대 입력 |
| 유효 창 | 컨텍스트 창 - max_output_tokens | ~180,000 | 출력 공간 예약 |
| 압축 임계값 | 유효 창 - 13K 버퍼 | ~167,000 | 자동 압축 트리거 |
| 경고 임계값 | 유효 기간 - 20K | ~160,000 | 로그 경고 |
| 차단 임계값 | 유효 창 - 3K | ~177,000 | 강제 실행/압축 |

</div>

출처: `restored-src/src/services/compact/autoCompact.ts:28-91`, `restored-src/src/utils/context.ts:8-9`

### <a href="#compaction-execution-flow" class="header">압축 실행 흐름</a>

``` mermaid
sequenceDiagram
    participant QL as Query Loop
    participant TC as tokenCountWithEstimation()
    participant AC as autoCompactIfNeeded()
    participant CP as compactConversation()
    participant FS as FileStateCache
    participant CL as postCompactCleanup()
    participant PC as promptCacheBreakDetection

    QL->>TC: New message arrives, estimate token count
    TC->>TC: Read last API response usage<br/>+ estimate new messages (4 chars ~ 1 token)
    TC-->>QL: Return ~170K tokens
    QL->>AC: shouldAutoCompact() -> true
    AC->>AC: Check circuit breaker: consecutive failures < 3
    AC->>CP: compactConversation()
    CP->>CP: stripImagesFromMessages()<br/>Replace images/docs with placeholders
    CP->>CP: Build compaction prompt + history messages
    CP->>CP: Call Claude API to generate summary
    CP-->>AC: Return compacted messages (~50K tokens)
    AC->>FS: Serialize file state cache
    FS-->>AC: FileStateCache.cacheToObject()
    AC->>CL: runPostCompactCleanup()
    CL->>CL: Clear system prompt cache
    CL->>CL: Clear memory file cache
    CL->>CL: Clear classifier approval records
    CL->>PC: notifyCompaction()
    PC->>PC: Reset prevCacheReadTokens
    PC-->>QL: Cache tracking state reset
    QL->>QL: Next API call rebuilds full prompt
```

### <a href="#subsystem-interaction-details-1" class="header">하위 시스템 상호 작용 세부 정보</a>

**1단계: 토큰 계산(12장)**

각 API 호출 후 `tokenCountWithEstimation()`(`restored-src/src/utils/tokens.ts:226-261`)는 마지막 응답에서 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`를 읽은 다음 이후에 추가된 메시지에 대한 추정 값을 추가합니다(4자는 대략 1토큰과 동일). 이 기능은 모든 컨텍스트 관리 결정을 위한 데이터 기반입니다.

**2단계: 임계값 평가(9장)**

`shouldAutoCompact()`(`restored-src/src/services/compact/autoCompact.ts:225-226`)는 토큰 수를 압축 임계값(~167K)과 비교합니다. 임계값을 초과한 후에는 회로 차단기도 확인합니다. 압축이 3회 연속 실패하면 재시도를 중지합니다(260-265행). 이는 26장의 "회로 차단 런어웨이 루프" 원칙을 구체적으로 구현한 것입니다.

**3단계: 압축 실행(9장)**

`compactConversation()`(`restored-src/src/services/compact/compact.ts:122-200`)는 실제 압축을 수행합니다.

1. `[image]`/`[document]` 자리 표시자로 대체하여 이미지 및 문서 콘텐츠 제거
2. 압축 프롬프트를 작성하고 요약 생성을 위해 전체 메시지 기록을 Claude에게 보냅니다.
3. 압축된 메시지 배열을 반환합니다(약 400개 메시지에서 약 80개로 감소).

**4단계: 파일 상태 보존(10장)**

압축하기 전에 `FileStateCache`(`restored-src/src/utils/fileStateCache.ts:30-143`)는 캐시된 모든 파일 경로, 콘텐츠 및 타임스탬프를 직렬화합니다. 이 데이터는 압축 후 메시지에 첨부 파일로 삽입되어 압축 후 어떤 파일을 읽고 편집했는지 모델이 계속 "기억"하도록 합니다. 캐시는 100개의 항목과 25MB의 총 크기로 제한되는 LRU 전략을 사용합니다.

**5단계: 캐시 무효화(13장)**

압축이 완료된 후 `runPostCompactCleanup()`(`restored-src/src/services/compact/postCompactCleanup.ts:31-77`)는 포괄적인 정리를 수행합니다.

- 시스템 프롬프트 캐시(`getUserContext.cache.clear()`)를 지웁니다.
- 메모리 파일 캐시를 지웁니다.
- YOLO 분류자의 승인 기록을 지웁니다.
- 캐시 추적 모듈에 상태 재설정을 알립니다(`notifyCompaction()`).

이는 압축 후 첫 번째 API 호출이 전체 시스템 프롬프트를 다시 작성해야 함을 의미합니다. 즉, 프롬프트 캐시가 완전히 누락됩니다. 이것이 압축의 숨겨진 비용입니다. 즉, 컨텍스트 공간을 절약하지만 전체 캐시 재구축 비용을 지불하게 됩니다.

### <a href="#what-this-case-demonstrates-1" class="header">이 사례가 보여주는 것</a>

자동 압축은 분리된 기능이 아니라 토큰 계산, 임계값 평가, 요약 생성, 파일 상태 보존 및 캐시 무효화라는 5가지 하위 시스템의 공동 작업입니다. 이는 26장의 핵심 원칙을 구현합니다. **컨텍스트 관리는 추가 기능이 아니라 에이전트의 핵심 기능입니다**. 모든 단계에서는 "충분한 정보 보존"과 "충분한 공간 확보" 사이에서 정확한 균형을 이루고 있습니다.

------------------------------------------------------------------------

## <a href="#case-3-multi-agent-collaborative-execution"
class="header">사례 3: 다중 에이전트 공동 실행</a>

> 연결된 장: 20장(에이전트 생성) -\> 20b장(팀 예약 커널) -\> 5장(시스템 프롬프트 변형) -\> 25장(하네스 엔지니어링 원칙)

### <a href="#scenario-2" class="header">대본</a>

사용자는 Claude Code에게 여러 모듈을 병렬로 리팩터링하도록 요청합니다. 메인 에이전트는 팀을 생성하고 하위 에이전트에게 작업을 할당하며, 하위 에이전트는 TaskList를 통해 자동으로 작업을 요청하고 완료합니다.

### <a href="#agent-communication-sequence" class="header">에이전트 통신 순서</a>

``` mermaid
sequenceDiagram
    participant U as User
    participant L as Leader Agent
    participant TC as TeamCreateTool
    participant TL as TaskList (Shared State)
    participant W1 as Worker 1
    participant W2 as Worker 2
    participant MB as Mailbox

    U->>L: "Refactor auth and payment modules in parallel"
    L->>TC: TeamCreate(name: "refactor-team")
    TC->>TC: Create TeamFile + TaskList directory
    TC->>TL: Initialize task graph
    L->>TL: TaskCreate: "Refactor auth"<br/>TaskCreate: "Refactor payment"<br/>TaskCreate: "Integration tests" (blockedBy: auth, payment)
    
    par Worker Startup
        TC->>W1: spawn(teammate, prompt)
        TC->>W2: spawn(teammate, prompt)
    end
    
    W1->>TL: findAvailableTask()
    TL-->>W1: "Refactor auth" (pending, no blockers)
    W1->>TL: claimTask("auth", owner: W1)
    
    W2->>TL: findAvailableTask()
    TL-->>W2: "Refactor payment" (pending, no blockers)
    W2->>TL: claimTask("payment", owner: W2)
    
    par Parallel Execution
        W1->>W1: Execute auth refactoring
        W2->>W2: Execute payment refactoring
    end
    
    W1->>TL: TaskUpdate("auth", completed)
    Note over TL: TaskCompleted event
    W1->>TL: findAvailableTask()
    TL-->>W1: "Integration tests" still blocked by payment
    Note over W1: TeammateIdle event
    
    W2->>TL: TaskUpdate("payment", completed)
    Note over TL: payment completed -> "Integration tests" unblocked
    
    W1->>TL: findAvailableTask()
    TL-->>W1: "Integration tests" (pending, no blockers)
    W1->>TL: claimTask("integration-tests", owner: W1)
    W1->>W1: Execute integration tests
    W1->>TL: TaskUpdate("integration-tests", completed)
    
    W1->>MB: Notify Leader: all tasks complete
    MB-->>L: task-notification
    L-->>U: "Refactoring complete, 3/3 tasks passed"
```

### <a href="#subsystem-interaction-details-2" class="header">하위 시스템 상호 작용 세부 정보</a>

**1단계: 팀 생성(20장, 20b장)**

`TeamCreateTool`(`restored-src/src/tools/AgentTool/AgentTool.tsx`)는 두 가지 작업을 수행합니다. 즉, `TeamFile` 구성을 생성하고 해당 TaskList 디렉터리를 초기화합니다. 20b장에서 분석한 바와 같이: **Team = TaskList** — 팀과 작업 테이블은 동일한 런타임 개체에 대한 두 개의 보기입니다.

작업자의 물리적 백엔드는 `detectAndGetBackend()`(`restored-src/src/utils/swarm/backends/`)에 의해 결정됩니다.

<div class="table-wrapper">

| 백엔드 | 프로세스 모델 | 검출 조건 |
|------------|-----------------------------|-------------------------------|
| 티먹스 | 독립적인 CLI 프로세스 | 기본 백엔드(Linux/macOS) |
| iTerm2 | 독립적인 CLI 프로세스 | macOS + iTerm2 |
| 진행 중 | AsyncLocalStorage 격리 | tmux/iTerm2 없음 |

</div>

**2단계: 작업 그래프 구성(20b장)**

리더가 생성한 작업은 단순한 Todo 목록이 아니라 `blocks`/`blockedBy` 종속 관계(`restored-src/src/utils/tasks.ts`)가 있는 DAG입니다.

``` typescript
// restored-src/src/utils/tasks.ts
{
  id: "auth",
  status: "pending",
  blocks: ["integration-test"],
  blockedBy: [],
}
{
  id: "integration-test",
  status: "pending",
  blocks: [],
  blockedBy: ["auth", "payment"],
}
```

이 설계를 통해 리더는 모든 작업과 해당 종속성을 한 번에 선언할 수 있으며 "병렬로 실행될 수 있는 시기"는 런타임에 맡겨 결정합니다.

**3단계: 자동 소유권 주장(20b장)**

`useTaskListWatcher.ts`의 `findAvailableTask()`는 Swarm의 최소 스케줄러입니다.

1. `status === 'pending'` 및 비어 있는 `owner`를 사용하여 작업 필터링
2. `blockedBy`의 모든 작업이 완료되었는지 확인하세요.
3. `claimTask()`가 발견되면 원자적으로 소유권을 주장합니다.

이는 25장의 핵심 원칙 중 하나를 구현합니다. **추론과 별도의 스케줄링** — 모델은 자연 언어로 작업 종속성을 판단할 필요가 없습니다. 런타임은 이미 후보를 하나의 명확한 작업으로 좁혔습니다.

**4단계: 컨텍스트 격리(20장)**

각 In-Process 작업자는 `AsyncLocalStorage`(`restored-src/src/utils/teammateContext.ts:41-64`)를 통해 독립적인 컨텍스트를 유지합니다.

``` typescript
// restored-src/src/utils/teammateContext.ts:41
const teammateStorage = new AsyncLocalStorage<TeammateContext>();
```

`TeammateContext`에는 `agentId`, `agentName`, `teamName` 및 `parentSessionId`와 같은 필드가 포함됩니다. 이렇게 하면 동일한 프로세스 내의 여러 에이전트가 서로의 상태를 오염시키지 않습니다.

**5단계: 사건 표면(20b장)**

작업자가 작업을 완료하면 두 가지 유형의 이벤트가 트리거됩니다(`restored-src/src/query/stopHooks.ts`).

- `TaskCompleted`: 작업을 완료로 표시하여 잠재적으로 다른 작업을 차단 해제합니다.
- `TeammateIdle`: 작업자가 유휴 상태로 전환되고 TaskList로 돌아가 새 작업을 찾습니다.

이로 인해 Teams는 하이브리드 풀 + 푸시 모델이 됩니다. 유휴 작업자는 적극적으로 작업을 가져오고 작업 완료 이벤트는 리더에게 푸시합니다.

**6단계: 의사소통(20b장)**

직원들은 서로 직접적으로 대화하지 않습니다. 모든 협업은 두 가지 채널을 통해 진행됩니다.

- **TaskList**(공유 파일 시스템 상태): `~/.claude/tasks/{team-name}/`
- **사서함**(지속성 메시지 대기열): `~/.claude/teams/{team}/inboxes/*.json`

`task-notification` 메시지가 리더의 메시지 스트림에 삽입되면 프롬프트에서는 해당 메시지를 `<task-notification>` 태그(사용자 입력 아님)를 통해 구별하도록 명시적으로 요구합니다.

### <a href="#what-this-case-demonstrates-2" class="header">이 사례가 보여주는 것</a>

다중 에이전트 협업의 핵심은 "에이전트가 서로 채팅하도록 하는 것"이 ​​아니라 협업 커널을 형성하는 **공유 작업 그래프 + 원자 클레임 + 턴엔드 이벤트**입니다. Claude Code의 Swarm은 본질적으로 분산 스케줄러입니다. 리더는 작업 종속성을 선언하고 작업자는 자동으로 작업을 요청하며 런타임은 동시성 충돌을 관리합니다. 이는 25장의 원칙을 직접적으로 구현한 것입니다. "먼저 협력 상태를 외부화한 다음, 다양한 실행 단위가 이를 중심으로 협력하도록 합니다."
