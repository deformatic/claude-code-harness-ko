# <아
href="#chapter-6b-api-communication-layer--retry-streaming-and-degradation-engineering"
class="header">6b장: API 통신 계층 - 재시도, 스트리밍,
및 분해공학</a>

> `services/api/` 디렉터리는 SDK 래퍼 레이어가 아닙니다.
> 에이전트의 **제어 플레인**. 모델 저하, 캐시 보호, 파일
> 전송 및 프롬프트 재생 디버깅이 모두 이 계층에서 발생합니다. 이것
> 장은 가장 중요한 복원력 하위 시스템인 재시도,
> 스트리밍 및 성능 저하. 파일 전송 채널(Files API)은 다음과 같습니다.
> 이 장의 끝 부분에서 다루고 Prompt Replay 디버깅에 대해 설명합니다.
> 도구는 29장에서 분석됩니다.

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

에이전트 시스템의 신뢰성은 얼마나 지능적인가에 달려 있지 않습니다.
모델은 최악의 네트워크에서도 여전히 작동할 수 있는지 여부에 달려 있습니다.
정황. 기차에서 Claude Code를 사용하여 처리하는 개발자를 상상해 보세요.
긴급 버그: Wi-Fi가 끊기거나 API가 때때로 529를 반환합니다.
과부하 오류가 발생하고 스트리밍 응답이 갑자기 중간에 종료됩니다.
을 통해. 의사소통에 충분한 탄력성 설계가 없으면
레이어에서 이 개발자는 설명할 수 없는 충돌을 확인하거나 수동으로 수행해야 합니다.
반복적으로 재시도하여 귀중한 컨텍스트 창 공간을 낭비합니다.

클로드 코드의 커뮤니케이션 레이어는 바로 이런 종류의 문제를 해결합니다.
문제. 이는 단순한 "실패 시 재시도" 래퍼가 아닙니다.
다층 방어 시스템: 지수 백오프로 눈사태를 방지합니다.
효과, 529 카운터는 모델 저하를 유발하고 이중 감시 장치는 감지합니다.
스트림 중단, 고속 모드 캐시 인식 재시도를 통해 비용을 보호하고
영구 모드는 무인 시나리오를 지원합니다. 함께, 이들
메커니즘은 핵심 엔지니어링 철학을 구현합니다. **통신 실패
이는 예외가 아닌 표준이며 시스템에는 우연성이 있어야 합니다.
모든 계층에서 계획을 세우세요.**

마찬가지로 주목할만한 점은 이 시스템의 관찰 가능성 설계입니다.
모든 API 호출은 세 가지 원격 측정 이벤트 — `tengu_api_query`(요청
보냄), `tengu_api_success`(성공적인 응답), `tengu_api_error`
(실패한 응답) — 25개의 오류 분류 및 게이트웨이와 결합
지문 감지로 모든 통신 실패를 추적 가능하게 만들고
진단 가능. 이는 실제 프로덕션 트래픽을 기반으로 구축된 시스템입니다.
모든 코드 줄은 실제로 발생한 오류 시나리오에 매핑됩니다.

-----------------------------------------------------------

## <a href="#source-code-analysis" class="header">소스코드 분석</a>

> **대화형 버전**: [재시도 및 성능 저하를 보려면 클릭하세요.
> animation](retry-viz.html) — 4가지 시나리오에 대한 타임라인 애니메이션
> (정상 / 429 속도 제한 / 529 과부하 / 고속 모드 성능 저하).

### <a
href="#6b1-retry-strategy-from-exponential-backoff-to-model-degradation"
class="header">6b.1 재시도 전략: 지수 백오프에서 모델까지
저하</a>

Claude Code의 재시도 시스템은 `withRetry.ts`에 구현되어 있습니다. 핵심은
`yield`를 사용하는 `AsyncGenerator` 함수 `withRetry()`
재시도는 `SystemAPIErrorMessage`을 상위 계층으로 전달하기를 기다립니다.
재시도 상태를 실시간으로 표시하는 UI입니다.

#### <a href="#constants-and-configuration" class="header">상수 및
구성</a>

재시도 시스템의 동작은 신중하게 조정된 세트에 의해 제어됩니다.
상수:

<div class="table-wrapper">

| 상수 | 가치 | 목적 | 소스 위치 |
|----|----|----|----|
| `DEFAULT_MAX_RETRIES` | 10 | 기본 재시도 예산 | `withRetry.ts:52` |
| `MAX_529_RETRIES` | 3 | 연속 529 과부하 후 모델 저하 트리거 | `withRetry.ts:54` |
| `BASE_DELAY_MS` | 500 | 지수 백오프 기준(500ms x 2^(시도-1)) | `withRetry.ts:55` |
| `PERSISTENT_MAX_BACKOFF_MS` | 5분 | 지속 모드의 최대 백오프 한도 | `withRetry.ts:96` |
| `PERSISTENT_RESET_CAP_MS` | 6시간 | 영구 모드의 절대 한도 | `withRetry.ts:97` |
| `HEARTBEAT_INTERVAL_MS` | 30초 | 하트비트 간격(컨테이너 유휴 회수 방지) | `withRetry.ts:98` |
| `SHORT_RETRY_THRESHOLD_MS` | 20초 | 빠른 모드 단기 재시도 임계값 | `withRetry.ts:800` |
| `DEFAULT_FAST_MODE_FALLBACK_HOLD_MS` | 30분 | 빠른 모드 휴지 기간 | `withRetry.ts:799` |

</div>

10번의 재시도 예산은 넉넉해 보일 수 있지만 기하급수적인 예산과 결합하면
백오프(500ms -\> 1초 -\> 2초 -\> 4초 -\> 8초 -\> 16초 -\> 32초 x 4)
총 대기 시간은 약 2.5~3분입니다. 실제 구현
또한 각 백오프 간격마다 0~25%의 무작위 지터를 추가합니다.
(`withRetry.ts:542-547`), 여러 클라이언트의 재시도 방지
동시에 Thundering Herd 효과를 발생시킵니다. 이는 신중하게
보정된 설계: 짧은 네트워크 문제를 처리하기에 충분한 재시도이지만
API를 실제로 사용할 수 없을 때 사용자가 너무 오래 기다릴 정도로 많지는 않습니다.

#### <a href="#retry-decisions-the-shouldretry-function" class="header">다시 시도
결정: shouldRetry 함수</a>

