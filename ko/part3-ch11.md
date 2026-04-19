# <a href="#chapter-11-micro-compaction--precise-context-pruning"
class="header">11장: 미세 압축 - 정확한 컨텍스트 가지치기</a>

> *"가장 저렴한 토큰은 절대 보내지 않는 토큰입니다."*

이전 장(9장)에서 자동 압축을 철저하게 분석했습니다. 즉, 컨텍스트가 창 한계에 도달하면 Claude Code는 전체 대화를 구조화된 요약으로 압축합니다. 이것은 "핵 옵션"입니다. 효과적이지만 비용이 많이 듭니다. 대화의 원래 세부 정보가 손실되며 요약을 생성하려면 전체 LLM 호출이 필요합니다.

이 장의 주인공은 가벼운 컨텍스트 가지치기 전략인 **마이크로 압축**입니다. 요약을 생성하지 않고 LLM을 호출하지 않지만 대신 이전 도구 호출 결과를 직접 **지우거나 삭제**합니다. 3분 전의 `grep` 출력 200줄, 30분 전의 구성 파일 `cat`, 1시간 전의 Bash 명령 로그 — 이 정보는 모델의 현재 추론 작업에 대해 "오래된" 정보입니다. Micro-compaction의 핵심 철학은 **이러한 오래된 콘텐츠가 귀중한 컨텍스트 공간을 차지하도록 두는 대신 적절한 순간에 정확하게 제거하는 것**입니다.

Claude Code는 트리거 조건, 실행 접근 방식 및 캐시 영향이 근본적으로 다른 세 가지 마이크로 압축 메커니즘을 구현합니다.

<div class="table-wrapper">

| 차원 | 시간 기반 미세 다짐 | 캐시된 마이크로 압축(cache_edits) | API 컨텍스트 관리 |
|----|----|----|----|
| **방아쇠** | 마지막 보조 메시지 이후의 시간 간격이 임계값을 초과했습니다. | 압축 가능한 도구 수가 임계값을 초과합니다. | API 측 input_tokens가 임계값을 초과합니다. |
| **실행 위치** | 클라이언트 측(메시지 내용 수정) | 서버측(cache_edits 지시문) | 서버측(context_management 전략) |
| **캐시 영향** | 캐시 접두어를 끊습니다(캐시가 만료되었기 때문에 예상되는 동작). | 캐시 접두사를 그대로 유지합니다. | API 레이어에서 관리 |
| **수정 접근 방식** | tool_result.content를 자리 표시자 텍스트로 바꿉니다. | Cache_edits 삭제 지시문을 보냅니다. | 선언적 전략, API가 자동으로 실행됩니다. |
| **적용 조건** | 오랜 유휴 기간 후 세션 재개 | 활성 세션 중 증분 가지치기 | 모든 세션(개미 사용자, 사고 모델) |
| **소스 진입점** | `maybeTimeBasedMicrocompact()` | `cachedMicrocompactPath()` | `getAPIContextManagement()` |
| **기능 게이트** | `tengu_slate_heron` (그로스북) | `CACHED_MICROCOMPACT`(빌드) | 환경 변수 토글 |

</div>

이 세 가지 메커니즘 사이의 우선순위 관계도 명확합니다. 시간 기반 트리거가 먼저 실행되고 단락되고, 캐시된 마이크로 압축이 그 다음에 오고, API 컨텍스트 관리가 항상 존재하는 독립적인 선언적 계층으로 존재합니다.

------------------------------------------------------------------------

> **대화형 버전**: [마이크로 압축 애니메이션을 보려면 클릭하세요](microcompact-viz.html) — 메시지를 하나씩 평가합니다. 주요 결론을 유지하고, 중복된 세부 정보를 정리하고, 오래된 콘텐츠를 제거합니다.

## <a
href="#111-time-based-micro-compaction-batch-cleanup-after-cache-expiry"
class="header">11.1 시간 기반 마이크로 압축: 캐시 만료 후 일괄 정리</a>

### <a href="#1111-design-intuition" class="header">11.1.1 디자인 직관</a>

다음 시나리오를 상상해 보십시오. 오전 10시에 Claude Code를 사용하여 복잡한 리팩터링을 완료한 다음 점심을 먹으러 갑니다. 오후 1시에 돌아와서 계속 일합니다. 3시간의 공백이 있습니다.

그 3시간 동안 무슨 일이 있었던 걸까요? **서버측 프롬프트 캐시가 만료되었습니다.** Anthropic의 프롬프트 캐시에는 5분(표준)과 1시간(확장)의 두 가지 TTL 계층이 있습니다. 등급에 관계없이 둘 다 3시간 후에 만료되었습니다. 이는 다음 API 호출이 **전체 대화 기록**을 캐시에 다시 작성한다는 것을 의미합니다. 모든 단일 토큰은 캐시 생성으로 다시 청구됩니다.

따라서 시간 기반 마이크로 압축의 논리는 매우 자연스럽습니다. **캐시가 만료되었고 어쨌든 전체 접두사를 다시 작성해야 하므로 불필요한 오래된 콘텐츠를 먼저 정리하여 다시 작성하는 작업을 더 작고 저렴하게 만드는 것이 좋습니다**.

### <a href="#1112-configuration-parameters" class="header">11.1.2 구성 매개변수</a>

구성은 `TimeBasedMCConfig`로 입력되는 GrowthBook 기능 플래그 `tengu_slate_heron`를 통해 제공됩니다.

``` typescript
// services/compact/timeBasedMCConfig.ts:18-28
export type TimeBasedMCConfig = {
  /** Master switch. When false, time-based microcompact is a no-op. */
  enabled: boolean
  /** Trigger when (now - last assistant timestamp) exceeds this many minutes. */
  gapThresholdMinutes: number
  /** Keep this many most-recent compactable tool results. */
  keepRecent: number
}

const TIME_BASED_MC_CONFIG_DEFAULTS: TimeBasedMCConfig = {
  enabled: false,
  gapThresholdMinutes: 60,
  keepRecent: 5,
}
```

세 가지 매개변수 각각에는 고유한 근거가 있습니다.

