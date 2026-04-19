# <a href="#chapter-28-where-claude-code-falls-short-and-what-you-can-fix"
class="header">28장: 클로드 코드의 부족한 점(그리고 고칠 수 있는 점)</a>

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

앞의 세 장에서는 엔지니어링 원칙, 컨텍스트 관리 전략, 프로덕션급 코딩 패턴 등 Claude Code의 탁월한 디자인을 소개했습니다. 그러나 진지한 기술적 분석은 "무엇이 옳았는가"만을 논의할 수는 없으며 "어디가 부족한지"를 객관적으로 조사해야 합니다.

이 장에서는 소스 코드에서 관찰할 수 있는 5가지 디자인 단점을 나열합니다. 각 단점은 **문제 설명**(무엇인지), **소스 코드 증거**(문제인 이유), **개선 제안**(무엇을 할 수 있는지)의 세 부분으로 구성됩니다.

강조해야 할 점은 이러한 분석은 전적으로 엔지니어링 설계 수준에 있으며 Anthropic 팀의 능력에 대한 평가를 포함하지 않는다는 것입니다. 모든 "단점"은 특정 엔지니어링 상충관계 내에서 합리적인 선택입니다. 이러한 선택에는 단순히 관찰 가능한 비용이 있습니다.

------------------------------------------------------------------------

## <a href="#source-code-analysis" class="header">소스 코드 분석</a>

### <a
href="#281-shortcoming-one-cache-fragility--scattered-injection-points-create-cache-break-risks"
class="header">28.1 단점 하나: 캐시 취약성 - 분산된 주입 지점으로 인해 캐시 중단 위험이 발생함</a>

#### <a href="#problem-description" class="header">문제 설명</a>

Claude Code의 프롬프트 캐싱 시스템은 **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 이전의 콘텐츠가 세션 전체에서 변경되지 않고 유지됩니다**라는 핵심 가정에 의존합니다. 그러나 여러 개의 분산된 주입 지점이 이 영역을 수정할 수 있습니다.

- `systemPromptSections.ts`의 조건부 섹션: 기능 플래그 또는 런타임 상태에 따라 포함 또는 제외
- MCP 연결/연결 끊김 이벤트: `DANGEROUS_uncachedSystemPromptSection()`는 "캐시를 중단합니다"라고 명시적으로 표시합니다.
- 도구 목록 변경: MCP 서버가 가동/중단되면 `tools` 매개변수 해시가 변경됩니다.
- GrowthBook 플래그 스위치: 원격 구성 변경으로 인해 직렬화된 도구 스키마가 변경됩니다.

#### <a href="#source-code-evidence" class="header">소스 코드 증거</a>

거의 20개 필드(`restored-src/src/services/api/promptCacheBreakDetection.ts:28-69`)를 추적해야 하는 캐시 중단 감지 시스템은 직접적인 증거입니다. 캐시가 안정적이라면 "왜 중단되었는지" 설명하는 복잡한 감지 시스템은 필요하지 않습니다.

`DANGEROUS_uncachedSystemPromptSection()`라는 이름 자체는 경고 표시입니다. 함수 이름의 `DANGEROUS` 접두사는 팀이 캐시 중단을 잘 알고 있음을 나타내지만 특정 시나리오(MCP 상태 변경)에서는 더 나은 대안이 없습니다.

에이전트 목록은 한때 시스템 프롬프트에 인라인되었으며 글로벌 `cache_creation` 토큰의 10.2%를 차지했습니다(자세한 내용은 15장 참조). 나중에 첨부 파일로 이동했지만 이는 숙련된 팀이라도 실수로 캐시 세그먼트 내에 불안정한 콘텐츠를 배치할 수 있음을 보여줍니다.

`splitSysPromptPrefix()`(`restored-src/src/utils/api.ts:321-435`)의 세 가지 코드 경로(MCP 도구 기반, 전역+경계 및 기본 조직 수준)는 "캐시 세그먼트 내에서 발생할 수 있는 다양한 변경 사항"을 처리하는 과정에서 복잡성이 완전히 파생됩니다. 소스 코드 주석은 상호 참조를 명시적으로 표시합니다.

``` typescript
// restored-src/src/constants/prompts.ts:110-112
// WARNING: Do not remove or reorder this marker without updating
// cache logic in:
// - src/utils/api.ts (splitSysPromptPrefix)
// - src/services/api/claude.ts (buildSystemPromptBlocks)
```

