# <a
href="#chapter-30-build-your-own-ai-agent--from-claude-code-patterns-to-practice"
class="header">30장: 자신만의 AI 에이전트 구축 — Claude 코드 패턴에서 실습까지</a>

## <a href="#why-this-chapter-exists" class="header">이 장이 존재하는 이유</a>

### <a href="#why-not-build-your-own-claude-code" class="header">"자신만의 클로드 코드 구축"을 시도해 보세요.</a>

독자들은 다음과 같이 예상할 수 있습니다. 이전 29개 장에서 모든 클로드 코드 하위 시스템을 분석했으므로 이 장에서는 하위 시스템을 다시 조립하는 방법을 가르쳐야 합니다. 그러나 그것이 바로 우리가 **하지 않을** 일입니다.

Claude Code는 **제품**입니다. 40개 이상의 도구, 특정 UI 상호 작용, 특정 세션 형식, 특정 청구 통합이 포함되어 있습니다. 이러한 구현 세부 정보를 복제하는 것은 의미가 없습니다. 에이전트는 코딩 보조자가 될 필요가 없습니다. 보안 스캐너, 데이터 파이프라인 모니터, 코드 검토 도구 또는 고객 서비스 봇일 수 있습니다. "Claude Code의 FileEditTool 구현 방법"을 가르쳤다면 다른 맥락에서는 완전히 이전할 수 없을 것입니다.

이 책의 처음 29개 장은 구현 세부 사항이 아니라 **패턴**, 즉 프롬프트 계층화, 컨텍스트 예산 책정, 도구 샌드박싱, 단계적 권한, 회로 차단 재시도, 구조화된 관찰 가능성을 담고 있습니다. 이러한 패턴은 특정 제품 형태에 묶여 있지 않으며 모든 에이전트 시나리오로 전송될 수 있습니다.

따라서 이 장은 **완전히 다른 에이전트**(코딩 도우미가 아닌 코드 검토), **완전히 다른 언어**(TypeScript가 아닌 Rust), **완전히 다른 실행 모델**(Claude Code에 위임하지 않고 에이전트 루프를 직접 제어)를 사용하여 동일한 22개 패턴이 애플리케이션에서 어떻게 결합되는지 보여줍니다. 패턴이 이러한 종류의 시나리오 간, 언어 간, 아키텍처 간 전송에서 살아남을 수 있다면 이는 Claude Code 관련 지식이 아니라 진정으로 재사용 가능한 에이전트 엔지니어링 원칙입니다.

### <a
href="#combining-patterns-is-harder-than-understanding-them-individually"
class="header">패턴을 결합하는 것은 개별적으로 이해하는 것보다 어렵습니다.</a>

25~27장은 22개의 명명된 패턴과 원리를 정리했습니다. 그러나 패턴의 가치는 열거가 아닌 조합에 있습니다. "**모든 것에 예산 책정**"(26장 참조)을 이해하는 것만으로는 어렵지 않지만, "**캐시 인식 설계**"(25장 참조)를 깨지 않고 "**알고 숨기지 마세요**"(26장 참조)와 함께 작업해야 하는 경우 엔지니어링 복잡성이 급격히 증가합니다.

이 장에서는 **진정으로 실행 가능한 프로젝트**(Rust의 최대 800줄)를 사용하여 분석 결과에서 이러한 패턴을 자신의 코드로 전환하는 방법을 보여줍니다.

우리 프로젝트는 **Rust 코드 검토 에이전트**입니다. Git diff를 입력하고 구조화된 검토 보고서를 출력합니다. 파일 읽기(컨텍스트 관리), 코드 검색(도구 오케스트레이션), 문제 분석(프롬프트 제어), 권한 제어(보안 제약 조건), 오류 처리(복원력), 품질 추적(관찰 가능성) 등 에이전트 구성의 핵심 차원을 자연스럽게 다루기 때문에 이 시나리오를 선택했습니다. 그리고 모든 개발자가 코드 검토를 완료했으므로 시나리오에 대한 추가 설명은 필요하지 않습니다.

## <a href="#301-project-definition-code-review-agent" class="header">30.1 프로젝트 정의: 코드 검토 에이전트</a>

### <a href="#cc-sdk-claude-codes-rust-sdk" class="header">cc-sdk: Claude Code의 Rust SDK</a>