- **`enabled`** 기본값은 꺼짐입니다. 이는 점진적인 롤아웃 기능이며 GrowthBook을 통해 점진적으로 활성화됩니다.
- **`gapThresholdMinutes: 60`**는 서버의 1시간 캐시 TTL과 일치합니다. 이는 "안전한 선택"입니다. 소스 주석(23행)은 다음과 같이 명시적으로 명시합니다. "서버의 1시간 캐시 TTL은 모든 사용자에 대해 만료가 보장되므로 발생하지 않았을 누락을 강제하지 않습니다."
- **`keepRecent: 5`**는 5개의 최신 도구 결과를 유지하여 모델에 최소한의 작업 컨텍스트를 제공합니다.

### <a href="#1113-trigger-determination" class="header">11.1.3 트리거 결정</a>

`evaluateTimeBasedTrigger()` 기능(`microCompact.ts:422-444`)은 부작용이 없는 순수한 결정 기능입니다.

``` typescript
// microCompact.ts:422-444
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const config = getTimeBasedMCConfig()
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  if (!lastAssistant) {
    return null
  }
  const gapMinutes =
    (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }
  return { gapMinutes, config }
}
```

428행의 보호 조건에 유의하세요. `!querySource`는 즉시 null을 반환합니다. 이는 캐시된 마이크로 압축의 동작과 다릅니다. `isMainThreadSource()`(249-251행)는 `undefined`를 기본 스레드(캐시된 MC 하위 호환성을 위해)로 처리하지만 시간 기반 트리거에는 **명시적으로** querySource가 있어야 합니다. 소스 주석(429-431행)에서는 `/context`, `/compact` 및 기타 분석 호출이 소스 없이 `microcompactMessages()`를 호출하며 시간 기반 정리를 트리거해서는 안 된다고 설명합니다.

### <a href="#1114-execution-logic" class="header">11.1.4 실행 논리</a>

트리거 조건이 충족되면 `maybeTimeBasedMicrocompact()`는 다음 단계를 실행합니다.

``` mermaid
flowchart TD
    A["maybeTimeBasedMicrocompact(messages, querySource)"] --> B{"evaluateTimeBasedTrigger()"}
    B -->|null| C["Return null (don't trigger)"]
    B -->|Triggered| D["collectCompactableToolIds(messages)<br/>Collect all compactable tool IDs"]
    D --> E["keepRecent = Math.max(1, config.keepRecent)<br/>Keep at least 1<br/>(slice(-0) returns entire array)"]
    E --> F["keepSet = compactableIds.slice(-keepRecent)<br/>Keep most recent N"]
    F --> G["clearSet = all remaining to clear"]
    G --> H["Iterate messages, replace clearSet<br/>tool_result.content with placeholder text"]
    H --> I["suppressCompactWarning()<br/>Suppress context pressure warning"]
    I --> J["resetMicrocompactState()<br/>Reset cached MC state"]
    J --> K["notifyCacheDeletion()<br/>Notify cache break detector"]
```

주요 구현 세부 사항은 `microCompact.ts:470-492`에 있습니다. 메시지 수정은 불변 스타일을 사용합니다.

``` typescript
// microCompact.ts:470-492
let tokensSaved = 0
const result: Message[] = messages.map(message => {
  if (message.type !== 'user' || !Array.isArray(message.message.content)) {
    return message
  }
  let touched = false
  const newContent = message.message.content.map(block => {
    if (
      block.type === 'tool_result' &&
      clearSet.has(block.tool_use_id) &&
      block.content !== TIME_BASED_MC_CLEARED_MESSAGE
    ) {
      tokensSaved += calculateToolResultTokens(block)
      touched = true
      return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }
    }
    return block
  })
  if (!touched) return message
  return {
    ...message,
    message: { ...message.message, content: newContent },
  }
})
```

479행의 가드에 주의하세요: `block.content !== TIME_BASED_MC_CLEARED_MESSAGE` — 이는 이미 삭제된 콘텐츠에 대해 `tokensSaved`가 중복 계산되는 것을 방지합니다. 이는 멱등성을 보장합니다. 여러 번 실행해도 tokensSaved 통계가 변경되지 않습니다.

### <a href="#1115-side-effect-chain" class="header">11.1.5 부작용 체인</a>

시간 기반 트리거 실행이 완료되면 세 가지 중요한 부작용이 발생합니다.

1. **`suppressCompactWarning()`** (라인 511): 마이크로 압축으로 컨텍스트 공간이 해제되어 사용자에게 표시되는 "컨텍스트가 채워질 예정" 경고를 억제합니다.
2. **`resetMicrocompactState()`** (라인 517): 캐시된 MC의 도구 등록 상태를 지웁니다. 방금 메시지 내용을 수정하고 서버 캐시를 중단했기 때문에 캐시된 MC의 이전 상태(등록된 도구, 삭제된 도구)가 모두 무효화됩니다.
3. **`notifyCacheDeletion(querySource)`** (라인 526): 다음 API 응답의 캐시_read_tokens가 삭제될 것임을 `promptCacheBreakDetection` 모듈에 알립니다. 이는 캐시 중단 버그가 아니라 예상된 동작입니다.

세 번째 부작용은 특히 미묘합니다. 소스 주석(520-522행)에서는 `notifyCompaction` 대신 `notifyCacheDeletion`가 사용되는 이유를 설명합니다. "notifyCacheDeletion(notifyCompaction 아님)은 이미 여기에 가져왔고 동일한 거짓 긍정 억제를 달성하기 때문입니다. 가져오기에 두 번째 기호를 추가하면 순환 깊이 검사에 의해 플래그가 지정됩니다." 이는 순환 종속성 제약 조건 하에서 실용적인 선택입니다. 두 함수 모두 동일한 효과를 갖지만(둘 다 거짓 긍정 방지) 추가 기호를 가져오면 순환 종속성 감지기가 트리거됩니다.

------------------------------------------------------------------------

## <a
href="#112-cached-micro-compaction-precise-surgery-without-breaking-the-cache"
class="header">11.2 캐시된 마이크로 압축: 캐시를 손상시키지 않는 정밀한 수술</a>