이러한 종류의 파일 간 `WARNING` 주석은 아키텍처 취약성의 신호입니다. 구성 요소는 명시적인 인터페이스가 아닌 암시적인 규칙을 통해 결합됩니다.

#### <a href="#improvement-suggestions" class="header">개선 제안</a>

**신속한 구축을 중앙 집중화**합니다. 분산 주입을 중앙 집중식 구성으로 변환:

1. **빌드 단계**: 모든 섹션은 중앙 기능으로 조립되며 조립 후 전체 해시가 계산됩니다.
2. **불변성 제약**: 캐시 세그먼트 콘텐츠에 대한 컴파일 시간 또는 런타임 불변성 검사를 시행합니다. 세션 중에 변경되는 모든 콘텐츠는 캐시 세그먼트 외부에 강제로 적용됩니다.
3. **변경 감사**: 커밋하기 전에 "캐시 세그먼트 내에 불안정한 콘텐츠가 추가되었는지 여부"를 자동으로 감지합니다.

------------------------------------------------------------------------

### <a
href="#282-shortcoming-two-compaction-information-loss--9-section-summary-template-cannot-preserve-all-reasoning-chains"
class="header">28.2 단점 2: 압축 정보 손실 - 9섹션 요약 템플릿이 모든 추론 체인을 보존할 수 없음</a>

#### <a href="#problem-description-1" class="header">문제 설명</a>

자동 압축(자세한 내용은 9장 참조)은 모델이 대화 요약을 생성하도록 요구하는 구조화된 프롬프트 템플릿을 사용합니다. 압축 프롬프트(`restored-src/src/services/compact/prompt.ts`)에는 다음을 포함하는 `<analysis>` 블록이 필요합니다.

``` typescript
// restored-src/src/services/compact/prompt.ts:31-44
"1. Chronologically analyze each message and section of the conversation.
    For each section thoroughly identify:
    - The user's explicit requests and intents
    - Your approach to addressing the user's requests
    - Key decisions, technical concepts and code patterns
    - Specific details like:
      - file names
      - full code snippets
      - function signatures
      ..."
```

이는 신중하게 설계된 체크리스트이지만 근본적인 한계가 있습니다. **모델의 추론 체인과 실패한 시도는 압축에서 손실됩니다**.

손실된 특정 유형의 정보:

- **실패한 접근 방식**: 모델이 접근 방식 A를 시도했지만 실패한 후 접근 방식 B를 성공적으로 사용했습니다. 압축 후 "문제 해결을 위해 사용된 접근 방식 B"만 유지되고 접근 방식 A의 실패 경험은 손실됩니다.
- **결정 맥락**: 접근 방식 A 대신 접근 방식 B를 선택한 이유는 다음과 같은 결론으로 ​​단순화됩니다.
- **정확한 참조**: 요약에서 특정 파일 경로 및 행 번호가 일반화될 수 있습니다. — "수정된 `auth/middleware.ts:42-67`"가 아닌 "인증 모듈 수정"

#### <a href="#source-code-evidence-1" class="header">소스 코드 증거</a>

압축 토큰 예산은 `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000`(`restored-src/src/services/compact/autoCompact.ts:30`)입니다. 압축률은 7:1 이상이 될 수 있습니다. 이러한 압축률에서는 정보 손실이 불가피합니다.

압축 후 파일 복원 메커니즘(`POST_COMPACT_MAX_FILES_TO_RESTORE = 5`, `restored-src/src/services/compact/compact.ts:122`)은 문제를 부분적으로 완화하지만 추론 체인이 아닌 파일 콘텐츠만 복원합니다.

`NO_TOOLS_PREAMBLE`(`restored-src/src/services/compact/prompt.ts:19-25`)의 존재는 또 다른 압축 품질 문제를 암시합니다. 모델은 때때로 압축 중에 요약 텍스트를 생성하는 대신 도구를 호출하려고 시도하므로(Sonnet 4.6에서 발생률 2.79%) 명시적인 금지가 필요합니다. 이는 압축 작업 자체가 모델에 대해 사소한 것이 아니라는 것을 의미합니다.

#### <a href="#improvement-suggestions-1" class="header">개선 제안</a>

**구조화된 정보 추출 + 계층형 압축**:

1. **구조화된 추출**: 압축 전 전용 단계를 사용하여 자연어 요약이 아닌 JSON으로 저장되는 구조화된 정보(파일 수정 목록, 실패한 접근 방식 목록, 결정 그래프)를 추출합니다.
2. **계층형 압축**: 대화를 '사실 레이어'(파일 수정, 명령 출력)와 '추론 레이어'(이런 방식으로 수행된 이유)로 나눕니다. 사실 계층은 추출 압축(직접 추출)을 사용하고, 추론 계층은 추상 압축(현재 접근 방식)을 사용합니다.
3. **실패 메모리**: "시도했지만 실패한 접근 방식" 목록을 구체적으로 보존하여 압축 후 모델이 과거 실패를 반복하는 것을 방지합니다.

------------------------------------------------------------------------

### <a
href="#283-shortcoming-three-grep-is-not-an-ast--text-search-misses-semantic-relationships"
class="header">28.3 세 번째 단점: Grep은 AST가 아닙니다. 텍스트 검색에서 의미 관계가 누락됩니다.</a>

#### <a href="#problem-description-2" class="header">문제 설명</a>

Claude Code의 코드 검색은 전적으로 GrepTool(텍스트 정규식 일치) 및 GlobTool(파일 이름 패턴 일치)을 기반으로 합니다. 이는 대부분의 시나리오에서 잘 작동하지만 **의미 수준 코드 관계**를 다룰 수는 없습니다.

- **동적 가져오기**: `require(variableName)` — 변수는 런타임 값이며 텍스트 검색에서는 이를 추적할 수 없습니다.
- **다시 내보내기**: `export { default as Foo } from './bar'` — `Foo` 정의를 검색할 때 올바르게 추적되지 않습니다.
- **문자열 참조**: 문자열로 등록된 도구 이름(`name: 'Bash'`) — 도구 사용 지점을 검색하려면 문자열과 변수 이름을 모두 검색해야 합니다.
- **유형 추론**: TypeScript의 유형 추론은 많은 변수에 명시적인 주석이 부족함을 의미합니다. 특정 유형의 사용 위치 검색이 불완전합니다.

#### <a href="#source-code-evidence-2" class="header">소스 코드 증거</a>

Claude Code의 자체 도구 목록에는 40개 이상의 도구(자세한 내용은 2장 참조)가 포함되어 있지만 AST 쿼리 도구는 없습니다. 시스템 프롬프트는 모델이 Bash의 grep 대신 Grep을 사용하도록 명시적으로 안내합니다(자세한 내용은 8장 참조). 그러나 이는 검색의 의미 수준을 높이지 않고 단지 텍스트 검색을 한 도구에서 다른 도구로 이동할 뿐입니다.

Claude Code의 자체 코드베이스(1,902 TypeScript 파일)에서 이러한 누락의 영향을 관찰할 수 있습니다. 예: 기능 플래그는 `feature('KAIROS')` 호출을 통해 사용됩니다. `KAIROS` 문자열을 검색하면 사용 지점을 찾을 수 있지만 `feature` 함수에 대한 호출을 검색하면 엄청난 노이즈와 함께 89개 플래그 모두에 대한 결과가 반환됩니다. AST 쿼리가 없으면 "`feature()`가 매개변수 값 `KAIROS`로 호출되는 위치를 찾습니다."라고 표현할 방법이 없습니다.

#### <a href="#improvement-suggestions-2" class="header">개선 제안</a>

**LSP(언어 서버 프로토콜) 통합 추가**:

1. **유형 조회**: TypeScript 언어 서버를 통해 변수의 유추된 유형을 쿼리합니다.
2. **정의로 이동**: 다시 내보내기, 유형 별칭 및 동적 가져오기의 전체 체인을 처리합니다.
3. **참조 찾기**: 유형 추론을 통한 간접 사용을 포함하여 기호의 모든 사용 위치를 찾습니다.
4. **호출 계층구조**: 함수의 호출자와 피호출자를 쿼리하여 호출 그래프를 작성합니다.

LSP 통합을 위한 인프라는 이미 소스 코드에 표시를 보여줍니다. 일부 실험적인 LSP 관련 코드 경로는 기능 플래그 분석에서 관찰할 수 있지만(자세한 내용은 23장 참조) 아직 널리 활성화되지는 않았습니다. Grep + LSP의 조합은 순수 Grep 또는 순수 LSP 단독보다 더 강력합니다. Grep은 빠른 전체 텍스트 검색 및 패턴 일치를 처리하고 LSP는 정확한 의미 쿼리를 처리합니다.

------------------------------------------------------------------------

