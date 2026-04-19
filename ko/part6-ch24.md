# <a
href="#chapter-24-cross-session-memory----from-forgetfulness-to-persistent-learning"
class="header">24장 교차 세션 기억 - 건망증에서 지속적인 학습까지</a>

> **포지셔닝**: 이 장에서는 원시 신호 캡처부터 구조화된 지식 증류까지 완전한 시스템인 Claude Code의 6계층 교차 세션 메모리 아키텍처를 분석합니다. 전제 조건: 5장. 대상 독자: CC가 망각에서 지속적인 학습으로 발전하는 교차 세션 메모리 시스템을 구현하는 방법을 이해하려는 독자.

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

메모리가 없는 AI 에이전트는 본질적으로 상태 비저장 기능입니다. 각 호출은 사용자가 누구인지, 지난번에 무엇을 했는지, 어떤 결정이 이미 내려졌는지 알 수 없는 상태에서 0부터 시작됩니다. 사용자는 모든 새 세션에서 동일한 컨텍스트를 반복해야 합니다. "저는 백엔드 엔지니어입니다." "이 프로젝트는 Bun을 사용하여 빌드됩니다." "테스트에서 데이터베이스를 조롱하지 마세요." 이러한 반복은 시간을 낭비하고, 더 중요하게는 인간-기계 협업의 연속성을 파괴합니다.

Claude Code의 대답은 원시 신호 캡처부터 구조화된 지식 추출, 세션 내 요약부터 세션 간 지속성에 이르기까지 완전한 "학습 능력"을 구축하는 **6계층 메모리 아키텍처**입니다. 이 6개 하위 시스템에는 명확한 업무 구분이 있습니다.

<div class="table-wrapper">

| 서브시스템 | 코어 파일 | 빈도 | 책임 |
|----|----|----|----|
| 멤디르 | `memdir/memdir.ts` | 모든 세션 로드 | MEMORY.md 인덱스 + 주제 파일, 시스템 프롬프트에 삽입됨 |
| 기억 추출 | `services/extractMemories/extractMemories.ts` | 매 턴 종료 | 포크 에이전트는 메모리를 자동 추출합니다. |
| 세션 메모리 | `services/SessionMemory/sessionMemory.ts` | 주기적 트리거 | 압축에 사용되는 롤링 세션 요약 |
| 성적 지속성 | `utils/sessionStorage.ts` | 모든 메시지 | JSONL 세션 기록 저장 및 복구 |
| 에이전트 메모리 | `tools/AgentTool/agentMemory.ts` | 에이전트 수명주기 | 하위 에이전트 지속성 + VCS 스냅샷 |
| 자동 꿈 | `services/autoDream/autoDream.ts` | 일일 | 야간 기억 통합 및 정리 |

</div>

이러한 하위 시스템은 이전 장에서 전달하면서 언급되었습니다. 9장에서는 자동 압축을 소개했고, 10장에서는 압축 후 파일 상태 보존에 대해 논의했으며, 19장에서는 CLAUDE.md 로딩을 분석했고, 20장에서는 포크 에이전트 모드를 다루고, 23장에서는 KAIROS 및 TEAMMEM 기능 플래그를 언급했습니다. 그러나 완전한 시스템으로서의 메모리의 **생성, 수명 주기 및 세션 간 지속성**은 완전히 분석된 적이 없습니다. 이 장은 그 격차를 메워줍니다.

## <a href="#source-code-analysis" class="header">소스 코드 분석</a>

### <a href="#241-memdir-architecture-memorymd-index-and-topic-files"
class="header">24.1 Memdir 아키텍처: MEMORY.md 인덱스 및 주제 파일</a>

Memdir은 전체 메모리 시스템의 저장 계층입니다. 모든 메모리는 궁극적으로 이 디렉터리 구조에 파일로 저장됩니다.

#### <a href="#path-resolution" class="header">경로 확인</a>

메모리 디렉토리 위치는 3단계 우선 순위 체인에 따라 `paths.ts`의 `getAutoMemPath()`에 의해 결정됩니다.

``` typescript
// restored-src/src/memdir/paths.ts:223-235
export const getAutoMemPath = memoize(
  (): string => {
    const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
    if (override) {
      return override
    }
    const projectsDir = join(getMemoryBaseDir(), 'projects')
    return (
      join(projectsDir, sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME) + sep
    ).normalize('NFC')
  },
  () => getProjectRoot(),
)
```

해결 순서:

1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 환경 변수(Cowork 공간 수준 마운트)
2. `autoMemoryDirectory` 설정(신뢰할 수 있는 소스로만 제한됨: 정책/플래그/로컬/사용자 설정, 악성 저장소가 쓰기 경로를 리디렉션하지 못하도록 **제외** projectSettings)
3. 기본 경로: `~/.claude/projects/<sanitized-git-root>/memory/`

특히 `getAutoMemBase()`는 `getProjectRoot()` 대신 `findCanonicalGitRoot()`를 사용합니다. 이는 동일한 저장소의 모든 작업 트리가 하나의 메모리 디렉터리를 공유한다는 의미입니다. 이는 의도적인 디자인 결정입니다. 메모리는 작업 디렉터리가 아니라 프로젝트에 관한 것입니다.

#### <a href="#index-and-truncation" class="header">색인 및 잘림</a>

`MEMORY.md`는 메모리 시스템의 진입점입니다. 즉, 각 줄이 주제 파일을 가리키는 인덱스 파일입니다. 시스템은 각 세션 시작 시 이를 시스템 프롬프트에 삽입합니다. 인덱스 팽창으로 인해 귀중한 컨텍스트 공간이 소모되는 것을 방지하기 위해 `memdir.ts`는 이중 잘림을 적용합니다.

``` typescript
// restored-src/src/memdir/memdir.ts:34-38
export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000
```

잘림 논리는 계단식으로 이루어집니다. 먼저 라인(200라인, 자연 경계)별로, 그 다음에는 바이트 확인(25KB)으로 이루어집니다. 바이트 잘림이 중간 줄을 잘라야 하는 경우 마지막 줄 바꿈으로 돌아갑니다. 이 "줄 먼저, 그 다음 바이트" 전략은 경험 중심입니다. 의견에 따르면 p97 콘텐츠 길이는 제한 내에 있지만 p100에서는 여전히 200줄 내에서 197KB가 관찰되어 인덱스 파일에 매우 긴 줄이 있음을 나타냅니다.

