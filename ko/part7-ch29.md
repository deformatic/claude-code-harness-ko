# <a
href="#chapter-29-observability-engineering--from-logevent-to-production-grade-telemetry"
class="header">29장: 관찰성 엔지니어링 — logEvent에서 프로덕션 등급 원격 측정까지</a>

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

CLI 도구 관찰 가능성은 고유한 제약 조건에 직면해 있습니다. 즉, 지속적인 서버 측이 없고, 사용자 장치에서 코드가 실행되고, 네트워크가 언제든지 중단될 수 있으며, 사용자는 개인 정보 보호에 매우 민감합니다. 기존 웹 서비스는 서버 측에서 계측하고 중앙 집중식 로그를 수집할 수 있지만 Claude Code는 클라이언트에서 이벤트 수집, PII 필터링, 일괄 전달부터 실패 재시도까지 전체 파이프라인을 완료해야 합니다.

Claude Code는 이를 위해 5계층 원격 측정 시스템을 구축했습니다.

<div class="table-wrapper">

| 층 | 책임 | 키 파일 |
|----|----|----|
| **이벤트 응모** | `logEvent()` 큐 연결 패턴 | `services/analytics/index.ts` |
| **라우팅 및 배송** | 이중 경로 디스패치(Datadog + 1P) | `services/analytics/sink.ts` |
| **PII 안전** | 유형 시스템 수준 보호 + 런타임 필터링 | `services/analytics/metadata.ts` |
| **배달 탄력성** | Otel 일괄 처리 + 디스크 영구 재시도 | `services/analytics/firstPartyEventLoggingExporter.ts` |
| **원격 제어** | 기능 플래그 회로 차단기(Kill Switch) | `services/analytics/sinkKillswitch.ts` |

</div>

이 장에서는 단일 `logEvent()` 호출부터 시작하여 이벤트가 샘플링, PII 필터링, 이중 경로 디스패치, 일괄 전달 및 실패 재시도를 통해 어떻게 흐르는지 추적하고 궁극적으로 Datadog 대시보드 또는 Anthropic의 내부 데이터 레이크에 도달하는 방식으로 이 시스템에 대한 완전한 분석을 제공합니다.

------------------------------------------------------------------------

> **대화형 버전**: [원격 측정 파이프라인 애니메이션을 보려면 클릭하세요](telemetry-viz.html) — logEvent()가 유형 확인, 샘플링, PII 필터링을 통해 어떻게 흐르고 최종적으로 Datadog/1P/OTel에 도달하는지 살펴보세요.

## <a href="#source-code-analysis" class="header">소스 코드 분석</a>

### <a
href="#291-telemetry-pipeline-architecture-from-logevent-to-the-data-lake"
class="header">29.1 원격 측정 파이프라인 아키텍처: logEvent()에서 데이터 레이크까지</a>

Claude Code의 원격 측정 파이프라인은 **큐 연결 패턴**을 사용합니다. 즉, 원격 측정 백엔드는 아직 초기화되지 않았을 수 있지만 애플리케이션 시작의 가장 초기 단계에서 이벤트가 생성될 수 있습니다. 해결 방법은 먼저 대기열에 이벤트를 캐시한 다음 백엔드가 준비되면 비동기적으로 비우는 것입니다.

``` typescript
// restored-src/src/services/analytics/index.ts:80-84
// Event queue for events logged before sink is attached
const eventQueue: QueuedEvent[] = []

// Sink - initialized during app startup
let sink: AnalyticsSink | null = null
```

`logEvent()`는 전역 진입점입니다. 전체 코드베이스는 이 기능을 통해 이벤트를 기록합니다. 싱크가 아직 연결되지 않은 경우 이벤트가 큐에 푸시됩니다.

``` typescript
// restored-src/src/services/analytics/index.ts:133-144
export function logEvent(
  eventName: string,
  metadata: LogEventMetadata,
): void {
  if (sink === null) {
    eventQueue.push({ eventName, metadata, async: false })
    return
  }
  sink.logEvent(eventName, metadata)
}
```

`attachAnalyticsSink()`가 호출되면 대기열은 `queueMicrotask()`를 통해 비동기적으로 배수되어 시작 경로를 차단하지 않습니다.

``` typescript
// restored-src/src/services/analytics/index.ts:101-122
if (eventQueue.length > 0) {
  const queuedEvents = [...eventQueue]
  eventQueue.length = 0
  // ... ant-only logging (omitted)
  queueMicrotask(() => {
    for (const event of queuedEvents) {
      if (event.async) {
        void sink!.logEventAsync(event.eventName, event.metadata)
      } else {
        sink!.logEvent(event.eventName, event.metadata)
      }
    }
  })
}
```

이 디자인에는 다음과 같은 중요한 속성이 있습니다. `index.ts` **종속성이 없습니다**(주석에는 "이 모듈에는 가져오기 주기를 피하기 위한 종속성이 없습니다"라고 명시되어 있습니다). 이는 모든 모듈이 순환 가져오기를 트리거하지 않고도 `logEvent`를 안전하게 가져올 수 있음을 의미합니다.

실제 싱크 구현은 이중 경로 디스패치를 ​​담당하는 `sink.ts`에 있습니다.

``` typescript
// restored-src/src/services/analytics/sink.ts:48-72
function logEventImpl(eventName: string, metadata: LogEventMetadata): void {
  const sampleResult = shouldSampleEvent(eventName)
  if (sampleResult === 0) {
    return
  }
  const metadataWithSampleRate =
    sampleResult !== null
      ? { ...metadata, sample_rate: sampleResult }
      : metadata
  if (shouldTrackDatadog()) {
    void trackDatadogEvent(eventName, stripProtoFields(metadataWithSampleRate))
  }
  logEventTo1P(eventName, metadataWithSampleRate)
}
```

두 가지 주요 세부 사항을 확인하세요.

1. **샘플링은 발송 전에 실행됩니다** — `shouldSampleEvent()`는 다운스트림 교정을 위해 메타데이터에 샘플링 속도가 첨부된 GrowthBook 원격 구성을 기반으로 이벤트 삭제 여부를 결정합니다.
2. **Datadog는 `stripProtoFields()`로 처리된 데이터를 수신합니다** — `_PROTO_*` 접두사가 붙은 모든 PII 필드가 제거됩니다. 1P 채널은 완전한 데이터를 수신합니다.

다음 인어 다이어그램은 이벤트 생성부터 최종 저장까지의 전체 경로를 보여줍니다.

``` mermaid
flowchart TD
    A["Any module calls logEvent()"] --> B{Sink attached?}
    B -->|No| C[Push to eventQueue]
    C --> D["attachAnalyticsSink()"]
    D --> E["queueMicrotask async drain"]
    B -->|Yes| F["sink.logEvent()"]
    E --> F
    F --> G["shouldSampleEvent()"]
    G -->|Sampled out| H[Discard]
    G -->|Pass| I["Dual-path dispatch"]
    I --> J["stripProtoFields()"]
    J --> K["Datadog<br/>(real-time alerts)"]
    I --> L["1P logEventTo1P()<br/>(complete data incl. _PROTO_*)"]
    L --> M["OTel BatchLogRecordProcessor"]
    M --> N["FirstPartyEventLoggingExporter"]
    N -->|Success| O["api.anthropic.com<br/>/api/event_logging/batch"]
    N -->|Failure| P["~/.claude/telemetry/<br/>disk persistence"]
    P --> Q["Quadratic backoff retry"]
    Q --> N

    style K fill:#f9a825,color:#000
    style O fill:#4caf50,color:#fff
    style P fill:#ef5350,color:#fff
```

