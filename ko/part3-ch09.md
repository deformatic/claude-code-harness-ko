# <a
href="#chapter-9-auto-compaction--when-and-how-context-gets-compressed"
class="header">9장: 자동 압축 — 컨텍스트가 압축되는 시기와 방법</a>

> *"최고의 압축은 사용자가 전혀 알아차리지 못하는 압축입니다."*

Claude Code의 모든 장기 세션 사용자는 이 순간을 경험했습니다. 모델이 복잡한 모듈을 점진적으로 리팩토링하도록 하다가 갑자기 응답이 "잊혀지는" 것을 발견했습니다. 즉, 5분 전에 명시적으로 보존하도록 요청한 인터페이스 서명을 잊어버리거나 이미 거부한 접근 방식을 다시 제안합니다. 모델은 더 멍청해지지 않았습니다. **컨텍스트 창이 채워지고 자동 압축이 실행되었습니다**.

압축은 Claude Code의 컨텍스트 관리의 핵심 메커니즘입니다. 대화 기록이 요약으로 압축되는 지점과 방식을 결정합니다. 이 메커니즘을 이해하면 트리거되는 시기를 예측하고, 보존하는 항목을 제어하고, "잘못"될 경우 수행할 작업을 알 수 있습니다.

이 장에서는 소스 코드 수준에서 **임계값 결정**(트리거 시), **요약 생성**(압축 방법), **실패 복구**(실패 시 발생하는 상황)의 세 단계에 걸쳐 자동 압축을 완전히 분석합니다.

------------------------------------------------------------------------

## <a href="#91-threshold-calculation-when-auto-compaction-triggers"
class="header">9.1 임계값 계산: 자동 압축이 트리거되는 경우</a>

### <a href="#911-the-core-formula" class="header">9.1.1 핵심 공식</a>

자동 압축의 트리거 조건은 간단한 부등식으로 표현될 수 있습니다.

현재 토큰 수 >= autoCompactThreshold

`autoCompactThreshold`를 계산하려면 3개의 상수와 2개의 빼기 레이어가 필요합니다. 소스 코드에서 단계별로 파생해 보겠습니다.

**레이어 1: 효과적인 컨텍스트 창**

``` typescript
// services/compact/autoCompact.ts:30
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

// services/compact/autoCompact.ts:33-48
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
}
```

여기서의 논리는 모델의 원시 컨텍스트 창에서 "압축 출력 예약"을 빼는 것입니다. `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000`는 실제 p99.99 압축 출력 통계에서 나온 것입니다. 압축 요약의 99.99%는 17,387개 토큰에 적합하며 20K는 안전 여유가 있는 상한입니다.

`Math.min(getMaxOutputTokensForModel(model), MAX_OUTPUT_TOKENS_FOR_SUMMARY)` 작업에 유의하세요. 모델의 최대 출력 제한 자체가 20K 미만인 경우(예: 특정 Bedrock 구성) 모델 자체 제한이 대신 사용됩니다.

**레이어 2: 자동 압축 버퍼**

``` typescript
// services/compact/autoCompact.ts:62
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000

// services/compact/autoCompact.ts:72-91
export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  const autocompactThreshold =
    effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS

  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}
```

`AUTOCOMPACT_BUFFER_TOKENS = 13_000`는 추가 안전 버퍼입니다. 이는 임계값 트리거링과 실제 압축 실행 사이에 현재 턴에서 생성할 수 있는 추가 토큰(도구 호출 결과, 시스템 메시지 등)을 위한 충분한 공간이 있는지 확인합니다.

### <a href="#912-threshold-calculation-table" class="header">9.1.2 임계값 계산표</a>

Claude Sonnet 4(200K 컨텍스트 창)를 예로 사용:

<div class="table-wrapper">

| 계산 단계 | 공식 | 값 |
|-------------------------------|---------------------------------|-------------|
| 원시 컨텍스트 창 | `contextWindow` | 200,000 |
| 압축 출력 예약 | `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 20,000 |
| 효과적인 컨텍스트 창 | `contextWindow - 20,000` | 180,000 |
| 자동 압축 버퍼 | `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 |
| **자동 압축 임계값** | **`effectiveWindow - 13,000`** | **167,000** |
| 경고 임계값 | `autoCompactThreshold - 20,000` | 147,000 |
| 오류 임계값 | `autoCompactThreshold - 20,000` | 147,000 |
| 하드 제한 차단 | `effectiveWindow - 3,000` | 177,000 |

</div>

> **대화형 버전**: [토큰 대시보드 애니메이션을 보려면 클릭하세요](compaction-viz.html) — 200K 창이 어떻게 점진적으로 채워지는지, 압축이 트리거될 때, 오래된 메시지가 요약으로 대체되는 방식을 살펴보세요.

좀 더 시각적으로 표현하면 다음과 같습니다.

|<------------ 200K context window ------------>| |<---- 167K usable ---->|<- 13K buffer ->|<- 20K compaction output reservation ->| ^ ^ 자동 압축 효과적인 창 트리거 지점 경계

즉, 기본 구성에서는 대화가 컨텍스트 창의 약 **83.5%**를 소비하면 자동 압축이 트리거됩니다.

### <a href="#913-environment-variable-overrides" class="header">9.1.3 환경 변수 재정의</a>

Claude Code는 사용자(또는 테스트 환경)가 기본 임계값을 재정의할 수 있도록 두 가지 환경 변수를 제공합니다.

