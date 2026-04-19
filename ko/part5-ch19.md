# <a href="#chapter-19-claudemd--user-instructions-as-an-override-layer"
class="header">19장: CLAUDE.md — 재정의 레이어로서의 사용자 지침</a>

[중국어 원문 보기](../../part5/ch19.html)

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

Hooks 시스템(18장)이 사용자가 **코드 실행**을 통해 에이전트 동작을 확장하는 채널이라면 CLAUDE.md는 **자연어 지침**을 통해 모델 출력을 제어하는 ​​채널입니다. 이는 단순한 "구성 파일"이 아닙니다. 4단계 우선순위 계단식, 전이적 파일 포함, 경로 범위 규칙, HTML 주석 제거 및 명시적 재정의 의미 체계 선언을 갖춘 완전한 명령 주입 시스템입니다.

CLAUDE.md의 디자인 철학은 한 문장으로 요약될 수 있습니다. **사용자 지침은 모델의 기본 동작을 재정의합니다.** 이것은 수사가 아니며 문자 그대로 시스템 프롬프트에 주입됩니다.

``` typescript
// claudemd.ts:89-91
const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. ' +
  'IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'
```

이 장에서는 파일 검색, 콘텐츠 처리, 프롬프트에 대한 최종 삽입까지 전체 체인을 분석하고 이 시스템의 소스 코드 구현을 검토합니다.

------------------------------------------------------------------------

## <a href="#191-four-level-loading-priority" class="header">19.1 4단계 로딩 우선순위</a>

CLAUDE.md 시스템은 `claudemd.ts` 파일 상단(1-26행)의 주석에 명시적으로 정의된 4단계 우선순위 모델을 사용합니다. 파일은 **우선순위 역순**으로 로드됩니다. 대화가 끝날 때 모델의 콘텐츠에 대한 "주의"가 더 높기 때문에 마지막으로 로드된 파일의 우선순위가 가장 높습니다.

``` mermaid
flowchart TB
    subgraph L1 ["Level 1: Managed Memory (Lowest priority, loaded first)"]
        M1["/etc/claude-code/CLAUDE.md<br/>Enterprise policy push, applies to all users"]
    end

    subgraph L2 ["Level 2: User Memory"]
        M2["~/.claude/CLAUDE.md<br/>~/.claude/rules/*.md<br/>User's private global instructions, applies to all projects"]
    end

    subgraph L3 ["Level 3: Project Memory"]
        M3["CLAUDE.md, .claude/CLAUDE.md<br/>.claude/rules/*.md<br/>Traversed from project root to CWD<br/>Committed to git, team-shared"]
    end

    subgraph L4 ["Level 4: Local Memory (Highest priority, loaded last)"]
        M4["CLAUDE.local.md<br/>Gitignored, local only"]
    end

    L1 -->|"Overridden by"| L2 -->|"Overridden by"| L3 -->|"Overridden by"| L4

    style L4 fill:#e6f3e6,stroke:#2d862d
    style L1 fill:#f3e6e6,stroke:#862d2d
```

### <a href="#loading-implementation" class="header">구현 로드 중</a>

`getMemoryFiles` 함수(라인 790-1075)는 완전한 로딩 로직을 구현합니다. `memoize`로 래핑된 비동기 함수입니다. 동일한 프로세스 수명 내에서 첫 번째 호출 후 결과가 캐시됩니다.

**1단계: 관리되는 메모리(라인 803-823)**

``` typescript
// claudemd.ts:804-822
const managedClaudeMd = getMemoryPath('Managed')
result.push(
  ...(await processMemoryFile(managedClaudeMd, 'Managed', processedPaths, includeExternal)),
)
const managedClaudeRulesDir = getManagedClaudeRulesDir()
result.push(
  ...(await processMdRules({
    rulesDir: managedClaudeRulesDir,
    type: 'Managed',
    processedPaths,
    includeExternal,
    conditionalRule: false,
  })),
)
```

관리되는 메모리 경로는 일반적으로 기업 IT 부서가 MDM(모바일 장치 관리)을 통해 정책을 푸시하는 표준 위치인 `/etc/claude-code/CLAUDE.md`입니다.

**2단계: 사용자 메모리(라인 826-847)**

`userSettings` 구성 소스가 활성화된 경우에만 로드됩니다. 사용자 메모리에는 권한이 있습니다. `includeExternal`는 항상 `true`(라인 833)입니다. 즉, 사용자 수준 CLAUDE.md의 `@include` 지시어는 프로젝트 디렉터리 외부의 파일을 참조할 수 있습니다.

**3단계: 프로젝트 메모리(849-920행)**

이것은 가장 복잡한 단계입니다. 코드는 CWD에서 파일 시스템 루트까지 이동하면서 모든 수준에서 `CLAUDE.md`, `.claude/CLAUDE.md` 및 `.claude/rules/*.md`를 수집합니다.

``` typescript
// claudemd.ts:851-857
const dirs: string[] = []
const originalCwd = getOriginalCwd()
let currentDir = originalCwd
while (currentDir !== parse(currentDir).root) {
  dirs.push(currentDir)
  currentDir = dirname(currentDir)
}
```

그런 다음 루트 방향에서 CWD(라인 878의 `dirs.reverse()`) 방향으로 처리하여 CWD에 더 가까운 파일이 나중에 로드되고 우선 순위가 높아지도록 합니다.