`truncateEntrypointContent()`(`memdir.ts:57-103`)는 계단식 잘림 후에 경고 메시지를 추가하여 모델에 인덱스가 잘렸음을 알리고 자세한 내용을 주제 파일로 이동할 것을 제안합니다(잘림 기능에 대한 전체 분석은 19장에 있습니다). 이는 영리한 자가 치유 메커니즘입니다. 모델은 다음에 메모리를 구성하고 그에 따라 행동할 때 이 경고를 보게 됩니다.

#### <a href="#topic-file-format" class="header">주제 파일 형식</a>

각 메모리는 YAML 앞부분이 포함된 독립적인 Markdown 파일로 저장됩니다.

``` markdown
---
name: Memory name
description: One-line description (used to judge relevance)
type: user | feedback | project | reference
---

Memory content...
```

네 가지 유형이 폐쇄형 분류 시스템을 형성합니다.

- **사용자**: 사용자 역할, 기본 설정, 지식 수준
- **피드백**: 에이전트 행동에 대한 사용자 수정 및 지침
- **프로젝트**: 진행 중인 작업, 목표, 마감일
- **참조**: 외부 시스템에 대한 포인터(선형 프로젝트, Grafana 대시보드)

`memoryScan.ts`의 스캐너는 각 파일의 처음 30줄만 읽어서 머리말을 구문 분석하므로 메모리 파일이 많아 과도한 IO를 방지합니다.

``` typescript
// restored-src/src/memdir/memoryScan.ts:21-22
const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30
```

검사 결과는 수정 시간을 기준으로 내림차순으로 정렬되며 최대 200개의 파일을 보관합니다. 이는 업데이트되지 않은 가장 긴 메모리가 자연스럽게 단계적으로 제거됨을 의미합니다.

#### <a href="#kairos-log-mode" class="header">카이로스 로그 모드</a>

KAIROS(장기 실행 보조 모드)가 활성화되면 메모리 쓰기 전략이 "토픽 파일 + MEMORY.md 직접 업데이트"에서 "일일 로그 파일에 추가"로 전환됩니다.

``` typescript
// restored-src/src/memdir/paths.ts:246-251
export function getAutoMemDailyLogPath(date: Date = new Date()): string {
  const yyyy = date.getFullYear().toString()
  const mm = (date.getMonth() + 1).toString().padStart(2, '0')
  const dd = date.getDate().toString().padStart(2, '0')
  return join(getAutoMemPath(), 'logs', yyyy, mm, `${yyyy}-${mm}-${dd}.md`)
}
```

경로 형식: `memory/logs/YYYY/MM/YYYY-MM-DD.md`. 이 추가 전용 전략은 긴 세션 동안 동일한 파일에 대한 빈번한 재작성을 방지합니다. 증류는 야간 Auto-Dream 처리에 맡겨집니다.

### <a href="#242-extract-memories-automatic-memory-extraction"
class="header">24.2 메모리 추출: 자동 메모리 추출</a>

메모리 추출은 메모리 시스템의 "인식 계층"입니다. 각 쿼리 턴이 끝날 때 포크 에이전트는 대화를 자동으로 분석하고 유지할 가치가 있는 정보를 추출합니다.

#### <a href="#trigger-mechanism" class="header">트리거 메커니즘</a>

쿼리 루프가 끝날 때 `stopHooks.ts`에서 추출이 트리거됩니다(중지 후크에 대한 설명은 4장 참조).

``` typescript
// restored-src/src/query/stopHooks.ts:141-156
if (
  feature('EXTRACT_MEMORIES') &&
  !toolUseContext.agentId &&
  isExtractModeActive()
) {
  void extractMemoriesModule!.executeExtractMemories(
    stopHookContext,
    toolUseContext.appendSystemMessage,
  )
}
if (!toolUseContext.agentId) {
  void executeAutoDream(stopHookContext, toolUseContext.appendSystemMessage)
}
```

두 가지 주요 제약 조건:

1. **주 에이전트만 해당**: `!toolUseContext.agentId`는 하위 에이전트 중지 후크를 제외합니다.
2. **Fire-and-forget**: `void` 접두사는 추출이 다음 쿼리 차례를 차단하지 않고 비동기식으로 실행됨을 의미합니다.

#### <a href="#throttle-mechanism" class="header">스로틀 메커니즘</a>

모든 쿼리 차례가 추출을 트리거하는 것은 아닙니다. `tengu_bramble_lintel` 기능 플래그는 주파수를 제어합니다(기본값 1, 매 턴 실행을 의미).

``` typescript
// restored-src/src/services/extractMemories/extractMemories.ts:377-385
if (!isTrailingRun) {
  turnsSinceLastExtraction++
  if (
    turnsSinceLastExtraction <
    (getFeatureValue_CACHED_MAY_BE_STALE('tengu_bramble_lintel', null) ?? 1)
  ) {
    return
  }
}
turnsSinceLastExtraction = 0
```

#### <a href="#mutual-exclusion-with-main-agent" class="header">주체와의 상호 배제</a>

기본 에이전트 자체가 메모리 파일을 쓸 때(예: 사용자가 명시적으로 "이것을 기억하세요"라고 요청하는 경우) 포크 에이전트는 해당 차례에 추출을 건너뜁니다.

``` typescript
// restored-src/src/services/extractMemories/extractMemories.ts:121-148
function hasMemoryWritesSince(
  messages: Message[],
  sinceUuid: string | undefined,
): boolean {
  // ... checks assistant messages for Edit/Write tool calls targeting autoMemPath
}
```

이렇게 하면 두 에이전트가 동시에 동일한 파일에 쓰는 것을 방지할 수 있습니다. 주 에이전트가 쓸 때 커서는 최신 메시지로 직접 이동하여 해당 메시지가 후속 추출로 인해 중복 처리되지 않도록 합니다.

#### <a href="#permission-isolation" class="header">권한 격리</a>

포크 에이전트의 권한은 엄격하게 제한됩니다.

`createAutoMemCanUseTool()`(`extractMemories.ts:171-222`)는 다음을 구현합니다.

- **허용**: 읽기/Grep/Glob(읽기 전용 도구, 제한 없음)
- **허용**: Bash(`isReadOnly` 전달 명령만 -- `ls`, `find`, `grep`, `cat` 등)
- **허용**: 편집/쓰기(`memoryDir` 내의 경로만, `isAutoMemPath()`를 통해 검증됨)
- **거부**: 기타 모든 도구(MCP, Agent, 쓰기 가능 Bash 등)