**`CLAUDE_CODE_AUTO_COMPACT_WINDOW`** — 컨텍스트 창 크기 재정의

``` typescript
// services/compact/autoCompact.ts:40-46
const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
if (autoCompactWindow) {
  const parsed = parseInt(autoCompactWindow, 10)
  if (!isNaN(parsed) && parsed > 0) {
    contextWindow = Math.min(contextWindow, parsed)
  }
}
```

이 변수는 `Math.min(actual window, configured value)`를 사용합니다. 창을 **축소**할 수만 있고 확장할 수는 없습니다. 일반적인 사용 사례: CI 환경에서 더 작은 창 값을 설정하여 안정성 테스트를 위해 더 자주 압축을 트리거하도록 합니다.

**`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`** — 백분율로 임계값 재정의

``` typescript
// services/compact/autoCompact.ts:79-87
const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
if (envPercent) {
  const parsed = parseFloat(envPercent)
  if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
    const percentageThreshold = Math.floor(
      effectiveContextWindow * (parsed / 100),
    )
    return Math.min(percentageThreshold, autocompactThreshold)
  }
}
```

예를 들어 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50`를 설정하면 임계값이 유효 창(90,000개 토큰)의 50%가 되지만 `Math.min`를 다시 사용하면 이 재정의는 기본 임계값보다 *더 높을* 수 없으며 압축 트리거를 더 일찍 수행할 수만 있습니다.

### <a href="#914-complete-determination-flow" class="header">9.1.4 완전한 결정 흐름</a>

`shouldAutoCompact()` 기능(`autoCompact.ts:160-239`)에는 토큰 수를 비교하기 전에 일련의 보호 조건이 있습니다.

shouldAutoCompact(메시지, 모델, querySource) | +- querySource는 'session_memory' 또는 'compact'입니까? -> false(재귀 방지) +- querySource는 'marble_origami'(ctx-agent)입니까? -> false(공유 상태 오염 방지) +- isAutoCompactEnabled()가 false를 반환합니까? -> 거짓 |   +- DISABLE_COMPACT env var가 사실인가요? -> 거짓 |   +- DISABLE_AUTO_COMPACT 환경 변수가 사실입니까? -> 거짓 |   +- 사용자 구성 autoCompactEnabled = false? -> false +- REACTIVE_COMPACT 실험 모드가 활성화되어 있습니까? -> false(반응형 압축이 인계받도록 함) +- 컨텍스트 축소가 활성화되어 있습니까? -> false(축소는 자체 컨텍스트 관리를 소유함) | +- tokenCount >= autoCompactThreshold? -> 참/거짓

Context Collapse(`autoCompact.ts:199-222`)에 대한 자세한 소스 설명을 참고하세요. 자동 압축은 유효 창의 대략 93%에서 트리거되는 반면 Context Collapse는 90%에서 커밋을 시작하고 95%에서 차단됩니다. 두 가지가 동시에 실행되면 자동 압축은 "총을 뛰어넘어" Collapse가 저장하려고 준비하는 세분화된 컨텍스트를 파괴합니다. 따라서 축소가 활성화되면 사전 자동 압축이 비활성화되고 반응 압축만 413 오류에 대한 대체 수단으로 유지됩니다.

------------------------------------------------------------------------

## <a href="#92-circuit-breaker-consecutive-failure-protection"
class="header">9.2 회로 차단기: 연속 고장 보호</a>

### <a href="#921-problem-background" class="header">9.2.1 문제 배경</a>

이상적인 경우에는 압축 후 컨텍스트가 크게 줄어들고 다음 차례가 다시 트리거되지 않습니다. 그러나 실제로는 "복구할 수 없는" 시나리오 클래스가 있습니다. 컨텍스트에는 압축할 수 없는 시스템 메시지, 첨부 파일 또는 인코딩된 데이터가 대량으로 포함되어 있고 압축 후 결과가 여전히 임계값을 초과하여 다음 턴에 즉시 다시 트리거되어 무한 루프를 형성합니다.

소스 주석은 실제 규모 데이터 포인트(`autoCompact.ts:68-69`)를 문서화합니다.

> BQ 2026-03-10: 단일 세션에서 1,279개 세션에서 50회 이상 연속 실패(최대 3,272회)가 발생하여 전 세계적으로 하루 최대 250,000개의 API 호출이 낭비되었습니다.

**1,279개의 세션에서 연속 실패가 발생했으며 그 중 한 세션에서는 3,272개의 실패에 도달**하여 전 세계적으로 하루에 약 250,000개의 API 호출이 낭비되었습니다. 이는 극단적인 경우가 아닙니다. 엄격한 보호가 필요한 시스템적인 문제입니다.

### <a href="#922-circuit-breaker-implementation" class="header">9.2.2 회로 차단기 구현</a>

``` typescript
// services/compact/autoCompact.ts:70
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

회로 차단기 논리는 매우 간결합니다. 전체 메커니즘은 20줄 미만의 코드입니다.

``` typescript
// services/compact/autoCompact.ts:257-265
if (
  tracking?.consecutiveFailures !== undefined &&
  tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
) {
  return { wasCompacted: false }
}
```

상태 추적은 `AutoCompactTrackingState` 유형을 통해 `queryLoop` 반복 간에 전달됩니다.

``` typescript
// services/compact/autoCompact.ts:51-60
export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  turnId: string
  consecutiveFailures?: number  // Circuit breaker counter
}
```

