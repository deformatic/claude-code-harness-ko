# <a href="#chapter-15-cache-optimization-patterns" class="header">15장: 캐시 최적화 패턴</a>

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

13장에서는 캐시 아키텍처의 방어 계층을 분석했고, 14장에서는 캐시 중단 감지 기능을 구축했습니다. 이 장은 Claude Code가 명명된 일련의 최적화 패턴을 통해 소스에서 캐시 중단을 제거하거나 줄이는 방법인 **공격**으로 이동합니다.

이러한 최적화 패턴은 한꺼번에 설계되지 않았습니다. 각각은 BigQuery를 통해 14장에 소개된 캐시 중단 감지 시스템에서 캡처한 실제 데이터에서 유래되었습니다. `tengu_prompt_cache_break` 이벤트에서 반복적으로 반복되는 특정 중단 원인이 밝혀졌을 때 엔지니어링 팀은 이를 제거하기 위한 목표 최적화 패턴을 설계했습니다.

이 장에서는 간단한 날짜 메모부터 복잡한 도구 스키마 캐싱까지 7개 이상의 명명된 캐시 최적화 패턴을 소개합니다. 각 패턴은 동일한 프레임워크를 따릅니다. **변경 소스를 식별하고, 변경의 성격을 이해하고, 동적을 정적으로 전환합니다**.

------------------------------------------------------------------------

## <a href="#pattern-summary" class="header">패턴 요약</a>

각 패턴을 살펴보기 전에 전체적인 관점은 다음과 같습니다.

<div class="table-wrapper">

| \# | 패턴 이름 | 소스 변경 | 최적화 전략 | 키 파일 | 영향 범위 |
|----|----|----|----|----|----|
| 1 | 날짜 메모 | 자정에 날짜 변경 | `memoize(getLocalISODate)` | `constants/common.ts` | 시스템 프롬프트 |
| 2 | 월별 세분성 | 날짜는 매일 변경됩니다. | 전체 날짜 대신 "YYYY월"을 사용하세요. | `constants/common.ts` | 도구 프롬프트 |
| 3 | 첨부 파일로 에이전트 목록 | 에이전트 목록이 동적으로 변경됩니다. | 도구 설명에서 메시지 첨부로 이동 | `tools/AgentTool/prompt.ts` | 도구 스키마(10.2% 캐시_생성) |
| 4 | 스킬 목록 예산 | 스킬 수 증가 | 컨텍스트 창의 1%로 제한 | `tools/SkillTool/prompt.ts` | 도구 스키마 |
| 5 | \$TMPDIR 자리 표시자 | 경로에 포함된 사용자 UID | `$TMPDIR`로 교체 | `tools/BashTool/prompt.ts` | 도구 프롬프트 / 글로벌 캐시 |
| 6 | 조건부 단락 생략 | 기능 플래그 변경 프롬프트 | 추가보다는 조건부 생략 | 다양한 시스템 프롬프트 | 시스템 프롬프트 접두사 |
| 7 | 도구 스키마 캐시 | GrowthBook 플립/동적 콘텐츠 | 세션 수준 맵 캐시 | `utils/toolSchemaCache.ts` | 모든 도구 스키마 |

</div>

**표 15-1: 7+ 캐시 최적화 패턴 요약**

------------------------------------------------------------------------

## <a href="#151-pattern-one-date-memoization--getsessionstartdate"
class="header">15.1 패턴 1: 날짜 메모 — getSessionStartDate()</a>

### <a href="#the-problem" class="header">문제</a>

Claude Code의 시스템 프롬프트에는 모델이 시간적 맥락을 이해하는 데 도움이 되는 현재 날짜(`currentDate`)가 포함되어 있습니다. 날짜는 `getLocalISODate()` 함수를 통해 얻습니다.

``` typescript
// constants/common.ts:4-15
export function getLocalISODate(): string {
  if (process.env.CLAUDE_CODE_OVERRIDE_DATE) {
    return process.env.CLAUDE_CODE_OVERRIDE_DATE
  }

  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
```

문제는 **자정 교차**에 있습니다. 사용자가 23시 59분에 요청을 시작하면 시스템 프롬프트에 `2026-04-01`가 포함됩니다. 사용자가 00:01에 다음 요청을 시작하면 날짜는 `2026-04-02`가 됩니다. 이 단일 문자 변경은 전체 시스템 프롬프트 접두사 캐시를 파괴하기에 충분합니다. 약 11,000개의 토큰을 다시 계산해야 합니다.

