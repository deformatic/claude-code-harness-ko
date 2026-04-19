# <a href="#chapter-2-tool-system--40-tools-as-the-models-hands"
class="header">2장: 도구 시스템 — 모델의 역할을 하는 40개 이상의 도구
손</a>

## <a href="#why-the-tool-system-is-the-core-of-claude-code"
class="header">도구 시스템이 클로드 코드의 핵심인 이유</a>

대규모 언어 모델은 텍스트 영역에서 "생각"하지만 소프트웨어는
엔지니어링 작업은 파일 시스템, 터미널 및 네트워크에서 발생합니다.
**도구 시스템**은 이 두 세계를 연결하는 다리입니다.
모델의 의도를 실제 부작용으로 변환한 다음
부작용의 결과는 모델이 사용할 수 있는 텍스트로 다시 변환됩니다.

Claude Code의 도구 시스템은 40개 이상의 내장 도구와 무제한의 도구를 관리합니다.
MCP 확장 도구의 수. 이러한 도구는 평면 배열이 아닙니다.
정확한 파이프라인 통과: **정의 -\> 등록 -\>
필터링 -\> 호출 -\> 렌더링**. 각 단계에는 명확한 내용이 있습니다.
계약. 이 장은 `Tool.ts` 인터페이스 정의부터 시작됩니다.
이 파이프라인 설계 결정의 각 레이어를 분석합니다.

-----------------------------------------------------------

## <a href="#21-the-tool-interface-contract" class="header">2.1
<code>도구</code> 인터페이스 계약</a>

모든 도구 — 내장 `BashTool` 또는 타사 도구 로드 여부
MCP 프로토콜을 통해 — 동일한 TypeScript 인터페이스를 충족해야 합니다. 이것
인터페이스는 `restored-src/src/Tool.ts:362-695`에 정의되어 있으며
전체 도구 시스템의 초석입니다.

### <a href="#core-fields-overview" class="header">핵심 필드 개요</a>

<div class="table-wrapper">

| 필드 | 유형 | 책임 | 필수 |
|----|----|----|----|
| `name` | `readonly string` | 권한 일치, 분석 및 API 전송에 사용되는 도구의 고유 식별자 | 예 |
| `description` | `(input, options) => Promise<string>` | 모델에 전송된 도구 설명 텍스트를 반환합니다. 권한 컨텍스트에 따라 동적으로 조정할 수 있습니다 | 예 |
| `prompt` | `(options) => Promise<string>` | 도구의 시스템 프롬프트를 반환합니다. 8장 | 예 |
| `inputSchema` | `z.ZodType` (Zod v4) | API용 JSON 스키마로 자동 변환되는 Zod 스키마를 사용하여 도구의 매개변수 구조를 정의 | 예 |
| `call` | `(args, context, canUseTool, parentMessage, onProgress?) => Promise<ToolResult>` | 도구의 핵심 실행 논리 | 예 |
| `checkPermissions` | `(input, context) => Promise<PermissionResult>` | 일반 권한 시스템 이후에 실행되는 도구 수준 권한 확인 | 예\* |
| `validateInput` | `(input, context) => Promise<ValidationResult>` | 권한 확인 전에 입력 적법성 검증 | 아니요 |
| `maxResultSizeChars` | `number` | 단일 도구 결과에 대한 문자 제한 이를 초과하면 디스크에 지속됩니다 | 예 |
| `isConcurrencySafe` | `(input) => boolean` | 다른 도구와 동시에 실행할 수 있는지 여부 | 예\* |
| `isReadOnly` | `(input) => boolean` | 읽기 전용 작업인지 여부(파일 시스템을 수정하지 않음) | 예\* |
| `isEnabled` | `() => boolean` | 현재 환경에서 도구를 사용할 수 있는지 여부 | 예\* |

</div>

> \*로 표시된 필드에는 `buildTool()`에서 제공하는 기본값이 있으며 다음을 수행할 수 있습니다.
> 도구 정의에서 생략됩니다.

심층적으로 검토할 가치가 있는 몇 가지 디자인 선택:

**`description`은 문자열이 아닌 함수입니다.** 동일한 도구에 필요할 수 있습니다.
다른 권한 모드에서는 다른 설명이 제공됩니다. 예를 들어,
사용자가 특정 항목을 금지하는 `alwaysDeny` 규칙을 구성할 때
하위 명령, 도구 설명을 통해 모델에 사전에 정보를 제공할 수 있습니다.
"이러한 작업을 시도하지 마십시오."
프롬프트 수준.

