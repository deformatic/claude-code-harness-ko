# <a href="#chapter-12-token-budgeting-strategies" class="header">12장: 토큰 예산 전략</a>

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

9~11장에서는 컨텍스트 창이 "채워진" 후 Claude Code가 어떻게 압축하고 정리하는지 분석했습니다. 그러나 훨씬 더 근본적인 질문이 있습니다. **콘텐츠가 컨텍스트 창에 들어가기 전에 콘텐츠의 크기를 어떻게 제어합니까?**

단일 `grep`는 80KB의 검색 결과를 반환하고, 단일 `cat`는 200KB의 로그 파일을 읽고, 5개의 병렬 도구 호출이 각각 50KB를 반환합니다. 이는 실제 시나리오입니다. 제어가 없으면 단일 도구 결과가 컨텍스트 창의 1/4을 소비할 수 있으며 일련의 병렬 도구 호출로 컨텍스트를 바로 압축 임계값으로 푸시할 수 있습니다.

토큰 예산 책정 전략은 상황 관리를 위한 Claude Code의 "진입 관문"입니다. 그들은 세 가지 수준에서 작동합니다:

1. **도구별 결과 수준**: 임계값을 초과하는 결과는 디스크에 유지되며 모델에는 미리보기만 표시됩니다.
2. **메시지별 수준**: 한 라운드의 병렬 도구 호출의 총 결과는 200,000자를 초과할 수 없습니다.
3. **토큰 계산 수준**: 컨텍스트 창 사용량은 표준 API 또는 대략적인 추정을 통해 추적됩니다.

이 장에서는 이러한 세 가지 구현 수준에 대해 자세히 알아보고 관련된 엔지니어링 절충안, 특히 병렬 도구 호출 시나리오의 토큰 계산 함정을 밝힙니다.

------------------------------------------------------------------------

## <a href="#121-tool-result-persistence-the-50k-character-entry-gate"
class="header">12.1 도구 결과 지속성: 50K 문자 입력 게이트</a>

### <a href="#core-constants" class="header">핵심 상수</a>

도구 결과 크기 제어는 `constants/toolLimits.ts`에 정의된 두 가지 핵심 상수를 중심으로 이루어집니다.

``` typescript
// constants/toolLimits.ts:13
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000

// constants/toolLimits.ts:49
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000
```

첫 번째 상수는 **단일 도구 결과**에 대한 전역 최대값입니다. 도구의 출력이 50,000자를 초과하면 전체 내용이 디스크 파일에 기록되고 모델은 파일 경로와 2,000바이트 미리 보기가 포함된 대체 메시지만 수신합니다. 두 번째 상수는 병렬 도구 호출의 누적 효과를 방지하도록 설계된 **단일 메시지** 내의 모든 도구 결과에 대한 집계 한도입니다.

이 두 상수 사이의 관계는 주목할 가치가 있습니다. 즉, 200K / 50K = 4입니다. 즉, 4개의 도구가 각각 도구별 상한선에 도달하더라도 단일 메시지 내에서는 여전히 안전합니다. 그러나 5개 이상의 병렬 도구가 동시에 한도에 가까운 결과를 반환하면 메시지 수준 예산 집행이 시작됩니다.

### <a href="#persistence-threshold-calculation" class="header">지속성 임계값 계산</a>

도구별 지속성 임계값은 단순히 50K가 아니라 다층적으로 결정됩니다.

``` typescript
// utils/toolResultStorage.ts:55-78
export function getPersistenceThreshold(
  toolName: string,
  declaredMaxResultSizeChars: number,
): number {
  // Infinity = hard opt-out
  if (!Number.isFinite(declaredMaxResultSizeChars)) {
    return declaredMaxResultSizeChars
  }
  const overrides = getFeatureValue_CACHED_MAY_BE_STALE<Record<
    string, number
  > | null>(PERSIST_THRESHOLD_OVERRIDE_FLAG, {})
  const override = overrides?.[toolName]
  if (
    typeof override === 'number' &&
    Number.isFinite(override) &&
    override > 0
  ) {
    return override
  }
  return Math.min(declaredMaxResultSizeChars, DEFAULT_MAX_RESULT_SIZE_CHARS)
}
```

이 함수의 결정 논리는 우선순위 체인을 형성합니다.

<div class="table-wrapper">

| 우선 사항 | 상태 | 결과 |
|----|----|----|
| 1(가장 높음) | 도구는 `maxResultSizeChars: Infinity`를 선언합니다. | 지속하지 않음(읽기 도구는 이 메커니즘을 사용함) |
| 2 | GrowthBook 플래그 `tengu_satin_quoll`에는 이 도구에 대한 재정의가 있습니다. | 원격 재정의 값 사용 |
| 3 | 도구는 사용자 정의 `maxResultSizeChars`를 선언합니다. | `Math.min(declared value, 50_000)` |
| 4(기본값) | 특별한 선언 없음 | 50,000자 |

