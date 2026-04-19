# <a href="#chapter-25-harness-engineering-principles"
class="header">25장: 하네스 엔지니어링 원리</a>

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

이전 6개 부분에서 우리는 도구 등록, 에이전트 루프, 시스템 프롬프트, 컨텍스트 압축, 프롬프트 캐싱, 권한 보안 및 기술 시스템 등 소스 코드 수준에서 Claude Code의 모든 하위 시스템을 분석했습니다. 이러한 분석을 통해 구현 세부 사항이 풍부하게 드러났지만, '작동 방식' 수준에서 멈추면 리버스 엔지니어링의 가장 가치 있는 결과물인 **재사용 가능한 엔지니어링 원칙**을 낭비하게 됩니다.

이 장에서는 이전 23개 장의 소스 코드 분석에서 얻은 6가지 핵심 하네스 엔지니어링 원칙을 추출합니다. 각 원칙에는 명확한 소스 코드 추적성, 적용 가능한 시나리오 및 패턴 방지 경고가 있습니다. 이러한 원칙의 공통 주제는 **AI 에이전트 시스템에서 동작을 제어하는 ​​가장 좋은 방법은 더 많은 코드를 작성하는 것이 아니라 더 나은 제약 조건을 설계하는 것**입니다.

------------------------------------------------------------------------

## <a href="#claude-codes-position-in-the-agent-loop-architecture-spectrum"
class="header">에이전트 루프 아키텍처 스펙트럼에서 Claude Code의 위치</a>

원칙을 정리하기 전에 다음과 같은 메타 질문에 답해 볼 가치가 있습니다. **Claude Code는 어떤 유형의 에이전트 아키텍처입니까?**

Academics categorize Agent Loops into six patterns: monolithic loop (ReAct-style reasoning-action interleaving), hierarchical agents (goal-task-execution three-tier), distributed multi-agent (multi-role collaboration), reflection/metacognitive loop (Reflexion-style self-improvement), tool-augmented loop (external tool-driven state updates), and learning/online update loop (memory persistence and 전략 반복). 대부분의 프레임워크(LangGraph, AutoGen, CrewAI)는 하나 또는 두 개의 패턴을 핵심 추상화로 선택합니다.

Claude Code를 독특하게 만드는 점은 **단일 패턴의 순수한 구현이 아니라 여섯 가지 패턴 모두의 실용적인 하이브리드**입니다.

┌─────────────────────────────────────────────────────────┐ │ 클로드 코드 아키텍처 스펙트럼 위치 │ ├─────────────────────┬────────────────────────────────────┤ │ 학업 패턴 │ CC 구현 │ ├──────────────────────┼─────────────────────────────────────┤ │ 모놀리식 루프 │ queryLoop() — 핵심 에이전트 루프(ch03) │ │ 도구 확장 루프 │ ReAct 스타일의 40개 이상의 도구 (ch02-04) │ │ 계층적 에이전트 │ 코디네이터 모드 레이어(ch20) │ │ 분산 다중 │ 팀 병렬 + Ultraplan 원격 │ │ 에이전트 │ 위임(ch20) │ │ 반사(약함) │ Advisor 도구 + 중지 후크(ch21) │ │ 학습(약함) │ 교차 세션 메모리 + CLAUDE.md │ │ │ 지속성 (ch24) │ └──────────────────────┴───────────────────────────────────┘

이 하이브리드는 디자인 실수가 아니라 실용적인 선택입니다. CC의 핵심은 모놀리식 `queryLoop()`(패턴 1)이지만 그 위에는 다음이 포함됩니다.

- **도구 보강**은 기본 동작입니다. 각 반복은 도구를 호출하고, 관찰을 얻고, 상태를 업데이트할 수 있습니다. 이는 정확히 ReAct의 "추론-작업 인터리빙"입니다.
- **계층형 에이전트**는 요청 시 활성화됩니다. 코디네이터 모드는 "계획"과 "실행"을 여러 계층으로 분할하여 상위 계층은 결정만 내리고 하위 계층은 실행만 합니다.
- **분산 다중 에이전트**는 요청 시 활성화됩니다. 팀 모드를 사용하면 여러 에이전트가 `SendMessageTool`를 통해 협업할 수 있으며 Ultraplan은 계획을 원격 컨테이너로 오프로드합니다.
- **Reflection**은 암시적입니다. 명시적인 Reflexion 메모리는 없지만 Advisor Tool은 "비판" 역할을 제공하고 중지 후크는 "실행 후 확인"을 제공합니다.
- **학습**은 지속적입니다. 교차 세션 메모리(`~/.claude/memory/`) 및 CLAUDE.md를 통해 에이전트는 모델 가중치를 업데이트하지 않고도 세션 전반에 걸쳐 경험을 축적할 수 있습니다.

