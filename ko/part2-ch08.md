# <a href="#chapter-8-tool-prompts-as-micro-harnesses"
class="header">8장: 마이크로 하네스로서의 도구 프롬프트</a>

> 5장에서는 시스템 프롬프트의 매크로 아키텍처(섹션 등록, 캐시 계층화, 동적 어셈블리)를 분석했습니다. 그러나 시스템 프롬프트는 "최상위 전략"일 뿐입니다. 각 공구 호출의 미시적 수준에서는 병렬 하네스 시스템이 작동합니다. **공구 프롬프트(공구 설명/공구 프롬프트)**. API 요청의 `tools` 배열에 `description` 필드로 삽입되어 모델이 각 도구를 사용하는 방식을 직접 형성합니다. 이 장에서는 Claude Code의 6가지 핵심 도구의 프롬프트 디자인을 하나씩 분석하여 조종 전략과 그 안에 재사용 가능한 패턴을 공개합니다.

## <a href="#81-the-harness-nature-of-tool-prompts" class="header">8.1 도구 프롬프트의 하네스 특성</a>

Anthropic API에 있는 도구의 `description` 필드는 "이 도구가 수행하는 작업을 모델에 알려주는 것"으로 배치됩니다. 그러나 Claude Code는 이 필드를 단순한 기능 설명에서 완전한 **행동 제약 프로토콜**로 확장합니다. 각 도구의 프롬프트는 다음을 포함하는 사실상 마이크로 하네스입니다.

- **기능 설명**: 도구의 기능
- **긍정적 지침**: 사용 방법
- **부정적인 금지 사항**: 사용하면 안 되는 방법
- **조건부 분기**: 특정 시나리오에서 수행할 작업
- **형식 템플릿**: 출력의 모양

이 설계의 핵심 통찰력은 **각 도구를 사용한 모델의 동작 품질은 해당 도구의 즉각적인 품질에 의해 직접적으로 제한됩니다**입니다. 시스템 프롬프트는 전역 페르소나를 설정합니다. 도구는 로컬 동작을 형성하라는 메시지를 표시합니다. 이들은 함께 Claude Code의 "이중 레이어 하니스 아키텍처"를 형성합니다.

기능적 복잡성을 줄이는 순서대로 6가지 도구를 분석해 보겠습니다.

------------------------------------------------------------------------

## <a href="#82-bashtool-the-most-complex-micro-harness" class="header">8.2 BashTool: 가장 복잡한 마이크로 하네스</a>

BashTool은 Claude Code에서 가장 긴 프롬프트와 가장 밀집된 제약 조건을 가진 도구입니다. 프롬프트는 `getSimplePrompt()` 함수에 의해 동적으로 생성되며 잠재적으로 수천 단어에 도달할 수 있습니다.

**소스 위치:** `tools/BashTool/prompt.ts:275-369`

### <a
href="#821-tool-preference-matrix-routing-traffic-to-specialized-tools"
class="header">8.2.1 도구 기본 설정 매트릭스: 특수 도구로 트래픽 라우팅</a>

프롬프트의 첫 번째 부분에서는 명시적인 **도구 기본 설정 매트릭스**를 설정합니다.

중요: 명시적으로 지시하지 않거나 전용 도구가 작업을 수행할 수 없다는 것을 확인한 후에는 이 도구를 사용하여 find, grep, cat, head, tail, sed, awk 또는 echo 명령을 실행하지 마십시오.

바로 뒤에 매핑 테이블이 옵니다(281-291행).

``` typescript
const toolPreferenceItems = [
  `File search: Use ${GLOB_TOOL_NAME} (NOT find or ls)`,
  `Content search: Use ${GREP_TOOL_NAME} (NOT grep or rg)`,
  `Read files: Use ${FILE_READ_TOOL_NAME} (NOT cat/head/tail)`,
  `Edit files: Use ${FILE_EDIT_TOOL_NAME} (NOT sed/awk)`,
  `Write files: Use ${FILE_WRITE_TOOL_NAME} (NOT echo >/cat <<EOF)`,
  'Communication: Output text directly (NOT echo/printf)',
]
```

이 디자인은 중요한 하네스 패턴인 **교통 조향**을 구현합니다. Bash는 이론적으로 모든 파일 읽기/쓰기, 검색 및 편집 작업을 수행할 수 있는 "범용 도구"입니다. 그러나 모델이 Bash를 통해 이러한 작업을 수행하게 하면 두 가지 문제가 발생합니다.

1. **나쁜 사용자 경험**: 전문 도구(예: FileEditTool)에는 구조화된 입력, 시각적 차이, 권한 확인 및 기타 기능이 있습니다. Bash 명령은 불투명한 문자열입니다.
2. **권한 제어 우회**: 전문 도구에는 세분화된 권한 확인 기능이 있습니다. Bash 명령은 이러한 검사를 우회합니다.

276-278행의 조건 분기에 유의하십시오. 시스템이 내장된 검색 도구(`hasEmbeddedSearchTools()`)를 감지하면 `find` 및 `grep`가 금지 목록에서 제거됩니다. 이는 독립형 Glob/Grep 도구를 제거하면서 `find`/`grep`를 임베디드 `bfs`/`ugrep`에 별칭으로 지정하는 Anthropic의 내부 빌드(ant-native 빌드)에 적용됩니다.

**재사용 가능한 패턴 - "범용 도구 수준 내리기":** 도구 세트에 기능 범위가 매우 넓은 도구가 포함되어 있는 경우 프롬프트에 "어떤 시나리오에서 어떤 대체 도구를 사용해야 하는지"를 명시적으로 나열하여 모델이 단일 도구에 과도하게 의존하는 것을 방지합니다.

### <a href="#822-command-execution-guidelines-from-timeouts-to-concurrency"
class="header">8.2.2 명령 실행 지침: 시간 초과에서 동시성까지</a>

프롬프트의 두 번째 부분은 다음을 포함하는 자세한 명령 실행 사양(331-352행)입니다.

- **디렉터리 확인**: "명령으로 새 디렉터리나 파일이 생성되는 경우 먼저 이 도구를 사용하여 `ls`를 실행하여 상위 디렉터리가 있는지 확인하세요."
- **경로 인용**: "공백이 포함된 파일 경로는 항상 큰따옴표로 인용하세요."
- **작업 디렉터리 지속성**: "절대 경로를 사용하여 세션 전체에서 현재 작업 디렉터리를 유지해 보세요."
- **시간 초과 제어**: 기본 120,000ms(2분), 최대 600,000ms(10분)
- **백그라운드 실행**: `run_in_background` 매개변수(명시적인 사용 조건 포함)