</div>

**표 12-1: 도구별 지속성 임계값 우선 순위 체인**

첫 번째 우선순위는 특히 흥미롭습니다. 읽기 도구는 `maxResultSizeChars`를 `Infinity`로 설정합니다. 즉, **절대** 지속되지 않습니다. 소스 주석(59-61행)은 이유를 설명합니다. 읽기 도구의 출력이 파일에 지속되는 경우 모델은 해당 파일을 읽기 위해 Read를 다시 호출하여 루프를 생성해야 합니다. 읽기 도구는 자체 `maxTokens` 매개변수를 통해 출력 크기를 제어하며 일반 지속성 메커니즘에 의존하지 않습니다.

### <a href="#persistence-flow" class="header">지속성 흐름</a>

도구 결과가 임계값을 초과하면 `maybePersistLargeToolResult` 기능이 다음 흐름을 실행합니다.

``` mermaid
flowchart TD
    A["Tool execution completes, produces result"] --> B{"Is result content empty?"}
    B -->|Yes| C["Inject placeholder text<br/>(toolName completed with no output)"]
    B -->|No| D{"Contains image blocks?"}
    D -->|Yes| E["Return as-is<br/>(images must be sent to the model)"]
    D -->|No| F{"size <= threshold?"}
    F -->|Yes| G["Return as-is"]
    F -->|No| H["persistToolResult()<br/>Write to disk file, generate 2KB preview"]
    H --> I["buildLargeToolResultMessage()<br/>Build substitute message:<br/>persisted-output file path + preview"]
```

**그림 12-1: 도구 결과 지속성 결정 흐름**

주목할 만한 두 가지 구현 세부 사항:

**빈 결과 처리**(280-295행): 빈 `tool_result` 콘텐츠로 인해 특정 모델(댓글에 "capybara"가 언급됨)이 대화 차례 경계를 잘못 식별하여 출력이 잘못 종료됩니다. 이는 서버 측 렌더러가 `tool_result` 뒤에 `\n\nAssistant:` 마커를 삽입하지 않고 빈 콘텐츠가 `\n\nHuman:` 중지 시퀀스 패턴과 일치하기 때문입니다. 해결책은 간단한 자리 표시자 문자열 `(toolName completed with no output)`를 삽입하는 것입니다.

**파일 쓰기 멱등성**(161-172행): `persistToolResult`는 `flag: 'wx'`를 사용하여 파일을 씁니다. 즉, 파일이 이미 존재하는 경우 `EEXIST` 오류가 발생합니다. 함수는 이 오류를 포착하고 무시합니다. 이 디자인은 microcompact가 원본 메시지를 재생할 때 중복 지속성 문제를 처리합니다. `tool_use_id`는 호출마다 고유하고 동일한 ID에 대한 콘텐츠가 결정적이므로 기존 파일을 건너뛰는 것이 안전합니다.

### <a href="#post-persistence-message-format"
class="header">사후 지속성 메시지 형식</a>

지속성 후에 모델이 실제로 보는 메시지는 다음과 같습니다.

``` xml
<persisted-output>
Output too large (82.3 KB). Full output saved to:
  /path/to/session/tool-results/toolu_01XYZ.txt

Preview (first 2.0 KB):
[First 2000 bytes of content, truncated at newline boundary]
...
</persisted-output>
```

미리보기 생성 논리(339-356행)는 중간에서 줄이 잘리는 것을 방지하기 위해 개행 경계에서 잘리려고 합니다. 마지막 개행 위치가 제한의 50% 이전인 경우(라인이 하나만 있거나 라인이 매우 길다는 의미) 정확한 바이트 제한으로 돌아갑니다.

------------------------------------------------------------------------

## <a href="#122-per-message-budget-the-200k-aggregate-ceiling"
class="header">12.2 메시지당 예산: 총 200K 한도</a>

### <a href="#why-message-level-budget-is-needed" class="header">메시지 수준 예산이 필요한 이유</a>

도구당 50K 한도는 병렬 도구 호출 시나리오에 충분하지 않습니다. 다음 상황을 고려하십시오. 모델은 서로 다른 키워드를 검색하는 10개의 `Grep` 호출을 동시에 시작합니다. 각각은 40,000자를 반환합니다. 개별적으로는 모두 50,000개 임계값 미만이지만 단일 사용자 메시지로 API에 전송되는 총 400,000자의 문자입니다. 이렇게 하면 컨텍스트 창의 큰 부분이 즉시 소비되고 잠재적으로 불필요한 압축이 발생할 수 있습니다.

`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000`(49행)는 이 시나리오를 위해 설계된 총 예산입니다. 주석(40-48행)은 핵심 설계 원칙을 명확하게 명시합니다. **메시지는 독립적으로 평가됩니다** — 한 라운드에서 150,000개의 결과와 다른 라운드에서 150,000개의 결과가 각각 예산 범위 내에 있으며 서로 영향을 미치지 않습니다.

