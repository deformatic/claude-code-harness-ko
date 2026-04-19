# <a href="#chapter-21-effort-fast-mode-and-thinking"
class="header">21장 노력, 빠른 모드 및 사고</a>

## <a href="#why-layered-reasoning-control-is-needed" class="header">계층화된 추론 제어가 필요한 이유</a>

모델 추론 깊이는 "더 많은 것이 항상 더 좋다"는 경우가 아닙니다. 더 깊이 생각한다는 것은 더 높은 대기 시간, 더 많은 토큰 소비, 더 낮은 처리량을 의미합니다. "변수 `foo`를 `bar`로 이름 바꾸기"와 같은 작업의 경우 Opus 4.6이 심층 추론에 10초를 소비하는 것은 낭비입니다. "전체 인증 모듈의 오류 처리를 리팩터링"하기 위해 빠르고 얕은 응답은 낮은 품질의 코드를 생성합니다.

Claude Code는 **노력**(추론 노력 수준), **빠른 모드**(가속 모드) 및 **사고**(사고 사슬 구성)의 세 가지 독립적이지만 협력적인 메커니즘을 통해 추론 깊이를 제어합니다. 각각에는 서로 다른 구성 소스, 우선 순위 규칙 및 모델 호환성 요구 사항이 있으며 각 API 호출의 추론 동작을 공동으로 결정합니다. 이 장에서는 이 세 가지 메커니즘을 하나씩 분석하고 런타임 시 이들이 어떻게 협력하는지 분석합니다.

------------------------------------------------------------------------

## <a href="#211-effort-reasoning-effort-level" class="header">21.1 노력: 추론 노력 수준</a>

노력은 응답을 생성하기 전에 모델이 투자하는 "사고 시간"을 제어하는 ​​기본 Claude API 매개변수입니다. Claude Code는 이 위에 다층 우선순위 체인을 구축합니다.

### <a href="#four-levels" class="header">4개 레벨</a>

``` typescript
// utils/effort.ts:13-18
export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'max',
] as const satisfies readonly EffortLevel[]
```

<div class="table-wrapper">

| 수준 | 설명(224-235행) | 제한 |
|:--:|:---|:---|
| `low` | 빠르고 직접적인 구현, 최소한의 오버헤드 | \- |
| `medium` | 균형 잡힌 접근 방식, 표준 구현 및 테스트 | \- |
| `high` | 광범위한 테스트 및 문서화를 통한 포괄적인 구현 | \- |
| `max` | 가장 깊은 추론 능력 | Opus 4.6 전용 |

</div>

`max` 레벨의 모델 제한은 `modelSupportsMaxEffort()`(라인 53-65)에 하드코딩되어 있습니다. `opus-4-6` 및 내부 모델만 지원됩니다. 다른 모델에서 `max`를 사용하려고 하면 `high`(라인 164)로 다운그레이드됩니다.

### <a href="#priority-chain" class="header">우선순위 체인</a>

노력의 실제 가치는 명확한 3단계 우선순위 체인에 의해 결정됩니다.

``` typescript
// utils/effort.ts:152-167
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined  // Environment variable set to 'unset'/'auto': don't send effort parameter
  }
  const resolved =
    envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  if (resolved === 'max' && !modelSupportsMaxEffort(model)) {
    return 'high'
  }
  return resolved
}
```

가장 높은 것부터 가장 낮은 것까지 우선순위:

``` mermaid
flowchart TD
    A["Environment variable CLAUDE_CODE_EFFORT_LEVEL\n(highest priority)"] --> B{Set?}
    B -->|"'unset'/'auto'"| C["Don't send effort parameter"]
    B -->|"Valid value"| G["Use environment variable value"]
    B -->|Not set| D["AppState.effortValue\n(/effort command or UI toggle)"]
    D --> E{Set?}
    E -->|Yes| G2["Use AppState value"]
    E -->|No| F["getDefaultEffortForModel(model)\nOpus 4.6 Pro → medium\nUltrathink enabled → medium\nOther → undefined (API default high)"]
    F --> H["Model default value"]
    G --> I{"Value is max and\nmodel doesn't support?"}
    G2 --> I
    H --> I
    I -->|Yes| J["Downgrade to high"]
    I -->|No| K["Keep original value"]
    J --> L["Send to API"]
    K --> L
```

### <a href="#differentiated-model-defaults" class="header">차별화된 모델 기본값</a>

`getDefaultEffortForModel()` 함수(279-329행)는 미묘한 기본값 전략을 보여줍니다.

