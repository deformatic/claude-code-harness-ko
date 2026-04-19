# <a href="#chapter-20b-teams-and-multi-process-collaboration"
class="header">20b장: 팀과 다중 프로세스 협업</a>

> **포지셔닝**: 이 장에서는 평면 구조의 다중 에이전트 협업 모델인 Claude Code의 Swarm 팀 협업 메커니즘을 분석합니다. 전제 조건: 20장. 대상 독자: TaskList 스케줄링, DAG 종속성 및 메일박스 통신을 포함하여 CC의 Swarm 팀 협업 메커니즘에 대한 깊은 이해를 원하는 독자.

## <a href="#why-discuss-teams-separately" class="header">팀을 별도로 논의하는 이유</a>

20장에서는 Claude Code의 세 가지 에이전트 생성 모드인 하위 에이전트, 포크 및 코디네이터를 소개했습니다. 이 모드는 "부모 생성 자식" 계층 관계의 공통 특성을 공유합니다. 팀(팀원 시스템)은 다른 차원입니다. 에이전트가 계층적 호출이 아닌 메시지 전달을 통해 협업하는 **평면 구조의 팀**을 만듭니다. 이러한 차이는 아키텍처뿐만 아니라 통신 프로토콜의 엔지니어링 구현, 권한 동기화 및 수명주기 관리에서도 나타납니다.

------------------------------------------------------------------------

## <a href="#20b1-teammate-agents-agent-swarms" class="header">20b.1 팀원 에이전트(에이전트 스웜)</a>

팀원 시스템은 에이전트 조정의 또 다른 차원입니다. 하위 에이전트의 '상위 생성' 모델과 달리 팀원 시스템은 에이전트가 메시지 전달을 통해 협업하는 **평면 구조의 팀**을 만듭니다.

### <a href="#teamcreatetool-team-creation" class="header">TeamCreateTool: 팀 생성</a>

`TeamCreateTool`(`tools/TeamCreateTool/TeamCreateTool.ts`)는 새 팀을 만드는 데 사용됩니다.

``` typescript
// tools/TeamCreateTool/TeamCreateTool.ts:37-49
const inputSchema = lazySchema(() =>
  z.strictObject({
    team_name: z.string().describe('Name for the new team to create.'),
    description: z.string().optional(),
    agent_type: z.string().optional()
      .describe('Type/role of the team lead'),
  }),
)
```

팀 정보는 팀 이름, 구성원 목록, 리더 정보 등이 포함된 `TeamFile`에 유지됩니다. 팀 이름은 고유해야 합니다. 충돌이 발생하면 단어 슬러그(64-72행)가 자동 생성됩니다.

### <a href="#teammateagentcontext-teammate-context"
class="header">TeammateAgentContext: 팀원 컨텍스트</a>

팀원은 풍부한 팀 조정 정보가 포함된 `TeammateAgentContext` 유형(`agentContext.ts` 행 60-85)을 사용합니다.

``` typescript
// utils/agentContext.ts:60-85
export type TeammateAgentContext = {
  agentId: string          // Full ID, e.g., "researcher@my-team"
  agentName: string        // Display name, e.g., "researcher"
  teamName: string         // Team membership
  agentColor?: string      // UI color
  planModeRequired: boolean // Whether plan approval is needed
  parentSessionId: string  // Leader's session ID
  isTeamLead: boolean      // Whether this is the Leader
  agentType: 'teammate'
}
```

팀원 ID는 `name@team-name` 형식을 사용하므로 로그와 통신에서 한 눈에 에이전트의 신원과 소속을 쉽게 식별할 수 있습니다.

### <a href="#flat-structure-constraint" class="header">평면 구조 제약</a>

팀원 시스템에는 중요한 아키텍처 제약이 있습니다. **팀원은 다른 팀원을 생성할 수 없습니다**(272-274행):

``` typescript
// tools/AgentTool/AgentTool.tsx:272-274
if (isTeammate() && teamName && name) {
  throw new Error('Teammates cannot spawn other teammates — the team roster is flat.');
}
```

