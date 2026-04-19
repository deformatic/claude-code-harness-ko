# <a href="#appendix-d-full-list-of-89-feature-flags"
class="header">Appendix D: Full List of 89 Feature Flags</a>

This appendix lists all Feature Flags gated via the `feature()` function
in the Claude Code v2.1.88 source code, categorized by functional
domain. Reference counts reflect how frequently each flag appears in the
source, offering a rough indication of implementation depth (see Chapter
23 for the maturity inference method).

## <a href="#autonomous-agent-and-background-execution-19"
class="header">Autonomous Agent and Background Execution (19)</a>

<div class="table-wrapper">

| Flag | References | Description |
|----|----|----|
| `AGENT_MEMORY_SNAPSHOT` | 2 | Agent memory snapshots |
| `AGENT_TRIGGERS` | 11 | Scheduled triggers (local cron) |
| `AGENT_TRIGGERS_REMOTE` | 2 | Remote scheduled triggers (cloud cron) |
| `BG_SESSIONS` | 11 | Background session management (ps/logs/attach/kill) |
| `BUDDY` | 15 | Buddy mode: floating UI bubble |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 1 | Built-in explore/plan agent types |
| `COORDINATOR_MODE` | 32 | Coordinator mode: cross-agent task coordination |
| `FORK_SUBAGENT` | 4 | Sub-agent fork execution mode |
| `KAIROS` | 84 | Assistant mode core: background autonomous agent, tick wake-up |
| `KAIROS_BRIEF` | 17 | Brief mode: send progress messages to user |
| `KAIROS_CHANNELS` | 13 | Channel system: multi-channel communication |
| `KAIROS_DREAM` | 1 | autoDream memory consolidation trigger |
| `KAIROS_GITHUB_WEBHOOKS` | 2 | GitHub Webhook subscription: PR event triggers |
| `KAIROS_PUSH_NOTIFICATION` | 2 | Push notifications: send status updates to user |
| `MONITOR_TOOL` | 5 | Monitor tool: background process monitoring |
| `PROACTIVE` | 21 | Proactive work mode: terminal focus awareness, proactive actions |
| `TORCH` | 1 | Torch command |
| `ULTRAPLAN` | 2 | Ultraplan: structured task decomposition UI |
| `VERIFICATION_AGENT` | 4 | Verification agent: automatically verify task completion status |

</div>

## <a href="#remote-control-and-distributed-execution-10"
class="header">Remote Control and Distributed Execution (10)</a>

<div class="table-wrapper">

