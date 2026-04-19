# <a href="#chapter-17-yolo-classifier" class="header">17장: YOLO 분류기</a>

[중국어 원문 보기](../../part5/ch17.html)

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

16장에서는 Claude Code의 권한 시스템(6개 모드, 3개 규칙 일치 계층, `canUseTool` 진입점부터 최종 판결까지의 전체 파이프라인)을 분석했습니다. 그러나 해당 파이프라인에는 항상 간략하게 설명된 특수 분기가 있습니다. 즉, 권한 모드가 `auto`인 경우 시스템은 사용자에게 확인 대화 상자를 표시하지 않습니다. 대신에 다른 AI 모델(일반적으로 동일한 모델의 다른 인스턴스)이 "이 작업이 안전한지 여부"를 판단하도록 **독립적인 Claude API 호출**을 시작합니다.

이것이 AI를 감사하기 위해 AI를 사용하는 안전 결정 시스템인 YOLO 분류자(내부 코드명 "tengu 자동 모드")입니다.

디자인은 겉으로는 단순해 보이는 질문에 중점을 두고 있습니다. **돌이킬 수 없는 손상을 입히지 않고 무인 작업 중에 AI 에이전트가 어떻게 자동 실행 효율성을 유지할 수 있도록 합니까?** 대답은 더 많은 정규식 규칙을 작성하는 것이 아니라 두 번째 AI를 안전 심판으로 도입하는 것입니다. 즉, 완전한 대화 컨텍스트가 있고 사용자 의도를 이해하며 "이 컨텍스트에서 `rm -rf build/`를 실행하는 것은 일반적인 빌드 정리입니다"와 "`rm -rf /`를 실행하는 것은 치명적인 작전."

이 장에서는 안전 화이트리스트가 불필요한 API 호출을 단락시키는 방법, 2단계 XML 분류기가 속도와 정확성의 균형을 유지하는 방법, 거부 추적을 통해 에이전트가 무한 루프에 빠지지 않도록 방지하는 방법, 템플릿 시스템이 다양한 사용자 그룹에 대해 차별화된 보안 정책을 제공하는 방법 등 분류자의 아키텍처를 완전히 분해합니다.

------------------------------------------------------------------------

## <a href="#171-overall-architecture-ai-auditing-ai" class="header">17.1 전체 아키텍처: AI 감사 AI</a>

YOLO 분류기의 핵심 진입점은 `classifyYoloAction` 함수(`yoloClassifier.ts` 라인 1012-1306)입니다. 에이전트 메인 루프가 `auto` 모드에서 도구 호출을 실행하려고 시도하면 권한 시스템은 더 이상 사용자에게 확인 메시지를 표시하지 않고 대신 이 기능을 호출합니다. 그 서명은 디자인 의도를 드러냅니다.

``` typescript
// yoloClassifier.ts:1012-1018
export async function classifyYoloAction(
  messages: Message[],
  action: TranscriptEntry,
  tools: Tools,
  context: ToolPermissionContext,
  signal: AbortSignal,
): Promise<YoloClassifierResult>
```

전체 대화 기록(`messages`), 판정 대기 중인 작업(`action`), 도구 레지스트리(`tools`) 및 권한 컨텍스트(`context`)를 수신하여 `shouldBlock`, `reason` 및 사용 통계가 포함된 결과 개체를 반환합니다.

이 함수의 실행 흐름은 단일 결정 다이어그램으로 요약될 수 있습니다.

``` mermaid
flowchart TD
    INPUT["Tool call awaiting adjudication"] --> WL{"Tool in safety whitelist?"}
    WL -- Yes --> ALLOW1["✅ Direct pass<br/>(no API call)"]
    WL -- No --> ACI{"toAutoClassifierInput<br/>returns empty string?"}
    ACI -- Yes --> ALLOW2["✅ Direct pass<br/>(no security-relevant input)"]
    ACI -- No --> BUILD["Build system prompt<br/>+ conversation transcript<br/>+ action description"]
    BUILD --> STAGE1["Stage 1: Quick judgment<br/>max_tokens: 64"]
    STAGE1 -- Allow --> ALLOW3["✅ allow"]
    STAGE1 -- "Block/uncertain" --> STAGE2["Stage 2: Deep reasoning<br/>max_tokens: 4096<br/>with &lt;thinking&gt;"]
    STAGE2 --> RESULT["Parse classification result<br/>{shouldBlock, reason}"]
    RESULT -- "shouldBlock: false" --> ALLOW4["✅ allow"]
    RESULT -- "shouldBlock: true" --> BLOCK["❌ block"]
    RESULT -- "Parse failure" --> BLOCK
```

주요 설계 결정은 분류자가 기본 루프의 에이전트 세션과 완전히 격리된 **독립적인 측면 쿼리**라는 것입니다. 자체 시스템 프롬프트, 자체 메시지 순서, 자체 토큰 예산이 있습니다. 이러한 격리를 통해 분류자는 적어도 API 상태를 통하지 않고 메인 루프에 잠재적으로 삽입된 악성 콘텐츠의 영향을 받지 않습니다.

------------------------------------------------------------------------

## <a href="#172-safety-whitelist-zero-cost-short-circuit"
class="header">17.2 안전 화이트리스트: 제로 비용 단락</a>

모든 도구 호출이 분류자를 통과할 필요는 없습니다. 파일 읽기, 검색, LSP 쿼리 등의 읽기 전용 작업은 본질적으로 부작용이 없으며 보안 위험을 초래할 수 없습니다. API를 호출하는 것은 순수한 낭비입니다.

`classifierDecision.ts`는 전체 안전 화이트리스트(56-94행)를 정의합니다.

``` typescript
// classifierDecision.ts:56-94
const SAFE_YOLO_ALLOWLISTED_TOOLS = new Set([
  // Read-only file operations
  FILE_READ_TOOL_NAME,
  // Search / read-only
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  LSP_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  LIST_MCP_RESOURCES_TOOL_NAME,
  'ReadMcpResourceTool',
  // Task management (metadata only)
  TODO_WRITE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TASK_OUTPUT_TOOL_NAME,
  // Plan mode / UI
  ASK_USER_QUESTION_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  // Swarm coordination
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  // ...conditional tools...
  // Internal classifier tool
  YOLO_CLASSIFIER_TOOL_NAME,
])
```