이는 의도적인 설계입니다. 팀 명단은 평면 배열이고 중첩된 팀원은 소스 정보 없이 명단에 항목을 생성하여 리더의 조정 논리를 혼란스럽게 합니다.

마찬가지로, 프로세스 중인 팀원은 수명 주기가 리더의 프로세스에 바인딩되어 있기 때문에 백그라운드 에이전트(278-280행)를 생성할 수 없습니다.

------------------------------------------------------------------------

## <a href="#20b2-inter-agent-communication" class="header">20b.2 에이전트 간 통신</a>

### <a href="#sendmessagetool-message-routing"
class="header">SendMessageTool: 메시지 라우팅</a>

`SendMessageTool`(`tools/SendMessageTool/SendMessageTool.ts`)는 Agent 간 통신의 핵심입니다. `to` 필드는 여러 주소 지정 모드를 지원합니다.

``` typescript
// tools/SendMessageTool/SendMessageTool.ts:69-76
to: z.string().describe(
  feature('UDS_INBOX')
    ? 'Recipient: teammate name, "*" for broadcast, "uds:<socket-path>" for a local peer, or "bridge:<session-id>" for a Remote Control peer'
    : 'Recipient: teammate name, or "*" for broadcast to all teammates',
),
```

메시지 유형은 구별된 공용체(47-65행)를 형성하며 다음을 지원합니다.

- 일반 문자 메시지
- 종료 요청(`shutdown_request`)
- 종료 응답(`shutdown_response`)
- 계획 승인 응답(`plan_approval_response`)

### <a href="#broadcast-mechanism" class="header">방송 메커니즘</a>

`to`가 `"*"`이면 브로드캐스트가 트리거됩니다(`handleBroadcast`, 191-266행). 팀 파일의 모든 구성원(발신자 제외)을 반복하고 각 사서함에 씁니다. 방송 결과에는 코디네이터 추적을 위한 수신자 목록이 포함됩니다.

### <a href="#mailbox-system" class="header">메일박스 시스템</a>

메시지는 `writeToMailbox()` 기능을 통해 파일 시스템 메일함에 물리적으로 기록됩니다. 각 메시지에는 보낸 사람 이름, 텍스트 내용, 요약, 타임스탬프 및 보낸 사람 색상이 포함됩니다. 이 파일 시스템 기반 메일박스 설계를 통해 프로세스 간 팀원(tmux 모드)이 공유 파일 시스템을 통해 통신할 수 있습니다.

### <a href="#uds_inbox-unix-domain-socket-extension"
class="header">UDS_INBOX: Unix 도메인 소켓 확장</a>

`UDS_INBOX` 기능 플래그가 활성화되면 `SendMessageTool`의 주소 지정 기능이 Unix 도메인 소켓으로 확장됩니다. `"uds:<socket-path>"`는 동일한 시스템의 다른 Claude Code 인스턴스에 메시지를 보낼 수 있고 `"bridge:<session-id>"`는 원격 제어 피어에 메시지를 보낼 수 있습니다.

이는 단일 팀 경계를 초월하는 커뮤니케이션 토폴로지를 만듭니다.

┌─────────────────────────────────────────────────────────────┐ │ 에이전트 간 통신 아키텍처 │ │ │ │ ┌─────────────────────────────────┐ │ │ │ 팀 "내 팀" │ │ │ │ │ │ │ ┌─────────┐ 메일박스 ┌─────────┐ │ │ │ │ 리더 │craze─────────────►│팀원 │ │ │ │ │ (리드) │ (파일 시스템) │ │ │ │ └────┬────┘ └─────────┘ │ │ │ │ │ │ │메시지 보내기(대상: "테스터") │ │ │ │ │ │ │ ▼ │ │ │ ┌─────────┐ │ │ │ 팀원 │ │ │ │ │ (테스터)│ │ │ │ └─────────┘ │ │ │ └─────────────────────────────────┘ │ │ │ │ │ SendMessage(to: "uds:/tmp/other.sock") │ │ ▼ │ │ ┌─────────────┐ │ │ │ 기타 Claude │ SendMessage(to: "bridge:<session>") │ │ │ 코드 인스턴스│──────────────────────────► 원격 제어 │ │ └─────────────┘ │ └─────────────────────────────────────────────────────────────┘