이 권한 기능은 Extract Memories와 Auto-Dream 모두에서 공유됩니다(섹션 24.6 참조).

#### <a href="#extraction-prompt" class="header">추출 프롬프트</a>

추출 에이전트의 프롬프트는 효율적인 작업을 명시적으로 지시합니다.

``` typescript
// restored-src/src/services/extractMemories/prompts.ts:39
`You have a limited turn budget. ${FILE_EDIT_TOOL_NAME} requires a prior
${FILE_READ_TOOL_NAME} of the same file, so the efficient strategy is:
turn 1 — issue all ${FILE_READ_TOOL_NAME} calls in parallel for every file
you might update; turn 2 — issue all ${FILE_WRITE_TOOL_NAME}/${FILE_EDIT_TOOL_NAME}
calls in parallel.`
```

또한 조사 행위를 명시적으로 금지합니다. "해당 콘텐츠를 추가로 조사하거나 확인하려는 시도를 낭비하지 마십시오." 이는 포크 에이전트가 기본 대화의 전체 컨텍스트(프롬프트 캐시 포함)를 상속하고 추가 정보 수집이 필요하지 않기 때문입니다. 최대 회전 수는 5(`maxTurns: 5`)로 제한되어 에이전트가 확인 루프에 빠지는 것을 방지합니다.

### <a href="#243-session-memory-rolling-session-summary"
class="header">24.3 세션 메모리: 롤링 세션 요약</a>

세션 메모리는 **세션 중** 정보 보존이라는 다른 문제를 해결합니다. 컨텍스트 창이 포화 상태에 가까워지고 자동 압축이 시작되려고 할 때(9장 참조) 압축기는 어떤 정보가 중요한지 알아야 합니다. 세션 메모리가 이 신호를 제공합니다.

#### <a href="#trigger-conditions" class="header">트리거 조건</a>

세션 메모리는 각 모델 샘플링 후에 실행되는 샘플링 후 후크(`registerPostSamplingHook`)로 등록됩니다. 실제 추출은 세 가지 임계값으로 보호됩니다.

``` typescript
// restored-src/src/services/SessionMemory/sessionMemoryUtils.ts:32-36
export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10000,   // First trigger: 10K tokens
  minimumTokensBetweenUpdate: 5000,    // Update interval: 5K tokens
  toolCallsBetweenUpdates: 3,          // Minimum tool calls: 3
}
```

트리거 로직(`sessionMemory.ts:134-181`)에는 다음이 필요합니다.

1. **초기화 임계값**: 컨텍스트 창이 10,000개 토큰에 도달하면 먼저 트리거됩니다.
2. **업데이트 조건**: 토큰 임계값(5K) **반드시** 충족하고 (a) 도구 호출 횟수 \>= 3 또는 (b) 마지막 보조자 차례에 도구 호출이 없었습니다(자연스러운 대화 중단점).

이는 세션 메모리가 짧은 대화에서 트리거되지 않으며 밀집된 도구 호출 중에 작업 흐름을 방해하지 않는다는 것을 의미합니다.

#### <a href="#summary-template" class="header">요약 템플릿</a>

요약 파일은 고정 섹션 구조(`prompts.ts:11-41`)를 사용합니다.

``` markdown
# Session Title
# Current State
# Task specification
# Files and Functions
# Workflow
# Errors & Corrections
# Codebase and System Documentation
# Learnings
# Key results
# Worklog
```

각 섹션에는 크기 제한(`MAX_SECTION_LENGTH = 2000` 토큰)이 있으며 총 파일은 12,000개 토큰을 초과하지 않습니다(토큰 예산 전략에 대한 논의는 12장 참조). 예산이 초과되면 상담원에게 가장 중요하지 않은 부분을 사전에 압축하라는 메시지가 표시됩니다.

#### <a href="#relationship-with-auto-compaction" class="header">자동 압축과의 관계</a>

세션 메모리의 초기화 게이트 `initSessionMemory()`는 `isAutoCompactEnabled()`를 확인합니다. -- 자동 압축이 비활성화된 경우 세션 메모리도 실행되지 않습니다. 이는 세션 메모리의 주요 소비자가 압축 시스템이기 때문입니다. 요약 파일 `summary.md`는 압축 중에 주입되어 압축기에 "중요한 것"이라는 중요한 신호를 제공합니다(9장 `sessionMemoryCompact.ts` 참조).

#### <a href="#difference-from-extract-memories" class="header">메모리 추출과의 차이점</a>

<div class="table-wrapper">

| 차원 | 세션 메모리 | 기억 추출 |
|----|----|----|
| 지속성 범위 | 세션 내 | 교차 세션 |
| 저장 위치 | `~/.claude/projects/<root>/<session-id>/session-memory/` | `~/.claude/projects/<root>/memory/` |
| 트리거 타이밍 | 토큰 임계값 + 도구 호출 임계값 | 매 턴 종료 |
| 소비자 | 압축 시스템 | 다음 세션의 시스템 프롬프트 |
| 콘텐츠 구조 | 고정 단면 템플릿 | 자유 형식 주제 파일 |

</div>

둘 다 간섭 없이 병렬로 실행됩니다. Session Memory는 "이 세션에서 수행된 작업"에 초점을 맞추고, Extract Memories는 "교차 세션을 유지할 가치가 있는 정보"에 중점을 둡니다.

### <a href="#244-transcript-persistence-jsonl-session-storage"
class="header">24.4 기록 지속성: JSONL 세션 저장소</a>

`sessionStorage.ts`(5,105줄, 소스에서 가장 큰 단일 파일 중 하나)는 지속되는 전체 세션 레코드를 JSONL(JSON Lines) 형식으로 처리합니다.

#### <a href="#storage-format" class="header">저장 형식</a>

각 메시지는 세션 파일에 추가된 하나의 JSON 줄로 직렬화됩니다. 저장 경로: `~/.claude/projects/<root>/<session-id>.jsonl`. 성능을 위해 JSONL이 선택되었습니다. 증분 추가에는 `appendFile`만 필요하며 전체 파일을 구문 분석하고 다시 쓸 필요가 없습니다.

표준 사용자/보조 메시지 외에도 세션 레코드에는 몇 가지 특수 항목 유형이 포함되어 있습니다.

