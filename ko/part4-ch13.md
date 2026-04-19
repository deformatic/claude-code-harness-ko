# <a href="#chapter-13-cache-architecture-and-breakpoint-design"
class="header">13장: 캐시 아키텍처와 중단점 설계</a>

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

12장에서는 토큰 예산 전략이 컨텍스트 창에 들어오는 콘텐츠의 크기를 어떻게 제어하는지 논의했습니다. 그러나 더 교활한 비용 문제가 있습니다. **컨텍스트 창 내의 콘텐츠가 완전히 동일하더라도 모든 API 호출은 여전히 ​​시스템 프롬프트 및 도구 정의에 대한 비용을 지불합니다.**

일반적인 Claude Code 세션의 경우 시스템 프롬프트는 약 11,000개의 토큰이고 40개 이상의 도구에 대한 스키마 정의는 추가로 ~20,000개의 토큰을 제공합니다. 이러한 "고정 오버헤드"만으로도 호출당 30,000개 이상의 토큰을 소비합니다. 50턴 세션 동안 1,500,000개의 토큰이 반복적으로 처리된다는 의미입니다. Anthropic의 가격을 고려하면 이는 적지 않은 비용입니다.

Anthropic의 Prompt Caching 메커니즘은 이 문제를 정확하게 해결하기 위해 설계되었습니다. API 요청의 접두사가 이전 요청과 일치하면 서버는 캐시된 KV 상태를 재사용하여 캐시된 부분에 대한 비용을 90%까지 줄일 수 있습니다. 그러나 캐시 적중에는 엄격한 요구 사항이 있습니다. 접두사는 **바이트 단위**와 일치해야 합니다. 단일 문자 변경으로 인해 캐시 누락, 즉 "캐시 중단"이 발생합니다.

Claude Code는 세 가지 캐시 범위 수준, 두 가지 TTL 계층, 캐시 중단을 방지하기 위한 일련의 "래칭" 메커니즘을 특징으로 하는 이러한 제약 조건을 중심으로 정교한 캐시 아키텍처를 구축합니다. 이 장에서는 이 아키텍처의 설계 및 구현에 대해 자세히 설명합니다.

------------------------------------------------------------------------

## <a href="#131-anthropic-api-prompt-caching-fundamentals"
class="header">13.1 Anthropic API 프롬프트 캐싱 기본 사항</a>

### <a href="#prefix-matching-model" class="header">접두사 일치 모델</a>

Anthropic의 프롬프트 캐싱은 **접두사 일치** 원칙을 기반으로 합니다. 서버는 API 요청을 직렬화된 바이트 스트림으로 처리하여 처음부터 바이트별로 비교합니다. 불일치가 발견되면 해당 시점에서 캐시가 "중단"됩니다. 이전의 모든 항목은 재사용될 수 있고 이후의 모든 항목은 다시 계산되어야 합니다.

이는 캐시 효율성이 전적으로 요청 접두사의 **안정성**에 달려 있음을 의미합니다. API 요청의 직렬화 순서는 대략 다음과 같습니다.

[시스템 프롬프트] → [도구 정의] → [메시지 기록]

시스템 프롬프트와 도구 정의는 시퀀스의 맨 앞에 위치합니다. 이를 변경하면 전체 캐시가 무효화됩니다. 메시지 기록은 끝에 추가되므로 새 메시지에는 증분 부분에 대한 비용만 발생합니다.

### <a href="#cache_control-markers" class="header">캐시 제어 마커</a>

캐싱을 활성화하려면 API 요청의 콘텐츠 블록에 `cache_control` 마커를 추가합니다.

``` typescript
// Basic form of cache_control
{
  type: 'ephemeral'
}

// Extended form (1P exclusive)
{
  type: 'ephemeral',
  scope: 'global' | 'org',   // Cache scope
  ttl: '5m' | '1h'           // Cache time-to-live
}
```

`type: 'ephemeral'`는 지원되는 유일한 캐시 유형으로, 임시 캐시 중단점을 나타냅니다. Claude Code는 전체 `cache_control` 옵션을 포함하는 `utils/api.ts`(68~78행)에서 확장 도구 스키마 유형을 정의합니다.