흥미로운 엣지 케이스 처리: git worktrees(라인 859-884). 작업 트리 내에서 실행하는 경우(예: `.claude/worktrees/<name>/`) 상향 순회는 작업 트리 루트 디렉터리와 기본 저장소 루트 디렉터리를 모두 통과합니다. 둘 다 `CLAUDE.md`를 포함하고 있어 중복 로딩이 발생합니다. 코드는 `isNestedWorktree`를 감지하여 기본 저장소 디렉터리의 프로젝트 유형 파일을 건너뜁니다. 하지만 `CLAUDE.local.md`는 gitignored이고 기본 저장소에만 존재하기 때문에 여전히 로드됩니다.

**4단계: 로컬 메모리(프로젝트 순회 내에 분산됨)**

각 디렉토리 수준에서 `CLAUDE.local.md`는 프로젝트 파일(922-933행) 다음에 로드되지만 `localSettings` 구성 소스가 활성화된 경우에만 해당됩니다.

**추가 디렉토리(`--add-dir`) 지원(라인 936-977):**

`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` 환경 변수를 통해 활성화되면 `--add-dir` 인수로 지정된 디렉터리의 CLAUDE.md 파일도 로드됩니다. 이러한 파일은 표준 프로젝트 메모리(CLAUDE.md, .claude/CLAUDE.md, .claude/rules/\*.md)와 동일한 로딩 논리를 사용하여 `Project` 유형으로 표시됩니다. 특히 `isSettingSourceEnabled('projectSettings')`는 여기에서 선택되지 않습니다. 왜냐하면 `--add-dir`는 명시적인 사용자 작업이고 SDK의 기본 빈 `settingSources`가 이를 차단해서는 안 되기 때문입니다.

**AutoMem 및 TeamMem(라인 979-1007):**

4가지 표준 메모리 수준 이후에는 자동 메모리(`MEMORY.md`)와 팀 메모리라는 두 가지 특수 유형도 로드됩니다. 이러한 유형에는 고유한 기능 플래그 제어 및 독립적인 자르기 전략(줄 수 및 바이트 수 제한에 대해 `truncateEntrypointContent`에서 처리)이 있습니다.

### <a href="#controllable-configuration-source-switches"
class="header">제어 가능한 구성 소스 스위치</a>

각 수준(관리 제외)은 `isSettingSourceEnabled()`에 의해 제어됩니다.

- `userSettings`: 사용자 메모리 제어
- `projectSettings`: 프로젝트 메모리 제어(CLAUDE.md 및 규칙)
- `localSettings`: 로컬 메모리 제어

SDK 모드에서 `settingSources`는 기본적으로 빈 배열로 설정됩니다. 즉, 명시적으로 활성화하지 않는 한 관리형 메모리만 적용됩니다. 이는 SDK 소비자에 대한 최소 권한 원칙을 구현합니다.

------------------------------------------------------------------------

## <a href="#192-include-directive" class="header">19.2 @include 지시어</a>

CLAUDE.md는 다른 파일을 참조하기 위한 `@include` 구문을 지원하여 모듈식 지침 구성을 가능하게 합니다.

### <a href="#syntax-format" class="header">구문 형식</a>

`@include`는 간결한 `@`-prefix-plus-path 구문을 사용합니다(19-24행의 주석):

<div class="table-wrapper">

| 통사론 | 의미 |
|----|----|
| `@path` 또는 `@./path` | 현재 파일의 디렉토리를 기준으로 |
| `@~/path` | 사용자의 홈 디렉토리를 기준으로 |
| `@/absolute/path` | 절대 경로 |
| `@path#section` | 조각 식별자 사용(`#` 이후는 무시됨) |
| `@path\ with\ spaces` | 백슬래시로 이스케이프 처리된 공백 |

</div>

### <a href="#path-extraction" class="header">경로 추출</a>

경로 추출은 `extractIncludePathsFromTokens` 함수(451-535행)에 의해 구현됩니다. 원시 텍스트가 아닌 표시된 어휘 분석기에 의해 사전 처리된 토큰 스트림을 수신합니다. — 다음 규칙을 보장합니다.

1. **코드 블록의 `@`는 무시됩니다**: `code` 및 `codespan` 유형 토큰을 건너뜁니다(496-498행).
2. **HTML 주석의 `@`는 무시됩니다**: `html` 유형 토큰의 주석 부분은 건너뛰지만 주석 후 잔여 텍스트의 `@`는 계속 처리됩니다(502-514행).
3. **텍스트 노드만 처리됩니다**: `tokens` 및 `items` 하위 구조로 재귀됩니다(522-529행).

경로 추출 정규식(라인 459):

``` typescript
// claudemd.ts:459
const includeRegex = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g
```

이 정규 표현식은 `@` 뒤의 공백이 아닌 문자 시퀀스와 일치하며 `\ ` 이스케이프 공백을 지원합니다.

### <a href="#transitive-inclusion-and-circular-reference-protection"
class="header">전이적 포함 및 순환 참조 보호</a>

`processMemoryFile` 함수(618-685행)는 `@include`를 재귀적으로 처리합니다. 두 가지 주요 안전 메커니즘:

**순환 참조 보호**: `processedPaths` 세트(629-630행)를 통해 이미 처리된 파일 경로를 추적합니다. `normalizePathForComparison`를 통해 비교하기 전에 경로가 정규화되어 Windows 드라이브 문자 대소문자 차이(`C:\Users` 대 `c:\Users`)를 처리합니다.

``` typescript
// claudemd.ts:629-630
const normalizedPath = normalizePathForComparison(filePath)
if (processedPaths.has(normalizedPath) || depth >= MAX_INCLUDE_DEPTH) {
  return []
}
```

