# <a href="#appendix-b-environment-variable-reference"
class="header">부록 B: 환경 변수 참조</a>

이 부록에는 Claude Code v2.1.88의 주요 사용자 구성 가능 환경 변수가 나열되어 있습니다. 기능 영역별로 그룹화되어 사용자에게 보이는 동작에 영향을 미치는 변수만 나열됩니다. 내부 원격 측정 및 플랫폼 감지 변수는 생략됩니다.

## <a href="#context-compaction" class="header">컨텍스트 압축</a>

<div class="table-wrapper">

| 변하기 쉬운 | 효과 | 기본 |
|----|----|----|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 컨텍스트 창 크기(토큰) 재정의 | 모델 기본값 |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 자동 압축 임계값을 백분율(0-100)로 재정의합니다. | 계산된 값 |
| `DISABLE_AUTO_COMPACT` | 자동 압축을 완전히 비활성화합니다. | `false` |

</div>

## <a href="#effort-and-reasoning" class="header">노력과 추론</a>

<div class="table-wrapper">

| 변하기 쉬운 | 효과 | 유효한 값 |
|----|----|----|
| `CLAUDE_CODE_EFFORT_LEVEL` | 노력 수준 재정의 | `low`, `medium`, `high`, `max`, `auto`, `unset` |
| `CLAUDE_CODE_DISABLE_FAST_MODE` | 고속 모드 가속 출력 비활성화 | `true`/`false` |
| `DISABLE_INTERLEAVED_THINKING` | 확장된 사고 비활성화 | `true`/`false` |
| `MAX_THINKING_TOKENS` | 사고 토큰 제한 무시 | 모델 기본값 |

</div>

## <a href="#tools-and-output-limits" class="header">도구 및 출력 제한</a>

<div class="table-wrapper">

| 변하기 쉬운 | 효과 | 기본 |
|----|----|----|
| `BASH_MAX_OUTPUT_LENGTH` | Bash 명령의 최대 출력 문자 | 8,000 |
| `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS` | Glob 검색 시간 초과(초) | 기본 |

</div>

## <a href="#permissions-and-security" class="header">권한 및 보안</a>

<div class="table-wrapper">

| 변하기 쉬운 | 효과 | 메모 |
|----|----|----|
| `CLAUDE_CODE_DUMP_AUTO_MODE` | YOLO 분류기 요청/응답 내보내기 | 디버그 전용 |
| `CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK` | Bash 명령 삽입 감지 비활성화 | 보안 감소 |

</div>

## <a href="#api-and-authentication" class="header">API 및 인증</a>

<div class="table-wrapper">

| 변하기 쉬운 | 효과 | 보안 수준 |
|----|----|----|
| `ANTHROPIC_API_KEY` | Anthropic API 인증키 | 신임장 |
| `ANTHROPIC_BASE_URL` | 사용자 정의 API 엔드포인트(프록시 지원) | 리디렉션 가능 |
| `ANTHROPIC_MODEL` | 기본 모델 재정의 | 안전한 |
| `CLAUDE_CODE_USE_BEDROCK` | AWS Bedrock을 통한 경로 추론 | 안전한 |
| `CLAUDE_CODE_USE_VERTEX` | Google Vertex AI를 통한 경로 추론 | 안전한 |
| `CLAUDE_CODE_EXTRA_BODY` | API 요청에 추가 필드 추가 | 고급 사용 |
| `ANTHROPIC_CUSTOM_HEADERS` | 사용자 정의 HTTP 요청 헤더 | 안전한 |

</div>

## <a href="#model-selection" class="header">모델 선택</a>

<div class="table-wrapper">

| 변하기 쉬운 | 효과 | 예 |
|----|----|----|
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | 맞춤 하이쿠 모델 ID | 모델 문자열 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | 사용자 정의 Sonnet 모델 ID | 모델 문자열 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | 맞춤 Opus 모델 ID | 모델 문자열 |
| `ANTHROPIC_SMALL_FAST_MODEL` | 빠른 추론 모델(예: 요약용) | 모델 문자열 |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 하위 에이전트가 사용하는 모델 | 모델 문자열 |

</div>

## <a href="#prompt-caching" class="header">프롬프트 캐싱</a>

<div class="table-wrapper">