- **성공 시** (`autoCompact.ts:332`): `consecutiveFailures`가 0으로 재설정됩니다.
- **실패 시** (`autoCompact.ts:341-349`): 카운터 증가; 3에 도달하면 경고가 기록되고 더 이상 시도가 이루어지지 않습니다.
- **트립 후**: 세션에 대한 모든 후속 자동 압축 요청은 즉시 `{ wasCompacted: false }`를 반환합니다.

이 디자인은 중요한 원칙을 구현합니다. **실패할 재시도에 API 예산을 낭비하는 것보다 사용자가 `/compact`를 수동으로 실행하도록 하는 것이 더 좋습니다**. 회로 차단기는 자동 압축만 차단합니다. 사용자는 `/compact` 명령을 통해 수동으로 트리거할 수 있습니다.

------------------------------------------------------------------------

## <a href="#93-compaction-prompt-dissection-the-9-section-template"
class="header">9.3 다짐 프롬프트 해부: 9-섹션 템플릿</a>

임계값이 트리거되면 Claude Code는 전체 대화를 구조화된 요약으로 압축하도록 요청하는 특별한 프롬프트를 모델에 보내야 합니다. 이 프롬프트의 디자인은 압축 품질에 매우 중요합니다. 즉, 요약에서 보존되는 항목과 손실되는 항목을 직접 결정합니다.

### <a href="#931-three-prompt-variants" class="header">9.3.1 세 가지 프롬프트 변형</a>

소스 코드는 각각 다른 압축 시나리오에 해당하는 세 가지 압축 프롬프트 변형을 정의합니다.

<div class="table-wrapper">

| 변종 | 상수 이름 | 사용 사례 | 요약 범위 |
|----|----|----|----|
| **베이스** | `BASE_COMPACT_PROMPT` | 전체 압축(수동 `/compact` 또는 첫 번째 자동 압축) | 전체 대화 |
| **일부** | `PARTIAL_COMPACT_PROMPT` | 부분 압축(초기 컨텍스트를 유지하고 새 메시지만 압축) | 최근 메시지(보존 경계 이후) |
| **PARTIAL_UP_TO** | `PARTIAL_COMPACT_UP_TO_PROMPT` | 접두사 압축(캐시 적중 최적화 경로) | 요약 전 대화 부분 |

</div>

세 가지의 핵심 차이점은 요약의 **"비전 범위"**에 있습니다.

- **BASE**는 모델에게 다음과 같이 지시합니다. "귀하의 작업은 **지금까지의 대화**에 대한 자세한 요약을 작성하는 것입니다." — 모든 것을 요약합니다.
- **PARTIAL**은 모델에 다음과 같이 지시합니다. "귀하의 작업은 대화의 **최근 부분**에 대한 자세한 요약(이전에 유지된 컨텍스트를 따르는 메시지)을 작성하는 것입니다." - 새로운 부분만 요약합니다.
- **PARTIAL_UP_TO**는 모델에 다음과 같이 지시합니다. "이 요약은 계속되는 세션이 시작될 때 배치됩니다. **이 컨텍스트를 기반으로 구축된 새로운 메시지는 요약 다음에 표시됩니다**" — 접두사를 요약하여 후속 메시지에 대한 컨텍스트를 제공합니다.

### <a href="#932-template-structure-analysis" class="header">9.3.2 템플릿 구조 분석</a>

`BASE_COMPACT_PROMPT`를 예로 들면(`prompt.ts:61-143`) 전체 프롬프트는 9개의 구조화된 섹션으로 구성됩니다. 다음은 설계 의도에 대한 섹션별 분석입니다.

<div class="table-wrapper">

| 부분 | 제목 | 디자인 의도 | 주요 지시사항 |
|----|----|----|----|
| 1 | 기본 요청 및 의도 | 사용자의 **명시적 요청**을 캡처하여 압축 후 "주제 드리프트"를 방지합니다. | "사용자의 명시적인 요청과 의도를 모두 자세히 캡처하세요." |
| 2 | 주요 기술 개념 | 기술적 결정을 위한 **상황별 기준** 유지 | 논의된 모든 기술, 프레임워크 및 개념 나열 |
| 3 | 파일 및 코드 섹션 | 정확한 **파일 및 코드** 컨텍스트 유지 | "해당되는 경우 전체 코드 조각 포함" — 참고: 요약이 아닌 전체 코드 조각 포함 |
| 4 | 오류 및 수정 | 반복되는 실수를 방지하기 위해 **디버깅 기록** 보존 | "특정 사용자 피드백에 특별한 주의를 기울이세요" |
| 5 | 문제 해결 | 결과만이 아닌 **문제 해결 과정**을 보존하세요. | "문서 문제 해결 및 지속적인 문제 해결 노력" |
| 6 | 모든 사용자 메시지 | **모든 사용자 메시지** 보존(도구 결과 아님) | "도구 결과가 아닌 모든 사용자 메시지 나열" - 강조를 위해 모두 대문자로 표시 |
| 7 | 보류 중인 작업 | **미완성 작업 목록** 보존 | 명시적으로 요청된 작업만 나열 |
| 8 | 현재 직장 | **현재 작업의 정확한 상태** 보존 | "이 요약 요청 직전에 어떤 작업이 진행 중이었는지 자세히 설명해주세요." |
| 9 | 선택적 다음 단계 | **다음 단계** 유지(보호 조건 포함) | "이 단계가 사용자의 가장 최근 명시적인 요청과 직접적으로 일치하는지 확인하세요." |