### <a href="#1121-the-core-challenge" class="header">11.2.1 핵심 과제</a>

시간 기반 마이크로 압축에는 근본적인 제한이 있습니다. **메시지 내용을 수정해야 합니다**. 즉, **캐시 접두사가 변경**되고 다음 API 호출에는 전체 캐시 생성 비용이 발생합니다. 캐시가 이미 만료된 경우에는 문제가 되지 않습니다(어차피 다시 작성되고 있음). 그러나 활성 세션 중에는 이는 허용되지 않습니다. 방금 축적한 캐시 접두사는 캐시 생성 비용에서 수만 개의 토큰을 나타낼 수 있습니다.

캐시된 마이크로 압축은 Anthropic의 API `cache_edits` 기능을 통해 이 문제를 해결합니다. 이 기능은 **로컬 메시지 내용을 수정하지 않고** 대신 "서버 측 캐시에서 지정된 도구 결과 삭제" 지시문을 API로 보냅니다. 서버는 캐시 접두사 내에서 이 콘텐츠를 제거하여 접두사 연속성을 유지합니다. 다음 요청은 여전히 ​​기존 캐시에 도달할 수 있습니다.

### <a href="#1122-how-cache_edits-works" class="header">11.2.2 캐시 편집의 작동 방식</a>

다음 시퀀스 다이어그램은 캐시된 마이크로 압축의 전체 수명 주기를 보여줍니다.

``` mermaid
sequenceDiagram
    participant MC as microCompact.ts
    participant API as claude.ts (API layer)
    participant Server as Anthropic API Server

    MC->>MC: 1. registerToolResult()<br/>Register tool_results
    MC->>MC: 2. getToolResultsToDelete()<br/>Check if threshold reached
    MC->>MC: 3. createCacheEditsBlock()<br/>Create cache_edits block
    MC->>API: 4. Store in pendingCacheEdits

    API->>API: 5. consumePendingCacheEdits()
    API->>API: 6. getPinnedCacheEdits()
    API->>API: 7. addCacheBreakpoints()<br/>Insert cache_edits block in user message<br/>Add cache_reference to tool_result

    API->>Server: 8. API Request: messages contain cache_edits
    Server->>Server: 9. Delete corresponding tool_result in cache<br/>Cache prefix remains continuous
    Server-->>API: 10. Response: cache_deleted_input_tokens (cumulative)

    API->>API: 11. pinCacheEdits()
    API->>API: 12. markToolsSentToAPIState()
```

이 흐름을 단계별로 분석해 보겠습니다.

### <a href="#1123-tool-registration-and-threshold-determination"
class="header">11.2.3 도구 등록 및 임계값 결정</a>

`cachedMicrocompactPath()` 기능(`microCompact.ts:305-399`)은 먼저 모든 메시지를 검색하여 압축 가능한 도구 결과를 등록합니다.

``` typescript
// microCompact.ts:313-329
const compactableToolIds = new Set(collectCompactableToolIds(messages))
// Second pass: register tool results grouped by user message
for (const message of messages) {
  if (message.type === 'user' && Array.isArray(message.message.content)) {
    const groupIds: string[] = []
    for (const block of message.message.content) {
      if (
        block.type === 'tool_result' &&
        compactableToolIds.has(block.tool_use_id) &&
        !state.registeredTools.has(block.tool_use_id)
      ) {
        mod.registerToolResult(state, block.tool_use_id)
        groupIds.push(block.tool_use_id)
      }
    }
    mod.registerToolMessage(state, groupIds)
  }
}
```

등록은 두 단계로 이루어집니다. `collectCompactableToolIds()`는 먼저 압축 가능한 도구 세트에 속하는 보조 메시지에서 모든 `tool_use` ID를 수집한 다음 사용자 메시지에서 해당 `tool_result` 항목을 찾아 메시지별로 그룹화하여 등록합니다. Cache_edits 삭제 세분성은 개별 tool_result별로 결정되지만 트리거 결정은 총 도구 수를 기반으로 하므로 그룹화가 필요합니다.

등록 후 삭제할 도구 목록을 가져오기 위해 `mod.getToolResultsToDelete(state)`가 호출됩니다. 이 기능의 로직은 GrowthBook에서 구성한 `triggerThreshold` 및 `keepRecent`에 의해 제어됩니다. 등록된 총 도구 수가 `triggerThreshold`를 초과하는 경우 가장 최근의 `keepRecent`를 유지하고 나머지는 삭제하도록 표시합니다.

### <a href="#1124-cache_edits-block-lifecycle" class="header">11.2.4 캐시_편집 블록 수명주기</a>

도구를 삭제해야 하는 경우 코드는 `CacheEditsBlock`를 생성하여 모듈 수준 변수 `pendingCacheEdits`에 저장합니다.

``` typescript
// microCompact.ts:334-339
const toolsToDelete = mod.getToolResultsToDelete(state)

if (toolsToDelete.length > 0) {
  const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
  if (cacheEdits) {
    pendingCacheEdits = cacheEdits
  }
```

이 `pendingCacheEdits` 변수의 소비자는 API 계층의 `claude.ts`입니다. API 요청 매개변수(라인 1531)를 작성하기 전에 코드는 `consumePendingCacheEdits()`를 호출하여 보류 중인 편집 지시문을 한 번에 검색합니다.

``` typescript
// claude.ts:1531-1532
const consumedCacheEdits = cachedMCEnabled ? consumePendingCacheEdits() : null
const consumedPinnedEdits = cachedMCEnabled ? getPinnedCacheEdits() : []
```

`consumePendingCacheEdits()`의 설계는 **단일 소비**(`microCompact.ts:88-94`)입니다. 호출된 후 즉시 `pendingCacheEdits`를 지웁니다. 소스 주석(1528-1530행)은 `paramsFromContext` 내에서 소비가 발생할 수 없는 이유를 설명합니다. "paramsFromContext는 여러 번 호출되므로(로깅, 재시도) 내부에서 소비하면 첫 번째 호출이 후속 호출에서 편집 내용을 훔치게 됩니다."

### <a href="#1125-inserting-cache_edits-into-the-api-request"
class="header">11.2.5 API 요청에 캐시_편집 삽입</a>