``` typescript
// utils/effort.ts:309-319
if (model.toLowerCase().includes('opus-4-6')) {
  if (isProSubscriber()) {
    return 'medium'
  }
  if (
    getOpusDefaultEffortConfig().enabled &&
    (isMaxSubscriber() || isTeamSubscriber())
  ) {
    return 'medium'
  }
}
```

Pro 가입자의 경우 Opus 4.6의 기본값은 `medium`입니다(`high` 아님). 이는 A/B 테스트를 거친 결정입니다(GrowthBook의 `tengu_grey_step2`, 268-276행을 통해 제어됨). 소스 코드 주석(307-308행)에는 명시적인 경고가 포함되어 있습니다.

> 중요: 모델 출시 DRI 및 연구에 알리지 않고 기본 노력 수준을 변경하지 마십시오. 기본 노력은 모델 품질과 배싱에 큰 영향을 미칠 수 있는 민감한 설정입니다.

Ultrathink 기능이 활성화되면 노력을 지원하는 모든 모델은 기본적으로 `medium`(322-324행)로 기본 설정됩니다. 사용자 입력에 키워드가 포함되어 있으면 Ultrathink가 `high`에 대한 노력을 강화하기 때문입니다. `medium`는 동적으로 상승할 수 있는 기준이 됩니다.

### <a href="#numeric-effort-internal-only" class="header">숫자 작업량(내부 전용)</a>

네 가지 문자열 수준 외에도 내부 사용자는 숫자 작업을 사용할 수도 있습니다(198-216행).

``` typescript
// utils/effort.ts:202-216
export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    return isEffortLevel(value) ? value : 'high'
  }
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    if (value <= 50) return 'low'
    if (value <= 85) return 'medium'
    if (value <= 100) return 'high'
    return 'max'
  }
  return 'high'
}
```

수많은 노력은 설정 파일에 지속될 수 없습니다(`toPersistableEffort()` 함수, 95-105행, 모든 숫자 필터링). 이는 세션 런타임에만 존재합니다. 이는 실수로 사용자의 `settings.json`에 유출되어서는 안 되는 실험적 메커니즘입니다.

### <a href="#effort-persistence-boundaries" class="header">노력 지속성 경계</a>

`toPersistableEffort()`의 필터링 논리는 미묘한 디자인을 보여줍니다. `max` 레벨은 외부 사용자(라인 101)에 대해서도 지속되지 않고 현재 세션에만 유효합니다. 이는 `/effort max`를 통해 설정된 `max`가 다음 출시 시 모델 기본값으로 되돌아간다는 것을 의미합니다. 이는 사용자가 최대 기능을 끄는 것을 잊어버리고 장기적으로 과도한 리소스를 소비하는 것을 방지하기 위한 의도적인 것입니다.

------------------------------------------------------------------------

## <a href="#212-fast-mode-opus-46-acceleration" class="header">21.2 빠른 모드: Opus 4.6 가속</a>

빠른 모드(내부 코드명 "Penguin Mode")는 Sonnet 클래스 모델이 Opus 4.6을 "가속기"로 사용할 수 있게 해주는 모드입니다. 사용자의 기본 모델이 Opus가 아닌 경우 특정 요청이 더 높은 품질의 응답을 위해 Opus 4.6으로 라우팅될 수 있습니다.

### <a href="#availability-check-chain" class="header">가용성 확인 체인</a>

빠른 모드 가용성은 여러 단계의 확인을 거칩니다.

``` typescript
// utils/fastMode.ts:38-40
export function isFastModeEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FAST_MODE)
}
```

최상위 스위치 이후 `getFastModeUnavailableReason()`는 다음 조건을 확인합니다(라인 72-140).

1. **Statsig 원격 킬 스위치**(`tengu_penguins_off`): 최우선 순위 원격 스위치
2. **비네이티브 바이너리**: 선택적 검사, GrowthBook을 통해 제어됨
3. **SDK 모드**: 명시적으로 선택하지 않는 한 Agent SDK에서 기본적으로 사용할 수 없습니다.
4. **비자사 제공업체**: Bedrock/Vertex/Foundry는 지원되지 않음
5. **조직 수준 비활성화**: API에서 반환된 조직 상태

### <a href="#model-binding" class="header">모델 바인딩</a>

빠른 모드는 Opus 4.6에 고정되어 있습니다.

``` typescript
// utils/fastMode.ts:143-147
export const FAST_MODE_MODEL_DISPLAY = 'Opus 4.6'

export function getFastModeModel(): string {
  return 'opus' + (isOpus1mMergeEnabled() ? '[1m]' : '')
}
```

