# <a href="#appendix-a-key-file-index" class="header">부록 A: 키 파일 인덱스</a>

이 부록에는 Claude Code v2.1.88 소스 코드의 주요 파일과 해당 책임이 하위 시스템별로 그룹화되어 나열되어 있습니다. 파일 경로는 `restored-src/src/`를 기준으로 합니다.

## <a href="#entry-points-and-core-loop" class="header">진입점 및 코어 루프</a>

<div class="table-wrapper">

| 파일 | 책임 | 관련 장 |
|----|----|----|
| `main.tsx` | CLI 진입점, 병렬 프리페치, 지연 가져오기, 기능 플래그 게이팅 | 제1장 |
| `query.ts` | 에이전트 루프 메인 루프, `queryLoop` 상태 머신 | 제3장 |
| `query/transitions.ts` | 루프 전환 유형: `Continue`, `Terminal` | 제3장 |

</div>

## <a href="#tool-system" class="header">도구 시스템</a>

<div class="table-wrapper">

| 파일 | 책임 | 관련 장 |
|----|----|----|
| `Tool.ts` | 도구 인터페이스 계약, `TOOL_DEFAULTS` 페일클로즈 기본값 | 2장, 25장 |
| `tools.ts` | 도구 등록, 기능 플래그 조건부 로딩 | 제2장 |
| `services/tools/toolOrchestration.ts` | 도구 실행 오케스트레이션, `partitionToolCalls` 동시성 파티셔닝 | 제4장 |
| `services/tools/toolExecution.ts` | 단일 도구 실행 수명주기 | 제4장 |
| `services/tools/StreamingToolExecutor.ts` | 스트리밍 도구 실행자 | 제4장 |
| `tools/BashTool/` | Git 안전 프로토콜을 포함한 Bash 도구 구현 | 8장, 27장 |
| `tools/FileEditTool/` | 파일 편집 도구, "편집 전 읽기" 시행 | 8장, 27장 |
| `tools/FileReadTool/` | 파일 읽기 도구, 기본 2000줄 | 제8장 |
| `tools/GrepTool/` | ripgrep 기반 검색 도구 | 제8장 |
| `tools/AgentTool/` | 하위 에이전트 생성 도구 | 8장, 20장 |
| `tools/SkillTool/` | 스킬 발동 도구 | 8장, 22장 |
| `tools/SkillTool/prompt.ts` | 스킬 목록 예산: 상황 창의 1% | 12장, 26장 |

</div>

## <a href="#system-prompts" class="header">시스템 프롬프트</a>

<div class="table-wrapper">

| 파일 | 책임 | 관련 장 |
|----|----|----|
| `constants/prompts.ts` | 시스템 신속한 구축, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | 5장, 6장, 25장 |
| `constants/systemPromptSections.ts` | 캐시 제어 범위가 있는 섹션 레지스트리 | 제5장 |
| `constants/toolLimits.ts` | 도구 결과 예산 상수 | 12장, 26장 |

</div>

## <a href="#api-and-caching" class="header">API 및 캐싱</a>

<div class="table-wrapper">

| 파일 | 책임 | 관련 장 |
|----|----|----|
| `services/api/claude.ts` | API 호출 구성, 캐시 중단점 배치 | 제13장 |
| `services/api/promptCacheBreakDetection.ts` | 캐시 중단 감지, `PreviousState` 추적 | 14, 25장 |
| `utils/api.ts` | `splitSysPromptPrefix()` 3방향 캐시 분할 | 5장, 13장 |

</div>

## <a href="#context-compaction" class="header">컨텍스트 압축</a>

<div class="table-wrapper">

| 파일 | 책임 | 관련 장 |
|----|----|----|
| `services/compact/compact.ts` | 압축 오케스트레이션, `POST_COMPACT_MAX_FILES_TO_RESTORE` | 9장, 10장 |
| `services/compact/autoCompact.ts` | 자동 압축 임계값 및 회로 차단기 | 9장, 25장, 26장 |
| `services/compact/prompt.ts` | 압축 프롬프트 템플릿 | 9장, 28장 |
| `services/compact/microCompact.ts` | 시간 기반 미세 압축 | 제11장 |
| `services/compact/apiMicrocompact.ts` | API 기반 캐시된 마이크로 압축 | 제11장 |

</div>

## <a href="#permissions-and-security" class="header">권한 및 보안</a>

<div class="table-wrapper">

| 파일 | 책임 | 관련 장 |
|----|----|----|
| `utils/permissions/yoloClassifier.ts` | YOLO 자동 모드 분류기 | 17장 |
| `utils/permissions/denialTracking.ts` | 거부 추적, `DENIAL_LIMITS` | 17, 27장 |
| `tools/BashTool/bashPermissions.ts` | Bash 명령 권한 확인 | 제16장 |

</div>

## <a href="#claudemd-and-skills" class="header">CLAUDE.md 및 기술</a>

<div class="table-wrapper">