이 "기본적으로 단순하고 요청 시 복잡함"이라는 아키텍처 철학은 이 장에서 정리한 모든 원칙에 스며들어 있습니다.

------------------------------------------------------------------------

## <a href="#source-code-analysis" class="header">소스 코드 분석</a>

### <a href="#251-principle-one-prompts-as-the-control-plane"
class="header">25.1 원칙 1: 컨트롤 플레인으로서의 프롬프트</a>

**정의**: 코드 논리의 하드코딩 제한 대신 시스템 프롬프트 세그먼트를 통해 모델 동작을 안내합니다.

Claude Code의 동작 지침의 대부분은 코드의 if/else 분기가 아닌 프롬프트를 통해 달성됩니다. 가장 일반적인 예는 미니멀리즘 지시문입니다.

``` typescript
// restored-src/src/constants/prompts.ts:203
"Don't create helpers, utilities, or abstractions for one-time operations.
Don't design for hypothetical future requirements. The right amount of
complexity is what the task actually requires — no speculative abstractions,
but no half-finished implementations either. Three similar lines of code
is better than a premature abstraction."
```

이 텍스트는 코드 주석이 아닙니다. 모델에 전송되는 실제 명령입니다. Claude Code does not detect at the code level whether the model is over-engineering (which is technically nearly impossible), but instead directly tells the model "don't do this" through natural language.

동일한 패턴이 전체 시스템 프롬프트 아키텍처에 널리 퍼져 있습니다(자세한 내용은 5장 참조). `systemPromptSections.ts`는 시스템 프롬프트를 각각 명확한 캐시 범위(`scope: 'global'` 또는 `null`)가 있는 여러 구성 가능한 섹션으로 구성합니다. 이 디자인은 동작 조정에 텍스트 수정만 필요함을 의미합니다. 코드 변경, 테스트 변경, 릴리스 프로세스가 필요하지 않습니다.

도구 프롬프트는 이 원칙의 전형적인 구현입니다(자세한 내용은 8장 참조). BashTool의 Git 안전 프로토콜("후크를 건너뛰지 말고, 수정하지 말고, 특정 파일 git add 선호")은 전적으로 프롬프트 텍스트를 통해 표현됩니다. If the team someday decides to allow amend, they only need to delete one line of prompt text, without touching any execution logic.

더 나아가 Claude Code는 모든 동작 스위치를 기본 시스템 프롬프트에 포함시키지 않습니다. `<system-reminder>` serves as an **out-of-band control channel**: Plan Mode's multi-stage workflow (interview → explore → plan → approve → execute), Todo/Task gentle reminders, Read tool's empty file/offset warnings, and ToolSearch's deferred tool hints are all meta-instructions conditionally injected into the message stream, rather than rewrites of the main system prompt. In other words, Claude Code separates the "stable constitution" and "runtime switches" into two layers of control plane: the former pursues stability and cacheability, the latter pursues on-demand, short-lived, and replaceable characteristics.

**적용 범위**: 코드를 사용하여 구조적 제약(권한, 토큰 예산)을 처리하고 프롬프트를 사용하여 동작 제약(스타일, 전략, 선호도)을 처리합니다.

**안티패턴: 하드코딩된 동작**. 바람직하지 않은 모든 모델 동작에 대한 탐지기와 인터셉터를 작성하여 궁극적으로 모델 기능 발전 속도를 결코 따라갈 수 없는 대규모 규칙 엔진을 생성합니다.

------------------------------------------------------------------------

### <a href="#252-principle-two-cache-aware-design-is-non-negotiable"
class="header">25.2 원칙 2: 캐시 인식 디자인은 협상 불가능하다</a>

**정의**: 모든 프롬프트 변경에는 `cache_creation` 토큰으로 측정된 비용이 있으며 시스템 설계에서는 캐시 안정성을 최우선 제약 조건으로 간주해야 합니다.

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 마커(`restored-src/src/constants/prompts.ts:114-115`)는 시스템 프롬프트를 두 영역으로 나눕니다.