### <a href="#worker-result-reporting-in-coordinator-mode"
class="header">코디네이터 모드에서 작업자 결과 보고</a>

코디네이터 모드에서는 작업자가 작업을 완료하면 결과가 `<task-notification>` XML 형식(`coordinatorMode.ts` 행 148-159)의 **사용자 역할 메시지**로 코디네이터의 대화에 삽입됩니다.

``` xml
<task-notification>
  <task-id>{agentId}</task-id>
  <status>completed|failed|killed</status>
  <summary>{human-readable status summary}</summary>
  <result>{Agent's final text response}</result>
  <usage>
    <total_tokens>N</total_tokens>
    <tool_uses>N</tool_uses>
    <duration_ms>N</duration_ms>
  </usage>
</task-notification>
```

코디네이터 프롬프트에는 명시적으로 다음이 필요합니다(라인 144). "사용자 메시지처럼 보이지만 그렇지 않습니다. `<task-notification>` 여는 태그로 구별하세요." 이 디자인은 코디네이터가 마치 사용자 입력인 것처럼 작업자 결과에 응답하는 것을 방지합니다.

------------------------------------------------------------------------

## <a
href="#20b3-the-real-scheduling-kernel-tasklist-claim-loop-and-idle-hooks"
class="header">20b.3 실제 스케줄링 커널: TaskList, Claim Loop, Idle Hooks</a>

`TeamCreateTool`, `SendMessageTool`, Mailbox만 보면 Teams를 "서로 메시지를 보낼 수 있는 에이전트 그룹"으로 이해하기 쉽습니다. 하지만 Claude Code의 Swarm의 진정한 가치는 채팅이 아닌 **공유 작업 그래프**에 있습니다. `TeamCreate`의 프롬프트에는 `Teams have a 1:1 correspondence with task lists (Team = TaskList)`가 직접적으로 명시되어 있습니다. 팀을 생성할 때 `TeamCreateTool`는 `TeamFile`를 작성할 뿐만 아니라 해당 작업 디렉터리를 재설정하고 생성한 다음 리더의 `taskListId`를 팀 이름에 바인딩합니다. 즉, Teams는 결코 "팀 우선, 보조 작업"으로 설계되지 않았으며 오히려 **팀과 작업 목록은 동일한 런타임 개체에 대한 두 가지 보기**입니다.

### <a href="#tasks-are-not-todos-they-are-dag-nodes" class="header">작업은 할 일이 아니라 DAG 노드입니다.</a>

`utils/tasks.ts`의 `Task` 구조에는 다음이 포함됩니다.

``` typescript
{
  id: string,
  owner?: string,
  status: 'pending' | 'in_progress' | 'completed',
  blocks: string[],
  blockedBy: string[],
}
```

여기서 가장 중요한 필드는 `status`가 아니라 `blocks` 및 `blockedBy`입니다. 작업 목록을 일반 할일 목록에서 **명시적 종속성 그래프**로 승격시킵니다. 작업은 모든 차단기가 완료된 후에만 실행 가능합니다. 이 설계를 통해 리더는 종속성이 있는 전체 작업 항목 배치를 미리 만든 다음 프롬프트에서 반복적으로 구두로 조정하는 대신 런타임에 "병렬화할 시기"를 전달할 수 있습니다.

이것이 `TeamCreate`의 메시지가 다음과 같이 강조하는 이유이기도 합니다. "팀원은 정기적으로, 특히 각 작업을 완료한 후에 TaskList를 확인하여 사용 가능한 작업을 찾거나 새로 차단되지 않은 작업을 확인해야 합니다." Claude Code는 각 팀원에게 완전한 글로벌 계획 추론 능력을 요구하지 않습니다. 팀원은 **공유 작업 그래프로 돌아가서 상태를 읽어야 합니다**.