`addCacheBreakpoints()` 함수(`claude.ts:3063-3162`)는 캐시_편집 지시문을 메시지 배열에 연결하는 역할을 합니다. 핵심 논리에는 세 단계가 있습니다.

**1단계: 고정된 수정사항 다시 삽입**(3128-3139행)

``` typescript
// claude.ts:3128-3139
for (const pinned of pinnedEdits ?? []) {
  const msg = result[pinned.userMessageIndex]
  if (msg && msg.role === 'user') {
    if (!Array.isArray(msg.content)) {
      msg.content = [{ type: 'text', text: msg.content as string }]
    }
    const dedupedBlock = deduplicateEdits(pinned.block)
    if (dedupedBlock.edits.length > 0) {
      insertBlockAfterToolResults(msg.content, dedupedBlock)
    }
  }
}
```

각 API 호출에서 이전에 전송된 캐시_편집은 **동일한 위치**에서 다시 전송되어야 합니다. 서버는 캐시 접두어를 올바르게 다시 작성하기 위해 완전하고 일관된 편집 기록을 확인해야 합니다. 이것이 `pinnedEdits`의 목적입니다.

**2단계: 새 수정사항 삽입**(3142-3162행)

새로운 캐시_편집 블록이 **마지막 사용자 메시지**에 삽입된 다음 `pinCacheEdits(i, newCacheEdits)`를 통해 위치 인덱스가 고정되어 후속 호출이 동일한 위치에서 다시 전송되도록 합니다.

**3단계: 중복 제거**

`deduplicateEdits()` 도우미 기능(3116-3125행)은 `seenDeleteRefs` 세트를 사용하여 동일한 `cache_reference`가 여러 블록에 나타나지 않도록 합니다. 이는 극단적인 경우를 방지합니다. 즉, 동일한 도구 결과가 다른 회전에서 삭제되도록 표시됩니다.

### <a href="#1126-cache_edits-data-structure" class="header">11.2.6 캐시_편집 데이터 구조</a>

API 계층에서 캐시_편집 블록 유형 정의(`claude.ts:3052-3055`)는 매우 간결합니다.

``` typescript
type CachedMCEditsBlock = {
  type: 'cache_edits'
  edits: { type: 'delete'; cache_reference: string }[]
}
```

각 편집은 서버가 각 `tool_result`에 할당하는 고유 식별자인 `cache_reference`를 가리키는 `delete` 작업입니다. 클라이언트는 이전 API 응답에서 이러한 참조를 얻은 다음 후속 요청에서 이를 참조하여 삭제할 콘텐츠를 지정합니다.

### <a href="#1127-baseline-and-delta-tracking" class="header">11.2.7 기준선 및 델타 추적</a>

`cachedMicrocompactPath()`는 결과를 반환할 때 `baselineCacheDeletedTokens` 값을 기록합니다(374-383행).

``` typescript
// microCompact.ts:374-383
const lastAsst = messages.findLast(m => m.type === 'assistant')
const baseline =
  lastAsst?.type === 'assistant'
    ? ((
        lastAsst.message.usage as unknown as Record<
          string,
          number | undefined
        >
      )?.cache_deleted_input_tokens ?? 0)
    : 0
```

API에서 반환된 `cache_deleted_input_tokens`는 **누적 값**입니다. 여기에는 현재 세션의 모든 캐시 편집 작업에 의해 삭제된 총 토큰이 포함됩니다. 현재 작업의 실제 델타를 계산하려면 작업 전 기준을 기록한 다음 API 응답의 새 누적 값에서 빼야 합니다. 이 디자인은 클라이언트 측에서 부정확한 토큰 추정을 방지합니다.

### <a href="#1128-mutual-exclusion-with-time-based-trigger"
class="header">11.2.8 시간 기반 트리거를 사용한 상호 배제</a>

입력 기능 `microcompactMessages()`(라인 253-293)는 엄격한 우선순위를 정의합니다.

``` typescript
// microCompact.ts:267-270
const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
if (timeBasedResult) {
  return timeBasedResult
}
```

시간 기반 트리거가 먼저 실행되고 단락됩니다. 소스 주석(261-266행)은 이유를 설명합니다. "마지막 보조 메시지 이후의 간격이 임계값을 초과하면 서버 캐시가 만료되고 전체 접두사가 관계없이 다시 작성됩니다. 따라서 이제 이전 도구의 콘텐츠 지우기 결과가 발생합니다. 이 작업이 실행되면 캐시된 MC(캐시 편집)를 건너뜁니다. 편집에서는 웜 캐시를 가정하고 방금 콜드 캐시로 설정했습니다."

이것은 우아한 상호 배제 디자인입니다.

- **웜 캐시**: 캐시를 손상시키지 않고 콘텐츠를 삭제하려면 캐시 편집을 사용하세요.
- **콜드 캐시**: 캐시가 이미 만료되었으므로 시간 기반 트리거를 사용하여 콘텐츠를 직접 수정합니다.

두 메커니즘은 동시에 실행되지 않습니다.

------------------------------------------------------------------------

## <a href="#113-api-context-management-declarative-context-management"
class="header">11.3 API 컨텍스트 관리: 선언적 컨텍스트 관리</a>

### <a href="#1131-from-imperative-to-declarative" class="header">11.3.1 명령형에서 선언형으로</a>

앞의 두 가지 미세 압축 메커니즘은 모두 **필수적**입니다. 즉, 삭제할 도구, 시기, 방법을 클라이언트가 결정합니다. API 컨텍스트 관리는 **선언적**입니다. 클라이언트는 "컨텍스트가 X 토큰을 초과하는 경우 Y 유형의 콘텐츠를 지우고 가장 최근 Z를 유지합니다"라고 설명하기만 하면 API 서버가 자동으로 실행됩니다.

이 논리는 `apiMicrocompact.ts`에 있습니다. `getAPIContextManagement()` 함수는 API 요청과 함께 전송되는 `ContextManagementConfig` 객체를 빌드합니다.

``` typescript
// apiMicrocompact.ts:59-62
export type ContextManagementConfig = {
  edits: ContextEditStrategy[]
}
```