``` typescript
// restored-src/src/constants/prompts.ts:105-115
/**
 * Boundary marker separating static (cross-org cacheable) content
 * from dynamic content.
 * Everything BEFORE this marker in the system prompt array can use
 * scope: 'global'.
 * Everything AFTER contains user/session-specific content and should
 * not be cached.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

`splitSysPromptPrefix()` (`restored-src/src/utils/api.ts:321-435`) implements three code paths to ensure cache breakpoints are placed correctly: MCP-present tool-based caching, global cache + boundary marker, and default org-level caching. 이 함수의 복잡성은 전적으로 캐시 최적화 요구에서 비롯됩니다. 캐싱에 관심이 없다면 문자열을 연결하기만 하면 됩니다.

캐시 중단 감지 시스템(자세한 내용은 14장 참조)은 `systemHash`, `toolsHash`, `cacheControlHash`, `perToolHashes`, `betas` 등을 포함하여 거의 20개에 달하는 상태 변경 전/후 필드(`restored-src/src/services/api/promptCacheBreakDetection.ts:28-69`)를 추적합니다. 어떤 필드라도 변경하면 캐시 무효화가 발생할 수 있습니다.

베타 헤더 래칭 메커니즘은 극단적인 경우입니다. **베타 헤더가 전송되면 해당 기능이 비활성화된 경우에도 영원히 계속 전송됩니다** — 전송을 중단하면 요청 서명이 변경되어 캐시된 접두사의 약 50-70K 토큰이 무효화되기 때문입니다. 소스 코드 주석에는 래칭 이유가 명시적으로 문서화되어 있습니다.

``` typescript
// restored-src/src/services/api/promptCacheBreakDetection.ts:47-48
/** AFK_MODE_BETA_HEADER presence — should NOT break cache anymore
 *  (sticky-on latched in claude.ts). Tracked to verify the fix. */
```

날짜 메모(`getSessionStartDate()`)는 또 다른 예입니다. 세션이 자정을 지나면 모델에 표시되는 날짜가 "만료"됩니다. 그러나 날짜 문자열 변경으로 인해 캐시 접두어가 손상될 수 있으므로 이는 의도적인 것입니다.

**안티패턴: 빈번한 프롬프트 변경**. 에이전트 목록은 한때 시스템 프롬프트에 인라인되었으며 글로벌 `cache_creation` 토큰의 10.2%를 차지했습니다(자세한 내용은 15장 참조). 해결책은 캐시 세그먼트 외부에 있는 `system-reminder` 메시지로 이동하여 수정 사항이 캐시에 영향을 미치지 않도록 하는 것이었습니다.

`/btw` 및 SDK `side_question`는 이러한 생각을 다른 방향으로 추진합니다. 바로 **캐시 안전 측파대 쿼리**입니다. 기본 대화에 일반적인 차례를 삽입하는 대신 중지 후크 단계 중에 기본 스레드가 저장한 캐시 안전 접두사 스냅샷을 재사용하고, 단일 `<system-reminder>` 부가 질문을 추가하고, 도구가 필요 없는 원샷 포크를 실행하고 명시적으로 `skipCacheWrite`를 실행합니다. 결과: 보조 질문은 자체 Q&A로 기본 대화 기록을 오염시키지 않고 상위 세션의 접두사 캐시를 공유할 수 있습니다.

------------------------------------------------------------------------

### <a href="#253-principle-three-fail-closed-open-explicitly"
class="header">25.3 원칙 3: 실패 시 닫힘, 명시적으로 열기</a>

**정의**: 시스템 기본값은 가장 안전한 옵션을 선택해야 합니다. 위험한 작업은 명시적으로 선언한 후에만 허용됩니다.

`buildTool()` 팩토리 기능은 모든 도구 속성에 대한 방어 기본값을 설정합니다.

``` typescript
// restored-src/src/Tool.ts:748-761
/**
 * Defaults (fail-closed where it matters):
 * - `isConcurrencySafe` → `false` (assume not safe)
 * - `isReadOnly` → `false` (assume writes)
 * - `isDestructive` → `false`
 * - `checkPermissions` → `{ behavior: 'allow', updatedInput }`
 *   (defer to general permission system)
 * - `toAutoClassifierInput` → `''`
 *   (skip classifier — security-relevant tools must override)
 */
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  ...
}
```

이는 새 도구가 **기본적으로 동시성이 안전하지 않음**을 의미합니다. `partitionToolCalls()`(`restored-src/src/services/tools/toolOrchestration.ts:91-116`)는 `isConcurrencySafe: true`를 선언하지 않은 도구를 직렬 대기열에 배치합니다. `isConcurrencySafe` 호출에서 예외가 발생하면 catch 블록은 보수적인 폴백인 `false`도 반환합니다.

``` typescript
// restored-src/src/services/tools/toolOrchestration.ts:98-108
const isConcurrencySafe = parsedInput?.success
  ? (() => {
      try {
        return Boolean(tool?.isConcurrencySafe(parsedInput.data))
      } catch {
        // If isConcurrencySafe throws, treat as not concurrency-safe
        // to be conservative
        return false
      }
    })()
  : false