### <a href="#auto-claim-the-swarms-minimal-scheduler"
class="header">자동 소유권 주장: The Swarm의 최소 스케줄러</a>

실제로 이 작업 그래프를 구동하는 것은 `useTaskListWatcher.ts`입니다. 이 감시자는 작업 디렉터리가 변경되거나 에이전트가 다시 유휴 상태가 될 때마다 확인을 트리거하여 자동으로 사용 가능한 작업을 선택합니다.

- `status === 'pending'`
- `owner`가 비어 있습니다.
- `blockedBy`의 모든 작업이 완료되었습니다.

소스 코드의 `findAvailableTask()`는 정확히 이러한 조건을 기준으로 필터링합니다. 작업을 찾은 후 런타임은 먼저 `claimTask()`를 사용하여 소유권을 확보한 다음 에이전트 실행을 위한 프롬프트로 작업 형식을 지정합니다. 제출이 실패하면 청구가 취소됩니다. 두 가지 중요한 엔지니어링 의미:

1. **스케줄링과 추론은 분리됩니다.** 모델은 "어떤 작업이 다른 사람에 의해 수행되지 않고 종속성이 해결되었는지" 자연어로 결정할 필요가 없습니다. 런타임은 먼저 후보를 단일 명시적 작업으로 좁힙니다.
2. **병렬화는 메시지 협상이 아닌 공유 상태에서 발생합니다.** 여러 에이전트가 서로 협력할 만큼 똑똑해서가 아니라 클레임 + 차단 검사가 충돌을 상태 머신에 명시적으로 인코딩하기 때문에 동시에 진행할 수 있습니다.

이러한 관점에서 Claude Code의 Swarm에는 이미 작지만 완전한 스케줄러(**작업 그래프 + 원자 클레임 + 상태 전환**)가 있습니다. 사서함은 기본 일정 관리 표면이 아닌 공동 작업 보완 기능일 뿐입니다.

### <a href="#post-turn-event-surface-taskcompleted-and-teammateidle"
class="header">턴 후 이벤트 표면: TaskCompleted 및 TeammateIdle</a>

Another key aspect of the Swarm is that when a teammate finishes a turn of execution, it doesn't simply "stop" -- it enters an event-driven wrap-up phase. `query/stopHooks.ts`에서 현재 실행자가 팀원인 경우 Claude Code는 일반 중지 후크 후에 두 가지 유형의 특수 이벤트를 실행합니다.

- `TaskCompleted`: 현재 팀원이 소유한 `in_progress` 작업에 대한 완료 후크를 실행합니다.
- `TeammateIdle`: 팀원이 유휴 상태에 들어갈 때 후크를 실행합니다.

이로 인해 Teams는 순수한 풀 기반도 아니고 순수한 푸시 기반도 아닌 다음 두 가지의 조합이 됩니다.

- **풀**: 유휴 팀원이 TaskList로 돌아가서 계속해서 새 작업을 요청합니다.
- **푸시**: 작업 완료 및 팀원 유휴 트리거 이벤트, 리더에게 알리거나 후속 자동화 추진

즉, Claude Code의 Swarm은 "메시지를 보내는 에이전트 그룹"이 아니라 **공유 작업 그래프 + 내구성 있는 메일함 + 포스트턴 이벤트**로 구성된 협업 커널입니다.

### <a href="#this-is-not-shared-memory-but-shared-state"
class="header">이것은 공유 메모리가 아니라 공유 상태입니다.</a>

여기의 표현은 매우 정확해야 합니다. 팀은 "작업 공간을 공유하는 여러 에이전트"처럼 보일 수 있지만 소스 코드에 따르면 더 정확한 설명은 "공유 메모리"가 아니라 공유 상태의 세 가지 계층입니다.