가장 정교한 것은 **다중 명령 동시성 가이드**(297-303행)입니다.

``` typescript
const multipleCommandsSubitems = [
  `If the commands are independent and can run in parallel, make multiple
   ${BASH_TOOL_NAME} tool calls in a single message.`,
  `If the commands depend on each other and must run sequentially, use
   a single ${BASH_TOOL_NAME} call with '&&' to chain them together.`,
  "Use ';' only when you need to run commands sequentially but don't
   care if earlier commands fail.",
  'DO NOT use newlines to separate commands.',
]
```

이것은 단순한 "모범 사례 조언"이 아니라 **동시성 결정 트리**입니다. 독립 작업은 병렬 도구 호출을 사용합니다. -\> 종속성은 `&&`를 사용합니다. -\> 실패 허용 `;`를 사용합니다. -\> 줄바꿈을 금지합니다. 각 규칙은 특정 실패 모드에 해당합니다.

### <a href="#823-git-safety-protocol-defense-in-depth" class="header">8.2.3 Git 안전 프로토콜: 심층 방어</a>

Git 작업은 BashTool 프롬프트에서 가장 중요한 보안 도메인입니다. 전체 Git 안전 프로토콜은 `getCommitAndPRInstructions()` 함수(42-161행)에 정의되어 있으며 핵심 금지 목록(88-95행)은 **6계층 방어**를 구성합니다.

Git 안전 프로토콜: - 절대로 git config를 업데이트하지 마세요. - 사용자가 명시적으로 이러한 작업을 요청하지 않는 한 파괴적인 git 명령(push --force, Reset --hard, checkout ., Restore ., clean -f, Branch -D)을 실행하지 마세요. - 사용자가 명시적으로 요청하지 않는 한 절대 후크를 건너뛰지 마세요(--no-verify, --no-gpg-sign 등) - 메인/마스터로 강제 푸시를 실행하지 마세요. 사용자가 요청하면 경고합니다. - 중요: 항상 새로운 커밋을 생성하세요. 수정보다는 - 파일을 준비할 때 "git add -A" 또는 "git add"를 사용하는 대신 이름으로 특정 파일을 추가하는 것이 좋습니다. - 사용자가 명시적으로 요청하지 않는 한 변경 사항을 커밋하지 마세요.

각 금지 사항은 실제 데이터 손실 시나리오에 해당합니다.

<div class="table-wrapper">

| 금지 | 실패 시나리오 방어 |
|----|----|
| Git 구성을 절대 업데이트하지 마세요 | 모델은 사용자의 전역 Git 구성을 수정할 수 있습니다. |
| 절대 밀지 마세요 --force | 원격 저장소 커밋 기록 덮어쓰기 |
| 절대 후크를 건너뛰지 마세요 | 우회코드 품질검사, 서명검증 |
| 절대 메인으로 강제 푸시하지 마세요 | 팀 공유 브랜치 삭제 |
| 항상 새로운 커밋을 생성하세요 | 사전 커밋 후크 실패 후 수정은 이전 커밋을 수정합니다. |
| 특정 파일을 선호하세요 | `git add .`는 .env, 자격 증명을 노출할 수 있습니다. |
| 요청하지 않는 한 절대 커밋하지 마세요 | 에이전트의 과도한 자율성 방지 |

</div>

"CRITICAL" 마커는 가장 미묘한 시나리오인 사전 커밋 후크 실패 후 `--amend` 트랩을 위해 예약되어 있습니다. 이 규칙을 사용하려면 Git의 내부 메커니즘을 이해해야 합니다. 후크 실패는 커밋이 발생하지 않았음을 의미하며, 해당 시점에서 `--amend`는 "현재 커밋을 다시 시도"하는 것이 아니라 **이전 기존 커밋**을 수정합니다.

프롬프트에는 전체 커밋 워크플로 템플릿(96-125행)도 포함되어 있으며, 번호가 매겨진 단계를 사용하여 병렬로 실행할 수 있는 작업과 순차적이어야 하는 작업을 명시적으로 지정하고 HEREDOC 형식의 커밋 메시지 템플릿도 제공합니다. 이는 **워크플로 스캐폴딩** 패턴입니다. 즉, 모델에게 "무엇을 해야 할지" 알려주는 것이 아니라 "어떤 순서로 수행할지" 알려 주는 것입니다.

### <a href="#824-sandbox-configuration-as-inline-json" class="header">8.2.4 인라인 JSON으로 샌드박스 구성</a>

샌드박스가 활성화되면 `getSimpleSandboxSection()` 함수(172-273행)가 전체 샌드박스 구성을 JSON으로 프롬프트에 인라인합니다.

``` typescript
const filesystemConfig = {
  read: {
    denyOnly: dedup(fsReadConfig.denyOnly),
    allowWithinDeny: dedup(fsReadConfig.allowWithinDeny),
  },
  write: {
    allowOnly: normalizeAllowOnly(fsWriteConfig.allowOnly),
    denyWithinAllow: dedup(fsWriteConfig.denyWithinAllow),
  },
}
```

**출처 참조:** `tools/BashTool/prompt.ts:195-203`

**기계가 읽을 수 있는 보안 정책을 모델에 직접 노출**하는 것은 깊이 생각해 볼 가치가 있는 설계 결정입니다. 모델은 액세스할 수 있는 경로와 연결할 수 있는 네트워크 호스트를 "이해"해야 명령을 생성할 때 위반을 사전에 방지할 수 있습니다. JSON 형식은 정확성과 명확성을 보장합니다.

167-170행의 `dedup` 함수와 188-191행의 `normalizeAllowOnly`에 유의하세요. 전자는 중복 경로를 제거하고(`SandboxManager`는 다중 계층 구성을 병합할 때 중복을 제거하지 않기 때문에), 후자는 사용자별 임시 디렉토리 경로를 `$TMPDIR` ​​자리 표시자로 바꿉니다. 이 두 가지 최적화는 각각 ~150-200개의 토큰을 절약하고 사용자 간 프롬프트 캐시 일관성을 보장합니다.

**재사용 가능한 패턴 - "정책 투명성":** 보안 정책을 시행하기 위해 모델 협력이 필요한 경우 구조화된 형식(JSON/YAML)으로 설정된 전체 규칙을 프롬프트에 인라인하여 모델이 생성 중에 준수 여부를 자체 검사할 수 있도록 합니다.

### <a href="#825-sleep-anti-pattern-suppression" class="header">8.2.5 수면 방지 패턴 억제</a>

