# <a href="#chapter-14-cache-break-detection-system"
class="header">14장: 캐시 중단 감지 시스템</a>

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

13장에서는 Claude Code가 래치 메커니즘과 신중하게 설계된 캐시 범위를 사용하여 캐시 중단을 **방지**하는 방법을 살펴보았습니다. 그러나 이러한 보호 장치를 사용하더라도 캐시 중단은 여전히 ​​발생합니다. MCP 서버 재연결로 인해 도구 정의가 변경될 수 있고, 새로운 첨부 파일, 모델 전환, 작업 조정으로 인해 시스템 프롬프트가 커질 수 있으며, GrowthBook 원격 구성 업데이트도 모두 API 요청 접두사를 변경할 수 있습니다.

이를 더욱 까다롭게 만드는 것은 캐시 중단이 "자동"이라는 것입니다. API 응답의 `cache_read_input_tokens`가 삭제되지만 이유를 알려주는 오류 메시지는 없습니다. 개발자는 근본 원인을 알지 못한 채 비용이 증가하고 대기 시간이 증가한다는 사실만 알아차립니다.

Claude Code는 이 문제를 해결하기 위해 2단계 캐시 중단 감지 시스템을 구축했습니다. 전체 시스템은 `services/api/promptCacheBreakDetection.ts`(728라인)에서 구현되며 기능보다는 순전히 **관찰 가능성**에 전념하는 Claude Code의 몇 안 되는 하위 시스템 중 하나입니다.

------------------------------------------------------------------------

## <a href="#141-two-phase-detection-architecture" class="header">14.1 2단계 감지 아키텍처</a>

### <a href="#design-rationale" class="header">설계 이론적 근거</a>

캐시 중단 감지에는 타이밍 문제가 있습니다.

1. **요청이 전송되기 전에 변경 사항이 발생합니다**: 시스템 프롬프트 변경, 도구 추가/제거, 베타 헤더 뒤집기
2. **응답이 반환된 후에 중단 확인이 옵니다**: `cache_read_input_tokens`의 드롭을 관찰해야만 캐시가 실제로 버스트되었음을 ​​확인할 수 있습니다.

2단계만으로는 부족합니다. 토큰 드롭이 감지되는 시점에는 이미 요청이 전송되고 이전 상태가 손실되어 원인 추적이 불가능합니다. 1단계만으로는 충분하지 않습니다. 많은 클라이언트 측 변경 사항이 반드시 서버 측 캐시 중단을 발생시키는 것은 아닙니다(예: 서버가 해당 접두사를 아직 캐시하지 않았을 수 있음).

Claude Code의 솔루션은 탐지를 두 단계로 나눕니다.

``` mermaid
flowchart LR
    subgraph Phase1["Phase 1 (Pre-request)<br/>recordPromptState()"]
        A1[Capture current state] --> A2[Compare with previous state]
        A2 --> A3[Record change list]
        A3 --> A4[Store as pendingChanges]
    end

    Phase1 -- "API request/response" --> Phase2

    subgraph Phase2["Phase 2 (Post-response)<br/>checkResponseForCacheBreak()"]
        B1[Check cache tokens] --> B2[Confirm actual break]
        B2 --> B3[Explain cause using Phase 1 changes]
        B3 --> B4[Output diagnostics]
        B4 --> B5[Send analytics event]
    end
```

**그림 14-1: 2단계 감지 시퀀스 다이어그램**

### <a href="#call-sites" class="header">전화 사이트</a>

`services/api/claude.ts`에서 두 단계가 호출됩니다.

**1단계**는 API 요청 생성 중에 호출됩니다(1460~1486행).

``` typescript
// services/api/claude.ts:1460-1486
if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
  const toolsForCacheDetection = allTools.filter(
    t => !('defer_loading' in t && t.defer_loading),
  )
  recordPromptState({
    system,
    toolSchemas: toolsForCacheDetection,
    querySource: options.querySource,
    model: options.model,
    agentId: options.agentId,
    fastMode: fastModeHeaderLatched,
    globalCacheStrategy,
    betas,
    autoModeActive: afkHeaderLatched,
    isUsingOverage: currentLimits.isUsingOverage ?? false,
    cachedMCEnabled: cacheEditingHeaderLatched,
    effortValue: effort,
    extraBodyParams: getExtraBodyParams(),
  })
}
```

두 가지 주요 설계 결정에 유의하세요.

1. **defer_loading 도구 제외**: API는 지연된 도구를 자동으로 제거합니다. 이는 실제 캐시 키에 영향을 주지 않습니다. 이를 포함하면 도구가 발견되거나 MCP 서버가 다시 연결될 때 오탐지가 발생합니다.
2. **래치 값 전달**: `fastModeHeaderLatched`, `afkHeaderLatched`, `cacheEditingHeaderLatched`는 실시간 상태가 아닌 래치 값입니다. 캐시 키는 사용자의 현재 설정이 아닌 실제로 전송된 헤더에 의해 결정되기 때문입니다.

**2단계**는 API 응답 처리가 완료된 후 호출되어 응답에서 캐시 토큰 통계를 받습니다.

------------------------------------------------------------------------