``` typescript
// utils/api.ts:68-78
type BetaToolWithExtras = BetaTool & {
  strict?: boolean
  defer_loading?: boolean
  cache_control?: {
    type: 'ephemeral'
    scope?: 'global' | 'org'
    ttl?: '5m' | '1h'
  }
  eager_input_streaming?: boolean
}
```

### <a href="#cache-breakpoint-placement" class="header">캐시 중단점 배치</a>

Claude Code는 요청에 캐시 중단점을 신중하게 배치하여 `getCacheControl()` 함수(`services/api/claude.ts`, 358-374행)를 통해 통합 `cache_control` 개체를 생성합니다.

``` typescript
// services/api/claude.ts:358-374
export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}
```

이 기능은 단순해 보이지만 모든 조건부 분기는 신중하게 고려된 캐싱 전략을 구현합니다.

------------------------------------------------------------------------

## <a href="#132-three-cache-scope-levels" class="header">13.2 세 가지 캐시 범위 수준</a>

Claude Code는 세 가지 캐시 범위를 사용하며, 각각은 서로 다른 재사용 세분성에 해당합니다. 이러한 범위는 `splitSysPromptPrefix()` 기능(`utils/api.ts`, 321-435행)을 통해 시스템 프롬프트의 여러 부분에 할당됩니다.

### <a href="#scope-definitions" class="header">범위 정의</a>

<div class="table-wrapper">

| 캐시 범위 | 식별자 | 재사용 세분성 | 해당 내용 | TTL |
|----|----|----|----|----|
| **글로벌 캐시** | `'global'` | 조직 간, 사용자 간 | 모든 Claude Code 인스턴스에서 공유되는 정적 프롬프트 | 5분(기본값) |
| **조직 캐시** | `'org'` | 같은 조직 내의 사용자 | 조직별로 다르지만 사용자에 구애받지 않는 콘텐츠 | 5분 / 1시간 |
| **캐시 없음** | `null` | Cache_control이 설정되지 않았습니다. | 매우 역동적인 콘텐츠 | 해당 없음 |

</div>

**표 13-1: 세 가지 캐시 범위 수준 비교**

> **대화형 버전**: [캐시 적중 애니메이션을 보려면 클릭하세요](cache-viz.html) — 실시간 적중률 및 비용 절감 계산과 함께 3가지 시나리오 전환(첫 번째 호출/동일 사용자/다른 사용자)을 지원하는 API 요청 캐시 일치 프로세스의 단계별 데모입니다.

### <a href="#global-cache-scope-global" class="header">글로벌 캐시 범위(글로벌)</a>

글로벌 캐싱은 가장 공격적인 최적화입니다. `global`로 표시된 콘텐츠는 모든 Claude Code 사용자 간에 KV 캐시를 공유할 수 있습니다. 이는 사용자 A가 요청을 시작하고 시스템 프롬프트의 정적 부분을 캐시하면 사용자 B의 다음 요청이 해당 캐시에 직접 적중할 수 있음을 의미합니다.

글로벌 캐싱에 대한 자격 기준은 매우 엄격합니다. 콘텐츠는 사용자별, 조직별 또는 시간별 정보를 포함하지 않고 **완전히 불변**해야 합니다. Claude Code는 "동적 경계 마커"(`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`)를 사용하여 시스템 프롬프트를 정적 부분과 동적 부분으로 분할합니다.

``` typescript
// utils/api.ts:362-404 (simplified)
if (useGlobalCacheFeature) {
  const boundaryIndex = systemPrompt.findIndex(
    s => s === SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  )
  if (boundaryIndex !== -1) {
    // Content before the boundary → cacheScope: 'global'
    // Content after the boundary → cacheScope: null
    for (let i = 0; i < systemPrompt.length; i++) {
      if (i < boundaryIndex) {
        staticBlocks.push(block)
      } else {
        dynamicBlocks.push(block)
      }
    }
    // ...
    if (staticJoined)
      result.push({ text: staticJoined, cacheScope: 'global' })
    if (dynamicJoined)
      result.push({ text: dynamicJoined, cacheScope: null })
  }
}
```