프로젝트를 소개하기 전에 핵심 종속성인 [`cc-sdk`](https://crates.io/crates/cc-sdk) ([GitHub](https://github.com/zhanghandong/claude-code-api-rs))를 살펴보겠습니다. 이는 하위 프로세스를 통해 Claude Code CLI와 상호 작용하는 커뮤니티에서 관리하는 Rust SDK입니다. 세 가지 사용 모드를 제공합니다.

<div class="table-wrapper">

| 방법 | API | 에이전트 루프 | 도구 | 인증 방법 | 적합 |
|----|----|----|----|----|----|
| **풀 에이전트** | `cc_sdk::query()` | CC 내부 | CC 내장 도구 | API 키 또는 CC 구독 | 파일을 자동으로 읽고 쓰며 명령을 실행하려면 에이전트가 필요합니다. |
| **대화형 클라이언트** | `ClaudeSDKClient` | CC 내부 | CC 내장 도구 | API 키 또는 CC 구독 | 다단계 대화, 세션 관리 |
| **LLM 프록시** | `cc_sdk::llm::query()` | **귀하의 코드** | **없음(모두 비활성화됨)** | CC 구독(API 키 필요 없음) | 입력이 알려져 있으며 텍스트 분석만 필요함 |

</div>

LLM 프록시 모드(v0.8.1의 새로운 기능)는 이 장의 핵심입니다. 이는 Claude Code CLI를 순수 LLM 프록시로 처리하며 `--tools ""`는 모든 도구를 비활성화하고 `PermissionMode::DontAsk`는 모든 도구 요청을 거부하며 `max_turns: 1`는 단일 회전으로 제한합니다. 더 중요한 것은 Claude Code 구독 인증을 사용하므로 별도의 `ANTHROPIC_API_KEY`가 필요하지 않습니다.

### <a href="#project-definition" class="header">프로젝트 정의</a>

프로젝트의 입력, 출력 및 제약 조건은 다음과 같습니다.

- **입력**: 통합 diff 파일(`git diff` 또는 PR에서)
- **출력**: 각 결과에 파일, 줄 번호, 심각도 수준, 카테고리 및 수정 제안이 포함된 구조화된 검토 보고서(JSON 또는 Markdown)
- **제약조건**: 읽기 전용(검토된 코드를 수정하지 않음), 토큰 예산이 있고 추적 가능

주요 아키텍처 결정은 **에이전트 루프가 자체 코드에 있으며** LLM 백엔드가 연결 가능하다는 것입니다. `LlmBackend` 특성을 통해 검토 논리를 수정하지 않고도 Claude(cc-sdk) 또는 GPT(Codex 구독)에서 동일한 에이전트를 구동할 수 있습니다.

전체 코드는 이 프로젝트의 `examples/code-review-agent/` 디렉토리에 있습니다.

``` mermaid
flowchart TB
    A["Git Diff Input"] --> B["Diff Parsing + Budget Control"]
    B --> C["Per-File Agent Loop"]
    C --> C1["Turn 1: Review diff"]
    C1 --> C2["Turn 2: Decision"]
    C2 -->|"done"| C5["Aggregate findings"]
    C2 -->|"use_tool: bash"| C3["Execute bash\n(read-only sandbox)"]
    C3 --> C2
    C2 -->|"use_tool: skill"| C4["Run skill\n(specialized analysis)"]
    C4 --> C5
    C2 -->|"review_related"| C6["Review related file"]
    C6 --> C5
    C5 -->|"next file"| C
    C5 --> D["Output Report\nJSON/Markdown"]

    subgraph LLM["Pluggable LLM Backend"]
        L1["cc-sdk\nClaude subscription"]
        L2["Codex\nGPT subscription"]
        L3["WebSocket\nRemote connection"]
    end

    C1 -.-> LLM
    C2 -.-> LLM
    C4 -.-> LLM
    C6 -.-> LLM
```

각 파일 검토는 최대 3회의 LLM 호출(검토 → 결정 → 후속 조치)과 최대 3회의 도구 호출을 거칩니다. LLM은 도구를 직접 실행하지 않습니다. JSON 요청(`AgentAction`)을 출력하고 Rust 코드는 이를 실행할지 여부와 방법을 결정합니다.

> **에이전트 루프를 직접 제어해야 하는 이유는 무엇입니까?** Claude Code의 내장 에이전트(`cc_sdk::query`)에 위임하는 것이 더 간단하지만 세부적인 제어 기능을 잃게 됩니다. 즉, 파일별 회로 차단, 예산 할당, 도구 화이트리스트 지정 및 크로스 백엔드 전환을 구현할 수 없습니다. 루프를 직접 제어한다는 것은 모든 결정 지점이 명시적이라는 것을 의미합니다. 이것이 하네스 엔지니어링의 핵심입니다.

프로젝트의 코드 아키텍처는 우리가 논의할 6개 계층에 직접 매핑됩니다.

<div class="table-wrapper">

| 코드 모듈 | 해당 레이어 | 핵심 패턴 적용 |
|----|----|----|
| `prompts.rs` | L1 프롬프트 아키텍처 | 제어 평면, 대역 외 제어 채널, 도구 수준 프롬프트 등의 프롬프트 |
| `context.rs` | L2 컨텍스트 관리 | 모든 것에 예산을 책정하고, 상황을 위생적으로 파악하고, 숨기지 말고 알리세요. |
| `agent.rs` + `tools.rs` | L3 도구 및 검색 | 편집 전 읽기, 구조화된 검색 |
| `llm.rs` + `tools.rs` | L4 보안 및 권한 | 실패 시 종료, 자율화 |
| `resilience.rs` | L5 탄력성 | 유한한 재시도 예산, 회로 차단 런어웨이 루프, 적절한 크기의 도우미 경로 |
| `agent.rs`(추적) | L6 관찰 가능성 | 고치기 전 관찰, 구조화된 검증 |

</div>

다음으로 우리는 레이어별로 분석합니다. 각 레이어는 먼저 Claude Code 소스 코드의 패턴 프로토타입을 검사한 다음 Rust 구현을 검사합니다.

## <a href="#302-layer-one-prompt-architecture" class="header">30.2 레이어 1: 프롬프트 아키텍처</a>

**적용 패턴**: **제어 평면으로서의 프롬프트**(25장 참조), **대역 외 제어 채널**(25장 참조), **도구 수준 프롬프트**(27장 참조), **범위 일치 응답**(27장 참조)

### <a href="#patterns-in-cc-source-code" class="header">CC 소스 코드의 패턴</a>

Claude Code의 신속한 아키텍처에는 **안정적인 부분과 휘발성 부분을 분리**하는 핵심 설계가 있습니다. 안정적인 부분은 캐시되며(프롬프트 캐시를 중단하지 않음), 휘발성 부분은 명시적으로 "위험"으로 표시됩니다.

``` typescript
// restored-src/src/constants/systemPromptSections.ts:20-24
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false }
}
```

``` typescript
// restored-src/src/constants/systemPromptSections.ts:32-38
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
}
```

`DANGEROUS_` 접두사는 장식이 아니며 엔지니어링 제약 사항입니다. 매 턴마다 다시 계산해야 하는 프롬프트 섹션은 이 함수를 통해 생성되어야 하며 개발자는 캐시 중단이 필요한 이유를 설명하는 `_reason` 매개변수를 입력해야 합니다. 이것은 **대역외 제어 채널** 패턴의 구현입니다. 주석이 아닌 함수 서명을 통해 동작을 제한합니다.

### <a href="#rust-implementation" class="header">러스트 구현</a>

우리의 코드 검토 에이전트는 동일한 계층 접근 방식을 채택하지만 "Constitution" 계층과 "런타임" 계층으로 구현이 더 간단합니다.

#![allow(unused)] fn main() { // 예제/code-review-agent/src/prompts.rs:38-42 pub fn build_system_prompt(pr_info: &PrInfo) -> String { let Constitution = build_constitution(); 런타임 = build_runtime_section(pr_info); format!("{헌법}\n\n---\n\n{런타임}") } }

헌법 계층은 정적입니다. 원칙, 심각도 수준 정의, 출력 형식 사양을 검토합니다. 이 내용은 모든 검토 세션에서 동일합니다.

#![allow(unused)] fn main() { // example/code-review-agent/src/prompts.rs:45-84 fn build_constitution() -> String { r#"# 코드 검토 에이전트 — 헌법

당신은 코드 검토 에이전트입니다. 귀하의 임무는 차이점을 검토하고 구조화된 결과 목록을 생성하는 것입니다.

    # 검토 원칙 1. **정확성 우선**: 논리 오류, 개별 버그 신고... 2. **보안**: 주입 취약점 식별... // ...

    # 출력 형식 찾기 개체의 JSON 배열을 출력해야 합니다..."# .to_string() } }

런타임 레이어는 동적입니다. 현재 PR 제목, 변경된 파일 목록, 파일 확장자에서 유추되는 언어별 규칙은 다음과 같습니다.

#![allow(unused)] fn main() { // 예제/code-review-agent/src/prompts.rs:113-154 fn infer_언어_rules(files: &[String]) -> String { let mut rule = Vec::new(); mut see_rust = false로 두십시오; // ... 파일의 파일에 대해 { if !seen_rust && file.ends_with(".rs") { visible_rust = true; rule.push("## Rust 관련 규칙\n- `.unwrap()`를 확인하세요..."); } // TypeScript, Python 규칙은 유사합니다... } rule.join("\n\n") } }

**범위 일치 응답** 패턴은 출력 형식 설계에 반영됩니다. 모델은 자유 텍스트가 아닌 JSON 배열을 출력해야 하며 각 결과는 고정된 필드 구조를 갖습니다. 이는 미적인 측면을 위한 것이 아닙니다. 다운스트림 `parse_findings_from_response`가 결과를 안정적으로 구문 분석할 수 있도록 하기 위한 것입니다.

## <a href="#303-layer-two-context-management" class="header">30.3 계층 2: 컨텍스트 관리</a>

**적용 패턴**: **모든 것에 예산 책정**(26장 참조), **컨텍스트 위생**(26장 참조), **알리고 숨기지 마세요**(26장 참조), **보수적으로 추정**(26장 참조)

### <a href="#patterns-in-cc-source-code-1" class="header">CC 소스 코드의 패턴</a>

Claude Code에는 컨텍스트 관리를 위한 세 가지 예산 제약 계층(도구별 결과 한도, 메시지별 집계 한도, 전역 컨텍스트 창)이 있습니다. 키 상수는 동일한 파일에 정의되어 있습니다.

``` typescript
// restored-src/src/constants/toolLimits.ts:13
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000

// restored-src/src/constants/toolLimits.ts:22
export const MAX_TOOL_RESULT_TOKENS = 100_000

// restored-src/src/constants/toolLimits.ts:49
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000
```

콘텐츠가 잘리면 CC는 자동으로 삭제되지 않습니다. 메타 정보를 보존하여 전체 콘텐츠가 어디에 있는지 모델에 알려줍니다.

``` typescript
// restored-src/src/utils/toolResultStorage.ts:30-34
export const PERSISTED_OUTPUT_TAG = '<persisted-output>'
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>'
export const TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]'
```

이것이 바로 **알리고 숨기지 마세요**입니다. 잘림은 피할 수 없지만 모델은 이러한 일이 발생했고 전체 정보가 어디에 있는지 알아야 합니다.

### <a href="#rust-implementation-1" class="header">러스트 구현</a>

우리 에이전트는 파일당 한도 + 총 예산이라는 동일한 이중 계층 예산을 구현합니다. `ContextBudget` 구조체는 할당 전에 확인하고 이후에 기록합니다.

#![allow(unused)] fn main() { // 예제/code-review-agent/src/context.rs:12-45 pub struct ContextBudget { pub max_total_tokens: usize, pub max_file_tokens: usize, pub Used_tokens: usize, }

impl ContextBudget { pub fn 남은(&self) -> usize { self.max_total_tokens.saturating_sub(self.used_tokens) }

pub fn try_consume(&mut self, tokens: usize) -> bool { if self.used_tokens + tokens <= self.max_total_tokens {
                self.used_tokens += tokens;
                true
            } else {
                false
            }
        }
    }
    }