## <a href="#142-previousstate-full-state-snapshot" class="header">14.2 PreviousState: 전체 상태 스냅샷</a>

1단계의 핵심은 `PreviousState` 유형입니다. 이는 서버 측 캐시 키에 영향을 줄 수 있는 모든 클라이언트 측 상태를 캡처합니다.

### <a href="#field-inventory" class="header">현장 재고</a>

`PreviousState`는 15개 이상의 필드를 포함하는 `promptCacheBreakDetection.ts`(28~69행)에 정의되어 있습니다.

<div class="table-wrapper">

| 필드 | 유형 | 목적 | 소스 변경 |
|----|----|----|----|
| `systemHash` | `number` | 시스템 프롬프트 콘텐츠 해시(cache_control 제외) | 즉각적인 콘텐츠 변경 |
| `toolsHash` | `number` | 집계 도구 스키마 해시(cache_control 제외) | 도구 추가/제거 또는 정의 변경 |
| `cacheControlHash` | `number` | 시스템 블록의 캐시_control 해시 | 범위 또는 TTL 뒤집기 |
| `toolNames` | `string[]` | 도구 이름 목록 | 도구 추가/제거 |
| `perToolHashes` | `Record<string, number>` | 도구별 개별 해시 | 단일 도구 스키마 변경 |
| `systemCharCount` | `number` | 총 시스템 프롬프트 문자 수 | 콘텐츠 추가/제거 |
| `model` | `string` | 현재 모델 식별자 | 모델 스위치 |
| `fastMode` | `boolean` | 빠른 모드 상태(래치 후) | 빠른 모드 활성화 |
| `globalCacheStrategy` | `string` | 캐시 전략 유형 | MCP 도구 검색/제거 |
| `betas` | `string[]` | 정렬된 베타 헤더 목록 | 베타 헤더 변경 |
| `autoModeActive` | `boolean` | AFK 모드 상태(래치 후) | 자동 모드 활성화 |
| `isUsingOverage` | `boolean` | 초과 사용량 상태(래치 후) | 할당량 상태 변경 |
| `cachedMCEnabled` | `boolean` | 캐시 편집 상태(래치 후) | 캐시된 MC 활성화 |
| `effortValue` | `string` | 해결된 노력 가치 | 노력 구성 변경 |
| `extraBodyHash` | `number` | 추가 요청 본문 매개변수의 해시 | CLAUDE_CODE_EXTRA_BODY 변경사항 |
| `callCount` | `number` | 현재 추적 키의 호출 횟수 | 자동 증가 |
| `pendingChanges` | `PendingChanges | null` | 1단계에서 감지된 변경 사항 | 1단계 비교 결과 |
| `prevCacheReadTokens` | `number | null` | 마지막 응답의 캐시 읽기 토큰 | 2단계 업데이트 |
| `cacheDeletionsPending` | `boolean` | Cache_edits 삭제가 확인 보류 중인지 여부 | 캐시된 MC 삭제 작업 |
| `buildDiffableContent` | `() => string` | 느리게 계산된 diffable 콘텐츠 | 디버그 출력에 사용됨 |

</div>

**표 14-1: PreviousState 필드 인벤토리 완료**

### <a href="#hashing-strategy" class="header">해싱 전략</a>

`PreviousState`에는 다양한 감지 세분성을 제공하는 여러 해시 필드가 포함되어 있습니다.

``` typescript
// promptCacheBreakDetection.ts:170-179
function computeHash(data: unknown): number {
  const str = jsonStringify(data)
  if (typeof Bun !== 'undefined') {
    const hash = Bun.hash(str)
    return typeof hash === 'bigint' ? Number(hash & 0xffffffffn) : hash
  }
  return djb2Hash(str)
}
```

**systemHash와 캐시ControlHash의 분리**에는 특별한 주의가 필요합니다.

``` typescript
// promptCacheBreakDetection.ts:274-281
const systemHash = computeHash(strippedSystem)  // excluding cache_control
const cacheControlHash = computeHash(           // cache_control only
  system.map(b => ('cache_control' in b ? b.cache_control : null)),
)
```

`systemHash`는 `stripCacheControl()`를 통해 `cache_control` 마커를 제거한 후 시스템 프롬프트 콘텐츠를 해시합니다. `cacheControlHash`는 `cache_control` 마커만 해시합니다. 왜 그들을 분리합니까? Because a cache scope flip (global to org) or TTL flip (1h to 5m) doesn't change the prompt text content — if you only look at `systemHash`, these flips would be missed. 분리 후 `cacheControlChanged`는 이러한 종류의 변경 사항을 독립적으로 캡처할 수 있습니다.

**perToolHashes의 주문형 계산**은 성능 최적화이기도 합니다.

``` typescript
// promptCacheBreakDetection.ts:285-286
const computeToolHashes = () =>
  computePerToolHashes(strippedTools, toolNames)
```

`perToolHashes`는 집계 도구 스키마 해시가 변경될 때 어떤 도구가 변경되었는지 정확히 찾아내는 데 사용되는 도구별 해시 테이블입니다. 그러나 도구별 해시 계산은 비용이 많이 들기 때문에(N `jsonStringify` 호출) `toolsHash`가 변경될 때만 트리거됩니다. 주석(37행)에서는 BigQuery 데이터를 인용합니다. **도구 스키마 변경의 77%는 도구 추가/제거가 아닌 단일 도구의 설명 변경입니다**. `perToolHashes`는 그 77%를 정확하게 진단하도록 설계되었습니다.