경계 뒤의 동적 콘텐츠는 `cacheScope: null`로 표시됩니다. `org` 수준 캐싱도 사용하지 않습니다. 동적 콘텐츠의 변경 빈도가 너무 높고 캐시 적중률이 매우 낮으며 캐시 중단점을 표시하면 API 요청이 복잡해지기 때문입니다.

### <a href="#organization-cache-scope-org" class="header">조직 캐시 범위(org)</a>

글로벌 캐싱을 사용할 수 없는 경우(예: 글로벌 캐시 기능이 활성화되지 않았거나 콘텐츠에 조직별 정보가 포함된 경우) Claude Code는 `org` 수준으로 대체됩니다.

``` typescript
// utils/api.ts:411-435 (default mode)
let attributionHeader: string | undefined
let systemPromptPrefix: string | undefined
const rest: string[] = []

for (const block of systemPrompt) {
  if (block.startsWith('x-anthropic-billing-header')) {
    attributionHeader = block
  } else if (CLI_SYSPROMPT_PREFIXES.has(block)) {
    systemPromptPrefix = block
  } else {
    rest.push(block)
  }
}

const result: SystemPromptBlock[] = []
if (attributionHeader)
  result.push({ text: attributionHeader, cacheScope: null })
if (systemPromptPrefix)
  result.push({ text: systemPromptPrefix, cacheScope: 'org' })
const restJoined = rest.join('\n\n')
if (restJoined)
  result.push({ text: restJoined, cacheScope: 'org' })
```

여기서 청킹 전략은 중요한 세부 정보를 보여줍니다. **청구 속성 헤더**(`x-anthropic-billing-header`)가 `null`로 표시되고 캐싱에서 제외됩니다. 어트리뷰션 헤더에는 `org` 레벨에서도 공유할 수 없는 사용자 신원 정보가 포함되어 있기 때문입니다. CLI 시스템 프롬프트 접두사(`CLI_SYSPROMPT_PREFIXES`)와 나머지 시스템 프롬프트 콘텐츠는 모두 `org`로 표시되며 동일한 조직 내에서 공유됩니다.

### <a href="#special-handling-for-mcp-tools" class="header">MCP 도구의 특수 처리</a>

사용자가 MCP 도구를 구성하면 글로벌 캐싱 전략이 변경됩니다. MCP 도구 정의는 외부 서버에서 제공되고 해당 내용을 예측할 수 없기 때문에 이를 글로벌 캐시에 포함하면 적중률이 줄어듭니다. Claude Code는 `skipGlobalCacheForSystemPrompt` 플래그를 통해 이를 처리합니다.

``` typescript
// utils/api.ts:326-360
if (useGlobalCacheFeature && options?.skipGlobalCacheForSystemPrompt) {
  logEvent('tengu_sysprompt_using_tool_based_cache', {
    promptBlockCount: systemPrompt.length,
  })
  // All content downgraded to org scope, skipping boundary markers
  // ...
}
```

이 다운그레이드는 보수적이지만 합리적입니다. 빈번한 글로벌 캐시 누락 위험을 감수하기보다는 보다 안정적인 `org` 수준 적중률로 되돌아갑니다.

------------------------------------------------------------------------

## <a href="#133-cache-ttl-tiers" class="header">13.3 캐시 TTL 계층</a>

### <a href="#default-5-minutes-vs-1-hour" class="header">기본 5분 대 1시간</a>

Anthropic의 프롬프트 캐싱에는 기본 TTL이 5분입니다. 즉, 사용자가 5분 이내에 새 API 요청을 시작하지 않으면 캐시가 만료됩니다. 활성 코딩 세션의 경우 일반적으로 5분이면 충분합니다. 그러나 확장된 사고나 문서 검토가 필요한 시나리오의 경우 5분만으로는 충분하지 않을 수 있습니다.

Claude Code는 `should1hCacheTTL()` 함수(`services/api/claude.ts`, 393-434행)에 따라 결정된 TTL을 1시간으로 업그레이드하는 것을 지원합니다.

