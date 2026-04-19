# <a href="#chapter-5-system-prompt-architecture" class="header">5장: 시스템 프롬프트 아키텍처</a>

> **포지셔닝**: 이 장에서는 CC가 시스템 프롬프트(섹션 등록 및 메모이제이션, 캐시 경계 표시, 다중 소스 우선순위 합성)를 어떻게 동적으로 조합하는지 분석합니다. 전제 조건: 3장(에이전트 루프). 대상 독자: CC가 시스템 프롬프트를 동적으로 구성하는 방법을 이해하려는 독자 또는 자신의 에이전트에 대한 프롬프트 아키텍처를 설계하려는 개발자.

> 4장에서는 도구 실행의 전체 조정 프로세스를 분석했습니다. 모델이 도구 호출을 하기 전에 먼저 "자신이 누구인지 알아야" 합니다. 이것이 바로 시스템 프롬프트의 역할입니다. 이 장에서는 섹션이 등록되고 메모되는 방식, 정적 콘텐츠와 동적 콘텐츠가 경계 표시로 분리되는 방식, API 계층에서 캐시 최적화 계약이 적용되는 방식, 다중 소스 프롬프트가 우선순위에 따라 모델에 전송되는 최종 명령어 세트에 합성되는 방식 등 시스템 프롬프트의 어셈블리 아키텍처에 대해 자세히 설명합니다.

## <a href="#51-why-the-system-prompt-needs-architecture"
class="header">5.1 시스템 프롬프트에 "아키텍처"가 필요한 이유</a>

단순한 구현에서는 시스템 프롬프트를 단일 문자열 상수로 하드코딩할 수 있습니다. 그러나 Claude Code의 시스템 프롬프트는 세 가지 엔지니어링 문제에 직면해 있습니다.

1. **볼륨 및 비용**: 전체 시스템 프롬프트에는 ID 소개, 행동 지침, 도구 사용 지침, 환경 정보, 메모리 파일, MCP 지침 및 기타 10개 이상의 섹션이 포함되어 총 수만 개의 토큰이 포함됩니다. 모든 API 호출에서 이 모든 것을 재전송한다는 것은 막대한 프롬프트 캐싱 비용을 의미합니다.
2. **변경 빈도 변경**: ID 소개 및 코딩 지침은 모든 사용자와 모든 세션에서 동일하지만 환경 정보(작업 디렉터리, OS 버전)는 세션마다 다르며 MCP 서버 지침은 대화 중에도 변경될 수 있습니다.
3. **다중 소스 재정의**: 사용자는 `--system-prompt`를 통해 프롬프트를 사용자 정의할 수 있고, 에이전트 모드에는 자체 전용 프롬프트가 있고, 코디네이터 모드에는 독립적인 프롬프트가 있으며, 루프 모드는 모든 것을 완전히 재정의할 수 있습니다. 이러한 소스 간의 우선 순위는 명확해야 합니다.

Claude Code의 솔루션은 **섹션 구성 아키텍처**입니다. 즉, 시스템 프롬프트를 독립적이고 메모 가능한 섹션으로 분할하고, 레지스트리를 통해 라이프사이클을 관리하고, 경계 마커를 사용하여 캐시 계층을 묘사하고, 궁극적으로 API 계층에서 이를 `cache_control`를 사용하여 요청 블록으로 변환합니다.

> **대화형 버전**: [프롬프트 조립 애니메이션을 보려면 클릭하세요.](prompt-assembly-viz.html) -- 캐시 비율이 실시간으로 계산되므로 7개의 섹션이 층별로 쌓이는 것을 확인하세요.

## <a
href="#52-section-registry-memoization-and-cache-awareness-of-systempromptsection"
class="header">5.2 섹션 레지스트리: systemPromptSection의 메모화 및 캐시 인식</a>

### <a href="#521-core-abstraction" class="header">5.2.1 핵심 추상화</a>

시스템 프롬프트의 최소 단위는 **섹션**입니다. 각 섹션은 이름, 계산 기능 및 캐시 전략으로 구성됩니다. 이 추상화는 `systemPromptSections.ts`에 정의되어 있습니다.

``` typescript
type SystemPromptSection = {
  name: string
  compute: ComputeFn        // () => string | null | Promise<string | null>
  cacheBreak: boolean       // false = memoizable, true = recomputed each turn
}
```

**출처 참조:** `restored-src/src/constants/systemPromptSections.ts:10-14`

두 개의 팩토리 함수가 섹션을 생성합니다.

- **`systemPromptSection(name, compute)`** -- **메모 섹션**을 생성합니다. 계산 함수는 첫 번째 호출에서만 실행됩니다. 결과는 전역 상태로 캐시되고 후속 턴에서는 캐시된 값을 직접 반환합니다. 캐시는 `/clear` 또는 `/compact`에서 재설정됩니다.
- **`DANGEROUS_uncachedSystemPromptSection(name, compute, reason)`** -- **휘발성 섹션**을 생성합니다. 계산 기능은 해결될 때마다 다시 실행됩니다. `DANGEROUS_` 접두사 및 필수 `reason` 매개변수는 의도적인 API 마찰로, 이러한 유형의 섹션은 **프롬프트 캐싱을 중단**한다는 점을 개발자에게 상기시킵니다.

<!-- -->