**`inputSchema`은 Zod v4를 사용합니다.** 이는 다음의 엄격한 런타임 검증을 허용합니다.
에 대한 JSON 스키마를 자동으로 생성하는 동안 도구 매개변수
`z.toJSONSchema()`을 통한 인류학 API. Zod의 `z.strictObject()`은 다음을 보장합니다.
모델은 정의되지 않은 매개변수를 전달하지 않습니다.

**`call`이 `canUseTool` 콜백을 받습니다.** 이는 매우
중요한 디자인 — 도구는 다음에 대한 권한을 재귀적으로 확인해야 할 수도 있습니다.
실행 중 하위 작업. 예를 들어 `AgentTool`은(는) 확인해야 합니다.
하위 에이전트가 스폰 시 특정 도구를 사용할 권한이 있는지 여부
그것. 권한 확인은 일회성 게이트가 아닌 지속적으로 이루어집니다.
실행 과정 전반에 걸쳐 검증합니다.

### <a href="#rendering-contract-three-method-groups"
class="header">렌더링 계약: 세 가지 메소드 그룹</a>

`Tool` 인터페이스는 다음을 구성하는 렌더링 방법 세트를 정의합니다.
터미널 UI에 도구의 전체 수명 주기 표시(참조
섹션 2.5):

renderToolUseMessage // 도구가 호출될 때 표시됩니다.
renderToolUseProgressMessage // 실행 중 진행 상황을 표시합니다.
renderToolResultMessage // 실행이 완료된 후 결과를 표시합니다.

`renderToolUseErrorMessage`과 같은 선택적 메서드도 있습니다.
`renderToolUseRejectedMessage`(권한이 거부됨) 및
`renderGroupedToolUse`(병렬 도구의 그룹화된 표시).

-----------------------------------------------------------

## <a href="#22-the-buildtool-factory-function-and-fail-closed-defaults"
class="header">2.2 <code>buildTool()</code> 팩토리 함수 및
페일클로즈 기본값</a>

모든 콘크리트 도구는 다음을 충족하는 개체로 직접 내보내지지 않습니다.
`Tool` 인터페이스이지만 `buildTool()` 팩토리를 통해 구성됩니다.
기능. 이 함수는 다음에서 정의됩니다.
`restored-src/src/Tool.ts:783-792`:

``` typescript
export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}
```

런타임 동작은 최소화됩니다. 단지 객체가 확산될 뿐입니다. 하지만 그
유형 수준 디자인(`BuiltTool<D>` 유형)은 의미론을 정확하게 모델링합니다.
`{ ...TOOL_DEFAULTS, ...def }`: 도구 정의가
방법에서는 도구 정의 버전을 사용합니다. 그렇지 않으면 기본값을 사용합니다.

### <a href="#defaults-and-the-fail-closed-philosophy"
class="header">기본값 및 "Fail-Closed" 철학</a>

`TOOL_DEFAULTS`(`restored-src/src/Tool.ts:757-769`)이 설계되었습니다.
안전 원칙에 따라 — **다음과 같은 경우 가장 위험한 시나리오를 가정합니다.
불확실한**:

<div class="table-wrapper">

| 기본 방법 | 기본값 | 디자인 의도 |
|----|----|----|
| `isEnabled` | `() => true` | 명시적으로 비활성화하지 않는 한 도구는 기본적으로 사용 가능 |
| `isConcurrencySafe` | `() => false` | **Fail-closed**: 안전하지 않다고 가정하고 동시성을 금지합니다 |
| `isReadOnly` | `() => false` | **Fail-closed**: 쓰기를 가정하고 권한이 필요함 |
| `isDestructive` | `() => false` | 기본적으로 비파괴적 |
| `checkPermissions` | `{ behavior: 'allow' }` 반환 | 일반허가제 위임 |
| `toAutoClassifierInput` | `() => ''` | 기본적으로 자동 안전 분류에 참여하지 않습니다 |
| `userFacingName` | `() => def.name` | 도구 이름을 사용합니다 |

</div>

가장 중요한 두 가지 기본값은 `isConcurrencySafe: false`과
`isReadOnly: false`. 즉, 새 도구가 이를 선언하는 것을 잊어버린 경우
속성을 사용하면 시스템은 자동으로 "파일을 수정할 수 있습니다"로 처리합니다.
시스템이며 동시에 실행할 수 없습니다." - 가장 보수적이고 안전한 방법
추정. 도구 개발자가 적극적으로 선언한 경우에만
`isConcurrencySafe() { return true }` 및 `isReadOnly() { return true }`
시스템이 제한을 완화합니까?