### <a
href="#284-shortcoming-four-informing-about-truncation--acting-on-it--large-results-written-to-disk-but-the-model-may-not-re-read"
class="header">28.4 단점 4: 잘림에 대한 알림 ≠ 이에 대한 조치 - 큰 결과가 디스크에 기록되지만 모델이 다시 읽히지 않을 수 있음</a>

#### <a href="#problem-description-3" class="header">문제 설명</a>

도구 결과가 50,000자를 초과하는 경우(`DEFAULT_MAX_RESULT_SIZE_CHARS`, `restored-src/src/constants/toolLimits.ts:13`) 처리 전략은 전체 결과를 디스크에 쓰고 미리보기 메시지를 반환하는 것입니다(자세한 내용은 12장 참조).

문제는 **모델을 다시 읽을 수 없다는 것**입니다. 모델은 미리보기를 기반으로 판단합니다. 미리보기가 "충분"해 보이는 경우(예: 검색 결과의 처음 50,000자에 이미 일부 관련 결과가 포함되어 있는 경우) 모델은 전체 콘텐츠를 읽지 못할 수 있습니다. 그러나 중요한 정보가 잘림 지점을 막 넘었을 수도 있습니다.

#### <a href="#source-code-evidence-3" class="header">소스 코드 증거</a>

`restored-src/src/utils/toolResultStorage.ts`는 대규모 결과 지속성 논리를 구현합니다. 잘라낼 때 모델은 다음을 수신합니다.

[결과가 잘렸습니다. /tmp/claude-tool-result-xxx.txt에 저장된 전체 출력] [총 N개 중 처음 50000자 표시]

이는 25장의 "알리고 숨기지 마세요" 원칙을 따릅니다. 모델에 잘림이 발생했다는 알림이 전달됩니다. 그러나 "정보를 제공하는 것"과 "모범적인 행동을 보장하는 것"은 서로 다른 것입니다.

근본 원인은 **주의 경제**입니다. 모델은 모든 단계에서 다음에 무엇을 할지 결정해야 합니다. 잘린 전체 파일을 읽는다는 것은 도구 호출을 한 번 더 수행하고 몇 초를 더 기다리는 것을 의미합니다. 모델이 미리 보기가 "충분하다"고 판단하면 이 단계를 건너뜁니다. 하지만 모델이 잘림 지점 이후의 내용을 **볼 수 없기** 때문에 이러한 판단 자체가 틀릴 수도 있습니다.

#### <a href="#improvement-suggestions-3" class="header">개선 제안</a>

**스마트 미리보기 + 사전 제안**:

1. **구조화된 미리보기**: 처음 N자로 자르는 대신 요약을 추출합니다. 검색 결과의 총 일치 항목, 파일 배포, 첫 번째 및 마지막 N 일치 항목에 대한 컨텍스트
2. **관련성 힌트**: 미리보기에 "결과에 총 M개의 일치 항목이 포함되어 있으며 현재는 첫 번째 K만 표시됩니다. 특정 파일이나 패턴을 찾고 있다면 전체 콘텐츠를 보는 것이 좋습니다."를 추가하세요.
3. **자동 페이지 매김**: 잘라낼 때 디스크에 저장하고 모델이 읽혀질 때까지 기다리지 마세요. 결과에 페이지를 매기고 요청 시 모델이 계속되도록 미리보기에 페이지 매김 정보를 표시하세요.

------------------------------------------------------------------------

### <a
href="#285-shortcoming-five-feature-flag-complexity--emergent-behavior-of-89-flags"
class="header">28.5 다섯 번째 단점: 기능 플래그 복잡성 - 89개 플래그의 새로운 동작</a>

#### <a href="#problem-description-4" class="header">문제 설명</a>

Claude Code에는 두 가지 메커니즘을 통해 제어되는 89개의 기능 플래그(자세한 내용은 23장 참조)가 있습니다.

1. **빌드 타임**: `feature()` 함수는 데드 코드 제거를 통해 비활성화된 분기를 제거하여 컴파일 타임에 평가합니다.
2. **런타임**: API를 통해 가져온 GrowthBook `tengu_*` 접두사가 붙은 플래그

문제는 플래그 간의 **상호작용 효과**입니다. 89개의 이진 플래그는 이론적으로 2^89개의 조합을 생성합니다. 플래그의 10%만 상호 작용하더라도 조합 공간은 엄청납니다.

#### <a href="#source-code-evidence-4" class="header">소스 코드 증거</a>

다음은 소스 코드에서 관찰 가능한 플래그 상호 작용 예입니다.

<div class="table-wrapper">

