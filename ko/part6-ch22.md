# <a href="#chapter-22-skills-system----from-built-in-to-user-defined"
class="header">22장: 스킬 시스템 - 기본 제공에서 사용자 정의까지</a>

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

이전 장에서는 Claude Code의 도구 시스템, 권한 모델 및 컨텍스트 관리를 분석했습니다. 그러나 핵심 확장 레이어는 **스킬 시스템**이라는 모든 시스템을 통해 구성되어 왔습니다.

사용자가 `/batch migrate from react to vue`를 입력하면 Claude Code는 "명령"을 실행하지 않습니다. 즉, 신중하게 제작된 프롬프트 템플릿을 로드하고 이를 컨텍스트 창에 삽입하여 모델이 미리 정의된 작업 흐름에 따라 작동하도록 합니다. 스킬 시스템의 핵심은 **호출 가능한 프롬프트 템플릿**입니다. 반복적으로 검증된 모범 사례를 Markdown 파일로 인코딩하고 `Skill` 도구를 통해 대화 흐름에 삽입합니다.

이 디자인 철학은 심오한 엔지니어링 의미를 가져옵니다. 기술은 코드 논리가 아니라 **구조화된 지식**입니다. 기술 파일은 필요한 도구, 사용할 모델, 실행할 실행 컨텍스트를 정의할 수 있지만 핵심은 항상 LLM에 의해 해석되고 실행되는 Markdown 텍스트입니다.

이 장에서는 기본 제공 기술부터 시작하여 등록, 검색, 로딩, 실행 및 개선 메커니즘을 점진적으로 공개합니다.

------------------------------------------------------------------------

## <a href="#221-the-nature-of-skills-command-types-and-registration"
class="header">22.1 스킬의 성격: 명령 유형 및 등록</a>

### <a href="#bundledskilldefinition-structure"
class="header">BundledSkillDefinition 구조</a>

모든 기술은 궁극적으로 `Command` 개체로 표시됩니다. 내장 스킬은 `registerBundledSkill` 기능을 통해 다음 정의 유형으로 등록됩니다.

``` typescript
// skills/bundledSkills.ts:15-41
export type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean
  hooks?: HooksSettings
  context?: 'inline' | 'fork'
  agent?: string
  files?: Record<string, string>
  getPromptForCommand: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}
```

이 유형은 기술의 몇 가지 주요 측면을 드러냅니다.

<div class="table-wrapper">

| 필드 | 목적 | 일반적인 값 |
|----|----|----|
| `name` | 스킬 호출 이름은 `/name` 구문에 해당합니다. | `"batch"`, `"simplify"` |
| `whenToUse` | 이 기술을 적극적으로 호출할 **시기**를 모델에 알려줍니다. | 시스템 알림에 표시됩니다. |
| `allowedTools` | 스킬 실행 중 자동 승인되는 도구 | `['Read', 'Grep', 'Glob']` |
| `context` | 실행 컨텍스트 - `inline`는 기본 대화에 삽입되고 `fork`는 하위 에이전트에서 실행됩니다. | `'fork'` |
| `disableModelInvocation` | 모델이 사전에 호출하는 것을 방지하고 사용자의 명시적 입력만 허용합니다. | `true`(배치) |
| `files` | 첫 번째 호출 시 디스크에 추출된 스킬과 함께 번들로 제공되는 참조 파일 | 스킬의 유효성 검사 스크립트 확인 |
| `getPromptForCommand` | **핵심**: 컨텍스트에 삽입된 프롬프트 콘텐츠 생성 | `ContentBlockParam[]`를 반환합니다. |

</div>

등록 흐름 자체는 간단합니다. `registerBundledSkill`는 정의를 표준 `Command` 객체로 변환하고 이를 내부 배열에 푸시합니다.

``` typescript
// skills/bundledSkills.ts:53-100
export function registerBundledSkill(definition: BundledSkillDefinition): void {
  const { files } = definition
  let skillRoot: string | undefined
  let getPromptForCommand = definition.getPromptForCommand

  if (files && Object.keys(files).length > 0) {
    skillRoot = getBundledSkillExtractDir(definition.name)
    let extractionPromise: Promise<string | null> | undefined
    const inner = definition.getPromptForCommand
    getPromptForCommand = async (args, ctx) => {
      extractionPromise ??= extractBundledSkillFiles(definition.name, files)
      const extractedDir = await extractionPromise
      const blocks = await inner(args, ctx)
      if (extractedDir === null) return blocks
      return prependBaseDir(blocks, extractedDir)
    }
  }

  const command: Command = {
    type: 'prompt',
    name: definition.name,
    // ... field mapping ...
    source: 'bundled',
    loadedFrom: 'bundled',
    getPromptForCommand,
  }
  bundledSkills.push(command)
}
```

67행의 `extractionPromise ??= ...` 패턴에 주목하세요. 이것은 "메모된 약속"입니다. 여러 동시 호출자가 동시에 첫 번째 호출을 트리거하면 모두 **동일한 Promise**를 기다리므로 중복 파일 쓰기를 유발하는 경쟁 조건을 피할 수 있습니다.

### <a href="#file-extraction-safety-measures" class="header">파일 추출 안전 조치</a>

내장 기술 참조 파일 추출에는 보안에 민감한 파일 시스템 작업이 포함됩니다. 소스 코드는 0o600 권한으로 `safeWriteFile`의 `O_NOFOLLOW | O_EXCL` 플래그 조합(176-184행)을 사용합니다. 이 의견은 위협 모델을 명시적으로 설명합니다.

``` typescript
// skills/bundledSkills.ts:169-175
// The per-process nonce in getBundledSkillsRoot() is the primary defense
// against pre-created symlinks/dirs. Explicit 0o700/0o600 modes keep the
// nonce subtree owner-only even on umask=0, so an attacker who learns the
// nonce via inotify on the predictable parent still can't write into it.
```

이는 일반적인 **심층 방어** 설계입니다. 프로세스별 nonce가 기본 방어이고 `O_NOFOLLOW` 및 `O_EXCL`가 보조 방어입니다.

------------------------------------------------------------------------

## <a href="#222-built-in-skills-inventory" class="header">22.2 내장 스킬 인벤토리</a>