원격 회로 차단기 메커니즘은 의도적으로 난독화된 GrowthBook 구성 이름을 사용하여 `sinkKillswitch.ts`를 통해 구현됩니다.

``` typescript
// restored-src/src/services/analytics/sinkKillswitch.ts:4
const SINK_KILLSWITCH_CONFIG_NAME = 'tengu_frond_boric'
```

구성 값은 `{ datadog?: boolean, firstParty?: boolean }` 개체이며, `true`를 설정하면 해당 채널이 비활성화됩니다. 이 설계를 통해 Anthropic은 새 버전을 출시하지 않고도 원격 측정을 원격으로 비활성화할 수 있습니다. 예를 들어 이벤트 유형이 예기치 않게 민감한 데이터를 전달하는 경우 몇 분 내에 출혈을 멈출 수 있습니다. 기능 플래그 메커니즘에 대한 자세한 내용은 23장을 참조하세요.

### <a href="#292-pii-safety-architecture-type-system-level-protection"
class="header">29.2 PII 안전 아키텍처: 유형-시스템-수준 보호</a>

Claude Code의 PII 보호는 코드 검토 및 문서 규칙에 의존하지 않고 TypeScript의 유형 시스템을 통해 **컴파일 시 적용**됩니다. 핵심은 두 개의 `never` 유형 마커입니다.

``` typescript
// restored-src/src/services/analytics/index.ts:19
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

// restored-src/src/services/analytics/index.ts:33
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never
```

`never` 유형을 사용하는 이유는 무엇입니까? `never`는 어떤 값도 보유할 수 없기 때문에 `as` 강제 캐스팅을 통해서만 할당할 수 있습니다. 이는 개발자가 원격 측정 이벤트에 문자열을 기록하려고 할 때마다 `myString as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`를 작성해야 함을 의미합니다. 이 장황한 유형 이름 자체가 체크리스트입니다. "이것이 코드나 파일 경로가 아니라는 것을 확인했습니다."

섹션 29.1에 표시된 `logEvent()` 서명을 되돌아보면 해당 메타데이터 매개변수 유형은 `{ [key: string]: boolean | number | undefined }`입니다. **문자열은 허용되지 않습니다**. 소스 코드 주석에는 "실수로 코드/파일 경로를 기록하는 것을 방지하기 위해 AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS가 아니면 의도적으로 문자열이 없습니다."라고 명시되어 있습니다. 문자열을 전달하려면 강제 캐스팅용 마커 유형을 사용해야 합니다.

실제로 PII 데이터(예: 기술 이름, MCP 서버 이름)를 기록해야 하는 시나리오의 경우 `_PROTO_` 접두사 필드가 사용됩니다.

``` typescript
// restored-src/src/services/analytics/firstPartyEventLoggingExporter.ts:719-724
const {
  _PROTO_skill_name,
  _PROTO_plugin_name,
  _PROTO_marketplace_name,
  ...rest
} = formatted.additional
const additionalMetadata = stripProtoFields(rest)
```

`_PROTO_*` 필드 라우팅 논리:

- **Datadog**: `sink.ts`는 모든 `_PROTO_*` 필드를 제거하기 위해 파견 전에 `stripProtoFields()`를 호출하므로 Datadog은 PII를 볼 수 없습니다.
- **1P 내보내기**: 알려진 `_PROTO_*` 필드를 해체하여 최상위 proto 필드(BigQuery 권한 열에 저장됨)로 승격한 다음 인식할 수 없는 새 필드가 누출되는 것을 방지하기 위해 나머지 필드에서 `stripProtoFields()`를 다시 실행합니다.

MCP 도구 이름 처리는 점진적인 공개 전략을 보여줍니다.

``` typescript
// restored-src/src/services/analytics/metadata.ts:70-77
export function sanitizeToolNameForAnalytics(
  toolName: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  if (toolName.startsWith('mcp__')) {
    return 'mcp_tool' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }
  return toolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}
```

MCP 도구 이름은 `mcp__<server>__<tool>` 형식을 가지며, 여기서 서버 이름은 사용자 구성 정보(PII-medium)를 노출할 수 있습니다. 기본적으로 모든 MCP 도구는 `'mcp_tool'`로 대체됩니다. 그러나 자세한 이름을 기록할 수 있는 세 가지 예외 사례가 있습니다.

1. 공동 작업 모드(`entrypoint=local-agent`) - ZDR 개념 없음
2. `claudeai-proxy` 유형 MCP 서버 — clude.ai 공식 목록에서
3. URL이 공식 MCP 레지스트리와 일치하는 서버

파일 확장자 처리 역시 조심스럽습니다. 10자를 초과하는 확장자는 `'other'`로 대체됩니다. 너무 긴 "확장자"는 해시된 파일 이름(예: `key-hash-abcd-123-456`)일 수 있기 때문입니다.

### <a href="#293-1p-event-delivery-opentelemetry--disk-persistent-retry"
class="header">29.3 1P 이벤트 전달: OpenTelemetry + 디스크 영구 재시도</a>

1P(자사) 채널은 Claude Code 원격 측정의 핵심입니다. 이는 오프라인 분석을 위해 BigQuery에 저장된 Anthropic의 자체 호스팅 `/api/event_logging/batch` 엔드포인트에 이벤트를 전달합니다.

아키텍처는 OpenTelemetry SDK를 기반으로 합니다.

``` typescript
// restored-src/src/services/analytics/firstPartyEventLogger.ts:362-389
const eventLoggingExporter = new FirstPartyEventLoggingExporter({
  maxBatchSize: maxExportBatchSize,
  skipAuth: batchConfig.skipAuth,
  maxAttempts: batchConfig.maxAttempts,
  path: batchConfig.path,
  baseUrl: batchConfig.baseUrl,
  isKilled: () => isSinkKilled('firstParty'),
})
firstPartyEventLoggerProvider = new LoggerProvider({
  resource,
  processors: [
    new BatchLogRecordProcessor(eventLoggingExporter, {
      scheduledDelayMillis,
      maxExportBatchSize,
      maxQueueSize,
    }),
  ],
})
```

OTel의 `BatchLogRecordProcessor`는 다음 조건 중 하나라도 충족되면 내보내기를 트리거합니다.

- 시간 간격 도달(기본값 10초, `tengu_1p_event_batch_config` 원격 구성을 통해 구성 가능)
- 배치 크기 제한에 도달했습니다(기본값 200개 이벤트).
- 대기열 가득 참(기본 8192 이벤트)

그러나 실제 엔지니어링 과제는 맞춤형 `FirstPartyEventLoggingExporter`(806라인)에 있습니다. 이 내보내기 기능은 표준 OTel 내보내기 위에 CLI 도구에 필요한 복원력을 추가합니다.

**일괄 샤딩 + 배치 간 지연**: 대규모 이벤트 배치는 여러 개의 작은 배치(각각 최대 `maxBatchSize`)로 분할되며 배치 간 지연 시간은 100ms입니다.