### <a href="#the-solution" class="header">해결책</a>

``` typescript
// constants/common.ts:24
export const getSessionStartDate = memoize(getLocalISODate)
```

`getSessionStartDate`는 `getLocalISODate`를 lodash의 `memoize`로 래핑합니다. 이 함수는 첫 번째 호출에서 날짜를 캡처하고 실제 날짜가 변경되었는지 여부에 관계없이 이후 영원히 동일한 값을 반환합니다.

소스 주석(17-23행)에서는 절충안을 자세히 설명합니다.

``` typescript
// constants/common.ts:17-23
// Memoized for prompt-cache stability — captures the date once at session start.
// The main interactive path gets this behavior via memoize(getUserContext) in
// context.ts; simple mode (--bare) calls getSystemPrompt per-request and needs
// an explicit memoized date to avoid busting the cached prefix at midnight.
// When midnight rolls over, getDateChangeAttachments appends the new date at
// the tail (though simple mode disables attachments, so the trade-off there is:
// stale date after midnight vs. ~entire-conversation cache bust — stale wins).
```

### <a href="#design-trade-off" class="header">디자인 트레이드오프</a>

**오래된 날짜와 전체 캐시 무효**라는 절충안이 분명합니다. 오래된 날짜를 선택하는 것은 다음과 같은 이유로 정당화됩니다.

1. 대부분의 프로그래밍 작업에서는 날짜 정보가 중요하지 않습니다.
2. 자정이 되면 `getDateChangeAttachments`는 메시지 끝 부분에 새 날짜를 추가합니다. 이는 접두사 캐시에 영향을 주지 않습니다.
3. 단순 모드(`--bare`)는 첨부 메커니즘을 비활성화하므로 소스에서 메모가 이루어져야 합니다.

### <a href="#impact" class="header">영향</a>

이 단일 라인 최적화는 하루에 하나의 전체 접두사 캐시 버스트를 제거합니다. 자정에 작업하는 사용자의 경우 캐시 생성 비용에서 약 11,000개의 토큰이 절약됩니다.

------------------------------------------------------------------------

## <a href="#152-pattern-two-monthly-granularity--getlocalmonthyear"
class="header">15.2 패턴 2: 월별 세분성 — getLocalMonthYear()</a>

### <a href="#the-problem-1" class="header">문제</a>

날짜 메모이제이션은 시스템 프롬프트의 자정 교차 문제를 해결하지만 도구 프롬프트에도 시간 정보가 필요합니다. 도구 프롬프트에서 전체 날짜(`YYYY-MM-DD`)를 사용하는 경우 자정마다 해당 날짜가 포함된 도구의 스키마 캐시가 무효화됩니다. 도구 스키마는 API 요청 앞쪽에 위치하므로 해당 변경 사항은 시스템 프롬프트 변경보다 더 파괴적입니다.

### <a href="#the-solution-1" class="header">해결책</a>

``` typescript
// constants/common.ts:28-33
export function getLocalMonthYear(): string {
  const date = process.env.CLAUDE_CODE_OVERRIDE_DATE
    ? new Date(process.env.CLAUDE_CODE_OVERRIDE_DATE)
    : new Date()
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' })
}
```

`getLocalMonthYear()`는 전체 날짜 대신 "YYYY월" 형식(예: "2026년 4월")을 반환합니다. **변경 빈도가 일일에서 월간으로 낮아졌습니다.**

주석(27행)은 설계 의도를 설명합니다.

// 사용자의 현지 시간대로 "YYYY월"(예: "2026년 2월")을 반환합니다. // 매일이 아닌 매월 변경됩니다. 캐시 무효화를 최소화하기 위해 도구 프롬프트에 사용됩니다.

### <a href="#division-of-two-time-precisions" class="header">2시간 정밀도의 나눗셈</a>

<div class="table-wrapper">

| 사용 상황 | 기능 | 정도 | 빈도 변경 | 위치 |
|----|----|----|----|----|
| 시스템 프롬프트 | `getSessionStartDate()` | 낮 | 세션당 한 번 | 시스템 프롬프트 |
| 도구 프롬프트 | `getLocalMonthYear()` | 월 | 한 달에 한 번 | 도구 스키마 |

</div>

이 구분은 기본 원칙을 반영합니다. **콘텐츠가 API 요청의 맨 앞에 가까울수록 변경 빈도는 낮아져야 합니다**.

------------------------------------------------------------------------