</div>

### <a
href="#933-the-analysis-draft-block-a-hidden-quality-assurance-mechanism"
class="header">9.3.3 <code>&lt;분석&gt;</code> 초안 블록: 숨겨진 품질 보증 메커니즘</a>

9개 섹션 요약 전에 템플릿에서는 모델이 먼저 `<analysis>` 블록을 생성해야 합니다.

``` typescript
// prompt.ts:31-44
const DETAILED_ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary,
wrap your analysis in <analysis> tags to organize your thoughts and ensure
you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation.
   For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback...
2. Double-check for technical accuracy and completeness...`
```

이 `<analysis>` 블록은 **초안 작성 패드**입니다. 모델은 최종 요약을 생성하기 전에 전체 대화를 시간순으로 탐색합니다. 핵심 문구는 "**각 메시지를 시간순으로 분석**"입니다. 이는 모델이 여기저기 뛰어다니지 않고 순차적으로 처리하도록 하여 누락을 줄입니다.

하지만 이 초안 블록은 **최종 컨텍스트에는 나타나지 않습니다**. `formatCompactSummary()` 기능(`prompt.ts:311-335`)은 이를 완전히 제거합니다.

``` typescript
// prompt.ts:316-319
formattedSummary = formattedSummary.replace(
  /<analysis>[\s\S]*?<\/analysis>/,
  '',
)
```

이것은 생각의 사슬을 영리하게 적용한 것입니다. `<analysis>` 블록을 활용하여 요약 품질을 향상시키되 압축 후 컨텍스트 공간을 소비하지 않도록 하십시오. 초안 블록의 토큰은 압축 API 호출의 출력에서만 생성되며 후속 대화에 대한 컨텍스트 부담이 되지 않습니다.

### <a href="#934-no_tools_preamble-preventing-tool-calls"
class="header">9.3.4 NO_TOOLS_PREAMBLE: 도구 호출 방지</a>

세 가지 변형 모두 맨 처음에 강력한 "도구 호출 없음" 서문을 삽입합니다.

``` typescript
// prompt.ts:19-26
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
`
```

그리고 마지막에는 일치하는 예고편이 있습니다(`prompt.ts:269-272`).

``` typescript
const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.'
```

소스 의견에서는 이러한 "공격적인" 금지가 필요한 이유를 설명합니다(`prompt.ts:12-18`). 압축 요청은 `maxTurns: 1`로 실행됩니다(한 번의 응답만 허용됨). 이 차례 동안 모델이 도구 호출을 시도하면 도구 호출이 거부되어 **텍스트 출력 없음**이 발생합니다. 전체 압축이 실패하고 스트리밍 폴백 경로로 돌아갑니다. Sonnet 4.6에서는 이 문제가 2.79%의 비율로 발생합니다. 시작과 끝 모두에서의 이중 금지는 이 문제를 무시할 수 있는 수준으로 줄입니다.

### <a href="#935-partial-variant-differences" class="header">9.3.5 부분적 변형 차이</a>

`PARTIAL_COMPACT_PROMPT`와 `BASE_COMPACT_PROMPT`의 주요 차이점은 다음과 같습니다.

1. **범위 제한**: "**최근 메시지에서만** 토론하고, 배우고, 달성한 내용에 요약을 집중하세요."
2. **분석 지침**: `DETAILED_ANALYSIS_INSTRUCTION_PARTIAL`는 BASE 버전의 "**대화**의 각 메시지와 섹션을 시간순으로 분석"을 "**최근 메시지** 시간순으로 분석"으로 대체합니다.

`PARTIAL_COMPACT_UP_TO_PROMPT`는 더욱 독특합니다. 섹션 8은 "현재 작업"에서 "**작업 완료**"로 변경되고, 섹션 9는 "선택적 다음 단계"에서 "**지속 작업을 위한 컨텍스트**"로 변경됩니다. 이는 UP_TO 모드에서 모델이 대화의 전반부만 보기 때문에(후반부는 보존된 메시지로 있는 그대로 추가됨) 요약은 다음 단계를 계획하기보다는 "계속"에 대한 컨텍스트를 제공해야 하기 때문입니다.

------------------------------------------------------------------------

## <a href="#94-compaction-execution-flow" class="header">9.4 압축 실행 흐름</a>

### <a href="#941-compactconversation-main-flow" class="header">9.4.1 <code>compactConversation()</code> 메인 흐름</a>

`compactConversation()` 기능(`compact.ts:387-704`)은 압축의 핵심 조정자입니다. 주요 흐름은 다음과 같이 요약될 수 있습니다.

``` mermaid
flowchart TD
    A[Start compaction] --> B[Execute PreCompact Hooks]
    B --> C[Build compaction prompt]
    C --> D[Send compaction request]
    D --> E{Is response<br/>prompt_too_long?}
    E -->|Yes| F[PTL retry loop]
    E -->|No| G{Is summary valid?}
    F --> D
    G -->|No| H[Throw error]
    G -->|Yes| I[Clear file state cache]
    I --> J[Generate attachments in parallel:<br/>files/plan/skills/tools/MCP]
    J --> K[Execute SessionStart Hooks]
    K --> L[Build CompactionResult]
    L --> M[Record telemetry event]
    M --> N[Return result]
```