``` typescript
// restored-src/src/services/analytics/firstPartyEventLoggingExporter.ts:379-421
private async sendEventsInBatches(
  events: FirstPartyEventLoggingEvent[],
): Promise<FirstPartyEventLoggingEvent[]> {
  const batches: FirstPartyEventLoggingEvent[][] = []
  for (let i = 0; i < events.length; i += this.maxBatchSize) {
    batches.push(events.slice(i, i + this.maxBatchSize))
  }
  // ...
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!
    try {
      await this.sendBatchWithRetry({ events: batch })
    } catch (error) {
      // Short-circuit all subsequent batches on first batch failure
      for (let j = i; j < batches.length; j++) {
        failedBatchEvents.push(...batches[j]!)
      }
      break
    }
    if (i < batches.length - 1 && this.batchDelayMs > 0) {
      await sleep(this.batchDelayMs)
    }
  }
  return failedBatchEvents
}
```

단락 논리에 유의하십시오. 첫 번째 배치가 실패하면 엔드포인트를 사용할 수 없다고 가정하고 나머지 모든 배치를 즉시 실패로 표시하여 쓸데없는 네트워크 요청을 방지합니다.

**2차 백오프 재시도**: 실패한 이벤트는 2차 백오프를 사용합니다(Statsig SDK 전략과 일치).

``` typescript
// restored-src/src/services/analytics/firstPartyEventLoggingExporter.ts:451-455
// Quadratic backoff (matching Statsig SDK): base * attempts²
const delay = Math.min(
  this.baseBackoffDelayMs * this.attempts * this.attempts,
  this.maxBackoffDelayMs,
)
```

기본 매개변수: `baseBackoffDelayMs=500`, `maxBackoffDelayMs=30000`, `maxAttempts=8`. 8번의 내보내기 시도는 최대 7번의 백오프 지연을 발생시킵니다: 500ms → 2s → 4.5s → 8s → 12.5s → 18s → 24.5s(8번째 시도가 실패하면 이벤트는 추가 백오프 없이 삭제됩니다).

**401 저하된 재시도**: 인증 실패 시 포기하는 대신 인증 없이 자동으로 재시도합니다.

``` typescript
// restored-src/src/services/analytics/firstPartyEventLoggingExporter.ts:593-611
if (
  useAuth &&
  axios.isAxiosError(error) &&
  error.response?.status === 401
) {
  // 401 auth error, retrying without auth
  const response = await axios.post(this.endpoint, payload, {
    timeout: this.timeout,
    headers: baseHeaders,
  })
  this.logSuccess(payload.events.length, false, response.data)
  return
}
```

이 디자인은 OAuth 토큰이 만료되었지만 자동으로 새로 고칠 수 없는 시나리오를 처리합니다. 원격 측정 데이터는 서버 측에서 사용자 ID 연결 없이도 인증되지 않은 채널을 통해 계속 서버에 도달할 수 있습니다.

**디스크 지속성**: 실패한 내보내기 이벤트가 JSONL 파일에 추가됩니다.

``` typescript
// restored-src/src/services/analytics/firstPartyEventLoggingExporter.ts:44-46
function getStorageDir(): string {
  return path.join(getClaudeConfigHomeDir(), 'telemetry')
}
```

파일 경로 형식은 `~/.claude/telemetry/1p_failed_events.<sessionId>.<batchUUID>.json`입니다. 추가 쓰기에 `appendFile`를 사용합니다. 각 세션은 파일 이름 지정에 고유한 세션 ID + 배치 UUID를 사용하므로 여러 프로세스가 동시에 동일한 파일에 쓰는 시나리오는 사실상 없습니다.

**시작 시 자동 재전송**: 내보내기 생성자는 `retryPreviousBatches()`를 호출하여 동일한 세션 ID의 다른 배치 UUID에서 실패한 파일을 검색하고 백그라운드에서 재전송합니다.

``` typescript
// restored-src/src/services/analytics/firstPartyEventLoggingExporter.ts:137-138
// Retry any failed events from previous runs of this session (in background)
void this.retryPreviousBatches()
```

**런타임 핫 리로드**: GrowthBook 구성이 새로 고쳐지면 `reinitialize1PEventLoggingIfConfigChanged()`는 일련의 널 로거(새 이벤트 일시 중지됨) → `forceFlush()` 이전 공급자 → 새 공급자 초기화 → 이전 공급자 백그라운드 종료를 통해 이벤트 손실 없이 전체 파이프라인을 재구축할 수 있습니다.

<div class="table-wrapper">

| 특징 | 1P 수출업체 | 표준 Otel HTTP 내보내기 |
|----|----|----|
| 일괄 샤딩 | maxBatchSize로 분할, 배치 간 지연 100ms | 없음(단일 일괄 전송) |
| 실패 처리 | 디스크 지속성 + 2차 백오프 + 단락 | 제한된 재시도 후 삭제(메모리 내, 지속성 없음) |
| 입증 | OAuth → 401이 인증되지 않음으로 저하됨 | 고정 헤더 |
| 세션 간 복구 | 시작 검사 및 이전 실패 재전송 | 없음 |
| 원격 제어 | 킬스위치 + GrowthBook 핫 구성 | 없음 |
| PII 처리 | `_PROTO_*` 프로모션 + `stripProtoFields()` | 없음 |

</div>

### <a href="#294-datadog-integration-curated-event-allowlist"
class="header">29.4 Datadog 통합: 선별된 이벤트 허용 목록</a>

Datadog 채널은 **실시간 알림**에 사용되며 1P 채널의 오프라인 분석을 보완합니다. 핵심 디자인 기능은 선별된 허용 목록입니다.

``` typescript
// restored-src/src/services/analytics/datadog.ts:19-64 (excerpt)
const DATADOG_ALLOWED_EVENTS = new Set([
  'chrome_bridge_connection_succeeded',
  'chrome_bridge_connection_failed',
  // ... chrome_bridge_* events
  'tengu_api_error',
  'tengu_api_success',
  'tengu_cancel',
  'tengu_exit',
  'tengu_init',
  'tengu_started',
  'tengu_tool_use_error',
  'tengu_tool_use_success',
  'tengu_uncaught_exception',
  'tengu_unhandled_rejection',
  // ... approximately 38 events total
])
```

목록에 있는 이벤트만 Datadog으로 전송됩니다. 이는 데이터 노출 표면을 외부 서비스로 제한합니다. `stripProtoFields()` PII 스트리핑과 결합된 Datadog은 안전하고 제한된 운영 데이터만 볼 수 있습니다.

Datadog은 공용 클라이언트 토큰(`pubbbf48e6d78dae54bceaa4acf463299bf`), 일괄 플러시 간격 15초, 일괄 처리 제한 100개 항목, 네트워크 시간 초과 5초를 사용합니다.

The tag system (TAG_FIELDS) covers key dimensions: `arch`, `platform`, `model`, `userType`, `toolName`, `subscriptionType`, etc. Note that MCP tools are further compressed to `'mcp'` at the Datadog level (rather than `'mcp_tool'`), 카디널리티를 줄입니다.

사용자 버킷팅 디자인은 주목할 만합니다.

``` typescript
// restored-src/src/services/analytics/datadog.ts:295-298
const getUserBucket = memoize((): number => {
  const userId = getOrCreateUserID()
  const hash = createHash('sha256').update(userId).digest('hex')
  return parseInt(hash.slice(0, 8), 16) % NUM_USER_BUCKETS
})
```