| 변하기 쉬운 | 효과 | 기본 |
|----|----|----|
| `CLAUDE_CODE_ENABLE_PROMPT_CACHING` | 프롬프트 캐싱 활성화 | `true` |
| `DISABLE_PROMPT_CACHING` | 프롬프트 캐싱을 완전히 비활성화합니다. | `false` |

</div>

## <a href="#session-and-debugging" class="header">세션 및 디버깅</a>

<div class="table-wrapper">

| 변하기 쉬운 | 효과 | 목적 |
|----|----|----|
| `CLAUDE_CODE_DEBUG_LOG_LEVEL` | 로그의 자세한 정도 | `silent`/`error`/`warn`/`info`/`verbose` |
| `CLAUDE_CODE_PROFILE_STARTUP` | 시작 성능 프로파일링 활성화 | 디버그 |
| `CLAUDE_CODE_PROFILE_QUERY` | 쿼리 파이프라인 프로파일링 활성화 | 디버그 |
| `CLAUDE_CODE_JSONL_TRANSCRIPT` | 세션 기록을 JSONL로 작성 | 파일 경로 |
| `CLAUDE_CODE_TMPDIR` | 임시 디렉터리 재정의 | 길 |

</div>

## <a href="#output-and-formatting" class="header">출력 및 포맷</a>

<div class="table-wrapper">

| 변하기 쉬운 | 효과 | 기본 |
|----|----|----|
| `CLAUDE_CODE_SIMPLE` | 최소 시스템 프롬프트 모드 | `false` |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | 터미널 제목 설정 비활성화 | `false` |
| `CLAUDE_CODE_NO_FLICKER` | 전체 화면 모드 깜박임을 줄입니다. | `false` |

</div>

## <a href="#mcp-model-context-protocol" class="header">MCP(모델 컨텍스트 프로토콜)</a>

<div class="table-wrapper">

| 변하기 쉬운 | 효과 | 기본 |
|-------------------------|------------------------------------|---------|
| `MCP_TIMEOUT` | MCP 서버 연결 시간 초과(ms) | 10,000 |
| `MCP_TOOL_TIMEOUT` | MCP 도구 호출 시간 초과(ms) | 30,000 |
| `MAX_MCP_OUTPUT_TOKENS` | MCP 도구 출력 토큰 제한 | 기본 |

</div>

## <a href="#network-and-proxy" class="header">네트워크 및 프록시</a>

<div class="table-wrapper">

| 변하기 쉬운 | 효과 | 메모 |
|------------------------------|----------------------------|-------------------|
| `HTTP_PROXY` / `HTTPS_PROXY` | HTTP/HTTPS 프록시 | 리디렉션 가능 |
| `NO_PROXY` | 프록시를 우회할 호스트 목록 | 안전한 |
| `NODE_EXTRA_CA_CERTS` | 추가 CA 인증서 | TLS 신뢰에 영향을 미칩니다 |

</div>

## <a href="#paths-and-configuration" class="header">경로 및 구성</a>

<div class="table-wrapper">

| 변하기 쉬운 | 효과 | 기본 |
|---------------------|-----------------------------------------|-------------|
| `CLAUDE_CONFIG_DIR` | Claude 구성 디렉터리 재정의 | `~/.claude` |

</div>

------------------------------------------------------------------------

## <a href="#version-evolution-v2191-new-variables" class="header">버전 발전: v2.1.91 새로운 변수</a>

<div class="table-wrapper">

| 변하기 쉬운 | 효과 | 메모 |
|----|----|----|
| `CLAUDE_CODE_AGENT_COST_STEER` | 하위 에이전트 비용 조정 | 다중 에이전트 시나리오에서 리소스 소비를 제어합니다. |
| `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` | 세션 재개 시간 기준 | 세션 재개를 위한 시간 창을 제어합니다. |
| `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` | 세션 재개 토큰 임계값 | 세션 재개를 위한 토큰 예산을 제어합니다. |
| `CLAUDE_CODE_USE_ANTHROPIC_AWS` | AWS 인증 경로 | Anthropic AWS 인프라 인증을 활성화합니다. |
| `CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH` | AWS 인증 건너뛰기 | AWS를 사용할 수 없는 경우 대체 경로 |
| `CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL` | Claude API 스킬 비활성화 | 기업 규정 준수 시나리오 제어 |
| `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE` | 플러그인 마켓플레이스 내결함성 | Marketplace 가져오기 실패 시 캐시된 버전 유지 |
| `CLAUDE_CODE_REMOTE_SETTINGS_PATH` | 원격 설정 경로 재정의 | 엔터프라이즈 배포를 위한 사용자 정의 설정 URL |