**최대 깊이 제한**: `MAX_INCLUDE_DEPTH = 5`(라인 537), 지나치게 깊은 중첩을 방지합니다.

**외부 파일 보안**: `@include`가 프로젝트 디렉터리 외부의 파일을 가리킬 때 해당 파일은 기본적으로 로드되지 않습니다(667-669행). 사용자 메모리 수준 파일 또는 `hasClaudeMdExternalIncludesApproved`의 명시적인 사용자 승인만 외부 포함을 허용합니다. 승인되지 않은 외부 포함이 감지되면 시스템은 경고(`shouldShowClaudeMdExternalIncludesWarning`, 1420-1430행)를 표시합니다.

### <a href="#symlink-handling" class="header">심볼릭 링크 처리</a>

모든 파일은 처리하기 전에 심볼릭 링크를 처리하기 위해 `safeResolvePath`를 통해 확인됩니다(640-643행). 파일이 심볼릭 링크인 경우 확인된 실제 경로도 `processedPaths`에 추가되어 심볼릭 링크를 통한 순환 참조 감지 우회를 방지합니다.

------------------------------------------------------------------------

## <a href="#193-frontmatter-paths-scope-limiting" class="header">19.3 머리말 경로: 범위 제한</a>

`.claude/rules/` 디렉토리의 `.md` 파일은 YAML 프론트매터 `paths` 필드를 통해 적용 가능성을 제한할 수 있습니다. 규칙은 Claude가 작업 중인 파일 경로가 이러한 glob 패턴과 일치할 때만 컨텍스트에 삽입됩니다.

### <a href="#frontmatter-parsing" class="header">머리말 파싱</a>

`parseFrontmatterPaths` 함수(254-279행)는 머리말의 `paths` 필드를 처리합니다.

``` typescript
// claudemd.ts:254-279
function parseFrontmatterPaths(rawContent: string): {
  content: string
  paths?: string[]
} {
  const { frontmatter, content } = parseFrontmatter(rawContent)
  if (!frontmatter.paths) {
    return { content }
  }
  const patterns = splitPathInFrontmatter(frontmatter.paths)
    .map(pattern => {
      return pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    })
    .filter((p: string) => p.length > 0)
  if (patterns.length === 0 || patterns.every((p: string) => p === '**')) {
    return { content }
  }
  return { content, paths: patterns }
}
```

`/**` 접미사 처리에 유의하세요. `ignore` 라이브러리는 `path`를 경로 자체 및 경로 내의 모든 내용과 모두 일치하는 것으로 처리하므로 `/**`는 중복되어 자동으로 제거됩니다. 모든 패턴이 `**`(모든 항목과 일치)이면 glob 제약 조건이 없는 것으로 간주됩니다.

### <a href="#path-syntax" class="header">경로 구문</a>

`splitPathInFrontmatter` 함수(`frontmatterParser.ts:189-232`)는 복잡한 경로 구문을 지원합니다.

``` yaml
---
paths: src/**/*.ts, tests/**/*.test.ts
---
```

또는 YAML 목록 형식:

``` yaml
---
paths:
  - src/**/*.ts
  - tests/**/*.test.ts
---
```

중괄호 확장도 지원됩니다. `src/*.{ts,tsx}`는 `["src/*.ts", "src/*.tsx"]`(`frontmatterParser.ts:240-266`의 `expandBraces` 기능)로 확장됩니다. 이 확장기는 다중 레벨 중괄호를 재귀적으로 처리합니다. `{a,b}/{c,d}`는 `["a/c", "a/d", "b/c", "b/d"]`를 생성합니다.

### <a href="#yaml-parsing-fault-tolerance" class="header">YAML 구문 분석 내결함성</a>

머리말 YAML 구문 분석(`frontmatterParser.ts:130-175`)에는 두 가지 수준의 내결함성이 있습니다.

1. **첫 번째 시도**: 원시 머리말 텍스트를 직접 구문 분석합니다.
2. **실패 시 재시도**: `quoteProblematicValues`를 통해 YAML 특수 문자가 포함된 값을 자동으로 인용합니다.

이 재시도 메커니즘은 일반적인 문제를 해결합니다. 즉, `**/*.{ts,tsx}`와 같은 glob 패턴에는 YAML의 흐름 매핑 표시기 `{}`가 포함되어 있어 직접 구문 분석이 실패하게 됩니다. `quoteProblematicValues`(라인 85-121)는 간단한 `key: value` 라인에서 특수 문자(`{}[]*, &#!|>%@`)를 감지하고 자동으로 큰따옴표로 묶습니다. 이미 인용된 값은 건너뜁니다.

이는 사용자가 수동으로 따옴표를 추가하지 않고 `paths: src/**/*.{ts,tsx}`를 직접 작성할 수 있음을 의미합니다. 파서는 첫 번째 YAML 구문 분석 실패 후 자동으로 따옴표를 추가하고 재시도합니다.

### <a href="#conditional-rule-matching" class="header">조건부 규칙 일치</a>

조건부 규칙 일치는 `processConditionedMdRules` 함수(1354-1397행)에 의해 실행됩니다. 규칙 파일을 로드한 다음 `ignore()` 라이브러리(gitignore 호환 glob 일치)를 사용하여 대상 파일 경로를 필터링합니다.

