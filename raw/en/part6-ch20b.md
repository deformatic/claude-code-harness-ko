# <a href="#chapter-20b-teams-and-multi-process-collaboration"
class="header">Chapter 20b: Teams and Multi-Process Collaboration</a>

> **Positioning**: This chapter analyzes Claude Code's Swarm team
> collaboration mechanism -- a flat-structured multi-Agent collaboration
> model. Prerequisites: Chapter 20. Target audience: readers who want a
> deep understanding of CC's Swarm team collaboration mechanism --
> including TaskList scheduling, DAG dependencies, and Mailbox
> communication.

## <a href="#why-discuss-teams-separately" class="header">Why Discuss Teams
Separately</a>

Chapter 20 introduced Claude Code's three Agent spawning modes --
Subagent, Fork, and Coordinator -- which share the common characteristic
of a "parent spawns child" hierarchical relationship. Teams (the
teammate system) is a different dimension: it creates a
**flat-structured team** where Agents collaborate through message
passing rather than hierarchical calls. This difference manifests not
only in architecture but also in engineering implementations of
communication protocols, permission synchronization, and lifecycle
management.

------------------------------------------------------------------------

## <a href="#20b1-teammate-agents-agent-swarms" class="header">20b.1
Teammate Agents (Agent Swarms)</a>

The teammate system is another dimension of Agent orchestration. Unlike
the "parent spawns child" model of subagents, the teammate system
creates a **flat-structured team** where Agents collaborate through
message passing.

### <a href="#teamcreatetool-team-creation" class="header">TeamCreateTool:
Team Creation</a>

`TeamCreateTool` (`tools/TeamCreateTool/TeamCreateTool.ts`) is used to
create new teams:

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

Team information is persisted to a `TeamFile` containing the team name,
member list, Leader info, etc. Team names must be unique -- conflicts
trigger automatic generation of a word slug (lines 64-72).

### <a href="#teammateagentcontext-teammate-context"
class="header">TeammateAgentContext: Teammate Context</a>

Teammates use the `TeammateAgentContext` type (`agentContext.ts` lines
60-85), containing rich team coordination information:

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

Teammate IDs use the format `name@team-name`, making it easy to identify
an Agent's identity and affiliation at a glance in logs and
communications.

### <a href="#flat-structure-constraint" class="header">Flat Structure
Constraint</a>

The teammate system has an important architectural constraint:
**teammates cannot spawn other teammates** (lines 272-274):

``` typescript
// tools/AgentTool/AgentTool.tsx:272-274
if (isTeammate() && teamName && name) {
  throw new Error('Teammates cannot spawn other teammates — the team roster is flat.');
}
```

This is a deliberate design -- the team roster is a flat array, and
nested teammates would create entries in the roster without source
information, confusing the Leader's coordination logic.

Similarly, in-process teammates cannot spawn background Agents (lines
278-280) because their lifecycle is bound to the Leader's process.

------------------------------------------------------------------------

## <a href="#20b2-inter-agent-communication" class="header">20b.2
Inter-Agent Communication</a>

### <a href="#sendmessagetool-message-routing"
class="header">SendMessageTool: Message Routing</a>

`SendMessageTool` (`tools/SendMessageTool/SendMessageTool.ts`) is the
core of inter-Agent communication. Its `to` field supports multiple
addressing modes:

``` typescript
// tools/SendMessageTool/SendMessageTool.ts:69-76
to: z.string().describe(
  feature('UDS_INBOX')
    ? 'Recipient: teammate name, "*" for broadcast, "uds:<socket-path>" for a local peer, or "bridge:<session-id>" for a Remote Control peer'
    : 'Recipient: teammate name, or "*" for broadcast to all teammates',
),
```

Message types form a discriminated union (lines 47-65), supporting:

- Plain text messages
- Shutdown requests (`shutdown_request`)
- Shutdown responses (`shutdown_response`)
- Plan approval responses (`plan_approval_response`)

### <a href="#broadcast-mechanism" class="header">Broadcast Mechanism</a>

When `to` is `"*"`, a broadcast is triggered (`handleBroadcast`, lines
191-266): iterating through all members in the team file (excluding the
sender), writing to each mailbox. Broadcast results include the
recipient list for coordinator tracking.

### <a href="#mailbox-system" class="header">Mailbox System</a>

Messages are physically written to filesystem mailboxes via the
`writeToMailbox()` function. Each message contains: sender name, text
content, summary, timestamp, and sender color. This filesystem-based
mailbox design allows cross-process teammates (tmux mode) to communicate
through a shared filesystem.

