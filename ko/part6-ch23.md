# <a
href="#chapter-23-the-unreleased-feature-pipeline----the-roadmap-behind-89-feature-flags"
class="header">23장: 출시되지 않은 기능 파이프라인 - 89개 기능 플래그 뒤에 있는 로드맵</a>

> **포지셔닝**: 이 장에서는 Claude Code 소스 코드의 89개 기능 플래그로 제어되는 미공개 기능 파이프라인과 그 구현 깊이를 분석합니다. 전제조건: 없음. 독립적으로 읽을 수 있습니다. 대상 독자: CC가 89 기능 플래그를 통해 아직 출시되지 않은 기능 파이프라인을 관리하는 방법을 이해하려는 독자 또는 자신의 제품에 기능 플래그 시스템을 구현하려는 개발자.

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

이전 22개 장에서는 Claude Code의 공개 기능을 분석했습니다. 그러나 소스 코드에는 또 다른 차원이 숨겨져 있습니다. **89 기능 플래그 아직 모든 사용자에게 공개되지 않은 게이트 기능**. 이러한 플래그는 Bun의 빌드 타임 `feature()` 함수를 통해 구현됩니다. 컴파일러는 다양한 빌드 구성에서 `feature('FLAG_NAME')`를 `true` 또는 `false`로 평가하고 데드 코드 제거를 통해 비활성화된 분기를 완전히 제거합니다.

이는 `feature('KAIROS')`에 의해 제어된 코드가 공개 빌드에 전혀 존재하지 않는다는 것을 의미합니다. 즉, 내부 빌드(`USER_TYPE === 'ant'`) 또는 실험적 분기에만 나타납니다. 그러나 복원된 소스 코드에서는 모든 플래그의 두 분기가 모두 보존되어 Claude Code의 기능 진화 방향을 조사할 수 있는 고유한 관점을 제공합니다.

이 장에서는 이러한 89개의 플래그를 기능 영역별로 5개의 주요 그룹으로 분류하고, 아직 출시되지 않은 핵심 기능의 구현 깊이와 상호 관계를 분석합니다. 강조해야 할 점: **이 장의 분석은 소스 코드에서 관찰 가능한 구현 상태를 기반으로 합니다. 우리는 비즈니스 전략을 추측하거나 릴리스 일정을 예측하지 않습니다.** 플래그의 존재는 임박한 기능 릴리스와 동일하지 않습니다. 많은 플래그는 실험적인 프로토타입, A/B 테스트 구성 또는 포기된 탐색 방향일 수 있습니다.

------------------------------------------------------------------------

## <a href="#231-feature-flag-mechanism" class="header">23.1 기능 플래그 메커니즘</a>

### <a href="#build-time-evaluation" class="header">빌드 시간 평가</a>

Claude Code는 Bun의 `bun:bundle` 모듈에서 제공하는 `feature()` 기능을 사용합니다.

``` typescript
import { feature } from 'bun:bundle'

if (feature('KAIROS')) {
  const { registerDreamSkill } = require('./dream.js')
  registerDreamSkill()
}
```

`feature()`는 빌드 시 리터럴 `true` 또는 `false`로 대체됩니다. 결과가 `false`이면 트리 쉐이킹 중에 전체 `if` 블록이 제거됩니다. 이는 게이트 코드가 `import()` 대신 `require()`를 사용하는 이유를 설명합니다. `require()`는 `if` 블록 내에 나타날 수 있는 표현식으로, 데드 코드 제거를 통해 모듈 종속성과 함께 이를 제거할 수 있습니다.

### <a href="#reference-counts-and-maturity-inference"
class="header">참조 횟수 및 성숙도 추론</a>

소스 코드에서 각 플래그의 참조를 계산하여 구현 깊이를 대략적으로 추론할 수 있습니다.

<div class="table-wrapper">

| 기준 범위 | 의미 | 일반적인 플래그 |
|----|----|----|
| 100+ | 심층 통합, 여러 핵심 하위 시스템에 접근 | 카이로스(154), TRANSCRIPT_CLASSIFIER(107) |
| 30-99 | 여러 모듈로 구성된 완벽한 기능 | TEAMMEM(51), VOICE_MODE(46), PROACTIVE(37) |
| 10-29 | 상당히 완전하며 특정 하위 시스템이 포함됩니다. | CONTEXT_COLLAPSE (20), CHICAGO_MCP (16) |
| 3-9 | 초기 구현 또는 제한된 범위 | TOKEN_BUDGET (9), WEB_BROWSER_TOOL (4) |
| 1-2 | 프로토타입/탐색 단계 또는 순수 토글 | 울트라씽크(1), ABLATION_BASELINE(1) |

</div>

**표 23-1: 기능 플래그 참조 횟수 및 성숙도 추론**

높은 참조 횟수가 반드시 "곧 출시될 예정"을 의미하는 것은 아닙니다. KAIROS의 154개 참조는 장기적으로 점진적인 통합을 진행 중인 복잡한 시스템임을 정확하게 나타낼 수 있습니다.

------------------------------------------------------------------------

## <a href="#232-all-89-flags-categorized" class="header">23.2 분류된 모든 89개 플래그</a>

기능 영역에 따라 89개 플래그는 5가지 주요 범주로 나눌 수 있습니다.

``` mermaid
graph TD
    ROOT["89 Feature Flags"] --> A["Autonomous Agent & Background\n18 flags"]
    ROOT --> B["Remote Control & Distributed Execution\n14 flags"]
    ROOT --> C["Context Management & Performance\n17 flags"]
    ROOT --> D["Memory & Knowledge Management\n9 flags"]
    ROOT --> E["UI/UX & Platform Capabilities\n31 flags"]

    A --> A1["KAIROS (154)"]
    A --> A2["COORDINATOR_MODE (32)"]
    A --> A3["PROACTIVE (37)"]

    B --> B1["BRIDGE_MODE (28)"]
    B --> B2["UDS_INBOX (17)"]

    C --> C1["TRANSCRIPT_CLASSIFIER (107)"]
    C --> C2["BASH_CLASSIFIER (45)"]

    D --> D1["TEAMMEM (51)"]
    D --> D2["EXPERIMENTAL_SKILL_SEARCH (21)"]

    E --> E1["VOICE_MODE (46)"]
    E --> E2["CHICAGO_MCP (16)"]

    style ROOT fill:#f9f,stroke:#333,stroke-width:2px
    style A fill:#e3f2fd
    style B fill:#e8f5e9
    style C fill:#fff3e0
    style D fill:#fce4ec
    style E fill:#f3e5f5
```