```

권한 시스템은 동일한 원칙을 따릅니다(자세한 내용은 16장 참조). 권한 모드의 범위는 가장 제한적인 것부터 가장 허용적인 것까지입니다: `default` → `acceptEdits` → `plan` → `bypassPermissions` → `auto` → `dontAsk`. 시스템 기본값은 `default`입니다. 사용자는 보다 허용적인 모드를 적극적으로 선택해야 합니다.

YOLO 분류자의 거부 추적은 또 다른 표현입니다(`restored-src/src/utils/permissions/denialTracking.ts:12-15`): `DENIAL_LIMITS`는 3회 연속 또는 총 20번의 분류자 거부 후 시스템이 자동으로 수동 사용자 확인으로 폴백하도록 지정합니다. — **자동화된 의사결정이 신뢰할 수 없는 경우 인간의 의사결정으로 폴백**(전체 코드는 27장, 패턴 2 참조).

**안티패턴: 기본적으로 열림, 사고 발생 후 닫힘**. Tools are concurrency-safe by default, and a tool with side effects produces a race condition during parallel execution — this kind of bug is extremely difficult to reproduce and diagnose.

------------------------------------------------------------------------

### <a href="#254-principle-four-ab-test-everything" class="header">25.4 원칙 4: 모든 것에 대해 A/B 테스트</a>

**정의**: 동작 변경 사항은 먼저 내부 사용자 그룹 내에서 검증되고 데이터로 확인된 성공 후에만 모든 사용자로 확장됩니다.

Claude Code에는 89개의 기능 플래그(자세한 내용은 23장 참조)가 있으며 그 중 상당 부분이 A/B 테스트에 사용됩니다. 가장 주목할만한 것은 플래그의 개수가 아니라 게이팅 패턴입니다.

`USER_TYPE === 'ant'` 게이트는 가장 직접적인 스테이징 메커니즘입니다(자세한 내용은 7장 참조). 소스 코드에는 Capybara v8 과잉 주석 완화와 같은 수많은 개미 전용 섹션이 포함되어 있습니다.

``` typescript
// restored-src/src/constants/prompts.ts:205-213
...(process.env.USER_TYPE === 'ant'
  ? [
      `Default to writing no comments. Only add one when the WHY
       is non-obvious...`,
      // @[MODEL LAUNCH]: capy v8 thoroughness counterweight
      // (PR #24302) — un-gate once validated on external via A/B
      `Before reporting a task complete, verify it actually works...`,
    ]
  : []),
