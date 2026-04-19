# <a href="#chapter-7-model-specific-tuning-and-ab-testing"
class="header">7장: 모델별 튜닝 및 A/B 테스트</a>

> 6장에서는 시스템 프롬프트가 어떻게 구성되어 있는지 살펴보았습니다.
> 명령 세트가 모델로 전송됩니다. 그러나 동일한 프롬프트는 적합하지 않습니다.
> 모든 모델 - 각 모델 세대에는 고유한 행동 경향이 있습니다.
> Anthropic의 내부 사용자는 새로운 모델을 테스트하고 검증해야 합니다.
> 외부 사용자보다 빠릅니다. 이 장에서는 Claude Code가 어떻게
> 모델별 프롬프트 튜닝, 내부 A/B 테스트 및 안전성 확보
> `@[MODEL LAUNCH]`을 통한 공개 저장소 기여
> 주석 시스템, `USER_TYPE === 'ant'` 게이팅, GrowthBook 기능
> 깃발 및 Undercover 모드.

## <a href="#71-model-launch-checklist-model-launch-annotations"
class="header">7.1 모델 출시 체크리스트: <code>@[MODEL LAUNCH]</code>
주석</a>

Claude Code의 코드베이스 전체에 걸쳐 특별한 주석 표시가 있습니다.
뿔뿔이 흩어진:

``` typescript
// @[MODEL LAUNCH]: Update the latest frontier model.
const FRONTIER_MODEL_NAME = 'Claude Opus 4.6'
```

**출처 참조:** `constants/prompts.ts:117-118`

이러한 `@[MODEL LAUNCH]` 주석은 일반적인 주석이 아닙니다. 그들은 형성한다
**분산 체크리스트** -- 새 모델 출시 준비가 되면
엔지니어는 코드베이스에서 `@[MODEL LAUNCH]`을 전역적으로 검색하면 됩니다.
업데이트가 필요한 모든 위치를 찾으려면 이 디자인에는 릴리스가 포함되어 있습니다.
외부에 의존하지 않고 코드 자체에 지식을 처리합니다.
선적 서류 비치.

`prompts.ts`에서 `@[MODEL LAUNCH]`은 다음 키 업데이트를 표시합니다.
전철기:

<div class="table-wrapper">

| 라인 | 내용 | 업데이트 작업 |
|----|----|----|
| 117 | `FRONTIER_MODEL_NAME` 상수 | 새 모델의 시장명 업데이트 |
| 120 | `CLAUDE_4_5_OR_4_6_MODEL_IDS` 객체 | 각 계층의 모델 ID 업데이트 |
| 204 | 과잉 주석 완화 지침 | 새 모델에 여전히 이러한 완화가 필요한지 평가 |
| 210 | 철저 균형추 | 개미 전용 게이트를 해제할 수 있는지 평가 |
| 224 | 자기주장 균형추 | 개미 전용 게이트를 해제할 수 있는지 평가 |
| 237 | 허위 주장 완화 지침 | 신모델 FC율 평가 |
| 712 | `getKnowledgeCutoff` 기능 | 새 모델의 지식 마감일 추가 |

</div>

`antModels.ts`에서:

<div class="table-wrapper">

| 라인 | 내용 | 업데이트 작업 |
|----|----|----|
| 32 | `tengu_ant_model_override` | 기능 플래그에서 Ant 전용 모델 목록 업데이트 |
| 33 | `excluded-strings.txt` | 외부 빌드로의 유출을 방지하기 위해 새 모델 코드명 추가 |

</div>

이 패턴의 우아함은 **자체 문서화** 특성에 있습니다.
주석 텍스트 자체가 작업 지침 역할을 합니다. 을 위한
예를 들어 204행의 주석에는 리프트가 명시적으로 명시되어 있습니다.
조건: "모델이 과잉 주석을 중단하면 제거하거나 부드럽게 합니다.
기본값." 엔지니어는 외부 운영 매뉴얼을 참조할 필요가 없습니다.
-- 조건과 동작이 모두 코드 바로 옆에 기록됩니다.

## <a href="#72-capybara-v8-behavior-mitigations" class="header">7.2
Capybara v8 동작 완화</a>

각 모델 세대에는 고유한 "성격 결함"이 있습니다. 클로드 코드의
소스 코드에는 Capybara v8에 대해 알려진 네 가지 문제가 문서화되어 있습니다(중 하나는
Claude 4.5/4.6 시리즈의 내부 코드명)
각각에 대한 프롬프트 수준 완화.

### <a href="#721-over-commenting" class="header">7.2.1 과잉 주석</a>

**문제:** Capybara v8은 불필요한 주석을 과도하게 추가하는 경향이 있습니다.
암호.

**완화(204-209행):**

``` typescript
// @[MODEL LAUNCH]: Update comment writing for Capybara —
// remove or soften once the model stops over-commenting by default
...(process.env.USER_TYPE === 'ant'
  ? [
      `Default to writing no comments. Only add one when the WHY is
       non-obvious...`,
      `Don't explain WHAT the code does, since well-named identifiers
       already do that...`,
      `Don't remove existing comments unless you're removing the code
       they describe...`,
    ]
  : []),
```

**출처 참조:** `constants/prompts.ts:204-209`