### <a href="#tracking-key-and-isolation-strategy" class="header">추적 키 및 격리 전략</a>

각 쿼리 소스는 맵에 저장된 독립적인 `PreviousState`를 유지 관리합니다.

``` typescript
// promptCacheBreakDetection.ts:101-107
const previousStateBySource = new Map<string, PreviousState>()

const MAX_TRACKED_SOURCES = 10

const TRACKED_SOURCE_PREFIXES = [
  'repl_main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
]
```

추적 키는 `getTrackingKey()` 함수(149~158행)에 의해 계산됩니다.

``` typescript
// promptCacheBreakDetection.ts:149-158
function getTrackingKey(
  querySource: QuerySource,
  agentId?: AgentId,
): string | null {
  if (querySource === 'compact') return 'repl_main_thread'
  for (const prefix of TRACKED_SOURCE_PREFIXES) {
    if (querySource.startsWith(prefix)) return agentId || querySource
  }
  return null
}
```

몇 가지 중요한 디자인 결정:

1. **compact는 메인 스레드의 추적 상태를 공유합니다**: Compaction은 동일한 `cacheSafeParams`를 사용하고 캐시 키를 공유하므로 감지 상태를 공유해야 합니다.
2. **하위 에이전트는 에이전트 ID로 격리됩니다**: 동일한 유형의 여러 동시 에이전트 인스턴스 간의 거짓 긍정을 방지합니다.
3. **추적되지 않은 쿼리 소스**는 `null`를 반환합니다. `speculation`, `session_memory`, `prompt_suggestion` 및 기타 단기 에이전트는 1~3턴만 실행하며 전후 비교 값이 없습니다.
4. **맵 용량 제한**: `MAX_TRACKED_SOURCES = 10`, 많은 하위 에이전트 에이전트 ID로 인한 무제한 메모리 증가 방지

------------------------------------------------------------------------

## <a href="#143-phase-1-recordpromptstate-deep-dive" class="header">14.3 1단계: RecordPromptState() 심층 분석</a>

### <a href="#first-call-establishing-the-baseline" class="header">첫 번째 요청: 기준선 설정</a>

`recordPromptState()`에 대한 첫 번째 호출에서는 비교할 이전 상태가 없습니다. 이 함수는 다음 두 가지 작업만 수행합니다.

1. 지도 용량을 확인하고 제한에 도달하면 가장 오래된 항목을 제거합니다.
2. `pendingChanges`를 `null`로 설정하여 초기 `PreviousState` 스냅샷을 생성합니다.

``` typescript
// promptCacheBreakDetection.ts:298-328
if (!prev) {
  while (previousStateBySource.size >= MAX_TRACKED_SOURCES) {
    const oldest = previousStateBySource.keys().next().value
    if (oldest !== undefined) previousStateBySource.delete(oldest)
  }

  previousStateBySource.set(key, {
    systemHash,
    toolsHash,
    cacheControlHash,
    toolNames,
    // ... all initial values
    callCount: 1,
    pendingChanges: null,
    prevCacheReadTokens: null,
    cacheDeletionsPending: false,
    buildDiffableContent: lazyDiffableContent,
    perToolHashes: computeToolHashes(),
  })
  return
}
```

### <a href="#subsequent-calls-change-detection" class="header">후속 호출: 변경 감지</a>

후속 호출에서 함수는 각 필드를 이전 상태와 비교합니다.

``` typescript
// promptCacheBreakDetection.ts:332-346
const systemPromptChanged = systemHash !== prev.systemHash
const toolSchemasChanged = toolsHash !== prev.toolsHash
const modelChanged = model !== prev.model
const fastModeChanged = isFastMode !== prev.fastMode
const cacheControlChanged = cacheControlHash !== prev.cacheControlHash
const globalCacheStrategyChanged =
  globalCacheStrategy !== prev.globalCacheStrategy
const betasChanged =
  sortedBetas.length !== prev.betas.length ||
  sortedBetas.some((b, i) => b !== prev.betas[i])
const autoModeChanged = autoModeActive !== prev.autoModeActive
const overageChanged = isUsingOverage !== prev.isUsingOverage
const cachedMCChanged = cachedMCEnabled !== prev.cachedMCEnabled
const effortChanged = effortStr !== prev.effortValue
const extraBodyChanged = extraBodyHash !== prev.extraBodyHash
```

필드가 변경된 경우 함수는 `PendingChanges` 객체를 생성합니다.

``` typescript
// promptCacheBreakDetection.ts:71-99
type PendingChanges = {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  modelChanged: boolean
  fastModeChanged: boolean
  cacheControlChanged: boolean
  globalCacheStrategyChanged: boolean
  betasChanged: boolean
  autoModeChanged: boolean
  overageChanged: boolean
  cachedMCChanged: boolean
  effortChanged: boolean
  extraBodyChanged: boolean
  addedToolCount: number
  removedToolCount: number
  systemCharDelta: number
  addedTools: string[]
  removedTools: string[]
  changedToolSchemas: string[]
  previousModel: string
  newModel: string
  prevGlobalCacheStrategy: string
  newGlobalCacheStrategy: string
  addedBetas: string[]
  removedBetas: string[]
  prevEffortValue: string
  newEffortValue: string
  buildPrevDiffableContent: () => string
}
```