| 파일 | 책임 | 관련 장 |
|----|----|----|
| `utils/claudemd.ts` | CLAUDE.md 로딩 및 주입, 4계층 우선순위 | 19장 |
| `skills/bundled/` | 내장된 기술 디렉토리 | 22장 |
| `skills/loadSkillsDir.ts` | 사용자 정의 스킬 발견 | 22장 |
| `skills/mcpSkillBuilders.ts` | MCP-스킬 브리지 | 22장 |

</div>

## <a href="#multi-agent-orchestration" class="header">다중 에이전트 오케스트레이션</a>

<div class="table-wrapper">

| 파일 | 책임 | 관련 장 |
|----|----|----|
| `coordinator/coordinatorMode.ts` | 코디네이터 모드 구현 | 제20장 |
| `utils/teammate.ts` | 팀원 에이전트 도구 | 제20장 |
| `utils/swarm/teammatePromptAddendum.ts` | 팀원 프롬프트 부록 콘텐츠 | 제20장 |

</div>

## <a href="#tool-results-and-storage" class="header">도구 결과 및 저장</a>

<div class="table-wrapper">

| 파일 | 책임 | 관련 장 |
|----|----|----|
| `utils/toolResultStorage.ts` | 큰 결과 지속성, 잘림 미리보기 | 12장, 28장 |
| `utils/toolSchemaCache.ts` | 도구 스키마 캐싱 | 제15장 |

</div>

## <a href="#cross-session-memory" class="header">교차 세션 메모리</a>

<div class="table-wrapper">

| 파일 | 책임 | 관련 장 |
|----|----|----|
| `memdir/memdir.ts` | MEMORY.md 인덱스 및 주제 파일 로딩, 시스템 프롬프트 삽입 | 24장 |
| `memdir/paths.ts` | 메모리 디렉터리 경로 확인, 3단계 우선 순위 체인 | 24장 |
| `services/extractMemories/extractMemories.ts` | Fork 에이전트 자동 메모리 추출 | 24장 |
| `services/SessionMemory/sessionMemory.ts` | 압축을 위한 롤링 세션 요약 | 24장 |
| `utils/sessionStorage.ts` | JSONL 세션 기록 저장 및 복구 | 24장 |
| `tools/AgentTool/agentMemory.ts` | 하위 에이전트 지속성 및 VCS 스냅샷 | 24장 |
| `services/autoDream/autoDream.ts` | 밤새 기억 통합 및 정리 | 24장 |

</div>

## <a href="#telemetry-and-observability" class="header">원격 측정 및 관찰 가능성</a>

<div class="table-wrapper">

| 파일 | 책임 | 관련 장 |
|----|----|----|
| `services/analytics/index.ts` | 이벤트 진입점, 대기열 연결 패턴, PII 태그 유형 | 29장 |
| `services/analytics/sink.ts` | 이중 경로 디스패치(Datadog + 1P), 샘플링 | 29장 |
| `services/analytics/firstPartyEventLogger.ts` | OTel BatchLogRecordProcessor 통합 | 29장 |
| `services/analytics/firstPartyEventLoggingExporter.ts` | 사용자 정의 내보내기, 디스크 영구 재시도 | 29장 |
| `services/analytics/metadata.ts` | 이벤트 메타데이터, 도구 이름 삭제, PII 등급 | 29장 |
| `services/analytics/datadog.ts` | Datadog 허용 목록, 일괄 플러시 | 29장 |
| `services/analytics/sinkKillswitch.ts` | 원격 회로 차단기(tengu_frond_boric) | 29장 |
| `services/api/logging.ts` | API 3가지 이벤트 모델(쿼리/성공/오류) | 29장 |
| `services/api/withRetry.ts` | 원격 측정, 게이트웨이 지문 감지 재시도 | 29장 |
| `utils/debug.ts` | 디버그 로깅, --debug 플래그 | 29장 |
| `utils/diagLogs.ts` | PII가 없는 컨테이너 진단 | 29장 |
| `utils/errorLogSink.ts` | 오류 파일 로깅 | 29장 |
| `utils/telemetry/sessionTracing.ts` | OTel 범위, 3단계 추적 | 29장 |
| `utils/telemetry/perfettoTracing.ts` | Perfetto 시각화 추적 | 29장 |
| `utils/gracefulShutdown.ts` | 계단식 시간 초과 단계적 종료 | 29장 |
| `cost-tracker.ts` | 비용 추적, 세션 간 지속성 | 29장 |

</div>

## <a href="#configuration-and-state" class="header">구성 및 상태</a>

<div class="table-wrapper">

| 파일 | 책임 | 관련 장 |
|----|----|----|
| `utils/effort.ts` | 노력 수준 구문 분석 | 21장 |
| `utils/fastMode.ts` | 빠른 모드 관리 | 21장 |
| `utils/managedEnvConstants.ts` | 관리형 환경 변수 허용 목록 | 부록 B |
| `screens/REPL.tsx` | 주요 대화형 인터페이스(5000개 이상의 라인 React 구성 요소) | 제1장 |

</div>