모든 내장 스킬은 `skills/bundled/index.ts`의 `initBundledSkills` 함수에 등록됩니다. 소스 분석에 따르면 내장된 스킬은 **무조건 등록됨**과 **기능 플래그로 등록됨**의 두 가지 범주로 분류됩니다.

### <a href="#table-22-1-built-in-skills-inventory" class="header">표 22-1: 내장 기술 인벤토리</a>

<div class="table-wrapper">

| 스킬명 | 등록조건 | 기능 요약 | 실행 모드 | 사용자 호출 가능 |
|----|----|----|----|----|
| `update-config` | 무조건 | settings.json을 통해 Claude Code 구성 | 인라인 | 예 |
| `keybindings` | 무조건 | 키보드 단축키 사용자 정의 | 인라인 | 예 |
| `verify` | `USER_TYPE === 'ant'` | 앱을 실행하여 코드 변경 사항을 확인하세요. | 인라인 | 예 |
| `debug` | 무조건 | 디버그 로그 활성화 및 문제 진단 | 인라인 | 예(모델 호출 비활성화됨) |
| `lorem-ipsum` | 무조건 | 개발/테스트 자리 표시자 | 인라인 | 예 |
| `skillify` | `USER_TYPE === 'ant'` | 현재 세션을 재사용 가능한 스킬로 캡처 | 인라인 | 예(모델 호출 비활성화됨) |
| `remember` | `USER_TYPE === 'ant'` | 에이전트 메모리 계층 검토 및 구성 | 인라인 | 예 |
| `simplify` | 무조건 | 품질 및 효율성을 위해 변경된 코드 검토 | 인라인 | 예 |
| `batch` | 무조건 | 대규모 변경을 위한 병렬 작업 트리 에이전트 | 인라인 | 예(모델 호출 비활성화됨) |
| `stuck` | `USER_TYPE === 'ant'` | 정지되거나 느린 Claude Code 세션 진단 | 인라인 | 예 |
| `dream` | `KAIROS || KAIROS_DREAM` | autoDream 메모리 통합 | 인라인 | 예 |
| `hunter` | `REVIEW_ARTIFACT` | 아티팩트 검토 | 인라인 | 예 |
| `loop` | `AGENT_TRIGGERS` | Timed 루프 프롬프트 실행 | 인라인 | 예 |
| `schedule` | `AGENT_TRIGGERS_REMOTE` | 원격 시간 제한 에이전트 트리거 만들기 | 인라인 | 예 |
| `claude-api` | `BUILDING_CLAUDE_APPS` | Claude API를 사용하여 앱 구축 | 인라인 | 예 |
| `claude-in-chrome` | `shouldAutoEnableClaudeInChrome()` | Chrome 브라우저 통합 | 인라인 | 예 |
| `run-skill-generator` | `RUN_SKILL_GENERATOR` | 스킬 생성기 | 인라인 | 예 |

</div>

**표 22-1: 내장 스킬 등록 조건 인벤토리**

기능 플래그 게이트 기술은 ESM의 `import()` 대신 `require()` 동적 가져오기를 사용합니다. 소스의 36-38행에 해당 eslint-disable 주석이 있습니다. 이는 Bun의 빌드 시간 트리 쉐이킹이 정적 분석에 의존하기 때문입니다. `feature()` 호출은 Bun이 컴파일 시간에 부울 상수로 평가하여 일치하지 않는 빌드 구성에서 전체 `require()` 분기를 완전히 제거합니다.

### <a href="#typical-skill-dissection-batch" class="header">일반적인 기술 해부: 배치</a>

`batch` 스킬(`skills/bundled/batch.ts`)은 스킬 작동 방식을 이해하는 데 탁월한 샘플입니다. 프롬프트 템플릿은 3단계 워크플로를 정의합니다.

1. **연구 및 계획 단계**: 계획 모드에 진입하고, 포그라운드 하위 에이전트를 실행하여 코드베이스를 연구하고, 5~30개의 독립적인 작업 단위로 분해합니다.
2. **병렬 실행 단계**: 각 작업 단위에 대해 백그라운드 `worktree` 격리 에이전트 실행
3. **진행 상황 추적 단계**: 상태 테이블 유지, PR 링크 집계

``` typescript
// skills/bundled/batch.ts:9-10
const MIN_AGENTS = 5
const MAX_AGENTS = 30
```

주요 엔지니어링 결정은 `disableModelInvocation: true`(109행)입니다. 배치 기술은 **사용자가 명시적으로 `/batch`를 입력해야만** 트리거될 수 있습니다. 모델은 대규모 병렬 리팩터링을 시작하기로 자율적으로 결정할 수 없습니다. 이는 합리적인 안전 경계입니다. 일괄 작업은 수많은 작업 트리와 PR을 생성하며 자율 트리거링은 너무 위험합니다.

### <a href="#typical-skill-dissection-simplify" class="header">일반적인 기술 분석: 단순화</a>

`simplify` 기술은 `AgentTool`를 통해 **3개의 병렬 검토 에이전트**를 시작하는 또 다른 일반적인 패턴을 보여줍니다.

1. **코드 재사용 검토**: 기존 유틸리티 기능 검색, 중복 구현 표시
2. **코드 품질 검토**: 중복 상태, 매개변수 팽창, 복사-붙여넣기, 불필요한 주석 감지
3. **효율성 검토**: 과도한 계산, 동시성 누락, 핫 경로 팽창, 메모리 누수 감지

이 세 가지 에이전트는 병렬로 실행되며 통합 수정을 위해 결과가 집계됩니다. 기술 프롬프트 자체는 "인간 코드 검토 모범 사례" 지식을 인코딩합니다.

### <a href="#typical-skill-dissection-skillify-session-to-skill-distiller"
class="header">일반적인 기술 분석: Skillify(Session-to-Skill Distiller)</a>

`skillify`는 시스템에서 가장 "메타"적인 기술입니다. 이 기술의 임무는 **현재 세션에서 반복 가능한 워크플로를 새 기술 파일로 추출**하는 것입니다. `skills/bundled/skillify.ts`에 있는 소스.

**게이팅**: `USER_TYPE === 'ant'`(라인 159), Anthropic 내부 사용자에게만 제공됩니다. `disableModelInvocation: true`(라인 177)는 `/skillify`를 통해서만 수동으로 트리거할 수 있습니다.