``` typescript
// claudemd.ts:1370-1396
return conditionedRuleMdFiles.filter(file => {
  if (!file.globs || file.globs.length === 0) {
    return false
  }
  const baseDir =
    type === 'Project'
      ? dirname(dirname(rulesDir))  // Parent of .claude directory
      : getOriginalCwd()            // managed/user rules use project root
  const relativePath = isAbsolute(targetPath)
    ? relative(baseDir, targetPath)
    : targetPath
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return false
  }
  return ignore().add(file.globs).ignores(relativePath)
})
```

주요 설계 세부사항:

- **프로젝트 규칙**' glob 기본 디렉터리는 `.claude` 디렉터리를 포함하는 디렉터리입니다.
- **관리/사용자 규칙**' glob 기본 디렉터리는 `getOriginalCwd()`입니다. 즉, 프로젝트 루트
- 기본 디렉터리 외부 경로(`..` 접두사)는 제외됩니다. 기본 디렉터리 상대 글로브와 일치할 수 없습니다.
- Windows에서 드라이브 문자 전체의 `relative()`는 절대 경로를 반환하며 이 역시 제외됩니다.

### <a href="#unconditional-rules-vs-conditional-rules"
class="header">무조건 규칙과 조건부 규칙</a>

`processMdRules` 함수(697-788행) `conditionalRule` 매개변수는 로드되는 규칙 유형을 제어합니다.

- `conditionalRule: false`: `paths` 머리말 **없이** 파일을 로드합니다. 이는 무조건적인 규칙이며 항상 컨텍스트에 삽입됩니다.
- `conditionalRule: true`: `paths` 머리말이 **포함된** 파일을 로드합니다. 이는 조건부 규칙이며 일치하는 경우에만 삽입됩니다.

세션 시작 시 CWD-루트 경로에 따른 무조건 규칙과 관리/사용자 수준 무조건 규칙이 모두 미리 로드됩니다. 조건부 규칙은 Claude가 특정 파일에 대해 작업할 때 요청 시에만 로드됩니다.

------------------------------------------------------------------------

## <a href="#194-html-comment-stripping" class="header">19.4 HTML 주석 제거</a>

CLAUDE.md의 HTML 주석은 컨텍스트에 삽입되기 전에 제거됩니다. 이를 통해 관리자는 Claude가 보지 않기를 원하는 설명을 지침 파일에 남길 수 있습니다.

`stripHtmlComments` 함수(292-301행)는 표시된 어휘분석기를 사용하여 블록 수준 HTML 주석을 식별합니다.

``` typescript
// claudemd.ts:292-301
export function stripHtmlComments(content: string): {
  content: string
  stripped: boolean
} {
  if (!content.includes('<!--')) {
    return { content, stripped: false }
  }
  return stripHtmlCommentsFromTokens(new Lexer({ gfm: false }).lex(content))
}
```

`stripHtmlCommentsFromTokens` 함수(303-334행)의 처리 논리는 정확하고 신중합니다.

1. `<!--`로 시작하고 `-->`를 포함하는 `html` 유형 토큰만 처리합니다.
2. **닫지 않은 주석**(해당 `-->`가 없는 `<!--`)은 보존됩니다. 이를 통해 단일 오타가 파일의 나머지 내용을 자동으로 삼키는 것을 방지할 수 있습니다.
3. **댓글이 보존된 후 잔여 콘텐츠**(예: `<!-- note --> Use bun`는 ` Use bun`를 보존함)
4. 인라인 코드 및 코드 블록 내의 `<!-- -->`는 영향을 받지 않습니다. 어휘분석기는 이미 `code`/`codespan` 유형으로 표시했습니다.

주목할 만한 구현 세부 사항: `gfm: false` 옵션(라인 300). 이는 `@include` 경로의 `~`가 GFM 모드로 표시되어 취소선 마크업으로 구문 분석되기 때문입니다. GFM을 비활성화하면 이러한 충돌을 피할 수 있습니다. HTML 블록 감지는 GFM 설정의 영향을 받지 않는 CommonMark 규칙입니다.

### <a href="#avoiding-spurious-contentdiffersfromdisk"
class="header">가짜 콘텐츠DiffersFromDisk 방지</a>

`parseMemoryFileContent` 함수(343-399행)에는 우아한 최적화가 포함되어 있습니다. 즉, 파일에 실제로 `<!--`(370-374행)가 포함된 경우에만 콘텐츠가 토큰을 통해 재구성됩니다. 이것은 단순한 성능 고려 사항이 아닙니다. 표시된 것은 렉싱 중에 `\r\n`를 `\n`로 정규화하고 CRLF 파일에서 불필요한 토큰 왕복이 수행되면 `contentDiffersFromDisk` 플래그를 허위로 트리거하여 캐시 시스템이 파일이 수정된 것으로 생각하게 만듭니다.

------------------------------------------------------------------------

## <a href="#195-prompt-injection" class="header">19.5 프롬프트 주입</a>

### <a href="#final-injection-format" class="header">최종 주입 형식</a>

`getClaudeMds` 함수(라인 1153-1195)는 로드된 모든 메모리 파일을 최종 시스템 프롬프트 문자열로 조합합니다.