### <a href="#uds_inbox-unix-domain-socket-extension"
class="header">UDS_INBOX: Unix Domain Socket Extension</a>

When the `UDS_INBOX` Feature Flag is enabled, `SendMessageTool`'s
addressing capability extends to Unix Domain Sockets:
`"uds:<socket-path>"` can send messages to other Claude Code instances
on the same machine, and `"bridge:<session-id>"` can send messages to
Remote Control peers.

This creates a communication topology that transcends single-team
boundaries:

    ┌─────────────────────────────────────────────────────────────────┐
    │                 Inter-Agent Communication Architecture           │
    │                                                                 │
    │  ┌──────────────────────────────────┐                          │
    │  │        Team "my-team"            │                          │
    │  │                                  │                          │
    │  │  ┌─────────┐    MailBox    ┌─────────┐                     │
    │  │  │ Leader  │◄────────────►│Teammate │                     │
    │  │  │ (lead)  │  (filesystem) │  (dev)  │                     │
    │  │  └────┬────┘              └─────────┘                     │
    │  │       │                                                    │
    │  │       │ SendMessage(to: "tester")                         │
    │  │       │                                                    │
    │  │       ▼                                                    │
    │  │  ┌─────────┐                                              │
    │  │  │Teammate │                                              │
    │  │  │ (tester)│                                              │
    │  │  └─────────┘                                              │
    │  └──────────────────────────────────┘                          │
    │         │                                                      │
    │         │ SendMessage(to: "uds:/tmp/other.sock")              │
    │         ▼                                                      │
    │  ┌──────────────┐                                              │
    │  │ Other Claude │    SendMessage(to: "bridge:<session>")       │
    │  │ Code instance│──────────────────────────►  Remote Control   │
    │  └──────────────┘                                              │
    └─────────────────────────────────────────────────────────────────┘

### <a href="#worker-result-reporting-in-coordinator-mode"
class="header">Worker Result Reporting in Coordinator Mode</a>

In Coordinator Mode, when a Worker completes its task, the result is
injected into the coordinator's conversation as a **user-role message**
in `<task-notification>` XML format (`coordinatorMode.ts` lines
148-159):

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

The coordinator prompt explicitly requires (line 144): "They look like
user messages but they are not. Distinguish them by the
`<task-notification>` opening tag." This design prevents the coordinator
from responding to Worker results as if they were user input.

------------------------------------------------------------------------

## <a
href="#20b3-the-real-scheduling-kernel-tasklist-claim-loop-and-idle-hooks"
class="header">20b.3 The Real Scheduling Kernel: TaskList, Claim Loop,
and Idle Hooks</a>

If you only see `TeamCreateTool`, `SendMessageTool`, and Mailbox, it's
easy to understand Teams as "a group of Agents that can send messages to
each other." But the real value of Claude Code's Swarm lies not in
chatting, but in the **shared task graph**. `TeamCreate`'s prompt states
this directly:
`Teams have a 1:1 correspondence with task lists (Team = TaskList)`.
When creating a team, `TeamCreateTool` doesn't just write a `TeamFile`
-- it also resets and creates the corresponding task directory, then
binds the Leader's `taskListId` to the team name. This means Teams were
never designed as "team first, tasks as an accessory," but rather **the
team and the task list are two views of the same runtime object**.

### <a href="#tasks-are-not-todos-they-are-dag-nodes" class="header">Tasks
Are Not Todos, They Are DAG Nodes</a>

The `Task` structure in `utils/tasks.ts` contains:

``` typescript
{
  id: string,
  owner?: string,
  status: 'pending' | 'in_progress' | 'completed',
  blocks: string[],
  blockedBy: string[],
}
```

The most critical fields here are not `status`, but `blocks` and
`blockedBy`. They elevate the task list from a plain todo list into an
**explicit dependency graph**: a task is only executable after all its
blockers have completed. This design lets the Leader create an entire
batch of work items with dependencies upfront, then hand off "when to
parallelize" to the runtime, rather than having to verbally coordinate
in prompts repeatedly.

This is also why `TeamCreate`'s prompt emphasizes: "teammates should
check TaskList periodically, especially after completing each task, to
find available work or see newly unblocked tasks." Claude Code doesn't
require each teammate to have complete global plan reasoning
capabilities; it requires teammates to **go back to the shared task
graph and read state**.

### <a href="#auto-claim-the-swarms-minimal-scheduler"
class="header">Auto-Claim: The Swarm's Minimal Scheduler</a>