| 플래그 A | 플래그 B | 상호 작용 |
|----|----|----|
| `KAIROS` | `PROACTIVE` | 보조자 모드와 사전 작업 모드에는 중복되는 활성화 메커니즘이 있습니다. |
| `COORDINATOR_MODE` | `TEAMMEM` | 둘 다 서로 다른 메시징 메커니즘을 사용하는 다중 에이전트 통신을 포함합니다. |
| `BRIDGE_MODE` | `DAEMON` | 브리지 모드에는 데몬 지원이 필요하지만 수명 주기 관리는 독립적입니다. |
| `FAST_MODE` | `ULTRATHINK` | 더 빠른 출력과 깊은 사고는 노력 구성에서 충돌할 수 있습니다. |

</div>

**표 28-1: 기능 플래그 상호 작용 예**

래칭 메커니즘(25장, 원칙 6 참조)은 플래그 상호 작용 복잡성을 완화하여 특정 상태를 수정하여 런타임 조합을 줄입니다. 그러나 래치 자체도 이해하기 어렵습니다. 시스템의 현재 동작은 현재 플래그 값뿐만 아니라 **세션 기록 전반에 걸친 플래그 값 변경 순서**에도 따라 달라집니다.

도구 스키마 캐싱(`getToolSchemaCache()`, 자세한 내용은 15장 참조)은 세션당 한 번씩 도구 목록을 계산하여 세션 중간 플래그 전환으로 인해 스키마가 변경되는 것을 방지하는 또 다른 완화 방법입니다. 그러나 이는 세션 중에 전환된 플래그가 기능과 제한 사항 모두 도구 목록에 영향을 미치지 않는다는 것을 의미합니다.

`promptCacheBreakDetection.ts`의 각 래치 관련 필드에는 `Tracked to verify the fix` 주석이 포함됩니다.

``` typescript
// restored-src/src/services/api/promptCacheBreakDetection.ts:47-55
/** AFK_MODE_BETA_HEADER presence — should NOT break cache anymore
 *  (sticky-on latched in claude.ts). Tracked to verify the fix. */
autoModeActive: boolean
/** Overage state flip — should NOT break cache anymore (eligibility is
 *  latched session-stable in should1hCacheTTL). Tracked to verify the fix. */
isUsingOverage: boolean
/** Cache-editing beta header presence — should NOT break cache anymore
 *  (sticky-on latched in claude.ts). Tracked to verify the fix. */
cachedMCEnabled: boolean
```

필드 3개, `should NOT break cache anymore` 인스턴스 3개, `Tracked to verify the fix` 인스턴스 3개 — 이러한 플래그의 상태 변경으로 **이전에** 캐시 중단이 발생했음을 나타내며 팀에서는 이를 하나씩 수정하고 수정 사항이 효과적인지 확인하기 위해 추적을 추가했습니다. 이는 전형적인 "두더지 잡기" 패턴입니다. 상호 작용 문제를 표시하는 체계적인 솔루션이 없으며 사례가 표면화되는 대로 수정하기만 하면 됩니다.

#### <a href="#improvement-suggestions-4" class="header">개선 제안</a>

**플래그 종속성 그래프 + 상호 배제 제약조건**:

1. **명시적 종속성 선언**: 각 플래그는 다른 플래그(`KAIROS_DREAM`는 `KAIROS`에 따라 다름)에 대한 종속성을 선언하여 컴파일 타임에 종속성 관계를 검증하는 도구를 구축합니다.
2. **상호 배제 제약**: 동시에 활성화할 수 없는 플래그 조합을 선언합니다.
3. **조합 테스트**: 최소한 모든 쌍별 조합을 포함하여 중요한 플래그 조합에 대해 자동화된 테스트를 실행합니다.
4. **플래그 상태 시각화**: 디버그 모드에서 모든 플래그 값과 래치 상태를 출력하여 이상 동작을 진단하는 데 도움을 줍니다.

------------------------------------------------------------------------

## <a href="#pattern-distillation" class="header">패턴 증류</a>

### <a href="#five-shortcomings-summary-table" class="header">5가지 단점 요약표</a>

<div class="table-wrapper">