`PendingChanges`는 내용이 변경되었는지 여부**(부울 플래그)뿐만 아니라 변경된 방법**(추가/제거된 도구, 추가/제거된 베타 헤더 목록, 문자 수 델타 등)도 기록합니다. 이러한 세부 사항은 2단계의 중단 설명에 매우 중요합니다.

### <a href="#precise-attribution-of-tool-changes" class="header">도구 변경 사항의 정확한 귀속</a>

`toolSchemasChanged`가 true인 경우 시스템은 어떤 특정 도구가 변경되었는지 추가로 분석합니다.

``` typescript
// promptCacheBreakDetection.ts:366-378
if (toolSchemasChanged) {
  const newHashes = computeToolHashes()
  for (const name of toolNames) {
    if (!prevToolSet.has(name)) continue
    if (newHashes[name] !== prev.perToolHashes[name]) {
      changedToolSchemas.push(name)
    }
  }
  prev.perToolHashes = newHashes
}
```

이 코드는 도구 변경 사항을 세 가지 유형으로 분류합니다.

- **추가된 도구**: 새 목록에는 있지만 이전 목록에는 없음(`addedTools`)
- **제거된 도구**: 이전 목록에는 있지만 새 목록에는 없음(`removedTools`)
- **스키마 변경**: 도구는 여전히 존재하지만 해당 스키마 해시가 다릅니다(`changedToolSchemas`).

세 번째 범주가 가장 일반적입니다. AgentTool 및 SkillTool 설명에는 세션 상태에 따라 변경되는 동적 에이전트 목록과 명령 목록이 포함되어 있습니다.

------------------------------------------------------------------------

## <a href="#144-phase-2-checkresponseforcachebreak-deep-dive"
class="header">14.4 2단계: checkResponseForCacheBreak() 심층 분석</a>

### <a href="#break-determination-criteria" class="header">브레이크 판정기준</a>

2단계는 API 응답이 반환된 후 호출됩니다. 핵심 논리는 캐시가 실제로 버스트되었는지 여부를 결정합니다.

``` typescript
// promptCacheBreakDetection.ts:485-493
const tokenDrop = prevCacheRead - cacheReadTokens
if (
  cacheReadTokens >= prevCacheRead * 0.95 ||
  tokenDrop < MIN_CACHE_MISS_TOKENS
) {
  state.pendingChanges = null
  return
}
```

결정에는 이중 임계값이 사용됩니다.

1. **상대적 임계값**: 캐시 읽기 토큰이 5% 이상 감소했습니다(`< prevCacheRead * 0.95`).
2. **절대적 기준**: 드롭이 2,000개 토큰을 초과합니다(`MIN_CACHE_MISS_TOKENS = 2_000`).

중단 경고를 트리거하려면 두 조건이 모두 **동시에** 충족되어야 합니다. 이렇게 하면 두 가지 유형의 거짓 긍정을 방지할 수 있습니다.

- 작은 변동: 캐시 토큰 수(수백 개의 토큰)의 자연스러운 변동으로 인해 경고가 트리거되지 않습니다.
- 비율 증폭: 기준이 작은 경우(예: 1,000개 토큰) 5% 변동은 50개 토큰에 불과하므로 경고할 가치가 없습니다.

### <a href="#special-case-cache-deletion" class="header">특별한 경우: 캐시 삭제</a>

캐시 편집(Cached Microcompact)은 `cache_edits`를 통해 캐시에서 콘텐츠 블록을 적극적으로 삭제할 수 있습니다. 이로 인해 `cache_read_input_tokens`가 삭제되는 것이 합법적입니다. 이는 예상된 동작이며 중단 경고를 트리거해서는 안 됩니다.

``` typescript
// promptCacheBreakDetection.ts:473-481
if (state.cacheDeletionsPending) {
  state.cacheDeletionsPending = false
  logForDebugging(
    `[PROMPT CACHE] cache deletion applied, cache read: ` +
    `${prevCacheRead} → ${cacheReadTokens} (expected drop)`,
  )
  state.pendingChanges = null
  return
}
```

`cacheDeletionsPending` 플래그는 삭제 작업을 보낼 때 캐시 편집 모듈에서 호출되는 `notifyCacheDeletion()` 함수(673-682행)를 통해 설정됩니다.

### <a href="#special-case-compaction" class="header">특별한 경우: 압축</a>

압축 작업(`/compact`)은 메시지 수를 크게 줄여 캐시 읽기 토큰이 자연스럽게 삭제되도록 합니다. The `notifyCompaction()` function (lines 689–698) handles this by resetting `prevCacheReadTokens` to `null` — the next call is treated as a "first call" with no comparison:

``` typescript
// promptCacheBreakDetection.ts:689-698
export function notifyCompaction(
  querySource: QuerySource,
  agentId?: AgentId,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    state.prevCacheReadTokens = null
  }
}
```

------------------------------------------------------------------------

## <a href="#145-break-explanation-engine" class="header">14.5 중단 설명 엔진</a>

캐시 중단이 확인되면 시스템은 1단계에서 수집된 `PendingChanges`를 사용하여 사람이 읽을 수 있는 설명을 구성합니다. 설명 엔진은 라인 495-588의 `checkResponseForCacheBreak()`에 있습니다.

### <a href="#client-side-attribution" class="header">클라이언트 측 기여</a>

`PendingChanges`의 변경 플래그가 true인 경우 시스템은 해당 설명 텍스트를 생성합니다.

``` typescript
// promptCacheBreakDetection.ts:496-563 (simplified)
const parts: string[] = []
if (changes) {
  if (changes.modelChanged) {
    parts.push(`model changed (${changes.previousModel} → ${changes.newModel})`)
  }
  if (changes.systemPromptChanged) {
    const charInfo = charDelta > 0 ? ` (+${charDelta} chars)` : ` (${charDelta} chars)`
    parts.push(`system prompt changed${charInfo}`)
  }
  if (changes.toolSchemasChanged) {
    const toolDiff = changes.addedToolCount > 0 || changes.removedToolCount > 0
      ? ` (+${changes.addedToolCount}/-${changes.removedToolCount} tools)`
      : ' (tool prompt/schema changed, same tool set)'
    parts.push(`tools changed${toolDiff}`)
  }
  if (changes.betasChanged) {
    const added = changes.addedBetas.length ? `+${changes.addedBetas.join(',')}` : ''
    const removed = changes.removedBetas.length ? `-${changes.removedBetas.join(',')}` : ''
    parts.push(`betas changed (${[added, removed].filter(Boolean).join(' ')})`)
  }
  // ... similar explanation logic for other fields
}
```

설명 엔진의 설계 원칙은 **추상적인 것보다 구체적입니다**. 단순히 "캐시가 손상되었습니다"라고 말하는 것이 아니라 어떤 필드가 얼마나 변경되었는지 정확하게 나열합니다.

### <a href="#independent-reporting-logic-for-cachecontrol-changes"
class="header">캐시 제어 변경 사항에 대한 독립적인 보고 논리</a>

설명 엔진에서 `cacheControlChanged`에는 특별한 보고 조건이 있습니다.

``` typescript
// promptCacheBreakDetection.ts:528-535
if (
  changes.cacheControlChanged &&
  !changes.globalCacheStrategyChanged &&
  !changes.systemPromptChanged
) {
  parts.push('cache_control changed (scope or TTL)')
}
```

`cacheControlChanged`는 글로벌 캐시 전략이나 시스템 프롬프트가 변경되지 않은 경우에만 독립적으로 보고됩니다. 이유: 전역 캐시 전략이 변경된 경우(예: `tool_based`에서 `system_prompt`로 전환) `cache_control` 변경은 단지 전략 변경의 **결과**일 뿐이며 중복 보고가 필요하지 않습니다. 마찬가지로, 시스템 프롬프트가 변경된 경우 새 콘텐츠 블록이 캐시 마커를 재구성했기 때문에 `cache_control`만 변경되었을 수 있습니다.

### <a href="#ttl-expiry-detection" class="header">TTL 만료 감지</a>

클라이언트 측 변경 사항이 감지되지 않으면(`parts.length === 0`) 시스템은 TTL 만료로 인해 캐시 무효화가 발생했는지 여부를 확인합니다.

``` typescript
// promptCacheBreakDetection.ts:566-588
const lastAssistantMsgOver5minAgo =
  timeSinceLastAssistantMsg !== null &&
  timeSinceLastAssistantMsg > CACHE_TTL_5MIN_MS
const lastAssistantMsgOver1hAgo =
  timeSinceLastAssistantMsg !== null &&
  timeSinceLastAssistantMsg > CACHE_TTL_1HOUR_MS

let reason: string
if (parts.length > 0) {
  reason = parts.join(', ')
} else if (lastAssistantMsgOver1hAgo) {
  reason = 'possible 1h TTL expiry (prompt unchanged)'
} else if (lastAssistantMsgOver5minAgo) {
  reason = 'possible 5min TTL expiry (prompt unchanged)'
} else if (timeSinceLastAssistantMsg !== null) {
  reason = 'likely server-side (prompt unchanged, <5min gap)'
} else {
  reason = 'unknown cause'
}
```

TTL 만료 감지는 메시지 기록에서 가장 최근 보조 메시지의 타임스탬프를 찾아 시간 간격을 계산합니다. 두 개의 TTL 상수는 파일 상단(125~126행)에 정의되어 있습니다.

``` typescript
// promptCacheBreakDetection.ts:125-126
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000
export const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000
```

### <a href="#server-side-attribution-90-of-breaks-are-server-side"
class="header">서버측 속성: "중단의 90%가 서버측입니다"</a>

가장 중요한 설명은 573~576행에 있습니다.