### <a href="#how-actual-tools-use-buildtool" class="header">실제 상황
도구 <code>buildTool</code></a> 사용

`GrepTool`을 예로 들면
(`restored-src/src/tools/GrepTool/GrepTool.ts:160-194`):

``` typescript
export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  searchHint: 'search file contents with regex (ripgrep)',
  maxResultSizeChars: 20_000,
  strict: true,
  // ...
  isConcurrencySafe() { return true },   // Search is a safe concurrent operation
  isReadOnly() { return true },           // Search doesn't modify files
  // ...
})
```

`GrepTool`은 검색 작업으로 인해 두 가지 기본값을 명시적으로 재정의합니다.
본질적으로 읽기 전용이며 동시성이 안전합니다. 이에 비해 `BashTool`
(`restored-src/src/tools/BashTool/BashTool.tsx:434-441`)에는 조건부가 있습니다.
동시성 안전성:

``` typescript
isConcurrencySafe(input) {
  return this.isReadOnly?.(input) ?? false;
},
isReadOnly(input) {
  const compoundCommandHasCd = commandHasAnyCd(input.command);
  const result = checkReadOnlyConstraints(input, compoundCommandHasCd);
  return result.behavior === 'allow';
},
```

`BashTool`은 명령이 다음과 같이 결정된 경우에만 동시성을 허용합니다.
읽기 전용 — `git status`은 동시에 실행할 수 있지만 `git push`
할 수 없습니다. 이 **입력 인식 동시성 제어**가 `buildTool`의 이유입니다.
메소드 서명은 `input` 매개변수를 허용합니다.

-----------------------------------------------------------

## <a href="#23-tool-registration-pipeline-toolsts" class="header">2.3 도구
등록 파이프라인: <code>tools.ts</code></a>

`restored-src/src/tools.ts`은 Tool Pool의 조립 센터입니다. 그것
핵심 질문에 답합니다. **현재 환경에서 어떤 도구를 사용할 수 있나요?
모델 사용?**

### <a href="#three-level-filtering" class="header">3레벨
필터링</a>

도구는 정의에서 최종까지 세 가지 수준의 필터링을 거칩니다.
유효성:

**레벨 1: 컴파일 시간/시작 시간 조건부 로딩.** 다양한 도구
기능 플래그를 통해 조건부로 로드됩니다.
(`restored-src/src/tools.ts:16-135`):

``` typescript
const SleepTool =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./tools/SleepTool/SleepTool.js').SleepTool
    : null

const cronTools = feature('AGENT_TRIGGERS')
  ? [
      require('./tools/ScheduleCronTool/CronCreateTool.js').CronCreateTool,
      require('./tools/ScheduleCronTool/CronDeleteTool.js').CronDeleteTool,
      require('./tools/ScheduleCronTool/CronListTool.js').CronListTool,
    ]
  : []
```

`feature()` 함수는 `bun:bundle`에서 제공되며 다음에서 평가됩니다.
번들 시간. 이는 비활성화된 도구가 **최종 버전에 나타나지 않음을 의미합니다.
JavaScript 번들 전혀** — 더 철저한 형태의 데드 코드
런타임 `if` 문보다 제거됩니다.

기능 플래그 외에도 환경 변수 기반 플래그도 있습니다.
조건부 로딩:

``` typescript
const REPLTool =
  process.env.USER_TYPE === 'ant'
    ? require('./tools/REPLTool/REPLTool.js').REPLTool
    : null
```

`USER_TYPE === 'ant'`은 Anthropic 내부용 특수 도구를 표시합니다.
직원(예: `REPLTool`, `ConfigTool`, `TungstenTool`)
공개 버전에서는 사용할 수 없습니다.

**레벨 2: `getAllBaseTools()`는 기본 도구 풀을 조립합니다.** 이
함수(`restored-src/src/tools.ts:193-251`)는 다음과 같은 모든 도구를 수집합니다.
수준 1 필터링을 배열에 전달했습니다. 시스템의 "도구"입니다.
레지스트리" — 잠재적으로 존재하는 모든 도구가 여기에 등록됩니다.
현재 버전에는 동적으로 조정되는 약 40개 이상의 내장 도구가 포함되어 있습니다.
어떤 기능 플래그가 활성화되어 있는지에 따라 결정됩니다.

``` typescript
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    // ... 30+ more tools omitted
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
  ]
}
```