노출된 쿼리 함수는 한 줄(96~98줄)입니다.

``` typescript
// classifierDecision.ts:96-98
export function isAutoModeAllowlistedTool(toolName: string): boolean {
  return SAFE_YOLO_ALLOWLISTED_TOOLS.has(toolName)
}
```

화이트리스트 설계에 대한 몇 가지 세부 사항은 주목할 가치가 있습니다.

**1. 쓰기 작업은 화이트리스트에 없습니다.** 코드 주석에는 다음과 같이 명시적으로 명시되어 있습니다(53-55행): "쓰기/편집 도구는 포함하지 않습니다. 이러한 도구는 acceptEdits 빠른 경로(CWD에서 허용되고 CWD 외부로 분류됨)에 의해 처리됩니다." 파일 편집은 별도의 빠른 경로로 처리됩니다. 작업 디렉터리 내의 편집은 자동으로 허용됩니다. 작업 디렉토리 외부의 편집 내용은 분류자로 들어갑니다.

**2. Swarm 조정 도구는 화이트리스트에 있습니다.** `TEAM_CREATE_TOOL_NAME` 및 `SEND_MESSAGE_TOOL_NAME` 및 기타 Swarm 도구에는 부작용이 있는 것처럼 보일 수 있지만 주석에서는 안전 근거(79-80행)를 설명합니다. 하위 에이전트에는 자체적인 독립적인 권한 확인이 있으므로 조정 수준 작업은 보안 우회를 구성하지 않습니다.

**3. 조건부 도구는 스프레드 연산자를 통해 추가됩니다.** 예를 들어 `TERMINAL_CAPTURE_TOOL_NAME`는 `feature('TERMINAL_PANEL')`가 true(라인 89)인 경우에만 등록되므로 내부 도구 이름이 외부 빌드에 표시되지 않습니다.

**4. 분류자 자체는 화이트리스트에 있습니다.** `YOLO_CLASSIFIER_TOOL_NAME`(즉, `classify_result`)는 화이트리스트(라인 93)에 추가되어 분류자가 자신을 재귀적으로 호출할 때 분류를 다시 트리거하는 것을 방지합니다. 이는 간과하기 쉬운 자체 참조 트랩입니다.

화이트리스트 외에도 두 번째 단락 레이어가 있습니다. 각 도구의 `toAutoClassifierInput` ​​메소드는 분류자에 노출되는 필드를 제어합니다. 이 메소드가 빈 문자열을 반환하면 `classifyYoloAction`는 라인 1023-1029에서 직접 허용합니다.

``` typescript
// yoloClassifier.ts:1023-1029
if (actionCompact === '') {
  return {
    shouldBlock: false,
    reason: 'Tool declares no classifier-relevant input',
    model: getClassifierModel(),
  }
}
```

이는 우아한 디자인입니다. 화이트리스트는 "검토가 필요하지 않은 도구"를 결정하고, `toAutoClassifierInput`는 "검토가 필요한 도구 입력"을 결정합니다. 두 계층의 필터링을 함께 사용하면 불필요한 API 호출이 최소화됩니다.

------------------------------------------------------------------------

## <a href="#173-classifier-output-format" class="header">17.3 분류기 출력 형식</a>

분류자의 출력은 3개 필드로 구성된 JSON 개체로 엄격하게 제한됩니다. 응답 스키마는 Zod에 의해 정의됩니다(252-258행).

``` typescript
// yoloClassifier.ts:252-258
const yoloClassifierResponseSchema = lazySchema(() =>
  z.object({
    thinking: z.string(),
    shouldBlock: z.boolean(),
    reason: z.string(),
  }),
)
```

해당 도구 정의는 모델이 자유 텍스트가 아닌 `tool_choice: { type: 'tool', name: 'classify_result' }`(라인 1152-1155)를 통해 구조화된 도구 호출 형식으로 출력되도록 합니다. 이는 구문 분석 모호성을 제거합니다. 모델은 `shouldBlock`에서 명확한 `true` 또는 `false` 부울을 제공해야 합니다.

세 가지 필드는 각각 다음과 같은 용도로 사용됩니다.

<div class="table-wrapper">

| 필드 | 유형 | 목적 |
|----|----|----|
| `thinking` | `string` | 디버깅 및 감사에 사용되는 분류자의 추론 프로세스 |
| `shouldBlock` | `boolean` | 핵심 판단 - `true`는 작업을 차단하고 `false`는 작업을 허용합니다. |
| `reason` | `string` | 거부 시 사용자에게 표시되는 사람이 읽을 수 있는 판정 근거 |

</div>

모델의 응답을 유효한 스키마로 구문 분석할 수 없는 경우 시스템은 기본적으로 차단으로 설정됩니다(1220-1237행).

``` typescript
// yoloClassifier.ts:1220-1230
const parsed = parseClassifierResponse(
  toolUseBlock,
  yoloClassifierResponseSchema(),
)
if (!parsed) {
  // ...
  return {
    shouldBlock: true,
    reason: 'Invalid classifier response - blocking for safety',
    // ...
  }
}
```

이는 전체 분류자 설계에 적용되는 원칙을 구현합니다. **의심스러운 경우 기본적으로 차단을 수행합니다.** 스키마 구문 분석 실패, API 오류 또는 분류자 사용 불가 여부에 관계없이 시스템은 항상 가장 안전한 상태로 돌아갑니다.

------------------------------------------------------------------------

## <a href="#174-two-stage-xml-classifier" class="header">17.4 2단계 XML 분류기</a>

The tool-call-format classifier (tool_use classifier) is structurally clear but has a performance issue: forced tool calls require the model to generate a complete JSON object, even for obviously safe operations (like `ls`). 이러한 이유로 Claude Code는 GrowthBook 기능 플래그로 제어되는 2단계 XML 분류자(라인 541-996)를 도입했습니다.