``` typescript
// claudemd.ts:1153-1195
export const getClaudeMds = (
  memoryFiles: MemoryFileInfo[],
  filter?: (type: MemoryType) => boolean,
): string => {
  const memories: string[] = []
  for (const file of memoryFiles) {
    if (filter && !filter(file.type)) continue
    if (file.content) {
      const description =
        file.type === 'Project'
          ? ' (project instructions, checked into the codebase)'
          : file.type === 'Local'
            ? " (user's private project instructions, not checked in)"
            : " (user's private global instructions for all projects)"
      memories.push(`Contents of ${file.path}${description}:\n\n${content}`)
    }
  }
  if (memories.length === 0) {
    return ''
  }
  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${memories.join('\n\n')}`
}
```

각 파일의 삽입 형식은 다음과 같습니다.

/path/to/CLAUDE.md의 내용(설명 유형):

[파일 내용]

모든 파일에는 통합 명령 헤더(`MEMORY_INSTRUCTION_PROMPT`)가 접두사로 추가되어 모델에 다음을 명시적으로 알려줍니다.

> "코드베이스 및 사용자 지침은 아래에 나와 있습니다. 이 지침을 반드시 준수하십시오. 중요: 이 지침은 모든 기본 동작을 무시하며 작성된 대로 정확하게 따라야 합니다."

이 "재정의" 선언은 장식적인 것이 아닙니다. 시스템 프롬프트의 명시적인 지침을 통해 Claude 모델의 높은 준수성을 활용합니다. 프롬프트에서 "이 명령은 기본 동작을 재정의합니다"를 명시적으로 선언함으로써 CLAUDE.md 콘텐츠는 내장 시스템 프롬프트와 동일하거나 그보다 더 큰 영향력을 얻습니다.

### <a href="#the-role-of-type-descriptions" class="header">유형 설명의 역할</a>

각 파일의 유형 설명은 사람이 읽기 위한 것이 아니라 모델이 지침의 출처와 권한을 이해하는 데 도움이 됩니다.

<div class="table-wrapper">

| 유형 | 설명 | 의미론적 의미 |
|----|----|----|
| 프로젝트 | `project instructions, checked into the codebase` | 팀 합의를 엄격히 준수해야 함 |
| 현지의 | `user's private project instructions, not checked in` | 개인 취향, 적당한 유연성 |
| 사용자 | `user's private global instructions for all projects` | 사용자 습관, 프로젝트 간 일관성 |
| AutoMem | `user's auto-memory, persists across conversations` | 참고용으로 배운 지식 |
| TeamMem | `shared team memory, synced across the organization` | `<team-memory-content>` 태그로 포장된 조직 지식 |

</div>

------------------------------------------------------------------------

## <a href="#196-size-budget" class="header">19.6 규모 예산</a>

### <a href="#40k-character-limit" class="header">40,000자 제한</a>

단일 메모리 파일에 권장되는 최대 크기는 40,000자입니다(93행).

``` typescript
// claudemd.ts:93
export const MAX_MEMORY_CHARACTER_COUNT = 40000
```

`getLargeMemoryFiles` 기능(1132-1134행)은 이 제한을 초과하는 파일을 검색하는 데 사용됩니다.

``` typescript
// claudemd.ts:1132-1134
export function getLargeMemoryFiles(files: MemoryFileInfo[]): MemoryFileInfo[] {
  return files.filter(f => f.content.length > MAX_MEMORY_CHARACTER_COUNT)
}
```

이 제한은 하드 차단이 아니라 경고 임계값입니다. 크기가 큰 파일이 감지되면 시스템에서 사용자에게 메시지를 표시하지만 로드를 방지하지는 않습니다. 실제 상한은 전체 시스템 프롬프트의 토큰 예산에 의해 제한됩니다(12장 참조). 대형 CLAUDE.md 파일은 다른 컨텍스트 공간을 압박합니다.

### <a href="#automem-and-teammem-truncation" class="header">AutoMem 및 TeamMem 잘림</a>

자동 메모리 및 팀 메모리 유형의 경우 더 엄격한 절단 논리가 있습니다(382-385행).

``` typescript
// claudemd.ts:382-385
let finalContent = strippedContent
if (type === 'AutoMem' || type === 'TeamMem') {
  finalContent = truncateEntrypointContent(strippedContent).content
}
```

`truncateEntrypointContent`는 `memdir/memdir.ts`에서 제공되며 줄 수와 바이트 수 제한을 모두 적용합니다. 자동 메모리는 사용량에 따라 시간이 지남에 따라 증가할 수 있으며 보다 적극적인 잘라내기 전략이 필요합니다.

------------------------------------------------------------------------

## <a href="#197-file-change-tracking" class="header">19.7 파일 변경 내용 추적</a>

### <a href="#contentdiffersfromdisk-flag"
class="header">contentDiffersFromDisk 플래그</a>

`MemoryFileInfo` 유형(229-243행)에는 두 개의 캐시 관련 필드가 포함되어 있습니다.

``` typescript
// claudemd.ts:229-243
export type MemoryFileInfo = {
  path: string
  type: MemoryType
  content: string
  parent?: string
  globs?: string[]
  contentDiffersFromDisk?: boolean
  rawContent?: string
}
```

`contentDiffersFromDisk`가 `true`인 경우 `content`는 처리된 버전(머리말 제거, HTML 주석 제거, 잘림)이며 `rawContent`는 원시 디스크 내용을 보존합니다. 이를 통해 캐시 시스템은 편집/쓰기 도구가 작동하기 전에 다시 읽도록 강제하지 않으면서 "파일을 읽었습니다"(중복 제거 및 변경 감지를 위해)를 기록할 수 있습니다. 왜냐하면 컨텍스트에 주입되는 것은 디스크 콘텐츠와 정확히 동일하지 않은 처리된 버전이기 때문입니다.

### <a href="#cache-invalidation-strategy" class="header">캐시 무효화 전략</a>