``` typescript
// promptCacheBreakDetection.ts:573-576
// Post PR #19823 BQ analysis:
// when all client-side flags are false and the gap is under TTL, ~90% of breaks
// are server-side routing/eviction or billed/inference disagreement. Label
// accordingly instead of implying a CC bug hunt.
```

이 의견은 BigQuery 데이터 분석 결론을 참조합니다. **클라이언트 측 변경 사항이 감지되지 않고 시간 간격이 TTL 내에 있는 경우 캐시 중단의 약 90%는 서버 측에서 발생합니다**. 구체적인 원인은 다음과 같습니다.

1. **서버 측 라우팅 변경**: 요청이 캐시가 없는 다른 서버 인스턴스로 라우팅되었습니다.
2. **서버 측 캐시 제거**: 부하가 높은 동안 서버는 우선순위가 낮은 캐시 항목을 사전에 제거합니다.
3. **청구/추론 불일치**: 추론은 실제로 캐시를 사용했지만 청구 시스템에서 다른 토큰 수를 보고했습니다.

이 발견은 중단 설명 문구를 "Claude Code에 버그가 있음"을 암시하는 것에서 명시적으로 "서버 측일 가능성이 있는" 레이블을 지정하는 것으로 변경하여 개발자가 존재하지 않는 클라이언트 측 문제를 찾는 데 시간을 낭비하지 않도록 방지합니다.

------------------------------------------------------------------------

## <a href="#146-diagnostic-output" class="header">14.6 진단 출력</a>

중단 감지의 최종 출력에는 다음 두 부분이 포함됩니다.

### <a href="#analytics-event" class="header">분석 이벤트</a>

`tengu_prompt_cache_break` 이벤트는 전체 차량 분석을 위해 BigQuery로 전송됩니다.

``` typescript
// promptCacheBreakDetection.ts:590-644
logEvent('tengu_prompt_cache_break', {
  systemPromptChanged: changes?.systemPromptChanged ?? false,
  toolSchemasChanged: changes?.toolSchemasChanged ?? false,
  modelChanged: changes?.modelChanged ?? false,
  // ... all change flags
  addedTools: (changes?.addedTools ?? []).map(sanitizeToolName).join(','),
  removedTools: (changes?.removedTools ?? []).map(sanitizeToolName).join(','),
  changedToolSchemas: (changes?.changedToolSchemas ?? []).map(sanitizeToolName).join(','),
  addedBetas: (changes?.addedBetas ?? []).join(','),
  removedBetas: (changes?.removedBetas ?? []).join(','),
  callNumber: state.callCount,
  prevCacheReadTokens: prevCacheRead,
  cacheReadTokens,
  cacheCreationTokens,
  timeSinceLastAssistantMsg: timeSinceLastAssistantMsg ?? -1,
  lastAssistantMsgOver5minAgo,
  lastAssistantMsgOver1hAgo,
  requestId: requestId ?? '',
})
```

분석 이벤트는 변경 플래그, 토큰 통계, 시간 간격, 요청 ID의 전체 세트를 기록하므로 후속 BigQuery 분석을 다양한 차원(변경 유형, 기간, 쿼리 소스 등)으로 분할할 수 있습니다.

### <a href="#debug-diff-file-and-logs" class="header">디버그 Diff 파일 및 로그</a>

클라이언트 측 변경 사항이 감지되면 시스템은 이전 상태와 이후 상태 간의 차이점을 한 줄씩 보여주는 diff 파일을 생성합니다.