`isFastModeSupportedByModel()`는 또한 Opus 4.6(167-176행)에 대해서만 `true`를 반환합니다. 즉, 사용자가 이미 Opus 4.6을 기본 모델로 사용하고 있는 경우 빠른 모드 자체가 됩니다.

### <a href="#cooldown-state-machine" class="header">쿨다운 상태 머신</a>

빠른 모드의 런타임 상태는 우아한 상태 머신입니다.

``` typescript
// utils/fastMode.ts:183-186
export type FastModeRuntimeState =
  | { status: 'active' }
  | { status: 'cooldown'; resetAt: number; reason: CooldownReason }
```

┌─────────────────────────────────────────────────────────┐ │ 빠른 모드 쿨다운 상태 머신 │ │ │ ┌──────────┐ TriggerFastModeCooldown() ┌──────────┐ │ │ │ │─────────────────────────────── │ │ │ │ 활성 │ │ 쿨타임 │ │ │ │ │turkey─────────────────────────────│ │ │ │ 이 | (이유가 out_of_credits가 아닌 경우) │ │ │ │ 트리거 이유(CooldownReason): │ │ • 'rate_limit' — API 429 속도 제한 │ │ • 'overloaded' — 서비스 오버로드 │ │ │ │ 쿨다운 만료 자동 복구 │ │ (타이밍 확인: getFastModeRuntimeState()) │ └─────────────────────────────────────────────────────────┘

쿨다운이 트리거되면(`triggerFastModeCooldown()`, 214-233행) 시스템은 쿨다운 종료 타임스탬프와 이유를 기록하고 분석 이벤트를 전송하며 Signal을 통해 UI에 알립니다.

``` typescript
// utils/fastMode.ts:214-233
export function triggerFastModeCooldown(
  resetTimestamp: number,
  reason: CooldownReason,
): void {
  runtimeState = { status: 'cooldown', resetAt: resetTimestamp, reason }
  hasLoggedCooldownExpiry = false
  logEvent('tengu_fast_mode_fallback_triggered', {
    cooldown_duration_ms: cooldownDurationMs,
    cooldown_reason: reason,
  })
  cooldownTriggered.emit(resetTimestamp, reason)
}
```

재사용 대기시간 만료 감지는 **게으르다** -- 타이머가 사용되지 않습니다. 대신 `getFastModeRuntimeState()`에 대한 모든 호출을 확인합니다(199-212행). 이는 불필요한 타이머 리소스 소비를 방지합니다. `cooldownExpired` 신호는 다음에 상태를 쿼리할 때만 발생합니다.

### <a href="#organization-level-status-prefetch"
class="header">조직 수준 상태 미리 가져오기</a>

조직에서 빠른 모드를 허용하는지 여부는 API 프리페치를 통해 결정됩니다. `prefetchFastModeStatus()` 함수(407-532행)는 시작 시 `/api/claude_code_penguin_mode` 끝점을 호출하고 결과는 `orgStatus` 변수에 캐시됩니다.

프리페치에는 스로틀 보호(30초 최소 간격, 383-384행) 및 디바운스(한 번에 하나의 진행 중 요청만, 416-420행)가 있습니다. 인증이 실패하면 자동으로 OAuth 토큰 새로 고침을 시도합니다(466-479행).

네트워크 요청이 실패하면 내부 사용자는 기본적으로 허용(내부 개발을 차단하지 않음)으로 설정되고, 외부 사용자는 디스크 캐시 `penguinModeOrgEnabled` 값(511-520행)으로 대체됩니다.

### <a href="#three-state-output" class="header">3상태 출력</a>

`getFastModeState()` 기능은 모든 상태를 사용자가 볼 수 있는 세 가지 상태로 압축합니다.

``` typescript
// utils/fastMode.ts:319-335
export function getFastModeState(
  model: ModelSetting,
  fastModeUserEnabled: boolean | undefined,
): 'off' | 'cooldown' | 'on' {
  const enabled =
    isFastModeEnabled() &&
    isFastModeAvailable() &&
    !!fastModeUserEnabled &&
    isFastModeSupportedByModel(model)
  if (enabled && isFastModeCooldown()) {
    return 'cooldown'
  }
  if (enabled) {
    return 'on'
  }
  return 'off'
}
```

이 세 가지 상태는 UI의 다양한 시각적 피드백에 매핑됩니다. `on`는 가속 아이콘을 표시하고 `cooldown`는 일시적인 성능 저하 알림을 표시하며 `off`는 아무것도 표시하지 않습니다.

------------------------------------------------------------------------

## <a href="#213-thinking-configuration" class="header">21.3 사고 구성</a>