흥미로운 조건은 `hasEmbeddedSearchTools()`입니다. ~ 안에
Anthropic의 내부 빌드인 `bfs`(빠른 찾기) 및 `ugrep`이 포함되어 있습니다.
Bun 바이너리에서 셸의 `find` 및 `grep` 지점은
이미 이러한 빠른 도구의 별칭으로 지정되어 독립 실행형 `GlobTool` 및
`GrepTool` 중복됨.

**레벨 3: `getTools()` 런타임 필터링.** 최종 필터링입니다.
레이어(`restored-src/src/tools.ts:271-327`), 3개 수행
작업:

1. **권한 거부 필터링**: `filterToolsByDenyRules()` 제거
`alwaysDeny` 규칙이 적용되는 도구입니다. 사용자가 구성하는 경우
`"Bash": "deny"`, `BashTool`은(는) 전송된 도구 목록에 표시되지 않습니다.
모델이 전혀.
2. **REPL 모드 숨기기**: REPL 모드가 활성화되면 `Bash`, `Read`,
`Edit` 및 기타 기본 도구는 숨겨져 있으며 간접적으로 표시됩니다.
`REPLTool`의 VM 컨텍스트를 통해 노출됩니다.
3. **`isEnabled()` 최종 확인**: 각 도구의 `isEnabled()` 방법은 다음과 같습니다.
마지막 스위치.

### <a href="#simple-mode-vs-full-mode" class="header">단순 모드와 전체 모드
모드</a>

`getTools()`은 "단순 모드"(`CLAUDE_CODE_SIMPLE`)도 지원합니다.
`Bash`, `FileRead`, `FileEdit`(세 가지 핵심 도구)만 노출합니다.
이는 일부 통합 시나리오에서 유용합니다.
도구는 토큰 소비를 줄이고 모델의 결정 부담을 줄입니다.

### <a href="#mcp-tool-integration" class="header">MCP 도구 통합</a>

최종 도구 풀은 `assembleToolPool()`에 의해 조립됩니다.
(`restored-src/src/tools.ts:345-367`):

``` typescript
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}
```

여기에는 두 가지 주요 디자인이 있습니다.

1. **내장 도구가 우선순위를 가집니다**: `uniqBy`가 첫 번째를 유지합니다.
각 이름의 발생; 내장 도구가 먼저 나열되므로
이름 충돌에서 승리하세요.
2. **안정적인 프롬프트 캐싱을 위해 이름별로 정렬**: 내장 도구 및
MCP 도구는 각각 정렬된 다음 연결됩니다(대신
인터리브됨) 내장 도구가 "연속적인"
접두사." 이는 API 서버 측의 캐시 중단점과 함께 작동합니다.
디자인 — MCP 도구가 내장 도구 사이에 분산되어 있는 경우
MCP 도구를 추가하거나 제거하면 모든 다운스트림이 무효화됩니다.
캐시 키. 13장을 참조하세요.

-----------------------------------------------------------

## <a href="#24-tool-result-size-budget" class="header">2.4 도구 결과
규모예산</a>

도구가 결과를 반환하면 시스템은 핵심 장력에 직면하게 됩니다.
올바른 결정을 내리려면 완전한 정보를 확인해야 하지만,
컨텍스트 창이 제한되어 있습니다. Claude Code는 **2단계를 통해 이 문제를 해결합니다.
예산**.

### <a href="#level-1-per-tool-result-limit-maxresultsizechars"
class="header">레벨 1: 도구별 결과 제한
<code>maxResultSizeChars</code></a>

각 도구는 다음을 통해 자체 결과 크기 제한을 선언합니다.
`maxResultSizeChars` 필드. 이 제한을 초과하는 결과는 지속됩니다.
모델에는 미리보기와 디스크 파일 경로만 표시됩니다.

다음은 여러 도구의 `maxResultSizeChars` 비교입니다.

<div class="table-wrapper">

| 도구 | `maxResultSizeChars` | 메모 |
|----|---------|----------------------|
| `McpAuthTool` | 10,000 | 인증 결과, 데이터 양이 적음 |
| `GrepTool` | 20,000 | 검색결과는 간결해야 합니다 |
| `BashTool` | 30,000 | 쉘 출력이 길어질 수 있음 |
| `GlobTool` | 100,000 | 파일 목록은 다양할 수 있습니다 |
| `AgentTool` | 100,000 | 하위 에이전트 결과 |
| `WebSearchTool` | 100,000 | 웹 검색결과 |
| `BriefTool` | 100,000 | 간략한 요약 |
| `FileReadTool` | **인피니티** | 지속되지 않음(아래 참조) |

</div>

