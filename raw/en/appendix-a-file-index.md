# <a href="#appendix-a-key-file-index" class="header">Appendix A: Key File
Index</a>

This appendix lists the key files in the Claude Code v2.1.88 source code
and their responsibilities, grouped by subsystem. File paths are
relative to `restored-src/src/`.

## <a href="#entry-points-and-core-loop" class="header">Entry Points and
Core Loop</a>

<div class="table-wrapper">

| File | Responsibility | Related Chapters |
|----|----|----|
| `main.tsx` | CLI entry point, parallel prefetch, lazy import, Feature Flag gating | Chapter 1 |
| `query.ts` | Agent Loop main loop, `queryLoop` state machine | Chapter 3 |
| `query/transitions.ts` | Loop transition types: `Continue`, `Terminal` | Chapter 3 |

</div>

## <a href="#tool-system" class="header">Tool System</a>

<div class="table-wrapper">

| File | Responsibility | Related Chapters |
|----|----|----|
| `Tool.ts` | Tool interface contract, `TOOL_DEFAULTS` fail-closed defaults | Chapters 2, 25 |
| `tools.ts` | Tool registration, Feature Flag conditional loading | Chapter 2 |
| `services/tools/toolOrchestration.ts` | Tool execution orchestration, `partitionToolCalls` concurrency partitioning | Chapter 4 |
| `services/tools/toolExecution.ts` | Single-tool execution lifecycle | Chapter 4 |
| `services/tools/StreamingToolExecutor.ts` | Streaming tool executor | Chapter 4 |
| `tools/BashTool/` | Bash tool implementation, including Git safety protocol | Chapters 8, 27 |
| `tools/FileEditTool/` | File edit tool, "read before edit" enforcement | Chapters 8, 27 |
| `tools/FileReadTool/` | File read tool, default 2000 lines | Chapter 8 |
| `tools/GrepTool/` | ripgrep-based search tool | Chapter 8 |
| `tools/AgentTool/` | Sub-Agent spawning tool | Chapters 8, 20 |
| `tools/SkillTool/` | Skill invocation tool | Chapters 8, 22 |
| `tools/SkillTool/prompt.ts` | Skill list budget: 1% of context window | Chapters 12, 26 |

</div>

## <a href="#system-prompts" class="header">System Prompts</a>

<div class="table-wrapper">

| File | Responsibility | Related Chapters |
|----|----|----|
| `constants/prompts.ts` | System prompt construction, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | Chapters 5, 6, 25 |
| `constants/systemPromptSections.ts` | Section registry with cache control scope | Chapter 5 |
| `constants/toolLimits.ts` | Tool result budget constants | Chapters 12, 26 |

</div>

## <a href="#api-and-caching" class="header">API and Caching</a>

<div class="table-wrapper">

| File | Responsibility | Related Chapters |
|----|----|----|
| `services/api/claude.ts` | API call construction, cache breakpoint placement | Chapter 13 |
| `services/api/promptCacheBreakDetection.ts` | Cache break detection, `PreviousState` tracking | Chapters 14, 25 |
| `utils/api.ts` | `splitSysPromptPrefix()` three-way cache splitting | Chapters 5, 13 |

</div>

## <a href="#context-compaction" class="header">Context Compaction</a>

<div class="table-wrapper">

| File | Responsibility | Related Chapters |
|----|----|----|
| `services/compact/compact.ts` | Compaction orchestration, `POST_COMPACT_MAX_FILES_TO_RESTORE` | Chapters 9, 10 |
| `services/compact/autoCompact.ts` | Auto-compaction threshold and circuit breaker | Chapters 9, 25, 26 |
| `services/compact/prompt.ts` | Compaction prompt template | Chapters 9, 28 |
| `services/compact/microCompact.ts` | Time-based micro-compaction | Chapter 11 |
| `services/compact/apiMicrocompact.ts` | API-native cached micro-compaction | Chapter 11 |

</div>

## <a href="#permissions-and-security" class="header">Permissions and
Security</a>

<div class="table-wrapper">

| File | Responsibility | Related Chapters |
|----|----|----|
| `utils/permissions/yoloClassifier.ts` | YOLO auto-mode classifier | Chapter 17 |
| `utils/permissions/denialTracking.ts` | Denial tracking, `DENIAL_LIMITS` | Chapters 17, 27 |
| `tools/BashTool/bashPermissions.ts` | Bash command permission checks | Chapter 16 |

</div>

## <a href="#claudemd-and-skills" class="header">CLAUDE.md and Skills</a>

<div class="table-wrapper">