- **공유 작업 상태**: `~/.claude/tasks/{team-name}/`
- **공유 통신 상태**: `~/.claude/teams/{team}/inboxes/*.json`
- **공유 팀 구성**: `~/.claude/teams/{team}/config.json`

In-Process 팀원은 실제로 동일한 프로세스에서 실행되고 `AsyncLocalStorage`를 통해 자신의 ID 컨텍스트를 보존합니다. 이는 전체 시스템을 범용 칠판 공유 메모리 런타임으로 승격시키지 않습니다. 이러한 구별은 Claude Code의 Swarm의 진정한 이식성 패턴을 결정하기 때문에 중요합니다. **먼저 협업 상태를 외부화한 다음 다양한 실행 단위가 이를 중심으로 협업하도록 합니다**.

------------------------------------------------------------------------

## <a href="#20b4-async-agent-lifecycle" class="header">20b.4 비동기 에이전트 수명주기</a>

`shouldRunAsync`가 `true`인 경우(`run_in_background`, `background: true`, 코디네이터 모드, 포크 모드, 보조 모드 등, 567행 중 하나에 의해 트리거됨) 에이전트는 비동기 수명 주기에 들어갑니다.

1. **등록**: `registerAsyncAgent()`는 백그라운드 작업 레코드를 생성하고 `agentId`를 할당합니다.
2. **실행**: `runWithAgentContext()`에 래핑된 `runAgent()`를 실행합니다.
3. **진행 상황 보고**: `updateAsyncAgentProgress()` 및 `onProgress` 콜백을 통해 상태 업데이트
4. **완료/실패**: `completeAsyncAgent()` 또는 `failAsyncAgent()`를 호출합니다.
5. **알림**: `enqueueAgentNotification()`는 발신자의 메시지 스트림에 결과를 삽입합니다.

A key design choice: background Agents are not associated with the parent Agent's `abortController` (line 694-696 comment) -- when the user presses ESC to cancel the main thread, background Agents continue running. `chat:killAgents`를 통해서만 명시적으로 종료할 수 있습니다.

### <a href="#worktree-isolation" class="header">작업 트리 격리</a>

`isolation: 'worktree'`인 경우 에이전트는 임시 git 작업 트리(590-593행)에서 실행됩니다.

``` typescript
const slug = `agent-${earlyAgentId.slice(0, 8)}`;
worktreeInfo = await createAgentWorktree(slug);
```

에이전트가 완료된 후 작업 트리에 변경 사항이 없으면(생성 시 HEAD 커밋과 비교하여) 자동으로 정리됩니다(666-679행). 변경 사항이 있는 작업 트리는 유지되며 해당 경로와 분기 이름이 호출자에게 반환됩니다.

------------------------------------------------------------------------

## <a
href="#20b5-teams-implementation-details-backends-communication-permissions-and-memory"
class="header">20b.5 Teams 구현 세부 사항: 백엔드, 통신, 권한 및 메모리</a>

> 이 섹션은 20b.1(팀원 개요)의 구현 수준 심층 분석입니다. 섹션 20b.1에서는 "팀이란 무엇인가"에 대해 답변합니다. 즉, 평면 구조의 팀, TeamCreateTool, TeammateAgentContext 유형입니다. this section answers "how do Teams actually run" -- process management, communication protocols, permission synchronization, and shared memory engineering implementations.  In the source code, "Swarm" and "Team" are synonyms: the directory is `utils/swarm/`, the tool is `TeamCreateTool`, the Feature Flag is `ENABLE_AGENT_SWARMS`, and the constant is `SWARM_SESSION_NAME = 'claude-swarm'`.

### <a href="#three-backends-one-interface" class="header">세 개의 백엔드, 하나의 인터페이스</a>

Teams는 `PaneBackend` + `TeammateExecutor` 인터페이스(`utils/swarm/backends/types.ts`) 뒤에 통합된 세 가지 물리적 백엔드를 지원합니다.

<div class="table-wrapper">