``` typescript
// skills/bundled/skillify.ts:158-162
export function registerSkillifySkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }
  // ...
}
```

**데이터 소스**: Skillify의 프롬프트 템플릿(22-156행)은 런타임에 두 가지 컨텍스트를 동적으로 주입합니다.

1. **세션 메모리 요약**: 현재 세션의 구조화된 요약을 위해 `getSessionMemoryContent()`를 통해 얻습니다(24장의 세션 메모리 섹션 참조).
2. **사용자 메시지 추출**: `extractUserMessages()`를 통해 압축 경계 이후의 모든 사용자 메시지 추출

``` typescript
// skills/bundled/skillify.ts:179-194
async getPromptForCommand(args, context) {
  const sessionMemory =
    (await getSessionMemoryContent()) ?? 'No session memory available.'
  const userMessages = extractUserMessages(
    getMessagesAfterCompactBoundary(context.messages),
  )
  // ...
}
```

**4라운드 인터뷰 구조**: Skillify의 프롬프트는 구조화된 4라운드 인터뷰를 정의하며 모두 `AskUserQuestion` 도구(일반 텍스트 출력 아님)를 통해 수행되어 사용자가 명확한 선택을 할 수 있도록 보장합니다.

<div class="table-wrapper">

| 둥근 | 목표 | 주요 결정 |
|----|----|----|
| 1라운드 | 높은 수준의 확인 | 기술 이름, 설명, 목표 및 성공 기준 |
| 2라운드 | 세부 보충 | 단계 목록, 매개변수 정의, 인라인 대 포크, 저장 위치 |
| 3라운드 | 단계별 개선 | 단계별 성공 기준, 결과물, 인적 체크포인트, 병렬화 기회 |
| 4라운드 | 최종 확인 | 트리거 조건, 트리거 문구, 엣지 케이스 |

</div>

프롬프트는 특히 "사용자가 당신을 정정한 곳에 주의를 기울이십시오"(`Pay special attention to places where the user corrected you during the session`)를 강조합니다. 이러한 정정에는 종종 가장 귀중한 암묵적 지식이 포함되어 있으며 기술의 엄격한 규칙으로 인코딩되어야 합니다.

**생성된 SKILL.md 형식**: Skillify에서 생성된 스킬은 몇 가지 주요 주석 규칙이 있는 표준 머리말 형식을 따릅니다.

- 각 단계에는 **반드시** `Success criteria`가 포함되어야 합니다.
- 병렬화 가능한 단계에서는 하위 번호 지정(3a, 3b)을 사용합니다.
- 사용자 조치가 필요한 단계는 `[human]`로 표시됩니다.
- `allowed-tools`는 최소 권한 모드를 사용합니다(예: `Bash`가 아닌 `Bash(gh:*)`).

Skillify와 SKILL_IMPROVEMENT(섹션 22.8)는 상호 보완적입니다. Skillify는 처음부터 스킬을 생성하고 SKILL_IMPROVEMENT는 사용 중에 지속적으로 스킬을 개선합니다. 이들은 함께 완전한 "생성 -\> 개선" 수명 주기 루프를 형성합니다.

------------------------------------------------------------------------

## <a
href="#223-user-defined-skills-discovery-and-loading-in-loadskillsdirts"
class="header">22.3 사용자 정의 기술: loadSkillsDir.ts에서 검색 및 로드</a>

### <a href="#skill-file-structure" class="header">스킬 파일 구조</a>

사용자 정의 기술은 디렉터리 형식을 따릅니다.

.claude/skills/ my-skill/ SKILL.md ← 기본 파일(머리말 + 마크다운 본문) reference.ts ← 선택적 참조 파일

`SKILL.md` 파일은 YAML 머리말을 사용하여 메타데이터를 선언합니다.

``` yaml
---
description: My custom skill
when_to_use: When the user asks for X
allowed-tools: Read, Grep, Bash
context: fork
model: opus
effort: high
arguments: [target, scope]
paths: src/components/**
---

# Skill prompt content here...
```

### <a href="#four-layer-loading-priority" class="header">4레이어 로딩 우선순위</a>

`getSkillDirCommands` 기능(`loadSkillsDir.ts:638`)은 4개의 소스에서 동시에 우선순위가 높은 것부터 낮은 것 순으로 스킬을 로드합니다.

``` typescript
// skills/loadSkillsDir.ts:679-713
const [
  managedSkills,      // 1. Policy-managed skills (enterprise deployment)
  userSkills,         // 2. User global skills (~/.claude/skills/)
  projectSkillsNested,// 3. Project skills (.claude/skills/)
  additionalSkillsNested, // 4. --add-dir additional directories
  legacyCommands,     // 5. Legacy /commands/ directory (deprecated)
] = await Promise.all([
  loadSkillsFromSkillsDir(managedSkillsDir, 'policySettings'),
  loadSkillsFromSkillsDir(userSkillsDir, 'userSettings'),
  // ... project and additional directories ...
  loadSkillsFromCommandsDir(cwd),
])
```

각 소스는 독립적으로 스위치로 제어됩니다.

<div class="table-wrapper">

| 원천 | 스위치 조건 | 디렉토리 경로 |
|----|----|----|
| 정책 관리 | `!CLAUDE_CODE_DISABLE_POLICY_SKILLS` | `<managed>/.claude/skills/` |
| 사용자 글로벌 | `isSettingSourceEnabled('userSettings') && !skillsLocked` | `~/.claude/skills/` |
| 프로젝트 로컬 | `isSettingSourceEnabled('projectSettings') && !skillsLocked` | `.claude/skills/`(걸음) |
| --추가 디렉토리 | 위와 동일 | `<dir>/.claude/skills/` |
| 레거시 명령 | `!skillsLocked` | `.claude/commands/` |

</div>

**표 22-2: 스킬 로딩 소스 및 전환 조건**

`skillsLocked` 플래그는 `isRestrictedToPluginOnly('skills')`에서 유래합니다. 기업 정책이 플러그인 전용 기술로 제한되면 모든 로컬 기술 로딩을 건너뜁니다.

### <a href="#frontmatter-parsing" class="header">머리말 분석</a>