사고(생각의 사슬/확장된 사고)는 모델이 추론 프로세스를 출력하는지 여부와 방법을 제어합니다.

### <a href="#three-modes" class="header">세 가지 모드</a>

``` typescript
// utils/thinking.ts:10-13
export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }
```

<div class="table-wrapper">

| 방법 | API 동작 | 적용 조건 |
|:--:|:---|:---|
| `adaptive` | 모델이 생각할지 여부와 생각의 양을 결정합니다. | Opus 4.6, Sonnet 4.6 및 기타 새 모델 |
| `enabled` | 고정 토큰 예산 사고방식 | 적응형을 지원하지 않는 이전 Claude 4 모델 |
| `disabled` | 생각의 연쇄 출력 없음 | API 키 검증 및 기타 낮은 오버헤드 호출 |

</div>

### <a href="#model-compatibility-layers" class="header">모델 호환성 레이어</a>

세 가지 독립적인 기능 감지 기능은 다양한 수준의 사고 지원을 처리합니다.

**`modelSupportsThinking()`** (90-110행): 모델이 사고 사슬을 지원하는지 여부를 감지합니다.

``` typescript
// utils/thinking.ts:105-109
if (provider === 'foundry' || provider === 'firstParty') {
  return !canonical.includes('claude-3-')  // All Claude 4+ supported
}
return canonical.includes('sonnet-4') || canonical.includes('opus-4')
```

자사 및 Foundry 제공업체의 경우 Claude 3을 제외한 모든 모델이 지원됩니다. 타사 공급자(Bedrock/Vertex): Sonnet 4+ 및 Opus 4+만 - 타사 배포의 모델 가용성 차이를 반영합니다.

**`modelSupportsAdaptiveThinking()`**(라인 113-144): 모델이 적응 모드를 지원하는지 여부를 감지합니다.

``` typescript
// utils/thinking.ts:119-123
if (canonical.includes('opus-4-6') || canonical.includes('sonnet-4-6')) {
  return true
}
```

4.6 버전 모델만 명시적으로 적응형을 지원합니다. 알 수 없는 모델 문자열의 경우 자사 및 Foundry의 기본값은 `true`(143행)이고 타사의 기본값은 `false`입니다. 소스 주석에서 이유를 설명합니다(136-141행).

> 최신 모델(4.6+)은 모두 적응적 사고에 대한 교육을 받았으며 모델 테스트를 위해 이를 활성화해야 합니다. 자사에 대해 기본값을 false로 설정하지 마세요. 그렇지 않으면 모델 품질이 조용히 저하될 수 있습니다.

**`shouldEnableThinkingByDefault()`** (라인 146-162): Thinking이 기본적으로 활성화되는지 여부를 결정합니다.

``` typescript
// utils/thinking.ts:146-162
export function shouldEnableThinkingByDefault(): boolean {
  if (process.env.MAX_THINKING_TOKENS) {
    return parseInt(process.env.MAX_THINKING_TOKENS, 10) > 0
  }
  const { settings } = getSettingsWithErrors()
  if (settings.alwaysThinkingEnabled === false) {
    return false
  }
  return true
}
```

우선순위: `MAX_THINKING_TOKENS` 환경 변수 \> 설정의 `alwaysThinkingEnabled` \> 기본적으로 활성화되어 있습니다.

### <a href="#three-mode-comparison" class="header">3가지 모드 비교</a>

┌─────────────────────────────────────────────────────────────────┐ │ 생각하는 3가지 모드 비교 │ ├──────────────┬───────────────┬────────────────┬──────────────┤ │ │ 적응형 │ 활성화 │ 비활성화 │ ├──────────────┼────────────────┼────────────────┼───────────────┤ │ 예산 생각 │ 모델 결정 │ 고정 예산Tkns │ 생각 없음 │ │ API 매개변수 │ {type:'adaptive│ {type:'enabled', │ No Thinking │ │ │ '} │ Budget_tokens:N}│ param 또는 비활성화 │ │ 지원됨 │ Opus/Sonnet 4.6│ 모든 Claude 4 │ 모든 모델 │ │ 모델 │ │ 시리즈 │ │ │ 기본 │ 선호되는 │ 대체 대상 │ 명시적으로 │ │ 상태 │ 4.6 모델 │ 이전 4 시리즈 │ 비활성화 │ │ 상호 작용 │ 노력 제어│ 예산 제어 │ 해당 없음 │ │ 노력 포함 │ 사고 깊이 │ 사고 한도 │ │ │ 사용 사례 │ 대부분의 대화 │ 정확한 경우 │ API 검증, │ │ │ │ 예산 필요 │ 도구 스키마 등 │ └──────────────┴───────────────┴────────────────┴───────────────┘