사용자 ID는 해시되어 30개 버킷 중 하나에 할당됩니다. This allows approximating unique user counts by counting unique buckets, while avoiding the cardinality explosion and privacy issues of directly recording user IDs.

### <a href="#295-api-call-observability-from-request-to-retry"
class="header">29.5 API 호출 관찰성: 요청부터 재시도까지</a>

API 호출은 Claude Code의 가장 중요한 작업 경로입니다. 각 에이전트 루프 반복(자세한 내용은 3장 참조)은 하나 이상의 API 호출을 트리거하여 완전한 원격 측정 이벤트 체인을 생성합니다. `services/api/logging.ts`는 **3가지 이벤트 모델**을 구현합니다.

1. **`tengu_api_query`**: 모델 이름, 토큰 예산, 캐시 구성을 포함하여 요청이 전송될 때 기록됩니다.
2. **`tengu_api_success`**: 성능 지표를 포함하여 요청 성공 시 기록됨
3. **`tengu_api_error`**: 오류 유형 및 상태 코드를 포함하여 요청 실패 시 기록됨

성능 지표는 특히 주목할 만합니다.

- **TTFT(Time to First Token)**: 요청 전송부터 첫 번째 토큰 수신까지의 시간으로, 모델 시작 지연 시간을 측정합니다.
- **TTLT(Time to Last Token)**: 요청 전송부터 마지막 ​​토큰 수신까지의 시간으로 전체 응답 시간을 측정합니다.
- **총 소요시간**: 네트워크 왕복 포함
- **각 재시도에 대한 독립적인 타임스탬프**

재시도 원격 측정은 `services/api/withRetry.ts`를 통해 구현됩니다. 각 재시도는 재시도 이유, 백오프 시간 및 HTTP 상태 코드를 포함하는 독립적인 이벤트(`tengu_api_retry`)로 기록됩니다.

429/529 상태 코드는 다르게 처리됩니다.

- **429(속도 제한)**: 표준 백오프, 고속 모드에서 30분 쿨다운 트리거(자세한 내용은 21장 참조)
- **529(오버로드)**: 서버 측 과부하, 더욱 공격적인 백오프 전략
- **백그라운드 요청**: 빠른 중단, 사용자 포그라운드 작업을 차단하지 않음

게이트웨이 지문 감지는 방어적인 설계입니다. 사용자가 프록시 게이트웨이(예: LiteLLM, Helicone, Portkey, Cloudflare, Kong)를 통해 API에 액세스하면 Claude Code는 게이트웨이 유형을 감지하고 기록합니다. 이는 Anthropic이 자체 API 문제와 제3자 프록시로 인해 발생하는 문제를 구별하는 데 도움이 됩니다.

### <a href="#296-tool-execution-telemetry" class="header">29.6 도구 실행 원격 측정</a>

도구 실행은 `services/tools/toolExecution.ts`를 통해 네 가지 이벤트 유형을 기록합니다.

- **`tengu_tool_use_success`**: 도구가 성공적으로 실행되었습니다.
- **`tengu_tool_use_error`**: 도구 실행 오류
- **`tengu_tool_use_cancelled`**: 사용자가 취소됨
- **`tengu_tool_use_rejected_in_prompt`**: 권한이 거부되었습니다.

각 이벤트에는 실행 기간, 결과 크기(바이트) 및 파일 확장자(보안 필터링됨)가 포함됩니다. MCP 도구의 경우 섹션 29.2에 설명된 점진적 공개 전략을 따릅니다.

전체 도구 실행 수명주기(validateInput → checkPermissions → 호출 → postToolUse 후크)는 4장에서 자세히 분석되었으며 여기서는 반복하지 않습니다.

### <a href="#297-cache-efficiency-tracking" class="header">29.7 캐시 효율성 추적</a>

캐시 중단 감지 시스템(`promptCacheBreakDetection.ts`)은 원격 측정과 캐시 최적화의 교차점입니다. 각 API 호출 전에 `PreviousState`를 스냅샷하고(systemHash, toolsHash, 캐시ControlHash를 포함한 15개 이상의 필드 포함) 응답을 받은 후 실제 캐시 적중 결과를 비교합니다.

캐시 중단이 감지되면(`cache_read_input_tokens`가 2000개 이상의 토큰 삭제) 중단 컨텍스트의 20개 이상의 필드를 전달하는 `tengu_prompt_cache_break` 이벤트가 생성됩니다. 2000개 토큰 노이즈 필터링 임계값은 사소한 변동으로 인한 오탐을 방지합니다.

이 시스템의 세부 설계는 14장에서 심층적으로 분석되었습니다. here we only note its position in the telemetry system: it is a paradigm practice of Claude Code's "observe before you fix" philosophy (see Chapter 25 for details).

### <a href="#298-three-debugdiagnostic-channels" class="header">29.8 세 개의 디버그/진단 채널</a>

Claude Code는 각각 서로 다른 사용 사례와 PII 정책을 포함하는 세 가지 독립적인 디버그/진단 채널을 제공합니다.

<div class="table-wrapper">

| 채널 | 파일 | 방아쇠 | PII 정책 | 출력 위치 | 사용 사례 |
|----|----|----|----|----|----|
| **디버그 로그** | `utils/debug.ts` | `--debug` 또는 `/debug` | PII를 포함할 수 있음 | `~/.claude/debug/<session>.log` | 개미의 경우 개발자 디버깅이 기본적으로 켜져 있습니다. |
| **진단 로그** | `utils/diagLogs.ts` | `CLAUDE_CODE_DIAGNOSTICS_FILE` 환경 변수 | **PII는 엄격히 금지됩니다** | 컨테이너 지정 경로 | 세션 수신을 통한 컨테이너 모니터링 |
| **오류 로그** | `utils/errorLogSink.ts` | 자동(ant 전용 파일 출력) | 오류 정보(제어됨) | `~/.claude/errors/<date>.jsonl` | 오류 후향적 분석 |

</div>

**디버그 로그**(`utils/debug.ts`)는 다양한 활성화 방법을 지원합니다.

``` typescript
// restored-src/src/utils/debug.ts:44-57
export const isDebugMode = memoize((): boolean => {
  return (
    runtimeDebugEnabled ||
    isEnvTruthy(process.env.DEBUG) ||
    isEnvTruthy(process.env.DEBUG_SDK) ||
    process.argv.includes('--debug') ||
    process.argv.includes('-d') ||
    isDebugToStdErr() ||
    process.argv.some(arg => arg.startsWith('--debug=')) ||
    getDebugFilePath() !== null
  )
})
```

Ant 사용자(Anthropic 내부)는 기본적으로 디버그 로그를 작성합니다. 외부 사용자는 이를 명시적으로 활성화해야 합니다. `/debug` 명령은 세션을 다시 시작하지 않고도 런타임 활성화(`enableDebugLogging()`)를 지원합니다. 로그 파일은 빠른 액세스를 위해 최신 로그 파일을 가리키는 `latest` 심볼릭 링크를 자동으로 생성합니다.

로그 수준 시스템은 `CLAUDE_CODE_DEBUG_LOG_LEVEL` 환경 변수를 통해 제어되는 5단계 필터링(자세한 정보 → 디버그 → 정보 → 경고 → 오류)을 지원합니다. `--debug=pattern` 구문은 특정 모듈에 대한 로그 필터링을 지원합니다.