`getMemoryFiles`는 lodash `memoize` 캐싱(790행)을 사용합니다. 캐시 지우기에는 두 가지 의미가 있습니다.

**후크를 트리거하지 않고 지우기(`clearMemoryFileCaches`, 1119-1122행)**: 순수 캐시 정확성 시나리오의 경우 — 작업 트리 시작/종료, 설정 동기화, `/memory` 대화 상자.

**InstructionsLoaded 후크 지우기 및 트리거(`resetGetMemoryFilesCache`, 1124-1130행)**: 명령이 실제로 컨텍스트에 다시 로드되는 시나리오(세션 시작, 압축)에 적합합니다.

``` typescript
// claudemd.ts:1124-1130
export function resetGetMemoryFilesCache(
  reason: InstructionsLoadReason = 'session_start',
): void {
  nextEagerLoadReason = reason
  shouldFireHook = true
  clearMemoryFileCaches()
}
```

`shouldFireHook`는 일회성 플래그입니다. 후크가 실행된 후(라인 1102-1108의 `consumeNextEagerLoadReason`) `false`로 설정되어 동일한 로딩 라운드 내에서 중복 실행을 방지합니다. 이 플래그의 소비는 Hook이 실제로 구성되었는지 여부에 좌우되지 않습니다. InstructionsLoaded Hook이 없어도 플래그가 소비됩니다. 그렇지 않으면 후속 후크 등록 + 캐시 지우기가 가짜 `session_start` 트리거를 생성합니다.

------------------------------------------------------------------------

## <a href="#198-file-type-support-and-security-filtering"
class="header">19.8 파일 유형 지원 및 보안 필터링</a>

### <a href="#allowed-file-extensions" class="header">허용되는 파일 확장자</a>

`@include` 지시문은 텍스트 파일만 로드합니다. `TEXT_FILE_EXTENSIONS` 세트(96-227행)는 다음을 포함하여 120개 이상의 허용 확장을 정의합니다.

- 마크다운 및 텍스트: `.md`, `.txt`, `.text`
- 데이터 형식: `.json`, `.yaml`, `.yml`, `.toml`, `.xml`, `.csv`
- 프로그래밍 언어: `.js`에서 `.rs`까지, `.py`에서 `.go`까지, `.java`에서 `.swift`까지
- 구성 파일: `.env`, `.ini`, `.cfg`, `.conf`
- 빌드 파일: `.cmake`, `.gradle`, `.sbt`

파일 확장자 확인은 `parseMemoryFileContent` 함수(343-399행)에서 수행됩니다.

``` typescript
// claudemd.ts:349-353
const ext = extname(filePath).toLowerCase()
if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) {
  logForDebugging(`Skipping non-text file in @include: ${filePath}`)
  return { info: null, includePaths: [] }
}
```

이는 바이너리 파일(이미지, PDF 등)이 메모리에 로드되는 것을 방지합니다. 이러한 콘텐츠는 의미가 없을 뿐만 아니라 많은 양의 토큰 예산을 소모할 수 있습니다.

### <a href="#claudemdexcludes-exclusion-patterns"
class="header">cludeMd는 제외 패턴을 제외합니다.</a>

`isClaudeMdExcluded` 기능(547-573행)은 `claudeMdExcludes` 설정을 통해 특정 CLAUDE.md 파일 경로를 제외하는 사용자를 지원합니다.

``` typescript
// claudemd.ts:547-573
function isClaudeMdExcluded(filePath: string, type: MemoryType): boolean {
  if (type !== 'User' && type !== 'Project' && type !== 'Local') {
    return false  // Managed, AutoMem, TeamMem are never excluded
  }
  const patterns = getInitialSettings().claudeMdExcludes
  if (!patterns || patterns.length === 0) {
    return false
  }
  // ...picomatch matching logic
}
```

제외 패턴은 glob 구문을 지원하고 macOS 심볼릭 링크 문제를 처리합니다. macOS의 `/tmp`는 실제로 `/private/tmp`를 가리키며 `resolveExcludePatterns` 함수(581~612행)는 절대 경로 패턴의 심볼릭 링크 접두사를 확인하여 양측이 비교를 위해 동일한 실제 경로를 사용하도록 보장합니다.

------------------------------------------------------------------------

## <a href="#199-what-users-can-do-claudemd-writing-best-practices"
class="header">19.9 사용자가 할 수 있는 일: CLAUDE.md 모범 사례 작성</a>

소스 코드 분석을 바탕으로 CLAUDE.md 작성에 대한 실제 권장 사항은 다음과 같습니다.

### <a href="#leverage-priority-cascading" class="header">우선순위 계단식 활용</a>

~/.claude/CLAUDE.md # 개인 환경 설정: 코드 스타일, 언어 설정 project/CLAUDE.md # 팀 규칙: 기술 스택, 아키텍처 표준 project/.claude/rules/*.md # 세분화된 규칙: 도메인별로 구성 project/CLAUDE.local.md # 로컬 재정의: 디버그 구성, 개인 툴체인

로컬 메모리의 우선순위가 가장 높습니다. 팀 규칙에서 공백 4개 들여쓰기를 사용하지만 공백 2개를 선호하는 경우 `CLAUDE.local.md`에서 재정의하세요.

### <a href="#use-include-for-modularization" class="header">모듈화를 위해 @include 사용</a>

``` markdown
# CLAUDE.md

@./docs/coding-standards.md
@./docs/api-conventions.md
@~/.claude/snippets/common-patterns.md
```