**Context Hygiene** is reflected in the PHXCODE00041PHX function — for
each file, first check total budget remaining, then apply per-file cap,
with exceeded files skipped rather than silently discarded:

    #![allow(unused)]
    fn main() {
    // examples/code-review-agent/src/context.rs:201-245
    pub fn apply_budget(diff: &DiffContext, budget: &mut ContextBudget) -> (DiffContext, usize) { let mut files = Vec::new(); mut 건너뛰기를 = 0으로 설정합니다.

for file in &diff.files { if Budget.remaining() == 0 { warning!(file = %file.path, "파일 건너뛰기 — 총 토큰 예산이 소진되었습니다."); 건너뛰기 += 1; 계속하다; } let Effective_max = Budget.max_file_tokens.min(budget.remaining()); let (content, was_truncated) = truncate_file_content(&file.diff, Effective_max); // ... } (DiffContext { 파일 }, 생략됨) } }

잘릴 때 메타 정보가 주입됩니다. 파일 내용이 잘릴 때 모델에 원래 크기를 명시적으로 알려줍니다.

#![allow(unused)] fn main() { //examples/code-review-agent/src/context.rs:100-102 truncated.push_str(&format!( "\n[Truncated: 전체 파일에 {total_lines}줄이 있으며 첫 번째 {lines_shown}]" )); }

토큰 추정은 바이트 길이를 4로 나눈 기준(Rust의 `str::len()`가 바이트 수를 반환함)을 기반으로 하는 **보수적 추정** 전략을 사용합니다. 이는 ASCII 코드의 경우 대략 문자 수와 같으며 비ASCII 콘텐츠의 경우 훨씬 더 보수적입니다.

#![allow(unused)] fn main() { // example/code-review-agent/src/context.rs:66-69 pub fn estimate_tokens(text: &str) -> usize { (text.len() + 3) / 4 // 보수적 추정: ~4 bytes/token } }

## <a href="#304-layer-three-tools-and-search" class="header">30.4 레이어 3: 도구 및 검색</a>

**적용 패턴**: **편집 전 읽기**(27장 참조), **구조적 검색**(27장 참조)

### <a href="#patterns-in-cc-source-code-2" class="header">CC 소스 코드의 패턴</a>

Claude Code의 FileEditTool에는 엄격한 제약이 있습니다. 먼저 파일을 읽지 않은 경우 편집 시 다음과 같은 오류가 발생합니다.

``` typescript
// restored-src/src/tools/FileEditTool/prompt.ts:4-6
function getPreReadInstruction(): string {
  return `\n- You must use your \`${FILE_READ_TOOL_NAME}\` tool at least once
    in the conversation before editing. This tool will error if you
    attempt an edit without reading the file. `
}
```

이는 제안이 아니라 시행됩니다. 한편 검색 도구(Grep, Glob)는 안전한 동시 읽기 전용 작업으로 표시됩니다.

``` typescript
// restored-src/src/tools/GrepTool/GrepTool.ts:183-187
isConcurrencySafe() { return true }
isReadOnly() { return true }
```

### <a href="#rust-implementation-2" class="header">러스트 구현</a>

우리 에이전트는 [just-bash](https://github.com/vercel-labs/just-bash)에서 영감을 받은 자체 도구 시스템을 구현합니다. bash 자체는 범용 도구 인터페이스이며 LLM은 자연스럽게 이를 사용하는 방법을 알고 있습니다. 하지만 just-bash와 달리 우리 도구는 **읽기 전용 샌드박스**에서 실행됩니다.

#![allow(unused)] fn main() { // example/code-review-agent/src/tools.rs — 도구 안전 제약 조건 const ALLOWED_COMMANDS: &[&str] = &[ "cat", "head", "tail", "wc", "grep", "find", "ls", "sort", "awk", "sed", ... ];

const BLOCKED_COMMANDS: &[&str] = &[ "rm", "mv", "curl", "python", "bash", "npm", ... ]; }

LLM은 `AgentAction::UseTool`를 통해 도구를 요청하고 코드는 다음을 검증하고 실행합니다.

#![allow(unused)] fn main() { // example/code-review-agent/src/review.rs — 에이전트 결정 pub enum AgentAction { Done, ReviewRelated { file: String, Reason: String }, UseTool { tool: String, input: String, Reason: String }, } }

두 가지 도구 유형:

- **bash**: 하위 프로세스 샌드박스에서 실행되는 읽기 전용 명령(`cat file | grep pattern`)
- **스킬**: 특수 분석 프롬프트(`security-audit`, `performance-review`, `rust-idioms`, `api-review`)는 코드에 의해 로드되고 현재 LLM 백엔드를 통해 전송됩니다.

이것이 실제로 **구조적 검색** 패턴입니다. LLM은 필요성을 명시하고("이 함수의 정의를 보고 싶습니다") 코드는 이를 충족하는 방법을 결정합니다(`grep -rn 'fn validate_input' src/` 실행). 도구 실행 결과는 분석을 계속하는 LLM으로 다시 전달됩니다.

## <a href="#305-layer-four-security-and-permissions" class="header">30.5 계층 4: 보안 및 권한</a>

**적용 패턴**: **Fail Closed**(25장 참조), **점진적 자율성**(27장 참조)

### <a href="#patterns-in-cc-source-code-3" class="header">CC 소스 코드의 패턴</a>

Claude Code는 5가지 외부 권한 모드(알파벳순)를 정의합니다.

``` typescript
// restored-src/src/types/permissions.ts:16-22
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const
```

가장 제한적인 것부터 순서대로: `plan`(계획만, 실행하지 않음) \> `default`(모든 단계 확인) \> `acceptEdits`(편집 자동 수락) \> `dontAsk`(승인되지 않은 도구 거부) \> `bypassPermissions`(완전 자율성). 이것이 **점진적 자율성**입니다. 사용자는 신뢰 수준에 따라 점진적으로 권한을 완화할 수 있습니다. **Fail Closed**는 `default` 모드 설계에 반영됩니다. 허용 여부가 확실하지 않은 경우 기본 대답은 "아니요"입니다.

### <a href="#rust-implementation-3" class="header">러스트 구현</a>

검토 에이전트는 다중 계층 **Fail Closed**를 구현합니다.

<div class="table-wrapper">

| 보안 계층 | 기구 | 효과 |
|----|----|----|
| LLM 백엔드 | `LlmBackend` 특성, 순수 텍스트 인터페이스 | LLM은 어떤 작업도 직접 실행할 수 없습니다. |
| 도구 화이트리스트 | 읽기 전용 명령만 포함된 `ALLOWED_COMMANDS` | bash는 `cat`/`grep`만 가능하고 `rm`/`curl`는 불가능합니다. |
| 도구 블랙리스트 | `BLOCKED_COMMANDS`는 위험한 명령을 명시적으로 차단합니다. | 이중 보험 |
| 출력 리디렉션 | `>` 연산자 차단 | Bash를 통해 파일을 쓸 수 없습니다 |
| 통화 한도 | 파일당 최대 3개의 도구 호출 | LLM이 도구 호출 사망 루프에 들어가는 것을 방지합니다. |
| 시간 초과 | 도구 실행당 30초 제한 시간 | 명령 중단 방지 |
| 출력 잘림 | 도구 출력은 50KB로 제한됩니다. | 대용량 파일이 컨텍스트를 소비하지 않도록 방지 |

</div>

이는 실제로 **점진적 자율성**입니다. 동일한 에이전트 내에 세 가지 권한 수준이 공존합니다.

1. **1단계(검토)**: LLM은 차이점만 볼 수 있으며 도구에 액세스할 수 없습니다.
2. **Turn 2+ (Tools)**: LLM은 읽기 전용 bash 또는 기술을 요청할 수 있지만 코드는 유효성을 검사하고 실행합니다.
3. **MCP 모드**: 외부 에이전트(예: Claude Code)가 에이전트를 호출하여 중첩된 인증을 형성할 수 있습니다.

## <a href="#306-layer-five-resilience" class="header">30.6 레이어 5: 탄력성</a>

**적용 패턴**: **유한한 재시도 예산**(6b장 참조), **회로 차단 런어웨이 루프**(26장 참조), **적절한 크기의 도우미 경로**(27장 참조)

### <a href="#patterns-in-cc-source-code-4" class="header">CC 소스 코드의 패턴</a>

Claude Code의 재시도 논리에는 총 재시도 횟수와 특정 오류 재시도 한도라는 두 가지 주요 제약 조건이 있습니다.

``` typescript
// restored-src/src/services/api/withRetry.ts:52-54
const DEFAULT_MAX_RETRIES = 10
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_529_RETRIES = 3
```

회로 차단기 패턴은 자동 압축에 나타납니다. 압축이 3번 연속 실패하면 시도를 중지하세요.

``` typescript
// restored-src/src/services/compact/autoCompact.ts:67-70
// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

소스 코드 주석의 데이터는 서킷 브레이커의 필요성을 보여줍니다. 이 상수가 추가되기 전에는 1,279개의 세션이 50번의 연속 실패를 누적하여 하루에 약 250,000개의 API 호출을 낭비했습니다. 이것이 **회로 차단 런어웨이 루프**가 선택 사항이 아닌 이유입니다.

### <a href="#rust-implementation-4" class="header">러스트 구현</a>

`with_retry` 기능은 30초 제한으로 지수 백오프 재시도를 구현합니다. 이는 프로덕션 등급 재시도의 단순화된 버전입니다. CC 구현에는 동기화된 다중 클라이언트 재시도의 "천둥소리" 효과를 방지하기 위한 지터(무작위 교란)도 포함되어 있습니다.

#![allow(unused)] fn main() { // example/code-review-agent/src/resilience.rs:34-68 pub async fn with_retry<F, Fut, T>(config: &RetryConfig, mut Operation: F) -> Result<T> where F: FnMut() -> Fut, Fut: Future<Output = Result<T>>, { 시도 시 0..=config.max_retries { 일치 작업().await { Ok(값) => 반환 Ok(값), Err(e) => { 시도 시 < config.max_retries {
                        let delay_ms = (config.base_delay_ms * 2u64.saturating_pow(attempt))
                            .min(MAX_BACKOFF_MS);
                        warn!(attempt, delay_ms, error = %e, "Operation failed, retrying");
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    }
                    last_error = Some(e);
                }
            }
        }
        Err(last_error.expect("at least one attempt must have been made"))
    }
    }