## <a
href="#153-pattern-three-agent-list-moved-from-tool-description-to-message-attachment"
class="header">15.3 패턴 3: 도구 설명에서 메시지 첨부 파일로 이동된 에이전트 목록</a>

### <a href="#the-problem-2" class="header">문제</a>

AgentTool의 도구 설명에는 사용 가능한 에이전트 목록(각 에이전트의 이름, 유형 및 설명)이 포함되어 있습니다. 이 목록은 동적입니다. MCP 서버 비동기 연결은 새 에이전트를 가져오고, `/reload-plugins`는 플러그인 목록을 새로 고치고, 권한 모드 변경은 사용 가능한 에이전트 세트를 변경합니다.

목록이 변경될 때마다 AgentTool의 도구 스키마가 변경되어 전체 도구 스키마 배열의 캐시가 무효화됩니다. 도구 스키마는 API 요청의 시스템 프롬프트 뒤에 위치합니다. 변경 사항은 자체 캐시뿐만 아니라 모든 다운스트림 메시지 캐시도 무효화합니다.

소스 주석(`tools/AgentTool/prompt.ts`, 50~57행)은 이 문제의 심각도를 수량화합니다.

``` typescript
// tools/AgentTool/prompt.ts:50-57
// The dynamic agent list was ~10.2% of fleet cache_creation tokens: MCP async
// connect, /reload-plugins, or permission-mode changes mutate the list →
// description changes → full tool-schema cache bust.
```

**전체 캐시_생성 토큰 중 10.2%가 이 문제로 인해 발생했습니다.**

### <a href="#the-solution-2" class="header">해결책</a>

``` typescript
// tools/AgentTool/prompt.ts:59-64
export function shouldInjectAgentListInMessages(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES))
    return false
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_agent_list_attach', false)
}
```

솔루션은 AgentTool의 도구 설명에서 동적 에이전트 목록을 이동하고 대신 메시지 첨부 파일을 통해 삽입합니다. 도구 설명은 AgentTool의 일반 기능만 설명하는 정적 텍스트가 됩니다. 사용 가능한 에이전트 목록은 사용자 메시지에 `agent_listing_delta` 첨부 파일로 추가됩니다.

이 마이그레이션의 주요 통찰력은 **첨부 파일이 메시지 끝부분에 추가되며 접두사 캐시에 영향을 주지 않습니다**입니다. 에이전트 목록 변경은 캐시된 도구 스키마를 무효화하지 않고 새 메시지에 토큰 비용만 추가합니다.

### <a href="#impact-1" class="header">영향</a>

Cache_creation 토큰의 10.2%가 제거되었습니다. 이는 모든 최적화 패턴 중에서 가장 큰 개선 사항입니다. 점진적인 출시를 위해 GrowthBook 기능 플래그 `tengu_agent_list_attach`를 통해 제어되며 환경 변수 `CLAUDE_CODE_AGENT_LIST_IN_MESSAGES`는 수동 재정의로 유지됩니다.

------------------------------------------------------------------------

## <a href="#154-pattern-four-skill-list-budget-1-context-window"
class="header">15.4 패턴 4: 기술 목록 예산(1% 컨텍스트 창)</a>

### <a href="#the-problem-3" class="header">문제</a>

AgentTool과 유사한 SkillTool은 도구 설명에 사용 가능한 기술 목록을 포함합니다. 기술 생태계가 성장함에 따라(내장 기술 + 프로젝트 기술 + 플러그인 기술) 목록이 매우 길어질 수 있습니다. 더 중요한 것은 스킬 로딩이 동적이라는 것입니다. 프로젝트마다 `.claude/` 구성이 다르며 세션 중에 플러그인을 로드하거나 언로드할 수 있습니다.

### <a href="#the-solution-3" class="header">해결책</a>

``` typescript
// tools/SkillTool/prompt.ts:20-23
// Skill listing gets 1% of the context window (in characters)
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000 // Fallback: 1% of 200k × 4
```

SkillTool은 기술 목록에 엄격한 예산 제한을 적용합니다. **총 목록 크기는 컨텍스트 창의 1%를 초과할 수 없습니다**. 200K 컨텍스트 창의 경우 이는 약 8,000자입니다.

예산 계산 기능(31~41행):

``` typescript
// tools/SkillTool/prompt.ts:31-41
export function getCharBudget(contextWindowTokens?: number): number {
  if (Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)) {
    return Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)
  }
  if (contextWindowTokens) {
    return Math.floor(
      contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT,
    )
  }
  return DEFAULT_CHAR_BUDGET
}
```