`shouldRetry()` 함수는 재시도의 핵심 의사결정자입니다.
`withRetry.ts:696-787`에 정의된 시스템입니다. `APIError`을 수신하고
부울을 반환합니다. 모든 반환 경로를 분석하면 세 가지가 드러납니다.
카테고리:

**다시 시도하지 마세요:**

<div class="table-wrapper">

| 조건 | 반품 | 이유 |
|----|----|----|
| 모의 오류(테스트용) | `false` | `/mock-limits` 명령에서는 재시도로 재정의되어서는 안 됩니다. |
| `x-should-retry: false`(ant 사용자가 아니거나 5xx 사용자가 아님) | `false` | 서버가 명시적으로 재시도 없음을 나타냄 |
| 상태 코드도 없고 연결 오류도 없습니다 | `false` | 오류 유형을 확인할 수 없습니다. |
| ClaudeAI 가입자의 429(비Enterprise) | `false` | Max/Pro 사용자 비율 제한은 시간 수준입니다. 재시도는 무의미하다 |

</div>

**항상 다시 시도하세요:**

<div class="table-wrapper">

| 조건 | 반품 | 이유 |
|----|----|----|
| 영구 모드의 429/529 | `true` | 무인 시나리오에는 무한 재시도가 필요합니다 |
| CCR 모드의 401/403 | `true` | 원격 환경에서의 인증은 인프라에서 관리됩니다. 일시적인 오류는 복구 가능 |
| 컨텍스트 오버플로 오류(400) | `true` | 오류 메시지를 구문 분석하고 `max_tokens` (`withRetry.ts:726`) |
| 오류 메시지에는 `overloaded_error` | `true` | SDK가 스트리밍 모드에서 529 상태 코드를 제대로 전달하지 못하는 경우가 있음 |
| `APIConnectionError`(연결 오류) | `true` | 네트워크 오류는 가장 일반적인 일시적 오류입니다 |
| 408(요청 시간 초과) | `true` | 서버측 시간 초과; 재시도는 일반적으로 성공합니다 |
| 409(잠금 시간 초과) | `true` | 백엔드 리소스 경합 재시도는 일반적으로 성공합니다 |
| 401(인증 오류) | `true` | API 키 캐시를 지운 후 다시 시도 |
| 403(OAuth 토큰 취소됨) | `true` | 다른 프로세스가 토큰을 새로 고쳤습니다 |
| 5xx(서버 오류) | `true` | 서버측 오류는 일반적으로 일시적입니다. |

</div>

**조건부 재시도:**

<div class="table-wrapper">

| 조건 | 반품 | 이유 |
|----|----|----|
| `x-should-retry: true` 및 ClaudeAI 구독자 또는 구독자가 아닌 Enterprise | `true` | 서버가 재시도를 표시하고 사용자 유형이 이를 지원함 |
| 429(ClaudeAI 비구독자 또는 Enterprise) | `true` | 종량제 사용자에 대한 비율 제한은 간단합니다 |

</div>

여기에 주목할만한 디자인 결정이 있습니다: ClaudeAI 가입자를 위한 것
(Max/Pro) `x-should-retry` 헤더가 `true`인 경우에도 429 오류
재시도되지 않습니다. 그 이유는 소스 댓글에 명확하게 명시되어 있습니다.

``` typescript
// restored-src/src/services/api/withRetry.ts:735-736
// For Max and Pro users, should-retry is true, but in several hours, so we shouldn't.
// Enterprise users can retry because they typically use PAYG instead of rate limits.
```

Max/Pro 사용자 속도 제한 창은 몇 시간 단위로 표시됩니다. 다시 시도하는 중입니다.
시간낭비일 뿐이고 사용자에게 직접 알리는 것이 더 좋습니다. 이것은
**사용자 시나리오 이해를 바탕으로 차별화된 결정**,
모든 경우에 적용되는 재시도 정책이 아닌

#### <a href="#the-three-layer-error-classification-funnel"
class="header">3계층 오류 분류 깔때기</a>

Claude Code의 오류 처리는 플랫 스위치 케이스가 아닌 3계층 구조입니다.
깔때기 구조:

classifyAPIError() — 19개 이상의 특정 유형(원격 측정 및 진단용)
↓ 매핑
categorizeRetryableAPIError() — SDK 카테고리 4개(상위 계층 오류 표시용)
↓ 결정
shouldRetry() — 부울(재시도 루프용)

첫 번째 레이어인 `classifyAPIError()`(`errors.ts:965-1161`)는 다음을 세분화합니다.
`aborted`, `api_timeout`을 포함한 25개 이상의 특정 유형에 대한 오류
`repeated_529`, `capacity_off_switch`, `rate_limit`, `server_overload`,
`prompt_too_long`, `pdf_too_large`, `pdf_password_protected`,
`image_too_large`, `tool_use_mismatch`, `unexpected_tool_result`,
`duplicate_tool_use_id`, `invalid_model`, `credit_balance_low`,
`invalid_api_key`, `token_revoked`, `oauth_org_not_allowed`,
`auth_error`, `bedrock_model_access`, `server_error`, `client_error`,
`ssl_cert_error`, `connection_error`, `unknown`. 이것들
분류는 `errorType` 필드에 직접 기록됩니다.
`tengu_api_error` 원격 측정 이벤트를 통해 정확한 분류가 가능합니다.
생산 문제.

두 번째 레이어 `categorizeRetryableAPIError()`
(`errors.ts:1163-1182`), 이러한 세분화된 유형을 4개로 병합합니다.
SDK 수준 카테고리: `rate_limit`(429 및 529),
`authentication_failed`(401 및 403), `server_error`(408+) 및
`unknown`. 이 레이어는 다음에 대한 단순화된 오류 표시를 제공합니다.
상위 레이어 UI.

세 번째 레이어는 `shouldRetry()` 자체이며 최종 부울을 만듭니다.
결정.

이 3계층 설계의 장점은 진단 정보가
의사결정 논리는 그대로 유지되면서 매우 상세할 수 있습니다(25개 분류).
간결함(참/거짓). 두 가지 우려 사항은 완전히 분리되었습니다.

#### <a href="#special-handling-of-529-overload" class="header">특집
529 과부하</a> 처리

529 오류는 Claude Code의 재시도 시스템에서 특별한 위치를 차지합니다. 에이
529는 429(사용자
속도 제한), 이는 시스템 수준의 과부하입니다.