What actually drives this task graph is `useTaskListWatcher.ts`. This
watcher triggers a check whenever the task directory changes or the
Agent becomes idle again, automatically selecting an available task:

- `status === 'pending'`
- `owner` is empty
- All tasks in `blockedBy` are completed

The `findAvailableTask()` in the source code filters by exactly these
conditions. After finding a task, the runtime first `claimTask()` to
seize ownership, then formats the task into a prompt for Agent
execution; if submission fails, the claim is released. Two important
engineering implications:

1.  **Scheduling and reasoning are separated.** The model doesn't need
    to determine in natural language "which task isn't being done by
    someone else and has its dependencies resolved"; the runtime narrows
    candidates to a single explicit task first.
2.  **Parallelism comes from shared state, not message negotiation.**
    Multiple Agents can make progress simultaneously not because they're
    smart enough to coordinate with each other, but because claim +
    blocker checks explicitly encode conflicts into the state machine.

From this perspective, Claude Code's Swarm already has a small but
complete scheduler: **task graph + atomic claim + state transitions**.
The Mailbox is just a collaboration supplement, not the primary
scheduling surface.

### <a href="#post-turn-event-surface-taskcompleted-and-teammateidle"
class="header">Post-Turn Event Surface: TaskCompleted and
TeammateIdle</a>

Another key aspect of the Swarm is that when a teammate finishes a turn
of execution, it doesn't simply "stop" -- it enters an event-driven
wrap-up phase. In `query/stopHooks.ts`, when the current executor is a
teammate, Claude Code runs two types of specialized events after normal
Stop hooks:

- `TaskCompleted`: fires completion hooks for `in_progress` tasks owned
  by the current teammate
- `TeammateIdle`: fires hooks when the teammate enters idle state

This makes Teams neither purely pull-based nor purely push-based, but a
combination of both:

- **pull**: idle teammates return to the TaskList and continue claiming
  new tasks
- **push**: task completion and teammate idle trigger events, notifying
  the Leader or driving subsequent automation

In other words, Claude Code's Swarm is not "a group of agents that send
messages," but rather a collaboration kernel composed of **shared task
graph + durable mailbox + post-turn events**.

### <a href="#this-is-not-shared-memory-but-shared-state"
class="header">This Is Not Shared Memory, But Shared State</a>

The wording here must be very precise. Teams may look like "multiple
Agents sharing a workspace," but per the source code, the more accurate
description is not "shared memory" but three layers of shared state:

- **Shared task state**: `~/.claude/tasks/{team-name}/`
- **Shared communication state**:
  `~/.claude/teams/{team}/inboxes/*.json`
- **Shared team configuration**: `~/.claude/teams/{team}/config.json`

In-Process teammates just happen to run in the same process physically,
and preserve their own identity context via `AsyncLocalStorage`; this
doesn't elevate the entire system into a general-purpose blackboard
shared-memory runtime. This distinction is important because it
determines the truly portable pattern of Claude Code's Swarm:
**externalize collaboration state first, then let different execution
units collaborate around it**.

------------------------------------------------------------------------

## <a href="#20b4-async-agent-lifecycle" class="header">20b.4 Async Agent
Lifecycle</a>

When `shouldRunAsync` is `true` (triggered by any of
`run_in_background`, `background: true`, Coordinator Mode, Fork mode,
assistant mode, etc., line 567), the Agent enters an async lifecycle:

1.  **Registration**: `registerAsyncAgent()` creates a background task
    record, assigns `agentId`
2.  **Execution**: Runs `runAgent()` wrapped in `runWithAgentContext()`
3.  **Progress Reporting**: Updates status via
    `updateAsyncAgentProgress()` and `onProgress` callbacks
4.  **Completion/Failure**: Calls `completeAsyncAgent()` or
    `failAsyncAgent()`
5.  **Notification**: `enqueueAgentNotification()` injects results into
    the caller's message stream

A key design choice: background Agents are not associated with the
parent Agent's `abortController` (line 694-696 comment) -- when the user
presses ESC to cancel the main thread, background Agents continue
running. They can only be explicitly terminated via `chat:killAgents`.

### <a href="#worktree-isolation" class="header">Worktree Isolation</a>

When `isolation: 'worktree'`, the Agent runs in a temporary git worktree
(lines 590-593):

``` typescript
const slug = `agent-${earlyAgentId.slice(0, 8)}`;
worktreeInfo = await createAgentWorktree(slug);
```

After the Agent completes, if the worktree has no changes (compared to
the HEAD commit at creation), it's automatically cleaned up (lines
666-679). Worktrees with changes are retained, and their path and branch
name are returned to the caller.