### <a href="#message-grouping-complexity" class="header">메시지 그룹화 복잡성</a>

병렬 도구 호출은 Claude Code의 내부 메시지 형식으로 간단하게 표현되지 않습니다. 모델이 여러 병렬 도구 호출을 시작하면 스트리밍 핸들러는 각 `content_block_stop` 이벤트에 대해 **별도** AssistantMessage 레코드를 생성한 다음 각 `tool_result`가 독립적인 사용자 메시지로 이어집니다. 따라서 내부 메시지 배열은 다음과 같습니다.

[..., 어시스턴트(id=A), 사용자(result_1), 어시스턴트(id=A), 사용자(result_2), ...]

여러 보조 레코드가 **동일한 `message.id`를 공유**합니다. 그러나 `normalizeMessagesForAPI`는 API로 보내기 전에 연속된 사용자 메시지를 하나로 병합합니다. 메시지 수준 예산은 분산된 내부 표현이 아니라 API가 보는 그룹화에 따라 작동해야 합니다.

`collectCandidatesByMessage` 함수(600-638행)는 이 그룹화 논리를 구현합니다. "보조 메시지 경계"를 기준으로 메시지를 그룹화합니다. **이전에 표시되지 않은** 보조 `message.id`만 새 그룹 경계를 만듭니다.

``` typescript
// utils/toolResultStorage.ts:624-635
const seenAsstIds = new Set<string>()
for (const message of messages) {
  if (message.type === 'user') {
    current.push(...collectCandidatesFromMessage(message))
  } else if (message.type === 'assistant') {
    if (!seenAsstIds.has(message.message.id)) {
      flush()
      seenAsstIds.add(message.message.id)
    }
  }
}
```

여기에는 미묘한 경우가 있습니다. 병렬 도구 실행이 중단되면 `agent_progress` 메시지가 tool_result 메시지 사이에 삽입될 수 있습니다. 진행 메시지에서 그룹 경계가 생성된 경우 해당 tool_results는 총예산 확인을 우회하여 여러 하위 예산 그룹으로 분할되지만 `normalizeMessagesForAPI`는 이를 단일 예산 초과 메시지로 병합합니다. 코드는 보조자 메시지에서만 그룹을 생성하여(진행 상황, 첨부 파일 및 기타 유형을 무시) 이를 방지합니다.

### <a href="#budget-enforcement-and-state-freezing" class="header">예산 집행 및 국가 동결</a>

메시지 수준 예산 집행의 핵심 메커니즘은 `enforceToolResultBudget` 기능(769-908행)입니다. 디자인은 **신속한 캐시 안정성**이라는 주요 제약 조건을 중심으로 이루어집니다. 모델이 도구 결과(전체 콘텐츠 또는 대체 미리보기)를 확인한 후에는 이 결정이 모든 후속 API 호출에서 일관성을 유지해야 합니다. 그렇지 않으면 접두사 변경으로 인해 프롬프트 캐시가 무효화됩니다.

이는 "3상태 분할" 메커니즘으로 이어집니다.

``` mermaid
flowchart LR
    subgraph CRS["ContentReplacementState"]
        direction TB
        S["seenIds: Set &lt; string &gt;<br/>replacements: Map &lt; string, string &gt;"]
        subgraph States["Three States"]
            direction LR
            MA["mustReapply<br/>In seenIds with replacement<br/>-> Re-apply cached replacement"]
            FR["frozen<br/>In seenIds without replacement<br/>-> Immutable, keep as-is"]
            FH["fresh<br/>Not in seenIds<br/>-> Can be selected for replacement"]
        end
        S --> States
    end
```

**그림 12-2: 도구 결과 3상태 파티션 및 상태 전환**

각 API 호출 전의 실행 흐름은 다음과 같습니다.

1. **각 메시지 그룹**에 대해 후보 tool_results를 위의 세 가지 상태로 분할합니다.
2. **mustReapply**: 이전에 캐시된 대체 문자열을 맵에서 검색하고 동일하게 다시 적용합니다. - I/O 없음, 바이트 수준 일관성
3. **고정**: 이전에 표시되었지만 대체되지 않은 결과 — 더 이상 대체할 수 없습니다(그렇게 하면 프롬프트 캐시 접두사가 손상됩니다).
4. **신선**: 이번 차례의 새로운 결과 — 총 예산을 확인하세요. 예산 초과 시 내림차순으로 지속성을 위해 가장 큰 결과를 선택합니다.

교체할 새로운 결과를 선택하는 논리는 `selectFreshToReplace`(675-692행)에 있습니다. 내림차순으로 정렬하고 나머지 합계(동결 + 선택되지 않은 새로)가 예산 한도 아래로 떨어질 때까지 하나씩 선택합니다. 고정된 결과만으로도 예산을 초과하는 경우 초과분을 수용하십시오. 마이크로컴팩트는 결국 해당 결과를 정리합니다.