### <a href="#1132-two-strategy-types" class="header">11.3.2 두 가지 전략 유형</a>

`ContextEditStrategy` 통합 유형은 두 가지 서버 실행 가능 편집 전략을 정의합니다.

**전략 1: `clear_tool_uses_20250919`**

``` typescript
// apiMicrocompact.ts:36-53
| {
    type: 'clear_tool_uses_20250919'
    trigger?: {
      type: 'input_tokens'
      value: number        // Trigger when input tokens exceed this value
    }
    keep?: {
      type: 'tool_uses'
      value: number        // Keep the most recent N tool uses
    }
    clear_tool_inputs?: boolean | string[]  // Which tools' inputs to clear
    exclude_tools?: string[]                // Which tools to exclude
    clear_at_least?: {
      type: 'input_tokens'
      value: number        // Clear at least this many tokens
    }
  }
```

**전략 2: `clear_thinking_20251015`**

``` typescript
// apiMicrocompact.ts:54-56
| {
    type: 'clear_thinking_20251015'
    keep: { type: 'thinking_turns'; value: number } | 'all'
  }
```

이 전략은 특히 사고 블록을 처리합니다. 확장된 사고 모델(예: 사고가 포함된 Claude Sonnet 4)은 많은 양의 사고 프로세스를 생성하지만 후속 단계에서 그 가치는 빠르게 감소합니다.

### <a href="#1133-strategy-composition-logic" class="header">11.3.3 전략 구성 논리</a>

`getAPIContextManagement()`는 런타임 조건에 따라 여러 전략을 구성합니다.

``` typescript
// apiMicrocompact.ts:64-88
export function getAPIContextManagement(options?: {
  hasThinking?: boolean
  isRedactThinkingActive?: boolean
  clearAllThinking?: boolean
}): ContextManagementConfig | undefined {
  const {
    hasThinking = false,
    isRedactThinkingActive = false,
    clearAllThinking = false,
  } = options ?? {}

  const strategies: ContextEditStrategy[] = []

  // Strategy 1: thinking management
  if (hasThinking && !isRedactThinkingActive) {
    strategies.push({
      type: 'clear_thinking_20251015',
      keep: clearAllThinking
        ? { type: 'thinking_turns', value: 1 }
        : 'all',
    })
  }
  // ...
}
```

사고 전략의 세 가지 가지:

<div class="table-wrapper">

| 상태 | 행동 | 이유 |
|----|----|----|
| `hasThinking && !isRedactThinkingActive && !clearAllThinking` | `keep: 'all'` | 모든 생각을 유지하십시오 (정상 작동 상태) |
| `hasThinking && !isRedactThinkingActive && clearAllThinking` | `keep: { type: 'thinking_turns', value: 1 }` | 마지막 1번의 생각만 유지(유휴 \> 1시간 = 캐시 만료) |
| `isRedactThinkingActive` | 전략을 추가하지 마세요 | 수정된 사고 블록에는 모델에 표시되는 콘텐츠가 없으며 관리가 필요하지 않습니다. |

</div>

`clearAllThinking`는 값을 0 대신 1로 설정합니다. 소스 주석(81행)은 다음과 같이 설명합니다. "API 스키마에는 값 \>= 1이 필요하며 편집을 생략하면 삭제되지 않는 모델 정책 기본값(종종 '모두')으로 대체됩니다."

### <a href="#1134-two-modes-of-tool-clearing" class="header">11.3.4 도구 지우기의 두 가지 모드</a>

`clear_tool_uses_20250919` 전략 내에서 도구 지우기에는 두 가지 보완 모드가 있습니다.

**모드 1: 도구 결과 지우기(`clear_tool_inputs`)**

``` typescript
// apiMicrocompact.ts:104-124
if (useClearToolResults) {
  const strategy: ContextEditStrategy = {
    type: 'clear_tool_uses_20250919',
    trigger: { type: 'input_tokens', value: triggerThreshold },
    clear_at_least: {
      type: 'input_tokens',
      value: triggerThreshold - keepTarget,
    },
    clear_tool_inputs: TOOLS_CLEARABLE_RESULTS,
  }
  strategies.push(strategy)
}
```

`TOOLS_CLEARABLE_RESULTS`(19-26행)에는 **출력은 크지만 일회용**인 도구(셸 명령, Glob, Grep, FileRead, WebFetch, WebSearch)가 포함되어 있습니다. 이러한 도구의 결과는 일반적으로 검색 출력 또는 파일 콘텐츠입니다. 모델은 이미 이를 처리했으며 이를 지워도 후속 추론에 영향을 미치지 않습니다.

**모드 2: 도구 사용 지우기(`exclude_tools`)**

``` typescript
// apiMicrocompact.ts:128-149
if (useClearToolUses) {
  const strategy: ContextEditStrategy = {
    type: 'clear_tool_uses_20250919',
    trigger: { type: 'input_tokens', value: triggerThreshold },
    clear_at_least: {
      type: 'input_tokens',
      value: triggerThreshold - keepTarget,
    },
    exclude_tools: TOOLS_CLEARABLE_USES,
  }
  strategies.push(strategy)
}
```

`TOOLS_CLEARABLE_USES`(28-32행)에는 FileEdit, FileWrite 및 NotebookEdit가 포함되어 있습니다. 이 도구는 **입력**(예: 모델이 보내는 편집 지침)이 일반적으로 출력보다 큽니다. `exclude_tools`의 의미는 "이러한 도구를 제외한 모든 도구 사용 지우기"이므로 API 측에서 보다 적극적으로 정리할 수 있습니다.

두 모드의 기본 매개변수는 동일합니다. `triggerThreshold = 180,000`(자동 압축 경고 임계값과 거의 동일), `keepTarget = 40,000`(마지막 40K 토큰 유지), `clear_at_least = triggerThreshold - keepTarget = 140,000`(최소 140K 토큰 무료). 이 값은 `API_MAX_INPUT_TOKENS` 및 `API_TARGET_INPUT_TOKENS` 환경 변수를 통해 재정의될 수 있습니다.

------------------------------------------------------------------------