------------------------------------------------------------------------

## <a
href="#20b5-teams-implementation-details-backends-communication-permissions-and-memory"
class="header">20b.5 Teams Implementation Details: Backends,
Communication, Permissions, and Memory</a>

> This section is the implementation-level deep dive of 20b.1 (teammate
> overview). Section 20b.1 answers "what are Teams" -- flat-structured
> teams, TeamCreateTool, TeammateAgentContext types; this section
> answers "how do Teams actually run" -- process management,
> communication protocols, permission synchronization, and shared memory
> engineering implementations.
>
> In the source code, "Swarm" and "Team" are synonyms: the directory is
> `utils/swarm/`, the tool is `TeamCreateTool`, the Feature Flag is
> `ENABLE_AGENT_SWARMS`, and the constant is
> `SWARM_SESSION_NAME = 'claude-swarm'`.

### <a href="#three-backends-one-interface" class="header">Three Backends,
One Interface</a>

Teams supports three physical backends, unified behind the
`PaneBackend` + `TeammateExecutor` interface
(`utils/swarm/backends/types.ts`):

<div class="table-wrapper">

| Backend | Process Model | Communication | Use Case |
|----|----|----|----|
| **Tmux** | Independent CLI processes, tmux split panes | Filesystem Mailbox | Default backend, for Linux/macOS |
| **iTerm2** | Independent CLI processes, iTerm2 split panes | Filesystem Mailbox | macOS native terminal users |
| **In-Process** | Same-process `AsyncLocalStorage` isolation | AppState memory queue | No tmux/iTerm2 environment |

</div>

Backend detection priority chain (`backends/registry.ts`):

    1. Running inside tmux?           → Tmux (native)
    2. Inside iTerm2 with it2 available? → iTerm2 (native)
    3. Inside iTerm2 but no it2?      → Prompt to install it2
    4. System has tmux?               → Tmux (external session)
    5. None of the above?             → In-Process fallback

The benefit of this strategy pattern: the Leader's `TeamCreateTool` and
`SendMessageTool` don't need to know which backend teammates run on --
`spawnTeammate()` automatically selects the best option.

### <a href="#team-lifecycle" class="header">Team Lifecycle</a>

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

Storage location: `~/.claude/teams/{teamName}/config.json`

**Teammate spawning flow** (`spawnMultiAgent.ts:305-539`):

1.  Detect backend -\> generate unique name -\> format agent ID
    (`{name}@{teamName}`)
2.  Assign terminal color -\> create tmux/iTerm2 split pane
3.  Build inherited CLI arguments: `--agent-id`, `--agent-name`,
    `--team-name`, `--agent-color`, `--parent-session-id`,
    `--permission-mode`
4.  Build inherited environment variables -\> send startup command to
    split pane
5.  Update TeamFile -\> send initial instructions via Mailbox
6.  Register out-of-process task tracking

**Flat structure constraint**: Teammates cannot spawn sub-teammates
(`AgentTool.tsx:266-300`). This isn't a technical limitation -- it's an
intentional organizational principle: coordination is centralized at the
Leader, avoiding infinitely deep delegation chains.

### <a href="#mailbox-communication-protocol" class="header">Mailbox
Communication Protocol</a>

Teammates communicate asynchronously through filesystem mailboxes
(`teammateMailbox.ts`):

    ~/.claude/teams/{teamName}/inboxes/{agentName}.json

**Concurrency control**: async lockfile + exponential backoff (10
retries, 5-100ms delay window)

**Message structure**:

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

**Control message types** (structured JSON nested in the `text` field):

<div class="table-wrapper">

| Type | Direction | Purpose |
|----|----|----|
| `idle` notification | Teammate -\> Leader | Teammate finished work, reporting reason (available/error/shutdown/completed) |
| `shutdown_request` | Leader -\> Teammate | Request graceful shutdown |
| `shutdown_response` | Teammate -\> Leader | Approve or reject shutdown request |
| `plan_approval_response` | Leader -\> Teammate | Approve or reject teammate's submitted plan |

</div>

**Idle notification structure** (`teammateMailbox.ts`):

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
class="header">Permission Synchronization: Leader Proxy Approval</a>

Teammates cannot self-approve dangerous tool calls -- they must go
through the Leader proxy (`utils/swarm/permissionSync.ts`):

    ~/.claude/teams/{teamName}/permissions/
      ├── pending/     # Requests awaiting approval
      └── resolved/    # Processed requests