<div class="table-wrapper">

| 출품 유형 | 목적 |
|----|----|
| `file_history_snapshot` | 압축 후 파일 상태를 복원하는 데 사용되는 파일 기록 스냅샷(10장 참조) |
| `attribution_snapshot` | 각 파일 수정의 소스를 기록하는 속성 스냅샷 |
| `context_collapse_snapshot` | 압축 경계 표시, 압축이 발생한 위치와 보존된 메시지 기록 |
| `content_replacement` | REPL 모드에서 출력 잘림에 사용되는 콘텐츠 교체 레코드 |

</div>

#### <a href="#session-resume" class="header">세션 재개</a>

사용자가 `claude --resume`를 통해 세션을 재개하면 `sessionStorage.ts`는 JSONL 파일에서 전체 메시지 체인을 다시 작성합니다. 이력서 프로세스:

1. 모든 JSONL 항목을 구문 분석합니다.
2. `uuid`/`parentUuid`를 기반으로 메시지 트리를 재구성합니다.
3. 압축 경계 마커(`context_collapse_snapshot`)를 적용하여 압축 후 상태로 복원합니다.
4. 파일 기록 스냅샷을 재구축하여 파일 상태에 대한 모델의 이해가 디스크와 일치하도록 보장합니다.

이를 통해 세션 간 "계속"이 가능해집니다. 사용자는 하루가 끝날 때 터미널을 닫고 다음 날 정확히 동일한 대화 컨텍스트를 다시 시작할 수 있습니다.

### <a href="#245-agent-memory-subagent-persistence" class="header">24.5 에이전트 메모리: 하위 에이전트 지속성</a>

하위 에이전트(20장 참조)에는 고유한 메모리 요구 사항이 있습니다. 반복적인 코드 검토 에이전트는 팀 코드 스타일 기본 설정을 기억해야 합니다. 테스트 에이전트는 프로젝트의 테스트 프레임워크 구성을 기억해야 합니다.

#### <a href="#three-scope-model" class="header">3개 범위 모델</a>

`agentMemory.ts`는 세 가지 메모리 범위를 정의합니다.

``` typescript
// restored-src/src/tools/AgentTool/agentMemory.ts:12-13
export type AgentMemoryScope = 'user' | 'project' | 'local'
```

<div class="table-wrapper">

| 범위 | 길 | VCS 커밋 가능 | 목적 |
|----|----|----|----|
| `user` | `~/.claude/agent-memory/<agentType>/` | 아니요 | 프로젝트 간 사용자 수준 기본 설정 |
| `project` | `<cwd>/.claude/agent-memory/<agentType>/` | 예 | 팀 공유 프로젝트 지식 |
| `local` | `<cwd>/.claude/agent-memory-local/<agentType>/` | 아니요 | 기계별 프로젝트 구성 |

</div>

각 범위는 시스템 프롬프트 콘텐츠를 구성하기 위해 Memdir과 정확히 동일한 `buildMemoryPrompt()`를 사용하여 자체 `MEMORY.md` 인덱스 및 항목 파일을 독립적으로 유지 관리합니다.

#### <a href="#vcs-snapshot-sync" class="header">VCS 스냅샷 동기화</a>

`agentMemorySnapshot.ts`는 실질적인 문제를 해결합니다. `project` 범위 메모리는 팀 전체에서 Git을 통해 공유 가능해야 하지만 `.claude/agent-memory/`는 `.gitignore`에 있습니다. 해결책은 별도의 스냅샷 디렉터리입니다.

``` typescript
// restored-src/src/tools/AgentTool/agentMemorySnapshot.ts:31-33
export function getSnapshotDirForAgent(agentType: string): string {
  return join(getCwd(), '.claude', SNAPSHOT_BASE, agentType)
}
```

스냅샷은 `snapshot.json`의 `updatedAt` 타임스탬프를 통해 버전을 추적합니다. 스냅샷이 로컬 메모리보다 최신인 것으로 감지되면 다음 세 가지 전략이 제공됩니다.

``` typescript
// restored-src/src/tools/AgentTool/agentMemorySnapshot.ts:98-144
export async function checkAgentMemorySnapshot(
  agentType: string,
  scope: AgentMemoryScope,
): Promise<{
  action: 'none' | 'initialize' | 'prompt-update'
  snapshotTimestamp?: string
}> {
  // No snapshot → 'none'
  // No local memory → 'initialize' (copy snapshot to local)
  // Snapshot newer → 'prompt-update' (prompt model to merge)
}
```

`initialize`는 파일을 직접 복사합니다. `prompt-update`는 자동으로 덮어쓰지 않지만 "새로운 팀 지식을 사용할 수 있습니다"라는 프롬프트를 통해 모델에 알리고 모델이 병합 방법을 결정하도록 합니다. 이렇게 하면 자동 덮어쓰기로 인해 발생할 수 있는 로컬 사용자 정의 내용의 손실을 방지할 수 있습니다.

### <a href="#246-auto-dream-automatic-memory-consolidation"
class="header">24.6 Auto-Dream: 자동 메모리 통합</a>

Auto-Dream은 메모리 시스템의 "수면 단계"입니다. 즉, 트리거하려면 타임 게이트(기본값 24시간)와 세션 게이트(기본값 5개의 새 세션)가 모두 필요한 백그라운드 통합 작업입니다. 흩어져 있는 메모리 조각을 종합적으로 정리하고 오래된 정보를 정리하며 메모리 시스템 상태를 유지합니다.

#### <a href="#four-layer-gating-system" class="header">4층 게이팅 시스템</a>

Auto-Dream 트리거링은 가장 낮은 비용부터 가장 높은 비용까지 순서대로 4가지 검사를 통과합니다(`autoDream.ts:95-191`).

**레이어 1: 마스터 게이트**

``` typescript
// restored-src/src/services/autoDream/autoDream.ts:95-100
function isGateOpen(): boolean {
  if (getKairosActive()) return false  // KAIROS mode uses disk-skill dream
  if (getIsRemoteMode()) return false
  if (!isAutoMemoryEnabled()) return false
  return isAutoDreamEnabled()
}
```

KAIROS 모드는 KAIROS가 자체 드림 스킬(`/dream`를 통해 수동으로 트리거)을 가지고 있기 때문에 제외됩니다. 영구 저장소가 신뢰할 수 없기 때문에 원격 모드(CCR)가 제외됩니다. `isAutoDreamEnabled()`는 사용자 설정과 `tengu_onyx_plover` 기능 플래그(`config.ts:13-21`)를 확인합니다.