이러한 지시문은 세련된 주석 작성 철학을 형성합니다.
코멘트를 작성하지 말고 "이유"가 분명하지 않은 경우에만 추가하십시오. ~하지 않다
코드가 수행하는 작업을 설명합니다(식별자는 이미 해당 작업을 수행함). 제거하지 마세요
당신이 이해하지 못하는 기존 댓글. 세 번째의 미묘함에 주목하세요
지시문 - 모델이 과도하게 설명하는 것을 방지하고
귀중한 기존 댓글을 삭제하여 과잉 수정을 방지합니다.

### <a href="#722-false-claims" class="header">7.2.2 허위 주장</a>

**문제:** Capybara v8의 허위 청구율(FC rate)은 29~30%이며,
v4의 16.7%보다 훨씬 높습니다.

**완화(237-241행):**

``` typescript
// @[MODEL LAUNCH]: False-claims mitigation for Capybara v8
// (29-30% FC rate vs v4's 16.7%)
...(process.env.USER_TYPE === 'ant'
  ? [
      `Report outcomes faithfully: if tests fail, say so with the
       relevant output; if you did not run a verification step, say
       that rather than implying it succeeded. Never claim "all tests
       pass" when output shows failures...`,
    ]
  : []),
```

**출처 참조:** `constants/prompts.ts:237-241`

이 완화 지침의 설계는 대칭적 사고를 구현합니다.
모델이 성공을 거짓으로 보고하지 않도록 요구할 뿐만 아니라
지나치게 자기 의심을 하지 말라고 명시적으로 요구합니다.
검사가 통과되었거나 작업이 완료되었음을 명확하게 기술하십시오. 위험을 회피하지 마십시오.
불필요한 면책 조항으로 결과를 확인했습니다." 엔지니어들은
모델에게 "거짓말하지 마세요"라고 말하면 모델이 흔들리는 것을 발견했습니다.
다른 극단적인 방법으로는 모든 결과에 불필요한 면책 조항을 추가하는 것입니다. 그만큼
완화 목표는 **방어적인 보고가 아닌 정확한 보고**입니다.

### <a href="#723-over-assertiveness" class="header">7.2.3
지나친 주장</a>

**문제:** Capybara v8은 단순히 사용자 명령을 실행하는 경향이 있습니다.
자신의 판단을 제시하지 않고.

**완화(224-228행):**

``` typescript
// @[MODEL LAUNCH]: capy v8 assertiveness counterweight (PR #24302)
// — un-gate once validated on external via A/B
...(process.env.USER_TYPE === 'ant'
  ? [
      `If you notice the user's request is based on a misconception,
       or spot a bug adjacent to what they asked about, say so.
       You're a collaborator, not just an executor...`,
    ]
  : []),
```

**출처 참조:** `constants/prompts.ts:224-228`

주석의 "PR \#24302"는 이 완화 조치가 도입되었음을 나타냅니다.
코드 검토 프로세스를 통해 "외부에서 검증된 후에는 게이트를 해제합니다.
A/B를 통해"는 완전한 릴리스 전략을 보여줍니다. 먼저 검증
내부 사용자(ant), A/B를 통해 외부 사용자에게 출시
데이터 수집 후 테스트.

### <a href="#724-lack-of-thoroughness" class="header">7.2.4 부족함
철저함</a>

**문제:** Capybara v8은 없이 작업 완료를 주장하는 경향이 있습니다.
결과를 확인 중입니다.

**완화(210-211행):**

``` typescript
// @[MODEL LAUNCH]: capy v8 thoroughness counterweight (PR #24302)
// — un-gate once validated on external via A/B
`Before reporting a task complete, verify it actually works: run the
 test, execute the script, check the output. Minimum complexity means
 no gold-plating, not skipping the finish line.`,
```

**출처 참조:** `constants/prompts.ts:210-211`

이 지시문의 마지막 문장은 특히 미묘합니다.
확인할 수 없음(테스트가 존재하지 않으며 코드를 실행할 수 없음), 명시적으로 말함
성공을 주장하기보다는." 상황이 있음을 인정합니다.
검증은 불가능하지만 모델이 명시적으로 다음을 수행해야 하는 경우
모든 것이 괜찮은 척하기보다는 이를 인정하십시오.

### <a href="#725-mitigation-lifecycle" class="header">7.2.5 완화
수명주기</a>

네 가지 완화는 통합된 수명 주기 패턴을 공유합니다.

``` mermaid
flowchart LR
    A["Discover behavioral issue\n(FC rate, etc.)"] --> B["PR introduces mitigation\n(PR #24302)"]
    B --> C["ant-only gating\ninternal validation"]
    C --> D["A/B test validation\nexternal rollout"]
    D --> E{"New model launch\n@[MODEL LAUNCH]\nre-evaluate"}
    E -->|"Issue fixed"| F["Remove mitigation"]
    E -->|"Issue persists"| G["Keep/adjust"]
    E -->|"Lift ant-only"| H["Full rollout"]

    style A fill:#f9d,stroke:#333
    style D fill:#9df,stroke:#333
    style F fill:#dfd,stroke:#333
    style H fill:#dfd,stroke:#333