## <a href="#114-compactable-tool-set-inventory" class="header">11.4 압축 가능한 도구 세트 목록</a>

세 가지 미세 압축 메커니즘은 각각 서로 다른 압축 가능한 도구 세트를 정의합니다. 이러한 차이점을 이해하는 것은 어떤 도구 결과가 지워질지 예측하는 데 중요합니다.

### <a
href="#1141-compactable_tools-shared-by-time-based--cached-micro-compaction"
class="header">11.4.1 <code>COMPACTABLE_TOOLS</code>(시간 기반 + 캐시된 마이크로 압축으로 공유)</a>

``` typescript
// microCompact.ts:41-50
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,      // Read
  ...SHELL_TOOL_NAMES,       // Bash (multiple shell variants)
  GREP_TOOL_NAME,            // Grep
  GLOB_TOOL_NAME,            // Glob
  WEB_SEARCH_TOOL_NAME,      // WebSearch
  WEB_FETCH_TOOL_NAME,       // WebFetch
  FILE_EDIT_TOOL_NAME,       // Edit
  FILE_WRITE_TOOL_NAME,      // Write
])
```

### <a href="#1142-tools_clearable_results-api-clear_tool_inputs"
class="header">11.4.2 <code>TOOLS_CLEARABLE_RESULTS</code>(APIclear_tool_inputs)</a>

``` typescript
// apiMicrocompact.ts:19-26
const TOOLS_CLEARABLE_RESULTS = [
  ...SHELL_TOOL_NAMES,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
]
```

### <a href="#1143-tools_clearable_uses-api-exclude_tools"
class="header">11.4.3 <code>TOOLS_CLEARABLE_USES</code>(API 제외_도구)</a>

``` typescript
// apiMicrocompact.ts:28-32
const TOOLS_CLEARABLE_USES = [
  FILE_EDIT_TOOL_NAME,       // Edit
  FILE_WRITE_TOOL_NAME,      // Write
  NOTEBOOK_EDIT_TOOL_NAME,   // NotebookEdit
]
```

주요 차이점:

<div class="table-wrapper">

| 도구 | COMPACTABLE_TOOLS | CLEARABLE_RESULTS | CLEARABLE_USES |
|-------------------|:-----------------:|:-----------------:|:--------------:|
| 셸(배시) | 예 | 예 | -- |
| 그렙 | 예 | 예 | -- |
| 글로브 | 예 | 예 | -- |
| 파일읽기(읽기) | 예 | 예 | -- |
| 웹검색 | 예 | 예 | -- |
| 웹 가져오기 | 예 | 예 | -- |
| 파일편집(편집) | 예 | -- | 예 |
| 파일쓰기(쓰기) | 예 | -- | 예 |
| 노트북편집 | -- | -- | 예 |

</div>

NotebookEdit은 API의 `TOOLS_CLEARABLE_USES`에만 나타납니다. 클라이언트측 마이크로 압축에서는 이를 처리하지 않습니다. FileEdit 및 FileWrite는 클라이언트 측에서 **결과**(tool_result)를 지우지만 API 모드에서는 `clear_tool_inputs`에서 제외되고 대신 `exclude_tools`에서 처리됩니다. 이러한 계층형 설계를 통해 클라이언트와 서버는 각각 자신에게 가장 적합한 부품을 처리할 수 있습니다.

------------------------------------------------------------------------

## <a href="#115-coordinating-with-cache-break-detection"
class="header">11.5 캐시 중단 감지 조정</a>

### <a href="#1151-the-problem-micro-compaction-triggers-false-positives"
class="header">11.5.1 문제: 미세 압축으로 인해 거짓 긍정이 발생함</a>

`promptCacheBreakDetection.ts` 모듈은 API 응답에서 `cache_read_tokens`를 지속적으로 모니터링합니다. 이 값이 마지막 요청에 비해 5% 이상 떨어지고 절대 감소량이 2,000개 토큰을 초과하면 "캐시 중단"을 보고합니다. 이는 일반적으로 일부 변경(시스템 프롬프트 수정, 도구 목록 변경)으로 인해 캐시 접두사가 무효화되었음을 의미합니다.

그러나 마이크로 압축은 **의도적으로** 캐시된 콘텐츠를 줄입니다. 조정이 없으면 모든 미세 압축이 거짓 긍정을 유발합니다. Claude Code는 두 가지 알림 기능을 통해 이 문제를 해결합니다.

### <a href="#1152-notifycachedeletion" class="header">11.5.2 <code>notifyCache삭제()</code></a>

``` typescript
// promptCacheBreakDetection.ts:673-682
export function notifyCacheDeletion(
  querySource: QuerySource,
  agentId?: AgentId,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    state.cacheDeletionsPending = true
  }
}
```

**호출 시**: 캐시된 마이크로 압축이 캐시 편집을 보낸 후(`microCompact.ts:366`), 시간 기반 트리거가 메시지 콘텐츠를 수정한 후(`microCompact.ts:526`).

**효과**: `cacheDeletionsPending = true`를 설정합니다. 다음 API 응답이 도착하면 `checkResponseForCacheBreak()`(라인 472-481)는 이 플래그를 확인하고 중단 감지를 완전히 건너뜁니다.

``` typescript
// promptCacheBreakDetection.ts:472-481
if (state.cacheDeletionsPending) {
  state.cacheDeletionsPending = false
  logForDebugging(
    `[PROMPT CACHE] cache deletion applied, cache read: ${prevCacheRead}
     -> ${cacheReadTokens} (expected drop)`,
  )
  state.pendingChanges = null
  return
}
```

### <a href="#1153-notifycompaction" class="header">11.5.3 <code>notifyCompaction()</code></a>

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

**호출 시**: 전체 압축(`compact.ts:699`) 및 자동 압축(`autoCompact.ts:303`)이 완료된 후입니다.

**효과**: `prevCacheReadTokens`를 null로 재설정합니다. 즉, 다음 API 응답에서 비교할 "이전 값"이 없습니다. 감지기는 이를 "첫 번째 호출"로 처리하고 중단을 보고하지 않습니다.

**두 기능의 차이점**:

<div class="table-wrapper">