또한 각 기술 항목의 설명이 잘립니다.

``` typescript
// tools/SkillTool/prompt.ts:29
export const MAX_LISTING_DESC_CHARS = 250
```

주석(25~28행)에서는 디자인 논리를 설명합니다.

// 항목당 하드 캡입니다. 목록은 검색용으로만 사용됩니다. // 기술 도구는 호출 시 전체 콘텐츠를 로드하므로 자세한 whenToUse 문자열은 일치율을 높이지 않고 1턴 캐시_생성 // 토큰을 낭비합니다.

### <a href="#the-essence-of-the-cache-optimization" class="header">캐시 최적화의 본질</a>

1% 예산 제어는 두 가지 방법으로 캐시 최적화를 달성합니다.

1. **도구 설명 크기 제한**: 설명이 짧을수록 정확히 일치해야 하는 바이트 수가 적음을 의미합니다.
2. **예산 조정으로 이탈률 감소**: 새로운 기술이 로드되었지만 예산이 이미 가득 찬 경우 해당 기술은 목록에 포함되지 않습니다. 목록이 변경되지 않고 캐시가 중단되지 않습니다.

이는 "예산은 안정성과 동일하다"는 패턴입니다. 즉, 동적 콘텐츠의 최대 크기를 제한하여 캐시 키 변경의 규모를 간접적으로 제어합니다.

------------------------------------------------------------------------

## <a href="#155-pattern-five-tmpdir-placeholder" class="header">15.5 패턴 5: $TMPDIR 자리 표시자</a>

### <a href="#the-problem-4" class="header">문제</a>

BashTool의 프롬프트는 모델에 쓸 수 있는 임시 디렉터리 경로를 알려야 합니다. Claude Code는 `getClaudeTempDir()`를 사용하여 일반적으로 `/private/tmp/claude-{UID}/` 형식으로 이 경로를 얻습니다. 여기서 `{UID}`는 사용자 시스템 UID입니다.

문제: 사용자마다 UID가 다르므로 경로 문자열이 다릅니다. 이 경로가 도구 프롬프트에 포함되어 있으면 **사용자 간 전역 캐시 적중**을 방지합니다. 사용자 A의 `/private/tmp/claude-1001/`와 사용자 B의 `/private/tmp/claude-1002/`는 글로벌 캐시 범위 내에서도 공유할 수 없는 서로 다른 바이트 시퀀스입니다.

### <a href="#the-solution-4" class="header">해결책</a>

``` typescript
// tools/BashTool/prompt.ts:186-190
// Replace the per-UID temp dir literal (e.g. /private/tmp/claude-1001/) with
// "$TMPDIR" so the prompt is identical across users — avoids busting the
// cross-user global prompt cache. The sandbox already sets $TMPDIR at runtime.
const claudeTempDir = getClaudeTempDir()
const normalizeAllowOnly = (paths: string[]): string[] =>
  [...new Set(paths)].map(p => (p === claudeTempDir ? '$TMPDIR' : p))
```

해결책은 우아하고 간결합니다. 사용자별 임시 디렉토리 경로를 `$TMPDIR` 자리 표시자로 바꾸십시오. Claude Code의 샌드박스 환경은 이미 `$TMPDIR`를 올바른 디렉토리로 설정했기 때문에 임시 디렉토리를 참조하기 위해 `$TMPDIR`를 사용하는 모델은 절대 경로를 사용하는 것과 동일하게 작동합니다.

또한 프롬프트는 모델에 `$TMPDIR`를 사용하도록 명시적으로 지시합니다.

``` typescript
// tools/BashTool/prompt.ts:258-260
'For temporary files, always use the `$TMPDIR` environment variable. ' +
'TMPDIR is automatically set to the correct sandbox-writable directory ' +
'in sandbox mode. Do NOT use `/tmp` directly - use `$TMPDIR` instead.',
```

### <a href="#impact-2" class="header">영향</a>

이러한 최적화를 통해 모든 사용자에 걸쳐 BashTool의 프롬프트가 **바이트 단위로 동일**하게 되어 글로벌 캐시 범위 접두사 공유가 가능해집니다. 가장 자주 사용되는 도구인 BashTool의 경우 스키마에 대한 글로벌 캐시 적중은 상당한 비용 절감을 의미합니다.

------------------------------------------------------------------------