### <a href="#state-marking-timing" class="header">상태 표시 시기</a>

코드에는 신중하게 설계된 타이밍 제약이 있습니다(833-842행). 지속성을 위해 선택되지 않은 후보는 **즉시 동기적으로** 표시된 것으로 표시되고(`seenIds`에 추가됨) 지속성을 위해 선택된 후보는 `await persistToolResult()`가 완료된 후에만 표시되므로 `seenIds.has(id)`와 `replacements.has(id)` 간의 일관성이 보장됩니다. 주석 설명: ID가 `seenIds`에 나타나지만 `replacements`에는 나타나지 않으면 고정(교체 불가능)으로 분류되어 전체 콘텐츠가 전송됩니다. 그 동안 메인 스레드가 미리보기를 보낼 수 있습니다. 불일치로 인해 즉시 캐시가 무효화될 수 있습니다.

------------------------------------------------------------------------

## <a href="#123-token-counting-canonical-vs-rough-estimation"
class="header">12.3 토큰 계산: 정규 추정과 대략적인 추정</a>

### <a href="#two-counting-mechanisms" class="header">두 가지 계산 메커니즘</a>

Claude Code는 다양한 시나리오에 대해 두 가지 토큰 계산 메커니즘을 유지합니다.

<div class="table-wrapper">

| 특징 | 정식 개수(API 사용량) | 대략적인 추정 |
|----|----|----|
| 데이터 소스 | API 응답의 `usage` 필드 | 문자 길이/토큰당 바이트 수 |
| 정확성 | 정확한 | 편차 최대 +/-50% |
| 유효성 | API 호출이 완료된 후 | 언제든지 |
| 사용 사례 | 임계값 결정, 예산 계산, 청구 | API 호출 간의 공백 메우기 |

</div>

**표 12-2: 두 가지 토큰 계산 메커니즘 비교**

### <a href="#canonical-count-from-api-usage-to-context-size"
class="header">표준 개수: API 사용량에서 컨텍스트 크기까지</a>

API 응답의 `usage` 객체에는 여러 필드가 포함되어 있습니다. `getTokenCountFromUsage` 기능(`utils/tokens.ts:46-53`)은 이를 전체 컨텍스트 창 크기로 결합합니다.

``` typescript
// utils/tokens.ts:46-53
export function getTokenCountFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  )
}
```

이 계산에는 `input_tokens`(이 요청에 대해 캐시되지 않은 입력), `cache_creation_input_tokens`(캐시에 새로 작성된 토큰), `cache_read_input_tokens`(캐시에서 읽은 토큰) 및 `output_tokens`(모델 생성 출력)의 네 가지 구성 요소가 포함됩니다. 캐시 관련 필드는 선택 사항(`?? 0`)입니다. 모든 API 공급자가 해당 필드를 반환하는 것은 아니기 때문입니다.

### <a href="#rough-estimation-the-4-bytestoken-rule" class="header">대략적인 추정: 4바이트/토큰 규칙</a>

API 사용을 사용할 수 없는 경우(예: 두 API 호출 사이에 새 메시지가 추가되는 경우) Claude Code는 문자 길이를 경험적 요인으로 나눈 값을 사용하여 토큰 수를 추정합니다. 핵심 추정 기능은 `services/tokenEstimation.ts:203-208`에 있습니다.

``` typescript
// services/tokenEstimation.ts:203-208
export function roughTokenCountEstimation(
  content: string,
  bytesPerToken: number = 4,
): number {
  return Math.round(content.length / bytesPerToken)
}
```

기본값인 4바이트/토큰은 보수적인 추정치입니다. Claude의 토크나이저의 실제 비율은 영어 텍스트의 경우 대략 3.5-4.5이며, 경험적 중앙값은 4입니다. 그러나 실제 비율은 콘텐츠 유형에 따라 크게 다릅니다.

<div class="table-wrapper">

| 콘텐츠 유형 | 바이트/토큰 인수 | 원천 |
|----|----|----|
| 일반 텍스트(영어, 코드) | 4 | 기본값(`tokenEstimation.ts:204`) |
| JSON/JSONL/JSONC | 2 | `bytesPerTokenForFileType` (`tokenEstimation.ts:216-224`) |
| 이미지(이미지 블록) | 2,000개의 토큰 고정 | `roughTokenCountEstimationForBlock`(라인 400-412) |
| PDF 문서(문서 블록) | 2,000개의 토큰 고정 | 위와 동일 |

</div>

**표 12-3: 파일 유형 인식 토큰 추정 규칙 요약**