``` typescript
// promptCacheBreakDetection.ts:648-660
let diffPath: string | undefined
if (changes?.buildPrevDiffableContent) {
  diffPath = await writeCacheBreakDiff(
    changes.buildPrevDiffableContent(),
    state.buildDiffableContent(),
  )
}

const summary = `[PROMPT CACHE BREAK] ${reason} ` +
  `[source=${querySource}, call #${state.callCount}, ` +
  `cache read: ${prevCacheRead} → ${cacheReadTokens}, ` +
  `creation: ${cacheCreationTokens}${diffSuffix}]`

logForDebugging(summary, { level: 'warn' })
```

diff 파일은 `writeCacheBreakDiff()`(708-727행)에 의해 생성되며, `createPatch` 라이브러리를 사용하여 임시 디렉토리에 저장된 표준 통합 diff 형식을 생성합니다. 파일 이름에는 충돌을 피하기 위해 임의의 접미사가 포함됩니다.

### <a href="#tool-name-sanitization" class="header">도구 이름 삭제</a>

중단 감지 시스템은 분석 이벤트에서 변경된 도구 이름을 보고해야 합니다. 그러나 MCP 도구 이름은 사용자가 구성하며 파일 경로나 기타 민감한 정보를 포함할 수 있습니다. `sanitizeToolName()` 함수(183-185행)는 이 문제를 해결합니다.

``` typescript
// promptCacheBreakDetection.ts:183-185
function sanitizeToolName(name: string): string {
  return name.startsWith('mcp__') ? 'mcp' : name
}
```

`mcp__`로 시작하는 모든 도구 이름은 `'mcp'`로 균일하게 대체되며, 내장된 도구 이름은 고정된 어휘이므로 분석에 안전하게 포함될 수 있습니다.

------------------------------------------------------------------------

## <a href="#147-complete-detection-flow" class="header">14.7 완전한 탐지 흐름</a>

두 단계를 결합하면 전체 캐시 중단 감지 흐름은 다음과 같습니다.

사용자가 새 쿼리 입력 │ ▼ ┌──────────────────────────────────┐ │ API 요청 구성 │ │ (시스템 프롬프트 + 도구 + 메시지) │ └──────────────┬────────────────┘ │ ▼ ┌─────────────────────────────────┐ │ RecordPromptState() [1단계] │ │ │ │ ① 모든 해시 계산 │ │ ② 이전 상태 조회 │ │ ③ 이전 상태 없음 → 초기 스냅 생성 │ │ ④ 이전 있음 → 필드 비교 │ │ 필드 │ │ ⑤ 변경 사항 발견 → 생성 │ │ PendingChanges │ │ 6 이전 상태 업데이트 │ └────────────────┬────────────────┘ │ ▼ [API 요청 보내기] │ ▼ [API 응답 받기] │ ▼ ┌─────────────────────────────────┐ │ checkResponseForCacheBreak() │ │ [2단계] │ │ │ │ ① 이전 상태 가져오기 │ │ ② 하이쿠 모델 제외 │ │ ③ 캐시 삭제 보류 확인 │ │ ④ 토큰 드롭 계산 │ │ ⑤ 이중 임계값 적용 │ │ (> 5% AND > 2,000 토큰) │ │ ⑥ 중단 없음 → 지우기 보류 중, │ │ 반환 │ │ 반환 │ │ 중단 확인됨 → 빌드 │ │ 설명 │ │ - 클라이언트 변경 → 나열 │ │ - 변경 없음 + 과거 TTL → │ │ TTL 만료 │ │ - 변경 없음 + TTL 내 → │ │ 서버 측 │ │ 8 분석 이벤트 보내기 │ │ 9 쓰기 diff 파일 │ │ ⑩ 디버그 로그 출력 │ └────────────────────────────────┘

**그림 14-2: 전체 캐시 중단 감지 흐름**

------------------------------------------------------------------------

## <a href="#148-excluded-models-and-cleanup-mechanisms"
class="header">14.8 제외된 모델과 정리 메커니즘</a>

### <a href="#excluded-models" class="header">제외 모델</a>

모든 모델이 캐시 중단 감지에 적합한 것은 아닙니다.

``` typescript
// promptCacheBreakDetection.ts:129-131
function isExcludedModel(model: string): boolean {
  return model.includes('haiku')
}
```

Haiku 모델은 캐싱 동작이 다르기 때문에 탐지에서 제외됩니다. 이렇게 하면 모델 차이로 인한 잘못된 긍정을 방지할 수 있습니다.

### <a href="#cleanup-mechanisms" class="header">정리 메커니즘</a>

시스템은 다양한 시나리오에 대해 세 가지 정리 기능을 제공합니다.

``` typescript
// promptCacheBreakDetection.ts:700-706
// Clean up tracking state when an agent ends
export function cleanupAgentTracking(agentId: AgentId): void {
  previousStateBySource.delete(agentId)
}

// Full reset (/clear command)
export function resetPromptCacheBreakDetection(): void {
  previousStateBySource.clear()
}
```

`cleanupAgentTracking`는 하위 에이전트가 종료될 때 호출되어 해당 `PreviousState`가 차지한 메모리를 해제합니다. `resetPromptCacheBreakDetection`는 사용자가 `/clear`를 실행하여 모든 추적 상태를 지울 때 호출됩니다.

------------------------------------------------------------------------

## <a href="#149-design-insights" class="header">14.9 디자인 통찰력</a>

### <a href="#two-phases-is-the-only-correct-architecture"
class="header">2단계가 유일한 올바른 아키텍처입니다.</a>

캐시 중단 감지를 위한 2단계 아키텍처는 설계상의 선택이 아닙니다. 이는 문제의 타이밍 제약에 따라 결정되는 유일한 올바른 솔루션입니다. 이유: 원래 상태는 요청이 전송되기 전에만 존재하는 반면 중단 확인은 응답이 반환된 후에만 발생할 수 있습니다. 단일 단계에서 두 가지를 모두 수행하려고 하면 중요한 정보가 손실됩니다.

### <a href="#90-server-side-changed-engineering-decisions"
class="header">"90% 서버 측" 변경된 엔지니어링 결정</a>

대부분의 캐시 중단이 서버 측에서 발생한다는 사실을 발견한 후 Claude Code 팀은 최적화 초점을 "모든 클라이언트 측 변경 사항 제거"에서 "클라이언트 측 변경 사항을 제어할 수 있도록 보장"으로 전환했습니다. 이는 13장의 래칭 메커니즘이 왜 그렇게 중요한지 설명합니다. 캐시 중단을 100% 제거할 필요는 없으며 클라이언트가 제어할 수 있는 10%만 더 이상 문제를 일으키지 않도록 보장해야 합니다.

### <a href="#observability-before-optimization"
class="header">최적화 전 관찰 가능성</a>

전체 캐시 중단 감지 시스템은 캐시 최적화를 수행하지 않으며 순전히 관찰성 인프라입니다. 그러나 15장의 최적화 패턴을 가능하게 하는 것은 바로 이러한 관찰 가능성입니다. 정확한 중단 감지 없이는 최적화 효과를 정량화할 수 없으며 새로운 최적화 기회를 발견할 수도 없습니다. BigQuery의 `tengu_prompt_cache_break` 이벤트 데이터는 여러 최적화 패턴의 발견과 검증을 직접적으로 주도했습니다.

------------------------------------------------------------------------

## <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

이 장에서 분석된 캐시 중단 감지 메커니즘을 기반으로 캐시 중단을 모니터링하고 진단하기 위한 실제 지침은 다음과 같습니다.

1. **애플리케이션에 대한 캐시 기준 설정**: 일반 세션에서 `cache_read_input_tokens`의 일반적인 값을 기록합니다. 기준선이 없으면 하락이 비정상적인지 여부를 확인할 수 없습니다. Claude Code는 이중 임계값(\>5% AND \>2,000개 토큰)을 사용하여 노이즈를 필터링합니다. 또한 시나리오에 적합한 임계값을 설정해야 합니다.

2. **클라이언트 측 변경 사항과 서버 측 원인 구별**: 캐시 적중률 저하가 관찰되면 먼저 클라이언트가 변경되었는지 확인하세요(시스템 프롬프트, 도구 정의, 베타 헤더 등). 클라이언트가 변경되지 않았고 시간 간격이 TTL 내에 있는 경우 서버 측 라우팅 또는 제거일 가능성이 높습니다. 존재하지 않는 클라이언트 측 버그를 찾는 데 시간을 낭비하지 마십시오.

3. **요청에 대한 상태 스냅샷 메커니즘 구축**: 캐시 중단을 진단해야 하는 경우 각 요청 전에 키 상태를 기록합니다(시스템 프롬프트 해시, 도구 스키마 해시, 요청 헤더 목록). 요청 전 상태를 캡처해야만 응답 후 변경 원인을 추적할 수 있습니다.

4. **TTL 만료는 일반적인 정당한 원인입니다**: 사용자 요청 사이에 긴 일시 중지가 있는 경우(TTL 계층에 따라 5분 또는 1시간 이상) 자연 캐시 만료는 정상이며 특별한 처리가 필요하지 않습니다.

5. **도구 변경에 대한 세분화된 속성 수행**: 애플리케이션이 동적 도구 세트(MCP 등)를 사용하는 경우 도구 스키마 변경이 감지되면 도구 추가/제거와 단일 도구 스키마 변경을 더욱 구분합니다. 후자가 더 일반적이며(Claude Code 데이터에 따르면 도구 변경 사항의 77%가 이 범주에 속함) 세션 수준 캐싱으로 해결하기가 더 쉽습니다.

### <a href="#advice-for-claude-code-users" class="header">Claude Code 사용자를 위한 조언</a>

1. **캐시 중단 관찰 가능성 신호를 이해합니다.** `tengu_prompt_cache_break` 이벤트는 모든 캐시 중단을 기록합니다. 자체 에이전트를 구축하는 경우 유사한 중단 감지를 구현하면 캐시 무효화 원인을 빠르게 식별하는 데 도움이 됩니다.
2. **시스템 프롬프트에 타임스탬프를 넣지 마세요.** CC는 날짜 변경으로 인해 캐시 접두사가 무효화되는 것을 방지하기 위해 날짜 문자열을 정확하게 "메모화"합니다(하루에 한 번만 변경됨). 또한 에이전트는 캐시된 영역 내에 자주 변경되는 콘텐츠를 배치하지 않아야 합니다.
3. **캐시된 세그먼트 외부에 동적 콘텐츠를 배치합니다.** CC는 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`를 사용하여 동적 콘텐츠에서 안정적인 콘텐츠를 분리합니다. 안정적인 부분은 캐시 가능하며 동적 부분은 매번 다시 계산됩니다. 시스템 프롬프트를 디자인할 때 "헌법 규칙"을 먼저 배치하고 "런타임 상태"를 마지막에 배치하십시오.

------------------------------------------------------------------------

## <a href="#summary" class="header">요약</a>

이 장에서는 Claude Code의 캐시 중단 감지 시스템을 심층적으로 분석했습니다.

1. **2단계 아키텍처**: `recordPromptState()`는 요청 전에 상태를 캡처하고 변경 사항을 감지합니다. `checkResponseForCacheBreak()`는 중단을 확인하고 응답 후 진단을 생성합니다.
2. **15개 이상의 필드가 있는 PreviousState**: 서버 측 캐시 키에 영향을 줄 수 있는 모든 클라이언트 측 상태를 포함합니다.
3. **중단 설명 엔진**: 클라이언트측 변경 사항, TTL 만료, 서버측 원인을 구별하여 정확한 속성 제공
4. **데이터 기반 통찰력**: "90%의 중단이 서버 측에서 발생합니다"라는 조사 결과가 전체 캐시 최적화 전략을 변경했습니다.

다음 장은 Claude Code가 7개 이상의 명명된 캐시 최적화 패턴을 통해 소스에서 캐시 중단을 줄이는 방법인 사전 예방적 최적화로 전환됩니다.