| 기능 | 재설정 접근 방식 | 적용 가능한 시나리오 |
|----|----|----|
| `notifyCacheDeletion` | `cacheDeletionsPending = true`를 표시하고 다음 감지를 건너뛰지만 기준선은 유지합니다. | 미세 압축(부분 삭제, 기준선은 여전히 ​​참조 값을 가짐) |
| `notifyCompaction` | `prevCacheReadTokens`를 null로 설정하고 기준선을 완전히 재설정합니다. | 전체 압축(메시지 구조가 완전히 변경되었으며 이전 기준선은 의미가 없음) |

</div>

------------------------------------------------------------------------

## <a href="#116-sub-agent-isolation" class="header">11.6 하위 에이전트 격리</a>

미세 압축 시스템이 처리해야 하는 중요한 시나리오는 **하위 에이전트**입니다. Claude Code의 기본 스레드는 각각 독립적인 대화 기록을 가진 여러 하위 에이전트(session_memory, Prompt_suggestion 등)를 분기할 수 있습니다.

`cachedMicrocompactPath`는 메인 스레드(`microCompact.ts:275-285`)에서만 실행됩니다.

``` typescript
// microCompact.ts:275-285
if (feature('CACHED_MICROCOMPACT')) {
  const mod = await getCachedMCModule()
  const model = toolUseContext?.options.mainLoopModel ?? getMainLoopModel()
  if (
    mod.isCachedMicrocompactEnabled() &&
    mod.isModelSupportedForCacheEditing(model) &&
    isMainThreadSource(querySource)
  ) {
    return await cachedMicrocompactPath(messages, querySource)
  }
}
```

소스 주석(라인 272-276)은 이유를 설명합니다. "포크된 에이전트가 전역 캐시된MCState에 tool_results를 등록하는 것을 방지하려면 메인 스레드에 대해 캐시된 MC만 실행하세요. 그러면 메인 스레드가 자체 대화에 존재하지 않는 도구를 삭제하려고 시도하게 됩니다."

`cachedMCState`는 모듈 수준 전역 변수입니다. 하위 에이전트가 자신의 도구 ID를 등록한 경우 기본 스레드는 다음 실행 시 해당 ID를 삭제하려고 시도하지만 기본 스레드의 메시지에는 해당 ID가 존재하지 않으므로 잘못된 캐시_edits 지시어가 발생합니다. `isMainThreadSource(querySource)` 가드는 캐시된 마이크로 압축에서 하위 에이전트를 완전히 제외합니다.

`isMainThreadSource()`(249-251행) 구현에서는 정확한 일치 대신 접두어 일치를 사용합니다.

``` typescript
// microCompact.ts:249-251
function isMainThreadSource(querySource: QuerySource | undefined): boolean {
  return !querySource || querySource.startsWith('repl_main_thread')
}
```

이는 `promptCategory.ts`가 querySource를 `'repl_main_thread:outputStyle:<style>'`로 설정하기 때문입니다. 엄격한 `=== 'repl_main_thread'` 검사가 사용된 경우 기본이 아닌 출력 스타일을 가진 사용자는 캐시된 마이크로 압축에서 자동으로 제외됩니다. 소스 주석(246-248행)은 이전의 정확한 일치를 "잠재된 버그"로 표시합니다.

------------------------------------------------------------------------

## <a href="#117-what-users-can-do" class="header">11.7 사용자가 할 수 있는 일</a>

세 가지 미세 압축 메커니즘을 이해하면 다음 전략을 채택하여 일상 경험을 최적화할 수 있습니다.

### <a href="#1171-understanding-why-tool-results-disappear"
class="header">11.7.1 "도구 결과가 사라지는" 이유 이해</a>

나중에 대화에서 모델이 이전 `grep` 또는 `cat` 결과를 "잊는" 것을 발견하면 이는 모델 환각이 아니라 마이크로 압축이 이전 도구 결과를 적극적으로 지우는 것일 가능성이 높습니다. 지워진 도구 결과는 `[Old tool result content cleared]` 자리 표시자 텍스트로 대체됩니다. 검색 결과를 다시 참조하기 위해 모델이 필요한 경우 검색을 다시 실행하도록 요청하기만 하면 됩니다. 이는 모델이 삭제된 콘텐츠를 "기억"하도록 만드는 것보다 더 안정적입니다.

### <a href="#1172-expectation-management-after-long-breaks"
class="header">11.7.2 장기간 휴식 후 기대 관리</a>

1시간 이상 방치했다가 돌아와서 대화를 계속하는 경우 시간 기반 마이크로 압축으로 인해 대부분의 이전 도구 결과가 지워질 수 있습니다(가장 최근의 5개만 유지). 이는 의도적으로 설계된 것입니다. 서버 캐시가 만료되었으므로 오래된 콘텐츠를 지우면 다음 API 호출의 캐시 생성 비용을 크게 줄일 수 있습니다. 모델이 키 파일을 다시 읽도록 하는 것은 정상적이고 효율적인 동작입니다.

### <a href="#1173-using-claudemd-to-preserve-key-context"
class="header">11.7.3 CLAUDE.md를 사용하여 주요 컨텍스트 보존</a>

미세 압축은 도구 호출 결과만 지우며 시스템 프롬프트를 통해 삽입된 `CLAUDE.md` 콘텐츠에는 영향을 주지 않습니다. 특정 정보(예: 프로젝트 규칙, 아키텍처 결정, 주요 파일 경로)가 전체 세션에서 유효한 상태를 유지해야 하는 경우 `CLAUDE.md`에 해당 정보를 기록하는 것이 가장 안정적인 접근 방식입니다. 이러한 정보는 압축 또는 미세 압축 메커니즘의 영향을 받지 않습니다.

### <a href="#1174-cost-awareness-for-parallel-tool-calls"
class="header">11.7.4 병렬 도구 호출에 대한 비용 인식</a>