**레이어 2: 타임 게이트**

``` typescript
// restored-src/src/services/autoDream/autoDream.ts:131-141
let lastAt: number
try {
  lastAt = await readLastConsolidatedAt()
} catch { ... }
const hoursSince = (Date.now() - lastAt) / 3_600_000
if (!force && hoursSince < cfg.minHours) return
```

기본 `minHours = 24`, 마지막 통합 이후 최소 24시간. 잠금 파일 mtime을 통해 얻은 시간 정보 - 하나의 `stat` 시스템 호출.

**레이어 3: 세션 게이트**

``` typescript
// restored-src/src/services/autoDream/autoDream.ts:153-171
let sessionIds: string[]
try {
  sessionIds = await listSessionsTouchedSince(lastAt)
} catch { ... }
const currentSession = getSessionId()
sessionIds = sessionIds.filter(id => id !== currentSession)
if (!force && sessionIds.length < cfg.minSessions) return
```

기본 `minSessions = 5`, 마지막 통합 이후 최소 5개의 새 세션이 수정되었습니다. 현재 세션은 제외됩니다(해당 mtime은 항상 최신입니다). 스캔에는 10분의 쿨다운(`SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000`)이 있어 타임 게이트가 지나면 매 턴마다 반복되는 세션 목록 스캔을 방지합니다.

**레이어 4: 잠금 게이트** -- 세 번의 검사를 통과한 후 동시성 잠금을 획득해야 합니다. 다른 프로세스가 통합되면 현재 프로세스는 포기됩니다. 다음 섹션에서 잠금 메커니즘 구현 세부정보를 확인하세요.

#### <a href="#pid-lock-mechanism" class="header">PID 잠금 메커니즘</a>

동시성 제어는 `.consolidate-lock` 파일(`consolidationLock.ts`)을 사용합니다.

``` typescript
// restored-src/src/services/autoDream/consolidationLock.ts:16-19
const LOCK_FILE = '.consolidate-lock'
const HOLDER_STALE_MS = 60 * 60 * 1000  // 1 hour
```

이 잠금 파일은 이중 의미를 전달합니다.

- **mtime** = `lastConsolidatedAt`(마지막으로 성공한 통합의 타임스탬프)
- **파일 콘텐츠** = 보유자의 PID

잠금 획득 흐름:

1. `stat` + `readFile`를 사용하여 mtime 및 PID 가져오기
2. mtime이 1시간 이내이고 PID가 살아 있고 -\> 점유된 경우 `null`를 반환합니다.
3. PID가 작동하지 않거나 시간이 만료된 경우 -\> 잠금 회수
4. 자신의 PID 작성
5. 다시 읽어 확인합니다(두 프로세스가 동시에 회수될 때 경합을 방지함).

``` typescript
// restored-src/src/services/autoDream/consolidationLock.ts:46-84
export async function tryAcquireConsolidationLock(): Promise<number | null> {
  // ... stat + readFile ...
  await writeFile(path, String(process.pid))
  // Double check: two reclaimers both write → the later writer wins the PID
  let verify: string
  try {
    verify = await readFile(path, 'utf8')
  } catch { return null }
  if (parseInt(verify.trim(), 10) !== process.pid) return null
  return mtimeMs ?? 0
}
```

`rollbackConsolidationLock()`를 통한 실패 롤백은 mtime을 획득 전 값으로 복원합니다. `priorMtime`가 0(이전에 잠금 파일이 존재하지 않음)인 경우 잠금 파일이 삭제됩니다. 이렇게 하면 통합 실패로 인해 다음 재시도가 차단되지 않습니다.

#### <a href="#four-phase-consolidation-prompt" class="header">4단계 통합 프롬프트</a>

통합 에이전트는 구조화된 4단계 프롬프트를 받습니다.

1단계 — 방향 조정: ls 메모리 디렉터리, MEMORY.md 읽기, 항목 파일 찾아보기 2단계 — 수집: 새로운 신호에 대한 로그 및 세션 레코드 검색 3단계 — 통합: 기존 파일에 병합, 모순 해결, 상대 날짜 → 절대 날짜 4단계 — 정리 및 색인: MEMORY.md를 200줄/25KB 이내로 유지

프롬프트는 특히 "생성보다 병합"(`Merging new signal into existing topic files rather than creating near-duplicates`) 및 "보존보다 올바른 것"(`if today's investigation disproves an old memory, fix it at the source`)을 강조하여 무한한 메모리 파일 증가를 방지합니다.

자동 트리거 시나리오에서는 프롬프트에 추가 제약 정보(`Tool constraints for this run` 및 세션 목록)도 추가됩니다.

``` typescript
// restored-src/src/services/autoDream/autoDream.ts:216-221
const extra = `
**Tool constraints for this run:** Bash is restricted to read-only commands...
Sessions since last consolidation (${sessionIds.length}):
${sessionIds.map(id => `- ${id}`).join('\n')}`
```

#### <a href="#fork-agent-constraints" class="header">포크 에이전트 제약</a>

통합은 섹션 24.2에 설명된 `createAutoMemCanUseTool` 권한 기능을 사용하여 `runForkedAgent`(포크 에이전트 모드는 20장 참조)를 통해 실행됩니다. 주요 제약사항:

``` typescript
// restored-src/src/services/autoDream/autoDream.ts:224-233
const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: prompt })],
  cacheSafeParams: createCacheSafeParams(context),
  canUseTool: createAutoMemCanUseTool(memoryRoot),
  querySource: 'auto_dream',
  forkLabel: 'auto_dream',
  skipTranscript: true,
  overrides: { abortController },
  onMessage: makeDreamProgressWatcher(taskId, setAppState),
})
```

- `cacheSafeParams: createCacheSafeParams(context)` -- 상위 프롬프트 캐시를 상속하여 토큰 비용을 크게 줄입니다.
- `skipTranscript: true` -- 세션 기록에 기록되지 않음(통합은 백그라운드 작업이므로 사용자의 대화 기록을 오염시키지 않아야 함)
- `onMessage` -- 진행 콜백, 편집/쓰기 경로를 캡처하여 DreamTask UI 업데이트

#### <a href="#task-ui-integration" class="header">작업 UI 통합</a>