| 결점 | 소스 코드 증거 | 개선 제안 |
|----|----|----|
| 캐시 취약성 | `promptCacheBreakDetection.ts`는 18개 필드를 추적합니다. | 중앙 집중식 구성 + 불변성 제약 |
| 압축 정보 손실 | `compact/prompt.ts` 압축률 7:1+ | 구조화된 추출 + 계층형 압축 |
| Grep은 AST가 아닙니다 | 40개 이상의 도구 중 AST 쿼리 도구 없음 | LSP 통합 |
| 잘림 알림이 충분하지 않음 | `toolResultStorage.ts` 미리보기 읽기가 보장되지 않음 | 스마트 미리보기 + 자동 페이지 매김 |
| 플래그 복잡성 | `Tracked to verify the fix` 댓글 3개 | 플래그 종속성 그래프 + 상호 배제 제약 조건 |

</div>

**표 28-2: 5가지 단점 요약**

### <a href="#three-defense-layers-and-the-five-shortcomings"
class="header">세 가지 방어 계층과 다섯 가지 단점</a>

``` mermaid
graph TD
    subgraph "Prompt Layer"
        A["Shortcoming 2: Compaction info loss<br/>Summary template limitations"]
        B["Shortcoming 4: Truncation notification<br/>insufficient<br/>Informed but model may not act"]
    end
    subgraph "Tool Layer"
        C["Shortcoming 3: Grep is not AST<br/>Text search semantic blind spots"]
    end
    subgraph "Infrastructure Layer"
        D["Shortcoming 1: Cache fragility<br/>Scattered injection points"]
        E["Shortcoming 5: Flag complexity<br/>Combinatorial explosion and whack-a-mole"]
    end

    D --> A
    D --> B
    E --> C
    E --> D
```

**그림 28-1: 3개 방어 계층에 걸친 5가지 단점 분포**

두 가지 인프라 계층 단점(캐시 취약성, 플래그 복잡성)이 가장 심각합니다. 이는 전체 시스템 동작에 영향을 미치고 수정 비용이 가장 높습니다. 프롬프트 계층의 두 가지 단점(압축 정보 손실, 자동 잘림)은 완화하기가 더 쉽습니다. 압축 템플릿이나 미리 보기 형식을 개선하는 데는 대규모 리팩터링이 필요하지 않습니다. 도구 계층의 단점(Grep은 AST가 아님)은 둘 사이에 있습니다. 즉, LSP 도구를 추가하려면 새로운 외부 종속성이 필요하지만 핵심 아키텍처는 변경되지 않습니다.

### <a href="#anti-pattern-scattered-injection" class="header">안티 패턴: 분산 주입</a>

- **문제**: 동일한 공유 상태를 수정하는 여러 개의 독립적인 주입 지점으로 인해 상태 변경을 예측할 수 없게 됩니다.
- **식별 신호**: "상태가 왜 변경되었는지" 설명하려면 복잡한 감지 시스템이 필요합니다.
- **솔루션 방향**: 중앙 집중식 구성 + 불변성 제약

### <a href="#anti-pattern-irreversible-lossy-compression"
class="header">안티 패턴: 되돌릴 수 없는 손실 압축</a>

- **문제**: 압축 후 손실된 정보는 복구할 수 없습니다.
- **식별 신호**: 압축 후 모델은 이전에 시도했지만 실패한 접근 방식을 반복합니다.
- **솔루션 방향**: 핵심 정보의 구조화된 추출, 계층형 스토리지

------------------------------------------------------------------------

## <a href="#what-you-can-do" class="header">당신이 할 수 있는 일</a>

### <a href="#what-you-can-act-on-directly" class="header">직접 조치를 취할 수 있는 사항</a>

1. **캐시 취약성**: CLAUDE.md를 통해 가능한 변수를 제어하세요. 프로젝트 CLAUDE.md를 안정적으로 유지하고 빈번한 수정을 피하세요. API 청구서에서 `cache_creation` 토큰 소비를 모니터링하세요.
2. **자동 잘림**: CLAUDE.md에 "도구 결과가 잘리면 항상 읽기 도구를 사용하여 전체 내용을 보십시오."라는 지시문을 추가합니다. 100% 따라간다고 보장할 수는 없지만 확률은 높아집니다.
3. **Grep의 제한 사항**: MCP 서버를 통해 LSP 기능을 추가합니다(자세한 내용은 22장 참조). 커뮤니티에는 이미 TypeScript LSP 및 Python LSP MCP 통합이 있습니다.

### <a href="#what-needs-awareness-but-cant-be-directly-fixed"
class="header">인식이 필요하지만 직접적으로 고칠 수 없는 것</a>