PHXCODE00065PHX uses an atomic counter to track consecutive failure
count. In our per-file review loop, it integrates directly into the
Agent Loop — 3 consecutive file failures stop reviewing remaining files,
avoiding meaningless API waste:

    #![allow(unused)]
    fn main() {
    // examples/code-review-agent/src/main.rs:107-130
    let circuit_breaker = CircuitBreaker::new(3);

    for file in &constrained_diff.files {
        if !circuit_breaker.check() {
            warn!("Circuit breaker OPEN — skipping remaining files");
            break;
        }
        // ... call LLM with retry ...
        match result {
            Ok(response_text) => { Circuit_breaker.record_success(); /* ... */ } Err(e) => { Circuit_breaker.record_failure(); /* ... */ } } } }

`CircuitBreaker` 자체:

#![allow(unused)] fn main() { // example/code-review-agent/src/resilience.rs:74-118 pub struct CircuitBreaker { max_failures: u32, failures: AtomicU32, }

impl CircuitBreaker { pub fn check(&self) -> bool { self.failures.load(Ordering::Relaxed) < self.max_failures
        }
        pub fn record_failure(&self) { /* atomic increment, warn at threshold */ }
        pub fn record_success(&self) { self.failures.store(0, Ordering::Relaxed); }
    }
    }