</div>

### <a href="#v2191-removed-variables" class="header">v2.1.91 제거된 변수</a>

<div class="table-wrapper">

| 변하기 쉬운 | 원본 효과 | 제거 이유 |
|----|----|----|
| `CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK` | 명령 주입 검사 비활성화 | 트리시터 인프라가 완전히 제거되었습니다. |
| `CLAUDE_CODE_DISABLE_MOUSE_CLICKS` | 마우스 클릭 비활성화 | 더 이상 사용되지 않는 기능 |
| `CLAUDE_CODE_MCP_INSTR_DELTA` | MCP 명령어 델타 | 기능이 리팩터링되었습니다. |

</div>

------------------------------------------------------------------------

## <a href="#configuration-priority-system" class="header">구성 우선순위 시스템</a>

환경 변수는 Claude Code 구성 시스템의 한 측면일 뿐입니다. 전체 구성 시스템은 가장 낮은 우선순위부터 가장 높은 우선순위까지 병합된 6개 소스 레이어로 구성됩니다. 이후 소스는 이전 소스보다 우선합니다. "내 설정이 적용되지 않는 이유"를 진단하려면 이 우선 순위 체인을 이해하는 것이 중요합니다.

### <a href="#six-layer-priority-model" class="header">6계층 우선 모델</a>

구성 소스는 `restored-src/src/utils/settings/constants.ts:7-22`에 정의되어 있으며 병합 논리는 `restored-src/src/utils/settings/settings.ts:644-796`의 `loadSettingsFromDisk()` 함수에서 구현됩니다.

<div class="table-wrapper">

| 우선 사항 | 소스 ID | 파일 경로/소스 | 설명 |
|----|----|----|----|
| 0(최저) | 플러그인설정 | 플러그인 제공 기본 설정 | 허용된 필드(예: `agent`)만 포함하고 모든 파일 소스의 기본 레이어 역할을 합니다. |
| 1 | `userSettings` | `~/.claude/settings.json` | 사용자 전역 설정은 모든 프로젝트에 적용됩니다. |
| 2 | `projectSettings` | `$PROJECT/.claude/settings.json` | 버전 관리에 전념하는 프로젝트 공유 설정 |
| 3 | `localSettings` | `$PROJECT/.claude/settings.local.json` | `.gitignore`에 자동으로 추가된 프로젝트 로컬 설정 |
| 4 | `flagSettings` | `--settings` CLI 매개변수 + SDK 인라인 설정 | 명령줄 또는 SDK를 통해 전달된 임시 재정의 |
| 5(최고) | `policySettings` | 기업 관리형 정책(여러 경쟁 소스) | 기업 관리자 시행 정책, 아래 참조 |

</div>

### <a href="#merge-semantics" class="header">의미론 병합</a>

병합은 `restored-src/src/utils/settings/settings.ts:538-547`에 정의된 사용자 지정 병합과 함께 심층 병합을 위해 lodash의 `mergeWith`를 사용합니다.

- **객체**: 재귀적으로 병합된 이후 소스 필드는 이전 필드를 재정의합니다.
- **어레이**: 병합 및 중복 제거(`mergeArrays`), 대체되지 않음 — 이는 여러 레이어의 `permissions.allow` 규칙이 누적됨을 의미합니다.
- **`undefined` 값**: `updateSettingsForSource`(`restored-src/src/utils/settings/settings.ts:482-486`)에서 "이 키 삭제"로 해석됩니다.

이 배열 병합 의미는 특히 중요합니다. 사용자가 `userSettings`의 도구를 허용하고 `projectSettings`의 다른 도구를 허용하는 경우 최종 `permissions.allow` 목록에는 두 가지 도구가 모두 포함됩니다. 이를 통해 다중 계층 권한 구성이 서로 재정의되지 않고 쌓일 수 있습니다.

### <a href="#policy-settings-policysettings-four-layer-competition"
class="header">정책 설정(policySettings) 4계층 경쟁</a>

정책 설정(`policySettings`)에는 `restored-src/src/utils/settings/settings.ts:322-345`에서 구현된 "콘텐츠가 있는 첫 번째 소스 승리" 전략을 사용하는 자체 내부 우선순위 체인이 있습니다.