몇 가지 주목할만한 세부 사항:

**사전 지우기 및 사후 복원**(`compact.ts:518-561`): 압축이 완료된 후 코드는 먼저 `readFileState` 캐시 및 `loadedNestedMemoryPaths`를 지운 다음 `createPostCompactFileAttachments()`를 통해 가장 중요한 파일 컨텍스트를 복원합니다. 이는 "잊은 후 불러오기" 전략입니다. 요약의 모든 파일 내용을 보존하는 대신(신뢰할 수 없음) 압축 후 가장 중요한 파일을 다시 읽습니다(매우 결정적). 파일 복원 예산: 최대 5개 파일, 총 50,000개 토큰, 파일당 최대 5,000개 토큰.

**첨부 파일 재삽입**(`compact.ts:566-585`): 압축에서는 이전 델타 첨부 파일(지연된 도구 선언, 에이전트 목록, MCP 지침)을 사용했습니다. 코드는 "빈 메시지 기록"을 기준으로 사용하여 압축 후 이러한 첨부 파일을 재생성하여 압축 후 첫 번째 차례에서 모델이 완전한 도구 및 지침 컨텍스트를 갖도록 보장합니다.

### <a href="#942-post-compaction-message-structure" class="header">9.4.2 압축 후 메시지 구조</a>

압축으로 생성된 `CompactionResult`는 `buildPostCompactMessages()`(`compact.ts:330-338`)를 통해 최종 메시지 배열로 어셈블됩니다.

[boundaryMarker, ...summaryMessages, ...messagesToKeep, ...첨부 파일, ...hookResults]

어디:

- `boundaryMarker`: 압축이 발생한 `SystemCompactBoundaryMessage` 표시
- `summaryMessages`: `getCompactUserSummaryMessage()`에서 생성된 서문을 포함하는 사용자 메시지 형식의 요약("이 세션은 컨텍스트가 부족한 이전 대화에서 계속되고 있습니다.")
- `messagesToKeep`: 부분 압축 중에 최근 메시지가 보존되었습니다.
- `attachments`: 파일, 계획, 기술, 도구 및 기타 첨부 파일
- `hookResults`: SessionStart 후크의 결과

------------------------------------------------------------------------

## <a href="#95-ptl-retry-when-compaction-itself-is-too-long"
class="header">9.5 PTL 재시도: 압축 자체가 너무 긴 경우</a>

### <a href="#951-problem-scenario" class="header">9.5.1 문제 시나리오</a>

이는 "재귀적" 딜레마입니다. 대화가 너무 길고 압축이 필요하지만 **압축 요청 자체**가 API의 입력 제한(prompt_too_long)을 초과합니다. 매우 긴 세션(예: 190,000개 이상의 토큰을 소비하는 세션)에서 전체 대화 기록을 압축 모델로 보내면 압축 요청의 입력 토큰이 컨텍스트 창 안팎으로 푸시될 수 있습니다.

### <a href="#952-retry-mechanism" class="header">9.5.2 재시도 메커니즘</a>

`truncateHeadForPTLRetry()` 기능(`compact.ts:243-291`)은 "가장 오래된 콘텐츠 삭제" 재시도 전략을 구현합니다.

``` mermaid
flowchart TD
    A[Compaction request] --> B{Does response start<br/>with PROMPT_TOO_LONG?}
    B -->|No| C[Compaction succeeds]
    B -->|Yes| D{ptlAttempts <= 3?}
    D -->|No| E[Throw error:<br/>Conversation too long]
    D -->|Yes| F[truncateHeadForPTLRetry]
    F --> G[Parse tokenGap]
    G --> H{Is tokenGap<br/>parseable?}
    H -->|Yes| I[Discard oldest<br/>API round groups<br/>by tokenGap]
    H -->|No| J[Fallback: discard<br/>20% of round groups]
    I --> K{At least 1<br/>group remains?}
    J --> K
    K -->|No| L[Return null -> failure]
    K -->|Yes| M[Prepend PTL_RETRY_MARKER]
    M --> N[Resend compaction request<br/>with truncated messages]
    N --> B
```

핵심 논리에는 세 단계가 있습니다.

**1단계: API 라운드별로 그룹화**

``` typescript
// compact.ts:257
const groups = groupMessagesByApiRound(input)
```

`groupMessagesByApiRound()`(`grouping.ts:22-60`)는 API 라운드 경계별로 메시지를 그룹화합니다. 새 보조 메시지 ID가 나타날 때마다 새 그룹이 시작됩니다. 이렇게 하면 삭제 작업이 해당 tool_result에서 tool_use를 분할하지 않도록 보장됩니다.

**2단계: 폐기 횟수 계산**

``` typescript
// compact.ts:260-272
const tokenGap = getPromptTooLongTokenGap(ptlResponse)
let dropCount: number
if (tokenGap !== undefined) {
  let acc = 0
  dropCount = 0
  for (const g of groups) {
    acc += roughTokenCountEstimationForMessages(g)
    dropCount++
    if (acc >= tokenGap) break
  }
} else {
  dropCount = Math.max(1, Math.floor(groups.length * 0.2))
}
```

API의 Prompt_too_long 응답에 특정 토큰 간격이 포함된 경우 코드는 이 간격을 메울 때까지 가장 오래된 그룹부터 정확하게 누적됩니다. 간격을 구문 분석할 수 없는 경우(일부 Vertex/Bedrock 오류 형식이 다름) 보수적이지만 효과적인 휴리스틱인 **그룹의 20% 삭제**로 대체됩니다.