주석(213-215행)에 명확하게 설명된 이유 때문에 JSON 파일은 4 대신 2를 사용합니다. **고밀도 JSON에는 많은 단일 문자 토큰이 포함되어 있습니다**(`{`, `}`, `:`, `,`, `"`). 이는 각 토큰이 평균 약 2바이트에 해당함을 의미합니다. 4를 계속 사용하는 경우 100KB JSON 파일은 25,000개 토큰으로 추정되지만 실제로는 50,000개에 가깝습니다. 이로 인해 너무 큰 도구 결과가 지속성을 벗어나 조용히 컨텍스트에 들어갈 수 있습니다.

`bytesPerTokenForFileType`(215-224행)는 파일 확장자에 따라 다양한 요소를 반환합니다.

``` typescript
// services/tokenEstimation.ts:215-224
export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension) {
    case 'json':
    case 'jsonl':
    case 'jsonc':
      return 2
    default:
      return 4
  }
}
```

### <a href="#fixed-estimation-for-images-and-documents"
class="header">이미지 및 문서에 대한 고정 추정</a>

이미지와 PDF 문서는 특별한 경우입니다. 이미지에 대한 API의 실제 토큰 청구는 `(width x height) / 750`이며, 이미지는 최대 2000x2000픽셀(약 5,333개 토큰)로 확장됩니다. 그러나 대략적으로 추정하면 Claude Code는 **고정된 2,000개의 토큰**을 균일하게 사용합니다(400-412행).

여기에는 중요한 엔지니어링 고려 사항이 있습니다. 이미지 또는 PDF의 `source.data`(base64 인코딩)가 일반 JSON 직렬화 경로에 공급되면 1MB PDF는 약 133만 개의 base64 문자를 생성하며, 이는 4바이트/토큰에서 약 325K 토큰으로 추정됩니다. 이는 API의 실제 청구인 ~2,000토큰을 훨씬 초과합니다. 따라서 코드는 일반 추정 전에 `block.type === 'image' || block.type === 'document'`를 명시적으로 확인하고 고정된 값을 조기에 반환하여 치명적인 과대평가를 방지합니다.

------------------------------------------------------------------------

## <a href="#124-the-token-counting-pitfall-of-parallel-tool-calls"
class="header">12.4 병렬 도구 호출의 토큰 계산 함정</a>

### <a href="#the-message-interleaving-problem" class="header">메시지 인터리빙 문제</a>

병렬 도구 호출은 미묘하지만 심각한 토큰 계산 문제를 야기합니다. `tokenCountWithEstimation` — Claude Code의 임계값 결정을 위한 **표준 기능**은 구현 시 이 문제에 대한 자세한 분석을 제공합니다(`utils/tokens.ts:226-261`).

근본 원인은 메시지 배열의 인터리브 구조에 있습니다. 모델이 두 개의 병렬 도구 호출을 시작하면 내부 메시지 배열은 다음 형식을 취합니다.

색인: ... i-3 i-2 i-1 i 메시지:... asst(A) user(tr_1) asst(A) user(tr_2) ^ 사용법 ^ 동일한 사용법

두 보조 레코드는 **동일한 `message.id`와 동일한 `usage`**를 공유합니다(동일한 API 응답의 서로 다른 콘텐츠 블록에서 왔기 때문입니다). 끝(인덱스 i-1)에서 `usage`가 있는 마지막 보조 메시지를 찾은 다음 그 뒤의 메시지를 추정하는 경우(인덱스 i에서 `user(tr_2)`만) 인덱스 i-2에서 `user(tr_1)`를 **놓치게** 됩니다.

그러나 다음 API 요청에서는 `user(tr_1)` 및 `user(tr_2)`가 모두 입력에 **표시됩니다**. 이는 `tokenCountWithEstimation`가 체계적으로 컨텍스트 크기를 과소평가한다는 의미입니다.

실제로 맥락에 맞는 콘텐츠 +-------------------------+ | asst(A) 사용자(tr_1) asst(A) 사용자(tr_2)| +-------------------------+ ^ ^ 놓쳤어요!              이것만 추정됨

수정 추정 범위 +-------------------------+ | asst(A) 사용자(tr_1) asst(A) 사용자(tr_2)| +------------+ ^ 동일한 ID를 가진 첫 번째 어시스턴트로 역추적 ^ 여기에서 나오는 모든 후속 메시지를 추정합니다.

**그림 12-3: 병렬 도구 호출에 대한 토큰 수 역추적 수정**

### <a href="#same-id-backtracking-correction" class="header">동일 ID 역추적 수정</a>

`tokenCountWithEstimation`의 솔루션은 사용량이 있는 마지막 보조 레코드를 찾은 후 동일한 `message.id`를 공유하는 첫 번째 보조 레코드로 **역추적**하는 것입니다.

``` typescript
// utils/tokens.ts:235-250
const responseId = getAssistantMessageId(message)
if (responseId) {
  let j = i - 1
  while (j >= 0) {
    const prior = messages[j]
    const priorId = prior ? getAssistantMessageId(prior) : undefined
    if (priorId === responseId) {
      i = j  // Anchor to the earlier same-ID record
    } else if (priorId !== undefined) {
      break  // Hit a different API response, stop backtracking
    }
    j--
  }
}
```