`FileReadTool`의 `maxResultSizeChars: Infinity`은 특별한 디자인이에요 —
읽기 -\> 파일 유지 -\> 읽기의 순환 참조를 피합니다.
시스템에는 글로벌 한도도 있습니다.
`DEFAULT_MAX_RESULT_SIZE_CHARS = 50,000`
(`restored-src/src/constants/toolLimits.ts:13`), 이는 하드 역할을 합니다.
도구가 선언하는 내용에 관계없이 cap을 사용합니다.

### <a href="#level-2-per-message-aggregate-limit" class="header">레벨 2:
메시지당 집계 제한</a>

모델이 단일 회전 내에서 여러 도구를 병렬로 호출하는 경우,
모든 도구 결과는 여러 `tool_result` 블록으로 전송됩니다.
동일한 사용자 메시지. `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200,000`
(`restored-src/src/constants/toolLimits.ts:49`)은 전체 크기를 제한합니다.
도구는 단일 메시지를 생성하므로 N개의 병렬 도구가
전체적으로 컨텍스트 창을 압도합니다.

FileReadTool Infinity 설계 이론적 근거, 메시지당 예산
지속성 구현 세부 정보(`ContentReplacementState` 포함)
결정 지속성 및 무한 면제 메커니즘)이 다뤄집니다.
4장에서.

### <a href="#size-budget-parameters-summary" class="header">예산 규모
매개변수 요약</a>

<div class="table-wrapper">

| 상수 | 가치 | 정의 위치 |
|----|----|----|
| `DEFAULT_MAX_RESULT_SIZE_CHARS` | 50,000자 | `constants/toolLimits.ts:13` |
| `MAX_TOOL_RESULT_TOKENS` | 100,000개의 토큰 | `constants/toolLimits.ts:22` |
| `MAX_TOOL_RESULT_BYTES` | 400,000바이트 | `constants/toolLimits.ts:33` (= 100K 토큰 x 4바이트/토큰) |
| `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` | 200,000자 | `constants/toolLimits.ts:49` |
| `TOOL_SUMMARY_MAX_LENGTH` | 50자 | `constants/toolLimits.ts:57` |

</div>

-----------------------------------------------------------

## <a href="#25-three-phase-rendering-flow" class="header">2.5 3상
렌더링 흐름</a>

터미널 UI의 도구 표시는 일회성 이벤트가 아니라
3단계 진행 과정. 이 세 단계는 해당됩니다.
도구 실행 수명 주기와 일대일로 진행됩니다.

### <a href="#flow-diagram" class="header">흐름도</a>

``` mermaid
flowchart TD
    A["Model emits tool_use block<br/>(parameters may not be fully streamed yet)"] --> B
    B["Phase 1: renderToolUseMessage<br/>Tool invoked, display name and parameters<br/>Parameters are Partial&lt;Input&gt; (streaming)"]
    B -->|Tool starts executing| C
    C["Phase 2: renderToolUseProgressMessage<br/>Executing, show progress<br/>Updated via onProgress callback"]
    C -->|Tool execution complete| D
    D["Phase 3: renderToolResultMessage<br/>Complete, display results"]
```

### <a href="#phase-1-rendertoolusemessage--intent-display"
class="header">1단계: <code>renderToolUseMessage</code> — 인텐트
디스플레이</a>

모델이 `tool_use` 블록을 출력할 때 이 메서드가 호출됩니다.
즉시. 서명의 키 유형을 참고하세요.

``` typescript
renderToolUseMessage(
  input: Partial<z.infer<Input>>,  // Note: Partial!
  options: { theme: ThemeName; verbose: boolean; commands?: Command[] },
): React.ReactNode
```

`input`은 `Partial`입니다. 왜냐하면 API는 도구 매개변수 JSON을
스트리밍 방식이며 JSON 구문 분석이 완료되기 전에는 일부 필드만
사용할 수 있습니다. 매개변수가 있는 경우에도 UI를 렌더링할 수 있어야 합니다.
불완전 — 사용자에게 빈 화면이 표시되어서는 안 됩니다.

`command` 필드가 아직 설정되지 않은 경우에도 `BashTool`을 예로 들어 보겠습니다.
완전히 수신되면 UI에 이미 "Bash" 라벨이 표시될 수 있으며
지금까지 수신된 부분 명령 텍스트입니다.

### <a href="#phase-2-rendertooluseprogressmessage--process-visibility"
class="header">2단계: <code>renderToolUseProgressMessage</code> —
프로세스 가시성</a>