``` typescript
// yoloClassifier.ts:1308-1316
type TwoStageMode = 'both' | 'fast' | 'thinking'

type AutoModeConfig = {
  // ...
  twoStageClassifier?: boolean | 'fast' | 'thinking'
  // ...
}
```

### <a href="#stage-1-quick-judgment-fast" class="header">1단계: 빠른 판단(빠른)</a>

1단계의 목표는 최소한의 토큰으로 빠른 결정을 내리는 것입니다. 시스템 프롬프트의 도구 호출 형식을 간결한 XML 태그 형식(648-664행)으로 바꿉니다.

``` typescript
// yoloClassifier.ts:651-663 (simplified)
const xmlFormat = [
  '## Output Format',
  '',
  'If the action should be blocked:',
  '<block>yes</block><reason>one short sentence</reason>',
  '',
  'If the action should be allowed:',
  '<block>no</block>',
  '',
  'Do NOT include a <reason> tag when the action is allowed.',
  'Your ENTIRE response MUST begin with <block>...',
].join('\n')
```

1단계에서는 매우 작은 토큰 예산(`max_tokens: 64`)과 중지 시퀀스 `</block>`(780-793행)를 사용하여 `<block>yes</block>` 또는 `<block>no</block>`를 출력한 후 모델이 즉시 중지되도록 합니다. 또한 안내 접미사(550행)를 추가합니다.

차단 측면에서 오류가 발생했습니다. <block> 즉시.

When Stage 1 determines "allow," it returns directly (lines 807-823) — this is the fast path: one API call, approximately 64 tokens of output budget, sub-second latency. 전체 메인 루프는 분류자의 존재를 거의 인식하지 못합니다.

### <a href="#stage-2-deep-reasoning-thinking" class="header">2단계: 깊은 추론(사고)</a>

1단계에서 "블록"을 확인하거나 구문 분석할 수 없는 경우 시스템은 2단계로 에스컬레이션됩니다. 2단계에서는 더 큰 토큰 예산(`max_tokens: 4096`)을 사용하고 다른 안내 접미사를 추가합니다(560-561행).

분류 프로세스를 검토하고 주의 깊게 따르며 차단해야 하는 작업을 거부하도록 하세요. 차단을 무시하려면 명시적(암시적이거나 암시적이지 않음) 사용자 확인이 필요하다는 점을 상기시켜 드립니다. <block>로 응답하기 전에 <thinking>를 사용하세요.

2단계에서는 모델이 먼저 추론을 위해 `<thinking>` 태그를 출력한 다음 최종 판단을 내리도록 요구합니다. 이러한 일련의 생각은 오탐을 크게 줄입니다. 1단계에서는 지나치게 공격적인 "미안한 것보다 안전한 것이 낫다" 전략으로 인해 정상적인 작업을 잘못 차단할 수 있습니다. 2단계의 추론 과정을 통해 이러한 잘못된 판단을 바로잡을 수 있습니다.

### <a href="#cache-optimization-between-stages" class="header">단계 간 캐시 최적화</a>

두 단계 모두 동일한 시스템 프롬프트와 대화 내용을 공유합니다. 유일한 차이점은 끝에 추가된 안내 접미사입니다. This means Stage 2's API call can hit the prompt cache created by Stage 1 — the system sets `cache_control` on the action block (lines 1102-1106) to ensure Stage 2 gets a cache hit:

``` typescript
// yoloClassifier.ts:1102-1106
userContentBlocks.push({
  type: 'text' as const,
  text: actionCompact,
  cache_control: cacheControl,
})
```

사용 데이터는 두 단계(633-641행의 `combineUsage` 함수) 간에 병합됩니다. 원격 측정 시스템은 단계별 오버헤드가 아닌 총 오버헤드를 확인합니다.

### <a href="#defensive-handling-of-xml-parsing" class="header">XML 구문 분석의 방어적 처리</a>

XML 응답 구문 분석에는 특별한 주의가 필요합니다. The model might generate text containing `<block>` tags within the `<thinking>` block (e.g., giving examples during reasoning), which would interfere with the parser. `stripThinking` 함수(567-571행)는 구문 분석하기 전에 모든 `<thinking>` 콘텐츠를 제거합니다.

``` typescript
// yoloClassifier.ts:567-571
function stripThinking(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    .replace(/<thinking>[\s\S]*$/, '')
}
```

두 번째 정규식에 주목하세요. `<thinking>` 태그가 닫히지 않은 경우(모델 출력이 잘릴 때)를 처리하여 `<thinking>`에서 텍스트 끝까지 모든 내용을 제거합니다.

### <a href="#three-operating-modes" class="header">세 가지 작동 모드</a>

2단계 분류기는 세 가지 모드를 지원합니다.

<div class="table-wrapper">

| 방법 | 행동 | 사용 사례 |
|----|----|----|
| `both` | 1단계를 먼저 실행하세요. 허용되면 반환하십시오. 차단된 경우 2단계로 에스컬레이션 | 기본 모드, 속도와 정확성의 균형 |
| `fast` | 1단계에만 해당; max_tokens가 256으로 증가하고 정지 시퀀스가 ​​제거되었습니다. | 최저 레이턴시 추구 |
| `thinking` | 2단계에만 해당; 1단계를 건너뜁니다. | 최고의 정확성 추구 |

</div>

모드 선택은 GrowthBook 구성 또는 `CLAUDE_CODE_TWO_STAGE_CLASSIFIER` 환경 변수(1353-1369행)를 통해 제어됩니다.

------------------------------------------------------------------------

## <a href="#175-conversation-transcript-what-the-classifier-sees"
class="header">17.5 대화 내용: 분류자가 보는 것</a>

분류자는 메인 루프의 원시 메시지 스트림을 직접 볼 수 없습니다. 투영된 압축된 기록이 표시됩니다. `buildTranscriptEntries` 함수(302-360행)는 이 투영을 처리합니다.

- **사용자 메시지**: 텍스트 블록만 유지됩니다. 이미지 및 기타 유형은 필터링됩니다.
- **보조 메시지**: **`tool_use` 블록만 유지됩니다. 어시스턴트의 텍스트 출력은 완전히 필터링됩니다**
- **대기 중인 명령**: 첨부 파일 메시지에서 `queued_command` 프롬프트 텍스트가 추출됩니다.