### <a href="#api-level-application" class="header">API 수준 애플리케이션</a>

`services/api/claude.ts`(라인 1602-1622)에서 ThinkingConfig는 실제 API 매개변수로 변환됩니다.

``` typescript
// services/api/claude.ts:1604-1622 (simplified)
if (hasThinking && modelSupportsThinking(options.model)) {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING)
      && modelSupportsAdaptiveThinking(options.model)) {
    thinking = { type: 'adaptive' }
  } else {
    let thinkingBudget = getMaxThinkingTokensForModel(options.model)
    if (thinkingConfig.type === 'enabled' && thinkingConfig.budgetTokens !== undefined) {
      thinkingBudget = thinkingConfig.budgetTokens
    }
    thinking = { type: 'enabled', budget_tokens: thinkingBudget }
  }
}
```

결정 논리는 적응형을 선호합니다. -\> 적응형이 지원되지 않는 경우 고정 예산을 사용합니다. -\> 사용자가 지정한 예산이 기본값을 재정의합니다. 환경 변수 `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`는 최종 탈출구로, 고정 예산 모드로 강제 대체할 수 있습니다.

------------------------------------------------------------------------

## <a href="#214-ultrathink-keyword-triggered-effort-boost"
class="header">21.4 울트라씽크: 키워드에 의해 유발되는 노력 부스트</a>

Ultrathink는 영리한 상호 작용 설계입니다. 사용자가 메시지에 `ultrathink` 키워드를 포함하면 노력이 자동으로 `medium`에서 `high`로 향상됩니다.

### <a href="#gating-mechanism" class="header">게이팅 메커니즘</a>

Ultrathink는 이중 문으로 되어 있습니다.

``` typescript
// utils/thinking.ts:19-24
export function isUltrathinkEnabled(): boolean {
  if (!feature('ULTRATHINK')) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_turtle_carbon', true)
}
```

빌드 시간 기능 플래그(`ULTRATHINK`)는 코드가 빌드 아티팩트에 포함되는지 여부를 제어하고, GrowthBook 런타임 플래그(`tengu_turtle_carbon`)는 현재 사용자에 대해 활성화되는지 여부를 제어합니다.

### <a href="#keyword-detection" class="header">키워드 감지</a>

``` typescript
// utils/thinking.ts:29-31
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}
```

감지에서는 단어 경계 일치(`\b`)를 사용하며 대소문자를 구분합니다. `findThinkingTriggerPositions()` 함수(36-58행)는 UI 강조를 위해 각 일치 항목에 대한 위치 정보를 추가로 반환합니다.

소스 코드의 세부 사항(42-44행 주석)에 유의하십시오. `String.prototype.matchAll`가 소스 정규식의 `lastIndex`에서 상태를 복사하기 때문에 공유 인스턴스를 재사용하는 대신 각 호출에서 새로운 정규식 리터럴이 생성됩니다. `hasUltrathinkKeyword`의 `.test()`와 인스턴스를 공유하는 경우 `lastIndex`는 호출 간에 누출될 수 있습니다.

### <a href="#attachment-injection" class="header">부착 주입</a>

Ultrathink의 노력 증대는 부착 시스템(`utils/attachments.ts` 라인 1446-1452)을 통해 구현됩니다.

``` typescript
// utils/attachments.ts:1446-1452
function getUltrathinkEffortAttachment(input: string | null): Attachment[] {
  if (!isUltrathinkEnabled() || !input || !hasUltrathinkKeyword(input)) {
    return []
  }
  logEvent('tengu_ultrathink', {})
  return [{ type: 'ultrathink_effort', level: 'high' }]
}
```

이 첨부 파일은 대화에 삽입된 시스템 알림 메시지로 변환됩니다(`utils/messages.ts` 행 4170-4175).

``` typescript
case 'ultrathink_effort': {
  return wrapMessagesInSystemReminder([
    createUserMessage({
      content: `The user has requested reasoning effort level: ${attachment.level}. Apply this to the current turn.`,
      isMeta: true,
    }),
  ])
}
```

Ultrathink는 `resolveAppliedEffort()`의 출력을 직접 수정하지 않습니다. "사용자가 더 높은 추론 노력을 요청했습니다"라는 메시지 시스템을 통해 모델에 알리고 모델이 적응적 사고 모드에서 자체적으로 조정되도록 합니다. 이는 API 매개변수를 변경하지 않는 순수한 프롬프트 수준 개입입니다.