이는 **선택적** 방법입니다. 장기 실행 도구(예: `BashTool`,
`AgentTool`) 진행 상황에 대한 피드백이 중요합니다. `BashTool`이 표시되기 시작합니다.
쉘 명령이 2시간 이상 실행된 후 진행
초(`PROGRESS_THRESHOLD_MS = 2000`,
`restored-src/src/tools/BashTool/BashTool.tsx:55`).

진행 상황은 `onProgress` 콜백을 통해 전달됩니다. 각 도구의
진행률 데이터 구조가 다릅니다. — `BashTool`의 `BashProgress`
stdout/stderr 조각을 포함하는 반면 `AgentTool`은
`AgentToolProgress`에는 하위 에이전트의 메시지 스트림이 포함됩니다. 이러한 유형
`restored-src/src/types/tools.ts`에 균일하게 정의되어 있으며 제약이 있습니다.
`ToolProgressData` 공용체 유형을 통해.

### <a href="#phase-3-rendertoolresultmessage--result-presentation"
class="header">3단계: <code>renderToolResultMessage</code> — 결과
프리젠테이션</a>

이는 **선택적** 방법이기도 합니다. 생략하면 도구 결과가
터미널에서 렌더링됩니다(예를 들어 `TodoWriteTool`의 결과는
대화 흐름이 아닌 전용 패널을 통해 표시됨)

`renderToolResultMessage`은 `style?: 'condensed'` 옵션을 허용합니다. ~ 안에
비상세 모드, 검색 유형 도구(`GrepTool`, `GlobTool`) 표시
간결한 요약(예: "3개 디렉터리에서 42개 파일 발견")
상세 모드에서는 전체 결과가 표시됩니다. 도구를 사용할 수 있습니다
`isResultTruncated(output)` 현재 결과가 다음과 같은지 UI에 알려줍니다.
잘려서 전체 화면 모드에서 "클릭하여 확장" 상호 작용을 활성화합니다.

### <a href="#grouped-rendering-rendergroupedtooluse" class="header">그룹화됨
렌더링: <code>renderGroupedToolUse</code></a>

모델이 동일한 유형의 여러 도구를 병렬로 호출하는 경우
단일 차례(예: 5 `Grep` 검색), 각각을 개별적으로 렌더링
상당한 화면 공간을 소비하게 됩니다. `renderGroupedToolUse`
메서드를 사용하면 도구에서 여러 병렬 호출을 압축된 코드로 병합할 수 있습니다.
그룹화된 보기 — 예: "5개의 패턴을 검색하여 127개의 결과를 찾았습니다."
34개 파일에 걸쳐 있습니다."

이 방법은 **비상세 모드**에서만 적용됩니다. 상세 모드에서는
각 도구 호출은 여전히 ​​원래 위치에서 독립적으로 렌더링됩니다.
디버깅 중에 정보가 손실되지 않도록 합니다.

-----------------------------------------------------------

## <a href="#26-design-patterns-from-specific-tools" class="header">2.6
특정 도구의 디자인 패턴</a>

### <a href="#bashtool-the-most-complex-tool" class="header">BashTool:
가장 복잡한 도구</a>

`BashTool`(`restored-src/src/tools/BashTool/BashTool.tsx`)이 가장 많습니다.
전체 도구 시스템에서 복잡한 단일 도구를 의미하기 때문에
쉘 명령의 공간은 무한합니다. 다음이 필요합니다.

- **명령 구조를 구문 분석**하여 읽기 전용인지 확인합니다(다음을 통해).
`checkReadOnlyConstraints` 및 `parseForSecurity`)
- **파이프 및 복합 명령 이해** (`ls && echo "---" && ls`
여전히 읽기 전용입니다)
- **조건부 동시성**: 읽기 전용 명령만 실행할 수 있습니다.
동시에
- **진행 상황 추적**: 2초 이상 실행되는 명령 표시
스트리밍 표준 출력
- **파일 변경 추적**: 쉘로 인한 파일 수정 사항을 기록합니다.
`fileHistoryTrackEdit` 및 `trackGitOperations`을 통한 명령
- **샌드박스 실행**: 아래의 `SandboxManager`을 통해 격리되어 실행됩니다.
특정 조건

`BashTool`의 `maxResultSizeChars`은 30,000으로 설정됩니다.
`GrepTool`의 20,000(셸 출력에는 일반적으로 더 많은 내용이 포함되어 있으므로)
구조화된 정보(컴파일 오류, 테스트 결과 등) 및
모델은 올바른 결정을 내리기 위해 충분한 맥락을 확인해야 합니다.

### <a href="#greptool-the-exemplar-of-concurrency-safety"
class="header">GrepTool: 동시성 안전성의 모범</a>

