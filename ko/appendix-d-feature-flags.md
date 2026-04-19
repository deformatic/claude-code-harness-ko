# <a href="#appendix-d-full-list-of-89-feature-flags"
class="header">부록 D: 89개 기능 플래그의 전체 목록</a>

이 부록에는 Claude Code v2.1.88 소스 코드의 `feature()` 함수를 통해 제어되는 모든 기능 플래그가 기능 도메인별로 분류되어 나열되어 있습니다. 참조 횟수는 각 플래그가 소스에 나타나는 빈도를 반영하여 구현 깊이를 대략적으로 나타냅니다(성숙도 추론 방법은 23장 참조).

## <a href="#autonomous-agent-and-background-execution-19"
class="header">자율 에이전트 및 백그라운드 실행 (19)</a>

<div class="table-wrapper">

| 깃발 | 참고자료 | 설명 |
|----|----|----|
| `AGENT_MEMORY_SNAPSHOT` | 2 | 에이전트 메모리 스냅샷 |
| `AGENT_TRIGGERS` | 11 | 예약된 트리거(로컬 크론) |
| `AGENT_TRIGGERS_REMOTE` | 2 | 원격 예약 트리거(클라우드 크론) |
| `BG_SESSIONS` | 11 | 백그라운드 세션 관리(ps/logs/attach/kill) |
| `BUDDY` | 15 | 버디 모드: 플로팅 UI 버블 |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 1 | 기본 제공 탐색/계획 에이전트 유형 |
| `COORDINATOR_MODE` | 32 | 코디네이터 모드: 에이전트 간 작업 조정 |
| `FORK_SUBAGENT` | 4 | 하위 에이전트 포크 실행 모드 |
| `KAIROS` | 84 | 보조자 모드 코어: 백그라운드 자동 에이전트, 틱 웨이크업 |
| `KAIROS_BRIEF` | 17 | 간략 모드: 사용자에게 진행 메시지 보내기 |
| `KAIROS_CHANNELS` | 13 | 채널 시스템: 다중 채널 통신 |
| `KAIROS_DREAM` | 1 | autoDream 메모리 통합 트리거 |
| `KAIROS_GITHUB_WEBHOOKS` | 2 | GitHub Webhook 구독: PR 이벤트 트리거 |
| `KAIROS_PUSH_NOTIFICATION` | 2 | 푸시 알림: 사용자에게 상태 업데이트를 보냅니다. |
| `MONITOR_TOOL` | 5 | 모니터 도구: 백그라운드 프로세스 모니터링 |
| `PROACTIVE` | 21 | 사전 예방 작업 모드: 최종 초점 인식, 사전 조치 |
| `TORCH` | 1 | 토치 명령 |
| `ULTRAPLAN` | 2 | Ultraplan: 구조화된 작업 분해 UI |
| `VERIFICATION_AGENT` | 4 | 검증대행 : 작업완료 상태를 자동으로 검증 |

</div>

## <a href="#remote-control-and-distributed-execution-10"
class="header">원격 제어 및 분산 실행 (10)</a>

<div class="table-wrapper">