`parseSkillFrontmatterFields` 함수(185-265행)는 모든 기술 소스에 대한 공유 구문 분석 진입점입니다. 처리하는 필드는 다음과 같습니다.

``` typescript
// skills/loadSkillsDir.ts:185-206
export function parseSkillFrontmatterFields(
  frontmatter: FrontmatterData,
  markdownContent: string,
  resolvedName: string,
): {
  displayName: string | undefined
  description: string
  allowedTools: string[]
  argumentHint: string | undefined
  whenToUse: string | undefined
  model: ReturnType<typeof parseUserSpecifiedModel> | undefined
  disableModelInvocation: boolean
  hooks: HooksSettings | undefined
  executionContext: 'fork' | undefined
  agent: string | undefined
  effort: EffortValue | undefined
  shell: FrontmatterShell | undefined
  // ...
}
```

주목할 만한 것은 `effort` 필드(228-235행)입니다. 스킬은 전역 설정을 재정의하여 자체 "노력 수준"을 지정할 수 있습니다. 유효하지 않은 작업량 값은 관대한 구문 분석 원칙에 따라 디버그 로그에서 자동으로 무시됩니다.

### <a href="#variable-substitution-at-prompt-execution"
class="header">프롬프트 실행 시 변수 대체</a>

`createSkillCommand`의 `getPromptForCommand` 메서드(344-399행)는 기술이 호출될 때 다음 처리 체인을 수행합니다.

원시 마크다운 │ ▼ "기본 디렉터리" 접두사 추가(baseDir이 있는 경우) │ ▼ 인수 대체($1, $2 또는 명명된 인수) │ ▼ ${CLAUDE_SKILL_DIR} → 기술 디렉터리 경로 │ ▼ ${CLAUDE_SESSION_ID} → 현재 세션 ID │ ▼ 셸 명령 실행(!`command` 구문, MCP 기술은 이 단계 건너뛰기) │ ▼ ContentBlockParam[] 반환

**그림 22-1: 스킬 프롬프트 변수 대체 흐름**

보안 경계는 374행에 명시되어 있습니다.

``` typescript
// skills/loadSkillsDir.ts:372-376
// Security: MCP skills are remote and untrusted — never execute inline
// shell commands (!`…` / ```! … ```) from their markdown body.
if (loadedFrom !== 'mcp') {
  finalContent = await executeShellCommandsInPrompt(...)
}
```

MCP 소스 기술은 **신뢰할 수 없음**으로 처리됩니다. Markdown의 `!command` 구문은 실행되지 않습니다. 이는 임의 명령 실행으로 이어지는 원격 프롬프트 삽입에 대한 주요 방어 수단입니다.

### <a href="#deduplication-mechanism" class="header">중복 제거 메커니즘</a>

로드 후 중복 항목을 감지하기 위해 `realpath`를 통해 기호 링크가 확인됩니다.

``` typescript
// skills/loadSkillsDir.ts:728-734
const fileIds = await Promise.all(
  allSkillsWithPaths.map(({ skill, filePath }) =>
    skill.type === 'prompt'
      ? getFileIdentity(filePath)
      : Promise.resolve(null),
  ),
)
```

소스 주석(107-117행)에서는 inode 대신 `realpath`가 사용되는 이유를 구체적으로 언급합니다. 일부 가상 파일 시스템, 컨테이너 환경 또는 NFS 마운트는 신뢰할 수 없는 inode 값(예: inode 0 또는 ExFAT의 정밀도 손실)을 보고합니다.

------------------------------------------------------------------------

## <a href="#224-conditional-skills-path-filtering-and-dynamic-activation"
class="header">22.4 조건부 기술: 경로 필터링 및 동적 활성화</a>

### <a href="#paths-frontmatter" class="header">경로 서문</a>

스킬은 사용자가 특정 경로의 파일에 대해 작업할 때만 활성화된다는 `paths` 프론트매터를 통해 선언할 수 있습니다.

``` yaml
---
paths: src/components/**, src/hooks/**
---
```

`getSkillDirCommands`(771-790행)에서 `paths`가 포함된 스킬은 스킬 목록에 즉시 표시되지 않습니다.

``` typescript
// skills/loadSkillsDir.ts:771-790
const unconditionalSkills: Command[] = []
const newConditionalSkills: Command[] = []
for (const skill of deduplicatedSkills) {
  if (
    skill.type === 'prompt' &&
    skill.paths &&
    skill.paths.length > 0 &&
    !activatedConditionalSkillNames.has(skill.name)
  ) {
    newConditionalSkills.push(skill)
  } else {
    unconditionalSkills.push(skill)
  }
}
for (const skill of newConditionalSkills) {
  conditionalSkills.set(skill.name, skill)
}
```

조건부 스킬은 `conditionalSkills` 맵에 저장되어 **파일 작업으로 인한 활성화**를 기다리고 있습니다. 사용자가 읽기/쓰기/편집 도구를 통해 경로와 일치하는 파일에 대해 작업할 때 `activateConditionalSkillsForPaths` 함수(1001-1033행)는 gitignore 스타일 경로 일치를 위해 `ignore` 라이브러리를 사용하여 일치하는 기술을 보류 중인 맵에서 활성 세트로 이동합니다.

``` typescript
// skills/loadSkillsDir.ts:1007-1033
for (const [name, skill] of conditionalSkills) {
  // ... path matching logic ...
  conditionalSkills.delete(name)
  activatedConditionalSkillNames.add(name)
}
```

활성화되면 스킬 이름이 `activatedConditionalSkillNames`에 기록됩니다. 캐시가 지워지면 이 세트는 **재설정되지 않습니다**(`clearSkillCaches`는 활성화 상태가 아닌 로딩 캐시만 지웁니다). 따라서 "파일을 터치하면 해당 스킬은 전체 세션 동안 계속 사용할 수 있습니다"라는 의미가 보장됩니다.

### <a href="#dynamic-directory-discovery" class="header">동적 디렉터리 검색</a>