**진단 로그**(`utils/diagLogs.ts`)는 PII가 안전한 컨테이너 진단 채널로, 컨테이너 환경 관리자가 읽고 세션 수신 서비스로 전송되도록 설계되었습니다.

``` typescript
// restored-src/src/utils/diagLogs.ts:27-31
export function logForDiagnosticsNoPII(
  level: DiagnosticLogLevel,
  event: string,
  data?: Record<string, unknown>,
): void {
```

함수 이름의 `NoPII` 접미사는 의도적인 명명 규칙입니다. 이는 호출자에게 상기시키고 코드 검토를 용이하게 합니다. 출력 형식은 타임스탬프, 레벨, 이벤트 이름 및 데이터를 포함하는 JSONL(한 줄에 하나의 JSON 개체)입니다. 동기 쓰기(`appendFileSync`)는 종료 경로에서 자주 호출되므로 사용됩니다.

`withDiagnosticsTiming()` 래퍼 기능은 `duration_ms`가 연결된 비동기 작업을 위한 `_started` 및 `_completed` 이벤트 쌍을 자동으로 생성합니다.

### <a href="#299-distributed-tracing-opentelemetry--perfetto"
class="header">29.9 분산 추적: OpenTelemetry + Perfetto</a>

Claude Code의 추적 시스템은 OTel 기반 구조적 추적과 Perfetto 기반 시각적 추적의 두 가지 계층으로 나뉩니다.

**OTel 추적**(`utils/telemetry/sessionTracing.ts`)은 3단계 범위 계층 구조를 사용합니다.

1. **상호작용 범위**: 사용자 요청 래핑 → 클로드 응답 주기
2. **LLM 요청 범위**: 단일 API 호출
3. **도구 범위**: 단일 도구 실행(하위 범위 포함: Blocked_on_user, tool.execution, 후크)

범위 컨텍스트는 `AsyncLocalStorage`를 통해 전파되어 비동기 호출 체인 전체에서 올바른 상위-하위 연결을 보장합니다. 에이전트 계층 구조(주 에이전트 → 하위 에이전트)는 상위-하위 범위 관계를 통해 표현됩니다.

중요한 엔지니어링 세부 사항은 **고아 범위 정리**입니다.

``` typescript
// restored-src/src/utils/telemetry/sessionTracing.ts:79
const SPAN_TTL_MS = 30 * 60 * 1000 // 30 minutes
```

활성 스팬은 60초마다 검사되며, 30분 이내에 종료되지 않은 스팬은 강제 종료되고 레지스트리에서 제거됩니다. 이는 비정상적인 중단(예: 스트림 취소, 도구 실행 중 포착되지 않은 예외)으로 인한 범위 누수를 처리합니다. `activeSpans`는 `WeakRef`를 사용하여 GC가 도달할 수 없는 범위 컨텍스트를 회수할 수 있도록 합니다.

기능 게이트 제어(`ENHANCED_TELEMETRY_BETA`)는 기본적으로 추적을 유지하여 환경 변수 또는 사용자 그룹당 GrowthBook 점진적 출시를 통해 활성화합니다.

**Perfetto 추적**(`utils/telemetry/perfettoTracing.ts`)은 Ant 전용 시각적 추적으로, ui.perfetto.dev에서 분석할 수 있는 Chrome 추적 이벤트 형식 JSON 파일을 생성합니다.

``` typescript
// restored-src/src/utils/telemetry/perfettoTracing.ts:16
// Enable via CLAUDE_CODE_PERFETTO_TRACE=1 or CLAUDE_CODE_PERFETTO_TRACE=<path>
```

추적 파일에는 다음이 포함됩니다.

- 에이전트 계층 관계(프로세스 ID를 사용하여 다양한 에이전트 구별)
- API 요청 세부정보(TTFT, TTLT, 캐시 적중률, 추측 플래그)
- 도구 실행 세부정보(이름, 기간, 토큰 사용)
- 사용자 입력 대기 시간

이벤트 배열에는 상한 가드(`MAX_EVENTS = 100_000`)가 있으며, 도달하면 가장 오래된 절반이 제거됩니다. 이는 장기 실행 세션(예: cron 구동 세션)이 메모리를 무기한 늘리는 것을 방지합니다. 메타데이터 이벤트(프로세스/스레드 이름)는 Perfetto UI가 트랙 레이블에 필요하기 때문에 제거에서 제외됩니다.

### <a href="#2910-crash-recovery-and-graceful-shutdown"
class="header">29.10 충돌 복구 및 정상 종료</a>

`utils/gracefulShutdown.ts`(529줄)는 "라스트 마일" 원격 측정 데이터 전달의 핵심인 Claude Code의 우아한 종료 시퀀스를 구현합니다.

종료 트리거 소스에는 SIGINT(Ctrl+C), SIGTERM, SIGHUP 및 macOS 관련 **고아 프로세스 감지**가 포함됩니다.

``` typescript
// restored-src/src/utils/gracefulShutdown.ts:281-296
if (process.stdin.isTTY) {
  orphanCheckInterval = setInterval(() => {
    if (getIsScrollDraining()) return
    if (!process.stdout.writable || !process.stdin.readable) {
      clearInterval(orphanCheckInterval)
      void gracefulShutdown(129)
    }
  }, 30_000)
  orphanCheckInterval.unref()
}
```

macOS는 터미널이 닫힐 때 항상 SIGHUP을 보내지는 않지만 대신 TTY 파일 설명자를 취소합니다. 30초마다 stdout/stdin이 지속적인 가용성을 확인합니다.

종료 시퀀스는 **계단식 시간 초과** 설계를 사용합니다.

``` mermaid
sequenceDiagram
    participant S as Signal/Trigger
    participant T as Terminal
    participant C as Cleanup
    participant H as SessionEnd Hooks
    participant A as Analytics
    participant E as Exit

    S->>T: 1. cleanupTerminalModes()<br/>Restore terminal state (sync)
    T->>T: 2. printResumeHint()<br/>Show resume hint
    T->>C: 3. runCleanupFunctions()<br/>⏱️ 2s timeout
    C->>H: 4. executeSessionEndHooks()<br/>⏱️ 1.5s default
    H->>A: 5. shutdown1PEventLogging()<br/>+ shutdownDatadog()<br/>⏱️ 500ms
    A->>E: 6. forceExit()

    Note over S,E: Failsafe: max(5s, hookTimeout + 3.5s)
```

주요 설계 결정:

1. **터미널 모드 복원이 먼저 실행됩니다** — 비동기 작업 전에 터미널 상태를 동기적으로 복원합니다. 정리 중에 SIGKILL이 발생하면 최소한 터미널은 손상된 상태가 되지 않습니다.
2. **정리 기능에는 독립적인 시간 제한이 있습니다**(2초) — `Promise.race`를 통해 구현되어 MCP 연결 중단을 방지합니다.
3. **SessionEnd 후크에는 예산이 있습니다**(기본값 1.5초) — `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`를 통해 사용자가 구성할 수 있습니다.
4. **500ms로 제한되는 분석 플러시** — 이전에는 무제한이었기 때문에 1P 내보내기가 보류 중인 모든 Axios POST(각각 10초 제한 시간)를 기다리게 하여 잠재적으로 전체 안전 장치 예산을 소비하게 되었습니다.
5. **안전 장치 타이머** 동적으로 계산: `max(5000, sessionEndTimeoutMs + 3500)`, 후크 예산에 충분한 시간이 확보되도록 보장합니다.