### <a href="#synergy-with-default-effort" class="header">기본 노력과의 시너지 효과</a>

Ultrathink의 디자인은 Opus 4.6의 기본 `medium` 노력과 완벽하게 결합됩니다.

1. 기본 노력은 `medium`입니다(대부분의 요청에 대한 빠른 응답).
2. 사용자가 깊은 추론이 필요할 때 `ultrathink`를 입력합니다.
3. 애착 시스템은 노력 부스트 메시지를 주입합니다.
4. 모델은 적응적 사고 모드에서 추론 깊이를 높입니다.

이 디자인의 우아함: 사용자는 **의미론적 제어 인터페이스**를 얻습니다. 노력 매개변수의 기술적 세부 사항을 이해할 필요가 없으며 "더 깊은 사고가 필요"할 때 메시지에 `ultrathink`를 쓰기만 하면 됩니다.

### <a href="#rainbow-ui" class="header">레인보우 UI</a>

Ultrathink가 활성화되면 UI에 키워드가 무지개 색상으로 표시됩니다(60-86행).

``` typescript
// utils/thinking.ts:60-68
const RAINBOW_COLORS: Array<keyof Theme> = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
]
```

`getRainbowColor()` 기능은 반짝임 효과를 위한 반짝임 변형 세트와 함께 문자 인덱스를 기반으로 색상을 주기적으로 할당합니다. 이 시각적 피드백을 통해 사용자는 Ultrathink가 인식되고 활성화되었음을 알 수 있습니다.

------------------------------------------------------------------------

## <a href="#215-how-the-three-mechanisms-cooperate" class="header">21.5 세 가지 메커니즘이 어떻게 협력하는가</a>

노력, 빠른 모드 및 사고는 단독으로 작동하지 않습니다. API 호출 경로에서의 상호 작용은 다층 제어판을 형성합니다.

사용자 입력 │ ├─ "ultrathink"가 포함되어 있습니까? | Effort 값 ──► API로 전송된 노력 매개변수 │ ▼ Fast Mode 확인 │ ├─ getFastModeState() = 'on' ──► Opus 4.6으로 라우팅 ├─ getFastModeState() = 'cooldown' ──► 원래 모델 사용 └─ getFastModeState() = 'off' ──► 원래 모델 사용 │ ▼ 생각 구성 │ ├─ modelSupportsAdaptiveThinking()? ──► { type: 'adaptive' } ├─ modelSupportsThinking()? ──► { 유형: '활성화', 예산 토큰: N } └─ 지원되지 않음 ──► { 유형: '비활성화' } │ ▼ API 호출: message.create({ 모델, 노력, 사고, ... })

주요 상호 작용 지점:

- **노력 + 사고**: 노력이 `medium`이고 사고가 `adaptive`인 경우 모델은 더 적은 추론을 선택할 수 있습니다. Ultrathink가 `high`에 대한 노력을 높이면 적응적 사고가 그에 따라 추론 깊이를 높입니다.
- **빠른 모드 + 노력**: 빠른 모드는 모델을 변경하고(Opus 4.6으로 라우팅), 노력은 동일한 모델의 추론 깊이를 변경합니다. 둘은 직교합니다.
- **빠른 모드 + 사고**: 빠른 모드가 요청을 Opus 4.6으로 라우팅하면 해당 모델이 적응형 사고를 지원하므로 사고 구성이 자동으로 업그레이드됩니다.

------------------------------------------------------------------------

## <a href="#216-design-insights" class="header">21.6 디자인 통찰력</a>

**기본값은 "중간"이라는 철학.** Opus 4.6은 Pro 사용자를 위해 직관적인 `high` 대신 `medium` 노력을 기본값으로 설정합니다. 이는 심오한 절충안을 반영합니다. 대부분의 프로그래밍 상호 작용에는 가장 깊은 추론이 필요하지 않으며 기본 노력을 낮추면 처리량이 크게 향상되고 대기 시간이 단축됩니다. 그런 다음 Ultrathink 메커니즘은 **마찰 없는 업그레이드 경로**를 제공합니다. 사용자는 설정을 조정하기 위해 대화 흐름을 떠날 필요가 없으며 문장에 단어만 추가하면 됩니다.

**지연 상태 확인 패턴.** 빠른 모드 쿨다운 만료 감지는 타이머를 사용하지 않고 대신 각 상태 쿼리에 대해 지연 계산을 사용합니다(199-212행). 이 패턴은 Claude Code에서 여러 번 나타납니다. 즉, 쿼리 빈도에 따른 상태 전환 시간 정밀도를 희생하면서 타이머 리소스 오버헤드와 경쟁 조건을 방지합니다. UI 기반 시스템의 경우 이 비용은 사실상 0입니다.