조건부 기술 외에도 `discoverSkillDirsForPaths` 함수(861-915행)는 **하위 디렉터리 수준 기술 검색**도 구현합니다. 사용자가 깊이 중첩된 파일을 작업할 때 시스템은 파일 디렉터리에서 cwd로 이동하여 각 수준에서 `.claude/skills/` 디렉터리가 존재하는지 확인합니다. 이를 통해 모노레포의 각 패키지가 고유한 기술 세트를 가질 수 있습니다.

검색 프로세스에는 두 가지 안전 확인이 있습니다.

1. **gitignore check**: `node_modules/pkg/.claude/skills/`와 같은 경로는 건너뜁니다.
2. **중복 확인**: 이미 확인된 경로는 `dynamicSkillDirs` 세트에 기록되어 존재하지 않는 디렉토리에 대한 반복적인 `stat()` 호출을 방지합니다.

------------------------------------------------------------------------

## <a href="#225-mcp-skill-bridging-mcpskillbuildersts" class="header">22.5 MCP 스킬 브리징: mcpSkillBuilders.ts</a>

### <a href="#circular-dependency-problem" class="header">순환 종속성 문제</a>

MCP 기술(MCP 서버 연결을 통해 주입된 기술)은 순환 종속성이라는 고전적인 엔지니어링 문제에 직면합니다. MCP 기술을 로드하려면 `loadSkillsDir.ts`의 `createSkillCommand` 및 `parseSkillFrontmatterFields` 기능이 필요하지만 `loadSkillsDir.ts`의 가져오기 체인은 궁극적으로 MCP 클라이언트 코드에 도달하여 순환을 형성합니다.

`mcpSkillBuilders.ts`는 **일회성 등록 패턴**을 통해 이 주기를 중단합니다.

``` typescript
// skills/mcpSkillBuilders.ts:26-44
export type MCPSkillBuilders = {
  createSkillCommand: typeof createSkillCommand
  parseSkillFrontmatterFields: typeof parseSkillFrontmatterFields
}

let builders: MCPSkillBuilders | null = null

export function registerMCPSkillBuilders(b: MCPSkillBuilders): void {
  builders = b
}

export function getMCPSkillBuilders(): MCPSkillBuilders {
  if (!builders) {
    throw new Error(
      'MCP skill builders not registered — loadSkillsDir.ts has not been evaluated yet',
    )
  }
  return builders
}
```

소스 주석(9-23행)에서는 동적 `import()`를 사용할 수 없는 이유를 자세히 설명합니다. Bun의 bunfs 가상 파일 시스템은 모듈 경로 확인 실패를 일으키고, bunfs에서 작업하는 동안 리터럴 동적 가져오기는 dependency-cruiser가 새로운 주기 위반을 감지하게 만듭니다.

등록은 `loadSkillsDir.ts`의 모듈 초기화 중에 발생합니다. `commands.ts`의 정적 가져오기 체인을 통해 이 코드는 MCP 서버가 연결을 설정하기 훨씬 전에 시작 초기에 실행됩니다.

------------------------------------------------------------------------

## <a href="#226-skill-search-experimental_skill_search"
class="header">22.6 스킬 검색: EXPERIMENTAL_SKILL_SEARCH</a>

### <a href="#remote-skill-discovery" class="header">원격 기술 검색</a>

`SkillTool.ts` 라인 108-116에서 `EXPERIMENTAL_SKILL_SEARCH` 플래그는 원격 기술 검색 모듈 로드를 게이트합니다.

``` typescript
// tools/SkillTool/SkillTool.ts:108-116
const remoteSkillModules = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? {
      ...(require('../../services/skillSearch/remoteSkillState.js') as ...),
      ...(require('../../services/skillSearch/remoteSkillLoader.js') as ...),
      ...(require('../../services/skillSearch/telemetry.js') as ...),
      ...(require('../../services/skillSearch/featureCheck.js') as ...),
    }
  : null
```

원격 기술은 `_canonical_<slug>` 명명 접두사를 사용합니다. -- `validateInput`(378-396행)에서 이러한 기술은 직접 조회를 위해 로컬 명령 레지스트리를 우회합니다.

``` typescript
// tools/SkillTool/SkillTool.ts:381-395
const slug = remoteSkillModules!.stripCanonicalPrefix(normalizedCommandName)
if (slug !== null) {
  const meta = remoteSkillModules!.getDiscoveredRemoteSkill(slug)
  if (!meta) {
    return {
      result: false,
      message: `Remote skill ${slug} was not discovered in this session.`,
      errorCode: 6,
    }
  }
  return { result: true }
}
```

원격 기술은 AKI/GCS(로컬 캐싱 사용)에서 SKILL.md 콘텐츠를 로드하고, 실행 중에는 셸 명령 대체 또는 인수 보간을 수행하지 **않습니다**. 이는 선언적이고 순수한 Markdown으로 처리됩니다.

권한 수준에서 원격 기술은 자동 승인을 받지만(488-504행) 이 승인은 거부 규칙 확인 **후**에 적용됩니다. 즉, 사용자가 구성한 `Skill(_canonical_:*) deny` 규칙은 계속 적용됩니다.

------------------------------------------------------------------------

## <a
href="#227-skill-budget-constraints-1-context-window-and-three-level-truncation"
class="header">22.7 기술 예산 제약: 1% 컨텍스트 창 및 3단계 절단</a>

### <a href="#budget-calculation" class="header">예산 계산</a>

컨텍스트 창에서 차지하는 공간 스킬 목록은 엄격하게 제어됩니다. 핵심 상수는 `tools/SkillTool/prompt.ts`에 정의되어 있습니다.

``` typescript
// tools/SkillTool/prompt.ts:21-29
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01  // 1% of context window
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000  // Fallback: 1% of 200k × 4
export const MAX_LISTING_DESC_CHARS = 250  // Per-entry hard cap
```

예산 공식: `contextWindowTokens x 4 x 0.01`. 200K 토큰 컨텍스트 창의 경우 이는 8,000자를 의미하며 대략 40개의 기술 이름과 설명입니다.

### <a href="#three-level-truncation-cascade" class="header">3단계 절단 캐스케이드</a>

기술 목록이 예산을 초과하면 `formatCommandsWithinBudget` 함수(70-171행)가 3단계 절단 계단식을 실행합니다.