| 깃발 | 참고자료 | 설명 |
|----|----|----|
| `BRIDGE_MODE` | 14 | 브리지 모드 코어: 원격 제어 프로토콜 |
| `CCR_AUTO_CONNECT` | 3 | Claude Code 원격 자동 연결 |
| `CCR_MIRROR` | 3 | CCR 미러 모드: 읽기 전용 원격 미러 |
| `CCR_REMOTE_SETUP` | 1 | CCR 원격 설정 명령 |
| `CONNECTOR_TEXT` | 7 | 커넥터 텍스트 블록 처리 |
| `DAEMON` | 1 | 데몬 모드: 백그라운드 데몬 작업자 |
| `DOWNLOAD_USER_SETTINGS` | 5 | 클라우드에서 사용자 설정 다운로드 |
| `LODESTONE` | 3 | 프로토콜 등록(lodestone:// 핸들러) |
| `UDS_INBOX` | 14 | Unix 도메인 소켓 받은 편지함 |
| `UPLOAD_USER_SETTINGS` | 1 | 클라우드에 사용자 설정 업로드 |

</div>

## <a href="#multimedia-and-interaction-17" class="header">멀티미디어 및 상호작용 (17)</a>

<div class="table-wrapper">

| 깃발 | 참고자료 | 설명 |
|----|----|----|
| `ALLOW_TEST_VERSIONS` | 2 | 테스트 버전 허용 |
| `ANTI_DISTILLATION_CC` | 1 | 증류 방지 보호 |
| `AUTO_THEME` | 1 | 자동 테마 전환 |
| `BUILDING_CLAUDE_APPS` | 1 | Claude Apps 스킬 구축 |
| `CHICAGO_MCP` | 12 | 컴퓨터 사용 MCP 통합 |
| `HISTORY_PICKER` | 1 | 기록 선택기 UI |
| `MESSAGE_ACTIONS` | 2 | 메시지 작업(바로가기 복사/편집) |
| `NATIVE_CLIENT_ATTESTATION` | 1 | 네이티브 클라이언트 증명 |
| `NATIVE_CLIPBOARD_IMAGE` | 2 | 기본 클립보드 이미지 지원 |
| `NEW_INIT` | 2 | 새로운 초기화 흐름 |
| `POWERSHELL_AUTO_MODE` | 2 | PowerShell 자동 모드 |
| `QUICK_SEARCH` | 1 | 빠른 검색 UI |
| `REVIEW_ARTIFACT` | 1 | 아티팩트 검토 |
| `TEMPLATES` | 5 | 작업 템플릿/분류 |
| `TERMINAL_PANEL` | 3 | 터미널 패널 |
| `VOICE_MODE` | 11 | 음성 모드: 음성을 텍스트로 스트리밍 |
| `WEB_BROWSER_TOOL` | 1 | 웹 브라우저 도구(Bun WebView) |

</div>

## <a href="#context-and-performance-optimization-16"
class="header">컨텍스트 및 성능 최적화 (16)</a>

<div class="table-wrapper">

| 깃발 | 참고자료 | 설명 |
|----|----|----|
| `ABLATION_BASELINE` | 1 | 절제 테스트 기준선 |
| `BASH_CLASSIFIER` | 33 | Bash 명령 분류자 |
| `BREAK_CACHE_COMMAND` | 2 | 강제 캐시 중단 명령 |
| `CACHED_MICROCOMPACT` | 12 | 캐시된 마이크로 압축 전략 |
| `COMPACTION_REMINDERS` | 1 | 압축 알림 메커니즘 |
| `CONTEXT_COLLAPSE` | 16 | 컨텍스트 축소: 세분화된 컨텍스트 관리 |
| `FILE_PERSISTENCE` | 3 | 파일 지속성 타이밍 |
| `HISTORY_SNIP` | 15 | 기록 캡처 명령 |
| `OVERFLOW_TEST_TOOL` | 2 | 오버플로 테스트 도구 |
| `PROMPT_CACHE_BREAK_DETECTION` | 9 | 신속한 캐시 중단 감지 |
| `REACTIVE_COMPACT` | 4 | 반응적 압축: 주문형 트리거링 |
| `STREAMLINED_OUTPUT` | 1 | 간소화된 출력 모드 |
| `TOKEN_BUDGET` | 4 | 토큰 예산 추적 UI |
| `TREE_SITTER_BASH` | 3 | Tree-sitter Bash 파서 |
| `TREE_SITTER_BASH_SHADOW` | 5 | 나무 시터 배쉬 그림자 모드(A/B) |
| `ULTRATHINK` | 1 | 울트라씽크 모드 |

</div>

## <a href="#memory-and-knowledge-management-13" class="header">기억과 지식 관리 (13)</a>

<div class="table-wrapper">

| 깃발 | 참고자료 | 설명 |
|----|----|----|
| `AWAY_SUMMARY` | 2 | 자리 비움 요약: 자리 비움 시 진행 상황 생성 |
| `COWORKER_TYPE_TELEMETRY` | 2 | 동료 유형 원격 측정 |
| `ENHANCED_TELEMETRY_BETA` | 2 | 향상된 원격 측정 베타 |
| `EXPERIMENTAL_SKILL_SEARCH` | 19 | 실험적인 원격 기술 검색 |
| `EXTRACT_MEMORIES` | 7 | 자동 메모리 추출 |
| `MCP_RICH_OUTPUT` | 3 | MCP 서식 있는 텍스트 출력 |
| `MCP_SKILLS` | 9 | MCP 서버 기술 발견 |
| `MEMORY_SHAPE_TELEMETRY` | 3 | 메모리 구조 원격 측정 |
| `RUN_SKILL_GENERATOR` | 1 | 스킬 생성기 |
| `SKILL_IMPROVEMENT` | 1 | 자동 스킬 향상 |
| `TEAMMEM` | 44 | 팀 메모리 동기화 |
| `WORKFLOW_SCRIPTS` | 6 | 워크플로 스크립트 |
| `TRANSCRIPT_CLASSIFIER` | 69 | 성적 증명서 분류기(자동 모드) |

</div>

## <a href="#infrastructure-and-telemetry-14" class="header">인프라 및 원격 측정 (14)</a>

<div class="table-wrapper">

| 깃발 | 참고자료 | 설명 |
|--------------------------|------------|-----------------------------------|
| `COMMIT_ATTRIBUTION` | 11 | Git 커밋 속성 추적 |
| `HARD_FAIL` | 2 | 심각한 오류 모드 |
| `IS_LIBC_GLIBC` | 1 | glibc 런타임 감지 |
| `IS_LIBC_MUSL` | 1 | musl 런타임 감지 |
| `PERFETTO_TRACING` | 1 | Perfetto 성능 추적 |
| `SHOT_STATS` | 8 | 도구 호출 분포 통계 |
| `SLOW_OPERATION_LOGGING` | 1 | 느린 작업 로깅 |
| `UNATTENDED_RETRY` | 1 | 무인 재시도 |

</div>

------------------------------------------------------------------------

## <a href="#statistical-summary" class="header">통계 요약</a>

<div class="table-wrapper">

| 범주 | 세다 | 최고 참조 플래그 |
|----|----|----|
| 자율 에이전트 및 백그라운드 실행 | 19 | 카이로스 (84) |
| 원격 제어 및 분산 실행 | 10 | BRIDGE_MODE(14), UDS_INBOX(14) |
| 멀티미디어와 상호작용 | 17 | CHICAGO_MCP (12) |
| 컨텍스트 및 성능 최적화 | 16 | TRANSCRIPT_CLASSIFIER (69) |
| 기억과 지식 관리 | 13 | 팀멤 (44) |
| 인프라 및 원격 측정 | 14 | COMMIT_ATTRIBUTION (11) |
| **총** | **89** |  |

</div>

**참조 수 기준 상위 5개**: KAIROS (84) \> TRANSCRIPT_CLASSIFIER (69) \> TEAMMEM (44) \> BASH_CLASSIFIER (33) \> COORDINATOR_MODE (32)