프롬프트에서는 `sleep` 남용을 억제하기 위한 섹션(310-327행)을 지정합니다.

``` typescript
const sleepSubitems = [
  'Do not sleep between commands that can run immediately — just run them.',
  'If your command is long running... use `run_in_background`.',
  'Do not retry failing commands in a sleep loop — diagnose the root cause.',
  'If waiting for a background task... do not poll.',
  'If you must sleep, keep the duration short (1-5 seconds)...',
]
```

이는 전형적인 **안티패턴 억제** 전략입니다. LLM은 코드 생성 시나리오에서 비동기 대기를 처리하기 위해 `sleep` + 폴링을 사용하는 경향이 있습니다. 이는 훈련 데이터에서 가장 일반적인 패턴이기 때문입니다. 프롬프트는 대안(백그라운드 실행, 이벤트 알림, 근본 원인 진단)을 하나씩 열거하여 이 기본 동작을 "덮어씁니다".

------------------------------------------------------------------------

## <a href="#83-fileedittool-the-must-read-before-edit-enforcement"
class="header">8.3 FileEditTool: "편집 전에 읽어야 함" 시행</a>

FileEditTool의 프롬프트는 BashTool의 프롬프트보다 훨씬 간결하지만 모든 문장에는 중요한 엔지니어링 제약이 따릅니다.

**소스 위치:** `tools/FileEditTool/prompt.ts:1-28`

### <a href="#831-pre-read-enforcement" class="header">8.3.1 사전 읽기 시행</a>

프롬프트의 첫 번째 규칙(4-6행):

``` typescript
function getPreReadInstruction(): string {
  return `You must use your \`${FILE_READ_TOOL_NAME}\` tool at least once
  in the conversation before editing. This tool will error if you
  attempt an edit without reading the file.`
}
```

이는 "제안"이 아니라 **엄격한 제약**입니다. 도구의 런타임 구현은 파일에 대한 읽기 호출에 대한 대화 기록을 확인하고, 존재하지 않는 경우 오류를 반환합니다. 프롬프트의 설명을 통해 모델은 이 제약 조건에 대해 **미리 알 수** 있어 도구 호출 낭비를 피할 수 있습니다.

이 디자인은 **모델 환각**이라는 핵심 문제를 해결합니다. 모델이 파일을 먼저 읽지 않고 파일을 편집하려고 시도하면 파일 내용에 대한 가정이 완전히 잘못될 수 있습니다. 사전 읽기를 강제하면 모델의 "메모리" 또는 "추측"이 아닌 실제 파일 상태를 기반으로 편집 작업이 수행됩니다.

**재사용 가능한 패턴 - "전제 조건 적용":** 도구 B의 정확성이 도구 A가 먼저 호출되는지에 따라 달라지는 경우 B의 프롬프트에서 이 종속성을 선언하고 B의 런타임에서 이를 적용합니다. 이중 보험 - 프롬프트 계층은 낭비되는 호출을 방지하고, 런타임 계층은 잘못된 작업을 방지합니다.

### <a href="#832-minimal-unique-old_string" class="header">8.3.2 최소 고유 old_string</a>

`old_string` 매개변수(20-27행)에 대한 프롬프트 요구 사항은 섬세한 균형을 구현합니다.

    - `old_string`가 파일에서 고유하지 않으면 편집이 실패합니다. 고유하게 만들기 위해 더 많은 주변 컨텍스트와 함께 더 큰 문자열을 제공하거나 `replace_all`를 사용하여 `old_string`의 모든 인스턴스를 변경하십시오.

Anthropic 내부 사용자(`USER_TYPE === 'ant'`)의 경우 추가 최적화 힌트가 있습니다(17-19행).

``` typescript
const minimalUniquenessHint =
  process.env.USER_TYPE === 'ant'
    ? `Use the smallest old_string that's clearly unique — usually 2-4
       adjacent lines is sufficient. Avoid including 10+ lines of context
       when less uniquely identifies the target.`
    : ''
```

이는 **토큰 경제학** 문제를 드러냅니다. FileEditTool을 사용할 때 모델은 `old_string` 매개변수에서 대체할 원본 텍스트를 제공해야 합니다. 모델이 "고유성을 보장"하기 위해 습관적으로 큰 컨텍스트 블록을 포함하는 경우 각 편집 작업의 토큰 소비가 급증합니다. "2-4줄" 지침은 모델이 고유성과 간결함 사이의 최적 지점을 찾는 데 도움이 됩니다.

### <a href="#833-indentation-preservation-and-line-number-prefix"
class="header">8.3.3 들여쓰기 보존 및 줄 번호 접두사</a>

프롬프트에서 가장 쉽게 간과되지만 가장 중요한 기술적 세부 사항(13-16행, 23행):

``` typescript
const prefixFormat = isCompactLinePrefixEnabled()
  ? 'line number + tab'
  : 'spaces + line number + arrow'

// In the description:
`When editing text from Read tool output, ensure you preserve the exact
indentation (tabs/spaces) as it appears AFTER the line number prefix.
The line number prefix format is: ${prefixFormat}. Everything after that
is the actual file content to match. Never include any part of the line
number prefix in the old_string or new_string.`
```

읽기 도구 출력에는 줄 번호 접두사(예: ` 42 →`)가 함께 제공되며 모델은 편집 중에 **이 접두사를 제거**하여 실제 파일 콘텐츠만 `old_string`로 추출해야 합니다. 이는 읽기 도구와 편집 도구 간의 **인터페이스 계약**입니다. 프롬프트는 "인터페이스 문서" 역할을 합니다.

**재사용 가능한 패턴 - "도구 간 인터페이스 선언":** 두 도구의 출력/입력에 형식 변환 관계가 있는 경우 다운스트림 도구의 프롬프트에서 업스트림 도구의 출력 형식을 명시적으로 설명하여 모델에 의한 형식 변환 오류를 방지합니다.

------------------------------------------------------------------------

## <a href="#84-filereadtool-resource-aware-reading-strategy"
class="header">8.4 FileReadTool: 자원 인식 읽기 전략</a>

FileReadTool의 프롬프트는 단순해 보이지만 신중하게 설계된 리소스 관리 전략이 포함되어 있습니다.

**소스 위치:** `tools/FileReadTool/prompt.ts:1-49`

### <a href="#841-the-2000-line-default-limit" class="header">8.4.1 2000라인 기본 제한</a>

``` typescript
export const MAX_LINES_TO_READ = 2000