┌──────────────────────────────────────────────┐ │ Level 1: 전체 설명 │ │ "- 배치: 대규모로 연구 및 계획 │ │ 변경 후 병행 실행..." │ │ │ │ 전체 크기 ≤ 예산 → 출력 │ └─────────────────────┬───────────────────────┘ │ 초과 ▼ ┌────────────────────────────────────────┐ │ 수준 2: 잘린 설명 │ │ 내장 스킬은 전체 설명을 유지합니다(절단 안함)│ │ maxDescLen으로 잘린 내장되지 않은 설명 │ │ maxDescLen = (남은 예산 - 이름 │ │ 오버헤드) / 스킬 개수 │ │ │ │ maxDescLen ≥ 20 → 출력 │ └────────────────────┬────────────────────────┘ │ maxDescLen < 20
                          ▼
    ┌──────────────────────────────────────────────┐
    │          Level 3: Names only                  │
    │   Built-in skills keep full descriptions      │
    │   Non-built-in skills show name only          │
    │   "- my-custom-skill"                         │
    └──────────────────────────────────────────────┘

**Figure 22-2: Three-level truncation cascade strategy**

The key insight in this design is **built-in skills are never
truncated** (lines 93-99). The reason is that built-in skills are
validated core functionality -- their PHXCODE00159PHX descriptions are
critical for the model's matching decisions. User-defined skills, once
truncated, can still access detailed content through the PHXCODE00160PHX's
full loading mechanism at invocation time -- the listing is only for
**discovery**, not for **execution**.

Each skill entry is also subject to the PHXCODE00161PHX
hard cap -- even in Level 1 mode, overly long PHXCODE00162PHX strings are
truncated to 250 characters. The source comment explains:

> 목록은 검색용입니다. 스킬 도구는 호출 시 전체 콘텐츠를 > 로드하므로 자세한 whenToUse 문자열은 일치율을 향상시키지 않고 턴 1 캐시_생성 > 토큰을 낭비합니다.

------------------------------------------------------------------------

## <a href="#228-skill-lifecycle-from-registration-to-improvement"
class="header">22.8 기술 수명주기: 등록부터 개선까지</a>

### <a href="#complete-lifecycle-flow" class="header">전체 수명 주기 흐름</a>

``` mermaid
flowchart TD
    REG["Register\nBuilt-in/User/MCP"] --> DISC["Discover\nsystem-reminder listing"]
    DISC --> INV["Invoke\nSkillTool.call()"]
    INV --> EXEC["Execute\ninline or fork"]
    EXEC --> IMPROVE{"Post-sampling hook\nSKILL_IMPROVEMENT\nTriggers every 5 turns"}
    IMPROVE -->|Preference detected| DETECT["Detect user preferences/corrections\nGenerate SkillUpdate[]"]
    IMPROVE -->|No change| DONE["Continue conversation"]
    DETECT --> REWRITE["Side-channel LLM\nRewrite SKILL.md"]
    REWRITE --> CHANGE["File change detection\nchokidar watcher"]
    CHANGE --> RELOAD["Reload\nClear caches"]
    RELOAD --> DISC

    style REG fill:#e1f5fe
    style EXEC fill:#e8f5e9
    style IMPROVE fill:#fff3e0
    style REWRITE fill:#fce4ec
```

**그림 22-3: 전체 기술 수명주기 흐름**

### <a href="#phase-one-registration" class="header">1단계: 등록</a>

- **내장 기술**: `initBundledSkills()`는 시작 시 동시에 등록됩니다.
- **사용자 기술**: `getSkillDirCommands()`는 `memoize`를 통해 첫 번째 로드 결과를 캐시합니다.
- **MCP 스킬**: MCP 서버 연결 후 `getMCPSkillBuilders()`를 통해 등록됨

### <a href="#phase-two-discovery" class="header">2단계: 발견</a>

기술은 두 가지 메커니즘을 통해 모델에 의해 발견됩니다.

1. **시스템 알림 목록**: 로드된 모든 기술의 이름과 설명이 `<system-reminder>` 태그에 삽입됩니다.
2. **스킬 도구 설명**: `SkillTool.prompt`에는 호출 지침이 포함되어 있습니다.

### <a href="#phase-three-invocation-and-execution" class="header">3단계: 호출 및 실행</a>

`SkillTool.call` 메소드(580-841행)는 622행의 핵심 분기를 사용하여 호출 논리를 처리합니다.

``` typescript
// tools/SkillTool/SkillTool.ts:621-632
if (command?.type === 'prompt' && command.context === 'fork') {
  return executeForkedSkill(...)
}
// ... inline execution path ...
```

- **인라인 모드**: 기술 프롬프트가 기본 대화의 메시지 스트림에 삽입됩니다. 모델은 동일한 컨텍스트에서 실행됩니다.
- **포크 모드**: 격리된 컨텍스트에서 하위 에이전트를 시작합니다. 완료 시 결과 요약을 반환합니다.

인라인 모드는 `contextModifier`를 통해 도구 인증 및 모델 재정의 주입을 구현합니다. 이는 전역 상태를 수정하지 않지만 `getAppState()` 기능을 체인 래핑합니다.

### <a href="#phase-four-improvement-skill_improvement" class="header">4단계: 개선(SKILL_IMPROVEMENT)</a>

`skillImprovement.ts`는 기술 실행 중에 사용자 기본 설정 및 수정 사항을 자동으로 감지하는 샘플링 후 후크를 구현합니다. 이 기능은 이중 게이팅으로 보호됩니다.

``` typescript
// utils/hooks/skillImprovement.ts:176-181
export function initSkillImprovement(): void {
  if (
    feature('SKILL_IMPROVEMENT') &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_copper_panda', false)
  ) {
    registerPostSamplingHook(createSkillImprovementHook())
  }
}
```

`feature('SKILL_IMPROVEMENT')`는 빌드 타임 게이팅(`ant` 빌드에만 이 코드가 포함됨)이고, `tengu_copper_panda`는 런타임 GrowthBook 플래그입니다. 이중 게이팅은 내부 빌드에서도 이 기능을 원격으로 비활성화할 수 있음을 의미합니다.

**트리거 조건**: 현재 세션에서 **프로젝트 수준 기술**(`projectSettings:` 접두사)이 호출된 경우에만 실행됩니다(`findProjectSkill()` 확인). 5개의 사용자 메시지마다 분석을 트리거합니다(`TURN_BATCH_SIZE = 5`):