| 백엔드 | 프로세스 모델 | 의사소통 | 사용 사례 |
|----|----|----|----|
| **티먹스** | 독립적인 CLI 프로세스, tmux 분할 창 | 파일 시스템 메일박스 | Linux/macOS용 기본 백엔드 |
| **iTerm2** | 독립적인 CLI 프로세스, iTerm2 분할 창 | 파일 시스템 메일박스 | macOS 기본 터미널 사용자 |
| **진행 중** | 동일 프로세스 `AsyncLocalStorage` 격리 | AppState 메모리 큐 | tmux/iTerm2 환경 없음 |

</div>

백엔드 감지 우선순위 체인(`backends/registry.ts`):

    1. tmux 내부에서 실행 중이신가요?           → Tmux (네이티브)
    2. iTerm2 내부에서 it2를 사용할 수 있나요? → iTerm2(네이티브)
    3. iTerm2 내부에 있지만 it2는 없나요?      → 설치하라는 메시지2
    4. 시스템에 tmux가 있나요?               → Tmux(외부 세션)
    5. 위에 해당사항이 없나요?             → 진행 중 폴백

이 전략 패턴의 이점: 리더의 `TeamCreateTool` 및 `SendMessageTool`는 어떤 백엔드 팀원이 실행되는지 알 필요가 없습니다. `spawnTeammate()`는 자동으로 최상의 옵션을 선택합니다.

### <a href="#team-lifecycle" class="header">팀 수명주기</a>

``` typescript
// utils/swarm/teamHelpers.ts — TeamFile structure
{
  name: string,                    // Unique team name
  description?: string,
  createdAt: number,
  leadAgentId: string,             // Format: team-lead@{teamName}
  members: [{
    agentId: string,               // Format: {name}@{teamName}
    name: string,
    agentType?: string,
    model?: string,
    prompt: string,
    color: string,                 // Auto-assigned terminal color
    planModeRequired: boolean,
    tmuxPaneId?: string,
    sessionId?: string,
    backendType: BackendType,
    isActive: boolean,
    mode: PermissionMode,
  }]
}
```

저장 위치: `~/.claude/teams/{teamName}/config.json`

**팀원 생성 흐름**(`spawnMultiAgent.ts:305-539`):

1. 백엔드 감지 -\> 고유 이름 생성 -\> 에이전트 ID 형식(`{name}@{teamName}`)
2. 터미널 색상 지정 -\> tmux/iTerm2 분할 창 생성
3. 상속된 CLI 인수 빌드: `--agent-id`, `--agent-name`, `--team-name`, `--agent-color`, `--parent-session-id`, `--permission-mode`
4. 상속된 환경 변수 빌드 -\> 분할 창에 시작 명령 보내기
5. TeamFile 업데이트 -\> 사서함을 통해 초기 지침 보내기
6. Out of Process 작업 추적 등록

**평평한 구조 제약**: 팀원은 하위 팀원을 생성할 수 없습니다(`AgentTool.tsx:266-300`). 이는 기술적 제한이 아니라 의도적인 조직 원칙입니다. 조정은 무한히 깊은 위임 체인을 피하면서 리더에 중앙 집중화됩니다.

### <a href="#mailbox-communication-protocol" class="header">메일박스 통신 프로토콜</a>

팀원은 파일 시스템 사서함(`teammateMailbox.ts`)을 통해 비동기식으로 통신합니다.

~/.claude/teams/{teamName}/inboxes/{agentName}.json

**동시성 제어**: 비동기 잠금 파일 + 지수 백오프(10회 재시도, 5~100ms 지연 기간)

**메시지 구조**:

``` typescript
type TeammateMessage = {
  from: string,      // Sender name
  text: string,      // Message content or JSON control message
  timestamp: string,
  read: boolean,      // Read marker
  color?: string,     // Sender's terminal color
  summary?: string,   // 5-10 word summary
}
```

**제어 메시지 유형**(`text` 필드에 중첩된 구조화된 JSON):

<div class="table-wrapper">