// In the prompt template:
`By default, it reads up to ${MAX_LINES_TO_READ} lines starting from
the beginning of the file`
```

**소스 참조:** `tools/FileReadTool/prompt.ts:10,37`

2000줄은 신중하게 균형 잡힌 숫자입니다. Anthropic의 모델에는 200K 토큰 컨텍스트 창이 있지만 컨텍스트가 클수록 주의가 분산되고 추론 비용이 높아집니다. 2000줄은 대략 8000~16000개의 토큰(코드 밀도에 따라 다름)에 해당하며 컨텍스트 창의 4~8%를 차지합니다. 이 예산은 다중 파일 작업을 위한 공간을 남겨두면서 대부분의 단일 파일 시나리오를 처리하기에 충분합니다.

### <a href="#842-progressive-guidance-for-offsetlimit" class="header">8.4.2 오프셋/한계에 대한 점진적 지침</a>

프롬프트는 오프셋/한계 매개변수에 대한 두 가지 표현 모드를 제공합니다(17-21행):

``` typescript
export const OFFSET_INSTRUCTION_DEFAULT =
  "You can optionally specify a line offset and limit (especially handy
   for long files), but it's recommended to read the whole file by not
   providing these parameters"

export const OFFSET_INSTRUCTION_TARGETED =
  'When you already know which part of the file you need, only read
   that part. This can be important for larger files.'