참고: `@include`의 최대 깊이는 5레벨이며 순환 참조는 자동으로 무시됩니다. 외부 파일(프로젝트 디렉터리 외부 경로)은 기본적으로 프로젝트 메모리 수준에서 로드되지 않습니다. 사용자 수준 `@include`에는 이 제한이 적용되지 않습니다.

### <a href="#use-frontmatter-paths-for-on-demand-loading"
class="header">온디맨드 로딩을 ​​위한 머리말 경로 사용</a>

``` markdown
---
paths: src/api/**/*.ts, src/api/**/*.test.ts
---

# API Development Guidelines

- All API endpoints must have corresponding integration tests
- Use Zod for request/response validation
- Error responses follow RFC 7807 Problem Details format
```

이 규칙은 Claude가 `src/api/` 아래의 TypeScript 파일에서 작동할 때만 주입됩니다. 즉, 귀중한 컨텍스트 공간을 차지하는 관련 없는 규칙을 방지합니다. 중괄호 확장도 지원됩니다. `src/*.{ts,tsx}`는 `.ts` 및 `.tsx` 파일과 모두 일치합니다.

### <a href="#use-html-comments-to-hide-internal-notes" class="header">HTML 주석을 사용하여 내부 메모 숨기기</a>

``` markdown
<!-- TODO: Update this specification after API v3 release -->
<!-- This rule was temporarily added due to the gh-12345 bug -->

All database queries must use parameterized statements; string concatenation is prohibited.
```

HTML 주석은 Claude의 컨텍스트에 삽입되기 전에 제거됩니다. 그러나 참고: 닫히지 않은 `<!--`는 보존됩니다. 이는 의도적인 보안 설계입니다.

### <a href="#control-file-size" class="header">제어 파일 크기</a>

단일 CLAUDE.md의 권장 최대값은 40,000자입니다. 지침이 너무 많으면 다음 전략을 선호합니다.

1. **`.claude/rules/` 디렉토리의 여러 파일로 분할** - 각 파일은 하나의 주제에 중점을 둡니다.
2. **주문형 로딩을 위해 머리말 경로 사용** — 관련 없는 규칙은 컨텍스트를 소비하지 않습니다.
3. **외부 문서를 참조하려면 `@include`를 사용하세요** — CLAUDE.md에서 정보 중복을 방지하세요

### <a href="#understand-override-semantics" class="header">재정의 의미 이해</a>

CLAUDE.md 콘텐츠는 "제안"이 아닙니다. `MEMORY_INSTRUCTION_PROMPT`의 명시적인 선언을 통해 따라야 하는 지침으로 표시됩니다. 이는 다음을 의미합니다.

- "`any` 유형 사용 금지"를 작성하는 것이 "`any` 유형 사용을 피하십시오"보다 효과적입니다. 모델은 명확한 금지 사항을 엄격하게 준수합니다.
- 모순되는 지침(반대의 요구 사항을 제공하는 다양한 CLAUDE.md 레벨)은 마지막으로 로드된(가장 높은 우선순위) 승리로 해결됩니다. 그러나 모델이 조정을 시도할 수 있으므로 직접적인 모순을 피하십시오.
- 각 파일의 경로와 유형 설명이 컨텍스트에 삽입됩니다. 모델은 지침이 어디에서 왔는지 확인할 수 있으며 이는 규정 준수 판단에 영향을 미칩니다.

### <a href="#leverage-the-clauderules-directory-structure"
class="header"><code>.claude/rules/</code> 디렉토리 구조 활용</a>

규칙 디렉터리는 재귀적 하위 디렉터리를 지원하므로 팀이나 모듈별로 구성할 수 있습니다.

.claude/rules/ 프론트엔드/ React-patterns.md css-conventions.md 백엔드/ api-design.md 데이터베이스-rules.md 테스트/unit-test-rules.md e2e-rules.md

모든 `.md` 파일은 로드(무조건 규칙)되거나 요청 시 일치됩니다(`paths` 앞문이 있는 조건 규칙). Symlink는 지원되지만 실제 경로로 확인됩니다. 순환 참조는 `visitedDirs` 세트를 통해 감지됩니다.

------------------------------------------------------------------------

## <a href="#1910-exclusion-mechanism-and-rule-directory-traversal"
class="header">19.10 제외 메커니즘 및 규칙 디렉터리 순회</a>

### <a href="#clauderules-recursive-traversal" class="header">.claude/rules/ 재귀 순회</a>

`processMdRules` 함수(697-788행)는 `.claude/rules/` 디렉터리와 해당 하위 디렉터리를 재귀적으로 탐색하여 모든 `.md` 파일을 로드합니다. 여러 가지 극단적인 경우를 처리합니다.

1. **Symlinked 디렉터리**: `visitedDirs` 세트(712-714행)를 통한 주기 감지를 통해 `safeResolvePath`를 통해 해결되었습니다.
2. **권한 오류**: `ENOENT`, `EACCES`, `ENOTDIR`는 자동으로 처리됩니다. 누락된 디렉터리는 오류가 아닙니다(734-738행).
3. **Dirent 최적화**: Non-symlink는 Dirent 메소드를 사용하여 추가 `stat` 호출을 방지하고 파일/디렉토리 유형을 결정합니다(라인 748-752).

### <a href="#instructionsloaded-hook-integration"
class="header">지침로드된 후크 통합</a>

메모리 파일 로드가 완료되면 `InstructionsLoaded` 후크가 구성된 경우 로드된 각 파일에 대해 한 번씩 트리거됩니다(라인 1042-1071). Hook 입력에는 다음이 포함됩니다.