### <a href="#table-23-2-autonomous-agent--background-execution-18"
class="header">표 23-2: 자율 에이전트 &amp; 백그라운드 실행 (18)</a>

<div class="table-wrapper">

| 깃발 | 참조 | 설명 |
|----|----|----|
| `KAIROS` | 154 | 보조 모드 코어: 백그라운드 자율 에이전트, 틱 웨이크업 메커니즘 |
| `PROACTIVE` | 37 | 자율 작업 모드: 최종 초점 인식, 사전 조치 |
| `KAIROS_BRIEF` | 39 | 간략 모드: 사용자에게 진행 메시지 보내기 |
| `KAIROS_CHANNELS` | 19 | 채널 시스템: 다중 채널 통신 |
| `KAIROS_DREAM` | 1 | autoDream 메모리 통합 트리거 |
| `KAIROS_PUSH_NOTIFICATION` | 4 | 푸시 알림: 사용자에게 상태 업데이트를 보냅니다. |
| `KAIROS_GITHUB_WEBHOOKS` | 3 | GitHub Webhook 구독: PR 이벤트 트리거 |
| `AGENT_TRIGGERS` | 11 | 시간 제한 트리거(로컬 크론) |
| `AGENT_TRIGGERS_REMOTE` | 2 | 원격 시간 지정 트리거(클라우드 크론) |
| `BG_SESSIONS` | 11 | 백그라운드 세션 관리(ps/logs/attach/kill) |
| `COORDINATOR_MODE` | 32 | 코디네이터 모드: 에이전트 간 작업 조정 |
| `BUDDY` | 15 | 컴패니언 모드: 플로팅 UI 버블 |
| `ULTRAPLAN` | 10 | Ultraplan: 구조화된 작업 분해 UI |
| `VERIFICATION_AGENT` | 4 | 검증 에이전트: 작업 완료 자동 검증 |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 1 | 기본 제공 탐색/계획 에이전트 유형 |
| `FORK_SUBAGENT` | 4 | 하위 에이전트 포크 실행 모드 |
| `MONITOR_TOOL` | 13 | 모니터 도구: 백그라운드 프로세스 모니터링 |
| `TORCH` | 1 | 토치 명령(목적이 불분명함) |

</div>

### <a href="#table-23-3-remote-control--distributed-execution-14"
class="header">표 23-3: 원격 제어 및 앰프; 분산 실행 (14)</a>

<div class="table-wrapper">