**Request flow**:

    Worker encounters permission check
      ↓
    Creates SwarmPermissionRequest (with toolName, input, suggestions)
      ↓
    Writes to pending/{requestId}.json + sends to Leader Mailbox
      ↓
    Leader polls Mailbox → detects permission request → presents to user
      ↓
    User approves/rejects in Leader terminal
      ↓
    Writes to resolved/{requestId}.json
      ↓
    Worker polls resolved/ → gets result → continues execution

This design ensures that even when teammates run in independent
processes, all dangerous operations still go through human approval.

### <a href="#team-memory" class="header">Team Memory</a>

Feature gate `TENGU_HERRING_CLOCK` controls this. Located at:

    ~/.claude/projects/{project}/memory/team/MEMORY.md

Independent from personal memory
(`~/.claude/projects/{project}/memory/`), shared by all team members.
Uses the same two-step write flow as personal memory: first write the
`.md` file, then update the `MEMORY.md` index.

**Path security validation** (`memdir/teamMemPaths.ts`, PSR M22186
security patch):

<div class="table-wrapper">

| Attack Type | Protection |
|----|----|
| Null byte injection | Reject paths containing `\0` |
| URL-encoded traversal | Reject `%2e%2e%2f` and similar patterns |
| Unicode normalization attacks | Reject fullwidth `．．／` and similar variants |
| Backslash traversal | Reject paths containing `\` |
| Symlink loops | Detect ELOOP + dangling links |
| Path escape | Resolve realpath to verify containment of deepest existing ancestor |

</div>

### <a href="#in-process-teammates-team-collaboration-without-tmux"
class="header">In-Process Teammates: Team Collaboration Without tmux</a>

When the environment lacks tmux/iTerm2, teammates run within the same
process isolated by `AsyncLocalStorage`
(`utils/swarm/spawnInProcess.ts`):

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

In-Process teammate task state (`InProcessTeammateTaskState`) contains:

- `pendingUserMessages: string[]` -- message queue (replaces filesystem
  Mailbox)
- `awaitingPlanApproval: boolean` -- waiting for Leader approval in Plan
  mode
- `isIdle: boolean` -- idle status
- `onIdleCallbacks: Array<() => void>` -- callbacks on idle (notify
  Leader)
- `messages: Message[]` -- UI display buffer (cap
  `TEAMMATE_MESSAGES_UI_CAP = 50`)

Key difference from tmux teammates: communication is through memory
queues rather than filesystem Mailbox, but the API is completely
consistent.

### <a
href="#pattern-distillation-filesystem-based-inter-process-collaboration"
class="header">Pattern Distillation: Filesystem-Based Inter-Process
Collaboration</a>

Teams' communication design makes a counterintuitive but pragmatic
choice: **using the filesystem rather than IPC/RPC for cross-process
communication**.

<div class="table-wrapper">

| Dimension | Filesystem Mailbox | Traditional IPC/RPC |
|----|----|----|
| Persistence | Messages survive process crashes | Lost on disconnect |
| Debuggability | Direct `cat` to inspect | Requires dedicated debug tools |
| Concurrency control | lockfile | Built into protocol |
| Latency | Poll interval (millisecond scale) | Instant |
| Cross-machine | Requires shared filesystem | Natively supported |

</div>

For Agent Teams scenarios (second-scale interactions, processes may
crash, human debugging needed), the filesystem Mailbox trade-off is
reasonable -- UDS serves as a supplementary solution covering
low-latency scenarios.

------------------------------------------------------------------------

## <a href="#what-users-can-do" class="header">What Users Can Do</a>

**Leverage the Teams system to improve multi-Agent collaboration
efficiency:**

1.  **Note the addressing modes for inter-Agent communication.**
    `SendMessageTool` supports name addressing (`"tester"`), broadcast
    (`"*"`), and UDS addressing (`"uds:<path>"`). Understanding these
    addressing modes helps design more efficient multi-Agent workflows.

2.  **Understand Teams' backend selection.** If you use tmux or iTerm2,
    teammates run as independent terminal split panes communicating
    through filesystem Mailbox; without a terminal multiplexer, it falls
    back to in-process mode. Knowing this helps debug inter-teammate
    communication issues.

3.  **Use idle detection to gauge teammate status.** The Leader senses
    teammate status by polling idle notifications in the Mailbox. If a
    teammate seems "stuck," checking the mailbox files under
    `~/.claude/teams/{teamName}/inboxes/` can help locate the problem.

4.  **Permission approval is centralized at the Leader.** All teammates'
    dangerous operations require approval through the Leader terminal.
    Make sure the Leader terminal stays active, otherwise teammates will
    block waiting for approval.