## <a href="#156-pattern-six-conditional-paragraph-omission"
class="header">15.6 패턴 6: 조건부 단락 생략</a>

### <a href="#the-problem-5" class="header">문제</a>

시스템 프롬프트에는 특정 조건에서만 나타나는 단락이 포함되어 있습니다. 활성화된 기능 플래그는 설명을 추가하고, 사용 가능한 기능은 지침을 삽입합니다. 이러한 조건이 세션 중간에 반전되면(예: GrowthBook의 원격 구성 업데이트) 단락의 표시/사라짐으로 인해 시스템 프롬프트 내용이 변경되어 캐시 중단이 발생합니다.

### <a href="#the-solution-5" class="header">해결책</a>

조건부 단락 생략 패턴의 핵심 원칙은 **말하고 삭제하는 것보다 말하지 않는 것이 낫다**입니다. 구체적인 구현 접근 방식은 다음과 같습니다.

1. **조건부 단락을 정적 텍스트로 대체**: 설명이 모델 동작에 최소한의 영향을 미치는 경우 조건부 논리를 피하고 항상 설명을 포함하거나 항상 제외합니다.
2. **동적 경계 뒤에 조건부 콘텐츠 이동**: 조건부 포함이 필요한 경우 전역 캐싱에 참여하지 않는 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 뒤에 배치합니다(13장 참조).
3. **인라인 조건 대신 첨부 메커니즘 사용**: 패턴 3의 에이전트 목록과 유사하게 조건부 콘텐츠를 메시지 꼬리에 첨부 파일로 추가합니다.

이 패턴에는 단일 구현 위치가 없습니다. 이는 시스템 프롬프트 및 도구 프롬프트 구성에 스며드는 디자인 원칙입니다. 그 핵심은 API 요청 접두사의 시스템 프롬프트 블록이 세션 수명 주기 전반에 걸쳐 **단조로운 안정성**을 유지하도록 보장하는 것입니다. 콘텐츠는 항상 존재하거나 존재하지 않으며, 외부 조건 전환으로 인해 결코 나타나거나 사라지지 않습니다.

------------------------------------------------------------------------

## <a href="#157-pattern-seven-tool-schema-cache--gettoolschemacache"
class="header">15.7 패턴 7: 도구 스키마 캐시 — getToolSchemaCache()</a>

### <a href="#the-problem-6" class="header">문제</a>

도구 스키마 직렬화(`toolToAPISchema()`)는 여러 런타임 결정을 포함하는 복잡한 프로세스입니다.

1. **GrowthBook 기능 플래그**: `tengu_tool_pear`(엄격 모드), `tengu_fgts`(세밀한 도구 스트리밍) 및 기타 플래그는 스키마의 선택적 필드를 제어합니다.
2. **tool.prompt()의 동적 출력**: 일부 도구의 설명 텍스트에는 런타임 정보가 포함되어 있습니다.
3. **MCP 도구 스키마**: 외부 서버에서 제공하는 스키마는 세션 중에 변경될 수 있습니다.

모든 API 요청에 대한 도구 스키마를 다시 계산한다는 것은 다음을 의미합니다. GrowthBook이 세션 중간에 캐시를 새로 고치고(언제든지 발생할 수 있음) 플래그 값이 `true`에서 `false`로 바뀌면 도구 스키마 직렬화 결과가 변경됩니다(캐시 중단).

### <a href="#the-solution-6" class="header">해결책</a>

``` typescript
// utils/toolSchemaCache.ts:1-27
// Session-scoped cache of rendered tool schemas. Tool schemas render at server
// position 2 (before system prompt), so any byte-level change busts the entire
// ~11K-token tool block AND everything downstream. GrowthBook gate flips
// (tengu_tool_pear, tengu_fgts), MCP reconnects, or dynamic content in
// tool.prompt() drift all cause this churn. Memoizing per-session locks the schema
// bytes at first render — mid-session GB refreshes no longer bust the cache.

type CachedSchema = BetaTool & {
  strict?: boolean
  eager_input_streaming?: boolean
}

const TOOL_SCHEMA_CACHE = new Map<string, CachedSchema>()

export function getToolSchemaCache(): Map<string, CachedSchema> {
  return TOOL_SCHEMA_CACHE
}

export function clearToolSchemaCache(): void {
  TOOL_SCHEMA_CACHE.clear()
}
```

