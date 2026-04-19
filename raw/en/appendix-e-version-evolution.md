# <a href="#appendix-e-version-evolution-log" class="header">Appendix E:
Version Evolution Log</a>

The core analysis in this book is based on Claude Code v2.1.88 (with
full source map, enabling recovery of 4,756 source files). This appendix
records key changes in subsequent versions and their impact on each
chapter.

> **Navigation tip**: Each change links to the corresponding chapter's
> version evolution section. Click the chapter number to jump.

> Since Anthropic removed source map distribution starting from v2.1.89,
> the following analysis is based on bundle string signal comparison +
> v2.1.88 source code-assisted inference, with limited depth.

## <a href="#v2188---v2191" class="header">v2.1.88 -&gt; v2.1.91</a>

**Overview**: cli.js +115KB \| Tengu events +39/-6 \| Environment
variables +8/-3 \| Source Map removed

### <a href="#high-impact-changes" class="header">High-Impact Changes</a>

<div class="table-wrapper">

| Change | Affected Chapters | Details |
|----|----|----|
| Tree-sitter WASM removal | [ch16 Permission System](../part5/ch16.html#version-evolutionv2191-changes) | Bash security reverted from AST analysis to regex/shell-quote; due to CC-643 performance issues |
| `"auto"` permission mode formalized | [ch16](../part5/ch16.html#version-evolutionv2191-changes)-[ch17](../part5/ch17.html#version-evolutionv2191-changes) Permissions/YOLO | SDK public API added auto mode |
| Cold compaction + dialog + quick backfill circuit breaker | [ch11 Micro-compaction](../part3/ch11.html#version-evolutionv2191-changes) | Added deferred compaction strategy and user confirmation UI |

</div>

### <a href="#medium-impact-changes" class="header">Medium-Impact
Changes</a>

<div class="table-wrapper">

| Change | Affected Chapters | Details |
|----|----|----|
| `staleReadFileStateHint` | [ch09](../part3/ch09.html#version-evolutionv2191-changes)-[ch10](../part3/ch10.html#version-evolutionv2191-changes) Context Management | File mtime change detection during tool execution |
| Ultraplan remote multi-agent planning | [ch20 Agent Clusters](../part6/ch20.html) | CCR remote sessions + Opus 4.6 + 30min timeout |
| Sub-agent enhancements | [ch20](../part6/ch20.html)-[ch21](../part6/ch21.html#version-evolutionv2191-changes) Multi-agent/Effort | Turn limits, lean schema, cost steering |

</div>

### <a href="#low-impact-changes" class="header">Low-Impact Changes</a>

<div class="table-wrapper">

| Change | Affected Chapters |
|----|----|
| `hook_output_persisted` + `pre_tool_hook_deferred` | ch19 Hooks |
| `memory_toggled` + `extract_memories_skipped_no_prose` | ch12 Token Budget |
| `rate_limit_lever_hint` | ch06 Prompt Behavior Steering |
| `bridge_client_presence_enabled` | ch22 Skills System |
| +8/-3 environment variables | Appendix B |

</div>

### <a href="#v2191-new-features-in-detail" class="header">v2.1.91 New
Features in Detail</a>

The following three features **did not exist at all** in v2.1.88 source
code and are new in v2.1.91. Analysis is based on v2.1.91 bundle reverse
engineering.

#### <a href="#1-powerup-lessons--interactive-feature-tutorial-system"
class="header">1. Powerup Lessons — Interactive Feature Tutorial
System</a>

**Events**: `tengu_powerup_lesson_opened`,
`tengu_powerup_lesson_completed`

**v2.1.88 status**: Did not exist. No powerup or lesson-related code in
`restored-src/src/`.

**v2.1.91 reverse engineering findings**:

Powerup Lessons is a built-in interactive tutorial system containing 10
course modules that teach users how to use Claude Code's core features.
The complete course registry extracted from the bundle:

<div class="table-wrapper">

| Course ID | Title | Related Features |
|----|----|----|
| `at-mentions` | Talk to your codebase | @ file references, line number references |
| `modes` | Steer with modes | Shift+Tab mode switching, plan, auto |
| `undo` | Undo anything | `/rewind`, Esc-Esc |
| `background` | Run in the background | Background tasks, `/tasks` |
| `memory` | Teach Claude your rules | CLAUDE.md, `/memory`, `/init` |
| `mcp` | Extend with tools | MCP servers, `/mcp` |
| `automate` | Automate your workflow | Skills, Hooks, `/hooks` |
| `subagents` | Multiply yourself | Sub-agents, `/agents`, `--worktree` |
| `cross-device` | Code from anywhere | `/remote-control`, `/teleport` |
| `model-dial` | Dial the model | `/model`, `/effort`, `/fast` |

</div>

**Technical implementation** (from bundle reverse engineering):

``` javascript
// Course opened event
logEvent("tengu_powerup_lesson_opened", {
  lesson_id: lesson.id,           // Course ID
  was_already_unlocked: unlocked.has(lesson.id),  // Already unlocked?
  unlocked_count: unlocked.size   // Total unlocked count
})

// Course completed event
logEvent("tengu_powerup_lesson_completed", {
  lesson_id: id,
  unlocked_count: newUnlocked.size,
  all_unlocked: newUnlocked.size === lessons.length  // All completed?
})
```

Unlock state is persisted to user configuration via `powerupsUnlocked`.
Each course contains a title, tagline, rich text content (with terminal
animation demos), and the UI uses check/circle markers for completion
status, triggering an "easter egg" animation when all courses are
completed.

**Book relevance**: The 10 course modules of Powerup Lessons cover
nearly all core topics from Parts 2 through 6 of this book — from
permission modes (ch16-17) to sub-agents (ch20) to MCP (ch22). It
represents Anthropic's official prioritization of "which features users
should master" and can serve as a reference for this book's "What You
Can Do" sections.

------------------------------------------------------------------------

#### <a href="#2-write-append-mode--file-append-writing" class="header">2.
Write Append Mode — File Append Writing</a>

**Event**: `tengu_write_append_used`

**v2.1.88 status**: Did not exist. v2.1.88's Write tool only supported
overwrite (complete replacement) mode.

**v2.1.91 reverse engineering findings**:

The Write tool's inputSchema gained a new `mode` parameter:

``` typescript
// v2.1.91 bundle reverse engineering
inputSchema: {
  file_path: string,
  content: string,
  mode: "overwrite" | "append"  // New in v2.1.91
}
```

`mode` parameter description (extracted from bundle):

> Write mode. 'overwrite' (default) replaces the file. Use 'append' to
> add content to the end of an existing file instead of rewriting the
> full content — e.g. for logs, accumulating output, or adding entries
> to a list.

**Feature Gate**: Append mode is controlled by GrowthBook flag
`tengu_maple_forge_w8k`. When the flag is off, the `mode` field is
`.omit()`'d from the schema, making it invisible to the model.

``` javascript
// v2.1.91 bundle reverse engineering
function getWriteSchema() {
  return getFeatureValue("tengu_maple_forge_w8k", false)
    ? fullSchema()           // Includes mode parameter
    : fullSchema().omit({ mode: true })  // Hides mode parameter
}
```

**Book relevance**: Affects ch02 (tool system overview) and ch08 (tool
prompts). In v2.1.88, the Write tool's prompt explicitly stated "This
tool will overwrite the existing file" — v2.1.91's append mode changes
this constraint, and the model can now choose to append rather than
overwrite.

------------------------------------------------------------------------

#### <a href="#3-message-rating--message-rating-feedback" class="header">3.
Message Rating — Message Rating Feedback</a>

**Event**: `tengu_message_rated`

**v2.1.88 status**: Did not exist. v2.1.88 had `tengu_feedback_survey_*`
series events (session-level feedback) but no message-level rating.

**v2.1.91 reverse engineering findings**:

Message Rating is a message-level user feedback mechanism that allows
users to rate individual Claude responses. Implementation extracted from
bundle reverse engineering:

``` javascript
// v2.1.91 bundle reverse engineering
function rateMessage(messageUuid, sentiment) {
  const wasAlreadyRated = ratings.get(messageUuid) === sentiment
  // Clicking the same rating again → clear (toggle behavior)
  if (wasAlreadyRated) {
    ratings.delete(messageUuid)
  } else {
    ratings.set(messageUuid, sentiment)
  }

  logEvent("tengu_message_rated", {
    message_uuid: messageUuid,  // Message unique ID
    sentiment: sentiment,       // Rating direction (e.g., thumbs_up/thumbs_down)
    cleared: wasAlreadyRated    // Was the rating cleared?
  })

  // Show thank-you notification after rating
  if (!wasAlreadyRated) {
    addNotification({
      key: "message-rated",
      text: "thanks for improving claude!",
      color: "success",
      priority: "immediate"
    })
  }
}
```

**UI mechanics**:

- Rating functionality is injected into the message list via React
  Context (`MessageRatingProvider`)
- Rating state is stored in memory as `Map<messageUuid, sentiment>`
- Supports toggle — clicking the same rating again clears it
- After rating, a green notification "thanks for improving claude!"
  appears

**Book relevance**: Related to ch29 (Observability Engineering).
v2.1.88's feedback system was session-level (`tengu_feedback_survey_*`);
v2.1.91 adds message-level rating, refining feedback granularity from
"was the whole session good" to "was this specific response good." This
provides Anthropic with more fine-grained training signals for RLHF
(Reinforcement Learning from Human Feedback).

------------------------------------------------------------------------

### <a href="#experimental-codename-events" class="header">Experimental
Codename Events</a>

The following events with random codenames are A/B tests with
undisclosed purposes:

<div class="table-wrapper">

| Event | Notes |
|----|----|
| `tengu_garnet_plover` | Unknown experiment |
| `tengu_gleaming_fair` | Unknown experiment |
| `tengu_gypsum_kite` | Unknown experiment |
| `tengu_slate_finch` | Unknown experiment |
| `tengu_slate_reef` | Unknown experiment |
| `tengu_willow_prism` | Unknown experiment |
| `tengu_maple_forge_w` | Related to Write Append mode's feature gate `tengu_maple_forge_w8k` |
| `tengu_lean_sub_pf` | Possibly related to sub-agent lean schema |
| `tengu_sub_nomdrep_q` | Possibly related to sub-agent behavior |
| `tengu_noreread_q` | Possibly related to `tengu_file_read_reread` file re-read skipping |

</div>

------------------------------------------------------------------------

## <a href="#v2191---v2192-incremental-changes" class="header">v2.1.91
-&gt; v2.1.92 (Incremental Changes)</a>

> Based on signal differences extracted between v2.1.91 and v2.1.92
> bundles. Full comparison report available at
> `docs/version-diffs/v2.1.88-vs-v2.1.92.md`.

### <a href="#overview" class="header">Overview</a>

<div class="table-wrapper">

| Metric                | v2.1.91 | v2.1.92     | Delta              |
|-----------------------|---------|-------------|--------------------|
| cli.js size           | 12.5MB  | 12.6MB      | +59KB              |
| Tengu events          | 860     | 857         | +19 / -21 (net -3) |
| Environment variables | 183     | 186         | +3                 |
| seccomp binaries      | None    | arm64 + x64 | **New**            |

</div>

### <a href="#key-additions" class="header">Key Additions</a>

<div class="table-wrapper">

| Subsystem | New Signals | Affected Chapters | Analysis |
|----|----|----|----|
| **Tools** | `advisor_command`, `advisor_dialog_shown` + 10 advisor\_\* identifiers | ch04 | Entirely new AdvisorTool — the first non-execution tool with its own model call chain |
| **Tools** | `tool_result_dedup` | ch04 | Tool result deduplication, together with v2.1.91's `file_read_reread` forms input/output dual-side dedup |
| **Security** | `vendor/seccomp/{arm64,x64}/apply-seccomp` | ch16 | System-level seccomp sandbox, replacing the tree-sitter application-level analysis removed in v2.1.91 |
| **Hook** | `stop_hook_added`, `stop_hook_command`, `stop_hook_removed` | ch18 | Stop Hook runtime dynamic add/remove — first time the Hook system supports runtime management |
| **Auth** | `bedrock_setup_started/complete/cancelled`, `oauth_bedrock_wizard_launched` | ch05 | AWS Bedrock guided setup wizard |
| **Auth** | `oauth_platform_docs_opened` | ch05 | Opening platform docs during OAuth flow |
| **Tools** | `bash_rerun_used` | ch04 | Bash command re-run functionality |
| **Model** | `rate_limit_options_menu_select_team` | — | Team option during rate limiting |

</div>

### <a href="#key-removals" class="header">Key Removals</a>

<div class="table-wrapper">

| Removed Signal | Analysis |
|----|----|
| `session_tagged`, `tag_command_*` (5 total) | Session tagging system completely removed |
| `sm_compact` | Legacy compaction event cleaned up (v2.1.91 already introduced cold_compact as replacement) |
| `skill_improvement_survey` | Skill improvement survey ended |
| `pid_based_version_locking` | PID-based version locking mechanism removed |
| `compact_streaming_retry` | Compaction streaming retry cleaned up |
| `ultraplan_model` | Ultraplan model event refactored |
| 6 random codename experiment events | Old A/B tests ended (cobalt_frost, copper_bridge, etc.) |

</div>

### <a href="#new-environment-variables" class="header">New Environment
Variables</a>

<div class="table-wrapper">

| Variable | Purpose |
|----|----|
| `CLAUDE_CODE_EXECPATH` | Executable file path |
| `CLAUDE_CODE_SIMULATE_PROXY_USAGE` | Proxy usage simulation (for testing) |
| `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK` | Skip Fast Mode organization-level check |

</div>

### <a href="#design-trends" class="header">Design Trends</a>

The v2.1.91 -\> v2.1.92 increment is small but directionally clear:

1.  **Security strategy descends from application layer to system
    layer** (tree-sitter -\> seccomp)
2.  **Tool system expands from pure execution to advisory**
    (AdvisorTool)
3.  **Configuration management moves from purely static to
    runtime-mutable** (Stop Hook dynamic management)
4.  **Enterprise onboarding barrier continues to lower** (Bedrock
    wizard)

------------------------------------------------------------------------

*Use `scripts/cc-version-diff.sh` to generate diff data;
`docs/anchor-points.md` provides subsystem anchor point locations*

------------------------------------------------------------------------

## <a href="#v2192---v21100" class="header">v2.1.92 -&gt; v2.1.100</a>

**Overview**: cli.js +870KB (+6.9%) \| Tengu events +45/-21 (net +24) \|
Env vars +8/-2 \| New audio-capture vendor

### <a href="#high-impact-changes-1" class="header">High Impact Changes</a>

<div class="table-wrapper">

| Change | Affected Chapters | Details |
|----|----|----|
| Dream system maturation | ch24 Memory System | kairos_dream cron scheduling + auto_dream_skipped observability + dream_invoked manual trigger tracking |
| Bedrock/Vertex full wizard | ch06b API Communication | 18 events covering setup, probing, and upgrade complete lifecycle |
| Tool Result Dedup | ch10 File State Preservation | Tool result dedup with short ID references saving context |
| Bridge REPL major cleanup | ch06b API Communication | 16 bridge_repl\_\* events removed (minor residual references remain), communication mechanism restructured |
| toolStats statistics field | ch24 Memory System | sdk-tools.d.ts adds 7-dimensional tool usage statistics |

</div>

### <a href="#medium-impact-changes-1" class="header">Medium Impact
Changes</a>

<div class="table-wrapper">

| Change | Affected Chapters | Details |
|----|----|----|
| Advisor tool | ch21 Effort/Thinking | Server-side strong model review tool, feature gate `advisor-tool-2026-03-01` |
| Autofix PR | ch20c Ultraplan | Remote session auto-fix PR, alongside ultraplan/ultrareview |
| Team Onboarding | ch20b Teams | Usage report generation + onboarding discovery |
| Mantle auth backend | ch06b, Appendix G | Fifth API authentication channel |
| Cold compact enhancement | ch09 Auto-Compaction | Feature Flag driven + MAX_CONTEXT_TOKENS override |

</div>

### <a href="#low-impact-changes-1" class="header">Low Impact Changes</a>

<div class="table-wrapper">

| Change | Affected Chapters |
|----|----|
| `hook_prompt_transcript_truncated` + stop_hook lifecycle | ch18 Hooks |
| Perforce VCS support (`CLAUDE_CODE_PERFORCE_MODE`) | ch04 Tools |
| audio-capture vendor binaries (6 platforms) | Potential new feature |
| `image_resize` — automatic image scaling | ch04 Tools |
| `bash_allowlist_strip_all` — bash allowlist operation | ch16 Permissions |
| +8/-2 environment variables | Appendix B |
| 12+ new experiment codename events | ch23 Feature Flags |

</div>

### <a href="#v21100-new-features-in-detail" class="header">v2.1.100 New
Features in Detail</a>

The following features **did not exist** in v2.1.92 or only had
rudimentary form, and are incremental additions in v2.1.92→v2.1.100.

#### <a href="#1-kairos-dream--background-scheduled-memory-consolidation"
class="header">1. Kairos Dream — Background Scheduled Memory
Consolidation</a>

**Event**: `tengu_kairos_dream`

**v2.1.92 status**: v2.1.92 already had `auto_dream` and manual `/dream`
trigger, but no background cron scheduling.

**v2.1.100 addition**:

Kairos Dream is the third trigger mode for the Dream system — executing
memory consolidation automatically via cron scheduling in the
background, without waiting for users to start new sessions. Cron
expression generation extracted from the bundle:

``` javascript
// v2.1.100 bundle reverse engineering
function P_A() {
  let q = Math.floor(Math.random() * 360);
  return `${q % 60} ${Math.floor(q / 60)} * * *`;
  // Random minute+hour offset, avoids multi-user simultaneous triggers
}
```

Combined with the `auto_dream_skipped` event's `reason` field
("sessions"/"lock"), Kairos Dream implements a complete background
memory consolidation lifecycle.

**Book relevance**: ch24 updated with Dream system analysis (three-tier
trigger matrix); ch29 observability chapter can reference
`auto_dream_skipped` skip reason distribution as an observability design
case study.

------------------------------------------------------------------------

#### <a href="#2-bedrockvertex-model-upgrade-wizard" class="header">2.
Bedrock/Vertex Model Upgrade Wizard</a>

**Events**: 18 events (9 Bedrock + 9 Vertex), symmetric structure

**v2.1.92 status**: v2.1.92 only had Bedrock's
`setup_started/complete/cancelled` (3 events).

**v2.1.100 addition**:

Complete model upgrade detection and automatic switching mechanism.
Design highlights:

1.  **Unpinned model detection**: Scans user configuration to find model
    tiers not explicitly pinned via environment variables
2.  **Accessibility probing**: `probeBedrockModel` / `probeVertexModel`
    verify whether new models are available in the user's account
3.  **User confirmation**: Upgrades don't auto-execute; require user
    accept/decline
4.  **Persistent decline**: Declined upgrades are recorded in user
    settings, preventing repeated prompting
5.  **Default fallback**: When default model is inaccessible, automatic
    fallback to same-tier alternative

The Vertex wizard (`vertex_setup_started` etc.) is new in v2.1.100;
v2.1.92 had no interactive Vertex setup.

------------------------------------------------------------------------

#### <a href="#3-autofix-pr--remote-auto-fix" class="header">3. Autofix PR —
Remote Auto-Fix</a>

**Events**: `tengu_autofix_pr_started`, `tengu_autofix_pr_result`

**v2.1.92 status**: Did not exist. v2.1.92 had ultraplan and
ultrareview, but no autofix-pr.

**v2.1.100 addition**:

Autofix PR is the fourth remote agent task type, listed alongside
`remote-agent`, `ultraplan`, and `ultrareview` in the `XAY` remote task
type registry. Workflow extracted from the bundle:

``` javascript
// v2.1.100 bundle reverse engineering
// Remote task type registry
XAY = ["remote-agent", "ultraplan", "ultrareview", "autofix-pr", "background-pr"];

// Autofix PR launch
d("tengu_autofix_pr_started", {});
let b = await kt({
  initialMessage: h,
  source: "autofix_pr",
  branchName: P,
  reuseOutcomeBranch: P,
  title: `Autofix PR: ${k}/${R}#${v} (${P})`
});
```

Autofix PR spawns a remote Claude Code session that monitors a specified
Pull Request and automatically fixes issues (CI failures, code review
feedback). Unlike Ultraplan (planning) and Ultrareview (reviewing),
Autofix PR focuses on **executing fixes**.

Note `background-pr` also appears in the task type list, suggesting
another background PR processing mode.

------------------------------------------------------------------------

#### <a href="#4-team-onboarding--team-usage-report" class="header">4. Team
Onboarding — Team Usage Report</a>

**Events**: `tengu_team_onboarding_invoked`,
`tengu_team_onboarding_generated`,
`tengu_team_onboarding_discovery_shown`

**v2.1.92 status**: Did not exist.

**v2.1.100 addition**:

Team onboarding report generator that collects user usage data (session
count, slash command count, MCP server count) and generates a guided
document from a template. Key parameters extracted from the bundle:

- `windowDays`: Analysis window (1-365 days)
- `sessionCount`, `slashCommandCount`, `mcpServerCount`: Usage statistic
  dimensions
- `GUIDE_TEMPLATE`, `USAGE_DATA`: Report template variables

The `cedar_inlet` experiment event controls team onboarding discovery
display (`discovery_shown`), suggesting this is an A/B tested feature.

------------------------------------------------------------------------

### <a href="#experiment-codename-events" class="header">Experiment Codename
Events</a>

The following events with random codenames are A/B tests with
undisclosed purposes:

<div class="table-wrapper">

| Event | Status | Notes |
|----|----|----|
| `tengu_amber_sentinel` | New in v2.1.100 | — |
| `tengu_basalt_kite` | New in v2.1.100 | — |
| `tengu_billiard_aviary` | New in v2.1.100 | — |
| `tengu_cedar_inlet` | New in v2.1.100 | Related to Team Onboarding discovery |
| `tengu_coral_beacon` | New in v2.1.100 | — |
| `tengu_flint_harbor` / `_prompt` / `_heron` | New in v2.1.100 | 3 related events |
| `tengu_garnet_loom` | New in v2.1.100 | — |
| `tengu_pyrite_wren` | New in v2.1.100 | — |
| `tengu_shale_finch` | New in v2.1.100 | — |

</div>

Experiments present in v2.1.92 but removed in v2.1.100: `amber_lantern`,
`editafterwrite_qpl`, `lean_sub_pf`, `maple_forge_w`, `relpath_gh`.

------------------------------------------------------------------------

### <a href="#design-trends-1" class="header">Design Trends</a>

The v2.1.92→v2.1.100 evolution direction:

1.  **Memory system from passive to active** (auto_dream → kairos_dream
    scheduled execution + observable skip reasons)
2.  **Cloud platforms from configuration to wizards** (manual env vars →
    interactive setup wizards + automatic model upgrade detection)
3.  **IDE bridge architecture restructured** (bridge_repl largely
    removed, 16 events cleared — transitioning to new communication
    mechanism)
4.  **Remote agent family expansion** (ultraplan/ultrareview → +
    autofix-pr + background-pr)
5.  **Context optimization refinement** (tool_result_dedup reduces
    duplicates + MAX_CONTEXT_TOKENS user-controllable)

------------------------------------------------------------------------

*Use `scripts/cc-version-diff.sh` to generate diff data;
`docs/anchor-points.md` provides subsystem anchor point locations*