<div class="table-wrapper">

| 하위 우선순위 | 원천 | 설명 |
|----|----|----|
| 1(가장 높음) | 원격 관리 설정 | API에서 동기화된 엔터프라이즈 정책 캐시 |
| 2 | MDM 기본 정책(HKLM / macOS plist) | `plutil` 또는 `reg query`를 통해 읽은 시스템 수준 정책 |
| 3 | 파일 정책(`managed-settings.json` + `managed-settings.d/*.json`) | 드롭인 디렉토리 지원, 알파벳순으로 병합 |
| 4(최저) | HKCU 사용자 정책(Windows에만 해당) | 사용자 수준 레지스트리 설정 |

</div>

정책 설정은 다른 소스와 다르게 병합됩니다. 정책 내의 4개 하위 소스는 **경쟁 관계**(첫 번째 항목이 승리)에 있는 반면, 정책 전체는 다른 소스와 **추가 관계**에 있습니다(구성 체인의 맨 위로 심층 병합됨).

### <a href="#override-chain-flowchart" class="header">체인 흐름도 재정의</a>

``` mermaid
flowchart TD
    P["pluginSettings<br/>Plugin base settings"] -->|mergeWith| U["userSettings<br/>~/.claude/settings.json"]
    U -->|mergeWith| Proj["projectSettings<br/>.claude/settings.json"]
    Proj -->|mergeWith| L["localSettings<br/>.claude/settings.local.json"]
    L -->|mergeWith| F["flagSettings<br/>--settings CLI / SDK inline"]
    F -->|mergeWith| Pol["policySettings<br/>Enterprise managed policies"]
    Pol --> Final["Final effective config<br/>getInitialSettings()"]

    subgraph PolicyInternal["policySettings internal competition (first wins)"]
        direction TB
        R["Remote Managed<br/>Remote API"] -.->|empty?| MDM["MDM Native<br/>plist / HKLM"]
        MDM -.->|empty?| MF["File Policies<br/>managed-settings.json"]
        MF -.->|empty?| HK["HKCU<br/>Windows user-level"]
    end

    Pol --- PolicyInternal

    style Final fill:#e8f4f8,stroke:#2196F3,stroke-width:2px
    style PolicyInternal fill:#fff3e0,stroke:#FF9800
```

**그림 B-1: 구성 우선순위 재정의 체인**

### <a href="#caching-and-invalidation" class="header">캐싱 및 무효화</a>

구성 로딩에는 2계층 캐싱 메커니즘(`restored-src/src/utils/settings/settingsCache.ts`)이 있습니다.

1. **파일 수준 캐시**: `parseSettingsFile()`는 각 파일의 구문 분석 결과를 캐시하여 반복되는 JSON 구문 분석을 방지합니다.
2. **세션 수준 캐시**: `getSettingsWithErrors()`는 병합된 최종 결과를 캐시하고 세션 전체에서 재사용됩니다.

캐시는 `resetSettingsCache()`를 통해 균일하게 무효화됩니다. 사용자가 `/config` 명령 또는 `updateSettingsForSource()`를 통해 설정을 수정할 때 트리거됩니다. 설정 파일 변경 감지는 파일 시스템 감시를 통해 React 구성 요소를 다시 렌더링하는 `restored-src/src/utils/settings/changeDetector.ts`에 의해 처리됩니다.

### <a href="#diagnostic-recommendations" class="header">진단 권장사항</a>

설정이 "적용되지 않는" 경우 다음 순서에 따라 문제를 해결하세요.

1. **소스 확인**: `/config` 명령을 사용하여 현재 유효한 구성 및 소스 주석을 확인하세요.
2. **우선순위 확인**: 우선순위가 더 높은 소스가 설정보다 우선 적용됩니까? `policySettings`는 가장 강력한 재정의입니다.
3. **배열 병합 확인**: 권한 규칙은 추가됩니다. `deny` 규칙이 우선 순위가 높은 소스에 나타나는 경우 우선 순위가 낮은 `allow`는 이를 재정의할 수 없습니다.
4. **캐싱 확인**: 동일한 세션 내에서 `.json` 파일을 수정한 후에도 구성이 여전히 캐시될 수 있습니다. 세션을 다시 시작하거나 `/config`를 사용하여 새로 고침을 트리거하세요.