`TOOL_SCHEMA_CACHE`는 도구 이름(또는 `inputJSONSchema`를 포함한 복합 키)으로 키가 지정된 모듈 수준 맵으로, 완전히 직렬화된 스키마를 캐싱합니다. 첫 번째 요청에서 도구의 스키마가 렌더링되고 캐시되면 후속 요청에서는 `tool.prompt()`를 호출하거나 GrowthBook 플래그를 다시 평가하지 않고 캐시된 값을 직접 재사용합니다.

### <a href="#cache-key-design" class="header">캐시 키 디자인</a>

캐시 키 디자인에는 미묘하지만 중요한 고려 사항이 있습니다(`utils/api.ts`, 147~149행).

``` typescript
// utils/api.ts:147-149
const cacheKey =
  'inputJSONSchema' in tool && tool.inputJSONSchema
    ? `${tool.name}:${jsonStringify(tool.inputJSONSchema)}`
    : tool.name
```

대부분의 도구는 해당 이름을 키로 사용합니다. 각 도구 이름은 고유하며 세션 내에서 스키마가 변경되지 않습니다. 그러나 `StructuredOutput`는 특별한 경우입니다. 해당 이름은 항상 `'StructuredOutput'`이지만 다른 워크플로 호출은 다른 `inputJSONSchema`를 전달합니다. 이름만 키로 사용하는 경우 첫 번째 호출에서 캐시된 스키마가 이후의 다른 워크플로에서 잘못 재사용됩니다.

소스 의견은 이 버그의 심각도를 언급합니다.

// StructuredOutput 인스턴스는 'StructuredOutput'이라는 이름을 공유하지만 // 워크플로 호출마다 다른 스키마를 전달합니다. // 이름 전용 키잉은 오래된 스키마를 반환했습니다(5.4% → 51% 오류율, PR#25424 참조).

**오류율이 5.4%에서 51%로 증가했습니다**. 이는 미묘한 캐시 일관성 문제가 아니라 심각한 기능 버그입니다. 캐시 키에 `inputJSONSchema`를 포함하여 해결되었습니다.

### <a href="#lifecycle" class="header">수명주기</a>

`TOOL_SCHEMA_CACHE`의 수명주기는 세션에 바인딩됩니다.

- **생성**: `toolToAPISchema()`에 대한 첫 번째 호출 시 도구별로 채워집니다.
- **읽기**: 모든 후속 API 요청에 재사용됩니다.
- **지우기**: `clearToolSchemaCache()`는 사용자 로그아웃 시(`auth.ts`를 통해) 호출되어 새 세션이 이전 세션의 오래된 스키마를 재사용하지 않도록 합니다.

`clearToolSchemaCache`는 `utils/api.ts`가 아닌 독립형 리프 모듈인 `utils/toolSchemaCache.ts`에 배치됩니다. 의견은 이유를 설명합니다.

// 리프 모듈에 상주하므로 api.ts를 가져오지 않고도 auth.ts가 이를 지울 수 있습니다. // (계획→설정→파일→growthbook→config→ // bridgeEnabled→auth를 통해 주기가 생성됩니다).

단순해 보이는 캐시 맵에는 순환 종속성을 피하기 위해 신중한 모듈 분할이 필요합니다. 이는 대규모 TypeScript 프로젝트에서 흔히 발생하는 문제입니다.

------------------------------------------------------------------------

## <a href="#158-the-common-essence-of-these-patterns" class="header">15.8 이러한 패턴의 공통 본질</a>

7가지 패턴을 모두 되돌아보면 다음 다이어그램은 모두 공유하는 최적화 결정 흐름을 보여줍니다.

``` mermaid
flowchart TD
    Start[Identify dynamic content] --> Q1{Must it appear\nin the prefix?}
    Q1 -- No --> Move[Move to message tail/attachment]
    Move --> Done[Cache safe]

    Q1 -- Yes --> Q2{Can user-dimension\ndifferences be eliminated?}
    Q2 -- Yes --> Placeholder[Use placeholder/normalize]
    Placeholder --> Done

    Q2 -- No --> Q3{Can change\nfrequency be reduced?}
    Q3 -- Yes --> Reduce[Memoize/reduce precision/session-level cache]
    Reduce --> Done

    Q3 -- No --> Q4{Can change\nmagnitude be limited?}
    Q4 -- Yes --> Budget[Budget control/conditional paragraph omission]
    Budget --> Done

    Q4 -- No --> Accept[Mark as dynamic region\nscope: null]
    Accept --> Done

    style Start fill:#f9f,stroke:#333
    style Done fill:#9f9,stroke:#333
```