**3단계: 메시지 순서 수정**

``` typescript
// compact.ts:278-291
const sliced = groups.slice(dropCount).flat()
if (sliced[0]?.type === 'assistant') {
  return [
    createUserMessage({ content: PTL_RETRY_MARKER, isMeta: true }),
    ...sliced,
  ]
}
return sliced
```

가장 오래된 그룹을 삭제한 후 나머지 메시지의 첫 번째 항목은 보조 메시지일 수 있습니다(원래 대화의 사용자 프리앰블이 삭제된 그룹 0에 있었기 때문입니다). API에서는 첫 번째 메시지가 사용자 역할이어야 하므로 코드는 합성 사용자 표시 메시지 `PTL_RETRY_MARKER`를 삽입합니다.

### <a href="#953-preventing-marker-accumulation" class="header">9.5.3 마커 축적 방지</a>

`truncateHeadForPTLRetry()`(`compact.ts:250-255`) 시작 부분의 미묘한 처리에 유의하세요.

``` typescript
const input =
  messages[0]?.type === 'user' &&
  messages[0].isMeta &&
  messages[0].message.content === PTL_RETRY_MARKER
    ? messages.slice(1)
    : messages
```

그룹화하기 전에 시퀀스의 첫 번째 메시지가 이전 재시도에 의해 삽입된 `PTL_RETRY_MARKER`인 경우 코드는 이를 먼저 제거합니다. 그렇지 않으면 이 마커는 그룹 0으로 그룹화되고 20% 대체 전략은 "이 마커만 삭제"할 수 있습니다. 즉, 진행률이 0이고 두 번째 재시도가 무한 루프에 들어갑니다.

### <a href="#954-retry-limit-and-cache-passthrough" class="header">9.5.4 재시도 제한 및 캐시 통과</a>

``` typescript
// compact.ts:227
const MAX_PTL_RETRIES = 3
```

최대 3회 재시도. 재시도할 때마다 메시지가 잘릴 뿐만 아니라 `cacheSafeParams`(`compact.ts:487-490`)도 업데이트되어 분기된 에이전트 경로도 잘린 메시지를 사용하도록 합니다.

``` typescript
retryCacheSafeParams = {
  ...retryCacheSafeParams,
  forkContextMessages: truncated,
}
```

3번의 재시도가 모두 실패하면 `ERROR_MESSAGE_PROMPT_TOO_LONG`가 발생하고 사용자에게 "대화 시간이 너무 깁니다. 메시지 몇 개 위로 올라가서 다시 시도하려면 esc를 두 번 누르세요."라는 메시지가 표시됩니다.

------------------------------------------------------------------------

## <a href="#96-complete-orchestration-of-autocompactifneeded"
class="header">9.6 <code>autoCompactIfNeeded()</code>의 완전한 오케스트레이션</a>

위의 모든 메커니즘을 함께 연결하는 `autoCompactIfNeeded()`(`autoCompact.ts:241-351`)는 각 반복에서 `queryLoop`가 호출하는 진입점입니다. 전체 흐름은 다음과 같습니다.

``` mermaid
flowchart TD
    A["queryLoop each iteration"] --> B{"DISABLE_COMPACT?"}
    B -->|Yes| Z["Return wasCompacted: false"]
    B -->|No| C{"consecutiveFailures >= 3?<br/>(circuit breaker)"}
    C -->|Yes| Z
    C -->|No| D["shouldAutoCompact()"]
    D -->|Not needed| Z
    D -->|Needed| E["Try Session Memory compaction"]
    E -->|Success| F["Cleanup + return result"]
    E -->|Failure/not applicable| G["compactConversation()"]
    G -->|Success| H["Reset consecutiveFailures = 0<br/>Return result"]
    G -->|Failure| I{"Is user abort?"}
    I -->|Yes| J["Log error"]
    I -->|No| J
    J --> K["consecutiveFailures++"]
    K --> L{">= 3?"}
    L -->|Yes| M["Log circuit breaker warning"]
    L -->|No| N["Return wasCompacted: false"]
    M --> N
```

흥미로운 우선순위에 주목하세요. 코드는 먼저 **세션 메모리 압축**(`autoCompact.ts:287-310`)을 시도하고 세션 메모리를 사용할 수 없거나 충분한 공간을 확보할 수 없는 경우에만 기존 `compactConversation()`로 대체됩니다. 세션 메모리 압축은 보다 세분화된 전략(전체 요약이 아닌 메시지 정리)이며, 이에 대해서는 이후 장에서 자세히 설명합니다.

------------------------------------------------------------------------

## <a href="#97-what-users-can-do" class="header">9.7 사용자가 할 수 있는 일</a>

자동 압축의 내부 메커니즘을 이해한 후 사용자로서 취할 수 있는 구체적인 조치는 다음과 같습니다.

### <a href="#971-observe-compaction-timing" class="header">9.7.1 압축 타이밍 관찰</a>

긴 세션 동안 짧은 "압축 중..." 상태 표시기가 나타나면 자동 압축이 진행 중인 것입니다. 임계값 공식에 따르면 컨텍스트 창이 200K인 경우 이는 대략 167K 토큰(약 83.5% 사용량)에서 발생합니다.