- `file_path`: 파일 경로
- `memory_type`: 사용자/프로젝트/로컬/관리됨
- `load_reason`: session_start/nested_traversal/path_glob_match/include/compact
- `globs`: 머리말 경로 패턴(선택 사항)
- `parent_file_path`: `@include`의 상위 파일 경로(선택 사항)

이는 감사 및 관찰 가능성을 위한 완전한 명령 로딩 추적을 제공합니다. AutoMem 및 TeamMem 유형은 의도적으로 제외됩니다. 이들은 독립적인 메모리 시스템이며 "명령어"의 의미 범위에 속하지 않습니다.

------------------------------------------------------------------------

## <a href="#pattern-distillation" class="header">패턴 증류</a>

### <a href="#pattern-one-layered-override-configuration"
class="header">패턴 1: 계층화된 재정의 구성</a>

**해결된 문제**: 다양한 수준의 사용자(기업 관리자, 개인 사용자, 팀, 로컬 개발자)는 동일한 시스템에 대해 다양한 수준의 제어를 행사해야 합니다.

**코드 템플릿**: 명확한 우선순위 수준을 정의하고(관리 -\> 사용자 -\> 프로젝트 -\> 로컬) 우선순위 역순으로 로드합니다(마지막 로드가 가장 높은 우선순위임). 각 레이어는 이전 레이어를 재정의하거나 보완할 수 있습니다. `isSettingSourceEnabled()` 스위치를 통해 각 레이어가 적용되는지 여부를 제어합니다.

**전제 조건**: 사용되는 LLM은 메시지 끝 부분의 콘텐츠에 더 높은 주의를 기울입니다(최근 편향).

### <a href="#pattern-two-explicit-override-declaration"
class="header">패턴 2: 명시적 재정의 선언</a>

**문제 해결**: 모델이 기본 동작에 따라 사용자 구성 및 출력을 무시할 수 있습니다.

**코드 템플릿**: 사용자 지침을 삽입하기 전에 명시적인 메타 지침을 추가합니다. "이 지침은 모든 기본 동작을 재정의하므로 작성된 대로 정확하게 따라야 합니다." — 명시적인 지침을 통해 모델의 높은 준수성을 활용합니다.

**전제 조건**: 명령 주입 지점이 시스템 프롬프트 또는 상위 권한 메시지에 있습니다.

### <a href="#pattern-three-conditional-on-demand-loading"
class="header">패턴 3: 조건부 온디맨드 로딩</a>

**문제 해결**: 컨텍스트 창이 제한됩니다. 관련 없는 규칙은 토큰 예산을 낭비합니다.

**코드 템플릿**: Frontmatter의 `paths` 필드를 통해 규칙의 적용 범위(glob 패턴)를 선언합니다. 시작 시 무조건 규칙을 로드합니다. 조건부 규칙은 에이전트가 경로와 일치하는 파일에 대해 작업할 때만 요청 시 삽입됩니다. gitignore 호환 glob 일치를 위해 `ignore()` 라이브러리를 사용하세요.

**전제 조건**: 규칙과 파일 경로 간의 연관성을 미리 결정할 수 있습니다.

------------------------------------------------------------------------

## <a href="#summary" class="header">요약</a>

CLAUDE.md 시스템의 핵심 디자인 철학은 **계층형 재정의**입니다. 즉, 기업 정책부터 개인 선호도까지 각 계층을 다음 계층으로 재정의하거나 보완할 수 있습니다. 이 아키텍처는 CSS의 계단식 메커니즘, git의 `.gitignore` 상속 및 npm의 `.npmrc` 계층 구조와 유사점을 공유하며 모두 "전역 기본값"과 "로컬 사용자 정의" 사이의 균형을 찾습니다.

AI Agent 빌더를 위해 차용할 가치가 있는 몇 가지 디자인 선택:

1. **명시적 재정의 선언**: `MEMORY_INSTRUCTION_PROMPT`는 모델에 "이 명령은 기본 동작을 재정의합니다"라고 알려줍니다. 우선순위를 자체 결정하기 위해 모델에 의존하지 않습니다.
2. **주문형 로딩**: 주요 경로는 규칙이 관련된 경우에만 컨텍스트를 차지하도록 보장합니다. 200K 토큰 분야에서는 모든 토큰이 부족한 리소스입니다.
3. **명확한 보안 경계**: 외부 파일을 포함하려면 명시적인 승인이 필요하고 바이너리 파일은 필터링되며 HTML 주석 제거는 닫힌 주석만 처리합니다.
4. **분리된 캐시 의미**: `clearMemoryFileCaches`와 `resetGetMemoryFilesCache`를 구별하여 캐시 무효화 중 부작용을 방지합니다.

------------------------------------------------------------------------

## <a href="#version-evolution-v2191-changes" class="header">버전 진화: v2.1.91 변경 사항</a>

> 다음 분석은 v2.1.91 번들 신호 비교를 기반으로 합니다.

v2.1.91에는 새로운 `tengu_hook_output_persisted` 및 `tengu_pre_tool_hook_deferred` 이벤트, 추적 후크 출력 지속성 및 사전 도구 후크 지연 실행이 각각 추가되었습니다. 이러한 이벤트는 이 장에 설명된 CLAUDE.md 명령 시스템과 병행하여 실행됩니다. CLAUDE.md는 자연어를 통해 동작을 제어하고, 코드 실행을 통해 Hooks는 동작을 제어하며, 함께 사용자 정의 하네스 레이어를 형성합니다.