역추적 논리의 세 가지 경우에 유의하세요.

1. `priorId === responseId`: 동일한 API 응답의 이전 조각 — 여기로 앵커를 이동하세요.
2. `priorId !== undefined`(및 다른 ID): 다른 API 응답 발생 — 역추적 중지
3. `priorId === undefined`: 이것은 사용자/도구_결과/첨부 파일 메시지입니다. 조각 사이에 인터리브된 도구 결과일 수 있습니다. 계속 역추적하세요.

역추적이 완료된 후 앵커 뒤의 모든 메시지(인터리브된 모든 tool_results 포함)가 대략적인 추정에 포함됩니다.

``` typescript
// utils/tokens.ts:253-256
return (
  getTokenCountFromUsage(usage) +
  roughTokenCountEstimationForMessages(messages.slice(i + 1))
)
```

최종 컨텍스트 크기 = 마지막 API 응답의 정확한 사용량 + 이후에 추가된 모든 메시지의 대략적인 추정치입니다. 이 "정확한 기준선 + 증분 추정" 하이브리드 접근 방식은 정밀도와 성능의 균형을 유지합니다.

### <a href="#when-not-to-use-which-function" class="header">어떤 기능을 사용하지 말아야 할 때</a>

소스 주석(118-121행, 207-212행)은 함수 선택의 중요성을 반복적으로 강조합니다.

- **`tokenCountWithEstimation`**: 모든 임계값 비교(자동 압축 트리거링, 세션 메모리 초기화 등)에 사용되는 **표준 함수**
- **`tokenCountFromLastAPIResponse`**: 새로 추가된 메시지 추정치를 제외하고 마지막 API 호출의 정확한 토큰 합계만 반환합니다. 임계값 결정에는 적합하지 않습니다.
- **`messageTokenCountFromLastAPIResponse`**: `output_tokens`만 반환합니다. 모델이 단일 응답에서 생성한 토큰 수를 측정하는 데만 사용되며 컨텍스트 창 사용량은 반영하지 않습니다.

이러한 기능을 잘못 사용하면 실제 결과가 발생합니다. `messageTokenCountFromLastAPIResponse`를 사용하여 압축이 필요한지 여부를 결정하는 경우 반환 값은 수천(어시스턴트 한 명의 응답 출력)에 불과할 수 있지만 실제 컨텍스트는 이미 180K를 초과합니다. 압축이 트리거되지 않아 궁극적으로 창 제한을 초과하여 API 호출이 실패하게 됩니다.

------------------------------------------------------------------------

## <a href="#125-auxiliary-counting-api-token-counting-and-haiku-fallback"
class="header">12.5 보조 계산: API 토큰 계산 및 Haiku 대체</a>

### <a href="#counttokens-api" class="header">카운트토큰 API</a>

대략적인 추정 외에도 Claude Code는 API를 통해 정확한 토큰 수를 얻을 수도 있습니다. `countMessagesTokensWithAPI`(`services/tokenEstimation.ts:140-201`)는 `anthropic.beta.messages.countTokens` 엔드포인트를 호출하여 전체 메시지 목록과 도구 정의를 전달하여 정확한 `input_tokens` 값을 얻습니다.

이 API는 정확한 개수(예: 도구 정의 토큰 오버헤드 평가)가 필요한 시나리오에 사용되지만 대기 시간 오버헤드가 있습니다. 즉, 추가 HTTP 왕복이 필요합니다. 따라서 일일 임계값 결정에서는 특정 시나리오용으로 예약된 API 계산과 함께 `tokenCountWithEstimation`의 하이브리드 접근 방식을 사용합니다.

### <a href="#haiku-fallback" class="header">하이쿠 폴백</a>

`countTokens` API를 사용할 수 없는 경우(예: 특정 Bedrock 구성) `countTokensViaHaikuFallback`(251-325행)는 영리한 대안을 사용합니다. 즉, 반환된 `usage`를 사용하여 정확한 입력 토큰 수를 얻기 위해 `max_tokens: 1` 요청을 Haiku(소형 모델)에 보냅니다. 비용은 하나의 작은 모델 API 호출이지만 정밀도를 달성합니다.

이 함수는 대체 모델을 선택할 때 여러 플랫폼 제약 조건을 고려합니다.

- **Vertex 글로벌 지역**: Haiku를 사용할 수 없으며 Sonnet으로 대체됩니다.
- **기반 + 사고 블록**: Haiku 3.5는 사고를 지원하지 않으며 Sonnet으로 대체됩니다.
- **기타 경우**: 하이쿠 사용(최저 비용)

------------------------------------------------------------------------

## <a href="#126-end-to-end-token-budget-system" class="header">12.6 엔드투엔드 토큰 예산 시스템</a>

위의 모든 메커니즘을 결합하여 Claude Code의 토큰 예산은 다층 방어 시스템을 형성합니다.