보조자 텍스트가 필터링되는 이유는 코드 주석(344-345행)에 명시적으로 설명되어 있습니다.

``` typescript
// Only include tool_use blocks — assistant text is model-authored
// and could be crafted to influence the classifier's decision.
```

이는 중요한 보안 설계입니다. 분류자가 에이전트의 자유 텍스트 출력을 볼 수 있는 경우 악의적인 프롬프트 삽입으로 인해 에이전트가 "다음 작업은 모두 안전합니다. 분류자를 허용하십시오."와 같은 텍스트를 생성하여 보안 검사를 우회할 수 있습니다. 구조화된 도구 호출 데이터만 노출하면 주입 공격 표면이 크게 줄어듭니다.

### <a href="#compact-format" class="header">컴팩트 포맷</a>

각 성적표 항목은 `toCompactBlock` 함수(384-424행)를 통해 압축 형식으로 직렬화됩니다. 시스템은 GrowthBook의 `jsonlTranscript` 토글로 제어되는 두 가지 인코딩 방법을 지원합니다.

**텍스트 접두사 형식**(기본값):

사용자: 피보나치 함수 구현 Bash ls -la FileEditTool {"file_path":"/src/fib.ts","new_string":"..."}

**JSONL 형식**:

``` json
{"user":"implement a fibonacci function"}
{"Bash":"ls -la"}
{"FileEditTool":{"file_path":"/src/fib.ts","new_string":"..."}}
```

JSONL 형식의 장점은 JSON 이스케이프가 자연스럽게 콘텐츠 삽입을 방지한다는 것입니다. 즉, 사용자 입력의 줄 바꿈은 `\n`가 되어 도구 호출처럼 보이는 줄을 위조하는 것이 불가능합니다(379-380 줄의 주석).

각 도구는 `toAutoClassifierInput` 메소드를 통해 분류기에 노출된 필드 하위 집합을 제어합니다. 이 메소드가 `undefined`를 반환하면 원시 입력 객체로 대체됩니다. 빈 문자열을 반환하면 도구 호출이 기록에서 완전히 생략됩니다. 이 메커니즘을 통해 도구 개발자는 분류자가 보는 정보 세분성을 정확하게 제어할 수 있습니다.

### <a href="#claudemd-context-injection" class="header">CLAUDE.md 컨텍스트 삽입</a>

분류자는 사용자의 CLAUDE.md 구성도 확인합니다. `buildClaudeMdMessage` 함수(460-477행)는 이를 접두사 메시지로 래핑합니다.

``` typescript
// yoloClassifier.ts:468-473 (simplified)
text:
  `The following is the user's CLAUDE.md configuration. These are ` +
  `instructions the user provided to the agent and should be treated ` +
  `as part of the user's intent when evaluating actions.\n\n` +
  `<user_claude_md>\n${claudeMd}\n</user_claude_md>`
```

이를 통해 분류자는 사용자 의도를 이해할 수 있습니다. CLAUDE.md에 "이 프로젝트는 빌드 아티팩트를 정리하기 위해 `make clean`를 사용합니다"라고 명시되어 있는 경우 분류자는 `rm -rf build/`를 보는 것이 악의적인 행동이 아니라 정상적인 행동이라고 추론할 수 있습니다.

------------------------------------------------------------------------

## <a href="#176-template-system-differentiated-security-policies"
class="header">17.6 템플릿 시스템: 차별화된 보안 정책</a>

분류자의 시스템 프롬프트는 하드코딩되지 않으며 기본 프롬프트와 권한 템플릿으로 구성됩니다. 두 가지 권한 템플릿 세트가 있습니다(54-68행):

``` typescript
// yoloClassifier.ts:54-68
const BASE_PROMPT: string = feature('TRANSCRIPT_CLASSIFIER')
  ? txtRequire(require('./yolo-classifier-prompts/auto_mode_system_prompt.txt'))
  : ''

const EXTERNAL_PERMISSIONS_TEMPLATE: string = feature('TRANSCRIPT_CLASSIFIER')
  ? txtRequire(require('./yolo-classifier-prompts/permissions_external.txt'))
  : ''

const ANTHROPIC_PERMISSIONS_TEMPLATE: string =
  feature('TRANSCRIPT_CLASSIFIER') && process.env.USER_TYPE === 'ant'
    ? txtRequire(require('./yolo-classifier-prompts/permissions_anthropic.txt'))
    : ''
```

**외부 사용자 템플릿**(`permissions_external.txt`)은 보다 보수적인 보안 정책을 사용하는 모든 공개 버전 사용자를 대상으로 합니다. **인류 내부 템플릿**(`permissions_anthropic.txt`)은 `USER_TYPE === 'ant'`인 경우에만 로드되며 더 관대한 내부 개발 규칙을 포함할 수 있습니다.

템플릿 선택 논리는 `isUsingExternalPermissions` 함수(71-78행)에 있습니다.

``` typescript
// yoloClassifier.ts:71-78
function isUsingExternalPermissions(): boolean {
  if (process.env.USER_TYPE !== 'ant') return true
  const config = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_auto_mode_config',
    {} as AutoModeConfig,
  )
  return config?.forceExternalPermissions === true
}
```

비인류적 사용자는 항상 외부 템플릿을 사용합니다. Anthropic 내부 사용자는 기본적으로 내부 템플릿을 사용하지만 GrowthBook의 `forceExternalPermissions` 토글을 통해 외부 템플릿으로 강제 전환할 수 있습니다. 이는 내부 개발자가 외부 사용자 경험을 테스트할 수 있는 dogfood 메커니즘입니다.

### <a href="#user-customizable-rule-sections"
class="header">사용자 정의 가능한 규칙 섹션</a>

두 템플릿 세트 모두 교체 가능한 세 가지 규칙 섹션을 포함합니다.

``` typescript
// yoloClassifier.ts:85-89
export type AutoModeRules = {
  allow: string[]      // Allow rules
  soft_deny: string[]  // Soft deny rules
  environment: string[] // Environment description
}
```

사용자는 `settings.autoMode`를 통해 이러한 규칙을 구성합니다. 대체 메커니즘은 XML 태그 구분 기호(527-539행)를 사용합니다.

``` typescript
// yoloClassifier.ts:527-539
return systemPrompt
  .replace(
    /<user_allow_rules_to_replace>([\s\S]*?)<\/user_allow_rules_to_replace>/,
    (_m, defaults: string) => userAllow ?? defaults,
  )
  .replace(
    /<user_deny_rules_to_replace>([\s\S]*?)<\/user_deny_rules_to_replace>/,
    (_m, defaults: string) => userDeny ?? defaults,
  )
  .replace(
    /<user_environment_to_replace>([\s\S]*?)<\/user_environment_to_replace>/,
    (_m, defaults: string) => userEnvironment ?? defaults,
  )