| File | Responsibility | Related Chapters |
|----|----|----|
| `utils/claudemd.ts` | CLAUDE.md loading and injection, 4-layer priority | Chapter 19 |
| `skills/bundled/` | Built-in skills directory | Chapter 22 |
| `skills/loadSkillsDir.ts` | User-defined skill discovery | Chapter 22 |
| `skills/mcpSkillBuilders.ts` | MCP-to-skill bridge | Chapter 22 |

</div>

## <a href="#multi-agent-orchestration" class="header">Multi-Agent
Orchestration</a>

<div class="table-wrapper">

| File | Responsibility | Related Chapters |
|----|----|----|
| `coordinator/coordinatorMode.ts` | Coordinator mode implementation | Chapter 20 |
| `utils/teammate.ts` | Teammate Agent tools | Chapter 20 |
| `utils/swarm/teammatePromptAddendum.ts` | Teammate prompt addendum content | Chapter 20 |

</div>

## <a href="#tool-results-and-storage" class="header">Tool Results and
Storage</a>

<div class="table-wrapper">

| File | Responsibility | Related Chapters |
|----|----|----|
| `utils/toolResultStorage.ts` | Large result persistence, truncation previews | Chapters 12, 28 |
| `utils/toolSchemaCache.ts` | Tool Schema caching | Chapter 15 |

</div>

## <a href="#cross-session-memory" class="header">Cross-Session Memory</a>

<div class="table-wrapper">

| File | Responsibility | Related Chapters |
|----|----|----|
| `memdir/memdir.ts` | MEMORY.md index and topic file loading, system prompt injection | Chapter 24 |
| `memdir/paths.ts` | Memory directory path resolution, three-level priority chain | Chapter 24 |
| `services/extractMemories/extractMemories.ts` | Fork agent automatic memory extraction | Chapter 24 |
| `services/SessionMemory/sessionMemory.ts` | Rolling session summary for compaction | Chapter 24 |
| `utils/sessionStorage.ts` | JSONL session record storage and recovery | Chapter 24 |
| `tools/AgentTool/agentMemory.ts` | Sub-Agent persistence and VCS snapshots | Chapter 24 |
| `services/autoDream/autoDream.ts` | Overnight memory consolidation and pruning | Chapter 24 |

</div>

## <a href="#telemetry-and-observability" class="header">Telemetry and
Observability</a>

<div class="table-wrapper">

| File | Responsibility | Related Chapters |
|----|----|----|
| `services/analytics/index.ts` | Event entry point, queue-attach pattern, PII tag types | Chapter 29 |
| `services/analytics/sink.ts` | Dual-path dispatch (Datadog + 1P), sampling | Chapter 29 |
| `services/analytics/firstPartyEventLogger.ts` | OTel BatchLogRecordProcessor integration | Chapter 29 |
| `services/analytics/firstPartyEventLoggingExporter.ts` | Custom Exporter, disk-persistent retry | Chapter 29 |
| `services/analytics/metadata.ts` | Event metadata, tool name sanitization, PII grading | Chapter 29 |
| `services/analytics/datadog.ts` | Datadog allow-list, batch flushing | Chapter 29 |
| `services/analytics/sinkKillswitch.ts` | Remote circuit breaker (tengu_frond_boric) | Chapter 29 |
| `services/api/logging.ts` | API three-event model (query/success/error) | Chapter 29 |
| `services/api/withRetry.ts` | Retry telemetry, gateway fingerprint detection | Chapter 29 |
| `utils/debug.ts` | Debug logging, --debug flag | Chapter 29 |
| `utils/diagLogs.ts` | PII-free container diagnostics | Chapter 29 |
| `utils/errorLogSink.ts` | Error file logging | Chapter 29 |
| `utils/telemetry/sessionTracing.ts` | OTel spans, three-level tracing | Chapter 29 |
| `utils/telemetry/perfettoTracing.ts` | Perfetto visualization tracing | Chapter 29 |
| `utils/gracefulShutdown.ts` | Cascading timeout graceful shutdown | Chapter 29 |
| `cost-tracker.ts` | Cost tracking, cross-session persistence | Chapter 29 |

</div>

## <a href="#configuration-and-state" class="header">Configuration and
State</a>

<div class="table-wrapper">

| File | Responsibility | Related Chapters |
|----|----|----|
| `utils/effort.ts` | Effort level parsing | Chapter 21 |
| `utils/fastMode.ts` | Fast Mode management | Chapter 21 |
| `utils/managedEnvConstants.ts` | Managed environment variable allowlist | Appendix B |
| `screens/REPL.tsx` | Main interactive interface (5000+ line React component) | Chapter 1 |

</div>