``` typescript
// services/api/claude.ts:393-434
function should1hCacheTTL(querySource?: QuerySource): boolean {
  // 3P Bedrock users opt-in via environment variable
  if (
    getAPIProvider() === 'bedrock' &&
    isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)
  ) {
    return true
  }

  // Latched eligibility check — prevents mid-session overage flips from changing TTL
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible =
      process.env.USER_TYPE === 'ant' ||
      (isClaudeAISubscriber() && !currentLimits.isUsingOverage)
    setPromptCache1hEligible(userEligible)
  }
  if (!userEligible) return false

  // Cache allowlist — also latched to maintain session stability
  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    const config = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_prompt_cache_1h_config', {}
    )
    allowlist = config.allowlist ?? []
    setPromptCache1hAllowlist(allowlist)
  }

  return (
    querySource !== undefined &&
    allowlist.some(pattern =>
      pattern.endsWith('*')
        ? querySource.startsWith(pattern.slice(0, -1))
        : querySource === pattern,
    )
  )
}
```

### <a href="#the-latching-mechanism-for-eligibility-checks"
class="header">자격 확인을 위한 걸쇠 메커니즘</a>

`should1hCacheTTL()`에서 가장 중요한 디자인은 **래칭**입니다. 첫 번째 호출에서 함수는 사용자가 1시간 TTL을 받을 자격이 있는지 평가한 다음 결과를 전역 `STATE`(`bootstrap/state.ts`)에 저장합니다.

``` typescript
// bootstrap/state.ts:1700-1706
export function getPromptCache1hEligible(): boolean | null {
  return STATE.promptCache1hEligible
}

export function setPromptCache1hEligible(eligible: boolean | null): void {
  STATE.promptCache1hEligible = eligible
}
```

래칭이 필요한 이유는 무엇입니까? 다음 시나리오를 고려해보세요.

1. 세션 시작 시 사용자는 구독 할당량(`isUsingOverage === false`) 내에 있으며 1시간 TTL을 받습니다.
2. 30번째 턴에 사용자가 할당량을 초과합니다(`isUsingOverage === true`).
3. TTL이 1시간에서 5분으로 떨어지면 `cache_control` 객체의 직렬화가 변경됩니다.
4. 이 변경으로 인해 API 요청 접두사가 더 이상 일치하지 않습니다 — **캐시 중단**

최대 20,000개의 시스템 프롬프트 및 도구 정의 캐시 토큰을 무효화하는 단일 초과 상태 전환은 분명히 허용되지 않습니다. 래칭 메커니즘은 세션 시작 시 TTL 계층이 결정되면 세션 전체에서 일정하게 유지되도록 보장합니다.

동일한 래칭 논리가 GrowthBook 허용 목록 구성에 적용되어 중간 세션 GrowthBook 디스크 캐시 업데이트로 인해 TTL 동작이 변경되는 것을 방지합니다.

### <a href="#ttl-tier-decision-table" class="header">TTL 계층 결정 표</a>

<div class="table-wrapper">

| 상태 | TTL | 메모 |
|----|----|----|
| 3P 기반암 + `ENABLE_PROMPT_CACHING_1H_BEDROCK=1` | 1시간 | Bedrock 사용자는 자신의 청구서를 관리합니다. |
| 인류 직원(`USER_TYPE=ant`) | 1시간 | 내부 사용자 |
| Claude AI 구독자 + 할당량을 초과하지 않음 | 1시간 | GrowthBook 허용 목록을 통과해야 함 |
| 다른 모든 사용자 | 5분 | 기본 |

</div>

**표 13-2: 캐시 TTL 결정 매트릭스**

------------------------------------------------------------------------

## <a href="#134-beta-header-latching-mechanism" class="header">13.4 베타 헤더 래칭 메커니즘</a>

### <a href="#the-problem-dynamic-headers-causing-cache-busting"
class="header">문제: 캐시 무효화를 일으키는 동적 헤더</a>

Anthropic API 요청에는 클라이언트가 사용하는 실험적 기능을 식별하는 "베타 헤더" 세트가 포함되어 있습니다. 이러한 헤더는 서버 측 캐시 키의 일부입니다. 헤더를 추가하거나 제거하면 캐시 키가 변경되어 캐시 중단이 발생합니다.