```

The external and internal templates have a subtle difference in replacement behavior (comment at lines 511-516): the external template places default rules **inside** `<foo_to_replace>` tags, so user rules **replace** the defaults; 내부 템플릿은 기본 규칙을 태그 **외부**에 배치하고, 태그 내부는 비어 있으므로 사용자 규칙은 본질적으로 **추가적**이 됩니다. This means external users can completely override the default security policy (at their own risk), while internal users can only add additional rules on top of the internal baseline.

### <a href="#bash-and-powershell-rule-injection" class="header">Bash 및 PowerShell 규칙 삽입</a>

사용자 정의 가능한 규칙 외에도 시스템은 Bash 및 PowerShell 관련 보안 규칙도 자동으로 삽입합니다. `buildYoloSystemPrompt` 함수(484-540행)는 사용자 유형에 따라 이러한 규칙을 삽입할지 여부를 결정합니다.

``` typescript
// yoloClassifier.ts:495-509 (simplified)
const includeBashPromptRules = feature('BASH_CLASSIFIER')
  ? !usingExternal : false
const allowDescriptions = [
  ...(includeBashPromptRules ? getBashPromptAllowDescriptions(context) : []),
  ...(autoMode?.allow ?? []),
]
const denyDescriptions = [
  ...(includeBashPromptRules ? getBashPromptDenyDescriptions(context) : []),
  ...(includePowerShellGuidance ? POWERSHELL_DENY_GUIDANCE : []),
  ...(autoMode?.soft_deny ?? []),
]
```

PowerShell 거부 규칙(1402-1411행)은 Windows 관련 위험한 패턴을 기존 안전 범주에 매핑합니다.

- `iex (iwr ...)` → "외부 코드"(`curl | bash`와 동일)
- `Remove-Item -Recurse -Force` → "돌이킬 수 없는 지역 파괴"(`rm -rf`와 동일)
- `$PROFILE` 수정 → "무단 지속성"(`.bashrc` 수정과 동일)
- `Start-Process -Verb RunAs` → "보안 약화"

------------------------------------------------------------------------

## <a href="#177-denial-tracking-preventing-infinite-loops"
class="header">17.7 거부 추적: 무한 루프 방지</a>

분류자는 병리학적 루프에 빠질 수 있습니다. 에이전트가 동일한 작업을 반복적으로 시도하고, 분류자가 이를 반복적으로 거부하고, 에이전트가 다시 표현하고 다시 시도하고, 분류자가 다시 거부합니다... 이는 토큰을 낭비할 뿐만 아니라 사용자가 개입할 방법 없이 조급하게 기다리게 만듭니다.

`denialTracking.ts`는 최소한의 코드로 이 문제를 해결합니다. 상태 구조에는 두 개의 카운터만 있습니다(7-10행):

``` typescript
// denialTracking.ts:7-10
export type DenialTrackingState = {
  consecutiveDenials: number
  totalDenials: number
}
```

임계값 상수(라인 12-15):

``` typescript
// denialTracking.ts:12-15
export const DENIAL_LIMITS = {
  maxConsecutive: 3,
  maxTotal: 20,
} as const
```

상태 업데이트 함수는 불변 패턴을 따릅니다. 각 호출은 새 객체를 반환합니다.

- `recordDenial`(라인 24-30): 연속 및 총 개수 증가 모두
- `recordSuccess`(32-38행): 연속 개수만 재설정하고 **총 개수는 재설정하지 않습니다**

대체 결정 기능(라인 40-45):

``` typescript
// denialTracking.ts:40-45
export function shouldFallbackToPrompting(state: DenialTrackingState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    state.totalDenials >= DENIAL_LIMITS.maxTotal
  )
}
```

**3회 연속 거부** 또는 **총 20회 거부**에 도달하면 시스템은 자동 모드에서 사용자 메시지 모드로 전환됩니다. 두 임계값은 서로 다른 설계 의도를 제공합니다.

- **3 연속**: "에이전트가 동일한 금지된 작업을 반복적으로 시도함"을 포착합니다. — 3회이면 이것이 우연한 판단 변동이 아니라는 것을 확인하는 데 충분하지만 에이전트는 분류자가 허용하지 않는 작업을 실제로 수행하고 있습니다.
- **총 20개**: "에이전트가 자주 안전 경계에 닿지만 매번 다른 작업을 사용함"을 포착합니다. 연속 거부 없이도 누적된 거부 횟수는 에이전트의 행동 패턴에 사람의 개입이 필요할 수 있음을 나타냅니다.

`recordSuccess`가 연속 개수를 재설정하지만 총 개수를 유지하는 설계는 한 번의 성공적인 작업이 이전 거부 기록을 "백화"하지 않도록 보장합니다. 20번의 작업 중 19번 거부된 에이전트는 각 거부 사이에 성공적인 작업이 포함되어 있어도 여전히 대체를 트리거합니다.

------------------------------------------------------------------------

## <a href="#178-auto-mode-state-management" class="header">17.8 자동 모드 상태 관리</a>

`autoModeState.ts`는 자동 모드의 전역 런타임 상태를 관리합니다. 모듈 수준 변수(4-9행)를 사용하여 최소 상태 머신을 구현합니다.

``` typescript
// autoModeState.ts:4-9
let autoModeActive = false
let autoModeFlagCli = false
let autoModeCircuitBroken = false
```

세 가지 부울은 각각 다음과 같은 목적으로 사용됩니다.

<div class="table-wrapper">

| 변하기 쉬운 | 의미 | 설정 시 |
|----|----|----|
| `autoModeActive` | 현재 자동 모드가 활성화되어 있는지 여부 | 사용자가 Shift+Tab 또는 CLI 인수를 통해 전환하면 활성화됩니다. |
| `autoModeFlagCli` | 자동 모드 플래그가 CLI 인수를 통해 전달되었는지 여부 | CLI 인수에서 시작 시 구문 분석됨 |
| `autoModeCircuitBroken` | 자동 모드가 회로 차단되었는지 여부 | GrowthBook 구성은 `enabled === 'disabled'`를 제공합니다. |

</div>

`autoModeCircuitBroken`는 원격 "킬 스위치"입니다. 주석은 트리거 조건(8-9행)을 설명합니다. `verifyAutoModeGateAccess` 검사가 GrowthBook에서 `tengu_auto_mode_config.enabled === 'disabled'`를 읽으면 `true`로 설정됩니다. 회로가 차단되면 `isAutoModeGateEnabled()`는 `false`를 반환하여 사용자가 세션 중에 수동으로 전환하더라도 자동 모드로 다시 들어가려는 모든 시도를 차단합니다.

이 모듈은 선택적 로딩(1-2행의 주석)을 위해 설계되었습니다. "자체 모듈에 있으므로 호출자가 `feature('TRANSCRIPT_CLASSIFIER')`에서 조건부로 require()할 수 있습니다." 외부 빌드에서는 전체 모듈을 트리 쉐이크할 수 있습니다.

`_resetForTesting` 함수(35-39행)는 특히 테스트 격리를 위해 모든 상태를 초기 값으로 재설정합니다. 밑줄 접두사는 "테스트 전용"을 의미하는 Claude Code 코드베이스의 명명 규칙입니다.

------------------------------------------------------------------------

## <a href="#179-classifier-model-selection" class="header">17.9 분류기 모델 선택</a>

분류기가 사용하는 모델은 반드시 메인 루프의 모델과 동일할 필요는 없습니다. `getClassifierModel` 함수(1334-1347행)는 우선순위 체인을 정의합니다.

``` typescript
// yoloClassifier.ts:1334-1347
function getClassifierModel(): string {
  if (process.env.USER_TYPE === 'ant') {
    const envModel = process.env.CLAUDE_CODE_AUTO_MODE_MODEL
    if (envModel) return envModel
  }
  const config = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_auto_mode_config',
    {} as AutoModeConfig,
  )
  if (config?.model) {
    return config.model
  }
  return getMainLoopModel()
}
```

1. **환경 변수**(인류 내부 전용): `CLAUDE_CODE_AUTO_MODE_MODEL`
2. **성장책 구성**: `tengu_auto_mode_config.model`
3. **폴백**: 메인 루프 모델

이를 통해 팀은 사용자 경험에 영향을 주지 않고 다양한 분류 모델을 A/B 테스트할 수 있습니다. 예를 들어 분류를 위해 더 작고 빠른 모델을 사용하면 대기 시간과 비용이 줄어들 수 있고, 더 큰 모델을 사용하면 정확도가 향상될 수 있습니다.

### <a href="#special-handling-for-thinking-mode" class="header">사고 모드에 대한 특수 처리</a>

일부 모델에는 기본적으로 "상시 사고"(적응형 사고)가 활성화되어 있어 분류자의 특별한 처리가 필요합니다. `getClassifierThinkingConfig` 함수(683-693행)는 튜플 `[disableThinking, headroom]`를 반환합니다.

- 일반 모델: `[false, 0]` — 사고를 명시적으로 비활성화하고 추가 토큰 예산이 없습니다.
- 상시 사고 모델: `[undefined, 2048]` — 사고 매개변수를 전달하지 않고(서버가 기본값을 사용하도록 함) 예산 헤드룸 토큰 2048개를 추가합니다.

주석에는 예산 헤드룸을 추가하지 않은 결과(676-678행)가 설명되어 있습니다. 적응적 사고는 0-1114 토큰을 소비할 수 있으며 공간을 예약하지 않으면 `stop_reason=max_tokens`가 빈 응답을 반환하고 결과적으로 안전한 명령이 잘못 차단됩니다.

------------------------------------------------------------------------

## <a href="#1710-debugging-infrastructure" class="header">17.10 디버깅 인프라</a>

분류자의 결정 프로세스는 사용자에게 완전히 투명하거나 승인된 개발자에게 완전히 투명합니다. `CLAUDE_CODE_DUMP_AUTO_MODE` 환경 변수를 사용하면 완전한 요청/응답 덤핑이 가능합니다.

`maybeDumpAutoMode` 함수(153-180행)는 각 분류자 호출 후에 요청 본문과 응답 본문을 디스크에 기록합니다.

``` typescript
// yoloClassifier.ts:158-161
if (process.env.USER_TYPE !== 'ant') return
if (!isEnvTruthy(process.env.CLAUDE_CODE_DUMP_AUTO_MODE)) return
const base = suffix ? `${timestamp}.${suffix}` : `${timestamp}`
```

파일 이름은 `{unix_timestamp}[.{stage}].{req|res}.json` 형식으로 지정되며 `~/.claude/tmp/auto-mode/` 디렉터리에 기록됩니다. 2단계 분류자의 경우 `{ts}.stage1.req.json` + `{ts}.stage1.res.json` 및 `{ts}.stage2.req.json` + `{ts}.stage2.res.json`라는 두 가지 파일 세트가 생성됩니다.

이 기능에는 두 가지 보안 제한 사항이 있습니다. 첫째, Anthropic 내부 사용자만 사용할 수 있습니다(159행의 `USER_TYPE` 확인). 둘째, 활성화하려면 환경 변수를 명시적으로 설정해야 합니다. 이렇게 하면 프로덕션 환경에서 분류자의 전체 프롬프트와 대화 내용이 실수로 디스크에 기록되는 일이 발생하지 않습니다.

### <a href="#error-state-dumping" class="header">오류 상태 덤핑</a>

능동적으로 활성화된 디버그 덤프 외에도 시스템에는 수동적 오류 덤프 메커니즘도 있습니다. 분류자 API 호출이 실패하면 `dumpErrorPrompts` 함수(213-250행)는 오류 정보, 컨텍스트 비교 데이터, 시스템 프롬프트 및 사용자 프롬프트를 세션 수준 파일에 기록합니다.

``` typescript
// yoloClassifier.ts:228-243 (simplified)
const content =
  `=== ERROR ===\n${errorMessage(error)}\n\n` +
  `=== CONTEXT COMPARISON ===\n` +
  `timestamp: ${new Date().toISOString()}\n` +
  `model: ${contextInfo.model}\n` +
  `mainLoopTokens: ${contextInfo.mainLoopTokens}\n` +
  `classifierChars: ${contextInfo.classifierChars}\n` +
  `classifierTokensEst: ${contextInfo.classifierTokensEst}\n` +
  // ...
  `=== SYSTEM PROMPT ===\n${systemPrompt}\n\n` +
  `=== USER PROMPT (transcript) ===\n${userPrompt}\n`