`forceExit()`는 극단적인 경우를 처리합니다. `process.exit()`가 데드 터미널(EIO 오류)로 인해 발생하면 `SIGKILL`로 대체됩니다.

``` typescript
// restored-src/src/utils/gracefulShutdown.ts:213-222
try {
  process.exit(exitCode)
} catch (e) {
  if ((process.env.NODE_ENV as string) === 'test') {
    throw e
  }
  process.kill(process.pid, 'SIGKILL')
}
```

포착되지 않은 예외와 처리되지 않은 Promise 거부는 PII 없는 진단 로그에 기록되고 분석으로 전송되는 이중 채널을 통해 기록됩니다.

``` typescript
// restored-src/src/utils/gracefulShutdown.ts:301-310
process.on('uncaughtException', error => {
  logForDiagnosticsNoPII('error', 'uncaught_exception', {
    error_name: error.name,
    error_message: error.message.slice(0, 2000),
  })
  logEvent('tengu_uncaught_exception', {
    error_name:
      error.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
})
```

`error.name`(예: "TypeError")는 민감하지 않은 정보로 판단되어 안전하게 기록될 수 있다는 점에 유의하세요. 긴 스택 추적이 과도한 스토리지를 소비하는 것을 방지하기 위해 오류 메시지는 2000자로 잘립니다.

### <a href="#2911-cost-tracking-and-usage-visualization"
class="header">29.11 비용 추적 및 사용량 시각화</a>

`cost-tracker.ts`는 USD 비용, 토큰 사용(입력/출력/캐시 생성/캐시 읽기) 추적, 코드 줄 변경 및 세션 전반에 걸쳐 지속을 추적하여 Claude Code의 런타임 비용 회계를 관리합니다.

비용 상태에는 전체 리소스 소비 스냅샷이 포함됩니다.

``` typescript
// restored-src/src/cost-tracker.ts:71-80
type StoredCostState = {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}
```

비용 상태는 `lastSessionId`로 입력되는 프로젝트 구성(`.claude.state`)에 저장됩니다. 세션 ID가 일치하는 경우에만 이전 비용 데이터가 복원되므로 서로 다른 세션 간의 교차 오염을 방지할 수 있습니다. API 호출이 성공할 때마다 `addToTotalSessionCost()`는 토큰 사용량을 축적하고 이를 `logEvent`를 통해 원격 측정 파이프라인에 기록하여 로컬 디스플레이와 원격 분석 모두에 비용 데이터를 사용할 수 있도록 합니다.

`/cost` 명령의 출력은 구독자와 비구독자를 구분합니다. 즉, 구독자는 더 자세한 사용량 분석을 볼 수 있고, 비구독자는 소비 패턴을 이해하는 데 중점을 둡니다.

------------------------------------------------------------------------

## <a href="#pattern-distillation" class="header">패턴 증류</a>

### <a href="#pattern-1-type-system-level-pii-protection"
class="header">패턴 1: 유형 시스템 수준 PII 보호</a>

**문제**: 원격 측정 이벤트에 실수로 민감한 데이터(파일 경로, 코드 조각, 사용자 구성)가 포함될 수 있습니다. 코드 검토 및 문서화 규칙으로는 이를 확실하게 방지할 수 없습니다.

**해결책**: `never` 유형 마커를 사용하여 개발자가 데이터 안전성을 명시적으로 선언하도록 합니다.

``` typescript
// Pattern template
type PII_VERIFIED = never
function logEvent(data: { [k: string]: number | boolean | undefined }): void
// To pass a string, you must:
logEvent({ name: value as PII_VERIFIED })
```

**전제 조건**: TypeScript 또는 이와 유사한 강력한 유형 시스템을 사용합니다. 유형 표시의 이름은 `as` 캐스팅 자체를 검토할 수 있도록 충분히 설명적이어야 합니다.

### <a href="#pattern-2-dual-path-telemetry-delivery" class="header">패턴 2: 이중 경로 원격 측정 전달</a>

**문제**: 단일 원격 측정 채널은 실시간 알림(낮은 대기 시간, 저렴한 비용)과 오프라인 분석(완전한 데이터, 높은 신뢰성)을 동시에 충족할 수 없습니다.

**해결책**: 원격 측정을 두 채널로 디스패치합니다. 실시간 채널은 허용 목록과 PII 제거를 사용하고 오프라인 채널은 전체 데이터를 유지합니다.

**전제 조건**: 두 채널의 보안 수준과 SLA가 다릅니다. 허용 목록에는 지속적인 유지 관리가 필요합니다.

### <a href="#pattern-3-disk-persistent-retry" class="header">패턴 3: 디스크 영구 재시도</a>

**문제**: CLI 도구가 사용자 장치에서 실행되고 네트워크가 불안정하며 프로세스가 언제든지 종료될 수 있습니다. 프로세스 종료 시 메모리 내 재시도 대기열이 손실됩니다.

**해결책**: 실패한 이벤트는 디스크 파일(JSONL 형식, 세션당 하나의 파일)에 추가되고, 시작 시 이전 세션의 실패한 이벤트를 검색하여 다시 전송합니다.

**전제 조건**: 쓰기 권한이 있는 파일 시스템을 사용할 수 있습니다. 이벤트에는 암호화된 저장이 필요한 데이터가 포함되어 있지 않습니다(PII는 쓰기 전에 이미 필터링됨).

### <a href="#pattern-4-curated-event-allowlist" class="header">패턴 4: 선별된 이벤트 허용 목록</a>

**문제**: 이벤트를 외부 서비스(Datadog)로 전송하려면 데이터 노출 표면을 제어해야 합니다. 새로운 이벤트 유형은 실수로 중요한 정보를 전달할 수 있습니다.

**해결책**: `Set`를 사용하여 명시적인 허용 목록을 정의하세요. 목록에 없는 이벤트는 자동으로 삭제됩니다. 새 이벤트를 목록에 명시적으로 추가하여 검토 체크포인트를 생성해야 합니다.

**전제 조건**: 기능이 반복되면 허용 목록을 업데이트해야 합니다. 그렇지 않으면 새 이벤트가 외부 서비스에 도달하지 않습니다.

### <a href="#pattern-5-cascading-timeout-graceful-shutdown"
class="header">패턴 5: 계단식 시간 초과 정상적인 종료</a>

**문제**: 프로세스 종료 시 여러 정리 작업(터미널 복원, 세션 저장, 후크 실행, 원격 측정 플러시)을 완료해야 하지만 모든 단계가 중단될 수 있습니다.

**해결책**: 레이어당 독립적인 시간 초과 + 전체 안전 장치. 우선순위: 터미널 복원(동기식, 첫 번째) → 데이터 지속성 → 후크 → 원격 측정. 비상 안전 시간 초과 = 최대(하드 플로어, 후크 예산 + 마진).

**전제조건**: 정리 작업 간의 우선순위가 명확하게 정의되어 있습니다. 가장 중요한 작업(터미널 복원)은 동기식이어야 합니다.

------------------------------------------------------------------------

## <a
href="#ccs-opentelemetry-implementation-from-logevent-to-standardized-telemetry"
class="header">CC의 OpenTelemetry 구현: logEvent에서 표준화된 원격 측정으로</a>