4. **다짐 정보 손실**: 모델이 이전에 긴 세션에서 시도한 접근 방식을 "잊는" 경우 수동으로 상기시킵니다. 중요한 기술 결정은 CLAUDE.md(압축되지 않음)에 기록될 수 있습니다.
5. **기능 플래그 복잡성**: 내부 아키텍처 문제이지만 이를 이해하면 Claude Code의 동작이 때때로 "일관되지 않는" 이유를 설명하는 데 도움이 됩니다. 이는 플래그 상호 작용으로 인해 발생할 수 있습니다.

------------------------------------------------------------------------

### <a href="#shortcomings-are-the-other-side-of-trade-offs"
class="header">단점은 트레이드오프의 또 다른 측면입니다</a>

<div class="table-wrapper">

| 결점 | 트레이드오프의 다른 측면 |
|----|----|
| 캐시 취약성 | 유연한 프롬프트 구성 기능 |
| 압축 정보 손실 | 200K 창 내에서 수백 차례 동안 지속적으로 작업할 수 있는 능력 |
| Grep은 AST가 아닙니다 | 외부 종속성 없음, 언어 간 보편성 |
| 잘림 알림이 충분하지 않음 | 하나의 큰 결과로 인해 컨텍스트가 쇄도하는 것을 방지 |
| 플래그 복잡성 | 신속한 반복 및 A/B 테스트 기능 |

</div>

**표 28-3: 5가지 단점과 해당 엔지니어링 상충관계**

이러한 장단점을 이해하는 것은 단순히 단점을 비판하는 것보다 더 가치가 있습니다. 귀하의 AI 에이전트 시스템에서도 동일한 선택에 직면할 수 있습니다. Claude Code의 경험은 각 옵션의 장기적인 비용을 예측하는 데 도움이 될 수 있습니다.

------------------------------------------------------------------------

## <a href="#ccs-fault-tolerance-architecture-three-layer-protection"
class="header">CC의 내결함성 아키텍처: 3계층 보호</a>

학술 문헌에서는 에이전트 시스템 내결함성을 검사점, 내구성 실행, 멱등성/보상 트랜잭션의 세 가지 계층으로 분류합니다. Claude Code는 세 가지 계층 모두에서 엔지니어링 구현을 갖고 있지만 통합 아키텍처로 제시되지 않고 이 책의 여러 장에 분산되어 있습니다.

### <a href="#layer-one-checkpointing" class="header">레이어 1: 체크포인트</a>

CC는 두 가지 차원에 따라 지속적인 체크포인트를 수행합니다.

**파일 기록 스냅샷**(`fileHistory.ts:39-52`):

``` typescript
// restored-src/src/utils/fileHistory.ts:39-52
export type FileHistorySnapshot = {
  messageId: UUID
  trackedFileBackups: Record<string, FileHistoryBackup>
  timestamp: Date
}
```

각 도구가 파일을 수정한 후 CC는 파일의 콘텐츠 해시 + 수정 시간 + 버전 번호로 스냅샷을 생성합니다. 백업은 중복 저장을 방지하기 위해 컨텐츠 주소 지정 저장 장치를 사용하여 `~/.claude/file-backups/`에 저장됩니다. 최대 100개의 스냅샷이 보존됩니다(`MAX_SNAPSHOTS = 100`).

**세션 기록 지속성**(`sessionStorage.ts`):

각 메시지는 JSONL 형식으로 `~/.claude/projects/{project-id}/sessions/{sessionId}.jsonl`에 추가됩니다. 이는 주기적으로 저장되는 것이 아니라 모든 메시지가 즉시 지속됩니다. 충돌 후 JSONL 파일은 복구 소스입니다.

### <a href="#layer-two-durable-execution-graceful-shutdown--resume"
class="header">레이어 2: 내구성 있는 실행(정상 종료 + 재개)</a>

**신호 처리**(`gracefulShutdown.ts:256-276`):

CC는 SIGINT, SIGTERM 및 SIGHUP 신호에 대한 처리기를 등록합니다. 더 영리하게는 **고아 감지**(278-296행)가 포함되어 있습니다. 30초마다 stdin/stdout TTY 유효성을 확인하고 macOS에서는 터미널이 닫힐 때(파일 설명자가 취소됨) 사전에 우아한 종료를 트리거합니다.

**정리 우선순위 순서**(`gracefulShutdown.ts:431-511`):

    1. 전체 화면 모드 종료 + 이력서 힌트 인쇄(즉시)
    2. 등록된 정리 기능 실행(2초 시간 초과, 시간 초과 시 CleanupTimeoutError 발생)
    3. SessionEnd 후크 실행(사용자 정의 정리 허용)
    4. 원격 측정 데이터 플러시(최대 500ms)
    5. 비상 안전 타이머: 최대(5초, HookTimeout + 3.5초) 후 강제 종료