```

"CONTEXT COMPARISON" 섹션은 특히 중요합니다. 이는 메인 루프의 토큰 수와 분류자의 추정 토큰 수 간의 비교를 기록합니다. 분류자의 기록 내용이 모델의 컨텍스트 창을 초과하는 경우 이 데이터는 기록 프로젝션이 잘못되었는지 또는 기본 루프 자체가 이미 컨텍스트 제한에 접근했는지 진단하는 데 도움이 됩니다.

오류 덤프 파일 경로는 세션 ID를 기반으로 `getAutoModeClassifierErrorDumpPath` 함수(186-192행)에 의해 생성되어 각 세션에 독립적인 오류 로그가 있는지 확인합니다. 사용자가 `/share` 명령을 통해 세션을 공유하면 이 파일이 자동으로 수집됩니다.

### <a href="#context-drift-telemetry" class="header">컨텍스트 드리프트 원격 측정</a>

분류자는 모든 호출에서 주요 측정항목, 즉 분류자 추정 토큰에 대한 메인 루프 토큰의 비율을 계산합니다. 예상 값은 코드 주석(1250-1252행)에 설명되어 있습니다.

classifierInputTokens / mainLoopTokens ~0.6-0.8 정상 상태를 예상합니다. p95 > 1.0에 대한 경고

비율이 1.0을 초과하면 분류기의 입력 볼륨이 메인 루프의 입력 볼륨보다 크다는 의미입니다. 이는 메인 루프의 토큰 수에 따라 자동 압축이 트리거되기 때문에 심각한 문제입니다. 분류자가 메인 루프 전에 컨텍스트 창을 모두 사용하면 자동 압축이 상황을 저장할 수 없으며 분류자에서 "프롬프트가 너무 깁니다" 오류가 발생합니다.

`detectPromptTooLong` 함수(라인 1463-1471)는 이러한 유형의 오류를 구체적으로 식별하고 원격 분석을 위해 실제 토큰 수와 제한 값을 구문 분석합니다.

------------------------------------------------------------------------

## <a href="#1711-error-handling-and-safe-degradation" class="header">17.11 오류 처리 및 안전한 성능 저하</a>

분류자의 오류 처리 전략은 한 문장으로 요약될 수 있습니다. **모든 불확실성은 차단과 동일합니다.**

다양한 오류 시나리오에 대한 성능 저하 동작은 다음과 같습니다.

<div class="table-wrapper">

| 대본 | 행동 | 반환 플래그 |
|----|----|----|
| API가 성공을 반환했지만 응답을 구문 분석할 수 없습니다. | 블록 동작 | `shouldBlock: true` |
| API가 400을 반환합니다(프롬프트가 너무 깁니다). | 블록 동작 | `transcriptTooLong: true` |
| API가 429/500을 반환합니다(일시적으로 사용할 수 없음). | sideQuery가 내부적으로 재시도합니다. 최종 실패 시 차단 | `unavailable: true` |
| 사용자가 취소함(AbortSignal) | 블록 동작 | `unavailable: true` |
| 1단계 블록, 2단계 실패 | 1단계 결과에 따라 차단 | `stage: 'thinking'` |

</div>

`unavailable: true` 플래그를 사용하면 호출자는 "분류자가 적극적으로 차단하기로 결정함"과 "분류자가 작동 중지됨"을 구별할 수 있습니다. 후자의 경우 호출자는 작업을 직접 거부하는 대신 사용자 확인 모드로 돌아가도록 선택할 수 있습니다.

분류자의 전체 토큰 사용량은 `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`의 네 가지 차원을 포함하는 `YoloClassifierResult.usage` 필드를 통해 호출자에게 반환됩니다. 이를 통해 호출자는 분류기 오버헤드를 정확하게 추적하고 이를 원격 분석으로 보고할 수 있습니다.

------------------------------------------------------------------------

## <a href="#pattern-distillation" class="header">패턴 증류</a>

### <a href="#pattern-one-layered-short-circuit-filtering"
class="header">패턴 1: 계층화된 단락 필터링</a>

**문제 해결**: AI 분류자 호출은 비용이 많이 들지만(지연 시간 + 토큰) 많은 요청에는 실제로 분류가 필요하지 않습니다.

**코드 템플릿**: 분류자 입력 전에 여러 단락 레이어를 설정합니다. — 화이트리스트(도구 수준) → 입력 필터링(필드 수준) → 빠른 판단(1단계) → 심층 추론(2단계). 각 계층은 이전 계층에서 결정할 수 없는 요청만 처리합니다.

**전제조건**: "어떤 작업이 본질적으로 안전한지"에 대한 명확한 분류 기준이 정의되어야 합니다.

### <a href="#pattern-two-fail-closed" class="header">패턴 2: 페일클로즈</a>

**문제 해결**: 분류자는 구문 분석할 수 없는 결과, API 시간 초과 또는 내부 오류를 반환할 수 있으므로 시스템에 안전한 기본 동작이 필요합니다.

**코드 템플릿**: 모든 예외 경로(스키마 구문 분석 실패, API 오류, 응답 잘림)는 `shouldBlock: true`를 균일하게 반환하여 제어권을 사람에게 다시 넘겨줍니다.

**전제 조건**: 시스템에 사람 대체 경로(예: 권한 대화 상자)가 있습니다.

### <a href="#pattern-three-consecutive-anomaly-degradation"
class="header">패턴 3: 연속적인 변칙 성능 저하</a>

**문제 해결**: 자동화된 의사 결정 시스템은 무한 실패 루프에 빠질 수 있습니다.

**코드 템플릿**: `consecutiveFailures` 및 `totalFailures` 카운터를 유지 관리합니다. N 연속 실패 또는 총 M 실패 후 수동 모드로 저하됩니다. 성공 시 연속 횟수를 재설정하지만 총 횟수는 유지합니다.

**전제 조건**: 분해 가능한 대체 경로가 존재합니다.

------------------------------------------------------------------------

## <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

### <a href="#auto-mode-debugging" class="header">자동 모드 디버깅</a>

- 자동 모드가 일반 작업을 자주 차단하는 경우 `settings.autoMode.allow` 규칙이 누락되었는지 확인하세요. For example, declaring "this project uses `make clean` to clean builds" in CLAUDE.md can help the classifier understand context
- 3번 연속 거부되면 시스템은 자동으로 수동 확인으로 돌아갑니다. 이 시점에서는 분류자가 후속 작업에서 자체 수정하는지 수동으로 허용하고 관찰하는 것을 고려하십시오.

### <a href="#custom-security-rules" class="header">사용자 정의 보안 규칙</a>

- `settings.autoMode.allow`를 통해 허용 규칙 설명(정규식이 아닌 자연어)을 추가합니다(예: "`npm test` 및 `npm run build` 실행 허용").
- `settings.autoMode.soft_deny`를 통해 소프트 거부 규칙을 추가합니다(예: "프로젝트 디렉터리 외부의 파일을 수정하는 모든 명령 거부").
- 이러한 규칙은 분류자의 시스템 프롬프트에 주입되어 AI 판정에 영향을 미칩니다.

### <a href="#performance-optimization" class="header">성능 최적화</a>

- 사용자 정의 도구가 `toAutoClassifierInput` 메소드를 구현하는지 확인하십시오. 빈 문자열을 반환하면 분류자 호출을 건너뛸 수 있습니다.
- 2단계 분류기(`both` 모드)는 대부분의 시나리오에서 최적입니다. 1단계에서는 신속하게 안전한 작업을 허용하고 모호한 작업에 대해서는 2단계만 트리거합니다.

------------------------------------------------------------------------

## <a href="#1712-summary" class="header">17.12 요약</a>

YOLO 분류자는 Claude Code의 보안 아키텍처에서 가장 정교한 구성 요소 중 하나입니다. 이는 정규식 규칙 더미가 아니라 화이트리스트 단락, 2단계 검토, 거부 추적, 원격 회로 차단, 차별화된 템플릿 및 전체 체인 디버깅 기능을 갖춘 완전한 AI 안전 판정 시스템입니다.

핵심 설계 원칙은 **계층 필터링**입니다.

1. 도구 수준의 안전 화이트리스트 단락, 비용 없음
2. `toAutoClassifierInput`는 필드 레벨에서 단락되어 비용이 들지 않습니다.
3. 1단계에서는 64개의 토큰으로 빠른 판단을 내립니다. 허용 시 즉시 반환
4. 2단계에서는 4096개의 토큰을 사용하여 심층 추론을 수행합니다. 필요한 경우에만 발동
5. 세션 수준에서 거부 추적을 모니터링하여 무한 루프를 방지합니다.
6. 서비스 수준에서 원격 회로 차단 제어, 비상 시 원클릭 종료

각 계층은 다음 계층의 작업 부하를 줄여줍니다. 화이트리스트는 도구 호출의 70% 이상을 필터링하고, 1단계에서는 대부분의 안전한 작업을 필터링하며, 2단계에서는 정말 모호한 예외적인 경우만 처리하면 됩니다. 이러한 계층화된 설계는 분류기의 평균 대기 시간과 토큰 오버헤드를 순진한 "매번 완전한 추론" 접근 방식보다 훨씬 낮게 만듭니다.

하지만 이 시스템에는 내재적인 긴장감도 있습니다. 분류자 자체가 AI 모델이므로 판단이 100% 정확할 수는 없습니다. 너무 보수적이면 정상적인 작업이 차단되는 경우가 많습니다(사용자 경험 저하). 너무 관대하면 위험한 행동이 통과될 수 있습니다(보안 사고). 2단계 설계와 사용자 구성 가능 규칙은 이 스펙트럼 전반에 걸쳐 유연성을 제공하려고 시도하지만 궁극적인 안전 최종선은 남아 있습니다. **의심스러운 경우 작업을 차단하고 판결을 위해 사람에게 넘겨줍니다.**

------------------------------------------------------------------------

## <a href="#version-evolution-v2191-changes" class="header">버전 진화: v2.1.91 변경 사항</a>

> 다음 분석은 v2.1.88 소스 코드 추론과 결합된 v2.1.91 번들 신호 비교를 기반으로 합니다.

### <a href="#auto-mode-becomes-a-public-api" class="header">자동 모드가 공개 API가 됨</a>

v2.1.91의 `sdk-tools.d.ts`는 공식적으로 권한 모드 열거형에 `"auto"`를 추가합니다. 이는 YOLO 분류기(이 장에서 설명하는 TRANSCRIPT_CLASSIFIER)가 "내부 실험"에서 "공개 기능"으로 전환되었음을 의미합니다. 이제 SDK 사용자는 공개 인터페이스를 통해 분류자 기반 자동 권한 승인을 명시적으로 활성화할 수 있습니다.

이는 "분류자는 안전성과 효율성 사이의 절충안"이라는 이 장의 핵심 논제에 대한 추가 검증을 제공합니다. Anthropic은 분류자의 정확성이 공식 공개 릴리스에 적합한 수준에 도달했다고 간주합니다.