`DreamTask.ts`는 Claude Code의 백그라운드 작업 UI(바닥글 알약 및 Shift+Down 대화 상자)에 Auto-Dream을 노출합니다.

``` typescript
// restored-src/src/tasks/DreamTask/DreamTask.ts:25-41
export type DreamTaskState = TaskStateBase & {
  type: 'dream'
  phase: DreamPhase               // 'starting' | 'updating'
  sessionsReviewing: number
  filesTouched: string[]
  turns: DreamTurn[]
  abortController?: AbortController
  priorMtime: number              // For rollback on kill
}
```

사용자는 UI에서 드림 작업을 적극적으로 종료할 수 있습니다. `kill` 메소드는 `abortController.abort()`를 통해 포크 에이전트를 중단한 후 잠금 파일의 mtime을 롤백하여 다음 세션이 재시도할 수 있도록 합니다.

``` typescript
// restored-src/src/tasks/DreamTask/DreamTask.ts:136-156
async kill(taskId, setAppState) {
  updateTaskState<DreamTaskState>(taskId, setAppState, task => {
    task.abortController?.abort()
    priorMtime = task.priorMtime
    return { ...task, status: 'killed', ... }
  })
  if (priorMtime !== undefined) {
    await rollbackConsolidationLock(priorMtime)
  }
}
```

#### <a href="#extract-memories-vs-auto-dream-complementary-relationship"
class="header">기억 추출과 자동 꿈 보완 관계</a>

두 하위 시스템은 **고주파 증분 + 저주파 전역** 보완 아키텍처를 형성합니다.

``` mermaid
graph TD
    A["User conversation"] --> B["Query Loop end"]
    B --> C{"Extract Memories<br/>(every turn)"}
    C -->|"write"| D["MEMORY.md<br/>+ topic files"]
    C -->|"KAIROS mode"| F["Append-Only<br/>log files"]
    C -->|"standard mode"| D

    G["Auto-Dream<br/>(periodic)"] --> H{"Four-layer gating"}
    H -->|"pass"| I["Fork Agent<br/>4-phase consolidation"]
    I -->|"read"| F
    I -->|"read"| D
    I -->|"write"| D

    D -->|"Next session load"| J["System prompt injection"]
```

<div class="table-wrapper">

| 차원 | 기억 추출 | 자동 꿈 |
|----|----|----|
| 빈도 | 매 턴마다(플래그를 통해 조절 가능) | 매일 (24시간 + 5개 세션) |
| 입력 | 최근 N개의 메시지 | 전체 메모리 디렉터리 + 세션 기록 |
| 운영 | 주제 파일 생성/업데이트 | 모순 병합, 정리, 해결 |
| 유추 | 단기 → 장기 기억 인코딩 | 수면 중 기억 강화 |

</div>

KAIROS 모드에서는 이러한 보완성이 더욱 두드러집니다. Extract Memories는 추가 전용 로그(원시 신호 스트림)만 작성하고 Auto-Dream은 일일 통합 중에 로그를 구조화된 주제 파일로 추출합니다. 표준 모드에서 Extract Memories는 주제 파일을 직접 업데이트하고 Auto-Dream은 주기적인 정리 및 중복 제거를 처리합니다.

## <a href="#pattern-distillation" class="header">패턴 증류</a>

### <a href="#pattern-one-multi-layer-memory-architecture"
class="header">패턴 1: 다층 메모리 아키텍처</a>

**문제 해결**: 단일 스토리지 전략으로는 고주파수 쓰기와 고품질 검색을 동시에 충족할 수 없습니다.

**패턴**: 메모리 시스템을 원시 신호 계층(로그/세션 레코드), 구조화된 지식 계층(주제 파일), 인덱스 계층(MEMORY.md)의 세 가지 계층으로 나눕니다. 각 레이어에는 독립적인 쓰기 빈도 및 품질 요구 사항이 있습니다.

원시 신호 ──(매 턴)──→ 구조화된 지식 ──(일일)──→ 인덱스(로그)(주제 파일) (MEMORY.md) 고주파, 저품질 중간 주파수, 중간 품질 저주파수, 고품질

**전제 조건**: 백그라운드 처리 기능(포크 에이전트)이 필요하고 예측 가능한 스토리지 예산(잘림 메커니즘)이 필요합니다.

### <a href="#pattern-two-background-extraction-via-fork-agent"
class="header">패턴 2: Fork Agent를 통한 배경 추출</a>

**문제 해결**: 메모리 추출에는 모델 추론이 필요하지만 사용자의 상호 작용 루프를 차단할 수는 없습니다.

**패턴**: 쿼리 루프 끝에서 포크 에이전트 실행, 상위 프롬프트 캐시 상속(비용 절감), 엄격한 권한 격리 적용(메모리 디렉터리에만 쓸 수 있음), 도구 호출 및 회전 제한 설정(폭주 방지). 상호 배제 확인(`hasMemoryWritesSince`)을 통해 주체와 협력합니다.

**전제 조건**: 프롬프트 캐시 메커니즘 사용 가능, 포크 에이전트 인프라 준비(20장 참조), 메모리 디렉터리 경로 결정.

### <a href="#pattern-three-file-mtime-as-state" class="header">패턴 3: 파일 mtime을 상태로 사용</a>

**문제 해결**: Auto-Dream은 외부 데이터베이스를 도입하지 않고도 "마지막 통합 시간"과 "현재 보유자"를 유지해야 합니다.

**패턴**: 하나의 잠금 파일을 사용합니다. mtime은 `lastConsolidatedAt`이고 콘텐츠는 보유자 PID입니다. `stat`/`utimes`/`writeFile`를 통해 읽기, 획득, 롤백을 구현합니다. PID 활성 감지 + 1시간 만료로 충돌 복구가 제공됩니다.

**전제 조건**: 파일 시스템은 밀리초 단위의 정밀도 mtime을 지원하고, 프로세스 PID는 합리적인 기간 내에 재사용되지 않습니다.

### <a href="#pattern-four-budget-constrained-memory-injection"
class="header">패턴 4: 예산이 제한된 메모리 주입</a>

**문제 해결**: 무한한 메모리 증가로 인해 결국 유용한 컨텍스트 공간이 밀려납니다.

**패턴**: 다중 레벨 잘림 적용 -- MEMORY.md 최대 200줄/25KB, 주제 파일은 `MAX_MEMORY_FILES = 200`로 제한되며 세션 메모리 섹션당 토큰 2000개/총 12000개입니다. 잘림에 대한 경고 메시지를 추가하여 자가 치유 루프를 형성합니다.