┌───────────────────────────────────────────────────────────────────┐ │ 섹션 레지스트리 │ │ │ │ ┌─────────────────────┐ ┌───────────────────────────────────┐ │ │ │ systemPromptSection │ │ DANGEROUS_uncachedSystemPromptSection│ │ │ │ 캐시 브레이크=false │ │ 캐시 브레이크=true │ │ │ └─────────┬────────────┘ └───────────┬───────────────────────┘ │ │ │ │ │ │ ▼ ▼ │ │ │ ┌──────────────────────────────────────────────────────────────┐ │ │ │solveSystemPromptSections(섹션) │ │ │ │ │ │ │ │ 각 섹션에 대해: │ │ │ │ if (!cacheBreak && 캐시.has(이름)): │ │ │ │ 반환 캐시.get(이름) ← 메모 적중 │ │ │ │ else: │ │ │ │ 값 = 대기 계산() │ │ │ │ 캐시.set(이름, 값) ← 캐시에 쓰기 │ │ │ │ 반환 값 │ │ │ └─────────────────────────────────────────────────────────────┘ │ │ │ 캐시 저장: STATE.systemPromptSectionCache (Map<string, string|null>) │ │ 재설정 타이밍: /clear, /compact →clearSystemPromptSections() │ └────────────────────────────────────────────────────────────────┘

**그림 5-1: 섹션 레지스트리의 메모 흐름.** 메모된 섹션(`cacheBreak=false`)은 첫 번째 계산 후 글로벌 맵에 캐시됩니다. 휘발성 섹션(`cacheBreak=true`)은 매번 다시 계산됩니다.

### <a href="#522-resolution-flow" class="header">5.2.2 해결 흐름</a>

`resolveSystemPromptSections`는 섹션 정의를 실제 문자열(`restored-src/src/constants/systemPromptSections.ts:43-58`)로 변환하는 핵심 기능입니다.

``` typescript
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  const cache = getSystemPromptSectionCache()
  return Promise.all(
    sections.map(async s => {
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name) ?? null
      }
      const value = await s.compute()
      setSystemPromptSectionCacheEntry(s.name, value)
      return value
    }),
  )
}
```

몇 가지 주요 설계 결정:

- **병렬 해상도**: `Promise.all`를 사용하여 모든 섹션 계산 기능을 병렬로 실행합니다. 이는 I/O 작업이 필요한 섹션(예: CLAUDE.md 파일을 읽는 `loadMemoryPrompt`)에 특히 중요합니다.
- **null은 유효함**: `null`를 반환하는 계산 함수는 해당 섹션이 최종 프롬프트에 포함될 필요가 없음을 나타냅니다. `null` 값도 캐시되어 후속 턴에서 반복적인 상태 확인을 방지합니다.
- **캐시 저장 위치**: 캐시는 `STATE.systemPromptSectionCache`(`restored-src/src/bootstrap/state.ts:203`), `Map<string, string | null>`에 저장됩니다. 모듈 수준 변수 대신 전역 상태를 선택하면 `/clear` 및 `/compact` 명령이 모든 상태를 균일하게 재설정할 수 있습니다.

### <a href="#523-cache-lifecycle" class="header">5.2.3 캐시 수명주기</a>

캐시 지우기는 `clearSystemPromptSections` 기능(`restored-src/src/constants/systemPromptSections.ts:65-68`)에 의해 처리됩니다.

``` typescript
export function clearSystemPromptSections(): void {
  clearSystemPromptSectionState()   // clear the Map
  clearBetaHeaderLatches()          // reset beta header latches
}
```

이 함수는 두 지점에서 호출됩니다.

1. **`/clear` 명령** -- 사용자가 대화 기록을 명시적으로 지우면 모든 섹션 캐시가 무효화되고 다음 API 호출이 모든 섹션을 다시 계산합니다.
2. **`/compact` 명령** -- 대화가 압축되면 섹션 캐시도 마찬가지로 무효화됩니다. 압축으로 인해 컨텍스트 상태(예: 사용 가능한 도구 목록)가 변경될 수 있고 이전 상태에서 계산된 섹션 값이 더 이상 정확하지 않을 수 있기 때문입니다.

함께 제공되는 `clearBetaHeaderLatches()`는 이전 턴의 래치 값을 전달하는 대신 새로운 대화가 AFK, 고속 모드 및 기타 베타 기능 헤더를 재평가할 수 있도록 보장합니다.

## <a href="#53-when-to-use-dangerous_uncachedsystempromptsection"
class="header">5.3 DANGEROUS_uncachedSystemPromptSection을 사용해야 하는 경우</a>

`DANGEROUS_` 접두사는 장식용이 아니며 실제 엔지니어링 절충안을 나타냅니다. 소스 코드의 유일한 사용법을 살펴보겠습니다.

``` typescript
DANGEROUS_uncachedSystemPromptSection(
  'mcp_instructions',
  () =>
    isMcpInstructionsDeltaEnabled()
      ? null
      : getMcpInstructionsSection(mcpClients),
  'MCP servers connect/disconnect between turns',
),
```

**출처 참조:** `restored-src/src/constants/prompts.ts:513-520`

MCP 서버는 대화의 두 차례 사이에 연결하거나 연결을 끊을 수 있습니다. MCP 지침 섹션이 메모된 경우 1턴에 연결된 서버 A만 사용하여 계산하고 A에 대한 지침을 캐싱합니다. 3번째 차례가 되면 서버 B도 연결될 수 있지만 캐시는 여전히 A만 포함하는 이전 값을 반환합니다. 즉, 모델은 B의 존재에 대해 전혀 알 수 없습니다.

`DANGEROUS_uncachedSystemPromptSection`의 사용 사례는 다음과 같습니다. **섹션의 내용이 대화 수명 주기 내에서 변경될 수 있고 오래된 값을 사용하면 기능 오류가 발생할 수 있는 경우**.