```

두 가지 모드는 서로 다른 사용 단계를 제공합니다.

- **DEFAULT 모드**는 전체 읽기를 권장합니다. 모델이 처음 파일을 접하고 전반적인 이해가 필요한 경우에 적합합니다.
- **TARGETED 모드**는 정확한 판독을 장려합니다. 모델이 이미 대상 위치를 알고 있는 경우에 적합하여 토큰 예산을 절약합니다.

사용되는 모드는 런타임 컨텍스트(`FileReadTool` 호출자가 결정)에 따라 다르지만 프롬프트는 두 가지 "안내 신호음"을 미리 정의하여 모델이 다양한 시나리오에서 다양한 읽기 동작을 나타낼 수 있도록 합니다.

### <a href="#843-multimedia-capability-declarations" class="header">8.4.3 멀티미디어 기능 선언</a>

프롬프트는 일련의 선언문을 사용하여 읽기 도구의 기능 경계를 확장합니다(40-48행).

    - 이 도구를 사용하면 Claude Code가 이미지(예: PNG, JPG 등)를 읽을 수 있습니다. 이미지 파일을 읽을 때 Claude Code는 다중 모드 LLM이므로 내용이 시각적으로 표시됩니다.
    - 이 도구는 PDF 파일(.pdf)을 읽을 수 있습니다. 큰 PDF(10페이지 이상)의 경우 특정 페이지 범위를 읽으려면 페이지 매개변수를 제공해야 합니다. 요청당 최대 20페이지.
    - 이 도구는 Jupyter 노트북(.ipynb 파일)을 읽고 출력과 함께 모든 셀을 반환할 수 있습니다.

PDF 페이지 매기기 제한("10페이지 이상...페이지 매개변수를 제공해야 함")은 **점진적 리소스 제한**입니다. 작은 파일은 직접 읽을 수 있고, 큰 파일에는 필수 페이지 매김이 필요합니다. 이는 "모든 파일에 페이지를 매겨야 합니다"와 "페이지 매김 제한 없음"보다 더 합리적입니다. 전자는 불필요한 도구 호출 라운드를 추가하고 후자는 한 번에 너무 많은 콘텐츠를 주입할 수 있습니다.

PDF 지원은 조건부입니다(41행). `isPDFSupported()`는 런타임 환경이 PDF 구문 분석을 지원하는지 여부를 확인합니다. 지원되지 않으면 전체 PDF 설명 섹션이 프롬프트에서 사라집니다. 이렇게 하면 "프롬프트가 런타임이 제공할 수 없는 기능을 약속한다"는 일반적인 함정을 피할 수 있습니다.

**재사용 가능한 패턴 - "런타임에 맞춰진 기능 선언":** 도구 프롬프트 기능 설명은 런타임 기능에 따라 동적으로 결정되어야 합니다. 특정 환경에서 기능을 사용할 수 없는 경우 프롬프트에서 해당 기능을 언급하지 마세요. 이렇게 하면 모델이 존재하지 않는 기능을 반복적으로 시도하게 되어 혼란과 낭비가 발생할 수 있습니다.

------------------------------------------------------------------------

## <a href="#85-greptool-always-use-grep-never-bash-grep"
class="header">8.5 GrepTool: "항상 Grep을 사용하고, grep을 강타하지 마세요."</a>

GrepTool의 프롬프트는 극도로 정제되었지만 모든 라인은 엄격한 제약입니다.

**소스 위치:** `tools/GrepTool/prompt.ts:1-18`

### <a href="#851-exclusivity-declaration" class="header">8.5.1 독점 선언</a>

프롬프트의 첫 번째 사용 규칙(10행):

검색 작업에는 항상 Grep을 사용하세요. `grep` 또는 `rg`를 Bash 명령으로 호출하지 마십시오. Grep 도구는 올바른 권한 및 액세스를 위해 최적화되었습니다.

이것은 BashTool의 도구 기본 설정 매트릭스와 **양방향 조정**으로 작동하는 디자인입니다. BashTool은 "검색에 bash를 사용하지 마십시오"라고 말하고 GrepTool은 "검색에는 나를 사용해야 합니다"라고 말합니다. 양방향의 제약 조건은 닫힌 루프를 형성하여 모델이 "잘못된 경로를 택"할 확률을 최대한 줄입니다.

"올바른 권한 및 액세스를 위해 최적화되었습니다"는 단순히 금지를 발행하는 것이 아니라 이유를 제공합니다. 중요한 이유는 GrepTool의 기본 호출이 동일한 `ripgrep`이지만 권한 확인(`checkReadPermissionForTool`, `GrepTool.ts:233-239`), 패턴 적용 무시(`getFileReadIgnorePatterns`, `GrepTool.ts:413-427`) 및 버전 제어 디렉터리 제외(`VCS_DIRECTORIES_TO_EXCLUDE`, `GrepTool.ts:95-102`)를 래핑합니다. Bash를 통해 `rg`를 직접 호출하면 이러한 안전 계층을 우회합니다.

### <a href="#852-ripgrep-syntax-hints" class="header">8.5.2 ripgrep 구문 힌트</a>

프롬프트는 세 가지 중요한 구문 차이점 참고 사항(11-16행)을 제공합니다.

    - 전체 정규식 구문 지원(예: "log.*Error", "function\s+\w+")
    - 패턴 구문: ripgrep 사용(grep 아님) - 리터럴 중괄호는 이스케이프해야 합니다(Go 코드에서 `interface{}`를 찾으려면 `interface\{\}`를 사용하세요).
    - 여러 줄 일치: 기본적으로 패턴은 한 줄 내에서만 일치합니다. `struct \{[\s\S]*?field`와 같은 교차선 패턴의 경우 `multiline: true`를 사용하세요.

첫 번째는 구문 계열(ripgrep의 Rust regex)을 명확히 하고, 두 번째는 가장 일반적인 함정(중괄호는 이스케이프해야 함 - GNU grep과 다름)을 제공하며, 세 번째는 여러 줄 매개변수의 사용 사례를 설명합니다.

코드 구현을 살펴보면 `multiline: true`는 ripgrep 매개변수 `-U --multiline-dotall`(`GrepTool.ts:341-343`)에 해당합니다. 프롬프트에서는 기본 매개변수 세부 정보를 노출하는 대신 "사용 사례 + 예"로 이 기능을 설명하도록 선택합니다. 모델은 `multiline: true`를 설정할 때만 `-U`가 무엇인지 알 필요가 없습니다.

### <a href="#853-output-modes-and-head_limit" class="header">8.5.3 출력 모드와 head_limit</a>

GrepTool의 입력 스키마(`GrepTool.ts:33-89`)는 다양한 매개변수를 정의하지만 프롬프트에서는 세 가지 출력 모드만 간략하게 언급합니다.

출력 모드: "content"는 일치하는 줄을 표시하고, "files_with_matches"는 파일 경로만 표시하고(기본값), "count"는 일치 개수를 표시합니다.

`head_limit` 매개변수 설계(`GrepTool.ts:81,107`)는 특별한 주의를 기울일 가치가 있습니다.

``` typescript
const DEFAULT_HEAD_LIMIT = 250

// In schema description:
'Defaults to 250 when unspecified. Pass 0 for unlimited
(use sparingly — large result sets waste context).'
```

기본 결과 250개 제한은 **컨텍스트 보호 메커니즘**입니다. 주석에서는 무제한 콘텐츠 모드 검색이 20KB 도구 결과 지속성 임계값을 채울 수 있다고 설명합니다(104-108행). "아껴서 사용하세요"라는 문구는 모델에 부드러운 경고를 제공하는 반면 "무제한" 탈출구인 `0`는 유연성을 유지합니다.

**재사용 가능한 패턴 -- "안전한 기본값 + 탈출 해치":** 큰 출력을 생성할 수 있는 도구의 경우 제한을 해제하는 명시적인 방법을 제공하면서 보수적인 기본 제한을 설정합니다. 프롬프트에서 해당 존재와 적용 가능한 시나리오를 모두 설명합니다.

------------------------------------------------------------------------

## <a href="#86-agenttool-dynamic-agent-list-and-fork-guidance"
class="header">8.6 AgentTool: 동적 에이전트 목록 및 포크 지침</a>

AgentTool은 런타임 상태(사용 가능한 에이전트 정의, 포크 활성화 여부, 코디네이터 모드, 구독 유형)를 기반으로 콘텐츠를 동적으로 구성해야 하기 때문에 6가지 도구 중에서 가장 복잡한 프롬프트 생성 논리를 가지고 있습니다.

**소스 위치:** `tools/AgentTool/prompt.ts:1-287`

### <a
href="#861-inline-vs-attachment-two-injection-methods-for-agent-lists"
class="header">8.6.1 인라인 vs. 첨부: 에이전트 목록에 대한 두 가지 삽입 방법</a>

프롬프트의 에이전트 목록은 두 가지 방법(58~64행, 196~199행)을 통해 삽입할 수 있습니다.

``` typescript
export function shouldInjectAgentListInMessages(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES))
    return false
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_agent_list_attach', false)
}
```

**방법 1(인라인):** 에이전트 목록이 도구 설명에 직접 포함됩니다.

``` typescript
`Available agent types and the tools they have access to:
${effectiveAgents.map(agent => formatAgentLine(agent)).join('\n')}`
```

**방법 2(첨부 파일):** 도구 설명에는 "사용 가능한 에이전트 유형이 대화의 `<system-reminder>` 메시지에 나열되어 있습니다."라는 정적 텍스트만 포함되어 있으며 실제 목록은 `agent_listing_delta` 첨부 메시지를 통해 별도로 삽입됩니다.

소스 코드 주석(50-57행)은 동기를 설명합니다. **동적 에이전트 목록은 글로벌 `cache_creation` 토큰의 약 10.2%를 차지합니다**. MCP 서버가 비동기식으로 연결되거나 플러그인이 다시 로드되거나 권한 모드가 변경될 때마다 에이전트 목록이 변경되어 목록이 포함된 도구 스키마가 완전히 무효화되어 비용이 많이 드는 캐시 재구축이 발생합니다. 목록을 첨부 메시지로 이동하면 도구 설명이 정적 텍스트가 되어 도구 스키마 계층의 프롬프트 캐시가 보호됩니다.

각 에이전트의 설명 형식(43~46행):

``` typescript
export function formatAgentLine(agent: AgentDefinition): string {
  const toolsDescription = getToolsDescription(agent)
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`
}
```

`getToolsDescription` 함수(15-37행)는 도구 화이트리스트와 블랙리스트의 교차 필터링을 처리하여 궁극적으로 "Bash, Agent를 제외한 모든 도구" 또는 "Read, Grep, Glob"와 같은 설명을 생성합니다. 이를 통해 모델은 각 상담원 유형이 **사용할 수 있는** 도구를 알 수 있어 합리적인 위임 결정이 가능해집니다.

**재사용 가능한 패턴 - "동적 콘텐츠 외부화":** 도구 프롬프트에서 자주 변경되는 부분이 캐시에 큰 영향을 미치는 경우 도구 `description`에서 메시지 스트림(예: 첨부 파일, 시스템 알림)으로 이동하여 도구 설명을 안정적으로 유지하세요.

### <a
href="#862-fork-sub-agent-lightweight-delegation-with-context-inheritance"
class="header">8.6.2 Fork 하위 에이전트: 컨텍스트 상속을 통한 경량 위임</a>

`isForkSubagentEnabled()`가 true이면 프롬프트에 "포크 시점" 섹션(81-96행)이 추가되어 모델이 두 가지 위임 모드 중에서 선택하도록 안내합니다.

1. **포크(`subagent_type` 생략)**: 연구 및 구현 작업에 적합한 상위 에이전트의 전체 대화 컨텍스트를 상속합니다.
2. **신규 에이전트(`subagent_type` 지정)**: 처음부터 시작하며 전체 컨텍스트 전달이 필요합니다.

포크 사용 가이드에는 세 가지 핵심 원칙이 포함되어 있습니다.

엿보지 마십시오. 도구 결과에는 output_file 경로가 포함됩니다. 사용자가 명시적으로 진행률 확인을 요청하지 않는 한 읽거나 마무리하지 마십시오.

경주하지 마십시오. 발사 후에는 포크가 무엇을 발견했는지에 대해 아무것도 알 수 없습니다. 어떠한 형식으로든 포크 결과를 조작하거나 예측하지 마십시오.

포크 프롬프트 작성. 포크는 컨텍스트를 상속하므로 프롬프트는 상황이 아니라 무엇을 해야 하는지에 대한 지시어입니다.

"Don't peek"는 상위 에이전트가 포크의 중간 출력을 읽는 것을 방지합니다. 이로 인해 포크의 도구 소음이 상위 에이전트의 컨텍스트로 유입되어 포크 목적이 무산됩니다. "경합하지 않음"은 결과가 반환되기 전에 상위 에이전트가 포크의 결론을 "추측"하는 것을 방지합니다. 이는 알려진 LLM 경향입니다.

### <a href="#863-prompt-writing-guide-preventing-shallow-delegation"
class="header">8.6.3 프롬프트 작성 가이드: 얕은 위임 방지</a>

프롬프트의 가장 독특한 부분은 "좋은 상담원 프롬프트 작성 방법" 섹션입니다(99-113행).

방금 방에 들어온 똑똑한 동료처럼 에이전트에게 브리핑합니다. 에이전트는 이 대화를 본 적도 없고, 사용자가 무엇을 시도했는지도 모르고, 이 작업이 왜 중요한지 이해하지 못합니다.

...

**절대로 이해를 위임하지 마세요.** "발견에 따라 버그를 수정하세요." 또는 "연구에 따라 구현하세요."라고 쓰지 마세요. 이러한 문구는 합성을 직접 수행하는 대신 에이전트에 푸시합니다.

"이해를 위임하지 마십시오"는 심오한 메타인지 제약입니다. 이는 모델이 **종합과 판단이 필요한 사고 작업**을 하위 에이전트에 넘겨주는 것을 방지합니다. 하위 에이전트는 의사결정자가 아니라 실행자가 되어야 합니다. 이 규칙은 상위 에이전트에 "이해"를 고정시켜 위임 체인에서 지식이 손실되지 않도록 합니다.

**재사용 가능한 패턴 - "위임 품질 보증":** 도구가 하위 시스템에 작업을 전달하는 것과 관련된 경우 프롬프트에서 작업 설명의 완전성과 구체성을 제한하여 모델이 모호하고 불완전한 위임 지침을 생성하지 않도록 합니다.

------------------------------------------------------------------------

## <a href="#87-skilltool-budget-constraints-and-three-level-truncation"
class="header">8.7 SkillTool: 예산 제약 및 3단계 절단</a>

SkillTool의 독특한 특징은 모델의 **행동**을 활용할 뿐만 아니라 자체 프롬프트의 **볼륨**도 관리한다는 것입니다.

**소스 위치:** `tools/SkillTool/prompt.ts:1-242`

### <a href="#871-the-1-context-window-budget" class="header">8.7.1 1% 컨텍스트 창 예산</a>

``` typescript
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000 // Fallback: 1% of 200k * 4
```

**출처 참조:** `tools/SkillTool/prompt.ts:21-23`

스킬 목록의 총 캐릭터 예산은 컨텍스트 창의 1%로 엄격하게 제한됩니다. 200K 토큰 컨텍스트 창의 경우 이는 200K \* 4자/토큰 \* 1% = 8000자입니다. 이러한 예산 제약은 기술 검색 기능이 모델의 작업 컨텍스트를 침범하지 않도록 보장합니다. 기술 목록은 "콘텐츠"가 아닌 "디렉터리"입니다. 모델은 스킬 호출 여부를 결정하는 데 충분한 정보만 확인하면 됩니다. 실제 스킬 콘텐츠는 호출 시 로드됩니다.

### <a href="#872-three-level-truncation-strategy" class="header">8.7.2 3단계 절단 전략</a>

`formatCommandsWithinBudget` 함수(70-171행)는 점진적 잘림 전략을 구현합니다.

**레벨 1: 전체 보존.** 모든 기술의 전체 설명이 예산 범위에 맞는 경우 모든 것을 유지합니다.

``` typescript
if (fullTotal <= budget) {
  return fullEntries.map(e => e.full).join('\n')
}
```

**레벨 2: 설명 자르기.** 예산이 초과되면 번들로 포함되지 않은 기술 설명을 사용 가능한 평균 길이로 자릅니다. 번들 스킬은 항상 전체 설명을 유지합니다.

``` typescript
const maxDescLen = Math.floor(availableForDescs / restCommands.length)
// ...
return `- ${cmd.name}: ${truncate(description, maxDescLen)}`
```

**레벨 3: 이름만.** 트림 후 평균 설명 길이가 20자 미만(`MIN_DESC_LENGTH`)인 경우 번들되지 않은 스킬은 이름만 표시하도록 저하됩니다.

``` typescript
if (maxDescLen < MIN_DESC_LENGTH) {
  return commands
    .map((cmd, i) =>
      bundledIndices.has(i) ? fullEntries[i]!.full : `- ${cmd.name}`,
    )
    .join('\n')
}
```

이 3단계 전략의 우선순위는 **번들되지 않은 기술 \>번들되지 않은 기술 설명 \>번들되지 않은 스킬 이름**입니다. Claude Code의 핵심 기능인 번들 스킬은 절대로 잘리지 않습니다. 타사 플러그인 기술은 필요에 따라 저하되므로 기술 생태계 규모에 관계없이 토큰 비용이 제어됩니다.

### <a href="#873-single-entry-hard-cap" class="header">8.7.3 단일 항목 하드 캡</a>

총 예산 외에도 각 기술 항목에는 독립적인 하드 캡(29행)이 있습니다.

``` typescript
export const MAX_LISTING_DESC_CHARS = 250
```

`getCommandDescription` 함수(43-49행)는 총 예산이 자르기 전에 각 항목을 250자로 미리 자릅니다.

``` typescript
function getCommandDescription(cmd: Command): string {
  const desc = cmd.whenToUse
    ? `${cmd.description} - ${cmd.whenToUse}`
    : cmd.description
  return desc.length > MAX_LISTING_DESC_CHARS
    ? desc.slice(0, MAX_LISTING_DESC_CHARS - 1) + '\u2026'
    : desc
}
```

댓글은 그 근거를 설명합니다. 스킬 목록은 **사용** 목적이 아닌 **발견** 목적으로 사용됩니다. Verbose `whenToUse` 문자열은 스킬 매칭 비율을 향상시키지 않고 턴 1 `cache_creation` 토큰을 낭비합니다.

### <a href="#874-invocation-protocol" class="header">8.7.4 호출 프로토콜</a>

SkillTool의 핵심 프롬프트(173-196행)는 상대적으로 짧지만 중요한 **차단 요구 사항**이 포함되어 있습니다.

기술이 사용자의 요청과 일치하는 경우 이는 차단 요구 사항입니다. 작업에 대한 다른 응답을 생성하기 전에 관련 기술 도구를 호출합니다.

"BLOCKING REQUIREMENT"는 Claude Code의 프롬프트 시스템에서 가장 강력한 제약 문구 중 하나입니다. 일치하는 기술을 식별하면 먼저 텍스트 응답을 생성하지 않고 모델이 **즉시 기술 도구를 호출**해야 합니다. 이렇게 하면 모델이 먼저 분석 텍스트를 출력한 다음 기술을 호출하는 일반적인 안티 패턴을 방지할 수 있습니다. 이 텍스트는 종종 기술 다음에 로드된 실제 지침과 충돌합니다.

또 다른 방어 규칙(194행):

``` typescript
`If you see a <${COMMAND_NAME_TAG}> tag in the current conversation turn,
the skill has ALREADY been loaded - follow the instructions directly
instead of calling this tool again`
```

이렇게 하면 **중복 로드**가 방지됩니다. `<command-name>` 태그를 통해 스킬이 이미 현재 턴에 주입된 경우 모델은 SkillTool을 다시 호출해서는 안 되며 스킬 지침을 직접 실행해야 합니다.

**재사용 가능한 패턴 - "예산 인식 디렉터리 생성":** 도구가 동적으로 증가하는 목록(플러그인, 기술, API 엔드포인트 등)을 모델에 제공해야 하는 경우 목록에 고정 토큰 예산을 할당하고 다단계 성능 저하 전략을 구현합니다. 가치가 높은 항목의 완전성을 보존하는 데 우선순위를 둡니다. 우선순위가 낮은 항목은 점차적으로 저하됩니다.

------------------------------------------------------------------------

## <a href="#88-six-tool-comparative-summary" class="header">8.8 6개 도구 비교 요약</a>

다음 표에서는 5개 차원에 걸쳐 6개 도구의 프롬프트 디자인을 비교합니다.

<div class="table-wrapper">

| 차원 | Bash도구 | 파일편집도구 | 파일읽기도구 | GrepTool | AgentTool | SkillTool |
|----|----|----|----|----|----|----|
| **프롬프트 길이** | 매우 길다(수천 단어, Git 프로토콜 포함) | 짧음(~30줄) | 중간(~50줄) | 매우 짧음(~18줄) | 긴 내용(예제 포함 최대 280줄) | 중간(~200줄, 잘림 논리 포함) |
| **생성 방법** | 동적 어셈블리(샌드박스 구성, Git 지시문, 내장 도구 감지) | 반동적(줄 접두어 형식, 사용자 유형 조건) | 반동적(PDF 지원 조건, 오프셋 모드 전환) | 정적 템플릿 | 매우 동적임(에이전트 목록, 포크 토글, 코디네이터 모드, 구독 유형) | 동적 예산 자르기(3단계 자르기) |
| **핵심 조향 전략** | 트래픽 라우팅 + 안전 프로토콜 + 워크플로우 스캐폴딩 | 전제조건 시행 + 인터페이스 계약 | 리소스 인식 점진적 한도 | 독점 선언 + 구문 수정 | 위임 품질 보증 + 캐시 보호 | 예산 제약 + 우선순위 저하 |
| **안전 메커니즘** | Git 6계층 방어, 샌드박스 JSON 인라인, 안티패턴 억제 | 편집하기 전에 읽어야 함(런타임 시행) | 줄 제한, PDF 페이지 매김 제한 | 권한 확인, VCS 디렉터리 제외, 결과 제한 | 포크 규율(엿보기/경주하지 않음), 위임 품질 | BLOCKING 요구사항, 중복 로딩 방지 |
| **재사용 가능한 패턴** | 범용 도구 강등, 정책 투명성 | 전제조건 시행, 도구간 인터페이스 선언 | 런타임에 맞춰진 기능 선언 | 안전 기본값 + 탈출 해치 | 동적 콘텐츠 외부화, 위임 품질 보증 | 예산을 고려한 디렉토리 생성 |

</div>

``` mermaid
block-beta
    columns 2
    block:behavior["Behavioral Constraint"]:1
        BT1["BashTool ← Safety Protocol"]
        ET1["EditTool ← Preconditions"]
        GT1["GrepTool ← Exclusivity"]
    end
    block:resource["Resource Management"]:1
        SK1["SkillTool ← Budget Truncation"]
        RT1["ReadTool ← Line/Page Limits"]
        GT2["GrepTool ← head_limit"]
    end
    block:collab["Collaboration Orchestration"]:1
        AT1["AgentTool ← Delegation Guide"]
        BT2["BashTool ← Concurrency Tree"]
        ET2["EditTool ← Interface Contract"]
    end
    block:cache["Cache Optimization"]:1
        AT2["AgentTool ← List Externalization"]
        BT3["BashTool ← $TMPDIR Normalization"]
        SK2["SkillTool ← Description Trimming"]
    end
```

**그림 8-1: 도구 프롬프트 조정 패턴의 4사분면 분포.** 각 도구는 일반적으로 여러 사분면에 걸쳐 있습니다. -- BashTool은 동작 제약, 협업 조정 및 캐시 최적화 특성을 동시에 나타냅니다. GrepTool은 동작 제약과 리소스 관리를 결합합니다.

## <a href="#89-seven-principles-for-designing-tool-prompts"
class="header">8.9 도구 프롬프트 디자인을 위한 7가지 원칙</a>

6가지 도구 분석을 통해 일반적인 도구 프롬프트 디자인 원칙을 정리할 수 있습니다.

1. **양방향 폐쇄 루프**: 도구 A가 특정 유형의 작업을 처리해서는 안 되는 경우 A에서는 "X를 수행하지 말고 B를 사용하세요"라고 말하고 B에서는 "X를 수행하면 나를 사용해야 합니다"라고 동시에 말합니다. 단방향 제약 조건에는 허점이 남습니다.

2. **금지 전 이유**: 모든 "절대 금지" 뒤에 "왜냐하면"이 붙습니다. 모델이 이유를 이해하면 제약 조건을 위반할 가능성이 줄어듭니다. GrepTool의 "올바른 권한을 위해 최적화되었습니다"는 "절대로 bash grep을 사용하지 마세요"보다 더 효과적입니다.

3. **런타임에 맞춰진 기능**: 프롬프트에 선언된 기능은 런타임에서 보장되어야 합니다. FileReadTool의 PDF 지원은 무조건 선언되는 것이 아니라 `isPDFSupported()`를 기반으로 조건부로 주입됩니다.

4. **안전한 기본값 + 탈출구**: 큰 출력이나 부작용을 생성할 수 있는 모든 매개변수에 대해 보수적인 기본값을 설정하는 동시에 이를 해제할 수 있는 명시적인 방법을 제공합니다. GrepTool의 `head_limit=250`/`0`는 교과서 케이스입니다.

5. **예산 인식**: 도구 프롬프트 자체가 토큰을 소비합니다. SkillTool의 1% 예산 제약과 3단계 절단은 극단적이지만 정확합니다. BashTool의 `$TMPDIR` 정규화 및 `dedup`는 보다 미묘한 최적화입니다.

6. **전제 조건 선언**: 올바른 도구 사용법이 특정 전제 조건(먼저 파일 읽기, 먼저 디렉터리 확인)에 따라 달라지는 경우 프롬프트에서 이를 선언하고 런타임에 적용합니다. 이중 보험이 단일 계층 방어를 능가합니다.

7. **위임 품질 표준**: 도구가 하위 시스템에 작업을 전달하는 것과 관련된 경우 작업 설명의 완전성과 구체성을 제한합니다. AgentTool의 "대리자 이해 없음"은 위임 체인에서 지식이 손실되는 것을 방지합니다.

------------------------------------------------------------------------

## <a href="#810-what-users-can-do" class="header">8.10 사용자가 할 수 있는 일</a>

6가지 도구 프롬프트에 대한 이 장의 분석을 바탕으로 독자가 자신의 도구 프롬프트를 디자인할 때 직접 적용할 수 있는 권장 사항은 다음과 같습니다.

1. **"범용 도구"에 대한 트래픽 라우팅 테이블을 구축하세요.** 도구 세트에 기능 범위가 매우 넓은 도구(예: 일반 API 호출자 Bash)가 포함되어 있는 경우 설명 맨 앞에 "시나리오 -\> 전문 도구" 매핑 테이블을 배치하세요. 각 전문 도구의 독점성을 동시에 선언합니다. 이 양방향 폐쇄 루프는 모델이 단일 도구에 과도하게 의존하는 것을 방지하는 가장 효과적인 수단입니다.

2. **도구 간에 전제 조건을 적용합니다.** 도구 A의 정확성이 도구 A가 먼저 호출되는지에 따라 달라지는 경우(예: "편집 전에 읽어야 함") B의 프롬프트에서 이 종속성을 선언하고 B의 런타임에 코드를 사용하여 이를 적용합니다. 프롬프트 레이어는 낭비되는 호출을 방지하고 런타임 레이어는 잘못된 작업을 방지합니다. 이중 레이어 방어가 단일 레이어보다 뛰어납니다.

3. **JSON으로 보안 정책을 프롬프트에 인라인합니다.** 모델이 권한 경계(액세스 가능한 경로, 연결 가능한 호스트 등)를 "이해"해야 하는 경우 구조화된 형식으로 설정된 전체 정책 규칙을 프롬프트에 삽입합니다. 이를 통해 모델은 런타임 거부 후 재시도에 의존하는 대신 생성 중에 규정 준수를 자체 검사할 수 있습니다.

4. **고출력 도구에 대해 보수적인 기본값을 설정합니다.** 큰 출력을 생성할 수 있는 모든 도구 매개변수(검색 결과 수, 파일 줄 수, PDF 페이지 수)에 대해 보수적인 기본 제한을 설정합니다. 동시에 명시적인 "리프트 제한" 옵션(예: `head_limit=0`)을 제공하고 프롬프트에 "아껴서 사용"이라고 기록하세요.

5. **도구 설명 자체의 토큰 비용을 제어합니다.** SkillTool의 1% 컨텍스트 창 예산 및 3단계 절단 전략을 참조하세요. 도구 세트가 늘어남에 따라 도구 설명의 총 토큰 오버헤드도 늘어납니다. 도구 설명에 고정 예산을 할당하고, 핵심 도구 완전성을 유지하는 데 우선순위를 두고, 가장자리 도구를 점진적으로 저하시킵니다.

6. **동적 조건을 사용하여 기능 선언을 제어합니다.** 런타임이 항상 제공하지 않을 수 있는 기능을 프롬프트에서 선언하지 마세요. FileReadTool의 `isPDFSupported()` 조건 확인을 참조하세요. PDF 구문 분석을 사용할 수 없는 경우 프롬프트에서 PDF 지원을 언급하지 마세요. 런타임이 제공할 수 없는 것을 약속하는 프롬프트는 모델이 반복적으로 시도하고 실패하게 하여 컨텍스트 창을 낭비하게 합니다.

## <a href="#811-summary" class="header">8.11 요약</a>

도구 프롬프트는 Claude Code의 하니스 시스템에서 가장 "기본적인" 레이어입니다. 시스템 프롬프트는 페르소나를 설정합니다. 도구 프롬프트가 작업을 형성합니다. 6가지 도구의 프롬프트 디자인은 핵심 원칙을 드러냅니다. **훌륭한 도구 프롬프트는 기능적 문서가 아니라 행동 계약입니다**. 그들은 모델에게 "이 도구가 무엇을 할 수 있는지"뿐만 아니라 "이 도구를 사용하는 조건", "안전하게 사용하는 방법", "다른 도구를 언제 사용해야 하는지"도 알려줍니다.

다음 장에서는 개별 도구의 미시적 수준 활용에서 도구 협업의 거시적 수준 조정으로 올라가서 권한 시스템, 상태 전달 및 동시성 제어를 통해 도구가 전체적으로 어떻게 조정되는지 살펴봅니다.