**전제 조건**: 컨텍스트 예산(12장 참조)이 결정되고 잘린 콘텐츠도 여전히 의미 있는 정보를 제공할 수 있습니다.

### <a href="#pattern-five-complementary-frequency-design"
class="header">패턴 5: 보완적인 주파수 설계</a>

**문제 해결**: 단일 주파수 메모리 처리는 정보를 잃거나(너무 드물게) 노이즈를 축적합니다(너무 빈번함).

**패턴**: 이중 주파수 전략 - 고주파 증분 추출(매 회전/매 N 회전)은 잠재적으로 가치 있는 모든 신호를 캡처합니다. 저주파 글로벌 통합(일일)은 노이즈를 제거하고 모순을 해결하며 중복을 병합합니다. 전자는 거짓 긍정(중요하지 않은 것을 기억하는 것)을 허용합니다. 후자는 거짓 긍정(중요하지 않은 메모리 삭제)을 수정합니다.

**전제 조건**: 두 처리 주파수 간의 충분한 시간 차이(최소 100배), 고주파 작업 비용을 제어할 수 있습니다(프롬프트 캐시 상속).

## <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

### <a href="#manage-memorymd" class="header">MEMORY.md 관리</a>

200줄 제한을 이해하는 것이 중요합니다. 프로젝트의 메모리 인덱스가 200줄을 초과하면 이후 항목이 잘립니다. MEMORY.md를 수동으로 편집하여 가장 중요한 항목이 첫 번째 항목이 되도록 하고 세부 정보를 항목 파일로 이동합니다. 각 색인 항목을 한 줄에 150자 미만으로 유지하세요.

### <a href="#understand-what-gets-remembered" class="header">무엇이 기억되는지 이해하기</a>

네 가지 유형은 각각 가장 잘 사용됩니다.

- **피드백**은 가장 가치 있는 유형입니다. 이는 상담사의 행동을 직접적으로 변화시킵니다. "테스트에서 데이터베이스를 조롱하지 마십시오"가 "우리는 PostgreSQL을 사용합니다"보다 더 유용합니다.
- **사용자**는 상담원이 의사소통 스타일과 제안 깊이를 조정하는 데 도움을 줍니다.
- **프로젝트**는 시간에 민감하며 주기적인 정리가 필요합니다.
- **참조**는 외부 리소스에 대한 바로가기입니다. 간략하게 설명하세요.

### <a href="#control-automatic-memory" class="header">자동 메모리 제어</a>

- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`는 모든 자동 메모리 기능을 완전히 비활성화합니다.
- `autoMemoryEnabled: false`가 포함된 `settings.json`는 프로젝트별 비활성화
- `autoDreamEnabled: false`는 야간 통합만 비활성화하고 즉각적인 추출을 유지합니다.

### <a href="#manually-trigger-consolidation" class="header">수동으로 통합 트리거</a>

매일 자동 트리거를 기다리고 싶지 않으십니까? 즉각적인 메모리 통합을 위해 `/dream` 명령을 사용하십시오. 특히 유용함:

- 대규모 리팩터링을 완료한 후 프로젝트 컨텍스트를 업데이트하려면
- 팀원 전환 후 개인 선호도 정리를 위해
- 오래되었거나 모순되는 메모리 파일을 발견한 경우

### <a href="#supplement-memory-with-claudemd" class="header">CLAUDE.md로 메모리 보충</a>

CLAUDE.md와 메모리 시스템은 상호 보완적입니다.

- CLAUDE.md는 **수정해서는 안되는 지침**(코딩 표준, 아키텍처 제약 조건, 팀 프로세스)을 저장합니다.
- 메모리 시스템은 사용자 선호도, 프로젝트 컨텍스트, 외부 참조 등 **진화할 수 있는 지식**을 저장합니다.

정보가 Auto-Dream에 의해 정리되거나 수정되어서는 안 되는 경우에는 메모리 시스템이 아닌 CLAUDE.md에 저장하세요.

------------------------------------------------------------------------

## <a href="#version-evolution-v2191-memory-system-changes"
class="header">버전 진화: v2.1.91 메모리 시스템 변경 사항</a>

> 다음 분석은 v2.1.88 소스 코드 추론과 결합된 v2.1.91 번들 신호 비교를 기반으로 합니다.

### <a href="#memory-feature-toggle" class="header">메모리 기능 토글</a>

v2.1.91에는 `tengu_memory_toggled` 이벤트가 추가되어 메모리 기능에 대한 런타임 토글을 제안합니다. 사용자는 세션 중에 교차 세션 메모리를 동적으로 활성화하거나 비활성화할 수 있습니다. 이는 메모리가 항상 활성화된(기능 플래그가 켜져 있는 경우) v2.1.88과 다릅니다.

### <a href="#no-prose-skip-optimization" class="header">무산문 건너뛰기 최적화</a>

`tengu_extract_memories_skipped_no_prose` 이벤트는 메모리 추출 전 v2.1.91에 추가된 콘텐츠 감지를 나타냅니다. 메시지에 구문 콘텐츠(순수 코드, 도구 결과, JSON 출력)가 포함되어 있지 않으면 메모리 추출을 건너뛰므로 의미 없는 콘텐츠에 대한 비용이 많이 드는 LLM 추출을 방지합니다.

이는 **예산을 고려한 최적화**입니다. 메모리 추출에는 추가 API 호출이 필요하며 순수한 기술 상호 작용(배치 파일 읽기, 테스트 실행)에서 추출하면 비용이 낭비될 뿐만 아니라 품질이 낮은 메모리 항목이 생성될 수 있습니다.

### <a href="#team-memory" class="header">팀 메모리</a>

v2.1.91에는 팀 메모리가 실험에서 활성 사용으로 이동했음을 나타내는 `tengu_team_mem_*` 이벤트 시리즈(sync_pull, sync_push, push_suppressed, secret_skipped 등)가 추가되었습니다.

팀 메모리는 개인 메모리와 별개로 `~/.claude/projects/{project}/memory/team/`에 저장됩니다. 주요 메커니즘:

- **동기화**: `sync_pull` / `sync_push` 이벤트는 구성원 간 동기화를 나타냅니다.
- **보안 필터링**: `secret_skipped` 이벤트는 민감한 콘텐츠(API 키, 비밀번호)가 공유 메모리에 기록되지 않음을 나타냅니다.
- **쓰기 억제**: `push_suppressed` ​​이벤트는 쓰기 제한(빈도 또는 용량)을 나타냅니다.
- **입력 한도**: `entries_capped` 이벤트는 팀 메모리에 용량 제한이 있음을 나타냅니다.

Teams 구현 세부 사항 내의 팀 메모리 보안 보호 분석은 20b장을 참조하세요.

------------------------------------------------------------------------

## <a href="#version-evolution-v21100-dream-system-maturation"
class="header">버전 진화: v2.1.100 드림 시스템 성숙</a>

> 다음 분석은 v2.1.88 소스 코드(`services/autoDream/autoDream.ts`) 추론과 결합된 v2.1.100 번들 신호 비교를 기반으로 합니다.

### <a href="#kairos-dream-background-scheduled-consolidation"
class="header">Kairos Dream: 백그라운드 예약 통합</a>

v2.1.88 소스에서 `getKairosActive()`는 `auto_dream`가 `false`(`autoDream.ts:95-100`)를 조기에 반환하도록 합니다. KAIROS 모드에는 "자신만의 드림 스킬이" 있기 때문입니다. v2.1.100은 이 디자인을 변경합니다. 별도의 드림 스킬 대신 KAIROS 모드는 이제 `tengu_kairos_dream`를 백그라운드 크론 예약 드림 작업(Dream 시스템의 세 번째 트리거 모드)으로 사용합니다.

<div class="table-wrapper">

| 트리거 모드 | 이벤트 | 언제 | 전제 조건 |
|----|----|----|----|
| 수동 | `tengu_dream_invoked` | 사용자가 `/dream`를 실행합니다. | 없음 |
| 오토매틱 | `tengu_auto_dream_fired` | 세션 시작 시 확인됨 | 타임 게이트 + 세션 게이트 |
| 예정됨 | `tengu_kairos_dream` | 백그라운드 크론 일정 | 카이로스 모드 활성화 |

</div>

v2.1.100 번들에서 추출된 cron 표현식 생성 로직:

``` javascript
// v2.1.100 bundle reverse engineering
function P_A() {
  let q = Math.floor(Math.random() * 360);
  return `${q % 60} ${Math.floor(q / 60)} * * *`;
}
```

`Math.random() * 360`는 0-359의 난수를 생성합니다. `q % 60`는 분(0-59)을 제공하고, `Math.floor(q / 60)`는 시간(0-5)을 제공합니다. 즉, Kairos Dream은 **자정부터 오전 5시 사이에만 실행**됩니다. 야간 실행은 활성 사용자 세션과 리소스 경쟁을 피하는 동시에 무작위 오프셋을 통해 여러 사용자가 동시에 트리거하는 것을 방지합니다. 이는 v2.1.88 소스(`autoDream.ts:153-171`)의 `consolidationLock` 파일 잠금과 동일한 분산 친화적 철학을 공유합니다.

### <a href="#explicit-skip-reasons" class="header">명시적인 건너뛰기 이유</a>

v2.1.100은 `reason` 필드 기록 건너뛰기 원인과 함께 `tengu_auto_dream_skipped`를 추가합니다. 번들에서 추출된 두 개의 건너뛰기 경로:

``` javascript
// v2.1.100 bundle reverse engineering
d("tengu_auto_dream_skipped", {
  reason: "sessions",          // Not enough new sessions (< minSessions)
  session_count: j.length,
  min_required: Y.minSessions
})