| 유형 | 방향 | 목적 |
|----|----|----|
| `idle` 알림 | 팀원 -\> 리더 | 팀원이 작업을 완료하고 사유를 보고합니다(사용 가능/오류/종료/완료) |
| `shutdown_request` | 리더 -\> 팀원 | 정상 종료 요청 |
| `shutdown_response` | 팀원 -\> 리더 | 종료 요청 승인 또는 거부 |
| `plan_approval_response` | 리더 -\> 팀원 | 팀원이 제출한 계획을 승인하거나 거부합니다. |

</div>

**유휴 알림 구조**(`teammateMailbox.ts`):

``` typescript
type IdleNotificationMessage = {
  type: 'idle',
  teamName: string,
  agentName: string,
  agentId: string,
  idleReason: 'available' | 'error' | 'shutdown' | 'completed',
  summary?: string,           // Work summary
  peerDmSummary?: string,     // Recent DM summary
  errorDetails?: string,
}
```

### <a href="#permission-synchronization-leader-proxy-approval"
class="header">권한 동기화: 리더 프록시 승인</a>

팀원은 위험한 도구 호출을 자체 승인할 수 없습니다. 리더 프록시(`utils/swarm/permissionSync.ts`)를 거쳐야 합니다.

~/.claude/teams/{teamName}/permissions/ ├── 보류 중/ # 승인 대기 중인 요청 └── 해결됨/ # 처리된 요청

**요청 흐름**:

작업자가 권한 확인 ↓ SwarmPermissionRequest 생성(toolName, 입력, 제안 포함) ↓ 보류 중인/{requestId}.json에 쓰기 + 리더 메일박스로 전송 ↓ 리더가 메일박스 폴링 → 권한 요청 감지 → 사용자에게 제공 ↓ 리더 터미널에서 사용자 승인/거부 ↓ 해결됨/{requestId}.json에 쓰기 ↓ 작업자 폴링 해결됨/ → 결과 가져오기 → 실행 계속

이 설계는 팀원이 독립적인 프로세스에서 실행되는 경우에도 모든 위험한 작업이 여전히 사람의 승인을 거치도록 보장합니다.

### <a href="#team-memory" class="header">팀 메모리</a>

기능 게이트 `TENGU_HERRING_CLOCK`가 이를 제어합니다. 위치:

~/.claude/projects/{프로젝트}/memory/team/MEMORY.md

개인 메모리(`~/.claude/projects/{project}/memory/`)와는 독립적이며 모든 팀원이 공유합니다. 개인 메모리와 동일한 2단계 쓰기 흐름을 사용합니다. 먼저 `.md` 파일을 쓴 다음 `MEMORY.md` 인덱스를 업데이트합니다.

**경로 보안 검증**(`memdir/teamMemPaths.ts`, PSR M22186 보안 패치):

<div class="table-wrapper">

| 공격 유형 | 보호 |
|----|----|
| 널 바이트 주입 | `\0`가 포함된 경로 거부 |
| URL 인코딩 순회 | `%2e%2e%2f` 및 유사한 패턴 거부 |
| 유니코드 정규화 공격 | 전폭 `．．／` 및 유사한 변형 거부 |
| 백슬래시 순회 | `\`가 포함된 경로 거부 |
| 심볼릭 링크 루프 | ELOOP + 매달린 링크 감지 |
| 경로 탈출 | 가장 깊은 기존 조상의 포함을 확인하기 위해 realpath를 해결합니다. |

</div>

### <a href="#in-process-teammates-team-collaboration-without-tmux"
class="header">진행 중인 팀원: tmux 없이 팀 협업</a>

환경에 tmux/iTerm2가 없으면 팀원은 `AsyncLocalStorage`(`utils/swarm/spawnInProcess.ts`)로 격리된 동일한 프로세스 내에서 실행됩니다.

``` typescript
// AsyncLocalStorage context isolation
type TeammateContext = {
  agentId: string,
  agentName: string,
  teamName: string,
  parentSessionId: string,
  isInProcess: true,
  abortController: AbortController,  // Independent cancellation control
}