```

`un-gate once validated on external via A/B` 댓글은 이 워크플로를 명확하게 보여줍니다. **먼저 내부적으로 검증한 다음, 효과가 확인되면 A/B 테스트를 통해 외부 사용자에게 출시합니다**.

GrowthBook 통합은 보다 세부적인 실험 기능을 제공합니다. `tengu_*` 접두사가 붙은 기능 플래그는 원격 구성 서버를 통해 제어되며 백분율 기반 점진적 출시를 지원합니다. `_CACHED_MAY_BE_STALE` 및 `_CACHED_WITH_REFRESH` 캐싱 전략(자세한 내용은 7장 참조)의 존재는 "캐시 인식 A/B 테스트"를 반영합니다. 즉, 플래그 값 전환으로 인해 캐시 무효화가 발생해서는 안 됩니다.

**안티패턴: 빅뱅 릴리스**. 동작 변경 사항을 모든 사용자에게 직접 푸시합니다. In the AI Agent domain, the impact of behavior changes is typically not "crashes" but "not good enough" or "too aggressive" — requiring quantitative metrics and control groups to detect.

------------------------------------------------------------------------

### <a href="#255-principle-five-observe-before-you-fix" class="header">25.5 원칙 5: 고치기 전에 관찰하라</a>

**정의**: 문제를 해결하기 전에 먼저 전체 그림을 이해할 수 있도록 관찰성 인프라를 구축하세요.

캐시 중단 감지 시스템(`restored-src/src/services/api/promptCacheBreakDetection.ts`)은 이 원리의 패러다임입니다. 이 시스템은 어떤 문제도 해결하지 않습니다. 전체 책임은 **관찰하고 보고**하는 것입니다.

1. **통화 전**: `recordPromptState()`는 거의 20개 필드의 스냅샷을 캡처합니다.
2. **통화 후**: `checkResponseForCacheBreak()`는 이전 상태와 이후 상태를 비교하여 어떤 필드가 변경되었는지 식별합니다.
3. **설명 생성**: 사람이 읽을 수 있는 이유("시스템 프롬프트 변경됨", "TTL 만료 가능성 있음")로 변환됩니다.
4. **차이점 생성**: 프롬프트 상태 비교 전/후에 `createPatch()` 출력

특히 주목할 만한 것은 `PreviousState`(`restored-src/src/services/api/promptCacheBreakDetection.ts:36-37`)의 주석 스타일입니다.

``` typescript
/** Per-tool schema hash. Diffed to name which tool's description changed
 *  when toolSchemasChanged but added=removed=0 (77% of tool breaks per
 *  BQ 2026-03-22). AgentTool/SkillTool embed dynamic agent/command lists. */
perToolHashes: Record<string, number>
```

특정 BigQuery 쿼리 날짜 및 백분율 데이터(77%)에 대한 참조는 팀이 관측 가능성 세분성을 위해 데이터 기반 설계를 사용하고 있음을 나타냅니다. 즉, 모든 필드를 무작위로 추적하는 것이 아니라 프로덕션 데이터에서 "대부분의 도구 스키마 변경 사항은 특정 도구의 설명 변경에서 비롯됩니다"라는 사실을 발견한 다음 목표 방식으로 도구별 해시를 추가하고 있음을 나타냅니다.

YOLO 분류기의 `CLAUDE_CODE_DUMP_AUTO_MODE=1`(자세한 내용은 17장 참조)는 동일한 패턴을 따릅니다. 즉, 개발자가 "분류기가 이 작업을 거부한 이유"를 정확하게 이해할 수 있도록 완전한 입력/출력 내보내기 기능을 제공합니다.

**안티패턴: 직관으로 수정**. 실제 원인이 베타 헤더 스위치, TTL 만료 또는 MCP 도구 목록 변경일 수 있는 경우 캐시 적중률 감소를 확인하고 가장 최근 변경 사항을 롤백합니다.

------------------------------------------------------------------------

### <a href="#256-principle-six-latch-for-stability" class="header">25.6 원칙 6: 안정성을 위한 래치</a>

**정의**: 일단 상태에 들어가면 흔들리지 마십시오. 상태 스래싱은 차선의 상태보다 더 해롭습니다.

"래치" 패턴은 Claude Code 전체의 여러 위치에 나타납니다.

**베타 헤더 래칭**(자세한 내용은 13장 참조): `afkModeHeaderLatched`, `fastModeHeaderLatched`, `cacheEditingHeaderLatched`. 베타 헤더가 세션에서 처음으로 전송되면 기능이 비활성화된 경우에도 모든 후속 요청이 계속해서 전송됩니다. 이유: 전송을 중단하면 요청 서명이 변경되어 캐시 접두사가 무효화됩니다.

**캐시 TTL 자격 래칭**(자세한 내용은 13장 참조): `should1hCacheTTL()`는 세션에서 한 번만 실행되며 결과가 래치됩니다. 소스 코드 주석(`promptCacheBreakDetection.ts:50-51`)은 다음을 확인합니다.

``` typescript
/** Overage state flip — should NOT break cache anymore (eligibility is
 *  latched session-stable in should1hCacheTTL). Tracked to verify the fix. */