**그림 15-1: 캐시 최적화 패턴 결정 흐름**

몇 가지 공통 원칙을 추출할 수 있습니다.

### <a href="#principle-one-push-dynamic-content-toward-the-request-tail"
class="header">원칙 1: 동적 콘텐츠를 요청 꼬리 방향으로 푸시</a>

API 요청의 접두사 일치 모델은 다음을 의미합니다. **콘텐츠가 빠를수록 변경 사항이 더 파괴적입니다**. 그러므로:

- 날짜 메모(패턴 1)는 시스템 프롬프트에서 날짜를 잠급니다.
- 첨부 파일로서의 에이전트 목록(패턴 3)은 동적 목록을 도구 스키마(앞)에서 메시지 첨부 파일(꼬리)로 이동합니다.
- 조건부 단락 생략(패턴 6)은 접두사 내용이 흔들리지 않도록 보장합니다.

### <a href="#principle-two-reduce-change-frequency"
class="header">원칙 2: 변경 빈도 줄이기</a>

콘텐츠가 접두사에 나타나야 하는 경우 변경 빈도를 줄이는 것이 차선책입니다.

- 월별 세분성(패턴 2)은 날짜 변경을 일별에서 월별로 줄입니다.
- 스킬 목록 예산(패턴 4)은 예산 조정을 통해 목록 변경을 줄입니다.
- 도구 스키마 캐시(패턴 7)는 요청별에서 세션별 변경 빈도를 줄입니다.

### <a href="#principle-three-eliminate-user-dimension-differences"
class="header">원칙 3: 사용자 차원의 차이 제거</a>

글로벌 캐싱의 전제 조건은 모든 사용자에게 동일한 접두사가 표시된다는 것입니다.

- \$TMPDIR 자리 표시자(패턴 5)는 사용자 UID로 인한 경로 차이를 제거합니다.
- 날짜 메모이제이션도 이를 간접적으로 제공합니다. 다른 시간대에 있는 사용자는 동시에 다른 날짜를 가질 수 있습니다.

### <a href="#principle-four-measure-first-optimize-second"
class="header">원칙 4: 먼저 측정하고 두 번째로 최적화</a>

모든 패턴의 발견은 14장의 캐시 중단 감지 시스템에 따라 달라집니다.

- 캐시_생성 토큰의 10.2%가 에이전트 목록에 귀속됩니다. 이 수치는 BigQuery 분석에서 나온 것입니다.
- 도구 변경의 77%는 단일 도구 스키마 변경입니다. 이는 도구 스키마 캐시 설계를 주도했습니다.
- GrowthBook 플래그가 중단 원인으로 바뀌었습니다. 이로 인해 세션 수준 캐싱이 도입되었습니다.

관찰성 인프라가 없었다면 이러한 패턴은 결코 발견되지 않았을 것입니다.

------------------------------------------------------------------------

## <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

이러한 패턴은 Claude Code 이상으로 적용됩니다. Anthropic API(또는 유사한 접두사 캐싱 메커니즘)를 사용하는 모든 애플리케이션은 이 패턴에서 학습할 수 있습니다.

### <a href="#advice-for-api-callers" class="header">API 호출자를 위한 조언</a>

1. **시스템 프롬프트 감사**: 그 안의 동적 콘텐츠(날짜, 사용자 이름, 구성 값)를 식별하고 이를 시스템 프롬프트 끝이나 메시지에 푸시합니다.
2. **도구 스키마 잠금**: 도구 정의는 세션 내에서 일정하게 유지되어야 합니다. 도구 목록을 동적으로 변경해야 하는 경우 대신 메시지 첨부 파일을 사용하는 것이 좋습니다.
3. **cache_read_input_tokens 모니터링**: 캐싱이 제대로 작동하는지 여부를 알려주는 유일한 지표입니다. 세션 중에 예기치 않게 삭제되면 캐시 중단이 발생합니다.
4. **접두사 순서 이해**: `cache_control` 중단점 이전의 콘텐츠를 변경하면 해당 중단점의 캐시가 무효화됩니다. 요청을 구성할 때 가장 안정적인 콘텐츠를 먼저 배치하세요.

### <a href="#common-pitfalls" class="header">일반적인 함정</a>

<div class="table-wrapper">