`GrepTool`의 디자인은 비교적 깔끔합니다. 무조건 선언한다
`isConcurrencySafe: true` 및 `isReadOnly: true`, 검색하기 때문에
작업은 파일 시스템을 수정하지 않습니다. `maxResultSizeChars`이 설정되었습니다.
~ 20,000 — 이 길이를 초과하는 검색 결과는 모델의
검색 범위가 너무 광범위하고 미리보기를 통해 디스크에 유지됩니다.
실제로 모델이 전략을 조정하는 데 도움이 됩니다.

### <a href="#filereadtool-the-philosophy-of-infinity"
class="header">FileReadTool: <code>Infinity</code></a>의 철학

`FileReadTool`은 `maxResultSizeChars`을 `Infinity`로 설정하고 대신 선택합니다.
자체 `maxTokens` 및 `maxSizeBytes`을 통해 출력 크기를 제어합니다.
제한. 이는 앞서 언급한 순환 읽기 문제를 방지하고
`FileReadTool`의 결과가 디스크 참조로 대체되지 않음을 의미합니다.
모델은 항상 파일 내용을 직접 봅니다.

-----------------------------------------------------------

## <a href="#27-deferred-loading-and-toolsearch" class="header">2.7
지연 로딩 및 ToolSearch</a>

도구 수가 특정 임계값을 초과하는 경우(특히 이후
많은 MCP 도구가 연결되어 있음) 모든 도구의 전체 스키마를
모델은 상당한 토큰을 소비합니다. Claude Code는 다음을 통해 이 문제를 해결합니다.
**지연 로딩** 메커니즘.

`shouldDefer: true`으로 표시된 도구는 도구 이름만 전송합니다.
전체 매개변수 스키마가 아닌 초기 프롬프트(`defer_loading: true`).
모델은 먼저 `ToolSearchTool`을 호출하여 키워드로 검색해야 하며
지연된 도구를 호출하기 전에 도구의 전체 정의를 검색합니다.
도구.

각 도구의 `searchHint` 필드는 이러한 목적으로 설계되었습니다.
`ToolSearchTool`에 도움이 되는 3~10단어 기능 설명을 제공합니다.
키워드 매칭을 수행합니다. 예를 들어 `GrepTool`의 `searchHint`은(는)
`'search file contents with regex (ripgrep)'`.

`alwaysLoad: true`으로 표시된 도구는 결코 연기되지 않습니다.
스키마는 항상 초기 프롬프트에 나타납니다. 이는 핵심 도구에 대한 것입니다.
모델은 첫 번째 대화 차례에서 직접 호출할 수 있어야 합니다.

-----------------------------------------------------------

## <a href="#28-pattern-extraction" class="header">2.8 패턴
추출</a>

Claude Code의 도구 시스템 설계에서 보편적인 여러 패턴
AI Agent 빌더의 값을 추출할 수 있습니다.

**패턴 1: 페일클로즈 기본값.** `buildTool()`의 기본값은
가장 위험한 시나리오(동시성이 안전하지 않고 읽기 전용이 아님)
도구 개발자가 안전한 속성을 적극적으로 선언합니다. 이는 안전성을 뒤집는다
"선택"에서 "선택 해제"로 변경하여 누락으로 인한 위험을 크게 줄입니다.

**패턴 2: 계층화된 예산 관리.** 단일 도구 결과에는 한도가 있습니다.
단일 메시지에도 집계 한도가 있습니다. 두 가지 수준
서로 보완 - 도구별 제한으로 인해 단일 지점 폭주가 방지됩니다.
메시지 제한은 병렬 호출로 인한 집단적 폭발을 방지합니다.

**패턴 3: 입력 인식 속성** `isConcurrencySafe(input)` 및
`isReadOnly(input)` 전역화하는 대신 도구 입력을 받습니다.
판단. 같은 `BashTool`이라도 안전성이 완전히 다릅니다
`ls` 대 `rm`에 대한 속성입니다. 이러한 세밀한 입력 인식은
정확한 권한 제어를 위한 기반입니다. 4장을 참조하세요.

**패턴 4: 프로그레시브 렌더링.** 3단계 렌더링(의도 -\>
진행률 -\> 결과)는 도구의 모든 단계에서 사용자에게 가시성을 제공합니다.
실행. `Partial<Input>` 디자인은 UI가 비어 있지 않도록 보장합니다.
매개변수 스트리밍 중. 이는 사용자 신뢰에 매우 중요합니다. 사용자에게는 다음이 필요합니다.
회전하는 것을 쳐다보기보다는 에이전트가 무엇을 하고 있는지 알기 위해
로딩 아이콘입니다.