### <a href="#972-manually-compact-ahead-of-time" class="header">9.7.2 미리 수동으로 압축하기</a>

자동 압축이 실행될 때까지 기다리지 마십시오. 하나의 하위 작업을 완료하고 다음 작업을 시작하기 전에 사전에 `/compact`를 실행하세요. 수동 압축을 사용하면 사용자 지정 지침을 전달할 수 있습니다.

/compact 파일 수정 기록 및 오류 수정 기록을 보존하는 데 중점을 두고 코드 조각을 완전하게 유지합니다.

이러한 사용자 지정 지침은 압축 프롬프트 끝에 추가되어 요약 콘텐츠에 직접적인 영향을 미칩니다.

### <a href="#973-leverage-compaction-instructions-in-claudemd"
class="header">9.7.3 CLAUDE.md의 압축 명령 활용</a>

프로젝트의 `CLAUDE.md`에 압축 지침 섹션을 추가할 수 있습니다. 이 섹션은 압축할 때마다 자동으로 삽입됩니다.

``` markdown
## Compact Instructions
When summarizing the conversation focus on typescript code changes
and also remember the mistakes you made and how you fixed them.
```

### <a href="#974-adjust-thresholds-with-environment-variables"
class="header">9.7.4 환경 변수를 사용하여 임계값 조정</a>

자동 압축 트리거가 너무 일찍(불필요한 컨텍스트 손실 발생) 또는 너무 늦게(빈번한 프롬프트_too_long 오류 발생) 발견된 경우 환경 변수를 사용하여 세부 조정할 수 있습니다.

``` bash
# Trigger compaction at 70% (more conservative, fewer PTL errors)
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70

# Or directly limit the "visible window" to 100K (for slow networks/tight budgets)
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000
```

### <a href="#975-disable-auto-compaction-not-recommended"
class="header">9.7.5 자동 압축 비활성화(권장하지 않음)</a>

``` bash
# Only disable auto-compaction, keep manual /compact
export DISABLE_AUTO_COMPACT=1

# Completely disable all compaction (including manual)
export DISABLE_COMPACT=1
```

완전히 비활성화한다는 것은 컨텍스트를 수동으로 관리해야 함을 의미합니다. 그렇지 않으면 컨텍스트 창이 소진되었을 때 복구할 수 없는 프롬프트_too_long 오류가 발생하게 됩니다.

### <a href="#976-understanding-post-compaction-forgetting"
class="header">9.7.6 압축 후 "망각" 이해하기</a>

압축 후 모델이 "잊는" 내용은 전적으로 9섹션 요약 템플릿이 다루는 내용에 따라 달라집니다. 가장 쉽게 잃어버리는 정보 유형:

1. **정확한 코드 차이점**: 템플릿이 "전체 코드 조각"을 요청하는 동안 매우 긴 차이점 목록은 잘립니다.
2. **거절된 접근 방식에 대한 구체적인 이유**: 템플릿은 '무엇이 수행되었는지'에 초점을 맞추고 '무엇이 수행되지 않은 이유'에 대한 범위는 약합니다.
3. **초기 대화의 미묘한 선호**: 처음에 "lodash를 사용하지 마세요"라고 한 번 언급한 경우 여러 번의 압축 후에 사라질 수 있습니다.

완화 전략: `CLAUDE.md`에 중요한 제약 조건을 작성하거나(압축의 영향을 받지 않음) 압축 지침에 보존할 정보를 명시적으로 나열합니다.

### <a href="#977-recovery-after-circuit-breaker-trips" class="header">9.7.7 회로 차단기 작동 후 복구</a>

모델이 더 이상 자동 압축되지 않는 경우(3회 연속 실패 후 회로 차단기 작동) 다음을 수행할 수 있습니다.

1. 압축을 시도하려면 `/compact`를 수동으로 실행하세요.
2. 그래도 실패하면 새 세션을 시작하십시오. 어떤 경우에는 컨텍스트가 복구 불가능합니다.

------------------------------------------------------------------------

## <a href="#98-summary" class="header">9.8 요약</a>

자동 압축은 Claude Code의 가장 중요한 컨텍스트 관리 메커니즘 중 하나이며 그 설계에는 몇 가지 중요한 엔지니어링 원칙이 반영되어 있습니다.

1. **다층 버퍼링**: 20K 출력 예약 + 13K 버퍼 + 3K 차단 하드 제한 - 3개 방어선으로 어떤 경쟁 조건에서도 시스템이 오버플로되지 않도록 보장합니다.
2. **점진적 성능 저하**: 세션 메모리 압축 -\> 기존 압축 -\> PTL 재시도 -\> 회로 차단기 - 각 레이어는 위 레이어에 대한 대체입니다.
3. **관찰 가능성**: `tengu_compact`, `tengu_compact_failed`, `tengu_compact_ptl_retry` — 성공, 실패 및 재시도 경로를 다루는 세 가지 원격 측정 이벤트
4. **사용자 제어 가능성**: 환경 변수 재정의, 사용자 정의 압축 지침, 수동 `/compact` 명령 — 고급 사용자에게 충분한 제어 제공

다음 장에서는 압축 후 파일 상태 보존 메커니즘을 살펴보겠습니다. 압축은 대화 기록을 "잊을" 수 있지만 편집 중인 파일을 "잊어서는" 안 됩니다.

------------------------------------------------------------------------

## <a href="#version-evolution-v2191-changes" class="header">버전 진화: v2.1.91 변경 사항</a>