이전 분석에서는 CC의 860개 이상의 `tengu_*` 이벤트와 `logEvent()` 통화 패턴을 다루었습니다. 그러나 더 깊은 계층에서 CC는 **완전한 OpenTelemetry 원격 측정 인프라**를 구축하여 이벤트 로깅, 분산 추적 및 메트릭 측정을 OTel 표준 프레임워크에 통합했습니다.

### <a href="#three-otel-scopes" class="header">세 개의 Otel 범위</a>

CC는 각각 고유한 책임을 지닌 3개의 독립적인 OTel 범위를 등록합니다.

<div class="table-wrapper">

| 범위 | Otel 구성 요소 | 목적 |
|----|----|----|
| `com.anthropic.claude_code.events` | 나무꾼 | 이벤트 로깅(860개 이상의 텐구 이벤트) |
| `com.anthropic.claude_code.tracing` | 트레이서 | 분산 추적(API 호출, 도구 실행) |
| `com.anthropic.claude_code` | 미터 | 측정항목 측정(OTLP/Prometheus/BigQuery) |

</div>

``` typescript
// restored-src/src/utils/telemetry/instrumentation.ts:602-606
const eventLogger = logs.getLogger(
  'com.anthropic.claude_code.events',
  MACRO.VERSION,
)
```

### <a href="#span-hierarchy-structure" class="header">범위 계층 구조</a>

CC의 추적 시스템은 명확한 상위-하위 계층 구조를 형성하는 6가지 범위 유형을 정의합니다.

claude_code.interaction (Root Span: 단일 사용자 상호작용) ├─ claude_code.llm_request (API 호출) ├─ claude_code.tool (도구 호출) │ ├─ claude_code.tool.blocked_on_user (권한 승인 대기 중) │ └─ claude_code.tool.execution (실제 실행) └─ claude_code.hook(후크 실행, 베타 추적)

각 범위에는 표준화된 속성(`sessionTracing.ts:162-166`)이 있습니다.

<div class="table-wrapper">

| 스팬 유형 | 주요 속성 |
|----|----|
| `interaction` | `session_id`, `platform`, `arch` |
| `llm_request` | `model`, `speed`(빠른/일반), `query_source`(에이전트 이름) |
| `llm_request` 응답 | `duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `ttft_ms`, `success` |
| `tool` | `tool_name`, `tool_input`(베타 추적) |

</div>

`ttft_ms`(Time to First Token)는 LLM 애플리케이션에 대한 가장 중요한 대기 시간 측정 항목 중 하나입니다. CC는 기본적으로 이를 범위 속성에 기록합니다.

### <a href="#context-propagation-asynclocalstorage" class="header">컨텍스트 전파: AsyncLocalStorage</a>

CC는 범위 컨텍스트 전파를 위해 Node.js `AsyncLocalStorage`를 사용합니다(`sessionTracing.ts:65-76`):

``` typescript
const interactionContext = new AsyncLocalStorage<SpanContext | undefined>()
const toolContext = new AsyncLocalStorage<SpanContext | undefined>()
const activeSpans = new Map<string, WeakRef<SpanContext>>()
```

두 개의 독립적인 AsyncLocalStorage 인스턴스는 각각 상호 작용 수준 및 도구 수준 컨텍스트를 추적합니다. `WeakRef` + 30분 TTL 주기적인 정리(60초마다 검색)는 분리된 범위의 메모리 누수를 방지합니다.

### <a href="#event-export-pipeline" class="header">이벤트 내보내기 파이프라인</a>

`logEvent()`는 단순한 `console.log`가 아닙니다. 이는 전체 Otel 파이프라인을 통과합니다.

logEvent("tengu_api_query", 메타데이터) ↓ 샘플링 확인(tengu_event_sampling_config) ↓ Logger.emit({ body: eventName, attribute: {...} }) 전달 ↓ BatchLogRecordProcessor(5초 간격 / 200개 항목 일괄 처리) ↓ FirstPartyEventLoggingExporter(사용자 정의 LogRecordExporter) ↓ POST /api/event_logging/batch → api.anthropic.com ↓ 실패 시 ~/.claude/config/telemetry/1p_failed_events.{session}.{batch}.json에 추가 ↓ 재시도 2차 백오프: 지연 = 최소(500ms × 시도², 30000ms), 최대 8회 시도

**원격 회로 차단기**: GrowthBook 구성 `tengu_frond_boric`는 전체 싱크의 켜기/끄기 스위치를 제어합니다. Anthropic은 릴리스 없이 원격 측정 내보내기를 긴급하게 비활성화할 수 있습니다.

### <a href="#datadog-dual-write" class="header">Datadog 이중 쓰기</a>

1P 내보내기 외에도 CC는 **일부** 이벤트를 Datadog(`datadog.ts:19-64`)에 이중 쓰기도 합니다.

- 허용 목록 메커니즘: `tengu_api_*`, `tengu_compact_*`, `tengu_tool_use_*` 및 유사한 접두사가 있는 핵심 이벤트만 내보냅니다(약 60개의 접두사 패턴).
- 일괄 처리: 100개 항목/배치, 15초 간격
- 엔드포인트: `https://http-intake.logs.us5.datadoghq.com/api/v2/logs`

이 이중 쓰기 전략은 전형적인 "프로덕션 관찰 계층화"입니다. 1P는 장기 분석을 위해 전체 볼륨 이벤트를 수집하고, Datadog는 실시간 경고 및 대시보드를 위한 핵심 이벤트를 수집합니다.

### <a href="#beta-tracing-richer-tracing-data" class="header">베타 추적: 더욱 풍부한 추적 데이터</a>

CC에는 환경 변수 `ENABLE_BETA_TRACING_DETAILED=1`에 의해 제어되는 별도의 "베타 추적" 시스템(`betaSessionTracing.ts`)도 있습니다.

<div class="table-wrapper">

| 표준 추적 | 베타 추적 추가 속성 |
|----|----|
| 모델, 기간_ms | \+ `system_prompt_hash`, `system_prompt_preview` |
| 입력_토큰, 출력_토큰 | \+ `response.model_output`, `response.thinking_output` |
| 도구_이름 | \+ `tool_input`(전체 입력 내용) |
| — | \+ `new_context`(턴당 새 메시지 델타) |

</div>

콘텐츠 잘림 임계값은 60KB입니다(허니콤 제한은 64KB). SHA-256 해싱은 중복 제거에 사용됩니다. 동일한 시스템 프롬프트는 한 번만 기록됩니다.

### <a href="#metric-exporter-ecosystem" class="header">미터법 수출 생태계</a>

CC는 주류 관찰 플랫폼을 포괄하는 5개의 메트릭 내보내기(`instrumentation.ts:130-215`)를 지원합니다.

<div class="table-wrapper">

| 수출업체 | 규약 | 내보내기 간격 | 목적 |
|----|----|----|----|
| OTLP(gRPC) | `@opentelemetry/exporter-metrics-otlp-grpc` | 60년대 | 표준 Otel 백엔드 |
| OTLP(HTTP) | `@opentelemetry/exporter-metrics-otlp-http` | 60년대 | HTTP 호환 백엔드 |
| 프로메테우스 | `@opentelemetry/exporter-prometheus` | 당기다 | 그라파나 생태계 |
| BigQuery | 사용자 정의 `BigQueryMetricsExporter` | 5분 | 장기 분석 |
| 콘솔 | `ConsoleMetricExporter` | 60년대 | 디버깅 |