Claude Code에는 세션 중에 동적으로 활성화하거나 비활성화할 수 있는 여러 기능이 있습니다.

- **AFK 모드**(자동 모드): 사용자가 자리를 비울 때 자동으로 작업을 실행합니다.
- **빠른 모드**: 더 빠르지만 잠재적으로 더 비싼 모델을 사용합니다.
- **캐시 편집**(Cached Microcompact): 캐시 내에서 증분 편집을 수행합니다.

이러한 기능 중 하나의 상태가 변경될 때마다 해당 베타 헤더가 추가되거나 제거되어 캐시 중단이 트리거됩니다. 코드 주석(`services/api/claude.ts`, 1405~1410행)에서는 이 문제를 명시적으로 설명합니다.

``` typescript
// services/api/claude.ts:1405-1410
// Sticky-on latches for dynamic beta headers. Each header, once first
// sent, keeps being sent for the rest of the session so mid-session
// toggles don't change the server-side cache key and bust ~50-70K tokens.
// Latches are cleared on /clear and /compact via clearBetaHeaderLatches().
// Per-call gates (isAgenticQuery, querySource===repl_main_thread) stay
// per-call so non-agentic queries keep their own stable header set.
```

### <a href="#latching-implementation" class="header">래칭 구현</a>

Claude Code의 솔루션은 "고정형" 래칭입니다. 베타 헤더가 세션에서 전송되면 베타 헤더를 ​​트리거한 기능이 비활성화된 경우에도 나머지 세션 동안 계속해서 전송됩니다.

다음은 베타 헤더 3개에 대한 래칭 코드입니다(`services/api/claude.ts`, 1412~1442행).

**AFK 모드 헤더:**

``` typescript
// services/api/claude.ts:1412-1423
let afkHeaderLatched = getAfkModeHeaderLatched() === true
if (feature('TRANSCRIPT_CLASSIFIER')) {
  if (
    !afkHeaderLatched &&
    isAgenticQuery &&
    shouldIncludeFirstPartyOnlyBetas() &&
    (autoModeStateModule?.isAutoModeActive() ?? false)
  ) {
    afkHeaderLatched = true
    setAfkModeHeaderLatched(true)
  }
}
```

**빠른 모드 헤더:**

``` typescript
// services/api/claude.ts:1425-1429
let fastModeHeaderLatched = getFastModeHeaderLatched() === true
if (!fastModeHeaderLatched && isFastMode) {
  fastModeHeaderLatched = true
  setFastModeHeaderLatched(true)
}
```

**캐시 편집 헤더:**

``` typescript
// services/api/claude.ts:1431-1442
let cacheEditingHeaderLatched = getCacheEditingHeaderLatched() === true
if (feature('CACHED_MICROCOMPACT')) {
  if (
    !cacheEditingHeaderLatched &&
    cachedMCEnabled &&
    getAPIProvider() === 'firstParty' &&
    options.querySource === 'repl_main_thread'
  ) {
    cacheEditingHeaderLatched = true
    setCacheEditingHeaderLatched(true)
  }
}
```

### <a href="#latching-state-diagram" class="header">래칭 상태 다이어그램</a>

세 가지 베타 헤더는 모두 동일한 상태 전환 패턴을 따릅니다.

``` mermaid
stateDiagram-v2
    [*] --> Unlatched
    Unlatched --> Latched : Condition first becomes true\n(feature activated + preconditions met)
    Latched --> Latched : Feature deactivated\n(latch remains unchanged)
    Latched --> Reset : /clear or /compact\n(clearBetaHeaderLatches)
    Reset --> Unlatched : Next condition evaluation

    state Unlatched {
        [*] : latched = false/null
    }
    state Latched {
        [*] : latched = true
    }
    state Reset {
        [*] : latched = false/null
    }
```

**그림 13-1: 베타 헤더 래칭 상태 다이어그램**

주요 속성:

1. **단방향 래칭**: false에서 true로의 전환은 되돌릴 수 없습니다(현재 세션 내에서).
2. **조건부 트리거**: 각 헤더에는 고유한 전제 조건 세트가 있습니다.
3. **세션 바인딩**: `/clear` 및 `/compact` 명령만 래치 상태를 재설정합니다.
4. **쿼리 격리**: `isAgenticQuery` 및 `querySource`와 같은 조건은 호출별로 평가되어 비에이전트 쿼리가 자체적으로 안정적인 헤더 세트를 유지하도록 보장합니다.

### <a href="#latching-summary-table" class="header">래칭 요약표</a>

<div class="table-wrapper">

| 베타 헤더 | 래치 변수 | 전제조건 | 트리거 재설정 |
|----|----|----|----|
| AFK 모드 | `afkModeHeaderLatched` | `TRANSCRIPT_CLASSIFIER` 활성화 + 에이전트 쿼리 + 1P 전용 + 자동 모드 활성화 | `/clear`, `/compact` |
| 빠른 모드 | `fastModeHeaderLatched` | 빠른 모드 사용 가능 + 쿨타임 없음 + 모델 지원 + 요청 활성화 | `/clear`, `/compact` |
| 캐시 편집 | `cacheEditingHeaderLatched` | `CACHED_MICROCOMPACT` 활성화 + 캐시된MC 사용 가능 + 1P + 메인 스레드 | `/clear`, `/compact` |

</div>

**표 13-3: 베타 헤더 래칭 세부 정보**

------------------------------------------------------------------------

## <a href="#135-thinking-clear-latching" class="header">13.5 명확한 래칭에 대한 생각</a>

베타 헤더 래칭 외에도 특수 래칭 메커니즘이 하나 더 있습니다. `thinkingClearLatched`(`services/api/claude.ts`, 라인 1446–1456):

``` typescript
// services/api/claude.ts:1446-1456
let thinkingClearLatched = getThinkingClearLatched() === true
if (!thinkingClearLatched && isAgenticQuery) {
  const lastCompletion = getLastApiCompletionTimestamp()
  if (
    lastCompletion !== null &&
    Date.now() - lastCompletion > CACHE_TTL_1HOUR_MS
  ) {
    thinkingClearLatched = true
    setThinkingClearLatched(true)
  }
}
```

이 래치는 마지막 API 완료(`CACHE_TTL_1HOUR_MS = 60 * 60 * 1000`) 이후 1시간 이상 경과하면 트리거됩니다. 이 시점에서는 TTL이 1시간이더라도 캐시가 이미 만료되었습니다. Thinking Clear는 이 신호를 활용하여 사고 블록 처리를 최적화합니다. 캐시가 이미 유효하지 않기 때문에 축적된 사고 콘텐츠를 정리하여 후속 요청에서 토큰 소비를 줄일 수 있습니다.

------------------------------------------------------------------------

## <a href="#136-cache-architecture-overview" class="header">13.6 캐시 아키텍처 개요</a>

위의 모든 메커니즘을 결합하면 Claude Code의 캐시 아키텍처는 다음 레이어로 요약될 수 있습니다.

┌────────────────────────────────────────────────────────┐ │ API 요청 구성 │ │ │ │ ┌── 시스템 프롬프트 ──┐ ┌── 도구 정의 ──┐ ┌── 메시지 ─┐│ │ │ │ │ │ │ ││ │ │ [속성] │ │ [도구 1] │ │ [메시지 1] ││ │ │ 범위: null │ │ 범위: org │ │ ││ │ │ │ │ │ [msg 2] ││ │ │ [접두사] │ │ [도구 2] │ │ ││ │ │ 범위: 조직/null │ │ 범위: 조직 │ │ [msg N] ││ │ │ │ │ │ │ │ │ [정적] │ │ [도구 N] │ │ │ │ │ 범위: 전역 │ │ 범위: 조직 │ │ │ │ │ │ │ │ │ │ │ │ [동적] │ │ │ │ ││ │ │ 범위: null │ │ │ │ │ └───────────────────┘ └──────────────┘ └─────────┘│ │ │ │ ────────── 접두사 일치 방향 ───────────────────────→ │ │ │ ├────────────────────────────────────────────────────┤ │ TTL 결정 계층 │ │ │ │ should1hCacheTTL() → 래치 → 세션 안정성 │ │ │ ├───────────────────────────────────────────────────────┤ │ 베타 헤더 래칭 레이어 │ │ │ │ afkMode / fastMode / 캐시편집 → 끈적끈적 │ │ │ ├───────────────────────────────────────────────────────┤ │ 캐시 중단 감지 계층 │ │ (14장 참조) │ └───────────────────────────────────────────────────────┘