| 함정 | 원인 | 해결책 |
|----|----|----|
| 시스템 프롬프트에 타임스탬프 삽입 | 모든 요청을 변경합니다. | 세션 수준 메모 사용 |
| 동적 도구 목록 | MCP 연결/연결 끊김이 목록을 변경합니다. | 첨부 메커니즘 또는 defer_loading |
| 사용자별 경로 | 다양한 사용자, 다양한 바이트 | 환경 변수 자리 표시자 |
| 스키마에 직접적인 영향을 미치는 기능 플래그 | 원격 구성 새로 고침 | 세션 수준 캐시 |
| 빈번한 모델 전환 | 모델이 캐시 키의 일부입니다. | 모델 선택을 최대한 안정적으로 유지 |

</div>

### <a href="#advice-for-claude-code-users" class="header">Claude Code 사용자를 위한 조언</a>

1. **1시간 캐시 창을 활용하세요.** CC의 프롬프트 캐시 TTL은 1시간입니다. 한 시간 내에 계속 작업하면 후속 요청의 캐시 적중률이 점점 더 높아집니다. 오랜 휴식 후에도 캐시가 유효한 상태로 유지될 것이라고 기대하지 마세요.
2. **새 세션을 자주 생성하기보다는 세션을 재사용하세요.** 새 세션 = 새 캐시 접두사 = 적중률 0입니다. `--resume`를 사용하여 기존 세션을 복원하는 것이 새 세션을 생성하는 것보다 비용 효율적입니다.
3. **`cache_creation_input_tokens` 대 `cache_read_input_tokens`를 모니터링하세요.** 전자는 캐싱에 대해 지불하는 "수업료"이고 후자는 "반품"입니다. 건강한 세션에서는 처음 몇 턴 동안 생성량이 높고 그 이후에는 읽기가 지배적임을 보여야 합니다.
4. **에이전트를 구축하는 경우 캐시 편집 고정을 구현합니다.** CC의 `pinCacheEdits()` / `consumePendingCacheEdits()` 패턴을 사용하면 캐시 접두사를 손상시키지 않고 메시지 내용을 수정할 수 있습니다. 이는 차용할 가치가 있는 고급 최적화입니다.

------------------------------------------------------------------------

## <a href="#summary" class="header">요약</a>

이 장에서는 Claude Code의 7가지 캐시 최적화 패턴을 소개했습니다.

1. **날짜 메모**: `memoize(getLocalISODate)`는 자정 캐시 무효화를 제거합니다.
2. **월간 단위**: `getLocalMonthYear()`는 도구 프롬프트 날짜 변경 빈도를 일일에서 월간으로 줄입니다.
3. **에이전트 목록 첨부**: 캐시_생성 토큰 10.2% 제거
4. **스킬 목록 예산**: 하드 1% 컨텍스트 창 예산은 목록 크기 및 변경을 제어합니다.
5. **\$TMPDIR 자리 표시자**: 사용자 차원 차이를 제거하여 글로벌 캐시를 활성화합니다.
6. **조건부 단락 생략**: 기능 토글로 인해 접두사 내용이 흔들리지 않도록 합니다.
7. **도구 스키마 캐시**: 세션 수준 맵은 GrowthBook 플립과 동적 콘텐츠를 분리합니다.

이러한 패턴은 함께 핵심 통찰력을 구현합니다. **캐시 최적화는 고립된 문제가 아니라 동적 콘텐츠를 생성하는 시스템의 모든 위치에 스며드는 것**입니다. 날짜 형식부터 경로 문자열, 도구 설명부터 기능 플래그까지, "중요해 보이지 않는" 변경 사항으로 인해 캐시된 수만 개의 토큰이 무효화될 수 있습니다. Claude Code의 접근 방식은 캐시 안정성을 최우선으로 고려하여 동적 콘텐츠가 생성되는 모든 지점에서 캐시 친화적인 디자인 결정을 명시적으로 내립니다.

이것으로 4부 "프롬프트 캐싱"을 마치겠습니다. 13장에서는 캐시 아키텍처의 방어 계층(범위, TTL, 래칭)을 설정했고, 14장에서는 탐지 기능(2단계 탐지, 설명 엔진)을 구축했으며, 15장에서는 공격 조치(7개 이상의 최적화 패턴)를 시연했습니다. 세 개의 장이 함께 완전한 캐시 엔지니어링 시스템인 **방어, 탐지, 최적화**를 구성합니다.

다음 부분은 체계적인 엔지니어링 사고가 필요한 또 다른 영역인 안전 및 허가 시스템에 대해 설명합니다. 16장을 참조하세요.