isUsingOverage: boolean
```

**자동 압축 회로 차단기**(`restored-src/src/services/compact/autoCompact.ts:67-70`):

``` typescript
// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures
// (up to 3,272) in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

3번 연속 실패하면 시스템은 "압축 중지" 상태가 됩니다. 댓글의 BigQuery 데이터(1,279개 세션, 250K API 호출/일)는 충분한 엔지니어링 근거를 제공합니다.

**안티패턴: 상태 스래싱**. 모든 요청에 ​​대해 구성을 다시 계산하여 상태가 서로 다른 값 사이에서 진동하게 합니다. 캐싱 시스템에서 이는 캐시 키가 지속적으로 변경되어 적중률이 0에 가까워진다는 것을 의미합니다.

------------------------------------------------------------------------

## <a href="#pattern-distillation" class="header">패턴 증류</a>

### <a href="#six-principles-summary-table" class="header">6대 원칙 요약표</a>

<div class="table-wrapper">

| 원칙 | 핵심 소스 코드 추적 | 안티패턴 |
|----|----|----|
| 컨트롤 플레인으로서의 프롬프트 | `prompts.ts:203` + `system-reminder` 주입 체인 — 기본 프롬프트와 메시지 수준 알림이 협력합니다. | 하드코딩된 동작: 원하지 않는 모든 동작에 대한 감지기 작성 |
| 캐시 인식 디자인 | `prompts.ts:114` + `stopHooks/forkedAgent` — 동적 콘텐츠 외부화 및 측파대 재사용 | 빈번한 프롬프트 변경: 캐시 생성 10.2%를 소비하는 에이전트 목록 인라인 |
| 실패 마감 | `Tool.ts:748-761` — `isConcurrencySafe: false` | 기본 개방형: 동시성이 보장되는 새로운 도구, 나중에 경합 수정 |
| A/B 테스트의 모든 것 | `prompts.ts:210` — `un-gate once validated via A/B` | Big Bang 릴리스: 변경 사항이 모든 사용자에게 직접 푸시됩니다. |
| 고치기 전에 관찰하세요 | `promptCacheBreakDetection.ts:36` — 77% 데이터 기반 | 직관에 의한 수정: 데이터를 보지 않고 롤백 |
| 안정성을 위한 래치 | `autoCompact.ts:68-70` — 250K API 호출/일 레슨 | 상태 스래싱: 모든 요청에 ​​대해 모든 상태를 다시 계산합니다. |

</div>

**표 25-1: 6가지 하네스 엔지니어링 원칙 요약**

### <a href="#relationships-between-principles" class="header">원칙 간의 관계</a>

``` mermaid
graph TD
    A["Principle 1: Prompts as Control Plane<br/>Primary means of behavior guidance"] --> B["Principle 2: Cache-Aware Design<br/>Prompt changes have cost"]
    B --> F["Principle 6: Latch for Stability<br/>Avoid cache thrashing"]
    A --> C["Principle 3: Fail Closed<br/>Safe defaults"]
    C --> D["Principle 4: A/B Test Everything<br/>Validate before opening"]
    D --> E["Principle 5: Observe Before You Fix<br/>Data-driven decisions"]
    E --> B
```

**그림 25-1: 6가지 하네스 엔지니어링 원칙의 관계 다이어그램**

**제어판으로서의 프롬프트**에서 시작: 동작은 주로 프롬프트에 의해 제어되므로 프롬프트 변경에는 비용을 제어하기 위한 **캐시 인식 설계**와 스래싱을 ​​방지하기 위한 **안정성을 위한 래치**가 필요합니다. 행동의 안전 경계는 **Fail Closed**를 통해 보장되며, 폐쇄형에서 개방형으로 전환하려면 검증을 위한 **A/B 테스트**가 필요합니다. 문제가 발생하면 **수정 전 관찰**을 통해 조치를 취하기 전에 전체 그림을 이해할 수 있으며 관찰 결과가 캐시 인식 설계에 피드백됩니다.

### <a href="#pattern-prompt-driven-behavior-control"
class="header">패턴: 프롬프트 기반 동작 제어</a>

- **해결된 문제**: 모델 기능 반복에 결합하지 않고 AI 모델 동작을 안내하는 방법
- **핵심 접근 방식**: 자연어 프롬프트를 통해 행동 기대치를 표현하고 구조적 제약 조건에만 코드를 사용합니다.
- **전제조건**: 모델이 충분한 지시 따르기 능력을 가지고 있음