| 깃발 | 참조 | 설명 |
|----|----|----|
| `BRIDGE_MODE` | 28 | 브리지 모드 코어: 원격 제어 프로토콜 |
| `DAEMON` | 3 | 데몬 모드: 백그라운드 데몬 작업자 |
| `SSH_REMOTE` | 4 | SSH 원격 연결 |
| `DIRECT_CONNECT` | 5 | 직접 연결 모드 |
| `CCR_AUTO_CONNECT` | 3 | Claude Code 원격 자동 연결 |
| `CCR_MIRROR` | 4 | CCR 미러 모드: 읽기 전용 원격 미러 |
| `CCR_REMOTE_SETUP` | 1 | CCR 원격 설정 명령 |
| `SELF_HOSTED_RUNNER` | 1 | 자체 호스팅 실행기 |
| `BYOC_ENVIRONMENT_RUNNER` | 1 | 자체 컴퓨팅 환경 실행자 |
| `UDS_INBOX` | 17 | Unix 도메인 소켓 받은 편지함: 프로세스 간 통신 |
| `LODESTONE` | 6 | 프로토콜 등록(lodestone:// 핸들러) |
| `CONNECTOR_TEXT` | 7 | 커넥터 텍스트 블록 처리 |
| `DOWNLOAD_USER_SETTINGS` | 5 | 클라우드에서 사용자 설정 다운로드 |
| `UPLOAD_USER_SETTINGS` | 2 | 클라우드에 사용자 설정 업로드 |

</div>

### <a href="#table-23-4-context-management--performance-17"
class="header">표 23-4: 컨텍스트 관리 &amp; 성능 (17)</a>

<div class="table-wrapper">

| 깃발 | 참조 | 설명 |
|----|----|----|
| `CONTEXT_COLLAPSE` | 20 | 컨텍스트 축소: 세분화된 컨텍스트 관리 |
| `REACTIVE_COMPACT` | 4 | 반응성 압축: 주문형 컴팩트 트리거 |
| `CACHED_MICROCOMPACT` | 12 | 캐시된 마이크로 압축 전략 |
| `COMPACTION_REMINDERS` | 1 | 압축 알림 메커니즘 |
| `TOKEN_BUDGET` | 9 | 토큰 예산 추적 UI 및 예산 관리 |
| `PROMPT_CACHE_BREAK_DETECTION` | 9 | 즉각적인 캐시 중단 감지 |
| `HISTORY_SNIP` | 15 | 기록 캡처 명령 |
| `BREAK_CACHE_COMMAND` | 2 | 강제 캐시 중단 명령 |
| `ULTRATHINK` | 1 | 울트라 사고 모드 |
| `TREE_SITTER_BASH` | 3 | Tree-sitter Bash 파서 |
| `TREE_SITTER_BASH_SHADOW` | 5 | Tree-sitter Bash 그림자 모드(A/B 테스트) |
| `BASH_CLASSIFIER` | 45 | Bash 명령 분류자 |
| `TRANSCRIPT_CLASSIFIER` | 107 | 성적 증명서 분류기(자동 모드) |
| `STREAMLINED_OUTPUT` | 1 | 간소화된 출력 모드 |
| `ABLATION_BASELINE` | 1 | 절제 실험 기준선 |
| `FILE_PERSISTENCE` | 3 | 파일 지속성 타이밍 |
| `OVERFLOW_TEST_TOOL` | 2 | 오버플로 테스트 도구 |

</div>

### <a href="#table-23-5-memory--knowledge-management-9"
class="header">표 23-5: 메모리 &amp; 지식경영 (9)</a>

<div class="table-wrapper">

| 깃발 | 참조 | 설명 |
|----|----|----|
| `TEAMMEM` | 51 | 팀 메모리 동기화 |
| `EXTRACT_MEMORIES` | 7 | 자동 메모리 추출 |
| `AGENT_MEMORY_SNAPSHOT` | 2 | 에이전트 메모리 스냅샷 |
| `AWAY_SUMMARY` | 2 | 자리 비움 요약: 사용자가 떠날 때 진행 상황 요약 생성 |
| `MEMORY_SHAPE_TELEMETRY` | 3 | 메모리 구조 원격 측정 |
| `SKILL_IMPROVEMENT` | 1 | 자동 스킬 개선(샘플링 후 후크) |
| `RUN_SKILL_GENERATOR` | 1 | 스킬 생성기 |
| `EXPERIMENTAL_SKILL_SEARCH` | 21 | 실험적인 원격 기술 검색 |
| `MCP_SKILLS` | 9 | MCP 서버 기술 발견 |

</div>

### <a href="#table-23-6-uiux--platform-capabilities-31"
class="header">표 23-6: UI/UX &amp; 플랫폼 기능 (31)</a>

<div class="table-wrapper">

| 깃발 | 참조 | 설명 |
|-----------------------------|------|---------------------------------------|
| `VOICE_MODE` | 46 | 음성 모드: 음성을 텍스트로 스트리밍 |
| `WEB_BROWSER_TOOL` | 4 | 웹 브라우저 도구(Bun WebView) |
| `TERMINAL_PANEL` | 4 | 터미널 패널 |
| `HISTORY_PICKER` | 4 | 기록 선택기 UI |
| `MESSAGE_ACTIONS` | 5 | 메시지 작업(바로가기 복사/편집) |
| `QUICK_SEARCH` | 5 | 빠른 검색 UI |
| `AUTO_THEME` | 2 | 자동 테마 전환 |
| `NATIVE_CLIPBOARD_IMAGE` | 2 | 기본 클립보드 이미지 지원 |
| `NATIVE_CLIENT_ATTESTATION` | 1 | 네이티브 클라이언트 증명 |
| `POWERSHELL_AUTO_MODE` | 2 | PowerShell 자동 모드 |
| `CHICAGO_MCP` | 16 | 컴퓨터 사용 MCP 통합 |
| `MCP_RICH_OUTPUT` | 3 | MCP 서식 있는 텍스트 출력 |
| `TEMPLATES` | 6 | 작업 템플릿/분류 |
| `WORKFLOW_SCRIPTS` | 10 | 워크플로 스크립트 |
| `REVIEW_ARTIFACT` | 4 | 아티팩트 검토 |
| `BUILDING_CLAUDE_APPS` | 1 | Claude Apps 스킬 구축 |
| `COMMIT_ATTRIBUTION` | 12 | Git 커밋 속성 추적 |
| `HOOK_PROMPTS` | 1 | 후크 프롬프트 |
| `NEW_INIT` | 2 | 새로운 초기화 흐름 |
| `HARD_FAIL` | 2 | 하드 장애 모드 |
| `SHOT_STATS` | 10 | 도구 호출 통계 분포 |
| `ANTI_DISTILLATION_CC` | 1 | 증류 방지 보호 |
| `COWORKER_TYPE_TELEMETRY` | 2 | 동료 유형 원격 측정 |
| `ENHANCED_TELEMETRY_BETA` | 2 | 향상된 원격 측정 베타 |
| `PERFETTO_TRACING` | 1 | Perfetto 성능 추적 |
| `SLOW_OPERATION_LOGGING` | 1 | 느린 작업 로깅 |
| `DUMP_SYSTEM_PROMPT` | 1 | 시스템 프롬프트 내보내기 |
| `ALLOW_TEST_VERSIONS` | 2 | 테스트 버전 허용 |
| `UNATTENDED_RETRY` | 1 | 무인 재시도 |
| `IS_LIBC_GLIBC` | 1 | glibc 런타임 감지 |
| `IS_LIBC_MUSL` | 1 | musl 런타임 감지 |

</div>

------------------------------------------------------------------------

## <a href="#233-deep-analysis-of-core-unreleased-features"
class="header">23.3 아직 출시되지 않은 핵심 기능에 대한 심층 분석</a>

### <a href="#kairos-background-autonomous-assistant" class="header">KAIROS: 백그라운드 자율 비서</a>

KAIROS는 가장 많이 참조되는 플래그(154회 발생)이며 코드 추적이 거의 모든 핵심 하위 시스템에 영향을 미칩니다. 소스 분석을 통해 다음 아키텍처를 재구성할 수 있습니다.

``` mermaid
graph TD
    AM["Assistant Module"] --> GATE["Gate Module\n(kairosGate)"]
    GATE --> ACTIVATE["Activation Path"]

    AM --> MODE["Assistant Mode\nIndependent session mode"]
    AM --> TICK["Tick Wakeup\nTimed wakeup"]
    AM --> BRIEF["Brief Tool\nBriefing/progress markers"]
    AM --> CH["Channels\nMulti-channel communication"]
    AM --> DREAM["Dream\nIdle memory consolidation"]
    AM --> PUSH["Push Notification\nStatus push"]
    AM --> GH["GitHub Webhooks\nPR event subscription"]

    TICK --> PRO["Proactive Module"]
    PRO --> CHECK{"terminalFocus?"}
    CHECK -->|"User not watching terminal"| AUTO["Agent autonomous execution"]
    CHECK -->|"User watching terminal"| WAIT["Wait for user input"]

    style AM fill:#e1f5fe,stroke:#333,stroke-width:2px
    style PRO fill:#fff3e0
    style AUTO fill:#c8e6c9
```

**그림 23-1: KAIROS 보조 모드 아키텍처 다이어그램**

KAIROS의 핵심 개념은 다음의 코드 패턴에서 유추할 수 있습니다.

**진입점**(`main.tsx:80-81`):

``` typescript
const assistantModule = feature('KAIROS')
  ? require('./assistant/index.js') as typeof import('./assistant/index.js')
  : null
const kairosGate = feature('KAIROS')
  ? require('./assistant/gate.js') as typeof import('./assistant/gate.js')
  : null
```

**틱 깨우기 메커니즘** (`REPL.tsx:2115, 2605, 2634, 2738`): KAIROS는 메시지 처리 후, 입력 유휴 중, 터미널 포커스 변경 시를 포함하여 여러 REPL 수명 주기 지점에서 "깨어나야" 하는지 여부를 확인합니다. 사용자가 터미널(`!terminalFocusRef.current`)을 떠나면 시스템이 대기 중인 작업을 자동으로 실행할 수 있습니다.

**간단한 도구 통합**(`main.tsx:2201`):

``` typescript
const briefVisibility = feature('KAIROS') || feature('KAIROS_BRIEF')
  ? isBriefEnabled()
    ? 'Call SendUserMessage at checkpoints to mark where things stand.'
    : 'The user will see any text you output.'
  : 'The user will see any text you output.'
```

브리프 모드가 활성화되면 시스템 프롬프트는 모든 중간 텍스트를 출력하는 대신 `SendUserMessage`를 사용하여 주요 체크포인트의 진행 상황을 보고하도록 모델에 지시합니다. 백그라운드 자율 실행을 위해 설계된 통신 패턴입니다.

**팀 컨텍스트**(`main.tsx:3035`):

``` typescript
teamContext: feature('KAIROS')
  ? assistantTeamContext ?? computeInitialTeamContext?.()
  : computeInitialTeamContext?.()
```

KAIROS는 "팀 컨텍스트" 개념을 도입합니다. 에이전트가 보조 모드로 실행될 때 더 큰 협업 그래프 내에서 자신의 위치를 ​​이해해야 합니다.

### <a href="#proactive-mode" class="header">사전 예방 모드</a>

PROACTIVE(37개 참조)는 KAIROS와 밀접하게 결합되어 있습니다. 소스 코드에서는 거의 항상 `feature('PROACTIVE') || feature('KAIROS')`(`REPL.tsx:194, 2115, 2605` 등)로 나타납니다. 이는 PROACTIVE가 KAIROS의 하위 기능 또는 이전 기능임을 의미합니다. 전체 KAIROS 보조 모드를 사용할 수 없는 경우 PROACTIVE는 더 가벼운 "선제적 작업" 기능을 제공합니다.

`REPL.tsx:2776`의 주요 동작 차이점은 다음과 같습니다.

``` typescript
...((feature('PROACTIVE') || feature('KAIROS'))
  && proactiveModule?.isProactiveActive()
  && !terminalFocusRef.current
  ? { /* autonomous execution config */ }
  : {})
```

조건 조합 `isProactiveActive() && !terminalFocusRef.current`는 핵심 메커니즘을 드러냅니다. **사용자가 터미널을 보고 있지 않고 사전 대응 모드가 활성화되면 에이전트는 자율 실행 권한을 얻습니다**. 이는 물리적 주의 신호를 기반으로 한 권한 에스컬레이션입니다. 즉, 사용자의 최종 초점 상태가 에이전트 자율성을 위한 게이팅 조건이 됩니다.

### <a href="#voice_mode-streaming-speech-to-text"
class="header">VOICE_MODE: 음성-텍스트 스트리밍</a>

VOICE_MODE(참조 46개)는 입력, 구성, 키 바인딩 및 서비스 레이어를 다룹니다.

**음성 STT 서비스** (`services/voiceStreamSTT.ts:3`):

``` typescript
// Only reachable in ant builds (gated by feature('VOICE_MODE') in useVoice.ts import).
```

**키 바인딩**(`keybindings/defaultBindings.ts:96`):

``` typescript
...(feature('VOICE_MODE') ? { space: 'voice:pushToTalk' } : {})
```

공간은 표준 음성 입력 상호 작용 패턴인 눌러서 말하기로 제한됩니다. 음성 통합에는 `useVoiceIntegration.tsx`: `useVoiceEnabled`, `useVoiceState`, `useVoiceInterimTranscript`의 여러 후크와 `startVoice`/`stopVoice`/`toggleVoice` 제어 기능이 포함됩니다.

**구성 통합**(`tools/ConfigTool/supportedSettings.ts:144`): 음성은 구성 가능한 설정으로 등록되어 `/config set voiceEnabled true`를 통해 활성화됩니다.

### <a href="#web_browser_tool-bun-webview" class="header">WEB_BROWSER_TOOL: Bun WebView</a>

WEB_BROWSER_TOOL(4개 참조)에는 몇 가지 핵심 구현 추적이 있습니다.

``` typescript
// main.tsx:1571
const hint = feature('WEB_BROWSER_TOOL')
  && typeof Bun !== 'undefined' && 'WebView' in Bun
  ? CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER
  : CLAUDE_IN_CHROME_SKILL_HINT
```

이는 기술 선택을 드러냅니다. 웹 브라우저 도구는 Playwright 또는 Puppeteer와 같은 외부 브라우저 자동화 도구가 아닌 **Bun의 내장 WebView**를 기반으로 합니다. 런타임 감지 `typeof Bun !== 'undefined' && 'WebView' in Bun`는 이것이 Bun의 아직 안정적이지 않은 WebView API에 달려 있음을 나타냅니다.

REPL(`REPL.tsx:272, 4585`)에서 WebBrowserTool에는 전체 화면 모드에서 기본 대화와 함께 표시될 수 있는 자체 패널 구성 요소 `WebBrowserPanel`가 있습니다.

### <a href="#bridge_mode--daemon-remote-control" class="header">BRIDGE_MODE + DAEMON: 원격 제어</a>

BRIDGE_MODE(28개 참조) 및 DAEMON(3개 참조)은 원격 제어를 위한 인프라를 형성합니다.

**진입점**(`entrypoints/cli.tsx:100-165`):

``` typescript
if (feature('DAEMON') && args[0] === '--daemon-worker') {
  // Start daemon worker
}
if (feature('BRIDGE_MODE') && (args[0] === 'remote-control' || args[0] === 'rc'
    || args[0] === 'remote' || args[0] === 'sync' || args[0] === 'bridge')) {
  // Start remote control/bridge
}
if (feature('DAEMON') && args[0] === 'daemon') {
  // Start daemon process
}
```

DAEMON은 `--daemon-worker` 백그라운드 작업자 프로세스와 `daemon` 관리 명령을 제공합니다. BRIDGE_MODE는 여러 하위 명령 별칭(`remote-control`, `rc`, `remote`, `sync`, `bridge`)을 제공합니다. 이 별칭의 풍부함은 팀이 여전히 사용자에게 가장 적합한 이름 지정을 모색하고 있음을 나타냅니다.

브리지 코어는 `bridge/bridgeEnabled.ts`에 있으며 여러 검사 기능을 제공합니다.

``` typescript
// bridge/bridgeEnabled.ts:32
return feature('BRIDGE_MODE')  // isBridgeEnabled

// bridge/bridgeEnabled.ts:51
return feature('BRIDGE_MODE')  // isBridgeOutboundEnabled

// bridge/bridgeEnabled.ts:127
return feature('BRIDGE_MODE')  // isRemoteControlEnabled
```

CCR_MIRROR(4개 참조)는 BRIDGE_MODE(읽기 전용 미러링)의 하위 모드로 제어 없이 원격 관찰이 가능합니다.

### <a href="#transcript_classifier-auto-mode"
class="header">TRANSCRIPT_CLASSIFIER: 자동 모드</a>

TRANSCRIPT_CLASSIFIER(107개 참조)는 두 번째로 많이 참조되는 플래그로, 새로운 권한 모드인 `auto`를 구현합니다.

``` typescript
// types/permissions.ts:35
...(feature('TRANSCRIPT_CLASSIFIER') ? (['auto'] as const) : ([] as const))
```

기존 `plan`(모든 도구 호출 확인)와 `auto-accept`(모두 자동 수락) 사이에 `auto` 모드는 **기록 분류**를 기반으로 중간 지점을 도입합니다. 시스템은 분류자를 사용하여 세션 콘텐츠를 분석하고 사용자 확인이 필요한지 여부를 동적으로 결정합니다.

`checkAndDisableAutoModeIfNeeded`(`REPL.tsx:2772`)는 자동 모드에 안전 저하 메커니즘이 있음을 제안합니다. 분류자가 위험한 작업을 감지하면 자동 모드를 종료하여 확인이 필요한 상태로 돌아갈 수 있습니다.

BASH_CLASSIFIER(45개 참조)는 특히 Bash 명령 분류 및 안전성 평가를 위한 TRANSCRIPT_CLASSIFIER의 관련 구성 요소입니다.

### <a href="#context_collapse-fine-grained-context-management"
class="header">CONTEXT_COLLAPSE: 세분화된 컨텍스트 관리</a>

CONTEXT_COLLAPSE(20개 참조)는 컴팩트 하위 시스템에 긴밀하게 통합되어 있습니다.

``` typescript
// services/compact/autoCompact.ts:179
if (feature('CONTEXT_COLLAPSE')) { ... }

// services/compact/autoCompact.ts:215
if (feature('CONTEXT_COLLAPSE')) { ... }
```

통합 지점에서 CONTEXT_COLLAPSE는 autoCompact, postCompactCleanup, sessionRestore 및 쿼리 엔진에 있습니다. 모델이 컨텍스트 창 상태를 적극적으로 검사하고 관리할 수 있도록 `CtxInspectTool`(`tools.ts:110`)를 도입합니다. 현재의 전체 압축과 달리 CONTEXT_COLLAPSE는 보다 세분화된 "축소" 의미 체계를 구현하여 다른 중요한 컨텍스트를 유지하면서 일부 도구 호출 결과를 선택적으로 축소합니다.

REACTIVE_COMPACT(4개 참조)는 또 다른 압축 실험입니다. 즉, 토큰 임계값을 기반으로 한 시간 초과 트리거가 아닌 반응형 트리거입니다.

### <a href="#teammem-team-memory-synchronization" class="header">TEAMMEM: 팀 메모리 동기화</a>

TEAMMEM(51개 참조)은 세션 간 팀 지식 동기화를 구현합니다.

``` typescript
// services/teamMemorySync/watcher.ts:253
if (!feature('TEAMMEM')) { return }
```

팀 메모리 시스템은 세 가지 핵심 구성 요소로 구성됩니다.

1. **감시자**(`teamMemorySync/watcher.ts`): 팀 메모리 파일의 변경 사항을 감시합니다.
2. **secretGuard** (`teamMemSecretGuard.ts`): 중요한 정보가 팀 메모리로 유출되는 것을 방지합니다.
3. **memdir 통합**(`memdir/memdir.ts`): 팀 메모리 계층을 memdir 경로 시스템에 통합합니다.

참조 패턴에서 TEAMMEM의 구현은 상당히 성숙되었습니다. 51개의 참조는 메모리 읽기/쓰기, 프롬프트 구성, 비밀 검색 및 파일 동기화의 전체 흐름을 포괄합니다.

------------------------------------------------------------------------

## <a href="#234-inferring-system-evolution-from-flag-clusters"
class="header">23.4 플래그 클러스터에서 시스템 진화 추론</a>

### <a href="#cluster-one-autonomous-agent-ecosystem" class="header">클러스터 1: 자율 에이전트 생태계</a>

KAIROS + PROACTIVE + KAIROS_BRIEF + KAIROS_CHANNELS + KAIROS_DREAM + KAIROS_PUSH_NOTIFICATION + KAIROS_GITHUB_WEBHOOKS + AGENT_TRIGGERS + AGENT_TRIGGERS_REMOTE + BG_SESSIONS + COORDINATOR_MODE + BUDDY + ULTRAPLAN + VERIFICATION_AGENT + MONITOR_TOOL

이는 가장 큰 플래그 클러스터(15+)이며 논리적 관계는 다음과 같이 재구성될 수 있습니다.

KAIROS (코어) │ ┌─────────────┼──────────────┐ │ │ │ PROACTIVE KAIROS_BRIEF KAIROS_DREAM (자율(브리핑(유휴 메모리 실행) 통신) 통합) │ │ │ ┌────┴────┐ │ │ │ │ CHANNELS PUSH_NOTIFICATION │ (다중(상태 │ 채널) 푸시) │ ┌────┴────┐ │ │ BG_SESSIONS AGENT_TRIGGERS(백그라운드(시간 제한 세션) 트리거) │ │ │ AGENT_TRIGGERS_REMOTE │(원격 트리거) │ COORDINATOR_MODE ── ULTRAPLAN(교차 에이전트(구조화된 조정) 계획) │ │ BUDDY VERIFICATION_AGENT(동반 UI)(자동 검증) │ MONITOR_TOOL(프로세스 모니터)

**그림 23-2: 자율 에이전트 플래그 클러스터 관계 다이어그램**

이 클러스터는 "사용자 입력에 수동적으로 응답"에서 "백그라운드에서 지속적으로 사전에 작업"하는 진화 경로를 설명합니다. KAIROS는 핵심 엔진이고, PROACTIVE는 초점 인식 자율성을 제공하고, AGENT_TRIGGERS는 시간에 따른 절전 모드 해제를 제공하고, BG_SESSIONS는 백그라운드 지속성을 제공하고, COORDINATOR_MODE는 다중 에이전트 오케스트레이션을 제공합니다.

### <a href="#cluster-two-remotedistributed-capabilities"
class="header">클러스터 2: 원격/분산 기능</a>

BRIDGE_MODE + DAEMON + SSH_REMOTE + DIRECT_CONNECT + CCR_AUTO_CONNECT + CCR_MIRROR + CCR_REMOTE_SETUP + SELF_HOSTED_RUNNER + BYOC_ENVIRONMENT_RUNNER + LODESTONE

이 클러스터는 "사용자 컴퓨터 외부 환경에서 Claude Code 실행"을 중심으로 진행됩니다.

<div class="table-wrapper">

| 역량 계층 | 플래그 | 설명 |
|----|----|----|
| 규약 | 천연 자석 | `lodestone://` 프로토콜 핸들러 등록 |
| 수송 | BRIDGE_MODE, UDS_INBOX | WebSocket 브리지 + Unix 소켓 IPC |
| 연결 | SSH_REMOTE, DIRECT_CONNECT | 두 가지 액세스 방법으로 SSH 및 직접 연결 |
| 관리 | CCR_AUTO_CONNECT, CCR_MIRROR | 자동 연결, 읽기 전용 미러 |
| 실행 | 데몬, SELF_HOSTED_RUNNER, BYOC | 데몬, 자체 호스팅, BYOC 실행기 |
| 동조 | 다운로드/UPLOAD_USER_SETTINGS | 클라우드 구성 동기화 |

</div>

**표 23-7: 원격/분산 기능 계층**

### <a href="#cluster-three-context-intelligence" class="header">클러스터 3: 컨텍스트 인텔리전스</a>

CONTEXT_COLLAPSE + REACTIVE_COMPACT + CACHED_MICROCOMPACT + COMPACTION_REMINDERS + TOKEN_BUDGET + PROMPT_CACHE_BREAK_DETECTION + HISTORY_SNIP

이러한 플래그는 컨텍스트 관리의 지속적인 최적화를 설명합니다. 9-12장에서 분석된 기존 압축 메커니즘과 비교하여 이러한 플래그는 차세대 컨텍스트 관리를 나타냅니다.

- **시간적 압축에서 반응형 압축으로** (REACTIVE_COMPACT)
- **완전 압축에서 선택적 축소까지**(CONTEXT_COLLAPSE)
- **패시브에서 액티브 캐시 관리로** (PROMPT_CACHE_BREAK_DETECTION)
- **암시적 예산 통제에서 명시적 예산 통제까지**(TOKEN_BUDGET)

### <a href="#cluster-four-security-classification-and-permissions"
class="header">클러스터 4: 보안 분류 및 권한</a>

TRANSCRIPT_CLASSIFIER + BASH_CLASSIFIER + ANTI_DISTILLATION_CC + NATIVE_CLIENT_ATTESTATION + HARD_FAIL

이 클러스터는 "보다 세부적인 보안 제어"를 중심으로 진행됩니다. TRANSCRIPT_CLASSIFIER의 `auto` 모드는 중요한 방향입니다. 이는 "바이너리 권한"(모두 확인 또는 모두 수락)에서 "지능형 권한"(콘텐츠 분석을 기반으로 한 동적 결정)으로의 전환을 나타냅니다. ANTI_DISTILLATION_CC는 모델 출력에 대한 지적 재산 보호 메커니즘을 암시합니다.

------------------------------------------------------------------------

## <a href="#235-flag-maturity-spectrum" class="header">23.5 플래그 성숙도 스펙트럼</a>

Refs 플래그 개수 성숙 단계 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100+ 2 심층 통합 ██ 30-99 6 전체 위빙 ██████ 10-29 12 모듈 통합 ████████████ 3-9 27 초기 구현 ███████████████████████████ 1-2 42 프로토타입/탐색 ██████████████████████████████████████████

**그림 23-3: 89개 플래그의 성숙도 분포**

분포는 명확한 **긴 꼬리**를 보여줍니다. 플래그 중 47%(42개)는 프로토타입 또는 순수 토글 단계에서 1-2개의 참조만 가집니다. 2개의 플래그만이 100개 이상의 심층 통합에 도달했습니다. 이는 소프트웨어 제품의 일반적인 기능 유입 경로와 일치합니다. 많은 탐색 실험 중에서 최종적으로 핵심 기능이 되는 것은 소수에 불과합니다.

참조 횟수와 **모듈 간 배포** 간의 차이점을 주목할 가치가 있습니다. KAIROS의 154개 참조는 `main.tsx`, `REPL.tsx`, `commands.ts`, `prompts.ts`, `print.ts`, `sessionStorage.ts`를 포함하여 최소 15개 파일에 분산되어 있습니다. 이러한 광범위한 통합은 KAIROS를 활성화하려면 시스템의 여러 측면을 다루어야 함을 의미합니다. 이와 대조적으로 TEAMMEM의 51개 참조는 주로 `memdir/`, `teamMemorySync/` 및 `services/mcp/`에 집중되어 있습니다. 이 현지화된 통합은 독립적으로 활성화하고 테스트하기가 더 쉽습니다.

------------------------------------------------------------------------

## <a href="#236-build-configuration-inference" class="header">23.6 빌드 구성 추론</a>

플래그 게이팅 패턴에서 최소한 세 가지 빌드 구성을 유추할 수 있습니다.

### <a href="#public-build" class="header">공개 빌드</a>

대부분의 플래그는 `false`입니다. 공개적으로 활성화된 것으로 알려진 기능(기본 기술 시스템, 도구 체인)에는 플래그 게이팅이 필요하지 않습니다. 이는 소스 코드의 "기본 경로"입니다.

### <a href="#internal-build-ant-build" class="header">내부 빌드(Ant 빌드)</a>

`USER_TYPE === 'ant'` 검사는 여러 기술 등록 논리(`verify.ts:13`, `remember.ts:5`, `stuck.ts` 등)에 나타납니다. 내부 빌드를 통해 EXPERIMENTAL_SKILL_SEARCH, SKILL_IMPROVEMENT 등을 포함한 더 실험적인 기능을 사용할 수 있습니다.

### <a href="#experiment-build" class="header">실험 빌드</a>

특정 플래그 조합은 A/B 테스트 구성을 나타낼 수 있습니다. TREE_SITTER_BASH 및 TREE_SITTER_BASH_SHADOW 이름 지정 패턴은 "섀도우 모드" 실험을 제안합니다. ABLATION_BASELINE은 절제 실험 기준선 구성을 명시적으로 식별합니다.

------------------------------------------------------------------------

## <a href="#237-dependencies-between-unreleased-features"
class="header">23.7 출시되지 않은 기능 간의 종속성</a>

일부 플래그에는 코드의 `&&` 조합에서 추론할 수 있는 암시적 종속성이 있습니다.

``` typescript
// commands.ts:77
feature('DAEMON') && feature('BRIDGE_MODE')  // daemon depends on bridge

// skills/bundled/index.ts:35
feature('KAIROS') || feature('KAIROS_DREAM')  // dream can be independent of full KAIROS

// main.tsx:1728
(feature('KAIROS') || feature('KAIROS_BRIEF')) && baseTools.length > 0

// main.tsx:2184
(feature('KAIROS') || feature('KAIROS_BRIEF'))
  && !getIsNonInteractiveSession()
  && !getUserMsgOptIn()
  && getInitialSettings().defaultView === 'chat'
```

주요 종속 관계:

**표 23-8: 주요 플래그 간 종속성**

<div class="table-wrapper">

| 매달린 | 의존 | 관계 |
|----|----|----|
| 악마 | BRIDGE_MODE | 공동 활성화되어야 함 |
| 카이로스_DREAM | 카이로스 | 독립적일 수 있지만 일반적으로 공존할 수 있음 |
| KAIROS_BRIEF | 카이로스 | 독립적으로 활성화 가능 |
| KAIROS_CHANNELS | 카이로스 | 보통 공존 |
| CCR_MIRROR | BRIDGE_MODE | CCR_MIRROR는 BRIDGE의 하위 모드입니다. |
| CCR_AUTO_CONNECT | BRIDGE_MODE | 브리지 인프라 필요 |
| AGENT_TRIGGERS_REMOTE | AGENT_TRIGGERS | 원격 확장 로컬 |
| MCP_SKILLS | MCP 인프라 | 기존 MCP 클라이언트 확장 |

</div>

------------------------------------------------------------------------

## <a href="#238-impact-on-existing-architecture" class="header">23.8 기존 아키텍처에 미치는 영향</a>

이러한 89개 플래그가 기존 아키텍처에 미치는 영향은 여러 수준에서 이해할 수 있습니다.

### <a href="#context-management-layer" class="header">컨텍스트 관리 계층</a>

CONTEXT_COLLAPSE 및 REACTIVE_COMPACT는 9-11장에서 분석한 압축 메커니즘을 변경합니다. 토큰 임계값을 기반으로 하는 현재 autoCompact의 시간 제한 검사는 보다 세부적인 반응 전략으로 대체될 수 있습니다. 즉, 전체 토큰 수가 임계값을 초과할 때까지 기다리지 않고 도구 호출이 많은 양의 결과를 반환할 때 즉시 지역화된 축소를 트리거합니다.

### <a href="#permission-layer" class="header">권한 계층</a>

TRANSCRIPT_CLASSIFIER의 자동 모드는 권한 시스템의 패러다임 전환을 나타냅니다. 현재 이진 모델(계획 대 자동 수락)은 자동 모드에서 ML 분류자를 사용하여 각 작업의 위험 수준을 실시간으로 평가하는 삼진 모델로 발전할 수 있습니다.

### <a href="#tool-layer" class="header">도구 레이어</a>

WEB_BROWSER_TOOL, TERMINAL_PANEL 및 MONITOR_TOOL과 같은 새로운 도구는 에이전트의 인식 및 작업 기능을 확장합니다. 특히 Bun WebView에 대한 WEB_BROWSER_TOOL의 종속성은 브라우저 기능이 Playwright와 같은 외부 프로세스를 통해 구현되는 대신 기본적으로 통합된다는 것을 의미합니다.

### <a href="#execution-model-layer" class="header">실행 모델 계층</a>

KAIROS + DAEMON + BRIDGE_MODE는 집합적으로 "지속적인 백그라운드 실행" 모델을 가리킵니다. Claude Code는 더 이상 단순한 대화형 REPL이 아니라 백그라운드에서 데몬으로 지속적으로 작동하고 Bridge를 통해 원격으로 제어되며 푸시 알림을 통해 진행 상황을 보고할 수 있습니다.

------------------------------------------------------------------------

## <a href="#239-summary" class="header">23.9 요약</a>

89개의 기능 플래그는 현재 공개된 기능을 훨씬 뛰어넘는 Claude Code의 엔지니어링 깊이를 보여줍니다. 기능 영역별:

- **자율 에이전트 생태계**(18개 플래그): KAIROS를 핵심으로 백그라운드 자율 실행, 시간 제한 트리거 및 다중 에이전트 조정을 위한 완전한 기능 스택 구축
- **원격/분산 실행**(14개 플래그): 브리지 + 데몬 + SSH/직접 연결, 시스템 간 원격 제어 및 분산 실행 가능
- **컨텍스트 관리 최적화**(17개 플래그): 시간 제한이 있는 전체 압축에서 반응형 선택적 축소로의 발전
- **메모리 및 지식 관리**(9 플래그): 팀 메모리 동기화, 자동 메모리 추출, 스킬 자기 향상
- **UI/UX 및 플랫폼 기능**(31개 플래그): 음성 입력, 브라우저 통합, 터미널 패널 및 기타 새로운 상호 작용 양식

성숙도 분포에서 KAIROS(154개 참조)와 TRANSCRIPT_CLASSIFIER(107개 참조)는 가장 깊이 통합된 두 시스템입니다. 이들의 코드 추적은 Claude Code의 핵심 아키텍처에 깊숙이 침투했습니다. 한편, 1~2개의 참조만 있는 42개의 플래그는 수많은 탐색적 실험을 나타내며, 그 중 대부분은 결코 공개 기능이 되지 않을 것입니다.

이러한 플래그는 "대화형 코딩 보조자"에서 "백그라운드 자율 개발 에이전트"로 발전하기 위한 Claude Code의 엔지니어링 준비를 전체적으로 보여줍니다. 그러나 소스 코드에 존재한다고 해서 제품 계획과 동일하지는 않습니다. 기능 플래그의 핵심은 팀이 모든 실험을 제품으로 만들지 않고도 안전하게 탐색하고 실험할 수 있도록 하는 것입니다.

------------------------------------------------------------------------

## <a href="#pattern-distillation" class="header">패턴 증류</a>

**패턴 1: 빌드 시 데드 코드 제거**

- **문제 해결**: 실험 코드는 프로덕션 빌드에 표시되지 않아야 합니다.
- **패턴**: `feature('FLAG')`는 컴파일 타임에 리터럴 `true`/`false`로 대체되고, `if (false) { require(...) }` 전체 분기 및 트리 쉐이킹으로 종속성이 제거됩니다.
- **전제 조건**: 빌드 도구는 컴파일 시간 상수 대체 및 데드 코드 제거를 지원합니다.

**패턴 2: 참조 횟수 성숙도 추론**

- **해결된 문제**: 대규모 코드베이스에서 실험적 기능의 통합 깊이 평가
- **패턴**: 소스 및 해당 모듈 간 배포의 플래그 참조 개수 -- 100개 이상의 참조는 심층 통합을 의미하고 1-2는 프로토타입 단계를 의미합니다.
- **전제 조건**: 통합 API를 통한 일관된 플래그 이름 지정 및 액세스

**패턴 3: 플래그 클러스터 종속성 관리**

- **문제 해결됨**: 관련 기능 간의 순서 지정 및 종속성 관계 활성화
- **패턴**: `feature('A') && feature('B')`를 통해 하드 종속성을 표현하고 `feature('A') || feature('B')`를 통해 소프트 연관을 표현합니다. 하위 기능은 상위 기능과 독립적일 수 있습니다(예: `KAIROS_DREAM`는 전체 `KAIROS`와 독립적일 수 있음).
- **전제 조건**: 기능 간에 계층적 종속 관계가 존재합니다.

------------------------------------------------------------------------

## <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

**Claude 코드를 더 잘 사용하기 위한 기능 플래그 이해:**

1. **사용 가능한 실험적 기능을 확인하세요.** 일부 플래그는 환경 변수를 통해 사용자에게 노출됩니다. 예를 들어 `CLAUDE_CODE_COORDINATOR_MODE`는 코디네이터 모드를 제어합니다. 환경 변수를 통해 어떤 실험적 기능을 활성화할 수 있는지 알아보려면 공식 문서를 참조하세요.

2. **빌드 버전 차이점을 이해하세요.** 공개, 내부(`USER_TYPE=ant`) 및 실험용 빌드에는 서로 다른 기능 세트가 있습니다. 엔터프라이즈 또는 내부 빌드를 사용하는 경우 더 많은 기능을 사용할 수 있습니다(예: `verify`, `remember`, `stuck` 및 기타 기술).

3. **KAIROS 관련 어시스턴트 모드를 살펴보세요.** KAIROS는 가장 많이 참조된 플래그(154개 참조)로, Claude Code가 "백그라운드 자율 에이전트"로의 진화를 나타냅니다. 이러한 기능이 점진적으로 공개되면 터미널 초점 인식, 시간에 따른 절전 모드 해제 및 브리핑 통신 메커니즘을 이해하면 이러한 기능을 더 잘 활용하는 데 도움이 됩니다.

4. **자동 권한 모드의 출현에 유의하세요.** TRANSCRIPT_CLASSIFIER의 `auto` 권한 모드는 `plan`(모두 확인)와 `auto-accept`(모두 수락) 사이의 현명한 중간 지점입니다. 공개적으로 사용 가능한 경우 대부분의 사용자에게 가장 적합한 기본 선택이 될 수 있습니다.

5. **플래그 존재가 기능 약속과 동일하지 않다는 점을 이해하십시오.** 89개 플래그 중 47%는 프로토타입 단계에서 1~2개의 참조만 가지고 있습니다. 소스 코드의 플래그 존재에 대한 기능 기대치를 기반으로 하지 마십시오. 플래그의 본질은 팀이 안전하게 탐색하고 실험할 수 있도록 하는 것입니다.

------------------------------------------------------------------------

## <a href="#23x-feature-flag-lifecycle" class="header">23.x 기능 플래그 수명 주기</a>

89개 기능 플래그는 정적 목록이 아닙니다. 명확한 수명 주기 단계가 있습니다. v2.1.88에서 v2.1.91 비교:

### <a href="#four-stage-lifecycle" class="header">4단계 수명주기</a>

``` mermaid
graph LR
    A[Experiment<br/>tengu_xxx created] --> B[Gradual Rollout<br/>GrowthBook %]
    B --> C[Full Rollout<br/>Code hardcoded true]
    C --> D[Deprecated<br/>Flag removed]
```

<div class="table-wrapper">

| 단계 | 형질 | v2.1.88-\>v2.1.91 예 |
|----|----|----|
| **실험** | `feature('FLAG_NAME')`는 코드 블록을 보호합니다. | `TREE_SITTER_BASH_SHADOW`(섀도우 테스트 AST 구문 분석) |
| **점진적 출시** | GrowthBook 서버는 롤아웃 %를 제어합니다. | `ULTRAPLAN`(원격 계획, 구독 수준별로 열림) |
| **전체 출시** | `feature()` 호출 DCE'd 또는 하드코드된 true | `TRANSCRIPT_CLASSIFIER`(v2.1.91 자동 모드 공개는 전체 출시를 제안함) |
| **지원 중단됨** | 플래그 및 관련 코드가 함께 제거됨 | `TREE_SITTER_BASH`(v2.1.91 제거된 tree-sitter) |

</div>

### <a href="#growthbook-dynamic-evaluation" class="header">GrowthBook 동적 평가</a>

기능 플래그는 GrowthBook SDK(`restored-src/src/utils/growthbook.ts`)를 통해 런타임에 평가됩니다.

``` typescript
// Two read modes
feature('FLAG_NAME')                    // Synchronous, uses local cache
getFeatureValue_CACHED_MAY_BE_STALE(    // Async, explicitly marked potentially stale
  'tengu_config_name', defaultValue
)
```

`_CACHED_MAY_BE_STALE` 접미사는 의도적인 명명 설계로, 호출자에게 값이 최신이 아닐 수 있으며 강력한 일관성이 필요한 결정에 사용되어서는 안 된다는 점을 상기시킵니다. CC는 Ultraplan의 모델 선택(`getUltraplanModel()`) 및 이벤트 샘플링 속도(`shouldSampleEvent()`)에서 이 패턴을 사용합니다.

### <a href="#v2191-change-comparison" class="header">v2.1.91 변경사항 비교</a>

<div class="table-wrapper">

| 깃발 | v2.1.88 상태 | v2.1.91 상태 | 스테이지 체인지 |
|----|----|----|----|
| `TREE_SITTER_BASH` | 실험(기능 게이트) | 제거됨 | 실험 -\> 더 이상 사용되지 않음 |
| `TREE_SITTER_BASH_SHADOW` | 점진적(섀도우 테스트) | 제거됨 | 점진적 -\> 더 이상 사용되지 않음 |
| `ULTRAPLAN` | 실험/점진적 | 점진적(+5개의 새로운 원격 측정 이벤트) | 점진적으로 계속됨 |
| `TRANSCRIPT_CLASSIFIER` | 점진적 | 아마도 전체(자동 모드 공개) | 점진적 -\> 전체? |
| `TEAMMEM` | 점진적 | 점진적(`TENGU_HERRING_CLOCK`) | 점진적으로 계속됨 |

</div>

### <a href="#version-tracking-method" class="header">버전 추적 방법</a>

소스 맵이 없으면 `scripts/extract-signals.sh`를 통해 GrowthBook 구성 이름 변경 사항을 추출하면 플래그 수명 주기를 간접적으로 추론할 수 있습니다. 새 구성 이름 = 새 실험, 사라진 구성 이름 = 실험 종료. 자세한 내용은 부록 E 및 `docs/reverse-engineering-guide.md`를 참조하세요.