**3계층 기능 감지 구조.** `modelSupportsThinking` -\> `modelSupportsAdaptiveThinking` -\> `shouldEnableThinkingByDefault`는 "사용 가능 여부"에서 "활성화 여부"까지의 의사 결정 체인을 형성합니다. 각 계층은 다양한 요소(모델 기능, 공급자 차이, 사용자 선호도)를 고려하며 각 계층에는 "책임자에게 알리지 않고 수정하지 마십시오"라는 명시적인 경고 설명이 포함됩니다. 이 다층 보호는 모델 품질에 대한 추론 구성의 민감도를 반영합니다. 즉, 부주의한 기본값 변경으로 인해 전체 사용자 기반의 경험이 저하될 수 있습니다.

**신중한 지속성 경계.** 외부 사용자에 대한 `max` 노력이 지속되지 않음, 수치적 노력이 지속되지 않음, 빠른 모드의 세션당 옵트인 옵션 - 이러한 설계 선택은 모두 동일한 원칙을 따릅니다. **고비용 구성은 세션 전체에서 누출되어서는 안 됩니다**. 한 세션에서 `max`를 활성화하는 사용자는 의식적인 선택입니다. 그러나 그 선택이 조용히 다음 세션으로 넘어간다면 그것은 잊혀진 자원 낭비가 될 수 있습니다.

------------------------------------------------------------------------

## <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

**작업 복잡성에 맞게 추론 깊이 조정:**

1. **추론 수준을 조정하려면 `/effort` 명령을 사용하십시오.** 간단한 코드 변경(변수 이름 바꾸기, 설명 추가)의 경우 `/effort low`는 대기 시간을 크게 줄일 수 있습니다. 복잡한 아키텍처 결정 또는 버그 조사의 경우 `/effort high` 또는 `max`(Opus 4.6만 해당)가 더 심층적인 분석을 제공합니다.

2. **심층 추론을 트리거하려면 메시지에 `ultrathink`를 입력하세요.** `medium`에서 기본 노력으로 Opus 4.6을 사용할 때 `ultrathink` 키워드를 추가하면 일시적으로 `high` 수준 추론이 향상됩니다. 설정을 조정하기 위해 대화 흐름을 종료할 필요가 없습니다.

3. **환경 변수를 통한 수정 노력.** 팀이 통합된 추론 전략을 갖고 있는 경우 `.env` 또는 시작 스크립트에서 `CLAUDE_CODE_EFFORT_LEVEL=high`를 설정하세요. `unset` 또는 `auto`로 설정하면 노력 매개변수를 완전히 건너뛰어 API가 서버측 기본값을 사용할 수 있게 됩니다.

4. **빠른 모드의 쿨다운 메커니즘을 이해합니다.** 빠른 모드(Opus 4.6 가속)가 속도 제한으로 인해 쿨다운에 들어가면 시스템이 자동으로 원래 모델로 돌아갑니다. 쿨다운은 일시적이며 만료 시 자동 복구되므로 수동 개입이 필요하지 않습니다.

5. **사고 모드와 모델 일치에 유의하세요.** Opus 4.6 및 Sonnet 4.6은 `adaptive` 사고 모드(모델이 사고 깊이 자체를 결정함)를 지원하는 반면, 이전 Claude 4 모델은 고정 예산 모드를 사용합니다. 적응적 사고를 강제로 비활성화하려면 환경 변수 `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=true`를 설정합니다.

6. **`max` 작업은 여러 세션에 걸쳐 지속되지 않습니다.** 이는 잊어버린 `max`가 장기적으로 과도한 리소스를 소모하는 것을 방지하도록 설계된 것입니다. 각각의 새 세션은 모델 기본값으로 복원됩니다.

------------------------------------------------------------------------

## <a href="#version-evolution-v2191-changes" class="header">버전 진화: v2.1.91 변경 사항</a>

> 다음 분석은 v2.1.88 소스 코드 추론과 결합된 v2.1.91 번들 신호 비교를 기반으로 합니다.

### <a href="#agent-cost-control" class="header">에이전트 비용 관리</a>

v2.1.91에는 `CLAUDE_CODE_AGENT_COST_STEER` 환경 변수가 추가되어 하위 에이전트 비용 조정 메커니즘 도입을 제안합니다. 새로운 `tengu_forked_agent_default_turns_exceeded` 이벤트와 결합된 v2.1.91은 다중 에이전트 시나리오에서 보다 세부적인 비용 제어를 제공합니다. 즉, 개별 에이전트 생각 예산(이 장에 설명됨)을 제한할 뿐만 아니라 전체 수준에서 리소스 소비를 조정합니다.