### <a href="#pattern-out-of-band-control-channel" class="header">패턴: 대역 외 제어 채널</a>

- **문제 해결**: 빈도가 높은 런타임 지침으로 인해 기본 시스템 프롬프트가 부풀어 오르고 스래싱이 발생하며 캐시가 중단됩니다.
- **핵심 접근 방식**: 시스템 프롬프트에서 안정적인 행동 구성을 유지하고 `<system-reminder>`와 같은 메타 메시지에 단기 조건부 지침을 추가합니다.
- **전제조건**: 모델은 사용자 의도와 하네스 주입 제어 메시지를 구별할 수 있습니다.

### <a href="#pattern-cache-prefix-stabilization" class="header">패턴: 캐시 접두사 안정화</a>

- **문제 해결됨**: 사소한 변경으로 인해 프롬프트 캐시가 자주 무효화됨
- **핵심 접근 방식**: 정적/동적 경계 분리 + 날짜 메모 + 헤더 래칭 + 스키마 캐싱
- **전제조건**: 프리픽스 캐싱을 지원하는 API 사용

### <a href="#pattern-cache-safe-sideband-query" class="header">패턴: 캐시 안전 측파대 쿼리</a>

- **문제 해결**: 빠른 사이드 질문으로 인해 메인 루프가 중단되거나 메인 세션의 캐시 접두사가 중단됩니다.
- **핵심 접근 방식**: 기본 스레드의 캐시 안전 접두사 스냅샷을 저장하고, 제한된 단일 쿼리를 분기하며, 결과는 기본 대화 기록에 다시 기록되지 않습니다.
- **전제 조건**: 런타임은 상위 캐시 안전 메시지 접두사를 재사용하고 사이드체인의 상태와 기록을 격리할 수 있습니다.

### <a href="#pattern-fail-closed-defaults" class="header">패턴: 페일클로즈 기본값</a>

- **문제 해결됨**: 새로운 구성요소로 인해 보안 또는 동시성 위험이 발생합니다.
- **핵심 접근 방식**: 모든 속성의 기본값은 가장 안전한 값이며 잠금 해제하려면 명시적인 선언이 필요합니다.
- **전제 조건**: "안전함"과 "안전하지 않음"에 대한 명확한 정의가 존재합니다.

------------------------------------------------------------------------

## <a href="#what-you-can-do" class="header">당신이 할 수 있는 일</a>

1. **코드 로직과 별도의 동작 지시문**. 동작 조정 시 코드 변경이 필요하지 않도록 동작 구성 파일(CLAUDE.md와 유사) 생성
2. **프롬프트 캐싱을 도입하기 전에 캐시 경계를 디자인하세요**. 사용자 간 공유 콘텐츠와 세션 수준 콘텐츠 구별
3. **기본값을 감사하세요**. 모든 구성 옵션에 대해 다음과 같이 질문하십시오. 사용자가 이를 설정하지 않은 경우 시스템 동작이 가장 안전한가요, 아니면 가장 위험한가요?
4. **중요한 동작 변경에 대한 점진적인 출시 계획을 설계합니다**. 사용자 그룹이 2개(내부/외부)뿐이라도 정식 릴리스보다 안전합니다.
5. **수정하기 전에 로깅을 추가하세요**. 캐시 적중률이 떨어지거나 모델 동작이 비정상적인 경우 먼저 전체 컨텍스트를 기록한 다음 수정을 시도하세요.
6. **시스템의 "래치 지점"을 식별합니다**. 세션 수명 동안 변경해서는 안되는 상태는 무엇입니까? 안정성 메커니즘을 적극적으로 설계
7. **고주파 안내를 기본 프롬프트 밖으로 이동합니다**. 안정적인 규칙은 시스템 프롬프트에 들어가고, 단기 런타임 스위치는 `system-reminder` 또는 첨부 메시지에 들어갑니다.
8. **빠른 사이드 질문을 위해 별도의 사이드체인을 디자인하세요**. 기본 대화에 하드 삽입하는 것보다 "도구가 필요 없고 단일 회전, 캐시 재사용, 결과가 기본 스레드에 다시 기록되지 않는" 구현을 선호합니다.