코드 주석(`'MCP servers connect/disconnect between turns'`)의 `reason` 매개변수는 단순한 문서가 아니라 코드 검토 제약 조건이기도 합니다. 새로운 `DANGEROUS_` 섹션을 소개하는 모든 PR에서는 캐시 무효화가 필요한 이유를 설명해야 합니다.

소스 코드에는 "DANGEROUS에서 일반 캐싱으로 다운그레이드"한 사례도 기록되어 있다는 점은 주목할 만합니다. `token_budget` 섹션은 한때 `getCurrentTurnTokenBudget()`를 기반으로 동적으로 전환되는 `DANGEROUS_uncachedSystemPromptSection`였지만 이로 인해 모든 예산 전환에서 약 20,000개의 캐시 토큰이 손상되었습니다. 해결책은 예산이 없을 때 자연스럽게 작동하지 않도록 프롬프트 텍스트를 바꿔서 일반 `systemPromptSection`(`restored-src/src/constants/prompts.ts:540-550`)로 다운그레이드하는 것이었습니다.

## <a href="#54-static-vs-dynamic-boundary-system_prompt_dynamic_boundary"
class="header">5.4 정적 경계와 동적 경계: SYSTEM_PROMPT_DYNAMIC_BOUNDARY</a>

### <a href="#541-boundary-marker-definition" class="header">5.4.1 경계 표시 정의</a>

시스템 프롬프트 내에는 콘텐츠를 "정적 영역"과 "동적 영역"으로 나누는 명시적인 구분선이 있습니다.

``` typescript
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

**출처 참조:** `restored-src/src/constants/prompts.ts:114-115`

이 문자열 상수는 최종적으로 모델에 전송되는 텍스트에 나타나지 않습니다. 이는 다운스트림 `splitSysPromptPrefix` 기능이 식별하고 처리할 수 있도록 시스템 프롬프트 배열 내에만 존재하는 **대역 내 신호**입니다.

### <a href="#542-boundary-position-and-meaning" class="header">5.4.2 경계 위치와 의미</a>

`getSystemPrompt` 함수의 반환 배열에서 경계 마커는 정적 콘텐츠와 동적 콘텐츠(`restored-src/src/constants/prompts.ts:560-576`) 사이에 정확하게 배치됩니다.

반환 배열 구조: [ getSimpleIntroSection(...) ─┐ getSimpleSystemSection() │ 정적 영역: 모든 사용자/세션에 동일 getSimpleDoingTasksSection() │ → 캐시 범위: 'global' getActionsSection() │ getUsingYourToolsSection(...) │ getSimpleToneAndStyleSection() │ getOutputEfficiencySection() ─┘ SYSTEM_PROMPT_DYNAMIC_BOUNDARY ← 경계 마커 session_guidance ─┐ 메모리(CLAUDE.md) │ 동적 영역: 세션/사용자에 따라 다름 env_info_simple │ → 캐시 범위: null(캐시되지 않음) 언어 │ 출력 스타일 │ mcp_instructions(위험) │ 스크래치 패드 │ ... ─┘ ]

**그림 5-2: 정적/동적 경계 다이어그램.** 경계 표시는 시스템 프롬프트 배열을 각각 다른 캐시 범위에 해당하는 두 개의 영역으로 나눕니다.

핵심 규칙: **경계 표시 이전의 모든 콘텐츠는 모든 조직, 모든 사용자 및 모든 세션에서 완전히 동일합니다**. 이는 조직 간 캐싱을 위해 `scope: 'global'`를 사용할 수 있음을 의미합니다. 즉, 한 사용자의 API 호출로 계산된 캐시 접두어는 다른 사용자의 호출로 직접 적중될 수 있습니다.

경계 마커는 자사 API 제공업체가 글로벌 캐싱을 활성화한 경우에만 삽입됩니다.

``` typescript
...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
```

`shouldUseGlobalCacheScope()`(`restored-src/src/utils/betas.ts:227-231`)는 API 제공자가 `'firstParty'`(즉, Anthropic API를 직접 사용)인지 그리고 실험적 베타 기능이 환경 변수를 통해 비활성화되지 않았는지 확인합니다. 타사 공급자(예: Foundry를 통한 액세스)는 글로벌 캐싱을 사용하지 않습니다.

### <a href="#543-pushing-session-variations-past-the-boundary"
class="header">5.4.3 세션 변형을 경계 너머로 밀어넣기</a>

소스 코드에는 `getSessionSpecificGuidanceSection`가 존재하는 이유(`restored-src/src/constants/prompts.ts:343-347`)를 설명하는 주의 깊게 작성된 설명이 포함되어 있습니다.

> SYSTEM_PROMPT_DYNAMIC_BOUNDARY 앞에 배치된 경우 캐시스코프:'글로벌' 접두사를 조각화하는 세션 변형 지침입니다. 여기의 각 조건은 Blake2b 접두사 해시 변형(2^N)을 곱하는 런타임 비트입니다.

이는 미묘하지만 중요한 디자인 제약 조건을 드러냅니다. **정적 영역은 세션별로 달라지는 조건부 분기를 포함할 수 없습니다**. 사용 가능한 도구 목록, 스킬 명령, 에이전트 도구 또는 기타 런타임 정보가 경계 앞에 나타나면 각 도구 조합은 서로 다른 Blake2b 접두사 해시를 생성하여 전역 캐시 변형 수가 기하급수적으로(2^N, 여기서 N은 조건부 비트 수) 증가하여 적중률을 효과적으로 0으로 줄입니다.

따라서 런타임 상태에 따른 모든 콘텐츠(도구 안내(세션 안내), 메모리 파일, 환경 정보, 언어 기본 설정)는 정적 문자열이 아닌 메모 섹션(`systemPromptSection`)으로 경계 뒤의 동적 영역에 배치됩니다.

## <a href="#55-the-three-code-paths-of-splitsyspromptprefix"
class="header">5.5 SplitSysPromptPrefix의 세 가지 코드 경로</a>

`splitSysPromptPrefix`(`restored-src/src/utils/api.ts:321-435`)는 API 요청에 대한 캐시 제어를 통해 논리 시스템 프롬프트 배열을 `SystemPromptBlock[]`로 변환하는 브리지입니다. 런타임 조건에 따라 세 가지 다른 코드 경로 중에서 선택합니다.

``` mermaid
flowchart TD
    A["splitSysPromptPrefix(systemPrompt, options)"] --> B{"shouldUseGlobalCacheScope()\n&&\nskipGlobalCacheForSystemPrompt?"}
    B -->|"Yes (MCP tools present)"| C["Path 1: MCP Downgrade"]
    B -->|"No"| D{"shouldUseGlobalCacheScope()?"}
    D -->|"Yes"| E{"Boundary marker\nexists?"}
    D -->|"No"| G["Path 3: Default org cache"]
    E -->|"Yes"| F["Path 2: Global cache + boundary"]
    E -->|"No"| G

    C --> C1["attribution → null\nprefix → org\nrest → org"]
    C1 --> C2["Up to 3 blocks\nskip boundary marker"]

    F --> F1["attribution → null\nprefix → null\nstatic → global\ndynamic → null"]
    F1 --> F2["Up to 4 blocks"]

    G --> G1["attribution → null\nprefix → org\nrest → org"]
    G1 --> G2["Up to 3 blocks"]

    style C fill:#f9d,stroke:#333
    style F fill:#9df,stroke:#333
    style G fill:#dfd,stroke:#333