**그림 13-2: Claude 코드 캐시 아키텍처 개요**

------------------------------------------------------------------------

## <a href="#137-design-insights" class="header">13.7 디자인 통찰력</a>

### <a href="#latching-is-the-core-pattern-for-cache-stability"
class="header">래칭은 캐시 안정성을 위한 핵심 패턴입니다.</a>

Claude Code는 캐싱 코드 전체에서 동일한 패턴을 반복적으로 사용합니다. **한 번 평가 → 래치 → 세션 안정성**. 이 패턴은 다음과 같이 나타납니다.

- TTL 자격 확인(`should1hCacheTTL`)
- TTL 허용 목록 구성
- 베타 헤더 전송 상태
- 명확한 트리거링을 생각

모든 래치는 동일한 목적을 수행합니다. 세션 중 상태 변경이 직렬화된 API 요청을 변경하지 못하도록 방지하여 캐시 접두사의 무결성을 보호합니다.

### <a href="#cache-scopes-are-a-cost-vs-hit-rate-trade-off"
class="header">캐시 범위는 비용과 적중률의 균형입니다.</a>

세 가지 캐시 범위 수준은 명확한 엔지니어링 균형을 구현합니다.

- **전역** 범위는 적중률이 가장 높지만(모든 사용자 간에 공유) 절대적으로 정적 콘텐츠가 필요합니다.
- **org** 범위에는 중간 적중률이 있어 조직 수준의 차이가 허용됩니다.
- **null**은 캐시 표시를 건너뛰어 요청 복잡성만 가중시키는 비효율적인 캐싱 시도를 방지합니다.

Claude Code의 전략은 "가능하면 글로벌하고, 그렇지 않으면 조직하고, 둘 다 작동하지 않으면 포기하는 것"입니다. 즉, 모든 경우에 적용되는 단일 접근 방식보다 더 세부적이고 효과적입니다.

### <a href="#mcp-tools-are-the-caches-worst-enemy" class="header">MCP 도구는 캐시의 최악의 적입니다</a>

MCP 도구의 도입은 캐싱에 심각한 문제를 야기합니다. MCP 서버는 세션 중에 연결하거나 연결을 끊을 수 있으며 도구 정의는 언제든지 변경될 수 있습니다. MCP 도구가 감지되면 시스템 프롬프트의 글로벌 캐시가 조직 수준(`skipGlobalCacheForSystemPrompt`)으로 다운그레이드되고 도구 캐싱 전략이 시스템 프롬프트 내장에서 독립적인 `tool_based` 전략으로 전환됩니다. 이러한 성능 저하 조치는 15장의 캐시 최적화 패턴에서 자세히 설명합니다.

------------------------------------------------------------------------

## <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

이 장에서 분석된 캐시 아키텍처를 기반으로 캐시 친화적인 시스템을 구축하기 위한 실용적인 지침은 다음과 같습니다.

1. **접두사 일치 의미 이해**: Anthropic의 캐싱은 엄격한 접두사 일치를 사용합니다. API 요청을 구성할 때 항상 가장 안정적이고 변경 가능성이 가장 적은 콘텐츠를 먼저 배치하고(정적 시스템 프롬프트) 동적 콘텐츠(사용자 메시지, 첨부 파일)를 마지막에 배치하세요.

2. **시스템 프롬프트에 대한 캐시 범위 설계**: 애플리케이션이 여러 사용자에게 서비스를 제공하는 경우 전역적으로 공유되는 프롬프트 콘텐츠(`global` 범위에 적합), 조직 수준(`org` 범위에 적합) 및 완전히 동적(`cache_control`로 표시하지 않음)인 프롬프트 콘텐츠를 식별합니다. 모든 경우에 적용되는 일률적인 캐싱 전략은 적중률을 낭비합니다.