------------------------------------------------------------------------

## <a href="#version-evolution-v21100--advisor-tool" class="header">버전 발전: v2.1.100 — Advisor 도구</a>

> 다음 분석은 v2.1.88 소스 코드 추론과 결합된 v2.1.100 번들 신호 비교를 기반으로 합니다.

### <a href="#advisor-strong-model-reviewing-weak-model"
class="header">Advisor: 약한 모델을 검토하는 강력한 모델</a>

v2.1.100에는 더 강력한 검토자 모델이 현재 작업 모델의 출력을 검토하는 서버 측 도구(`server_tool_use`)인 Advisor 도구가 도입되었습니다. 이는 추론 깊이 제어의 완전히 새로운 차원입니다. 동일한 모델의 사고 깊이를 변경하기 위해 노력 매개변수를 조정하는 대신 **검토자로서 독립적이고 강력한 모델**을 도입합니다.

**핵심 메커니즘**:

Advisor는 매개변수가 없는 도구로 등록합니다. `advisor()`를 호출하면 입력이 필요하지 않으며 시스템은 자동으로 전체 대화 기록을 검토자 모델에 전달합니다. 번들에서 추출된 도구 설명:

``` text
# Advisor Tool
You have access to an `advisor` tool backed by a stronger reviewer model.
It takes NO parameters -- when you call advisor(), your entire conversation
history is automatically forwarded.
```

**호출 규칙**(번들의 조언자 프롬프트에서 추출):

1. **실질적인 작업 전에 전화하세요**: "실질적인 작업 전에 조언자에게 전화하세요 — 쓰기 전, 커밋하기 전에"
2. **경량 탐색은 제외**: "오리엔테이션은 실질적인 작업이 아닙니다. 쓰기, 편집 및 커밋은"입니다.
3. **긴 작업의 경우 최소 두 번**: "몇 단계보다 긴 작업의 경우 접근 방식을 결정하기 전에 최소 한 번, 마무리하기 전에 Advisor에게 한 번 호출하세요."
4. **충돌 처리**: "이미 한 방향을 가리키는 데이터를 검색했고 조언자가 다른 방향을 가리키는 경우: 자동으로 전환하지 마십시오. 충돌을 표면화합니다."

**모델 선택 및 기능 게이트**:

``` javascript
// v2.1.100 bundle reverse engineering
// Feature gate
UZ1 = "advisor-tool-2026-03-01"

// Model compatibility checks
if (!OR6(K)) {
  N("[AdvisorTool] Skipping advisor - base model does not support advisor");
  return;
}
if (!O88(_)) {
  N("[AdvisorTool] Skipping advisor - not a valid advisor model");
  return;
}
```

Advisor 모델은 `advisorModel` 구성 필드를 통해 지정되며 두 가지 조건, 즉 기본 모델이 Advisor(`OR6`)를 지원하고 지정된 Advisor 모델이 유효함(`O88`)을 충족해야 합니다. 일반적인 구성은 약한 모델 작동 + 강력한 모델 검토일 가능성이 높지만 정확한 모델 일치 규칙은 내부 기능 `OR6` 및 `O88`에 의해 제어되며 번들에서 정확하게 재구성할 수 없습니다.

**노력과의 관계**:

Advisor는 노력을 대체하지 않으며 다양한 차원의 문제를 해결합니다.

<div class="table-wrapper">

| 차원 | 노력 | 고문 |
|----|----|----|
| 제어 대상 | 같은 모델의 사고 깊이 | 다른 모델의 리뷰를 소개합니다 |
| 비용 모델 | 통화당 더 많은 사고 토큰 | 독립적인 전체 API 호출 |
| 숨어 있음 | 현재 응답 대기 시간 증가 | 상담원 통화에는 추가 시간이 필요합니다 |
| 사용 사례 | 단일 단계 복잡한 추론 | 다단계 작업 전반에 걸친 방향 검증 |

</div>

**에이전트 빌더를 위한 통찰력**: Advisor 패턴은 "검토 중심 개발" 에이전트 아키텍처를 제안합니다. 즉, 중요한 결정 지점에서 값비싼 모델을 게이트키핑하여 저렴한 모델이 일상적인 작업을 처리하도록 합니다. 이는 가장 강력한 모델을 균일하게 사용하는 것보다 경제적이며, 약한 모델에만 의존하는 것보다 안전합니다.