모델이 여러 검색 또는 읽기 작업을 동시에 시작하는 경우 이러한 결과의 총 크기는 메시지당 200,000자 예산으로 제한됩니다. 일부 병렬 도구의 결과가 디스크에 유지되는 것을 관찰하면(모델에 "출력이 너무 커서 파일에 저장됨"이 표시됨) 이는 컨텍스트 팽창을 방지하는 예산 메커니즘입니다. 보다 정확한 검색 기준을 통해 개별 도구 출력 크기를 줄일 수 있습니다.

### <a href="#1175-awareness-of-non-compactable-tools" class="header">11.7.5 비압축 도구에 대한 인식</a>

미세 다짐으로 인해 모든 도구 결과가 지워지는 것은 아닙니다. `FileEdit`, `FileWrite` 및 기타 쓰기 유형 도구의 **결과**는 클라이언트측 마이크로 압축에서 지울 수 있지만 `ToolSearch`, `SendMessage` 등과 같은 도구는 압축 가능 세트에 포함되어 있지 않습니다. 어떤 도구 결과가 지워질지 알면(섹션 11.4의 비교 표 참조) 긴 세션 동안 모델의 동작 변화를 이해하는 데 도움이 됩니다.

------------------------------------------------------------------------

## <a href="#118-design-pattern-summary" class="header">11.8 디자인 패턴 요약</a>

미세 다짐 시스템은 연구할 가치가 있는 여러 엔지니어링 패턴을 보여줍니다.

**계층적 성능 저하**: 세 가지 메커니즘이 계층 구조를 형성합니다. API 컨텍스트 관리는 항상 존재하는 선언적 기준선 역할을 합니다. 캐시된 마이크로 압축은 캐시_편집을 지원하는 환경에서 정확한 수술을 제공합니다. 시간 기반 트리거는 캐시 만료 후 대체 역할을 합니다. 각 계층에는 명확한 전제 조건과 저하 경로가 있습니다.

**부작용 조정**: 마이크로 압축은 격리된 작업이 아닙니다. 캐시 중단 감지기에 알리고(가양성 방지), 관련 상태를 재설정하고(더티 데이터 방지), 사용자 경고를 억제해야 합니다(혼란 방지). 이 세 가지 부작용은 이벤트 시스템이 아닌 명시적 함수 호출(`notifyCacheDeletion`, `resetMicrocompactState`, `suppressCompactWarning`)을 통해 조정되어 인과 ​​사슬의 추적성을 유지합니다.

**단일 소비 의미**: `consumePendingCacheEdits()`는 데이터를 반환한 후 즉시 삭제하여 API 재시도 시나리오 중에 중복 소비를 방지합니다. 이 패턴은 일회성 상태를 모듈 전체에 전달해야 할 때 매우 실용적입니다.

**불변 메시지 수정**: 시간 기반 트리거 경로는 `map` + 확산 연산자를 사용하여 제자리에서 수정하는 대신 새 메시지 배열을 생성합니다. 이렇게 하면 마이크로 압축 논리에 버그가 있어도 원본 메시지가 오염되지 않습니다. 캐시된 마이크로 압축은 더 나아가 로컬 메시지 수정을 **완전히 방지**하며 모든 수정은 서버 측에서 이루어집니다.

**순환 종속성 방지**: `notifyCacheDeletion`는 `notifyCompaction` 대신 재사용됩니다. `notifyCompaction`를 가져오면 순환 종속성 감지기가 트리거되기 때문입니다. 이러한 종류의 실용적인 타협은 대규모 코드베이스에서 흔히 발생합니다. 완벽한 모듈 경계는 시스템 제약을 구축하는 데 도움이 됩니다. 소스 댓글은 이러한 절충안을 숨기려고 하기보다는 솔직하게 문서화했습니다.

------------------------------------------------------------------------

## <a href="#version-evolution-v2191-changes" class="header">버전 진화: v2.1.91 변경 사항</a>

> 다음 분석은 v2.1.88 소스 코드 추론과 결합된 v2.1.91 번들 신호 비교를 기반으로 합니다.

### <a href="#cold-compact" class="header">콜드 컴팩트</a>

v2.1.91에서는 `tengu_cold_compact` 이벤트를 도입하여 기존 "핫 컴팩트"(긴급, 컨텍스트가 채워지려고 할 때 자동으로 트리거됨)와 함께 새로운 "콜드 컴팩트" 전략을 제안합니다.

<div class="table-wrapper">

| 비교 | 핫 컴팩트(v2.1.88) | Cold Compact(v2.1.91 추론) |
|----|----|----|
| 트리거 타이밍 | 컨텍스트가 차단 임계값에 도달함 | 컨텍스트가 가득 찼지만 아직 차단되지는 않았습니다. |
| 긴급 | 높음 — 압축하지 않고는 계속할 수 없습니다. | 낮음 — 다음 턴으로 연기될 수 있음 |
| 사용자 인식 | 자동으로 실행 | 대화상자 확인이 있을 수 있음 |

</div>

### <a href="#compaction-dialog" class="header">압축 대화상자</a>

새로운 `tengu_autocompact_dialog_opened` 이벤트는 v2.1.91에 압축 확인 UI가 도입되었음을 나타냅니다. 사용자는 압축이 발생하기 전에 알림을 보고 진행할지 여부를 선택할 수 있습니다. 이는 v2.1.88의 완전 자동 압축과 달리 압축 작업 투명성을 향상시킵니다.

### <a href="#rapid-refill-circuit-breaker" class="header">급속 리필 회로 차단기</a>

`tengu_auto_compact_rapid_refill_breaker`는 극단적인 경우를 해결합니다. 압축 후 많은 수의 도구 결과가 컨텍스트를 빠르게 다시 채우면(예: 여러 개의 대용량 파일 읽기) 시스템이 "압축 -\> 다시 채우기 -\> 다시 압축" 루프에 들어갈 수 있습니다. 이 회로 차단기는 빠른 재충전 패턴을 감지하면 루프를 중단하여 무의미한 API 오버헤드를 방지합니다.

### <a href="#manual-compaction-tracking" class="header">수동 다짐 추적</a>

`tengu_autocompact_command`는 사용자 시작 `/compact` 명령과 시스템 트리거 자동 압축을 구별하여 원격 측정 데이터가 사용자 의도와 시스템 동작을 정확하게 반영할 수 있도록 합니다.