| Flag | References | Description |
|----|----|----|
| `BRIDGE_MODE` | 14 | Bridge mode core: remote control protocol |
| `CCR_AUTO_CONNECT` | 3 | Claude Code Remote auto-connect |
| `CCR_MIRROR` | 3 | CCR mirror mode: read-only remote mirror |
| `CCR_REMOTE_SETUP` | 1 | CCR remote setup command |
| `CONNECTOR_TEXT` | 7 | Connector text block handling |
| `DAEMON` | 1 | Daemon mode: background daemon worker |
| `DOWNLOAD_USER_SETTINGS` | 5 | Download user settings from cloud |
| `LODESTONE` | 3 | Protocol registration (lodestone:// handler) |
| `UDS_INBOX` | 14 | Unix Domain Socket inbox |
| `UPLOAD_USER_SETTINGS` | 1 | Upload user settings to cloud |

</div>

## <a href="#multimedia-and-interaction-17" class="header">Multimedia and
Interaction (17)</a>

<div class="table-wrapper">

| Flag | References | Description |
|----|----|----|
| `ALLOW_TEST_VERSIONS` | 2 | Allow test versions |
| `ANTI_DISTILLATION_CC` | 1 | Anti-distillation protection |
| `AUTO_THEME` | 1 | Automatic theme switching |
| `BUILDING_CLAUDE_APPS` | 1 | Building Claude Apps skill |
| `CHICAGO_MCP` | 12 | Computer Use MCP integration |
| `HISTORY_PICKER` | 1 | History picker UI |
| `MESSAGE_ACTIONS` | 2 | Message actions (copy/edit shortcuts) |
| `NATIVE_CLIENT_ATTESTATION` | 1 | Native client attestation |
| `NATIVE_CLIPBOARD_IMAGE` | 2 | Native clipboard image support |
| `NEW_INIT` | 2 | New initialization flow |
| `POWERSHELL_AUTO_MODE` | 2 | PowerShell auto mode |
| `QUICK_SEARCH` | 1 | Quick search UI |
| `REVIEW_ARTIFACT` | 1 | Review artifact |
| `TEMPLATES` | 5 | Task templates/categorization |
| `TERMINAL_PANEL` | 3 | Terminal panel |
| `VOICE_MODE` | 11 | Voice mode: streaming speech-to-text |
| `WEB_BROWSER_TOOL` | 1 | Web browser tool (Bun WebView) |

</div>

## <a href="#context-and-performance-optimization-16"
class="header">Context and Performance Optimization (16)</a>

<div class="table-wrapper">

| Flag | References | Description |
|----|----|----|
| `ABLATION_BASELINE` | 1 | Ablation test baseline |
| `BASH_CLASSIFIER` | 33 | Bash command classifier |
| `BREAK_CACHE_COMMAND` | 2 | Force cache break command |
| `CACHED_MICROCOMPACT` | 12 | Cached micro-compaction strategy |
| `COMPACTION_REMINDERS` | 1 | Compaction reminder mechanism |
| `CONTEXT_COLLAPSE` | 16 | Context collapse: fine-grained context management |
| `FILE_PERSISTENCE` | 3 | File persistence timing |
| `HISTORY_SNIP` | 15 | History snip command |
| `OVERFLOW_TEST_TOOL` | 2 | Overflow test tool |
| `PROMPT_CACHE_BREAK_DETECTION` | 9 | Prompt Cache break detection |
| `REACTIVE_COMPACT` | 4 | Reactive compaction: on-demand triggering |
| `STREAMLINED_OUTPUT` | 1 | Streamlined output mode |
| `TOKEN_BUDGET` | 4 | Token budget tracking UI |
| `TREE_SITTER_BASH` | 3 | Tree-sitter Bash parser |
| `TREE_SITTER_BASH_SHADOW` | 5 | Tree-sitter Bash shadow mode (A/B) |
| `ULTRATHINK` | 1 | Ultra-think mode |

</div>

## <a href="#memory-and-knowledge-management-13" class="header">Memory and
Knowledge Management (13)</a>

<div class="table-wrapper">

| Flag | References | Description |
|----|----|----|
| `AWAY_SUMMARY` | 2 | Away summary: generate progress when away |
| `COWORKER_TYPE_TELEMETRY` | 2 | Coworker type telemetry |
| `ENHANCED_TELEMETRY_BETA` | 2 | Enhanced telemetry beta |
| `EXPERIMENTAL_SKILL_SEARCH` | 19 | Experimental remote skill search |
| `EXTRACT_MEMORIES` | 7 | Automatic memory extraction |
| `MCP_RICH_OUTPUT` | 3 | MCP rich text output |
| `MCP_SKILLS` | 9 | MCP server skill discovery |
| `MEMORY_SHAPE_TELEMETRY` | 3 | Memory structure telemetry |
| `RUN_SKILL_GENERATOR` | 1 | Skill generator |
| `SKILL_IMPROVEMENT` | 1 | Automatic skill improvement |
| `TEAMMEM` | 44 | Team memory synchronization |
| `WORKFLOW_SCRIPTS` | 6 | Workflow scripts |
| `TRANSCRIPT_CLASSIFIER` | 69 | Transcript classifier (auto mode) |

</div>

## <a href="#infrastructure-and-telemetry-14" class="header">Infrastructure
and Telemetry (14)</a>

<div class="table-wrapper">

| Flag                     | References | Description                       |
|--------------------------|------------|-----------------------------------|
| `COMMIT_ATTRIBUTION`     | 11         | Git commit attribution tracking   |
| `HARD_FAIL`              | 2          | Hard failure mode                 |
| `IS_LIBC_GLIBC`          | 1          | glibc runtime detection           |
| `IS_LIBC_MUSL`           | 1          | musl runtime detection            |
| `PERFETTO_TRACING`       | 1          | Perfetto performance tracing      |
| `SHOT_STATS`             | 8          | Tool call distribution statistics |
| `SLOW_OPERATION_LOGGING` | 1          | Slow operation logging            |
| `UNATTENDED_RETRY`       | 1          | Unattended retry                  |

</div>

------------------------------------------------------------------------

## <a href="#statistical-summary" class="header">Statistical Summary</a>

<div class="table-wrapper">

| Category | Count | Highest-Reference Flag |
|----|----|----|
| Autonomous Agent and Background Execution | 19 | KAIROS (84) |
| Remote Control and Distributed Execution | 10 | BRIDGE_MODE (14), UDS_INBOX (14) |
| Multimedia and Interaction | 17 | CHICAGO_MCP (12) |
| Context and Performance Optimization | 16 | TRANSCRIPT_CLASSIFIER (69) |
| Memory and Knowledge Management | 13 | TEAMMEM (44) |
| Infrastructure and Telemetry | 14 | COMMIT_ATTRIBUTION (11) |
| **Total** | **89** |  |

</div>

**Top 5 by reference count**: KAIROS (84) \> TRANSCRIPT_CLASSIFIER (69)
\> TEAMMEM (44) \> BASH_CLASSIFIER (33) \> COORDINATOR_MODE (32)