runWithTeammateContext<T>(context, fn: () => T): T  // Isolated execution
```

진행 중인 팀원 작업 상태(`InProcessTeammateTaskState`)에는 다음이 포함됩니다.

- `pendingUserMessages: string[]` -- 메시지 대기열(파일 시스템 메일박스 대체)
- `awaitingPlanApproval: boolean` -- 계획 모드에서 리더 승인을 기다리는 중
- `isIdle: boolean` -- 유휴 상태
- `onIdleCallbacks: Array<() => void>` -- 유휴 상태에서의 콜백(리더에게 알림)
- `messages: Message[]` -- UI 디스플레이 버퍼(캡 `TEAMMATE_MESSAGES_UI_CAP = 50`)

tmux 팀원과의 주요 차이점: 통신은 파일 시스템 메일박스가 아닌 메모리 대기열을 통해 이루어지지만 API는 완전히 일관됩니다.

### <a
href="#pattern-distillation-filesystem-based-inter-process-collaboration"
class="header">패턴 증류: 파일 시스템 기반 프로세스 간 협업</a>

Teams의 통신 설계는 직관에 어긋나지만 실용적인 선택을 합니다. 즉, **프로세스 간 통신을 위해 IPC/RPC 대신 파일 시스템을 사용**합니다.

<div class="table-wrapper">

| 차원 | 파일 시스템 메일박스 | 기존 IPC/RPC |
|----|----|----|
| 고집 | 메시지는 프로세스 충돌 후에도 유지됩니다. | 연결이 끊어지면 손실됨 |
| 디버깅 가능성 | `cat`를 직접 검사해 보세요. | 전용 디버그 도구 필요 |
| 동시성 제어 | 잠금 파일 | 프로토콜에 내장 |
| 숨어 있음 | 폴링 간격(밀리초 단위) | 즉각적인 |
| 교차 기계 | 공유 파일 시스템이 필요합니다 | 기본적으로 지원됨 |

</div>

Agent Teams 시나리오(2차 상호 작용, 프로세스 충돌 가능성, 사람의 디버깅 필요)의 경우 파일 시스템 메일박스 절충이 합리적입니다. UDS는 지연 시간이 짧은 시나리오를 다루는 보완 솔루션 역할을 합니다.

------------------------------------------------------------------------

## <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

**Teams 시스템을 활용하여 다중 에이전트 공동 작업 효율성을 향상합니다.**

1. **에이전트 간 통신을 위한 주소 지정 모드에 유의하십시오.** `SendMessageTool`는 이름 주소 지정(`"tester"`), 브로드캐스트(`"*"`) 및 UDS 주소 지정(`"uds:<path>"`)을 지원합니다. 이러한 주소 지정 모드를 이해하면 보다 효율적인 다중 에이전트 워크플로를 설계하는 데 도움이 됩니다.

2. **팀의 백엔드 선택을 이해합니다.** tmux 또는 iTerm2를 사용하는 경우 팀원은 파일 시스템 메일박스를 통해 통신하는 독립적인 터미널 분할 창으로 실행됩니다. 터미널 멀티플렉서가 없으면 in-process 모드로 돌아갑니다. 이를 알면 팀원 간 의사소통 문제를 디버깅하는 데 도움이 됩니다.

3. **유휴 감지를 사용하여 팀원 상태를 측정합니다.** 리더는 메일함에서 유휴 알림을 폴링하여 팀원 상태를 감지합니다. 팀원이 "멈춘" 것처럼 보이는 경우 `~/.claude/teams/{teamName}/inboxes/`에서 메일함 파일을 확인하면 문제를 찾는 데 도움이 될 수 있습니다.

4. **권한 승인은 리더에게 집중됩니다.** 모든 팀원의 위험한 작업은 리더 터미널을 통한 승인이 필요합니다. 리더 터미널이 활성 상태인지 확인하세요. 그렇지 않으면 팀원이 승인 대기를 차단하게 됩니다.