```

**그림 7-1: 모델 완화의 전체 수명주기.** 문제에서
내부 검증을 통해 발견부터 완화 도입까지
A/B 테스트, 다음 `@[MODEL LAUNCH]` 재평가로 마무리됩니다.

## <a href="#73-user_type--ant-gating-the-internal-ab-testing-staging-area"
class="header">7.3 <code>USER_TYPE === 'ant'</code> 게이팅: 내부
A/B 테스트 준비 영역</a>

위의 네 가지 완화 방법은 모두 동일한 조건으로 래핑됩니다.

``` typescript
process.env.USER_TYPE === 'ant'
```

이 환경 변수는 런타임에 읽혀지지 않습니다. **빌드 타임입니다.
끊임없는**. 소스 코드 주석은 이 중요한 컴파일러를 설명합니다.
계약:

DCE: `process.env.USER_TYPE === 'ant'`은 빌드 시간 --define입니다.
각 호출 사이트에서 인라인되어야 합니다(const로 끌어올려지지 않음).
번들러는 외부 빌드에서 이를 `false`로 계속 접을 수 있으며
지점을 제거하십시오.

**출처 참조:** `constants/prompts.ts:617-619`

이 의견은 우아한 DCE(Dead Code Elimination) 메커니즘을 보여줍니다.

1. **빌드 타임 교체**: 번들러의 `--define` 옵션이
`process.env.USER_TYPE`을 컴파일 타임에 문자열 리터럴로 사용합니다.
2. **지속적인 폴딩**: 외부 빌드의 경우 `'external' === 'ant'`은
`false`으로 접었습니다.
3. **분기 제거**: `false` 조건이 있는 분기는 완전히
모든 문자열 내용을 포함하여 제거되었습니다.
4. **인라인 요구 사항**: 각 호출 사이트는 직접 작성해야 합니다.
`process.env.USER_TYPE === 'ant'`; 로 추출할 수 없습니다.
변수이거나 번들러가 상수 폴딩을 수행할 수 없습니다.

이는 **ant 전용 코드가 외부 사용자에게 물리적으로 존재하지 않음을 의미합니다.
아티팩트**를 빌드합니다. 런타임 권한 확인은 아니지만
컴파일 타임 코드 제거. 외부 빌드를 디컴파일하는 경우에도
Capybara와 같은 내부 코드명이나 특정 문구는 공개하지 않습니다.
완화의.

### <a href="#731-complete-ant-only-gating-inventory" class="header">7.3.1
개미 전용 게이팅 인벤토리 완료</a>

다음 표에는 `prompts.ts`에 의해 제어되는 모든 콘텐츠가 나열되어 있습니다.
`USER_TYPE === 'ant'`:

<div class="table-wrapper">

| 라인 범위 | 기능 설명 | 제한 콘텐츠 | 리프트 상태 |
|----|----|----|----|
| 136-139 | 개미 모델 재정의 섹션 | `getAntModelOverrideSection()` -- 시스템 프롬프트에 개미 관련 접미사를 추가합니다 | 고정된 조건이 아닌 기능 플래그에 의해 제어됨 |
| 205-209 | 과잉 주석 완화 | 세 가지 논평 철학 지침 | 새 모델은 기본적으로 더 이상 과잉 설명을 하지 않습니다 |
| 210-211 | 철저한 완화 | 작업 완료 지시어 확인 | A/B 테스트를 통해 검증된 후 외부로 출시됨 |
| 225-228 | 자기 주장 완화 | 실행자가 아닌 협력자 지시어 | A/B 테스트를 통해 검증된 후 외부로 출시됨 |
| 238-241 | 허위 주장 완화 | 정확한 결과 보고 지침 | 신모델 FC비율은 수용 가능한 수준으로 하락 |
| 243-246 | 내부 피드백 채널 | `/issue` 및 `/share` 명령 권장 사항 및 내부 Slack 채널로 전송 제안 | 내부 사용자만 해제되지 않습니다 |
| 621 | Undercover 모델 설명 억제 | 시스템 프롬프트에서 모델 이름 및 ID 억제 | Undercover 모드가 활성화된 경우 |
| 660 | Undercover 단순화된 모델 설명 억제 | 위와 동일, 단순화된 프롬프트 버전 | Undercover 모드가 활성화된 경우 |
| 694-702 | Undercover 모델군 정보 억제 | 최신 모델 목록, Claude Code 플랫폼 정보, 빠른 모드 설명 억제 | Undercover 모드가 활성화된 경우 |

</div>

**표 7-1: `prompts.ts`에서 개미 전용 게이팅 인벤토리를 완료합니다.** 각각
게이트에는 명확한 리프트 조건이 있어 점진적인 릴리스 파이프라인을 형성합니다.
내부 검증부터 외부 출시까지.

`getAntModelOverrideSection`(136-139행)은 특별한 주의를 기울일 가치가 있습니다.

``` typescript
function getAntModelOverrideSection(): string | null {
  if (process.env.USER_TYPE !== 'ant') return null
  if (isUndercover()) return null
  return getAntModelOverrideConfig()?.defaultSystemPromptSuffix || null
}
```

**이중 게이팅**이 있습니다. 사용자가 내부에 있어야 할 뿐만 아니라
또한 Undercover 모드에 있어서는 안 됩니다. 이 디자인은 심지어
내부 사용자는 다음과 같은 경우 내부 모델 구성을 유출하지 않습니다.
공개 저장소에 기여합니다.

## <a href="#74-undercover-mode-stealth-in-public-repositories"
class="header">7.4 비밀 모드: 공개 저장소의 스텔스</a>

Undercover 모드는 Claude Code의 가장 독특한 기능 중 하나입니다. 그것은 해결한다
매우 구체적인 문제: Anthropic 내부 엔지니어가 Claude를 사용할 때
공개/오픈 소스 저장소에 기여하는 코드, 내부 없음
정보가 유출되어야 합니다.

### <a href="#741-activation-logic" class="header">7.4.1 활성화
논리</a>

``` typescript
export function isUndercover(): boolean {
  if (process.env.USER_TYPE === 'ant') {
    if (isEnvTruthy(process.env.CLAUDE_CODE_UNDERCOVER)) return true
    return getRepoClassCached() !== 'internal'
  }
  return false
}
```

**출처 참조:** `utils/undercover.ts:28-37`

활성화 규칙에는 세 가지 수준이 있습니다.

1. **강제 실행**: `CLAUDE_CODE_UNDERCOVER=1` 환경 설정
내부 저장소에서도 변수가 강제로 활성화됩니다.
2. **자동 감지**: 현재 저장소의 원격 주소가
내부 화이트리스트에 없으면 자동으로 활성화됩니다.
`'external'`, `'none'` 및 `null`(확인이 아직 실행되지 않음) 모두
"켜기"로 결정하세요.
3. **강제로 끌 수 없음**: 설계상 강제로 끌 수 있는 옵션은 없습니다.
끄다. 소스 코드 주석은 다음과 같이 설명합니다. "이것은 모델을 보호합니다.
코드명 누출 - 내부 저장소에 있는지 확신할 수 없는 경우
우리는 비밀리에 지내요."

이 "안전한 기본값은 켜져 있습니다"라는 디자인 철학은 깊이 생각해 볼 가치가 있습니다.
내부 저장소에 불필요하게 정보를 숨기는 것보다
공공 장소에서는 누출 위험이 있습니다.

### <a href="#742-suppression-scope" class="header">7.4.2 억제
범위</a>

언더커버 모드가 활성화되면 다음과 같은 제압 작전이 수행됩니다.
실행됩니다:

┌────────────────────────────────────────────────────────────────┐
│ 언더커버 모드 작업 흐름 │
│ │
│ ┌─────────────────┐ │
│ │ isUndercover() │──── false ────▶ 일반 모드 (모델 정보 표시) │
│ │는 true를 반환합니다. │ │
│ └────────┬────────┘ │
│ │ 사실 │
│ ▼ │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ 억제 계층 1: 시스템 프롬프트 │ │
│ │ │ │
│ │ 계산EnvInfo(L621): │ │
│ │ modelDescription = '' ← 모델 이름/ID가 완전히 지워졌습니다. │ │
│ │ │ │
│ │ 계산SimpleEnvInfo (L660): │ │
│ │ modelDescription = null ← 환경 정보에서 제거됨 │ │
│ │ │ │
│ │ 모델 제품군 목록(L694-696): │ │
│ │ null ← Opus/Sonnet/Haiku ID 목록이 표시되지 않음 │ │
│ │ │ │
│ │ Claude Code 플랫폼 정보(L697-699): │ │
│ │ null ← CLI/데스크탑/웹/IDE 정보가 표시되지 않음 │ │
│ │ │ │
│ │ 고속 모드 설명(L700-702): │ │
│ │ null ← 동일 모델 사용에 대한 설명은 표시되지 않음 │ │
│ │ │ │
│ │ getAntModelOverrideSection (L138): │ │
│ │ null 반환 ← 개미 모델 재정의 접미사가 삽입되지 않음 │ │
│ └────────────────────────────────────────────────────────────┘ │ │
│ │ │
│ ▼ │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ 억제 계층 2: 속성 │ │
│ │ │ │
│ │ getAttributionTexts(): │ │
│ │ return { 커밋: '', pr: '' } │ │
│ │ ← 공동 작성자 라인이 생성되지 않음 │ │
│ │ ← PR 설명에 AI 도구 속성이 없음 │ │
│ └────────────────────────────────────────────────────────────┘ │ │
│ │ │
│ ▼ │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ 억제 계층 3: 행동 지시어 │ │
│ │ │ │
│ │ getUndercoverInstructions(): │ │
│ │ 자세한 누출 방지 지시문을 삽입합니다. │ │
│ │ - 내부 모델 코드명(카피바라, 텐구 등) 금지 │ │
│ │ - 미출시 모델 버전 번호 금지 │ │
│ │ - 내부 저장소/프로젝트 이름 금지 │ │
│ │ - 내부 도구, Slack 채널, 짧은 링크 금지 │ │
│ │ - "Claude Code" 텍스트 또는 AI 신원 힌트 금지 │ │
│ │ - 공동 저작자 귀속 금지 │ │
│ │ - 인간 개발자처럼 작성된 커밋 메시지 필요 │ │
│ └────────────────────────────────────────────────────────────┘ │ │
└────────────────────────────────────────────────────────────────┘

**그림 7-2: Undercover 모드의 3단계 억제 작업흐름.**
시스템은 행동 지시에 대한 귀인을 촉구하여
완벽한 정보 유출 방어.

소스 코드 주석(612-615행)은 억제 이유를 설명합니다.
범위가 너무 넓습니다.

Undercover: 모든 모델 이름/ID를 시스템 프롬프트에서 제외하여
내부의 어떤 것도 공개 커밋/PR로 유출될 수 없습니다. 여기에는 다음이 포함됩니다.
공개 FRONTIER_MODEL_* 상수 — 해당 상수가
예고되지 않은 모델이기 때문에 우리는 이러한 모델이 맥락에 포함되는 것을 원하지 않습니다. 완전히 어두워지세요.

"완전히 어두워집니다" -- 심지어 공개 상수(예: `FRONTIER_MODEL_NAME`)
왜냐하면 이 상수가 아직 발표되지 않은 변수를 가리키는 경우
모델 자체가 누출 원인이 됩니다.

### <a href="#743-undercover-instruction-examples" class="header">7.4.3
잠복 지시 예시</a>

`getUndercoverInstructions()` 함수(`utils/undercover.ts:39-69`)
자세한 누출 방지 지침을 주입합니다. 두 가지를 모두 사용하여 모델을 교육합니다.
긍정적이고 부정적인 예:

**좋은 커밋 메시지:**

- "파일 감시자 초기화 시 경쟁 조건 수정"
- "사용자 정의 키 바인딩에 대한 지원 추가"

**절대 쓰지 말아야 할 내용:**

- "Claude Capybara로 테스트하는 동안 발견된 버그 수정"
- "claude-opus-4-6의 1샷"
- "클로드 코드로 생성됨"

이러한 긍정적/부정적 예시를 나란히 가르치는 접근 방식은
단순한 금지 목록보다 효과적입니다. 이는 모델에 정보를 제공할 뿐만 아니라
"하지 말아야 할 것"뿐만 아니라 "해야 할 것"도 보여줍니다.

### <a href="#744-auto-notification-mechanism" class="header">7.4.4
자동 알림 메커니즘</a>

Undercover 모드가 처음 자동 활성화되면 Claude Code는 다음을 표시합니다.
일회성 설명 대화 상자(`shouldShowUndercoverAutoNotice`, 줄
80-88). 확인 논리는 사용자가 반복적으로 방해를 받지 않도록 보장합니다.
강제로 설정한 사람(환경 변수를 통해)은 알림을 볼 수 없습니다.
(그들은 이미 알고 있음), 이미 알림을 본 사용자
다시는 볼 수 없습니다. 이 플래그는 전역 구성의
`hasSeenUndercoverAutoNotice` 필드.

## <a href="#75-growthbook-integration-the-tengu_-feature-flag-system"
class="header">7.5 GrowthBook 통합: <code>tengu_*</code>
기능 플래그 시스템</a>

### <a href="#751-architecture-overview" class="header">7.5.1 아키텍처
개요</a>

Claude Code는 GrowthBook을 기능 플래그 및 실험으로 사용합니다.
플랫폼. 모든 기능 플래그는 `tengu_*` 명명 규칙을 따릅니다.
"tengu"는 클로드 코드의 내부 코드명입니다.

GrowthBook 클라이언트 초기화 및 기능값 검색은 다음을 따릅니다.
신중하게 설계된 다중 계층 폴백 메커니즘:

우선순위(높음에서 낮음):
1. 환경 변수 재정의(CLAUDE_INTERNAL_FC_OVERRIDES) — 개미 전용
2. 로컬 구성 재정의(/config Gates 패널) — 개미 전용
3. 메모리 내 원격 평가 값(remoteEvalFeatureValues)
4. 디스크 캐시(cachedGrowthBookFeatures)
5. 기본값(defaultValue 매개변수)

핵심가치검색기능은
`getFeatureValue_CACHED_MAY_BE_STALE`(`growthbook.ts:734-775`). 그것으로
이름 상태에 따르면, 이 함수에 의해 반환된 값은 **오래되었을 수 있습니다** --
메모리나 디스크 캐시에서 먼저 읽고, 기다리기 위해 차단하지 않습니다.
네트워크 요청. 이것은 의도적인 디자인 결정입니다. 시작 시
중요 경로, 오래되었지만 사용 가능한 값이 UI가 고정된 것보다 낫습니다.
네트워크를 기다리고 있습니다.

``` typescript
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  feature: string,
  defaultValue: T,
): T {
  // 1. Environment variable override
  const overrides = getEnvOverrides()
  if (overrides && feature in overrides) return overrides[feature] as T
  // 2. Local config override
  const configOverrides = getConfigOverrides()
  if (configOverrides && feature in configOverrides)
    return configOverrides[feature] as T
  // 3. In-memory remote evaluation value
  if (remoteEvalFeatureValues.has(feature))
    return remoteEvalFeatureValues.get(feature) as T
  // 4. Disk cache
  const cached = getGlobalConfig().cachedGrowthBookFeatures?.[feature]
  return cached !== undefined ? (cached as T) : defaultValue
}
```

**출처 참조:** `services/analytics/growthbook.ts:734-775`

### <a href="#752-remote-evaluation-and-local-cache-sync"
class="header">7.5.2 원격 평가 및 로컬 캐시 동기화</a>

GrowthBook은 `remoteEval: true` 모드를 사용합니다. -- 기능 값은 다음과 같습니다.
사전 평가된 서버 측, 클라이언트는 결과만 캐시하면 됩니다.
`processRemoteEvalPayload` 함수(`growthbook.ts:327-394`)가 실행됩니다.
각 초기화 및 주기적 새로 고침 시 서버 반환 쓰기
사전 평가된 값을 두 저장소에 전달합니다.

1. **인메모리 맵**(`remoteEvalFeatureValues`): 빠른 읽기를 위해
프로세스 수명.
2. **디스크 캐시**(`syncRemoteEvalToDisk`, 407-417행):
프로세스 간 지속성.

디스크 캐시는 **병합보다는 전체 교체** 전략을 사용합니다.
서버 측에서 삭제된 기능은 디스크에서 지워집니다. 이는 다음을 보장합니다.
디스크 캐시는 항상 서버 상태의 완전한 스냅샷입니다.
끊임없이 축적되는 역사적 퇴적물.

소스 코드 주석(322-325행)은 과거의 실패를 기록합니다.

새로 고침 시 이를 실행하지 않으면 RemoteEvalFeatureValues가 다음 위치에서 정지됩니다.
초기화 시간 스냅샷 및 getDynamicConfig_BLOCKS_ON_INIT 반환
전체 프로세스 수명 동안 오래된 값으로 인해
tengu_max_version_config 장기 실행 세션을 위한 킬 스위치.

이 킬 스위치 실패는 주기적인 새로 고침이 중요한 이유를 보여줍니다.
초기화 시 값을 한 번만 읽는 경우 장기 실행 세션
긴급한 원격 구성 변경에는 응답할 수 없습니다.

### <a href="#753-experiment-exposure-tracking" class="header">7.5.3
실험 노출 추적</a>

GrowthBook의 A/B 테스트 기능은 실험 노출에 따라 달라집니다.
추적. `logExposureForFeature` 함수(296-314행)는 기록합니다.
이후 특성 값에 액세스할 때 노출 이벤트
실험 분석. 주요 디자인:

- **세션 수준 중복 제거**: `loggedExposures` 세트는 다음을 보장합니다.
각 기능은 세션당 최대 한 번만 기록되므로
핫 경로(예: 렌더 루프)의 빈번한 호출에서 이벤트를 복제합니다.
- **지연 노출**: GrowthBook 이전에 기능에 액세스한 경우
초기화가 완료되면 `pendingExposures` 세트는 이를 저장합니다.
액세스하고 초기화가 완료되면 소급하여 기록합니다.

### <a href="#754-known-tengu_-feature-flags" class="header">7.5.4 알려진
<code>tengu_*</code> 기능 플래그</a>

다음 `tengu_*` 기능 플래그는 다음에서 식별할 수 있습니다.
코드베이스:

<div class="table-wrapper">

| 플래그 이름 | 목적 | 검색 방법 |
|----|----|----|
| `tengu_ant_model_override` | Ant 전용 모델 목록, 기본 모델, 시스템 프롬프트 접미사 구성 | `_CACHED_MAY_BE_STALE` |
| `tengu_1p_event_batch_config` | 자사 이벤트 일괄 처리 구성 | `onGrowthBookRefresh` |
| `tengu_event_sampling_config` | 이벤트 샘플링 구성 | `_CACHED_MAY_BE_STALE` |
| `tengu_log_datadog_events` | Datadog 이벤트 로깅 게이트 | `_CACHED_MAY_BE_STALE` |
| `tengu_max_version_config` | 최대 버전 킬 스위치 | `_BLOCKS_ON_INIT` |
| `tengu_frond_boric` | 싱크 마스터 스위치(킬 스위치) | `_CACHED_MAY_BE_STALE` |
| `tengu_cobalt_frost` | Nova 3 음성 인식 게이트 | `_CACHED_MAY_BE_STALE` |

</div>

일부 플래그는 난독화된 이름(예: `tengu_frond_boric`)을 사용합니다.
이는 보안상의 고려 사항입니다. 플래그 이름이 외부인 경우에도 마찬가지입니다.
관찰해보면 그 목적을 추론할 수 없다.

### <a href="#755-environment-variable-override-the-eval-harness-backdoor"
class="header">7.5.5 환경 변수 재정의: 평가 하네스
백도어</a>

`CLAUDE_INTERNAL_FC_OVERRIDES` 환경 변수
(`growthbook.ts:161-192`)는 모든 기능 플래그 값을 재정의할 수 있습니다.
GrowthBook 서버에 연결하지 않고. 이 메커니즘은
평가 하네스용으로 특별히 설계되었습니다. 자동화된 테스트는 다음을 수행해야 합니다.
결정론적 조건에서 실행되며 상태에 의존할 수 없습니다.
원격 서비스.

``` typescript
// Example: CLAUDE_INTERNAL_FC_OVERRIDES='{"my_feature": true}'
```

재정의 우선순위가 가장 높습니다(디스크 캐시 및 원격 평가보다 높음).
값)이며 Ant 빌드에서만 사용할 수 있습니다. 이는 평가를 보장합니다.
외부 사용자에게 영향을 주지 않으면서 결정성을 활용합니다.

## <a href="#76-tengu_ant_model_override-model-hot-switching"
class="header">7.6 <code>tengu_ant_model_override</code>: 모델
핫스위칭</a>

`tengu_ant_model_override`은 모든 `tengu_*` 플래그 중에서 가장 복잡합니다.
GrowthBook 원격을 통해 Ant 전용 모델의 전체 목록을 구성합니다.
새로운 버전을 출시하지 않고도 런타임 핫 스위칭을 지원하는 구성
버전.

### <a href="#761-configuration-structure" class="header">7.6.1
구성 구조</a>

``` typescript
export type AntModelOverrideConfig = {
  defaultModel?: string               // Default model ID
  defaultModelEffortLevel?: EffortLevel // Default effort level
  defaultSystemPromptSuffix?: string   // Suffix appended to system prompt
  antModels?: AntModel[]              // Available model list
  switchCallout?: AntModelSwitchCalloutConfig // Switch callout configuration
}
```

**출처 참조:** `utils/model/antModels.ts:24-30`

각 `AntModel`에는 별칭(명령줄 선택용), 모델 ID,
표시 라벨, 기본 노력 수준, 컨텍스트 창 크기 및 기타
매개변수. `switchCallout`을 사용하면 모델 전환 제안을 표시할 수 있습니다.
UI에서 사용자에게

### <a href="#762-resolution-flow" class="header">7.6.2 해결 흐름</a>

`resolveAntModel` (`antModels.ts:51-64`)은 사용자 입력 모델 이름을 확인합니다.
특정 `AntModel` 구성:

``` typescript
export function resolveAntModel(
  model: string | undefined,
): AntModel | undefined {
  if (process.env.USER_TYPE !== 'ant') return undefined
  if (model === undefined) return undefined
  const lower = model.toLowerCase()
  return getAntModels().find(
    m => m.alias === model || lower.includes(m.model.toLowerCase()),
  )
}
```

일치 논리는 정확한 별칭 일치와 퍼지 모델 ID를 모두 지원합니다.
포함 일치. 예를 들어, 사용자가 지정하는 경우
`--model capybara-fast`, 별칭 일치는 해당 항목을 찾습니다.
`AntModel`; `--model claude-opus-4-6-capybara`을 지정하는 경우
모델 ID 포함 일치도 올바르게 해결됩니다.

### <a href="#763-cold-cache-startup-problem" class="header">7.6.3 콜드
캐시 시작 문제</a>

`main.tsx`(2001-2014행)의 주석은 까다로운 시작을 문서화합니다.
주문 문제: 개미 모델 별칭은 다음을 통해 해결됩니다.
`tengu_ant_model_override` 기능 플래그 및 `_CACHED_MAY_BE_STALE`은
GrowthBook 초기화가 완료되기 전에만 디스크 캐시를 읽으십시오. 만약에
디스크 캐시가 비어 있으면(콜드 캐시) `resolveAntModel`이(가) 반환됩니다.
`undefined`, 이로 인해 모델 별칭이 해결되지 않습니다.

해결책은 **GrowthBook 초기화가 완료될 때까지 동기적으로 기다리는 것입니다.
완료** 개미 사용자가 명시적 모델을 지정했음을 감지한 경우
디스크 캐시는 비어 있습니다.

``` typescript
if ('external' === 'ant' && explicitModel && ...) {
  await initializeGrowthBook()
}
```

이는 전체 코드베이스에서 매우 드문 시나리오 중 하나입니다.
GrowthBook 호출은 차단하고 기다려야 합니다.

## <a href="#77-knowledge-cutoff-date-mapping" class="header">7.7 지식
컷오프 날짜 매핑</a>

`getKnowledgeCutoff` 함수(`prompts.ts:712-730`)는
모델 ID를 지식 마감일로 매핑:

``` typescript
function getKnowledgeCutoff(modelId: string): string | null {
  const canonical = getCanonicalName(modelId)
  if (canonical.includes('claude-sonnet-4-6'))      return 'August 2025'
  else if (canonical.includes('claude-opus-4-6'))    return 'May 2025'
  else if (canonical.includes('claude-opus-4-5'))    return 'May 2025'
  else if (canonical.includes('claude-haiku-4'))     return 'February 2025'
  else if (canonical.includes('claude-opus-4') ||
           canonical.includes('claude-sonnet-4'))    return 'January 2025'
  return null
}
```

**출처 참조:** `constants/prompts.ts:712-730`

이 함수는 정확한 일치 대신 `includes`을 사용합니다.
모델 ID 접미사(예: 날짜 태그 `-20251001`)에 대해 강력합니다. 그만큼
마감일이 환경 정보 섹션에 삽입됩니다.
시스템 프롬프트(635-638행), 모델에 지식을 알려줍니다.
경계:

``` typescript
const knowledgeCutoffMessage = cutoff
  ? `\n\nAssistant knowledge cutoff is ${cutoff}.`
  : ''