> 다음 분석은 v2.1.88 소스 코드 추론과 결합된 v2.1.91 번들 신호 비교를 기반으로 합니다.

### <a href="#file-state-staleness-detection" class="header">파일 상태 비활성 감지</a>

v2.1.91의 `sdk-tools.d.ts`는 새로운 `staleReadFileStateHint` 필드를 추가합니다.

``` typescript
staleReadFileStateHint?: string;
// Model-facing note listing readFileState entries whose mtime bumped
// during this command (set when WRITE_COMMAND_MARKERS matches)
```

이는 도구 실행 중에 Bash 명령이 이전에 읽은 파일을 수정하는 경우 시스템이 도구 결과에 부실 힌트를 첨부하여 "이전에 읽은 파일 A가 수정되었습니다"라고 모델에 알립니다. 이는 이 장에 설명된 압축 후 파일 상태 보존 메커니즘을 보완합니다. 즉, 압축은 "장기 메모리"를 처리하고, 오래된 힌트는 "단일 회전 즉시성"을 처리합니다.

------------------------------------------------------------------------

## <a href="#version-evolution-v21100-changes" class="header">버전 발전: v2.1.100 변경 사항</a>

> 다음 분석은 v2.1.88 소스 코드 추론과 결합된 v2.1.100 번들 신호 비교를 기반으로 합니다.

### <a href="#cold-compact-deferred-strategy-with-feature-flag-control"
class="header">Cold Compact: 기능 플래그 제어를 사용한 지연 전략</a>

v2.1.100의 `tengu_cold_compact` 이벤트는 콜드 컴팩트가 실험에서 제어된 배포로 이동했음을 나타냅니다. 번들에서 추출된 트리거 로직:

``` javascript
// v2.1.100 bundle reverse engineering
let M = GPY() && S8("tengu_cold_compact", !1);
// GPY() — Feature Flag gate (server-side control switch)
// S8("tengu_cold_compact", false) — GrowthBook config, default off
try {
  let P = await QS6(q, K, _, !0, void 0, !0, J, M);
  // M passed as 8th parameter to the core compaction function
```

저온 컴팩트와 핫 컴팩트의 차이점:

<div class="table-wrapper">

| 차원 | 핫 컴팩트(자동 컴팩트) | 콜드 컴팩트 |
|----|----|----|
| 트리거 타이밍 | 상황이 거의 꽉 찼을 때 긴급하게 | 보다 적절한 시점으로 연기됨 |
| 긴급 | 높음 - 실행해야 하며 그렇지 않으면 API 호출이 실패합니다. | 낮음 — 사용자 확인 또는 더 나은 중단점을 기다릴 수 있습니다. |
| v2.1.88 대응 | `autoCompact.ts:72-91` 임계값 계산 | 존재하지 않습니다 |
| 기능 플래그 | 항상 활성화됨 | `tengu_cold_compact`에 의해 제어됨 |

</div>

### <a href="#rapid-refill-circuit-breaker" class="header">급속 리필 회로 차단기</a>

`tengu_auto_compact_rapid_refill_breaker` 이벤트는 압축 시스템의 극단적인 경우를 해결합니다. 압축이 방금 완료되고 사용자가 즉시 고밀도 입력을 재개하여 신속한 컨텍스트 재충전이 발생하는 경우 시스템은 "압축 → 다시 채우기 → 다시 압축" 사망 루프에 들어갈 수 있습니다. 회로 차단기는 `consecutiveRapidRefills` 카운터를 통해 연속적인 빠른 리필을 추적합니다. 컨텍스트가 이전 컴팩트의 3회전 이내에 컴팩트 임계값까지 리필되면 카운터가 증가합니다. 3회 연속 빠른 리필은 차단기를 작동시켜 압축을 중단하고 사용자에게 "Autocompact is thrashing(자동 압축이 스래싱 중)"임을 표시하여 시스템 안정성을 위해 한 번의 압축 기회를 희생합니다.

### <a href="#user-triggerable-compact-command"
class="header">사용자가 트리거할 수 있는 <code>/compact</code> 명령</a>

v2.1.100에는 `tengu_autocompact_command` 및 `tengu_autocompact_dialog_opened` 이벤트가 추가되어 사용자가 이제 `/compact` 명령을 통해 압축을 트리거하고 확인 대화 상자를 통해 진행할지 여부를 결정할 수 있음을 나타냅니다. 이는 압축이 완전히 시스템 자동화된 v2.1.88 모델을 변경합니다. 즉, 사용자는 컨텍스트 관리를 적극적으로 제어할 수 있습니다.

### <a href="#max_context_tokens-override" class="header">MAX_CONTEXT_TOKENS 재정의</a>

새로운 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 환경 변수를 사용하면 사용자가 최대 컨텍스트 토큰 수를 재정의할 수 있습니다. 번들 리버스 엔지니어링에서:

``` javascript
// v2.1.100 bundle reverse engineering
if (B6(process.env.DISABLE_COMPACT) && process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
  let _ = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10);
  if (!isNaN(_) && _ > 0) // Override context window size
```

이 재정의는 `DISABLE_COMPACT`도 활성화된 경우에만 적용됩니다. 설계 의도는 압축 안전 임계값을 우회하는 것이 아니라 자동 압축이 비활성화된 경우 고급 사용자가 컨텍스트 예산을 수동으로 제어할 수 있도록 하는 것입니다.