**패턴 5: 컴파일 시간 제거와 런타임 필터링 비교.** 기능
플래그는 `bun:bundle`의 `feature()`을 사용하여 비활성화된 도구 코드를 제거합니다.
컴파일 시간에는 권한 규칙이 도구 목록을 런타임에 필터링합니다.
두 가지 메커니즘은 서로 다른 목적으로 사용됩니다. 전자는 번들을 줄입니다.
크기와 공격 표면이 있으며 후자는 사용자 수준 구성을 지원합니다.

-----------------------------------------------------------

## <a href="#what-you-can-do" class="header">할 수 있는 일</a>

Claude Code의 도구 시스템 설계 경험을 바탕으로 다음과 같은 작업을 수행합니다.
자신만의 AI Agent 도구 시스템을 구축할 때 다음을 수행할 수 있습니다.

- **"실패 시 닫힘" 기본값을 채택합니다.** 도구 등록 프레임워크에서
`isConcurrencySafe`과 같은 안전 속성의 기본값을 설정합니다.
그리고 `isReadOnly`은 가장 보수적인 옵션입니다. 도구를 가지고
개발자는 가정하기보다는 안전 속성을 적극적으로 선언합니다.
기본적으로 안전합니다.
- **모든 도구에 대한 결과 크기 제한을 설정합니다.** 도구가 반환되지 않도록 합니다.
무한히 큰 결과. 도구별 제한을 설정합니다(예:
`maxResultSizeChars`) 및 메시지별 집계 제한; 초과했을 때,
디스크에 유지하고 미리보기를 반환합니다.
- **정적 문자열이 아닌 도구 설명 기능을 만드세요.**
도구는 권한에 따라 동작 제한이 다릅니다.
모드 또는 컨텍스트를 동적으로 생성하는 설명을 통해
프롬프트 수준에서 잘못된 호출을 방지하기 위한 모델입니다.
- **3단계 렌더링을 구현합니다.** 다음에 대한 진행 피드백을 제공합니다.
장기 실행 도구(의도 표시 -\> 실행 진행률 -\> 최종
결과), 사용자는 항상 에이전트가 수행하는 작업을 알 수 있습니다. 지원하다
`Partial<Input>`은 매개변수 스트리밍 중에도 렌더링을 활성화합니다.
- **조건부 로딩을 사용하여 도구 세트를 줄입니다.** 필터링
기능 플래그를 통해 컴파일 시간/시작 시 불필요한 도구 또는
환경 변수, 토큰 소비 및 모델 결정 감소
부담. MCP 도구가 많은 시나리오의 경우 지연 로딩을 고려하세요.
기구.
- **도구 주문을 안정적으로 유지합니다.** API 프롬프트 캐싱을 사용하는 경우 다음을 확인하세요.
도구 목록 순서는 요청 전반에 걸쳐 안정적으로 유지됩니다. 내장형
도구를 연속 접두사로 지정하고 이름별로 정렬된 MCP 도구를 추가합니다.
빈번한 캐시 키 무효화를 피하십시오.

-----------------------------------------------------------

## <a href="#summary" class="header">요약</a>

Claude Code의 도구 시스템은 신중하게 계층화된 아키텍처입니다.
`Tool` 인터페이스는 계약을 정의하고, `buildTool()`은 안전한 제공을 제공합니다.
기본값에서는 `tools.ts` 등록 파이프라인이 도구 풀을 어셈블합니다.
컴파일 타임 및 런타임 2단계 필터링을 통해 크기 예산
메커니즘은 도구별 및 메시지별 모두에서 컨텍스트 소비를 제어합니다.
수준 및 3단계 렌더링을 통해 도구 실행 프로세스가 완전히 완료됩니다.
사용자에게 투명합니다.

이 시스템의 디자인 철학은 한 문장으로 요약될 수 있습니다.
**옳은 일은 쉽게 하고, 위험한 일은 어렵게 만드세요.**
`buildTool()`의 페일클로즈 기본값은 "안전 선언을 잊어버리게 만듭니다"
속성"은 안전한 실수입니다. 계층화된 예산으로 인해 "도구도 반환됩니다."
많은 데이터"는 제어 가능한 성능 저하, 조건부 로딩은 "추가"를 만듭니다.
실험 도구"는 위험이 전혀 없는 작업입니다.

도구 호출 및 오케스트레이션 - 전체 권한 포함
흐름 확인, 동시 실행 스케줄링 전략, 스트리밍
진행 전파 메커니즘 - 4장에서 자세히 다룰 것입니다.