``` mermaid
flowchart TB
    subgraph L1["Layer 1: Per-Tool Result Persistence"]
        L1D["Tool executes -> result > threshold? -> Persist to disk + 2KB preview<br/>Threshold = min(tool declared value, 50K) or GrowthBook override<br/>Special cases: Read (Infinity), images (skip)"]
    end
    subgraph L2["Layer 2: Per-Message Aggregate Budget"]
        L2D["Before API call -> tool_result total > 200K?<br/>-> Persist fresh results by descending size until total <= 200K<br/>-> State freeze: seen results' fate never changes (prompt cache stability)"]
    end
    subgraph L3["Layer 3: Context Window Tracking"]
        L3D["tokenCountWithEstimation() = exact usage + incremental rough estimation<br/>-> Drives auto-compaction, micro-compaction decisions<br/>-> Parallel tool calls: same-ID backtracking correction avoids systematic underestimation"]
    end
    subgraph L4["Layer 4: Auto-Compaction / Micro-Compaction (see Chapters 9-11)"]
        L4D["Context approaching window limit -> compress message history / clean old tool results"]
    end
    L1 -->|"If not intercepted"| L2
    L2 -->|"If not intercepted"| L3
    L3 -->|"Threshold exceeded triggers"| L4
```

**그림 12-4: 4계층 토큰 예산 방어 시스템**

각 계층에는 명확한 책임 경계와 오류 발생 시 성능 저하 경로가 있습니다.

- 레이어 1 실패(디스크 지속성 오류) -\> 전체 결과가 있는 그대로 반환되고 레이어 2와 4가 이를 포착합니다.
- 레이어 2의 고정된 결과는 대체될 수 없습니다. -\> 초과분을 수용하고 레이어 4의 마이크로 컴팩트는 결국 정리됩니다.
- 레이어 3의 대략적인 추정이 정확하지 않습니다. -\> 압축이 너무 이르거나 너무 늦게 트리거될 수 있지만 데이터 손실은 발생하지 않습니다.

### <a href="#growthbook-dynamic-parameter-tuning" class="header">GrowthBook 동적 매개변수 조정</a>

새 버전을 출시하지 않고도 GrowthBook 기능 플래그를 통해 런타임에 두 가지 핵심 임계값을 조정할 수 있습니다.

- **`tengu_satin_quoll`**: 도구별 지속성 임계값 재정의 맵
- **`tengu_hawthorn_window`**: 메시지별 총 예산 전역 재정의

`getPerMessageBudgetLimit`(라인 421-434)는 캐시 레이어에서 `null`, `NaN` 또는 문자열 유형 값이 누출될 수 있으므로 GrowthBook 반환 값에 대해 `typeof`, `isFinite` 및 `> 0` 삼중 검사를 수행하여 재정의 값에 대한 방어 코딩을 보여줍니다.

------------------------------------------------------------------------

## <a href="#127-what-users-can-do" class="header">12.7 사용자가 할 수 있는 일</a>

### <a href="#1271-control-tool-output-size" class="header">12.7.1 제어 도구 출력 크기</a>

`grep` 또는 `bash` 명령이 큰 출력(50,000자 이상)을 반환하면 결과는 디스크에 유지되며 모델은 처음 2KB 미리 보기만 볼 수 있습니다. 이러한 정보 손실을 방지하려면 보다 정확한 검색 기준을 사용하십시오. 예를 들어 전체 텍스트 검색 대신 `grep -l`(파일 이름만 나열)를 사용하거나 `head -n 100`를 사용하여 명령 출력을 제한하십시오. 이렇게 하면 모델에서 잘린 미리보기가 아닌 완전한 결과를 볼 수 있습니다.

### <a href="#1272-watch-for-parallel-tool-call-accumulation"
class="header">12.7.2 병렬 도구 호출 누적 감시</a>

모델이 여러 검색을 동시에 시작하는 경우 모든 결과의 총 크기는 200,000자로 제한됩니다. 모델에 "이 10개의 키워드를 한 번에 검색"하도록 요청하면 예산 초과로 인해 일부 결과가 지속될 수 있습니다. 대규모 검색을 여러 개의 작은 라운드로 분할하는 것을 고려하거나 모델이 점진적으로 검색하여 각 라운드의 결과를 예산 내에서 유지하도록 하세요.

### <a href="#1273-special-considerations-for-json-files"
class="header">12.7.3 JSON 파일에 대한 특별 고려 사항</a>

JSON 파일은 일반 코드보다 토큰 밀도가 2배 더 높습니다(토큰당 약 2바이트 대 4바이트). 이는 100KB JSON 파일이 실제로 약 50,000개의 토큰을 소비하는 반면, 동일한 크기의 TypeScript 파일은 약 25,000개의 토큰만 소비한다는 것을 의미합니다. 모델이 대규모 JSON 구성 또는 데이터 파일을 읽도록 할 때 컨텍스트 창에 더 많은 압력을 가한다는 점에 유의하세요.