</div>

### <a href="#prompt-replay-supportability-debugging-internal-tool"
class="header">프롬프트 재생: 지원 가능성 디버깅 내부 도구</a>

Claude Code에는 내부 사용자 대상(`USER_TYPE === 'ant'`) 디버깅 도구인 `dumpPrompts.ts`가 있습니다. 이 도구는 모든 API 호출 시 각 API 요청을 JSONL 파일로 투명하게 직렬화하여 전체 프롬프트 상호 작용 기록의 사후 재생을 지원합니다.

파일 쓰기 경로는 `~/.claude/dump-prompts/{sessionId}.jsonl`이며, 네 가지 유형의 JSON 개체가 한 줄에 하나씩 있습니다.

<div class="table-wrapper">

| 유형 | 방아쇠 | 콘텐츠 |
|----|----|----|
| `init` | 첫 번째 API 호출 | 시스템 프롬프트, 도구 스키마, 모델 메타데이터 |
| `system_update` | 시스템 프롬프트 또는 도구가 변경될 때 | init와 동일하지만 증분 업데이트로 표시됨 |
| `message` | 각각의 새로운 사용자 메시지 | 사용자 메시지만(응답으로 캡처된 보조 메시지) |
| `response` | API 성공 후 | 완전한 스트리밍 청크 또는 JSON 응답 |

</div>

``` typescript
// restored-src/src/services/api/dumpPrompts.ts:146-167
export function createDumpPromptsFetch(
  agentIdOrSessionId: string,
): ClientOptions['fetch'] {
  const filePath = getDumpPromptsPath(agentIdOrSessionId)
  return async (input, init?) => {
    // ...
    // Defer so it doesn't block the actual API call —
    // this is debug tooling for /issue, not on the critical path.
    setImmediate(dumpRequest, init.body as string, timestamp, state, filePath)
    // ...
  }
}
```

이 코드에서 가장 주목할만한 디자인은 **`setImmediate` 지연 직렬화**(167행)입니다. 시스템 프롬프트 + 도구 스키마는 쉽게 몇 MB가 될 수 있습니다. 동기 직렬화는 실제 API 호출을 차단합니다. `setImmediate`는 직렬화를 다음 이벤트 루프 틱으로 푸시하여 디버깅 도구가 사용자 경험에 영향을 미치지 않도록 합니다.

변경 감지는 **2단계 지문**을 사용합니다. 먼저 가벼운 `initFingerprint`(`model|toolNames|systemLength`, 74-88행)를 사용하여 "구조가 동일합니까?" 확인한 다음 구조가 변경된 경우에만 값비싼 `JSON.stringify + SHA-256 hash`를 수행합니다. 이를 통해 다중 턴 대화의 모든 라운드에서 변경되지 않은 시스템 프롬프트에 대해 300ms 직렬화 비용을 지불하는 것을 방지할 수 있습니다.

또한 `dumpPrompts.ts`는 사용자가 버그를 보고할 때 `/issue` 명령이 최신 요청 컨텍스트를 신속하게 얻을 수 있도록 5개의 가장 최근 API 요청(`MAX_CACHED_REQUESTS = 5`, 14행)의 메모리 내 캐시를 유지합니다. JSONL 파일 구문 분석이 필요하지 않습니다.

에이전트 빌더에 대한 시사점: **디버깅 도구는 비용이 들지 않는 사이드카여야 합니다**. `dumpPrompts`는 `setImmediate` 지연, 지문 중복 제거 및 메모리 내 캐싱의 세 가지 메커니즘을 통해 "상시 작동되지만 성능 중립적인" 디버깅 기능을 구현합니다. 에이전트에 유사한 프롬프트 재생 기능이 필요한 경우 이 패턴을 직접 재사용할 수 있습니다.

### <a href="#implications-for-agent-builders" class="header">Agent Builder에 대한 시사점</a>

1. **처음부터 Otel 표준을 사용하십시오**. CC는 사용자 정의 원격 측정 프로토콜을 구축하지 않았습니다. 표준 `Logger`, `Tracer`, `Meter`를 사용하여 모든 OTel 호환 백엔드와 통합할 수 있습니다. 귀하의 대리인도 동일한 작업을 수행해야 합니다.
2. **스팬 계층 구조는 에이전트 루프 구조를 반영해야 합니다**. `interaction → llm_request / tool` 계층 구조는 에이전트 루프의 한 반복에 직접 매핑됩니다. 스팬을 설계할 때 먼저 에이전트 루프 구조 다이어그램을 그립니다.
3. **샘플링은 필수입니다**. 860개가 넘는 이벤트를 전체 볼륨으로 내보내면 막대한 비용이 발생합니다. CC는 GrowthBook 원격 구성을 통해 각 이벤트의 샘플링 속도를 제어합니다. 이는 코드에서 `if (Math.random() < 0.01)`를 하드코딩하는 것보다 훨씬 더 유연합니다.
4. **다양한 목적으로 다양한 백엔드에 이중 쓰기**. 1P 전체 볼륨 + Datadog 코어 = 장기 분석 + 실시간 경고. 하나의 백엔드로 모든 요구 사항을 충족하려고 하지 마십시오.
5. **AsyncLocalStorage는 Node.js 에이전트를 위한 추적 무기입니다**. 이를 통해 컨텍스트 개체를 수동으로 전달하는 것을 방지할 수 있습니다. 상위-하위 관계 범위는 실행 컨텍스트를 통해 자동으로 전파됩니다.

------------------------------------------------------------------------

## <a href="#what-you-can-do" class="header">당신이 할 수 있는 일</a>

### <a href="#debug-logging" class="header">디버그 로깅</a>

- **시작 시 활성화**: `claude --debug` 또는 `claude -d`
- **런타임에 활성화**: 대화에 `/debug`를 입력하세요.
- **특정 모듈 필터링**: API 관련 로그만 보려면 `claude --debug=api`
- **stderr로 출력**: `claude --debug-to-stderr` 또는 `claude -d2e`(배관에 편리함)
- **출력 파일 지정**: `claude --debug-file=/path/to/log`

로그는 가장 최근 파일을 가리키는 `latest` 심볼릭 링크와 함께 `~/.claude/debug/` 디렉터리에 있습니다.

### <a href="#performance-analysis" class="header">성능 분석</a>

- **Perfetto 추적**(개미 전용): `CLAUDE_CODE_PERFETTO_TRACE=1 claude`
- `~/.claude/traces/trace-<session-id>.json`에 있는 추적 파일
- 시각적 타임라인을 보려면 [ui.perfetto.dev](https://ui.perfetto.dev)에서 엽니다.

### <a href="#cost-viewing" class="header">비용 보기</a>

- 현재 세션 토큰 사용량 및 비용을 보려면 대화에 `/cost`를 입력하세요.
- 비용 데이터는 세션 전반에 걸쳐 유지됩니다. 이전 세션의 누적 값은 재개 시 자동으로 로드됩니다.

### <a href="#privacy-controls" class="header">개인 정보 보호 제어</a>

- Claude Code의 원격 측정은 표준 옵트아웃 메커니즘을 따릅니다.
- 타사 API 공급자(Bedrock, Vertex) 호출은 원격 분석을 생성하지 않습니다.
- 관찰 가능성 데이터에는 사용자 코드 내용이나 파일 경로가 포함되어 있지 않습니다(유형 시스템에서 보장).