```

Undercover 모드가 활성화되면 모델별 부분이
전체 환경 정보 섹션(지식 마감일 포함)
표시되지 않지만 지식 마감일 자체는 여전히
내부 정보가 유출되지 않기 때문에 보관됩니다.

## <a href="#78-engineering-insights" class="header">7.8 엔지니어링
통찰력</a>

### <a href="#the-three-stage-progressive-release-pipeline"
class="header">3단계 프로그레시브 릴리스 파이프라인</a>

Claude Code의 모델 튜닝은 명확한 3단계 릴리스 파이프라인을 보여줍니다.

1. **발견 및 소개**: 행동 문제를 발견합니다.
모델 평가(예: FC 비율 29~30%)를 통해 완화 조치를 취합니다.
PR을 통해 소개되었습니다.
2. **내부 검증**: 다음을 통해 내부 사용자로 제한됩니다.
`USER_TYPE === 'ant'` 게이팅, 실제 사용 데이터 수집.
3. **점진적 출시**: GrowthBook을 통해 효과 검증 후
A/B 테스트, Ant 전용 게이팅이 해제되어 모든 사용자에게 공개됩니다.

### <a href="#compile-time-safety-over-runtime-checks"
class="header">런타임 검사보다 컴파일 시간 안전성</a>

`USER_TYPE` 빌드 타임 교체 + 데드 코드 제거 메커니즘
내부 코드가 외부 코드에 **물리적으로 존재하지 않음**을 보장합니다.
단순히 "액세스할 수 없는" 것이 아닙니다. 이 컴파일 타임 안전성은 더 강력합니다.
런타임 권한 확인보다 코드가 없다는 것은 공격 표면이 없다는 것을 의미합니다.

### <a href="#the-philosophy-of-safe-defaults" class="header">철학
안전한 기본값</a>

언더커버 모드의 "강제적으로 끌 수 없는" 디자인, `DANGEROUS_`
접두사의 API 마찰 및 "콜드 캐시 차단 및 대기" 시작
논리는 모두 동일한 철학을 구현합니다. **보안과 편의성이
충돌이 발생하면 보안**을 선택하세요. 이것은 편집증이 아닙니다. 합리적입니다.
"내부 모델 정보 유출"과 "조금 기다리기" 사이의 균형
100밀리초."

### <a href="#feature-flags-as-control-plane" class="header">기능 플래그
제어 평면으로</a>

`tengu_*` 기능 플래그 시스템은 Claude Code를 단일 기능에서 변환합니다.
소프트웨어 제품을 **원격 제어가 가능한 플랫폼**으로 통합합니다. 을 통해
GrowthBook, 엔지니어는 새 버전을 출시하지 않고도 다음을 수행할 수 있습니다.
기본 모델, 이벤트 샘플링 비율 조정, 실험 활성화/비활성화
기능을 종료하고, 문제가 있는 기능을 강제 종료하여 긴급 종료하기도 합니다.
스위치. 이 "제어 평면/데이터 평면 분리" 아키텍처는
SaaS 제품 성숙도의 특징.

## <a href="#79-what-users-can-do" class="header">7.9 사용자가 할 수 있는 작업</a>

본 장의 모델별 튜닝 및 A/B 분석을 바탕으로
테스트 시스템에 대해 독자가 직접 적용할 수 있는 권장 사항은 다음과 같습니다.
AI 에이전트 프로젝트:

1. **코드에 분산 체크리스트를 삽입하세요.** 시스템에 필요한 경우
모델 업그레이드 중에 여러 위치를 업데이트하려면(모델 이름,
지식 마감일, 행동 완화 등), 채택
`@[MODEL LAUNCH]` 스타일 주석 표시자. 업데이트 작업 작성
주석 텍스트에서 직접 조건을 해제하여
체크리스트는 외부에 의존하지 않고 코드와 공존합니다.
선적 서류 비치.

2. **각 모델에 대한 행동 완화 아카이브를 유지합니다.
세대.** 새로운 모델의 행동 성향을 ​​발견했을 때
(예: 과장된 댓글, 허위 주장)을 통해 수정하세요.
코드 논리가 아닌 프롬프트 수준 완화. 각각 문서화
완화 도입 이유, FC 비율과 같은 정량화된 지표,
그리고 리프트 조건. 이 아카이브는 다음을 위한 귀중한 참고 자료입니다.
다음 모델 업그레이드.

3. **런타임 검사 대신 빌드 시간 상수를 사용하여 보호하세요.
내부 코드.** 귀하의 제품이 내부 코드와 내부 코드를 구별하는 경우
외부 버전, 숨기기 위해 런타임 `if` 검사에 의존하지 마세요
내부 기능. 참고 클로드 코드의 `USER_TYPE` +
번들러 `--define` + 데드 코드 제거(DCE) 메커니즘을 통해
내부 코드는 외부 빌드에 물리적으로 존재하지 않습니다.

4. **프롬프트 원격 제어를 위한 기능 플래그 시스템을 구축합니다.**
프롬프트에서 실험 콘텐츠 게이트(새로운 행동 지침,
숫자 앵커 등)은 하드코딩이 아닌 기능 플래그를 통해 가능합니다.
이를 통해 새 버전을 출시하지 않고도 모델 동작을 조정할 수 있습니다.
A/B 테스트를 실행하고 킬 스위치를 통해 변경 사항을 롤백합니다.
긴급 상황.

5. **기본적으로는 안전하고 편리하지 않습니다.** 보안 중에서 선택할 때
그리고 편의성, 참고 언더커버 모드의 디자인 : 보안 모드
기본적으로 켜져 있으며 강제로 끌 수 없습니다.
놓치다. AI 에이전트의 경우 정보 유출 비용이 훨씬 더 큽니다.
가끔 추가 제한으로 인한 비용.