**Right-Sized Helper Paths** is reflected in the context management
layer — when a file exceeds the per-file token budget, the Agent doesn't
abandon the review but degrades to reviewing only the truncated portion
(see Section 30.3's truncation logic). This is more practical than "all
or nothing."

## <a href="#307-layer-six-observability" class="header">30.7 레이어 6: 관찰 가능성</a>

**적용 패턴**: **수정 전 관찰**(25장 참조), **구조적 검증**(27장 참조)

### <a href="#patterns-in-cc-source-code-5" class="header">CC 소스 코드의 패턴</a>

Claude Code의 이벤트 로깅에는 고유한 유형 안전 설계가 있습니다. `logEvent` 함수의 `metadata` 매개변수는 `LogEventMetadata` 유형을 사용합니다. 이 유형은 `boolean | number | undefined`만 값으로 허용하고 유형 정의 수준에서 `string`를 제외하여 실수로 원격 측정 로그에 코드나 파일 경로를 쓰는 것을 방지합니다.

``` typescript
// restored-src/src/services/analytics/index.ts:133-144
export function logEvent(
  eventName: string,
  // intentionally no strings unless
  // AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  // to avoid accidentally logging code/filepaths
  metadata: LogEventMetadata,
): void {
  if (sink === null) {
    eventQueue.push({ eventName, metadata, async: false })
    return
  }
  sink.logEvent(eventName, metadata)
}
```

`AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`라는 마커 유형 이름은 코드 검토 중에 시각적 경고 역할을 합니다. 문자열을 명시적으로 전달해야 하는 경우 이 유형의 "선언"을 거쳐야 합니다.

### <a href="#rust-implementation-5" class="header">러스트 구현</a>

우리는 `tracing` 상자를 사용하여 주요 지점에서 구조화된 이벤트를 기록합니다. `review_started` 및 `review_completed` 이벤트는 에이전트의 전체 수명주기를 다룹니다.

#![allow(unused)] fn main() { // example/code-review-agent/src/main.rs:68-75 info!( diff = %cli.diff.display(), max_tokens = cli.max_tokens, max_file_tokens = cli.max_file_tokens, "review_started" );

// 파일별 검토 이벤트 정보!(file = %file.path, tokens = file.estimated_tokens, "파일 검토 중"); info!(file = %file.path, Finding = Finding.len(), "파일 검토 완료");

// 요약 이벤트 정보!(summary = %report.summary_line(), "review_completed"); }

`ReviewReport` 자체는 관찰 가능 구조입니다. 검토 범위(검토 및 건너뛰기), 토큰 소비, 기간 및 비용을 기록합니다.

#![allow(unused)] fn main() { // example/code-review-agent/src/review.rs:46-59 pub struct ReviewReport { pub files_reviewed: usize, pub files_skipped: usize, pub total_tokens_used: u64, pub 기간_ms: u64, pub 결과: Vec<Finding>, pub cost_usd: Option<f64>, } }

이러한 측정항목을 통해 다음과 같은 주요 질문에 답할 수 있습니다. 검토된 파일 수는 몇 개입니까? 건너뛴 횟수는 몇 개입니까? 결과당 토큰 수는 몇 개입니까? 전체 리뷰 비용은 얼마입니까? **수정하기 전에 관찰하세요**는 무엇이든 최적화하기 전에 먼저 확인할 수 있어야 함을 의미합니다.

## <a href="#308-live-demo-agent-reviewing-its-own-code"
class="header">30.8 라이브 데모: 자체 코드를 검토하는 에이전트</a>

가장 좋은 테스트는 에이전트가 자체적으로 검토하도록 하는 것입니다. 우리는 `git diff --no-index`를 사용하여 5개의 Rust 소스 파일(새 코드 1261줄)을 모두 포함하는 diff를 생성한 다음 검토를 실행합니다.

$ 화물 실행 -- --diff /tmp/new-code-review.diff

review_started diff=/tmp/new-code-review.diff max_tokens=50000 파일별 청크로 구문 분석된 diff file_count=5 예산 적용 files_to_review=5 files_skipped=0 tokens_used=10171 파일 검토 중 file=context.rs tokens=2579 파일 검토 완료 file=context.rs 결과=5 파일 검토 중 file=main.rs tokens=1651 파일 검토 완료 file=main.rs Finding=5 파일 검토 중 file=prompts.rs tokens=1722 파일 검토 완료 file=prompts.rs Finding=5 파일 검토 중 file=resilience.rs tokens=1580 파일 검토 완료 file=resilience.rs Finding=5 파일 검토 중 file=review.rs tokens=2639 파일 검토 완료 file=review.rs Finding=5 review_completed 25개의 결과(0 중요, 경고 10개, 정보 15개) 128.3초 내에 5개 파일에 걸쳐 발생

에이전트는 128초 안에 5개의 파일을 하나씩 검토하여 25개의 문제를 찾아냈습니다. 다음은 몇 가지 대표적인 결과입니다.

**Diff 구문 분석 경계 버그**(경고):

> `splitn(2, " b/")`는 파일 경로에 공백이 포함되어 있으면 잘못 분할됩니다. 예를 들어, `diff --git a/foo b/bar b/foo b/bar`는 `a/` 경로 내의 ` b/`에서 중단됩니다.

**원자 카운터 오버플로**(경고):

> `record_failure`의 `fetch_add(1, Relaxed)`에는 오버플로 보호 기능이 없습니다. 계속해서 호출되면 카운터는 `u32::MAX`에서 다시 0으로 돌아가서 실수로 회로 차단기를 닫습니다.

**JSON 구문 분석 취약성**(경고):

> `extract_json_array`의 대괄호 일치는 JSON 문자열 값 내에서 `[` 및 `]`를 처리하지 않으므로 잠재적으로 조기 일치 또는 지연 일치가 발생할 수 있습니다.

**성능 최적화 제안**(정보):

> `content.lines().count()`는 한 번 순회하여 총 줄 수를 계산한 다음 `for` 루프가 다시 순회합니다. 대용량 파일의 경우 이는 중복 이중 순회입니다.

동일한 코드를 검토하기 위해 Codex(GPT-5.4) 백엔드로 전환한 후 에이전트는 파일 간 후속 기능을 시연했습니다. `agent.rs`를 검토할 때 `llm.rs`(특성 종속성으로 인해)도 검사하기로 자동으로 결정하여 67초 안에 8개 파일에 걸쳐 39개의 결과를 생성했습니다. 동일한 에이전트 루프, LLM 백엔드를 교체하면 다양한 모델의 검토 품질을 비교할 수 있습니다.

### <a
href="#bootstrapping-agent-discovers-and-fixes-its-own-security-vulnerability"
class="header">부트스트랩핑: 에이전트가 자체 보안 취약점을 발견하고 수정합니다.</a>

가장 강력한 테스트는 에이전트가 자체 도구 시스템 코드(`tools.rs`)를 검토하도록 하는 것입니다. Codex 백엔드는 2개의 중요한 결과를 반환했습니다.

> **셸 명령 삽입**(필수): bash 도구는 `sh -c`를 통해 명령을 실행하므로 첫 번째 토큰이 화이트리스트에 있더라도 셸 메타 문자가 해석됩니다. `cat file; uname -a`, `grep foo $(id)` 또는 역따옴표 대체는 모두 `is_command_allowed`를 우회할 수 있습니다.

이는 **실제 보안 취약점**입니다. 수정 사항:

1. **`sh -c` 사용 중지** — 쉘 인터프리터를 우회하여 직접 실행하려면 `Command::new(program).args(args)`로 전환하세요.
2. **모든 셸 메타 문자 차단**: `;|&`\$(){}\`, 명령이 실행되기 전에 가로채기
3. **5개의 주입 공격 테스트 추가**: 세미콜론 체인, 파이프, 서브쉘, 백틱, `&&` 체인

<!-- -->

#![allow(unused)] fn main() { // 수정 전: sh -c는 쉘 메타문자를 해석합니다 let mut cmd = Command::new("sh"); cmd.arg("-c").arg(명령);  // ← "cat file; rm -rf /"는 두 개의 명령을 실행합니다.

// 수정 후: 직접 실행, 쉘 없음 const SHELL_METACHARACTERS: &[char] = &[';', '|', '&', '`', '$', '(', ')']; if command.contains(SHELL_METACHARACTERS) { return Blocked("셸 메타문자는 허용되지 않습니다."); } let mut cmd = 명령::new(프로그램); cmd.args(args);  // ← 인수는 쉘로 해석되지 않습니다. }

이 프로세스는 **에이전트 검토 → 취약점 발견 → 개발자 수정 → 에이전트가 수정 사항 확인**이라는 완전한 에이전트 중심 개발 주기를 보여줍니다. 더 중요한 것은 코드 검토 에이전트의 보안 계층(4계층) 자체를 검토해야 하는 이유를 보여줍니다. 어떤 시스템도 설계만으로는 보안을 보장할 수 없습니다. 지속적인 검토 주기가 방어선입니다.

### <a href="#agent-workflow-panorama" class="header">에이전트 워크플로 파노라마</a>

다음 시퀀스 다이어그램은 에이전트가 초기 검토, 도구 호출, 파일 간 후속 조치 및 최종 집계를 포함하여 종속 관계가 있는 두 파일을 검토할 때의 전체 상호 작용을 보여줍니다.

``` mermaid
sequenceDiagram
    participant U as User/CLI
    participant A as Agent Loop<br/>(agent.rs)
    participant T as Tool System<br/>(tools.rs)
    participant L as LLM Backend<br/>(llm.rs)
    participant B as Bash Sandbox

    U->>A: --diff my.diff --backend codex
    activate A
    Note over A: Load diff → budget control<br/>5 files, 10K tokens

    rect rgb(230, 245, 255)
        Note over A,L: File 1: agent.rs (Turn 1 — Review)
        A->>L: complete(system_prompt, diff_of_agent.rs)
        L-->>A: findings: [{severity: Warning, ...}, ...]
    end

    rect rgb(255, 243, 224)
        Note over A,L: File 1: agent.rs (Turn 2 — Decision)
        A->>L: complete(system_prompt, followup_prompt)
        L-->>A: {"action": "use_tool", "tool": "bash",<br/>"input": "grep -rn 'LlmBackend' src/"}
    end

    rect rgb(232, 245, 233)
        Note over A,B: File 1: agent.rs (Turn 3 — Tool Execution)
        A->>T: execute_tool("bash", "grep -rn ...")
        T->>T: Whitelist check ✓<br/>Metacharacter check ✓
        T->>B: Command::new("grep").args(["-rn", ...])
        B-->>T: src/llm.rs:50: pub trait LlmBackend ...
        T-->>A: ToolResult { success: true, output: ... }
    end

    rect rgb(255, 243, 224)
        Note over A,L: File 1: agent.rs (Turn 4 — Continue Decision)
        A->>L: complete(prompt + tool_results)
        L-->>A: {"action": "review_related",<br/>"file": "llm.rs", "reason": "trait dependency"}
    end

    rect rgb(243, 229, 245)
        Note over A,L: File 1: agent.rs (Turn 5 — Cross-File Review)
        A->>L: complete(system_prompt, diff_of_llm.rs)
        L-->>A: cross_file_findings: [...]
    end

    Note over A: File 1 complete: merge findings

    rect rgb(230, 245, 255)
        Note over A,L: File 2: tools.rs (Turn 1 — Review)
        A->>L: complete(system_prompt, diff_of_tools.rs)
        L-->>A: [{severity: Critical,<br/>message: "sh -c shell injection"}]
    end

    rect rgb(255, 243, 224)
        Note over A,L: File 2: tools.rs (Turn 2 — Decision)
        A->>L: complete(followup_prompt)
        L-->>A: {"action": "use_tool", "tool": "skill",<br/>"input": "security-audit"}
    end

    rect rgb(252, 228, 236)
        Note over A,L: File 2: tools.rs (Turn 3 — Skill Analysis)
        A->>A: find_skill("security-audit")<br/>Load specialized prompt
        A->>L: complete(security_audit_prompt,<br/>diff_of_tools.rs)
        L-->>A: deep_security_findings: [...]
    end

    Note over A: File 2 complete: merge findings

    A->>A: Aggregate all findings<br/>Build ReviewReport
    A-->>U: JSON/Markdown report
    deactivate A
```

> **대화형 버전**: [애니메이션 시각화를 보려면 클릭하세요](agent-viz.html) — 단계별로 진행하고, 일시 중지하고, 속도를 조정하고, 자세한 설명을 보려면 각 단계를 클릭하세요.

이 다이어그램은 런타임 시 협력하는 6개 레이어를 명확하게 보여줍니다.

- **L1 프롬프트**: `system_prompt` 및 `followup_prompt`는 각 LLM 호출 동작을 제어합니다.
- **L2 컨텍스트**: 예산 제어에 따라 로드할 파일과 잘릴 파일이 결정됩니다.
- **L3 도구**: 에이전트가 bash(코드 찾기) 또는 스킬(심층 분석) 호출을 자동으로 결정합니다.
- **L4 보안**: 도구 시스템은 실행 전에 화이트리스트와 메타 문자의 유효성을 검사합니다.
- **L5 탄력성**: 각 LLM 호출에는 재시도 + 회로 차단기 보호 기능이 있습니다(다이어그램에서는 생략됨).
- **L6 관찰 가능성**: 각 색상 블록에는 해당 추적 이벤트가 있습니다.

이러한 조사 결과는 함께 작동하는 6개 계층 아키텍처를 검증합니다. 프롬프트 계층의 구성은 검토 원칙과 출력 형식을 정의하고, 컨텍스트 계층의 예산 제어는 모든 파일이 예산에 맞는지 확인하고, 에이전트 루프 주기는 도구 시스템을 통한 심층 분석을 통해, 탄력성 계층의 재시도 및 회로 차단기는 전체 주기를 보호하고, 관찰 가능성 계층의 추적 이벤트를 통해 각 파일의 검토 진행 상황, 도구 호출 및 발견 횟수를 확인할 수 있습니다.

## <a href="#309-closing-the-loop-let-claude-code-use-your-agent"
class="header">30.9 루프 닫기: Claude Code가 에이전트를 사용하도록 허용</a>

에이전트 구축의 궁극적인 검증은 다른 에이전트가 해당 에이전트를 사용하도록 하는 것입니다. 우리의 코드 검토 에이전트는 MCP(Model Context Protocol, 스킬 시스템의 22장 참조)를 통해 Claude Code 도구로 노출될 수 있습니다.

`--serve` 인수를 추가하면 에이전트가 CLI에서 MCP 서버 모드로 전환되어 stdio를 통해 Claude Code와 통신합니다.

#![allow(unused)] fn main() { // example/code-review-agent/src/mcp.rs (핵심 정의) #[tool(description = "버그, 보안 문제 및 코드 품질에 대한 통합 diff 파일을 검토합니다.")] async fn review_diff(&self, 매개변수(req): 매개변수<ReviewDiffRequest>) -> String { // 전체 에이전트 루프 재사용: diff 로드 → 예산 제어 → 파일별 LLM → 집계 일치 self.do_review(req).await { Ok(report) => serde_json::to_string_pretty(&report).unwrap_or_default(), Err(e) => format!("{{\"error\": \"{e}\"}}"), } } }

Claude Code의 `settings.json`에 등록하세요.

``` json
{
  "mcpServers": {
    "code-review": {
      "command": "cargo",
      "args": ["run", "--manifest-path", "/path/to/Cargo.toml", "--", "--serve"]
    }
  }
}
```

그 후 Claude Code는 자연스럽게 `review_diff` 도구를 호출할 수 있습니다. 대화 중에 "이 차이점을 검토해 주세요"라고 말하면 CC는 에이전트에 전화를 걸어 구조화된 결과를 얻은 다음 하나씩 수정합니다. 이는 완전한 루프를 형성합니다.

``` mermaid
flowchart LR
    U["Developer"] -->|"Review this"| CC["Claude Code"]
    CC -->|"MCP: review_diff"| RA["Your Review Agent"]
    RA -->|"LLM Proxy"| LLM["Claude (subscription)"]
    LLM --> RA
    RA -->|"25 findings JSON"| CC
    CC -->|"Fix one by one"| U
```

CC 소스 코드에서 패턴을 학습하고 해당 패턴을 사용하여 자신만의 에이전트를 구축한 다음 CC에서 이를 사용하도록 하는 것이 하네스 엔지니어링의 실질적인 중요성입니다.

## <a href="#3010-complete-architecture-review" class="header">30.10 전체 아키텍처 검토</a>

6개 계층을 함께 쌓아서 완전한 에이전트 아키텍처를 형성합니다.

``` mermaid
graph TB
    subgraph L6["Layer Six: Observability"]
        O1["tracing events"]
        O2["ReviewReport metrics"]
    end

    subgraph L5["Layer Five: Resilience"]
        R1["with_retry exponential backoff"]
        R2["CircuitBreaker"]
        R3["Truncation degradation"]
    end

    subgraph L4["Layer Four: Security"]
        S1["bash whitelist + blacklist"]
        S2["Tool call cap (3/file)"]
        S3["Output truncation + timeout"]
    end

    subgraph L3["Layer Three: Tools"]
        T1["bash (read-only sandbox)"]
        T2["skill (specialized analysis prompts)"]
        T3["AgentAction decision dispatch"]
    end

    subgraph L2["Layer Two: Context"]
        C1["ContextBudget dual-layer budget"]
        C2["truncate + meta-information"]
    end

    subgraph L1["Layer One: Prompts"]
        P1["Constitution static layer"]
        P2["Runtime dynamic layer"]
    end

    L6 --> L5 --> L4 --> L3 --> L2 --> L1

    style L1 fill:#e3f2fd
    style L2 fill:#e8f5e9
    style L3 fill:#fff3e0
    style L4 fill:#fce4ec
    style L5 fill:#f3e5f5
    style L6 fill:#e0f2f1
```

다음 표에는 각 레이어의 해당 CC 패턴과 책 장이 요약되어 있습니다.

<div class="table-wrapper">

| 층 | 핵심 패턴 | 원천 | CC 키 소스 파일 |
|----|----|----|----|
| L1 프롬프트 | 제어 평면, 대역 외 제어 채널, 도구 수준 프롬프트, 범위 일치 응답 등의 프롬프트 | ch25, ch27 | `systemPromptSections.ts` |
| L2 컨텍스트 | 모든 것에 예산을 책정하고, 상황을 위생적으로 파악하고, 숨기지 말고 알리고, 보수적으로 추정하세요. | ch26 | `toolLimits.ts`, `toolResultStorage.ts` |
| L3 도구 | 편집 전 읽기, 구조화된 검색 | ch27 | `FileEditTool/prompt.ts`, `GrepTool.ts` |
| L4 보안 | 실패 시 종료, 자율화 | ch25, ch27 | `types/permissions.ts` |
| L5 탄력성 | 유한한 재시도 예산, 회로 차단 런어웨이 루프, 적절한 크기의 도우미 경로 | ch6b, ch26, ch27 | `withRetry.ts`, `autoCompact.ts` |
| L6 관찰 가능성 | 고치기 전 관찰, 구조화된 검증 | ch25, ch27 | `analytics/index.ts` |

</div>

22개의 명명된 패턴 중 이 장에서는 **16개(73%)**를 다룹니다. 다루지 않은 6가지(캐시 인식 디자인, 모든 A/B 테스트, 중요한 내용 보존, 방어 Git, 이중 감시, 캐시 중단 감지)는 의미가 있으려면 더 큰 시스템 규모가 필요하거나(A/B 테스트) 특정 하위 시스템(캐시 중단 감지, 방어 Git)에 밀접하게 묶여 있어야 합니다.

## <a href="#pattern-distillation" class="header">패턴 증류</a>

### <a href="#pattern-six-layer-agent-construction-stack"
class="header">패턴: 6계층 에이전트 구성 스택</a>

- **문제 해결**: 에이전트 구성에는 체계적인 방법론이 부족합니다. 개발자는 주변 엔지니어링을 무시하고 "모델 호출"에만 집중하는 경우가 많습니다.
- **핵심 접근 방식**: 프롬프트 → 컨텍스트 → 도구 → 보안 → 탄력성 → 관찰 가능성의 계층으로, 각 계층에는 명확한 책임 경계가 있습니다.
- **전제 조건**: 이 책의 첫 29장, 특히 25~27장의 원리 ​​증류에 대한 단일 레이어 패턴을 이해합니다.
- **CC 매핑**: 각 레이어는 Claude Code 하위 시스템(`systemPrompt`, `compaction`, `toolSystem`, `permissions`, `retry`, `telemetry`)에 직접적으로 해당합니다.

### <a href="#pattern-pattern-composition-over-pattern-stacking"
class="header">패턴: 패턴 스태킹을 통한 패턴 합성</a>

- **문제 해결**: 22개 패턴은 모두 개별적으로 가치가 있지만 조합하여 사용하면 충돌할 수 있습니다.
- **핵심 접근 방식**: 패턴 간 관계 식별(보완 또는 긴장)
  - **보완적**: 컨텍스트 위생 + 정보를 숨기지 않음(콘텐츠는 잘라내지만 메타정보는 보존, 30.3 참조)
  - **보완적**: 실패 시 폐쇄 + 단계적 자율성(기본적으로 잠김 + 요청 시 업그레이드, 30.5 참조)
  - **긴장**: 모든 것에 예산을 할당하는 것과 캐시 인식 설계를 비교합니다(잘림으로 인해 캐시 중단점이 깨질 수 있음).
  - **긴장**: 편집 전 읽기 대 토큰 예산(전체 파일을 읽는 것이 예산을 초과할 수 있음)
- **긴장 해결**: 잘림 동작에 메타정보 주입을 추가하여 잘리는 경우에도 예산 시스템이 모델의 인식을 유지할 수 있도록 합니다.

## <a href="#what-you-can-do" class="header">당신이 할 수 있는 일</a>

6가지 권장 사항(레이어당 하나씩):

1. **프롬프트 레이어**: 시스템 프롬프트를 정적 "구성" 부분과 동적 "런타임" 부분으로 나눕니다. 구성은 버전 제어에 들어가고 호출마다 런타임 부분이 생성됩니다. 이는 단순한 코드 구성이 아닙니다. 나중에 프롬프트 캐싱을 통합하면 정적 부분을 직접 재사용할 수 있습니다.

2. **컨텍스트 레이어**: 에이전트에 대한 모든 입력 채널에 대해 명시적인 토큰 예산을 설정하고 잘라낼 때 메타 정보를 삽입합니다(섹션 30.3의 구현 참조). 모델에게 모든 것을 볼 수 없다는 사실을 알려주는 것이 조용히 잘라내는 것보다 훨씬 낫습니다.

3. **도구 레이어**: just-bash의 통찰력을 통해 알아보세요. bash는 LLM이 자연스럽게 사용법을 알고 있는 범용 도구 인터페이스입니다. 하지만 항상 샌드박싱을 추가하세요. 허용되는 명령을 화이트리스트에 추가하고, 출력 리디렉션을 차단하고, 호출 횟수를 제한하세요. LLM 요청 도구(`AgentAction::UseTool`)를 사용하면 코드가 검증되고 실행됩니다. 또한 스킬에는 외부 시스템 종속성이 필요하지 않습니다. 스킬은 에이전트 자체에서 관리하고 로드하는 특수 분석 프롬프트 템플릿일 뿐입니다.

4. **보안 레이어**: 다중 레이어 페일클로즈는 단일 레이어보다 더 안정적입니다. 우리 에이전트에는 7개의 보안 제약 계층(화이트리스트 + 블랙리스트 + 리디렉션 차단 + 통화 제한 + 시간 초과 + 출력 잘림 + LLM이 도구를 직접 실행하지 않음)이 있습니다. 한 레이어가 우회되더라도 다른 레이어는 계속 유효합니다.

5. **복원력 레이어**: 재시도에 한도를 설정하고 연속 실패 시 회로 차단기를 설정합니다. 무제한 재시도는 회복력이 아니라 낭비입니다. CC 소스 코드 주석(섹션 30.6 참조)은 중단되지 않은 재시도 루프로 인해 엄청난 리소스 낭비가 발생함을 보여줍니다.

6. **관찰 가능성 레이어**: 비즈니스 로직의 첫 번째 줄을 작성하기 전에 추적을 통합하세요. `review_started` 및 `review_completed` 이벤트는 "에이전트가 무엇을 하고 있는지", "얼마나 잘하고 있는지"에 답하기에 충분합니다. 모든 후속 최적화는 관찰 데이터를 기반으로 합니다. 데이터가 없는 최적화는 추측입니다.