```

**그림 5-3: SplitSysPromptPrefix 3경로 순서도.** 전역 캐시 기능과 MCP 도구 존재에 따라 이 기능은 다양한 캐시 전략을 선택합니다.

### <a href="#551-path-1-mcp-downgrade-path" class="header">5.5.1 경로 1: MCP 다운그레이드 경로</a>

**트리거 조건:** `shouldUseGlobalCacheScope() === true` 및 `options.skipGlobalCacheForSystemPrompt === true`

MCP 도구가 세션에 있는 경우 도구 스키마 자체는 전역적으로 캐시할 수 없는 사용자 수준 동적 콘텐츠입니다. 이 경우 시스템 프롬프트의 정적 영역이 전역적으로 캐시될 수 있더라도 도구 스키마가 있으면 전역 캐싱의 실제 이점이 크게 줄어듭니다. 따라서 `splitSysPromptPrefix`는 **조직 수준 캐싱으로 다운그레이드**하기로 선택합니다.

``` typescript
// Path 1 core logic (restored-src/src/utils/api.ts:332-359)
for (const prompt of systemPrompt) {
  if (!prompt) continue
  if (prompt === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue // skip boundary
  if (prompt.startsWith('x-anthropic-billing-header')) {
    attributionHeader = prompt
  } else if (CLI_SYSPROMPT_PREFIXES.has(prompt)) {
    systemPromptPrefix = prompt
  } else {
    rest.push(prompt)
  }
}
// Result: [attribution:null, prefix:org, rest:org]
```

경계 마커는 직접 건너뛰고(`continue`) 특수 블록이 아닌 모든 블록은 단일 `org` 수준 캐시 블록으로 병합됩니다. `skipGlobalCacheForSystemPrompt` 값은 `claude.ts`(`restored-src/src/services/api/claude.ts:1210-1214`)의 확인에서 나옵니다. MCP 도구가 실제로 요청에 렌더링되는 경우에만 다운그레이드가 트리거됩니다(`defer_loading`가 아님).

### <a href="#552-path-2-global-cache--boundary-path" class="header">5.5.2 경로 2: 글로벌 캐시 + 경계 경로</a>

**트리거 조건:** `shouldUseGlobalCacheScope() === true`, MCP에 의해 다운그레이드되지 않았으며 경계 마커가 시스템 프롬프트에 존재합니다.

이는 MCP 도구가 없는 자사 사용자를 위한 기본 경로이며 가장 높은 캐시 효율성을 제공합니다.

``` typescript
// Path 2 core logic (restored-src/src/utils/api.ts:362-409)
const boundaryIndex = systemPrompt.findIndex(
  s => s === SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
)
if (boundaryIndex !== -1) {
  for (let i = 0; i < systemPrompt.length; i++) {
    const block = systemPrompt[i]
    if (!block || block === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue
    if (block.startsWith('x-anthropic-billing-header')) {
      attributionHeader = block
    } else if (CLI_SYSPROMPT_PREFIXES.has(block)) {
      systemPromptPrefix = block
    } else if (i < boundaryIndex) {
      staticBlocks.push(block)        // before boundary → static
    } else {
      dynamicBlocks.push(block)       // after boundary → dynamic
    }
  }
  // Result: [attribution:null, prefix:null, static:global, dynamic:null]
}
```

이 경로는 최대 **4개의 텍스트 블록**을 생성합니다.

<div class="table-wrapper">

| 차단하다 | 캐시 범위 | 설명 |
|----|----|----|
| 속성 헤더 | `null` | 캐시되지 않은 청구 속성 헤더 |
| 시스템 프롬프트 접두사 | `null` | 캐시되지 않은 CLI 접두사 식별자 |
| 정적 콘텐츠 | `'global'` | 조직 전반에 걸쳐 캐시 가능한 핵심 지침 |
| 동적 콘텐츠 | `null` | 캐시되지 않은 세션별 콘텐츠 |

</div>

`scope: 'global'`를 사용하는 정적 블록은 Anthropic API 백엔드가 모든 Claude Code 사용자 간에 이 캐시 접두어를 공유할 수 있음을 의미합니다. 정적 영역에는 일반적으로 ID 소개 및 행동 지침에 대한 수만 개의 토큰이 포함되어 있다는 점을 고려하면 높은 동시성에서 이 캐시의 계산 절감 효과는 엄청납니다.

### <a href="#553-path-3-default-org-cache-path" class="header">5.5.3 경로 3: 기본 조직 캐시 경로</a>

**트리거 조건:** 글로벌 캐시 기능이 활성화되지 않았거나(타사 제공업체) 경계 표시가 존재하지 않습니다.

가장 간단한 대체 경로는 다음과 같습니다.

``` typescript
// Path 3 core logic (restored-src/src/utils/api.ts:411-434)
for (const block of systemPrompt) {
  if (!block) continue
  if (block.startsWith('x-anthropic-billing-header')) {
    attributionHeader = block
  } else if (CLI_SYSPROMPT_PREFIXES.has(block)) {
    systemPromptPrefix = block
  } else {
    rest.push(block)
  }
}
// Result: [attribution:null, prefix:org, rest:org]
```

특별하지 않은 모든 콘텐츠는 `org` 수준 캐싱을 사용하여 단일 블록으로 병합됩니다. 이는 제3자 공급자의 경우 충분합니다. 동일한 조직 내의 사용자는 동일한 시스템 프롬프트 접두사를 공유하며 여전히 조직 수준 캐시 적중을 달성할 수 있습니다.

### <a href="#554-from-splitsyspromptprefix-to-api-request"
class="header">5.5.4 SplitSysPromptPrefix에서 API 요청으로</a>

`buildSystemPromptBlocks`(`restored-src/src/services/api/claude.ts:3213-3237`)는 `splitSysPromptPrefix`의 직접적인 소비자입니다. `SystemPromptBlock[]`를 Anthropic API에서 예상하는 `TextBlockParam[]` 형식으로 변환합니다.

``` typescript
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: { skipGlobalCacheForSystemPrompt?: boolean; querySource?: QuerySource },
): TextBlockParam[] {
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(block => ({
    type: 'text' as const,
    text: block.text,
    ...(enablePromptCaching && block.cacheScope !== null && {
      cache_control: getCacheControl({
        scope: block.cacheScope,
        querySource: options?.querySource,
      }),
    }),
  }))
}
```

매핑 규칙은 간단합니다. `null` `cacheScope`가 아닌 블록은 `cache_control` 속성을 받습니다. `null` 블록은 그렇지 않습니다. API 백엔드는 `cache_control.scope`(`'global'` 또는 `'org'`) 값을 사용하여 캐싱 공유 범위를 결정합니다.

## <a href="#56-system-prompt-build-flow" class="header">5.6 시스템 프롬프트 빌드 흐름</a>

### <a href="#561-the-complete-flow-of-getsystemprompt" class="header">5.6.1 getSystemPrompt의 전체 흐름</a>

`getSystemPrompt`(`restored-src/src/constants/prompts.ts:444-577`)는 시스템 프롬프트를 구축하기 위한 주요 진입점입니다. 도구 목록, 모델 이름, 추가 작업 디렉터리 및 MCP 클라이언트 목록을 받아들이고 `string[]` 배열을 반환합니다.

``` mermaid
flowchart TD
    A["getSystemPrompt(tools, model, dirs, mcpClients)"] --> B{"CLAUDE_CODE_SIMPLE?"}
    B -->|"Yes"| C["Return minimal prompt\n(identity + CWD + date only)"]
    B -->|"No"| D["Parallel computation:\nskillToolCommands\noutputStyleConfig\nenvInfo"]
    D --> E{"Proactive mode?"}
    E -->|"Yes"| F["Return autonomous agent prompt\n(slimmed, no section registry)"]
    E -->|"No"| G["Build dynamic section array\n(systemPromptSection ×N)"]
    G --> H["resolveSystemPromptSections\n(parallel resolution, memoization)"]
    H --> I["Assemble final array"]

    I --> J["Static zone:\nintro, system, tasks,\nactions, tools, tone,\nefficiency"]
    J --> K["BOUNDARY MARKER\n(conditionally inserted)"]
    K --> L["Dynamic zone:\nsession_guidance, memory,\nenv_info, language,\noutput_style, mcp, ..."]
    L --> M["filter(s => s !== null)"]
    M --> N["Return string[]"]
```

**그림 5-4: 시스템 프롬프트 빌드 흐름도.** 진입점에서 최종 반환까지의 전체 데이터 흐름.

빌드 프로세스에는 세 가지 빠른 경로가 있습니다.

1. **CLAUDE_CODE_SIMPLE 모드**: `CLAUDE_CODE_SIMPLE` 환경 변수가 true인 경우 ID, 작업 디렉터리 및 날짜만 포함된 최소 프롬프트를 직접 반환합니다. 이는 주로 테스트 및 디버깅 시나리오를 위한 것입니다.
2. **사전 모드**: `PROACTIVE` 또는 `KAIROS` 기능 플래그가 활성화되어 활성화되면 슬림형 자율 에이전트 프롬프트가 반환됩니다. 이 경로는 **레지스트리 섹션을 우회**하고 문자열 배열을 직접 어셈블합니다.
3. **표준 경로**: 전체 섹션 등록, 해결, 정적/동적 파티셔닝 흐름을 진행합니다.

### <a href="#562-section-registry-overview" class="header">5.6.2 섹션 레지스트리 개요</a>

표준 경로(`restored-src/src/constants/prompts.ts:491-555`)에 등록된 동적 섹션은 동적 영역의 모든 콘텐츠를 구성합니다.

<div class="table-wrapper">

| 섹션 이름 | 유형 | 콘텐츠 설명 |
|----|----|----|
| `session_guidance` | 메모됨 | 도구 안내, 상호 작용 모드 힌트 |
| `memory` | 메모됨 | CLAUDE.md 메모리 파일 내용(6장 참조) |
| `ant_model_override` | 메모됨 | 인류 내부 모델 재정의 지침 |
| `env_info_simple` | 메모됨 | 작업 디렉터리, OS, Shell 및 기타 환경 정보 |
| `language` | 메모됨 | 언어 기본 설정 |
| `output_style` | 메모됨 | 출력 스타일 구성 |
| `mcp_instructions` | **휘발성 물질** | MCP 서버 지침(대화 중에 변경될 수 있음) |
| `scratchpad` | 메모됨 | 스크래치패드 지침 |
| `frc` | 메모됨 | 함수 결과 정리 지침 |
| `summarize_tool_results` | 메모됨 | 도구 결과 요약 지침 |
| `numeric_length_anchors` | 메모됨 | 길이 앵커(Ant 내부 전용) |
| `token_budget` | 메모됨 | 토큰 예산 지침(기능 제한) |
| `brief` | 메모됨 | 브리핑 섹션(KAIROS 기능별) |

</div>

유일한 `DANGEROUS_uncachedSystemPromptSection`는 `mcp_instructions`입니다. 이는 섹션 5.3의 분석과 일치합니다. 다른 모든 섹션은 메모되어 세션 수명 주기 내에서 한 번 계산되며 그 이후에는 변경되지 않습니다.

## <a href="#57-priority-of-buildeffectivesystemprompt" class="header">5.7 buildEffectiveSystemPrompt의 우선순위</a>

`getSystemPrompt`는 "기본 시스템 프롬프트"를 구축합니다. 그러나 실제 호출에서는 여러 소스가 이 기본값을 재정의하거나 보완할 수 있습니다. `buildEffectiveSystemPrompt`(`restored-src/src/utils/systemPrompt.ts:41-123`)는 우선순위에 따라 최종 효과적인 프롬프트를 합성하는 역할을 담당합니다.

### <a href="#571-priority-chain" class="header">5.7.1 우선순위 체인</a>

우선순위 0(가장 높음): ​​overrideSystemPrompt ↓ 없는 경우 우선순위 1: 코디네이터 시스템 프롬프트 ↓ 없는 경우 우선순위 2: 에이전트 시스템 프롬프트 ↓ 없는 경우 우선순위 3: customSystemPrompt(--system-prompt) ↓ 없는 경우 우선순위 4(최하위): defaultSystemPrompt(getSystemPrompt 출력)

    + AppendSystemPrompt는 항상 끝에 추가됩니다(재정의 제외).

### <a href="#572-behavior-at-each-priority-level" class="header">5.7.2 각 우선순위 수준에서의 행동</a>

**재정의:** `overrideSystemPrompt`가 존재하는 경우(예: 루프 모드에 의해 설정된 루프 명령) **`appendSystemPrompt`**(`restored-src/src/utils/systemPrompt.ts:56-58`)를 포함한 다른 모든 소스를 무시하고 해당 문자열만 포함하는 배열을 직접 반환합니다.

``` typescript
if (overrideSystemPrompt) {
  return asSystemPrompt([overrideSystemPrompt])
}
```

**코디네이터:** `COORDINATOR_MODE` 기능 플래그가 활성화되고 `CLAUDE_CODE_COORDINATOR_MODE` 환경 변수가 true인 경우 코디네이터별 시스템 프롬프트가 기본값을 대체합니다. 순환 종속성을 피하기 위해 `coordinatorMode` 모듈의 지연 가져오기(`restored-src/src/utils/systemPrompt.ts:62-75`)에 유의하세요.

**에이전트:** `mainThreadAgentDefinition`가 설정된 경우 사전 예방 모드가 활성화되었는지 여부에 따라 동작이 달라집니다.

- **사전 모드**: 상담원 지침은 기본 프롬프트를 바꾸는 것이 아니라 끝에 **추가**됩니다. 이는 사전 모드의 기본 프롬프트가 이미 슬림화된 자율 에이전트 ID이기 때문입니다. 에이전트 정의는 팀원 모드의 동작과 일치하여 상단에 도메인 지침을 추가할 뿐입니다.
- **일반 모드**: 상담원 지침이 기본 프롬프트를 **교체**합니다.

**사용자 정의:** `--system-prompt` 명령줄 인수로 지정된 프롬프트가 기본 프롬프트를 대체합니다.

**기본값:** `getSystemPrompt`의 전체 출력입니다.

**추가:** `appendSystemPrompt`가 설정된 경우 최종 배열의 끝에 추가됩니다. 이는 시스템 프롬프트를 완전히 무시하지 않고 추가 지침을 주입하는 메커니즘을 제공합니다.

### <a href="#573-final-synthesis-logic" class="header">5.7.3 최종 합성 논리</a>

재정의 또는 코디네이터가 없는 경우 핵심 3방향 선택 논리는 다음과 같습니다(`restored-src/src/utils/systemPrompt.ts:115-122`).

``` typescript
return asSystemPrompt([
  ...(agentSystemPrompt
    ? [agentSystemPrompt]
    : customSystemPrompt
      ? [customSystemPrompt]
      : defaultSystemPrompt),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

이것은 깨끗한 삼항 체인입니다: Agent \> Custom \> Default 및 선택적 추가. `asSystemPrompt`는 반환 값의 유형 안전성을 보장하는 브랜드 유형 변환입니다(유형 시스템에 대한 논의는 8장 참조).

## <a
href="#58-cache-optimization-contract-design-constraints-and-pitfalls"
class="header">5.8 캐시 최적화 계약: 설계 제약 및 함정</a>

시스템 프롬프트 아키텍처는 암시적 **캐시 최적화 계약**을 설정합니다. 이 계약을 위반하면 캐시 적중률이 급락하게 됩니다. 소스 코드에서 추출된 주요 제약 조건은 다음과 같습니다.

### <a
href="#constraint-1-the-static-zone-must-not-contain-session-variables"
class="header">제약 조건 1: 정적 영역에는 세션 변수가 포함되어서는 안 됩니다.</a>

섹션 5.4.3에서 설명한 것처럼 경계 앞의 모든 조건 분기는 해시 변형의 수를 기하급수적으로 증가시킵니다. PR \#24490 및 \#24171에는 이러한 유형의 버그가 문서화되어 있습니다. 개발자가 실수로 정적 영역에 `if (hasAgentTool)` 조건을 배치하여 전역 캐시 적중률이 95%에서 10% 미만으로 급락했습니다.

### <a
href="#constraint-2-dangerous-sections-must-have-sufficient-justification"
class="header">제약 2: 위험한 섹션에는 충분한 근거가 있어야 합니다.</a>

`DANGEROUS_uncachedSystemPromptSection`의 모든 사용은 코드 검토에서 면밀히 조사됩니다. `reason` 매개변수는 런타임에 사용되지 않지만(매개변수 이름의 `_` 접두사 참고: `_reason`) PR 검토를 위한 기준점 역할을 합니다. 검토자는 정당성이 충분한지, 메모된 섹션으로 다운그레이드할 수 있는 대안이 있는지 확인합니다.

### <a href="#constraint-3-mcp-tools-trigger-global-cache-downgrade"
class="header">제약 조건 3: MCP 도구가 글로벌 캐시 다운그레이드를 트리거합니다.</a>

MCP 도구가 있는 경우 `splitSysPromptPrefix`는 자동으로 조직 수준 캐싱으로 다운그레이드됩니다. 이 결정은 엔지니어링 판단을 기반으로 합니다. MCP 도구 스키마는 사용자 수준 동적 콘텐츠이며 시스템 프롬프트의 정적 영역이 전역적으로 캐시될 수 있더라도 도구 스키마 블록이 있다는 것은 API 요청에 전역적으로 캐시할 수 없는 큰 블록이 이미 포함되어 있음을 의미합니다. 시스템 프롬프트에 대한 전역 캐싱의 한계 이점은 추가적인 복잡성을 정당화하기에 충분하지 않습니다.

### <a
href="#constraint-4-the-boundary-marker-position-is-an-architectural-invariant"
class="header">제약 조건 4: 경계 표시 위치는 건축학적 불변성입니다.</a>

소스 코드 주석은 무뚝뚝합니다(`restored-src/src/constants/prompts.ts:572`):

// === 경계 마커 - 이동하거나 제거하지 마세요 ===

경계 표시를 이동하거나 삭제하는 것은 코드 변경이 아닙니다. 모든 자사 사용자의 캐싱 동작을 변경하는 아키텍처 변경입니다.

## <a href="#58-pattern-extraction" class="header">5.8 패턴 추출</a>

시스템 프롬프트 아키텍처에서 다음과 같은 재사용 가능한 엔지니어링 패턴을 추출할 수 있습니다.

### <a href="#pattern-1-sectioned-memoization" class="header">패턴 1: 구분된 메모</a>

- **문제 해결:** 큰 프롬프트에서 일부 콘텐츠는 정적이고 일부 콘텐츠는 동적입니다. 모든 것을 다시 계산하면 리소스가 낭비됩니다.

- **해결책:** 프롬프트를 명확한 캐시 전략(메모 vs. 휘발성)을 사용하는 독립적인 섹션으로 나눕니다. 휘발성 유형(`DANGEROUS_` 접두사 + 필수 `reason`)에 대한 API 마찰을 추가하여 팩토리 기능을 통해 두 가지 유형을 구별합니다.

- **전제 조건:** 캐시 맵을 보유하는 전역 상태 관리자와 잘 정의된 캐시 무효화 타이밍(예: `/clear`, `/compact`)이 필요합니다.

- **코드 템플릿:**

memoizedSection(name, ComputeFn) → 첫 번째 계산 후 캐시됨 휘발성Section(name, ComputeFn, 이유) → 매 턴마다 다시 계산됨, 이유가 필요함.ResolveAll(sections) → Promise.all 병렬 해결

### <a href="#pattern-2-cache-boundary-partitioning" class="header">패턴 2: 캐시 경계 분할</a>

- **문제 해결:** 여러 사용자가 공유하는 프롬프트 접두어에는 전역 캐싱이 필요하지만 세션별 콘텐츠로 인해 캐시 적중률이 손상됩니다.
- **해결책:** 프롬프트 배열에 명시적인 경계 마커를 삽입하여 콘텐츠를 "전역적으로 캐시 가능한 정적 영역"과 "세션별 동적 영역"으로 나눕니다. 다운스트림 기능은 경계 위치에 따라 다른 `cacheScope` 값을 할당합니다.
- **전제 조건:** API 백엔드는 다중 레벨 캐시 범위(예: `global` / `org` ​​/ `null`)를 지원합니다.
- **주요 제약 조건:** 경계 앞의 정적 영역에는 세션별로 달라지는 조건부 분기가 포함되어서는 안 됩니다. 그렇지 않으면 해시 변형의 수가 기하급수적으로 늘어납니다.

### <a href="#pattern-3-priority-chain-composition" class="header">패턴 3: 우선순위 체인 구성</a>

- **문제 해결:** 여러 소스(사용자 정의, 에이전트 모드, 코디네이터 모드, 기본값)는 모두 명확한 우선순위가 필요한 시스템 프롬프트를 제공할 수 있습니다.
- **해결책:** 선형 우선 순위 체인(\> 코디네이터 \> 에이전트 \> 사용자 정의 \> 기본값 재정의)과 항상 추가되는 `append` 메커니즘을 정의합니다. 선형 가독성을 유지하려면 삼항 체인을 사용하세요.
- **전제 조건:** 모든 우선 순위 소스에 대한 통합 입력 인터페이스(모두 `string | string[]`).

## <a href="#59-what-users-can-do" class="header">5.9 사용자가 할 수 있는 일</a>

이 장에서 분석된 시스템 프롬프트 아키텍처를 기반으로 독자가 자신의 AI 에이전트 프로젝트에 직접 적용할 수 있는 권장 사항은 다음과 같습니다.

1. **프롬프트에 대한 섹션 레지스트리를 구축하세요.** 시스템 프롬프트를 단일 문자열로 하드코딩하지 마세요. 이를 독립적인 명명된 섹션으로 분할하고 각 섹션에는 캐시 가능 여부에 대한 주석이 추가됩니다. 이점은 캐시 효율성뿐 아니라 유지 관리성입니다. 동작 지시어를 수정해야 할 경우 방대한 문자열을 검색하는 대신 해당 섹션을 정확하게 찾을 수 있습니다.

2. **휘발성 섹션에 대한 API 마찰을 추가합니다.** 프롬프트 콘텐츠의 일부를 매 턴마다 다시 계산해야 하는 경우(예: 동적 도구 목록, 실시간 상태 정보) `DANGEROUS_uncachedSystemPromptSection`의 설계를 따르십시오. 호출자에게 턴별 재계산이 필요한 이유를 제공하도록 요구합니다. 이러한 마찰은 코드 검토에서 특히 중요합니다. 이로 인해 개발자는 콘텐츠 최신성과 비교하여 캐시 효율성을 명시적으로 평가해야 합니다.

3. **캐시 경계를 넘어서 세션 변수를 푸시합니다.** 사용하는 API가 프롬프트 캐싱을 지원하는 경우 프롬프트의 접두사 부분(캐시 키가 계산되는 범위)에 사용자, 세션 또는 런타임 상태에 따라 달라지는 콘텐츠가 포함되지 않는지 확인하세요. Claude Code의 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 마커는 이 전략을 직접 구현한 것입니다.

4. **명확한 프롬프트 우선순위 체인을 정의합니다.** 시스템이 여러 작동 모드(자율 에이전트, 코디네이터, 사용자 정의 등)를 지원하는 경우 각 모드의 프롬프트 소스에 대해 명시적인 우선순위를 정의합니다. 다양한 소스의 프롬프트를 "병합"하지 마세요. "교체" 의미 체계를 사용하는 것이 더 안전하고 예측 가능합니다.

5. **캐시 적중률을 모니터링합니다.** 시스템 프롬프트 아키텍처의 값은 캐시 적중률에 완전히 반영됩니다. 캐시 적중률이 갑자기 떨어지면 정적 영역에 새로운 조건 분기가 도입되었는지 확인하세요. 이는 Claude Code 팀이 PR \#24490에서 직면한 함정입니다.

## <a href="#510-summary" class="header">5.10 요약</a>

시스템 프롬프트 아키텍처는 Claude Code의 "보이지 않지만 어디에나 존재하는" 인프라입니다. 이 디자인은 세 가지 핵심 원칙을 구현합니다.

1. **섹션 구성**: `systemPromptSection` 레지스트리를 통해 프롬프트는 각각 명확한 이름, 컴퓨팅 기능 및 캐시 전략이 포함된 독립적이고 메모 가능한 섹션으로 분해됩니다.
2. **경계 분할**: `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 마커는 콘텐츠를 전체적으로 캐시 가능한 정적 영역과 세션별 동적 영역으로 나누고, `splitSysPromptPrefix`의 세 가지 경로는 런타임 조건에 따라 최적의 캐시 전략을 선택합니다.
3. **우선순위 합성**: `buildEffectiveSystemPrompt`는 선형 코드 가독성을 유지하면서 명확한 5단계 우선순위 체인(재정의 \> 코디네이터 \> 에이전트 \> 사용자 정의 \> 기본값 + 추가)을 통해 여러 작동 모드를 지원합니다.

이 아키텍처의 "성공 기준"은 기능적 정확성이 아닙니다. 전체 시스템 프롬프트를 단일 문자열로 하드코딩하더라도 기능적으로는 완벽하게 작동합니다. 그 가치는 **비용 효율성**에 있습니다. 신중한 캐시 계층 설계를 통해 매일 수백만 건의 API 호출에서 막대한 프롬프트 처리 오버헤드가 절약됩니다. 다음 장에서는 시스템 프롬프트 아키텍처에 대한 주요 입력, 즉 CLAUDE.md 메모리 파일이 로드되고 주입되는 방법에 대해 논의합니다(6장 참조).