d("tengu_auto_dream_skipped", {
  reason: "lock"               // Lock held by another process
})
```

이 두 건너뛰기 경로는 v2.1.88 소스(`autoDream.ts:131-171`)의 2계층 게이팅에 해당합니다. 하지만 v2.1.88은 자동으로 반환되는 반면 v2.1.100은 건너뛰기 이유를 원격 측정 이벤트로 기록합니다. 이를 통해 관찰 가능성이 향상됩니다. 운영자는 `reason` 배포판을 검사하여 "꿈이 실행되지 않는 이유"를 진단할 수 있습니다.

### <a href="#two-dream-prompt-modes" class="header">두 가지 꿈 프롬프트 모드</a>

v2.1.88 소스(`autoDream.ts:216-233`)의 드림 실행 논리에 해당하는 v2.1.100 번들에서 추출된 두 개의 서로 다른 꿈 프롬프트:

1. **가지치기 모드**: "당신은 꿈을 수행하고 있습니다 - 메모리 파일에 대한 가지치기 패스" - 오래되거나 중복되거나 모순되는 메모리 항목을 삭제합니다
2. **반사 모드**: "당신은 메모리 파일에 대한 반사 패스인 꿈을 수행하고 있습니다. 무엇을 합성합니까..." — 흩어진 메모리 조각을 구조화된 지식으로 합성합니다.

v2.1.100 번들의 `team/` 디렉토리 처리 규칙("꿈을 꾸는 동안 개인 메모리를 `team/`로 승격시키지 마십시오. 이는 반사적으로 수행할 작업이 아니라 사용자가 `/remember`를 통해 의도적으로 선택하는 것입니다.")과 결합된 모드 간의 명시적인 구분은 명확한 Dream 동작 경계를 설정합니다. 꿈은 정리하고 정리할 수 있지만 메모리 공유 범위를 일방적으로 확대할 수는 없습니다.

### <a href="#toolstats-session-level-tool-statistics"
class="header">toolStats: 세션 수준 도구 통계</a>

v2.1.100의 `sdk-tools.d.ts`는 7차원 세션 수준 도구 사용 통계를 제공하는 `toolStats` 필드를 추가합니다.

``` typescript
toolStats?: {
  readCount: number;       // File read count
  searchCount: number;     // Search count
  bashCount: number;       // Bash command count
  editFileCount: number;   // File edit count
  linesAdded: number;      // Lines added
  linesRemoved: number;    // Lines removed
  otherToolCount: number;  // Other tool count
};
```

이는 Dream 시스템의 "세션 가치 평가"에 대한 정량적 기반을 제공합니다. `auto_dream`는 순전히 기술적인 작업(`bashCount`가 높지만 `linesAdded`가 없는 디버깅 세션과 같은)보다는 최근 세션에 통합할 가치가 있는 충분한 "실질적인 상호 작용"이 포함되어 있는지 판단해야 합니다.