첫째, 모든 쿼리 소스가 529에서 다시 시도하는 것은 아닙니다.
`FOREGROUND_529_RETRY_SOURCES`(`withRetry.ts:62-82`)은
포그라운드 요청(사용자가 적극적으로 요청하는 경우)만 허용되는 허용 목록
대기 중)이 재시도됩니다.

``` typescript
// restored-src/src/services/api/withRetry.ts:57-61
// Foreground query sources where the user IS blocking on the result — these
// retry on 529. Everything else (summaries, titles, suggestions, classifiers)
// bails immediately: during a capacity cascade each retry is 3-10× gateway
// amplification, and the user never sees those fail anyway.
```

이는 **시스템 수준 부하 차단 전략**입니다. 백엔드가
오버로드, 백그라운드 작업(요약 생성, 제목 생성,
제안 생성) 재시도에 참여하기보다는 즉시 포기
대기줄. 재시도할 때마다 오버로드된 백엔드의 로드가 3~10배 증폭됩니다.
불필요한 재시도를 줄이는 것이 연속적인 오류를 완화하는 데 중요합니다.

둘째, 3회 연속 529 오류가 모델 성능 저하를 유발합니다. 이것
논리는 `withRetry.ts:327-364`에 있습니다.

``` typescript
// restored-src/src/services/api/withRetry.ts:327-351
if (is529Error(error) &&
    (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
     (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))
) {
  consecutive529Errors++
  if (consecutive529Errors >= MAX_529_RETRIES) {
    if (options.fallbackModel) {
      logEvent('tengu_api_opus_fallback_triggered', {
        original_model: options.model,
        fallback_model: options.fallbackModel,
        provider: getAPIProviderForStatsig(),
      })
      throw new FallbackTriggeredError(
        options.model,
        options.fallbackModel,
      )
    }
    // ...
  }
}
```

`FallbackTriggeredError`(`withRetry.ts:160-168`)은 전용 오류입니다.
수업. 이는 일반적인 예외가 아닙니다. **제어 흐름 신호**입니다.
상위 계층 에이전트 루프에 포착되면 모델 전환을 트리거합니다.
(일반적으로 Opus에서 Sonnet까지). 제어 흐름에 예외를 사용하는 것은
많은 맥락에서 안티패턴이지만 여기서는 정당화됩니다.
이벤트는 여러 호출 스택 레이어를 통해 전파되어
에이전트 루프 및 예외는 가장 자연스러운 상향 전파입니다.
기구.

마찬가지로 중요한 것은 `CannotRetryError`(`withRetry.ts:144-158`)입니다.
`retryContext`(현재 모델 포함, 생각
구성, max_tokens 재정의 등), 상위 계층 제공
실패를 처리하는 방법을 결정하기에 충분한 컨텍스트입니다.

### <a href="#6b2-streaming-dual-watchdogs" class="header">6b.2 스트리밍:
듀얼 워치독</a>

스트리밍 응답은 Claude Code 사용자 경험의 핵심입니다.
길고 빈 페이지를 기다리지 않고 텍스트가 점차적으로 나타나는 것을 확인하세요.
그러나 스트리밍 연결은 일반 HTTP보다 훨씬 취약합니다.
요청: TCP 연결은 중개자에 의해 자동으로 닫힐 수 있습니다.
프록시, 생성 중에 서버가 중단될 수 있으며 SDK 시간 초과가 발생할 수 있습니다.
메커니즘은 데이터 스트림 단계가 아닌 초기 연결만 다룹니다.

Claude Code는 `claude.ts`의 두 계층을 사용하여 이 문제를 해결합니다.
감시견.

#### <a href="#idle-timeout-watchdog-interrupting" class="header">유휴
타임아웃 워치독(중단)</a>

``` typescript
// restored-src/src/services/api/claude.ts:1877-1878
const STREAM_IDLE_TIMEOUT_MS =
  parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000
const STREAM_IDLE_WARNING_MS = STREAM_IDLE_TIMEOUT_MS / 2
```

유휴 감시는 전형적인 **2단계 경고** 패턴을 따릅니다.

1. **경고 단계**(45초): 스트리밍 이벤트(청크)가 없는 경우
45초 동안 수신됨, 경고 로그 및 진단 이벤트
`cli_streaming_idle_warning`이 녹화됩니다. 스트림은 아마도
이 시점에서는 느립니다. 반드시 죽은 것은 아닙니다.
2. **타임아웃 단계**(90초): 이벤트 없이 90초가 경과한 경우
모두 스트림이 죽은 것으로 선언됩니다. 그것은 설정한다
`streamIdleAborted = true`, `performance.now()` 스냅샷을 기록합니다.
(나중에 중단 전파 지연을 측정하기 위해)
`tengu_streaming_idle_timeout` 원격 측정 이벤트 후 호출
`releaseStreamResources()` 스트림을 강제로 종료합니다.

새로운 스트리밍 이벤트가 도착할 때마다 `resetStreamIdleTimer()`이 재설정됩니다.
타이머 둘 다. 이렇게 하면 스트림이 살아있는 한 보장됩니다.
느림 - 감시자가 조기에 종료하지 않습니다.

``` typescript
// restored-src/src/services/api/claude.ts:1895-1928
function resetStreamIdleTimer(): void {
  clearStreamIdleTimers()
  if (!streamWatchdogEnabled) { return }
  streamIdleWarningTimer = setTimeout(/* warning */, STREAM_IDLE_WARNING_MS)
  streamIdleTimer = setTimeout(() => {
    streamIdleAborted = true
    streamWatchdogFiredAt = performance.now()
    // ... logging and telemetry
    releaseStreamResources()
  }, STREAM_IDLE_TIMEOUT_MS)
}
```

워치독은 다음을 통해 명시적으로 활성화되어야 합니다.
`CLAUDE_ENABLE_STREAM_WATCHDOG` 환경 변수입니다. 이는 다음을 나타냅니다.
기능은 아직 점진적인 출시 단계에 있습니다.
모든 사용자로 확장되기 전에 내부 및 제한된 사용자입니다.

#### <a href="#stall-detection-logging-only" class="header">스톨 감지
(로깅 전용)</a>

``` typescript
// restored-src/src/services/api/claude.ts:1936
const STALL_THRESHOLD_MS = 30_000 // 30 seconds
```