**충돌 복구**: `claude --resume {sessionId}`는 JSONL 파일(`sessionRestore.ts:99-150`)에서 전체 메시지 기록, 파일 기록 스냅샷 및 속성 상태를 로드합니다. 복구된 세션은 충돌 전 상태와 일치합니다. 즉, 사용자는 중단 지점에서 작업을 계속할 수 있습니다.

### <a href="#layer-three-compensation-transactions-file-rewind"
class="header">레이어 3: 보상 거래(파일 되감기)</a>

모델이 잘못 수정된 경우 CC는 두 가지 보상 메커니즘을 제공합니다.

**SDK 되감기 제어 요청**(`controlSchemas.ts:308-315`):

``` typescript
SDKControlRewindFilesRequest {
  subtype: 'rewind_files',
  user_message_id: string,  // Revert to this message's file state
  dry_run?: boolean,        // Preview changes without executing
}
```

되감기 알고리즘(`fileHistory.ts:347-591`)은 대상 스냅샷을 찾고 파일별로 현재 상태와 스냅샷 상태를 비교합니다. 대상 버전에 파일이 없으면 삭제되고, 콘텐츠가 다르면 `~/.claude/file-backups/`에서 복원됩니다.

**압축 후 파일 복원**(`compact.ts:122-129`, 자세한 내용은 ch10 참조):

<div class="table-wrapper">

| 끊임없는 | 값 | 목적 |
|-------------------------------------|--------|--------------------------|
| `POST_COMPACT_MAX_FILES_TO_RESTORE` | 5 | 최대 5개 파일 복원 |
| `POST_COMPACT_TOKEN_BUDGET` | 50,000 | 총 복원예산 |
| `POST_COMPACT_MAX_TOKENS_PER_FILE` | 5,000 | 파일당 한도 |

</div>

복원은 액세스 시간(가장 최근에 액세스한 것부터)을 기준으로 우선순위를 지정하고, 이미 보관된 메시지에 있는 파일을 건너뛰고, FileReadTool을 사용하여 최신 콘텐츠를 다시 읽습니다.

### <a href="#three-layer-unified-view" class="header">3레이어 통합 보기</a>

``` mermaid
graph TD
    subgraph "Layer 1: Checkpointing"
        A[File History Snapshots<br/>MAX_SNAPSHOTS=100]
        B[JSONL Transcript<br/>Immediate per-message persistence]
    end
    subgraph "Layer 2: Durable Execution"
        C[Signal Handling<br/>SIGINT/SIGTERM/SIGHUP]
        D[Orphan Detection<br/>30-second TTY polling]
        E[claude --resume<br/>Full state recovery]
    end
    subgraph "Layer 3: Compensation Transactions"
        F[rewind_files<br/>SDK control request]
        G[Post-compaction restoration<br/>5 files × 5K tokens]
    end

    A --> E
    B --> E
    C --> B
    D --> C
    A --> F
    A --> G
```

**그림 28-x: CC의 3계층 내결함성 아키텍처**

### <a href="#implications-for-agent-builders" class="header">Agent Builder에 대한 시사점</a>

1. **모든 메시지를 주기적이 아닌 즉시 유지합니다**. CC는 모든 에이전트 단계가 파일 시스템을 수정할 수 있으므로 주기적인 스냅샷 대신 JSONL 추가 쓰기를 선택했습니다. 지속되지 않는 단계는 복구할 수 없습니다.
2. **체크포인트 세분성 = 사용자 메시지**. 파일 기록 스냅샷은 `messageId`에 연결되어 되감기 의미를 명확하게 만듭니다. "이 메시지에서 파일 상태로 돌아갑니다."
3. **안전 장치 타이머는 협상할 수 없습니다**. `gracefulShutdown.ts`의 안전 타이머는 모든 정리 기능이 중단되더라도 프로세스가 결국 종료되도록 보장합니다. 이는 시스템 모니터(systemd, Docker)의 상태 확인에 중요합니다.
4. **보상에는 dry_run 모드가 필요합니다**. `rewind_files` `dry_run` 매개변수를 통해 사용자는 실행을 결정하기 전에 변경 사항을 미리 볼 수 있습니다. 이는 되돌릴 수 없는 작업을 위한 필수 패턴입니다.