``` typescript
// utils/hooks/skillImprovement.ts:84-87
const userCount = count(context.messages, m => m.type === 'user')
if (userCount - lastAnalyzedCount < TURN_BATCH_SIZE) {
  return false
}
```

**탐지 프롬프트**: 분석기는 세 가지 유형의 신호, 즉 단계 추가/수정/삭제 요청("X도 물어보실 수 있나요?"), 선호 표현("캐주얼한 어조 사용") 및 수정("아니요, 대신 X를 하세요")을 찾습니다. 이미 스킬에 포함된 일회성 대화와 동작을 명시적으로 무시합니다.

**2단계 처리**:

1. **탐지 단계**: 최근 대화 조각(전체 기록이 아닌 마지막 확인 이후의 새 메시지만)을 작고 빠른 모델(`getSmallFastModel()`)로 보내고 AppState에 저장된 `SkillUpdate[]` 배열을 출력합니다.
2. **응용 단계**: `applySkillImprovement`(188행 이후)는 **독립적인 부채널 LLM 호출**을 통해 `.claude/skills/<name>/SKILL.md`를 다시 작성합니다. 결정적 출력을 위해 `temperatureOverride: 0`를 사용하고 "머리말을 있는 그대로 유지하고 명시적으로 교체하지 않는 한 기존 콘텐츠를 삭제하지 마십시오"라고 명시적으로 지시합니다.

전체 프로세스는 주요 대화를 차단하지 않고 실행 후 잊어버립니다. 재작성으로 인한 파일 변경 사항은 Phase Five의 파일 감시자에 의해 감지되고 핫 리로드를 트리거합니다.

**skillify와의 보완 관계**: Skillify(섹션 22.2)는 처음부터 기술을 생성합니다. 워크플로를 완료한 후 사용자는 수동으로 `/skillify`를 호출하고 4번의 인터뷰 라운드를 통해 SKILL.md를 생성합니다. SKILL_IMPROVEMENT는 사용 중에 지속적으로 개선되어 각 스킬 실행 시 기본 설정 변경을 자동으로 감지하고 정의를 업데이트합니다. 이들은 함께 "생성 -\> 개선" 수명 주기 루프를 형성합니다.

### <a href="#phase-five-change-detection-and-reload" class="header">5단계: 변경 감지 및 다시 로드</a>

`skillChangeDetector.ts`는 Chokidar 파일 감시자를 사용하여 스킬 파일 변경 사항을 감지합니다.

``` typescript
// utils/skills/skillChangeDetector.ts:27-28
const FILE_STABILITY_THRESHOLD_MS = 1000
const FILE_STABILITY_POLL_INTERVAL_MS = 500
```

변경 사항이 감지되면:

1. 1초 파일 안정성 임계값을 기다립니다.
2. 300ms 디바운스 창 내에서 여러 변경 이벤트를 집계합니다.
3. 스킬 캐시 및 명령 캐시 지우기
4. `skillsChanged` 신호를 통해 모든 가입자에게 알립니다.

특히 주목할 만한 점은 라인 62의 플랫폼 적용입니다.

``` typescript
// utils/skills/skillChangeDetector.ts:62
const USE_POLLING = typeof Bun !== 'undefined'
```