### <a href="#1274-leverage-the-read-tools-special-status"
class="header">12.7.4 읽기 도구의 특수 상태 활용</a>

읽기 도구의 출력은 디스크에 유지되지 않습니다. 자체 `maxTokens` 매개변수를 통해 크기를 제어합니다. 즉, 읽기를 통해 읽은 파일 내용은 항상 모델에 직접 표시되며 2KB 미리 보기로 잘리지 않습니다. 파일의 전체 내용을 보기 위해 모델이 필요한 경우 읽기를 사용하는 것이 `cat` 명령보다 더 안정적입니다.

### <a href="#1275-be-aware-of-rough-estimation-deviation"
class="header">12.7.5 대략적인 추정 편차에 유의하세요.</a>

API 호출 사이에 Claude Code는 대략적인 추정(문자 수/4)을 사용하여 최대 +/-50%의 편차로 컨텍스트 크기를 추적합니다. 이는 자동 압축 트리거 타이밍이 예상보다 빠르거나 늦을 수 있음을 의미합니다. 예상치 못한 시간에 압축이 발생하는 것을 관찰하는 경우 이는 일반적으로 버그가 아닌 추정 편차로 인해 발생하는 정상적인 동작입니다.

------------------------------------------------------------------------

## <a href="#128-design-insights" class="header">12.8 디자인 통찰력</a>

### <a href="#conservative-vs-aggressive-estimation"
class="header">보수적 추정과 공격적 추정</a>

토큰 예산 시스템 전반에 걸쳐 반복되는 설계 상충 관계는 **토큰 수를 과소평가하는 것보다 과대평가하는 것이 더 좋습니다**입니다.

- JSON은 4 대신 2바이트/토큰을 사용합니다. 과소평가하면 너무 큰 결과가 지속성을 벗어나게 되기 때문입니다.
- 이미지는 base64 길이 추정 대신 고정된 2,000개의 토큰을 사용합니다. 왜냐하면 후자는 치명적인 과대평가를 유발할 수 있기 때문입니다(컨텍스트는 실제로 그렇지 않은데 "전체"로 표시됨).
- Tool_results 누락으로 인해 체계적인 과소평가가 발생하므로 병렬 도구 호출 역추적 수정이 존재합니다.

이러한 선택은 **토큰 예산은 최적화 메커니즘이 아닌 안전 메커니즘입니다**라는 원칙을 반영합니다. 과대평가로 인한 비용으로 인해 조기에 압축이 발생합니다(사소한 성능 손실). 과소평가로 인한 비용은 컨텍스트 창 오버플로(API 호출 실패)입니다.

### <a href="#prompt-caches-deep-impact-on-budget-design"
class="header">Prompt Cache가 예산 설계에 미치는 깊은 영향</a>

메시지 수준 예산의 복잡성(3상태 분할, 상태 동결, 바이트 수준 일관성 재적용)의 대부분은 단일 외부 제약에서 비롯됩니다. 즉, 프롬프트 캐시에는 접두사 안정성이 필요합니다. 프롬프트 캐시가 없으면 모든 API 호출에서 모든 도구 결과에 지속성이 필요한지 여부를 자유롭게 재평가할 수 있습니다. 그러나 프롬프트 캐시가 존재한다는 것은 모델이 도구 결과의 전체 콘텐츠를 "본" 후에 후속 호출이 전체 콘텐츠를 계속해서 보내야 함을 의미합니다. 그렇지 않으면 접두사 변경으로 인해 캐시가 무효화됩니다.

이 제약 조건은 상태 비저장 함수("크기 확인, 초과 시 교체")를 **상태 저장 상태 시스템**(`ContentReplacementState`)으로 변환하고 상태는 세션 재개 전체에서 유지되어야 합니다. 이것이 `ContentReplacementRecord`가 기록에 유지되는 이유입니다.

이는 교과서의 예입니다. **AI 에이전트 시스템에서 성능 최적화(프롬프트 캐시)는 기능 설계(예산 집행)를 소급하여 제한하여 예상치 못한 아키텍처 결합을 생성할 수 있습니다**.

------------------------------------------------------------------------

## <a href="#version-evolution-v2191-changes" class="header">버전 진화: v2.1.91 변경 사항</a>

> 다음 분석은 v2.1.91 번들 신호 비교를 기반으로 합니다.

v2.1.91에는 `tengu_memory_toggled` 및 `tengu_extract_memories_skipped_no_prose` 이벤트가 추가되었습니다. 전자는 메모리 기능 토글 상태를 추적합니다. 후자는 메시지에 산문 내용이 포함되지 않은 경우 메모리 추출을 건너뛰었음을 나타냅니다. 이는 순수 코드/도구 결과 메시지에서 무의미한 메모리 추출을 수행하지 않는 예산 인식 최적화입니다.