3. **래칭 패턴을 사용하여 캐시 키 안정성 보호**: 세션 중에 변경될 수 있는 모든 구성(기능 플래그, 사용자 할당량 상태, 기능 토글)(직렬화된 API 요청에 영향을 미치는 경우)은 세션 시작 시 래칭되어야 합니다. 래칭의 핵심 원칙: 캐시 키가 세션 중간에 변경되도록 하는 것보다 약간 오래된 값을 사용하는 것이 더 좋습니다.

4. **MCP 도구가 캐싱에 미치는 영향에 주의하세요**: 애플리케이션이 외부 도구(MCP 또는 유사한 도구)를 통합하는 경우 해당 도구의 역동성은 캐시 적중률을 크게 감소시킵니다. 핵심 도구와 별도로 외부 도구 정의를 처리하거나 외부 도구가 감지되면 캐싱 전략을 다운그레이드하는 것을 고려하세요.

5. **`cache_read_input_tokens` 모니터링**: 이는 캐시 상태에 대한 신뢰할 수 있는 유일한 지표입니다. 기준선을 설정한 후 상당한 감소가 있으면 조사할 가치가 있습니다. 캐시 중단 감지 시스템에 대해서는 14장을 참조하세요.

### <a href="#advice-for-claude-code-users" class="header">Claude Code 사용자를 위한 조언</a>

1. **시스템 프롬프트를 안정적으로 유지하세요.** CLAUDE.md를 수정할 때마다 캐시 접두사가 무효화될 수 있습니다. CLAUDE.md를 자주 편집하는 경우 실험 지침을 파일에 유지하는 대신 세션 수준(`/memory` 또는 대화 중 지침을 통해)에 배치하는 것이 좋습니다.
2. **잦은 모델 전환을 피하세요.** 모델 전환은 캐시 접두사가 완전히 무효화됨을 의미합니다. Opus와 Sonnet은 시스템 프롬프트가 다르며 전환 후 모든 캐싱은 0부터 시작됩니다. 강력한 모델이 필요한 작업에는 Opus를 사용하고, 가벼운 작업에는 Sonnet을 집중 배치로 사용하세요.
3. **`/compact` 사용 시간을 정하세요.** 수동 압축 후 CC는 캐시 접두어를 다시 작성합니다. 많은 도구 호출(예: 배치 파일 수정)을 수행할 예정인 경우 먼저 압축하면 효과적인 캐시 기간이 더 길어질 수 있습니다.
4. **캐시 적중 지표를 확인하세요.** `--verbose` 모드에서 CC는 `cache_read_input_tokens`를 보고합니다. `input_tokens`가 높을 때 이 숫자가 0에 가까우면 캐시가 자주 무효화된다는 의미이므로 조사해야 합니다.

------------------------------------------------------------------------

## <a href="#summary" class="header">요약</a>

이 장에서는 Claude Code의 프롬프트 캐시 아키텍처를 분석했습니다.

1. **접두사 일치 모델**에는 API 요청 접두사의 바이트 단위 안정성이 필요합니다. 모든 변경으로 인해 캐시 중단이 발생함
2. **세 가지 캐시 범위 수준**(전역/조직/null)을 통해 적중률과 유연성 사이를 세밀하게 절충합니다.
3. **TTL 계층**(5분/1시간)은 래칭 메커니즘을 통해 세션 내 안정성을 보장합니다.
4. **베타 헤더 래칭**은 고정 패턴을 사용하여 기능 전환으로 인해 캐시 키가 변경되는 것을 방지합니다.

이러한 메커니즘은 함께 캐시의 "보호 레이어"를 형성합니다. 그러나 보호만으로는 충분하지 않습니다. 캐시 중단이 발생하면 시스템이 원인을 감지하고 진단해야 합니다. 14장에서는 캐시 중단 감지 시스템의 2단계 아키텍처를 자세히 살펴봅니다.