Bun의 기본 `fs.watch()`에는 `PathWatcherManager` 교착 상태 문제(oven-sh/bun#27469)가 있습니다. 파일 감시 스레드가 이벤트를 전달할 때 감시자를 닫으면 두 스레드가 모두 `__ulock_wait2`에서 영원히 정지됩니다. 소스는 임시 솔루션으로 stat() 폴링을 선택하여 업스트림 수정 제거 계획에 주석을 달았습니다.

------------------------------------------------------------------------

## <a href="#229-skill-tool-permission-model" class="header">22.9 스킬 도구 권한 모델</a>

### <a href="#auto-authorization-conditions"
class="header">자동 승인 조건</a>

모든 기술 호출에 사용자 확인이 필요한 것은 아닙니다. `SkillTool.checkPermissions`(529-538행)에서는 `skillHasOnlySafeProperties` 조건을 충족하는 기술이 자동으로 인증됩니다.

``` typescript
// tools/SkillTool/SkillTool.ts:875-908
const SAFE_SKILL_PROPERTIES = new Set([
  'type', 'progressMessage', 'contentLength', 'model', 'effort',
  'source', 'name', 'description', 'isEnabled', 'isHidden',
  'aliases', 'argumentHint', 'whenToUse', 'paths', 'version',
  'disableModelInvocation', 'userInvocable', 'loadedFrom',
  // ...
])
```

이는 **허용 목록 패턴**입니다. 허용 목록에 있는 속성을 선언하는 기술만 자동 인증됩니다. 나중에 `PromptCommand` 유형에 새 속성이 추가되면 허용 목록에 명시적으로 추가될 때까지 기본적으로 **권한 필요**로 설정됩니다. `allowedTools`, `hooks` 등과 같은 민감한 필드가 포함된 기술은 사용자 확인 대화 상자를 트리거합니다.

### <a href="#permission-rule-matching" class="header">권한 규칙 일치</a>

권한 확인은 정확한 일치 및 접두사 와일드카드를 지원합니다.

``` typescript
// tools/SkillTool/SkillTool.ts:451-467
const ruleMatches = (ruleContent: string): boolean => {
  const normalizedRule = ruleContent.startsWith('/')
    ? ruleContent.substring(1)
    : ruleContent
  if (normalizedRule === commandName) return true
  if (normalizedRule.endsWith(':*')) {
    const prefix = normalizedRule.slice(0, -2)
    return commandName.startsWith(prefix)
  }
  return false
}
```

이는 사용자가 `Skill(review:*) allow`를 구성하여 `review`로 시작하는 모든 기술을 한 번에 인증할 수 있음을 의미합니다.

------------------------------------------------------------------------

## <a href="#pattern-distillation" class="header">패턴 증류</a>

스킬 시스템 설계에서 추출된 재사용 가능한 패턴:

**패턴 1: 메모된 약속 패턴**

- **문제 해결**: 여러 동시 호출자가 동시에 첫 번째 초기화를 트리거하는 경합 상태
- **패턴**: `extractionPromise ??= extractBundledSkillFiles(...)` -- `??=`를 사용하면 Promise가 하나만 생성되고 모든 호출자는 동일한 결과를 기다립니다.
- **전제 조건**: 초기화 작업이 멱등성이고 결과를 재사용할 수 있습니다.

**패턴 2: 허용 목록 보안 모델**

- **문제 해결됨**: 새 속성은 기본적으로 안전합니다. 알 수 없는 속성에는 권한이 필요합니다.
- **패턴**: `SAFE_SKILL_PROPERTIES` 허용 목록에는 알려진 안전 필드만 포함됩니다. 새 필드는 자동으로 "권한 필요" 경로를 입력합니다.
- **전제 조건**: 속성 세트는 시간이 지남에 따라 증가하고 안전에는 보수적인 기본값이 필요합니다.

**패턴 3: 계층화된 신뢰 및 기능 저하**

- **문제 해결**: 다양한 소스의 확장 프로그램은 신뢰 수준이 다릅니다.
- **패턴**: 내장 기술(잘리지 않음) \> 사용자 로컬 기술(잘림 가능, 셸 실행 가능) \> MCP 원격 기술(셸 금지, 자동 인증은 거부 규칙에 따라 다름)
- **전제 조건**: 시스템은 여러 신뢰 도메인의 입력을 수락합니다.

**패턴 4: 예산을 고려한 점진적 성능 저하**

- **문제 해결**: 제한된 리소스에서 가변 개수의 항목 표시(컨텍스트 창)
- **패턴**: 3단계 잘림 계단식(전체 설명 -\> 잘린 설명 -\> 이름만), 우선순위가 높은 항목은 잘리지 않음
- **전제 조건**: 항목 수를 예측할 수 없으며 리소스 예산이 고정되어 있습니다.

------------------------------------------------------------------------

## <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

**맞춤형 기술을 만들고 사용하여 생산성을 높이세요.**

1. **자신만의 기술을 만드세요.** `.claude/skills/my-skill/SKILL.md`에 마크다운 파일을 작성하고, YAML 머리말(설명, 허용되는 도구, 실행 컨텍스트 등)을 통해 메타데이터를 선언하고, `/my-skill` 또는 자동 모델 호출을 통해 사용하세요.

2. **조건부 활성화를 위해 `paths` 앞부분을 사용하세요.** 특정 디렉터리(예: `paths: src/components/**`)에서 작업할 때만 기술이 필요한 경우 모든 대화에 표시되지 않지만 일치하는 파일을 작업할 때 자동으로 활성화되어 귀중한 컨텍스트 창 공간을 절약합니다.

3. **`/skillify`를 사용하여 세션을 스킬로 캡처합니다.** 대화에서 효과적인 워크플로우를 구축한 경우 `/skillify`는 이를 재사용 가능한 스킬 파일로 자동 변환할 수 있습니다.

4. **1% 예산 한도를 이해하세요.** 스킬 목록은 컨텍스트 창(최대 8000자)의 1%만 차지합니다. 이를 초과하면 잘림이 발생합니다. `whenToUse` 설명을 간결하게 유지하면 제한된 예산 내에서 더 많은 기술을 표시하는 데 도움이 됩니다.

5. **권한 접두사 와일드카드를 사용하세요.** `Skill(my-prefix:*) allow`를 구성하면 `my-prefix`로 시작하는 모든 기술이 한 번에 인증되어 확인 대화 상자 중단이 줄어듭니다.

6. **MCP 스킬 보안 제한 사항에 유의하세요.** 원격 MCP 스킬의 셸 명령 구문(`!command`)은 실행되지 않습니다. 이는 원격 프롬프트 삽입에 대한 보안 방어입니다. 스킬이 셸 명령을 실행해야 하는 경우 로컬 스킬을 사용하세요.

------------------------------------------------------------------------

## <a href="#2210-summary" class="header">22.10 요약</a>

스킬 시스템은 **모범 사례 지식**을 실행 가능한 워크플로로 인코딩하기 위한 Claude Code의 핵심 메커니즘입니다. 그 디자인은 몇 가지 주요 원칙을 따릅니다.

1. **코드로 표시되는 프롬프트**: 스킬은 기존 플러그인 API가 아닙니다. LLM이 해석하고 실행하는 마크다운 텍스트입니다. 이로 인해 기술을 만들고 반복하는 데 대한 장벽이 매우 낮아집니다.

2. **계층화된 신뢰**: 기본 제공 기술은 절대 잘리지 않으며, MCP 기술은 셸 실행을 금지하고, 원격 기술은 자동 승인을 받지만 거부 규칙의 적용을 받습니다. 각 소스는 서로 다른 신뢰 수준을 갖습니다.

3. **자체 개선**: `SKILL_IMPROVEMENT` 메커니즘을 사용하면 사용 중 사용자 피드백을 기반으로 기술이 자동으로 발전할 수 있습니다. 즉, 폐쇄형 "사용을 통한 학습" 루프입니다.

4. **예산 인식**: 1% 컨텍스트 창 하드 예산 및 3단계 절단 계단식은 기술 발견이 실제 작업의 컨텍스트 공간을 압도하지 않도록 보장합니다.

다음 장에서는 소스 코드의 89 기능 플래그 뒤에 있는 미공개 기능 파이프라인을 통해 시스템의 진화 방향을 엿보는 등 다른 각도에서 Claude Code의 확장성을 살펴보겠습니다.

------------------------------------------------------------------------

## <a href="#version-evolution-v2191-changes" class="header">버전 진화: v2.1.91 변경 사항</a>

> 다음 분석은 v2.1.91 번들 신호 비교를 기반으로 합니다.

v2.1.91에는 `tengu_bridge_client_presence_enabled` 이벤트 및 `CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL` 환경 변수가 추가되었습니다. 전자는 IDE 브리징 프로토콜에 클라이언트 존재 감지 기능이 추가되었음을 나타냅니다. 후자는 내장된 Claude API 기술을 비활성화하는 런타임 스위치를 제공합니다. 이는 특정 기술 가용성을 제한하기 위해 기업 규정 준수 시나리오에서 잠재적으로 사용됩니다.