정지 감지는 유휴 감시와 다른 문제를 해결합니다.

- **유휴** = "전혀 수신된 이벤트 없음"(연결이 이미
죽은)
- **Stall** = "이벤트가 수신되었으나 그 사이의 간격이 너무 깁니다.
대형"(연결은 살아있지만 서버가 느림)

중단 감지는 **로그**만 수행하며 **중단**하지 않습니다. 때
두 스트리밍 이벤트 간의 간격이 30초를 초과하면 간격이 증가합니다.
`stallCount` 및 `totalStallTime`, `tengu_streaming_stall`를 보냅니다.
원격 측정 이벤트:

``` typescript
// restored-src/src/services/api/claude.ts:1944-1965
if (lastEventTime !== null) {
  const timeSinceLastEvent = now - lastEventTime
  if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
    stallCount++
    totalStallTime += timeSinceLastEvent
    logForDebugging(
      `Streaming stall detected: ${(timeSinceLastEvent / 1000).toFixed(1)}s gap between events (stall #${stallCount})`,
      { level: 'warn' },
    )
    logEvent('tengu_streaming_stall', { /* ... */ })
  }
}
lastEventTime = now
```

주요 세부 사항: `lastEventTime`은 첫 번째 청크가 도착한 후에만 설정됩니다.
TTFB(Time to First Token)를 지연으로 잘못 식별하는 것을 방지합니다.
TTFB는 합법적으로 높을 수 있지만(모델이 생각하고 있음) 일단 출력되면
시작되면 후속 이벤트 간격이 안정적이어야 합니다.

두 감시 계층 간의 협력은 다음과 같이 설명할 수 있습니다.
다음과 같습니다:

``` mermaid
graph TD
    A[Stream Connection Established] --> B{Event Received?}
    B -->|Yes| C[resetStreamIdleTimer]
    C --> D{Gap Since Last Event > 30s?}
    D -->|Yes| E[Log Stall<br/>No Interruption]
    D -->|No| F[Process Event Normally]
    E --> F
    B -->|No, Waiting| G{Waited 45s?}
    G -->|Yes| H[Log Idle Warning]
    H --> I{Waited 90s?}
    I -->|Yes| J[Terminate Stream<br/>Trigger Fallback]
    I -->|No| B
    G -->|No| B
```

#### <a href="#non-streaming-fallback" class="header">비스트리밍
폴백</a>

스트리밍 연결이 워치독에 의해 중단되거나 실패하는 경우
다른 이유로 인해 Claude Code는 비스트리밍 요청 모드로 대체됩니다.
이 논리는 `claude.ts:2464-2569`에 있습니다.

대체 중에 두 가지 주요 정보가 기록됩니다.

1. **`fallback_cause`**: `'watchdog'`(워치독 시간 초과) 또는 `'other'`
(기타 오류), 트리거 원인을 구별하는 데 사용됩니다.
2. **`initialConsecutive529Errors`**: 스트리밍 자체가 실패하는 경우
529 오류가 발생한 경우 횟수가 비스트리밍 재시도로 전달됩니다.
고리. 이렇게 하면 529 카운트가 도중에 재설정되지 않습니다.
스트리밍-비스트리밍 스위치:

``` typescript
// restored-src/src/services/api/claude.ts:2559
initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0,
```

비스트리밍 대체에는 자체 시간 제한 구성이 있습니다.

``` typescript
// restored-src/src/services/api/claude.ts:807-811
function getNonstreamingFallbackTimeoutMs(): number {
  const override = parseInt(process.env.API_TIMEOUT_MS || '', 10)
  if (override) return override
  return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ? 120_000 : 300_000
}
```

CCR(Claude Code Remote) 환경은 기본적으로 2분으로 설정되어 있지만 로컬에서는
환경의 기본값은 5분입니다. CCR의 시간 제한이 더 짧은 이유는 다음과 같습니다.
원격 컨테이너에는 최대 5분 동안의 유휴 회수 메커니즘이 있습니다.
5분 동안 정지하면 컨테이너가 SIGKILL을 수신하게 되므로
2분으로 적절하게 시간 초과하는 것이 좋습니다.

주목할 만한 점은 다음을 통해 비스트리밍 폴백을 비활성화할 수 있다는 점입니다.
기능 플래그 `tengu_disable_streaming_to_non_streaming_fallback` 또는
환경 변수 `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK`. 그만큼
이유는 소스 댓글에 명확하게 설명되어 있습니다.

``` typescript
// restored-src/src/services/api/claude.ts:2464-2468
// When the flag is enabled, skip the non-streaming fallback and let the
// error propagate to withRetry. The mid-stream fallback causes double tool
// execution when streaming tool execution is active: the partial stream
// starts a tool, then the non-streaming retry produces the same tool_use
// and runs it again. See inc-4258.
```

이 수정 사항은 실제 생산 사고(inc-4258)에서 탄생했습니다.
스트리밍 중에 도구가 이미 실행되기 시작한 다음 시스템이
비스트리밍 재시도로 대체되면 동일한 도구가 두 번 실행됩니다.
이 "부분 완료 + 전체 재시도 = 중복 실행" 패턴은
모든 스트리밍 시스템의 전형적인 함정입니다.

### <a href="#6b3-fast-mode-cache-aware-retry" class="header">6b.3 고속 모드
캐시 인식 재시도</a>

고속 모드는 Claude Code의 가속 모드입니다(자세한 내용은 21장 참조).
세부 정보) 더 높은 처리량을 달성하기 위해 별도의 모델 이름을 사용합니다.
고속 모드의 재시도 전략에는 다음과 같은 고유한 고려 사항이 있습니다. **프롬프트
은닉처**.

고속 모드에서 429(속도 제한) 또는 529(과부하)가 발생하면 코어
재시도 결정은
`Retry-After` 헤더(`withRetry.ts:267-305`):

``` typescript
// restored-src/src/services/api/withRetry.ts:284-304
const retryAfterMs = getRetryAfterMs(error)
if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
  // Short retry-after: wait and retry with fast mode still active
  // to preserve prompt cache (same model name on retry).
  await sleep(retryAfterMs, options.signal, { abortError })
  continue
}
// Long or unknown retry-after: enter cooldown (switches to standard
// speed model), with a minimum floor to avoid flip-flopping.
const cooldownMs = Math.max(
  retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
  MIN_COOLDOWN_MS,
)
const cooldownReason: CooldownReason = is529Error(error)
  ? 'overloaded'
  : 'rate_limit'
triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
```

이 설계의 비용 절충점은 다음과 같습니다.

<div class="table-wrapper">

| 시나리오 | 대기 시간 | 전략 | 이유 |
|----|----|----|----|
| `Retry-After < 20s` | 간략한 | 제자리에서 기다리세요. 빠른 모드를 유지하세요 | 캐시는 \<20초 내에 만료되지 않습니다. 캐시를 보존하면 다음 요청 시 토큰 비용이 크게 절감됩니다. |
| `Retry-After >= 20s` 또는 알 수 없음 | 더 이상 | 표준 모드로 전환하고 쿨타임을 입력하세요 | 캐시가 만료되었을 수 있습니다. 가용성을 복원하려면 즉시 표준 모드로 전환하는 것이 좋습니다 |

</div>

쿨다운 하한선은 10분(`MIN_COOLDOWN_MS`)이며 기본값은
30분(`DEFAULT_FAST_MODE_FALLBACK_HOLD_MS`). 바닥의 ​​목적
속도 제한 경계에서 고속 모드가 플립플롭되는 것을 방지하기 위한 것입니다.
불안정한 사용자 경험을 만들 수 있습니다.

또한 429가 초과 사용량을 사용할 수 없기 때문에 발생하는 경우 —
즉, 사용자의 구독은 초과분을 지원하지 않습니다. — 빠른 모드는
일시적으로 냉각되지 않고 **영구적으로 비활성화됨**:

``` typescript
// restored-src/src/services/api/withRetry.ts:275-281
const overageReason = error.headers?.get(
  'anthropic-ratelimit-unified-overage-disabled-reason',
)
if (overageReason !== null && overageReason !== undefined) {
  handleFastModeOverageRejection(overageReason)
  retryContext.fastMode = false
  continue
}
```

### <a href="#6b4-persistent-retry-mode" class="header">6b.4 지속성
재시도 모드</a>

환경 변수 `CLAUDE_CODE_UNATTENDED_RETRY=1` 설정
Claude Code의 지속적인 재시도 모드를 활성화합니다. 이 모드는 다음을 위해 설계되었습니다.
무인 시나리오(CI/CD, 일괄처리, 내부 Anthropic
자동화), 핵심 동작은 **429/529에서 무한 재시도**입니다.

지속 모드의 세 가지 주요 설계 측면:

**1. 무한 루프 + 독립 카운터**

일반 모드에서는 `attempt`이 1에서 `maxRetries + 1`로 증가합니다.
루프가 종료됩니다. 지속 모드는 클램핑을 통해 무한 루프를 달성합니다.
루프 끝의 `attempt` 값:

``` typescript
// restored-src/src/services/api/withRetry.ts:505-506
// Clamp so the for-loop never terminates. Backoff uses the separate
// persistentAttempt counter which keeps growing to the 5-min cap.
if (attempt >= maxRetries) attempt = maxRetries
```

`persistentAttempt`은(는) 증가하는 독립 카운터입니다.
백오프 지연을 계산하는 데 사용되는 지속 모드입니다. 에 국한되지 않습니다.
`maxRetries`에 도달할 때까지 백오프 시간이 계속 증가합니다.
5분 제한.

**2. 창 수준 속도 제한 인식**

429 오류의 경우 영구 모드는
재설정 타임스탬프에 대한 `anthropic-ratelimit-unified-reset` 헤더입니다. 만약에
서버에 "5시간 후 재설정"이 표시되면 시스템은 직접 기다립니다.
5분마다 아무 생각 없이 폴링하는 대신 재설정 시간까지:

``` typescript
// restored-src/src/services/api/withRetry.ts:436-447
if (persistent && error instanceof APIError && error.status === 429) {
  persistentAttempt++
  const resetDelay = getRateLimitResetDelayMs(error)
  delayMs =
    resetDelay ??
    Math.min(
      getRetryDelay(persistentAttempt, retryAfter, PERSISTENT_MAX_BACKOFF_MS),
      PERSISTENT_RESET_CAP_MS,
    )
}
```

**3. 하트비트 Keepalive**

이것은 지속 모드에서 가장 영리한 디자인입니다. 백오프 시간
시간이 길면(예: 5분) 시스템은 단일 작업을 수행하지 않습니다.
`sleep(300000)`. 대신 대기 시간을 여러 30초로 분할합니다.
세그먼트를 생성하여 각 세그먼트 뒤에 `SystemAPIErrorMessage`을 생성합니다.

``` typescript
// restored-src/src/services/api/withRetry.ts:489-503
let remaining = delayMs
while (remaining > 0) {
  if (options.signal?.aborted) throw new APIUserAbortError()
  if (error instanceof APIError) {
    yield createSystemAPIErrorMessage(
      error,
      remaining,
      reportedAttempt,
      maxRetries,
    )
  }
  const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
  await sleep(chunk, options.signal, { abortError })
  remaining -= chunk
}
```

하트비트 메커니즘은 두 가지 문제를 해결합니다.

- **컨테이너 유휴 회수**: CCR과 같은 원격 환경은
출력이 없는 장기 실행 프로세스를 유휴 상태로 식별하고 회수합니다.
그들을. 30초 수율은 stdout에서 활동을 생성하여
거짓 종료.
- **사용자 인터럽트 응답성**: `signal.aborted` 확인
각 30초 세그먼트 사이에서 사용자는 언제든지 긴 대기를 중단할 수 있습니다.
시간. 단일 `sleep(300s)`의 경우 Ctrl-C를 눌러야 합니다.
효과가 나타나기 전에 수면이 완료될 때까지 기다립니다.

소스의 TODO 주석은 이 디자인의 임시방편 특성을 보여줍니다.

``` typescript
// restored-src/src/services/api/withRetry.ts:94-95
// TODO(ANT-344): the keep-alive via SystemAPIErrorMessage yields is a stopgap
// until there's a dedicated keep-alive channel.
```

### <a href="#6b5-api-observability" class="header">6b.5 API
관찰성</a>

Claude Code의 API 관찰 시스템은 `logging.ts`에 구현되어 있습니다.
세 가지 원격 측정 이벤트를 중심으로 구축되었습니다.

#### <a href="#the-three-event-model" class="header">3가지 이벤트
모델</a>

<div class="table-wrapper">

| 이벤트 | 트리거 | 주요 분야 | 소스 위치 |
|----|----|----|----|
| `tengu_api_query` | 요청이 전송되면 | 모델, messageLength, 베타, querySource, ThinkingType, 노력값, fastMode | `logging.ts:196` |
| `tengu_api_success` | 성공적인 응답 시 | 모델, inputTokens, outputTokens, 캐시된InputTokens, ttftMs, costUSD, 게이트웨이, didFallBackToNonStreaming | `logging.ts:463` |
| `tengu_api_error` | 응답 실패 시 | 모델, 오류, 상태, errorType(분류 25개), DurationMs, 시도, 게이트웨이 | `logging.ts:304` |

</div>

이 세 가지 이벤트는 완전한 요청 퍼널을 형성합니다. query -\>
성공/오류. `requestId`에 대한 상관관계를 통해
발송부터 완료까지 요청을 추적할 수 있습니다.

#### <a href="#ttfb-and-cache-hits" class="header">TTFB 및 캐시 적중</a>

성공 이벤트에서 가장 중요한 성능 지표는 `ttftMs`입니다.
(첫 번째 토큰까지의 시간) — 요청 발송부터 도착까지의 시간
첫 번째 스트리밍 청크. 이 지표는 다음을 직접적으로 반영합니다.

- 네트워크 대기 시간(클라이언트에서 API 엔드포인트까지의 왕복 시간)
- 대기열 지연(요청이 API 백엔드에서 대기하는 데 소요되는 시간)
- 모델 최초 토큰 생성 시간(프롬프트 길이 및 모델 관련)
크기)

캐시 관련 필드(`cachedInputTokens` 및 `uncachedInputTokens`,
즉, `cache_creation_input_tokens`) 팀이 프롬프트를 모니터링할 수 있도록 합니다.
비용과 TTFB에 직접적인 영향을 미치는 캐시 적중률입니다.

#### <a href="#gateway-fingerprint-detection" class="header">게이트웨이
지문 감지</a>

`logging.ts`에서 쉽게 간과되는 기능은 게이트웨이 감지입니다.
(`detectGateway()`, `logging.ts:107-139`). 이는 다음 여부를 식별합니다.
요청은 검사를 통해 타사 AI 게이트웨이를 통과했습니다.
응답 헤더 접두사:

<div class="table-wrapper">

| 게이트웨이 | 헤더 접두사 |
|------------|---------------|
| LiteLLM | `x-litellm-` |
| 헬리콥터 | `helicone-` |
| 포트키 | `x-portkey-` |
| Cloudflare AI 게이트웨이 | `cf-aig-` |
| 콩 | `x-kong-` |
| 브레인트러스트 | `x-bt-` |
| 데이터브릭스 | 도메인 접미사를 통해 감지됨 |

</div>

게이트웨이가 감지되면 `gateway` 필드가 성공에 포함됩니다.
및 오류 이벤트. 이를 통해 Anthropic 팀은 "특정"을 진단할 수 있습니다.
특정 게이트웨이 환경의 오류 패턴" — 예를 들어,
LiteLLM 프록시를 통해 404 오류율이 비정상적으로 높을 수 있습니다.
API 문제가 아닌 프록시 구성 문제입니다.

#### <a href="#diagnostic-value-of-error-classification"
class="header">오류 분류의 진단 값</a>

오류 이벤트의 `errorType`은 `classifyAPIError()`의 25를 사용합니다.
분류. 단순한 HTTP 상태 코드와 비교하면 다음과 같습니다.
분류는 보다 정확한 진단 정보를 제공합니다.

<div class="table-wrapper">

| 분류 | 의미 | 진단적 가치 |
|----|----|----|
| `repeated_529` | 연속 529가 임계값을 초과함 | 지속적인 비가용성과 산발적인 과부하 구별 |
| `tool_use_mismatch` | 도구 호출/결과 불일치 | 컨텍스트 관리의 버그를 나타냅니다 |
| `ssl_cert_error` | SSL 인증서 문제 | 사용자에게 프록시 구성을 확인하라는 메시지 표시 |
| `token_revoked` | OAuth 토큰이 취소됨 | 다중 인스턴스 토큰 경합을 나타냅니다 |
| `bedrock_model_access` | 기반암 모델 액세스 오류 | 사용자에게 IAM 권한을 확인하라는 메시지 표시 |

</div>

-----------------------------------------------------------

## <a href="#pattern-extraction" class="header">패턴 추출</a>

### <a
href="#pattern-1-finite-retry-budget--independent-degradation-threshold"
class="header">패턴 1: 한정된 재시도 예산 + 독립적 성능 저하
임계값</a>

- **문제 해결**: 무한한 재시도로 인해 사용자 대기 및 비용 발생
도망자; 동시에, 다른 오류 유형에는 다른 요구사항이 있습니다.
인내심의 한계점
- **핵심 접근 방식**: 전역 재시도 예산(10회 시도)을 설정하는 동안
특정 오류에 대한 독립적인 하위 예산 설정(529
과부하, 3회 시도). 하위 예산 소진으로 인해 성능 저하가 발생합니다.
포기보다는. 두 카운터는 별도의 조치 없이 독립적으로 실행됩니다.
서로 간섭하다
- **전제조건**: 명확한 성능 저하 계획이 있어야 합니다(대체)
모델); 저하 자체가 주요 예산을 소비해서는 안 됩니다.
- **출처 참조**:
`restored-src/src/services/api/withRetry.ts:52-54` —
`DEFAULT_MAX_RETRIES=10`, `MAX_529_RETRIES=3`

### <a href="#pattern-2-dual-watchdog-logging--interrupting"
class="header">패턴 2: 이중 감시(로깅 + 중단)</a>

- **문제 해결**: 스트리밍 연결이 자동으로 중단될 수 있음 - TCP
Keepalive는 애플리케이션 계층의 자동 정지를 처리할 수 없습니다.
- **핵심 접근 방식**: 두 개의 탐지 계층을 설정합니다. 스톨 감지(30
초) 이벤트 간격이 너무 긴 경우에만 원격 분석을 기록하고 내보냅니다.
스트림을 방해하지 않고 크며 — 느리다는 것은 의미가 없기 때문입니다.
죽은. 유휴 감시(90초)는 연결을 종료하고
이벤트가 전혀 없을 때 대체를 트리거합니다.
90초 동안 활동이 없으면 거의 확실히 사망했습니다.
- **전제 조건**: 비스트리밍 대체 경로가 있어야 합니다. 지키는 개
임계값은 구성 가능해야 합니다(다른 네트워크 환경에서는
임계값이 다름)
- **소스 참조**: `restored-src/src/services/api/claude.ts:1936` —
정지 감지, `restored-src/src/services/api/claude.ts:1877` — 유휴
지키는 개

### <a href="#pattern-3-cache-aware-retry-decision" class="header">패턴
3: 캐시 인식 재시도 결정</a>

- **문제 해결**: 재시도 시 프롬프트 캐시가 무효화될 수 있으며,
캐시 무효화는 더 높은 토큰 비용과 더 긴 TTFB를 의미합니다.
- **핵심 접근 방식**: 기대치를 바탕으로 차별화된 결정을 내립니다.
대기 시간. 짧은 대기(\<20 seconds) -\> 캐시를 보존하고 대기
캐시는 20초 이내에 만료되지 않기 때문입니다. 오래 기다리다
(\>=20초) -\> 캐시를 포기하고 모드를 전환합니다.
대기 비용이 캐시 재구축 비용을 초과합니다.
- **전제 조건**: API는 `Retry-After` 헤더를 제공해야 합니다. 있어야 한다
전환할 대체 모드
- **출처 참조**:
`restored-src/src/services/api/withRetry.ts:284-304`

### <a href="#pattern-4-heartbeat-keepalive" class="header">패턴 4:
하트비트 연결 유지</a>

- **문제 해결**: 긴 수면 중에 프로세스에서 출력이 생성되지 않습니다.
호스트 환경에서는 유휴 상태로 간주되어 회수될 수 있습니다.
- **핵심 접근 방식**: 단일 긴 수면을 N 30초로 분할합니다.
세그먼트, 스트림을 유지하기 위해 각 세그먼트 후에 메시지를 생성합니다.
활동적인. 또한 각 세그먼트 간의 인터럽트 신호를 확인하여
사용자는 언제든지 취소할 수 있습니다.
- **전제 조건**: 발신자는 `AsyncGenerator` 또는 이와 유사한 사람이어야 합니다.
중간 결과를 생성할 수 있는 코루틴 구조
기다림
- **출처 참조**:
`restored-src/src/services/api/withRetry.ts:489-503`

-----------------------------------------------------------

### <a href="#6b5-file-transfer-channel-files-api" class="header">6b.5 파일
전송 채널: 파일 API</a>

`services/api/` 디렉토리에는 자주 간과되는 항목도 포함되어 있습니다.
하위 시스템 — 파일 업로드/다운로드를 구현하는 `filesApi.ts`
Anthropic Public Files API 기능을 사용합니다. 이것은 단순한 것이 아니다
HTTP 클라이언트이지만 세 가지 개별 서비스를 제공하는 파일 전송 채널
시나리오:

<div class="table-wrapper">

| 시나리오 | 발신자 | 방향 | 목적 |
|----|----|----|----|
| 세션 시작 파일 첨부 | `main.tsx` | 다운로드 | `--file=<id>:<path>` 매개변수로 지정된 파일 |
| CCR 시드 번들 업로드 | `gitBundle.ts` | 업로드 | 원격 세션을 위한 코드베이스 패키지 전송(20c장 참조) |
| BYOC 파일 지속성 | `filePersistence.ts` | 업로드 | 매 턴마다 수정된 파일 업로드 |

</div>

`FilesApiConfig`의 디자인은 중요한 제약 조건인 파일을 드러냅니다.
작업에는 OAuth 세션 토큰(API 키가 아님)이 필요합니다.
파일은 세션에 바인딩됩니다.

``` typescript
// restored-src/src/services/api/filesApi.ts:60-67
export type FilesApiConfig = {
  /** OAuth token for authentication (from session JWT) */
  oauthToken: string
  /** Base URL for the API (default: https://api.anthropic.com) */
  baseUrl?: string
  /** Session ID for creating session-specific directories */
  sessionId: string
}
```

파일 크기 제한은 500MB입니다(`MAX_FILE_SIZE_BYTES`, 82행). 다운로드
독립적 재시도 논리 사용(지수 백오프로 3회 시도, 기본
500ms), `withRetry.ts`의 일반 재시도를 재사용하는 대신 —
파일 다운로드 실패 모드(대용량 파일, 디스크 부족)
공간)은 API 호출(429/529 오버로드)과 다르며
독립적인 재시도 예산.

베타 헤더 `files-api-2025-04-14,oauth-2025-04-20` (라인 27)
이는 여전히 진화하는 API임을 나타냅니다. `oauth-2025-04-20`을 사용하면
공개 API 경로에 대한 Bearer OAuth 인증.

-----------------------------------------------------------

## <a href="#what-you-can-do" class="header">할 수 있는 일</a>

1. **529와 모델 성능 저하 사이의 관계를 이해합니다.**
3회 연속 529 과부하 오류가 발생한 후 Claude Code는 자동으로
폴백 모델(일반적으로 Opus에서 Sonnet으로)로 저하됩니다. 만약에
응답 품질이 갑자기 떨어지는 것을 발견했다면 이는
모델 성능이 저하되었습니다. `tengu_api_opus_fallback_triggered`을 확인하세요.
터미널 출력의 이벤트. 이것은 버그가 아닙니다. 시스템은
가용성을 보호합니다.

2. **빠른 모드의 캐시 창을 활용합니다.** 빠른 모드에서 간단한 429 오류가 발생합니다.
모드(재시도 후 \< 20초)에서는 캐시 무효화가 발생하지 않습니다.
Claude Code는 캐시를 보존하기 위해 대기합니다. 하지만 기다려
20초를 초과하면 최소 10분의 쿨다운 기간이 발생합니다.
그 동안 표준 속도로 전환됩니다. 자주보신다면
빠른 모드 쿨다운으로 인해 요청 빈도를 줄여야 할 수도 있습니다.

3. **지속적인 재시도 모드(v2.1.88, Anthropic 내부 빌드에만 해당).**
`CLAUDE_CODE_UNATTENDED_RETRY=1`은 무한 재시도를 활성화합니다(
지수 백오프, 최대 5분), 대기 지원
비율 제한은 다음에 따라 재설정됩니다.
`anthropic-ratelimit-unified-reset` 헤더. 당신이 당신의 건물을 구축하는 경우
자신의 에이전트, 이 "하트비트 연결 유지 + 속도 제한 인식 대기"
패턴은 채택할 가치가 있습니다.

4. **TTFB는 가장 중요한 대기 시간 측정항목입니다.** `--verbose` 모드에서는
Claude Code는 각 API에 대해 TTFB(Time to First Token)를 보고합니다.
부르다. 이 값이 비정상적으로 높을 경우(\>5초)
API 측 과부하 또는 네트워크 문제를 나타냅니다. 또한 시청하세요
`cachedInputTokens` 필드 — 일관되게 0인 경우 프롬프트
캐시가 적중되지 않고 모든 요청에 ​​대해 전체 가격을 지불하고 있습니다.
(자세한 내용은 13장 참조)

5. **스트리밍 시간 초과 임계값을 사용자 정의합니다.** 네트워크가
대기 시간이 긴 환경(예: VPN을 통해 API에 액세스)
또는 위성 링크) 기본 유휴 시간 제한은 90초입니다.
공격적인. 다음을 설정하여 시간 초과 임계값을 조정할 수 있습니다.
`CLAUDE_STREAM_IDLE_TIMEOUT_MS` 환경 변수(또한 필요
`CLAUDE_ENABLE_STREAM_WATCHDOG=1`).

6. **`CLAUDE_CODE_MAX_RETRIES`을(를) 통해 재시도 예산을 조정합니다.**
기본 10회 재시도는 대부분의 시나리오에 적합하지만 API 공급자가
일시적인 오류가 자주 반환되는 경우 이를 늘릴 수 있습니다. 만약 당신이
더 빠른 실패 피드백을 원하면 3~5로 줄일 수 있습니다.

-----------------------------------------------------------

## <a
href="#version-evolution-v21100--bedrockvertex-setup-wizard-and-model-upgrade"
class="header">버전 발전: v2.1.100 — Bedrock/Vertex 설정 마법사
및 모델 업그레이드</a>

> 다음 분석은 v2.1.100 번들 신호 비교를 기반으로 합니다.
> v2.1.88 소스 코드 추론과 결합되었습니다.

### <a href="#interactive-cloud-platform-setup-wizard"
class="header">대화형 클라우드 플랫폼 설정 마법사</a>

v2.1.100에는 AWS Bedrock을 위한 완전한 대화형 설정 마법사가 도입되었습니다.
및 Google Vertex AI, 수동 환경 변수 대체
v2.1.88에서는 구성이 필요합니다. Bedrock을 예로 사용(Vertex
흐름은 대칭임) 전체 설정 수명주기는 3가지 이벤트로 처리됩니다.

``` text
tengu_bedrock_setup_started → tengu_bedrock_setup_complete / tengu_bedrock_setup_cancelled
tengu_vertex_setup_started → tengu_vertex_setup_complete / tengu_vertex_setup_cancelled
```

설정 마법사는 통합 플랫폼 선택 메뉴(사용자)에서 시작됩니다.
Bedrock, Vertex 또는 Microsoft Foundry를 선택할 수 있습니다.
(`oauth_platform_docs_opened` 해당 문서를 엽니다.
페이지). 완료되면 인증 방법(`auth_method`)은 다음과 같습니다.
원격 측정에 기록됩니다.

### <a href="#automatic-model-upgrade-detection" class="header">자동
모델 업그레이드 감지</a>

v2.1.100의 가장 흥미로운 추가 사항은 **자동 모델 업그레이드입니다.
발각**. Anthropic이 새로운 모델 버전을 출시하면 시스템은
사용자의 현재 구성을 변경할 수 있는지 자동으로 감지합니다.
업그레이드됨:

``` text
Detection flow:
  upgrade_check (check for available upgrades)
    → probe_result (probe whether new model is accessible in user's Bedrock/Vertex account)
      → upgrade_accepted / upgrade_declined (user decision)
        → upgrade_relaunch (restart after upgrade) / upgrade_save_failed (save failure)
```

번들에서 추출된 프로빙 로직은 우아한 디자인을 보여줍니다.

``` javascript
// v2.1.100 bundle reverse engineering — Bedrock upgrade probing
// 1. Check unpinned model tiers
d("tengu_bedrock_default_check", { unpinned_tiers: String(q.length) });

// 2. For each unpinned tier, probe whether new model is accessible
let w = await Za8(O, Y.tier);  // Za8 = probeBedrockModel
d("tengu_bedrock_probe_result", {
  tier: Y.tier,
  model_id: O,
  accessible: String(w)
});
```

**주요 설계 결정**:

- 사용자가 명시적으로 고정한 경우 "고정 해제된" 모델 계층만 확인합니다.
환경 변수를 통해 모델 ID를 입력하면 시스템에서 업그레이드를 제안하지 않습니다.
- 거부된 업그레이드는 다음을 통해 사용자 설정에 유지됩니다.
`bedrockDeclinedUpgrades` / `vertexDeclinedUpgrades`, 방지
반복적으로 촉구
- 기본 모델에 액세스할 수 없으면 `default_fallback`이 트리거됩니다.
동일한 계층의 대체 모델로 자동 전환

### <a href="#mantle-authentication-backend" class="header">맨틀
인증 백엔드</a>

v2.1.100에는 다섯 번째 API 인증 백엔드로 `mantle`이 도입되었습니다.
(firstParty, bedrock, vertex 및 Foundry와 함께) 다음을 통해 활성화됨
`CLAUDE_CODE_USE_MANTLE` 환경 변수, 건너뛸 수 있음
`CLAUDE_CODE_SKIP_MANTLE_AUTH`. 맨틀은 `anthropic.` 접두사 모델을 사용합니다.
ID(예: `anthropic.claude-haiku-4-5`)는 이것이
직접 인증과 구별되는 Anthropic 호스팅 기업 인증 채널
API 호출.

### <a href="#api-retry-enhancement" class="header">API 재시도
강화</a>

새로운 `tengu_api_retry_after_too_long` 이벤트는 v2.1.100이 추가되었음을 나타냅니다.
과도한 Retry-After 헤더 값에 대한 특별 처리 — API가
합리적인 임계값을 초과하는 재시도 대기 시간을 반환하면 시스템이
대기를 포기하고 즉시 오류를 보고하도록 선택할 수 있습니다.
사용자가 장기간 응답하지 않는 현상을 방지합니다.
