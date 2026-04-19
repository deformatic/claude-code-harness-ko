# <a href="#chapter-10-post-compaction-file-state-preservation"
class="header">10장: 압축 후 파일 상태 보존</a>

> *"복원 없는 압축은 추가 단계를 거친 데이터 손실일 뿐입니다."*

9장에서는 **압축이 트리거되는 경우**와 **요약이 생성되는 방법**을 다루었습니다. 그러나 압축 이야기는 요약 생성 후에도 끝나지 않습니다. 긴 대화가 하나의 요약 메시지로 압축되면 모델은 원래의 모든 컨텍스트를 잃게 됩니다. 즉, 방금 읽은 파일이 무엇인지 더 이상 알 수 없고 실행 중이던 계획도 기억하지 못하며 어떤 도구를 사용할 수 있는지조차 알 수 없습니다. 압축 후 첫 번째 차례에서 모델이 "방금" 읽은 파일을 계속 편집하도록 요청하고 모델이 이를 다시 `Read`하는 경우 이는 토큰을 낭비할 뿐만 아니라 사용자의 작업 흐름을 방해합니다.

이 장의 주제는 **압축 후 상태 복원**입니다. 압축이 완료된 후 Claude Code가 신중하게 설계된 일련의 첨부 파일을 통해 모델이 "필요하지만 손실된" 주요 컨텍스트를 대화 흐름에 다시 주입하는 방법입니다. 파일 상태, 기술 콘텐츠, 계획 상태, 델타 도구 선언, 의도적으로 복원되지 않은 콘텐츠 등 5가지 복원 차원을 하나씩 분석해 보겠습니다.

------------------------------------------------------------------------

## <a href="#101-pre-compaction-snapshot-save-before-clearing"
class="header">10.1 압축 전 스냅샷: 지우기 전 저장</a>

압축 복원의 첫 번째 단계는 압축 후에 수행하는 작업이 아니라 **압축 전 장면을 저장하는 것**입니다.

### <a href="#1011-cachetoobject--clear-the-snapshot-clear-pattern"
class="header">10.1.1 <code>cacheToObject</code> + <code>clear</code>: 스냅샷 지우기 패턴</a>

``` typescript
// services/compact/compact.ts:517-522
// Store the current file state before clearing
const preCompactReadFileState = cacheToObject(context.readFileState)

// Clear the cache
context.readFileState.clear()
context.loadedNestedMemoryPaths?.clear()
```

다음 세 줄은 고전적인 **스냅샷 지우기** 패턴을 구현합니다.

1. **스냅샷**: `cacheToObject(context.readFileState)`는 메모리 내 `FileStateCache`(맵 구조)를 일반 `Record<string, { content: string; timestamp: number }>` 객체로 직렬화합니다. 이 객체는 압축 전에 모델이 읽은 모든 파일(파일 이름, 콘텐츠, 마지막 읽기의 타임스탬프)을 기록합니다.

2. **지우기**: `context.readFileState.clear()`는 파일 상태 캐시를 지우고 `context.loadedNestedMemoryPaths?.clear()`는 로드된 중첩 메모리 경로를 지웁니다.

왜 먼저 클리어해야 할까요? 압축은 대화 기록을 단일 요약 메시지로 대체하기 때문입니다. 모델의 관점에서 볼 때, 파일을 읽은 것을 "잊어버릴" 것입니다. 캐시가 지워지지 않으면 시스템은 모델이 여전히 이러한 파일의 내용을 "알고" 있다고 잘못 믿고 후속 파일 중복 제거 논리가 제대로 작동하지 않게 됩니다. 삭제 후 시스템은 정리 상태로 들어간 다음 모든 것을 복원하는 대신 가장 중요한 파일을 선택적으로 복원합니다.

### <a href="#1012-why-not-restore-everything" class="header">10.1.2 왜 모든 것을 복원하지 않습니까?</a>

이 질문은 압축 복원의 핵심 설계 철학과 관련이 있습니다. 긴 세션 동안 모델은 수십 또는 수백 개의 파일을 읽었을 수 있습니다. 압축 후에 모두 다시 주입되면 터무니없는 주기가 발생합니다. **압축으로 방금 확보된 토큰 공간은 복원된 파일 콘텐츠로 즉시 채워집니다**.

따라서 복원 전략은 근본적으로 **예산 할당 문제**, 즉 제한된 토큰 예산 내에서 가장 가치 있는 상태를 선택적으로 복원하는 것입니다.

------------------------------------------------------------------------

## <a
href="#102-file-restoration-most-recent-5-files-5k-per-file-50k-total-budget"
class="header">10.2 파일 복원: 최근 5개 파일, 파일당 5K, 총 예산 50K</a>

### <a href="#1021-the-five-constant-budget-framework" class="header">10.2.1 5가지 예산 체계</a>

``` typescript
// services/compact/compact.ts:122-130
export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
export const POST_COMPACT_TOKEN_BUDGET = 50_000
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000
```

이 5가지 상수는 압축 후 복원을 위한 완전한 예산 체계를 형성합니다. 아래 표는 할당 논리를 보여줍니다.

**표 10-1: 압축 후 토큰 예산 할당**

<div class="table-wrapper">

| 예산 항목 | 상수 이름 | 한계 | 의미 |
|----|----|----|----|
| 파일 수 제한 | `POST_COMPACT_MAX_FILES_TO_RESTORE` | 5 | 가장 최근에 읽은 파일 최대 5개 복원 |
| 파일당 토큰 제한 | `POST_COMPACT_MAX_TOKENS_PER_FILE` | 5,000 | 각 파일은 최대 5K 토큰을 차지합니다. |
| 파일 복원 총 예산 | `POST_COMPACT_TOKEN_BUDGET` | 50,000 | 복원된 모든 파일의 총 토큰은 50K를 초과할 수 없습니다. |
| 스킬당 토큰 제한 | `POST_COMPACT_MAX_TOKENS_PER_SKILL` | 5,000 | 각 스킬 파일은 5,000개 토큰으로 잘립니다. |
| 스킬복원 총예산 | `POST_COMPACT_SKILLS_TOKEN_BUDGET` | 25,000 | 모든 기술의 총 토큰은 25K를 초과할 수 없습니다. |

</div>

200K 컨텍스트 창을 예로 사용하면 압축 후 요약은 약 10K-20K 토큰을 차지합니다. 파일 복원은 최대 50K, 스킬 복원은 최대 25K, 총 대략 75K~95K를 소비하며 여전히 후속 대화를 위한 100K 이상의 공간을 남겨둡니다. 이는 신중하게 고려된 균형입니다. **모델이 원활하게 작업을 계속할 수 있도록 충분한 컨텍스트를 복원하지만 압축이 의미가 없을 정도로 너무 많이 복원하지는 않습니다**.

### <a href="#1022-restoration-logic-in-detail" class="header">10.2.2 복원 로직 상세 설명</a>

``` typescript
// services/compact/compact.ts:1415-1464
export async function createPostCompactFileAttachments(
  readFileState: Record<string, { content: string; timestamp: number }>,
  toolUseContext: ToolUseContext,
  maxFiles: number,
  preservedMessages: Message[] = [],
): Promise<AttachmentMessage[]> {
  const preservedReadPaths = collectReadToolFilePaths(preservedMessages)
  const recentFiles = Object.entries(readFileState)
    .map(([filename, state]) => ({ filename, ...state }))
    .filter(
      file =>
        !shouldExcludeFromPostCompactRestore(
          file.filename,
          toolUseContext.agentId,
        ) && !preservedReadPaths.has(expandPath(file.filename)),
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, maxFiles)
  // ...
}
```

이 함수의 논리는 네 단계로 구분됩니다.

**1단계: 복원이 필요하지 않은 파일을 제외합니다**. `shouldExcludeFromPostCompactRestore`(라인 1674-1705)에서는 두 가지 유형의 파일을 제외합니다.

- **계획 파일** — 자체적인 독립적인 복원 채널이 있습니다(섹션 10.4 참조).
- **CLAUDE.md 메모리 파일** - 시스템 프롬프트를 통해 삽입되며 파일 복원 채널을 통해 복제할 필요가 없습니다.

또한 파일 경로가 보존된 메시지 테일(`preservedReadPaths`)에 이미 나타나는 경우 중복 복원이 필요하지 않습니다. 모델은 이미 컨텍스트에서 이를 볼 수 있습니다.

**2단계: 타임스탬프별로 정렬**. `.sort((a, b) => b.timestamp - a.timestamp)`는 마지막으로 읽은 시간의 내림차순으로 파일을 정렬합니다. 가장 최근에 읽은 파일은 모델이 다음에 작동해야 하는 파일일 가능성이 높습니다.

**3단계: 상위 N**을 선택합니다. `.slice(0, maxFiles)`는 가장 최근 파일 5개를 가져옵니다. 이 잘림은 제외 필터링 후에 발생합니다. 20개의 파일 중 3개가 제외되면 17개의 파일만 정렬에 참여하고 그 중에서 상위 5개가 가져옵니다.

**4단계: 첨부 파일을 병렬로 생성**. 선택한 파일의 경우 `generateFileAttachment`는 파일 내용을 병렬로 다시 읽으며 각 파일에는 `POST_COMPACT_MAX_TOKENS_PER_FILE`(5K 토큰) 제한이 적용됩니다. 여기서 중요한 세부 사항은 복원 시 스냅샷에서 캐시된 콘텐츠가 아닌 **디스크의 현재 콘텐츠**를 읽는다는 것입니다. 압축 중에 파일이 외부에서 수정된 경우(예: 사용자가 편집기에서 수동으로 편집한 경우) 복원된 콘텐츠는 수정된 버전입니다.

**5단계: 예산 관리**. 첨부 파일을 생성한 후에는 예산 제한이 하나 더 있습니다.

``` typescript
// services/compact/compact.ts:1452-1463
let usedTokens = 0
return results.filter((result): result is AttachmentMessage => {
  if (result === null) {
    return false
  }
  const attachmentTokens = roughTokenCountEstimation(jsonStringify(result))
  if (usedTokens + attachmentTokens <= POST_COMPACT_TOKEN_BUDGET) {
    usedTokens += attachmentTokens
    return true
  }
  return false
})
```

파일이 5개만 있어도 모두 큰 경우(각각 토큰 5,000개에 접근) 전체 파일이 50,000개 예산을 초과할 수 있습니다. 이 필터는 최종 게이트키퍼 역할을 합니다. 즉, 각 파일의 토큰 수를 순서대로 누적하고 총량이 `POST_COMPACT_TOKEN_BUDGET`(50K)를 초과하면 나머지 파일을 삭제합니다.

### <a href="#1023-preserve-vs-discard-decision-tree" class="header">10.2.3 "보존 및 폐기" 결정 트리</a>

다음 결정 트리에서는 압축 후 각 파일을 복원할지 여부를 결정하는 전체 논리를 설명합니다.

``` mermaid
flowchart TD
    A["Was the file read before compaction?"] -->|No| B["Not restored: file not in readFileState"]
    A -->|Yes| C{"Is it a plan file?"}
    C -->|Yes| D["Excluded: restored independently via Plan attachment (see 10.4)"]
    C -->|No| E{"Is it a CLAUDE.md memory file?"}
    E -->|Yes| F["Excluded: injected via system prompt"]
    E -->|No| G{"Already in preserved message tail?"}
    G -->|Yes| H["Excluded: model can already see it, no duplication needed"]
    G -->|No| I{"In top 5 after timestamp sorting?"}
    I -->|No| J["Discarded: exceeds file count limit"]
    I -->|Yes| K{"Single file exceeds 5K tokens?"}
    K -->|Yes| L["Truncated to 5K tokens, then continue"]
    K -->|No| M{"Cumulative total exceeds 50K?"}
    L --> M
    M -->|Yes| N["Discarded: exceeds total budget"]
    M -->|No| O["Restored - injected as attachment"]
```

이 의사결정 트리는 중요한 설계를 보여줍니다. **복원은 단순한 "최근 N" 알고리즘이 아니라 다중 계층 필터링 파이프라인**입니다. 제외 규칙, 개수 제한, 파일별 잘림, 총 예산 한도 등 4가지 보호 계층을 통해 복원된 콘텐츠의 가치를 높이고 지나치게 부풀리지 않도록 보장합니다.

------------------------------------------------------------------------

## <a href="#103-skill-re-injection-selective-restoration-of-invokedskills"
class="header">10.3 스킬 재주입: 호출된 스킬의 선택적 복원</a>

### <a href="#1031-why-skills-need-independent-restoration"
class="header">10.3.1 스킬에 독립적인 복원이 필요한 이유</a>

스킬은 클로드 코드의 확장성 시스템입니다. 사용자가 세션 중에 스킬(예: `code-review` 또는 `commit`)을 호출하면 해당 스킬의 지침이 대화에 삽입됩니다. 압축 후에는 이러한 지침이 나머지 컨텍스트와 함께 사라집니다. 그러나 기술에는 "커밋하기 전에 테스트를 실행해야 함" 또는 "코드 검토 중 보안 문제에 집중"과 같은 중요한 행동 제약 조건이 포함되는 경우가 많습니다. 복원되지 않으면 모델이 압축 후 이러한 제약 조건을 위반할 수 있습니다.

### <a href="#1032-skill-restoration-mechanism" class="header">10.3.2 스킬 복원 메커니즘</a>

``` typescript
// services/compact/compact.ts:1494-1534
export function createSkillAttachmentIfNeeded(
  agentId?: string,
): AttachmentMessage | null {
  const invokedSkills = getInvokedSkillsForAgent(agentId)

  if (invokedSkills.size === 0) {
    return null
  }

  // Sorted most-recent-first so budget pressure drops the least-relevant skills.
  let usedTokens = 0
  const skills = Array.from(invokedSkills.values())
    .sort((a, b) => b.invokedAt - a.invokedAt)
    .map(skill => ({
      name: skill.skillName,
      path: skill.skillPath,
      content: truncateToTokens(
        skill.content,
        POST_COMPACT_MAX_TOKENS_PER_SKILL,
      ),
    }))
    .filter(skill => {
      const tokens = roughTokenCountEstimation(skill.content)
      if (usedTokens + tokens > POST_COMPACT_SKILLS_TOKEN_BUDGET) {
        return false
      }
      usedTokens += tokens
      return true
    })

  if (skills.length === 0) {
    return null
  }

  return createAttachmentMessage({
    type: 'invoked_skills',
    skills,
  })
}
```

스킬 복원 전략은 파일 복원과 매우 유사하지만 두 가지 주요 차이점이 있습니다.

**차이점 1: 버리기보다는 잘라냅니다**. 소스 주석(125-128행)은 설계 의도를 설명합니다.

> 기술은 클 수 있습니다(verify=18.7KB, clude-api=20.1KB). 이전에는 모든 컴팩트 -\> 5-10K tok/컴팩트에 무제한으로 다시 주입되었습니다. 스킬별 잘림이 삭제보다 낫습니다. 스킬 파일 상단에 있는 지침은 일반적으로 중요한 부분입니다.

스킬 파일은 클 수 있지만(`verify` 스킬은 18.7KB, `claude-api`는 20.1KB) **스킬 파일 시작 부분에 있는 지침은 일반적으로 가장 중요한 부분입니다**. `truncateToTokens` 기능은 각 스킬을 5K 토큰으로 잘라서 상단 지침을 유지하고 하단의 자세한 참조 콘텐츠를 삭제합니다. 이는 바이너리 "모두 유지 또는 모두 삭제" 전략보다 더 정교합니다.

**차이점 2: 에이전트에 의한 격리**. `getInvokedSkillsForAgent(agentId)`는 현재 에이전트에 속한 스킬만 반환합니다. 이렇게 하면 기본 세션의 스킬이 하위 에이전트의 컨텍스트로 유출되는 것을 방지할 수 있으며 그 반대의 경우도 마찬가지입니다.

### <a href="#1033-budget-arithmetic" class="header">10.3.3 예산 산술</a>

총 예산 25,000개로 얼마나 많은 스킬을 복원할 수 있나요? 스킬당 5K 토큰, 이론적으로는 최대 5개 스킬입니다. 소스 댓글도 이를 확인합니다. "스킬당 최대 5개의 스킬을 보유할 수 있는 예산 규모."

그러나 실제로는 많은 기술이 잘린 후 5,000개 토큰 미만이므로 일반적으로 25,000개 예산은 세션에서 호출되는 모든 기술을 포함합니다. 사용자가 단일 긴 세션에서 수많은 대규모 기술을 호출하는 경우에만 예산이 병목 현상이 됩니다. 이 경우 가장 오래된 기술이 먼저 삭제됩니다.

------------------------------------------------------------------------

## <a href="#104-content-deliberately-not-restored-sentskillnames"
class="header">10.4 콘텐츠가 의도적으로 복원되지 않음: sentSkillNames</a>

모든 지워진 상태를 복원할 필요는 없습니다. 소스 코드에서 가장 흥미로운 디자인 결정 중 하나는 다음과 같습니다.

``` typescript
// services/compact/compact.ts:524-529
// Intentionally NOT resetting sentSkillNames: re-injecting the full
// skill_listing (~4K tokens) post-compact is pure cache_creation with
// marginal benefit. The model still has SkillTool in its schema and
// invoked_skills attachment (below) preserves used-skill content. Ants
// with EXPERIMENTAL_SKILL_SEARCH already skip re-injection via the
// early-return in getSkillListingAttachments.
```

`sentSkillNames`는 어떤 기술 이름 목록이 이미 모델에 전송되었는지 기록하는 모듈 수준 `Map<string, Set<string>>`입니다. 압축 후 재설정된 경우 시스템은 다음 요청 시 전체 기술 목록 첨부 파일(약 4K 토큰)을 다시 주입합니다.

하지만 코드는 **의도적으로 재설정하지 않습니다**. 이유는 다음과 같습니다.

1. **비용 비대칭성**: 4K 토큰 기술 목록은 전적으로 `cache_creation` 토큰(캐시에 기록해야 하는 새 콘텐츠)이지만 이점은 미미합니다. 모델은 여전히 ​​`SkillTool` 스키마를 통해 기술 도구의 존재를 알 수 있습니다.
2. **이미 호출된 스킬은 이미 복원되었습니다**: 이전 섹션의 `invoked_skills` 첨부 파일은 이미 실제로 사용된 스킬의 내용을 복원하므로 모델에서 전체 이름 목록을 다시 볼 필요가 없습니다.
3. **실험적 기술 검색**: `EXPERIMENTAL_SKILL_SEARCH`가 활성화된 환경에서는 이미 기술 목록 삽입을 건너뜁니다.

이는 "복원 완전성"보다 "토큰 비용"을 선택하는 교과서적인 **토큰 절약 엔지니어링 결정**입니다. 4K 토큰은 작아 보일 수 있지만 압축할 때마다 누적됩니다. 자주 압축되는 긴 세션의 경우 이는 상당한 비용 절감 효과를 나타냅니다.

------------------------------------------------------------------------

## <a href="#105-plan-and-planmode-attachment-preservation"
class="header">10.5 Plan 및 PlanMode 첨부 파일 보존</a>

Claude Code의 계획 모드를 사용하면 모델이 작업을 실행하기 전에 세부 계획을 생성할 수 있습니다. 압축 후에는 계획 상태가 완전히 보존되어야 합니다. 그렇지 않으면 모델은 실행 중이던 계획을 "잊게" 됩니다.

### <a href="#1051-plan-attachment" class="header">10.5.1 계획 ​​첨부</a>

``` typescript
// services/compact/compact.ts:545-548
const planAttachment = createPlanAttachmentIfNeeded(context.agentId)
if (planAttachment) {
  postCompactFileAttachments.push(planAttachment)
}
```

`createPlanAttachmentIfNeeded`(라인 1470-1486)는 현재 에이전트에 활성 계획 파일이 있는지 확인합니다. 그렇다면 계획 내용은 `plan_file_reference` 형태의 첨부파일로 주입됩니다. 계획 파일은 독립적인 복원 채널이 있기 때문에 `shouldExcludeFromPostCompactRestore`에 의한 파일 복원에서 명시적으로 제외됩니다. 동일한 파일이 두 번 복원되어 예산이 낭비되는 것을 방지합니다.

### <a href="#1052-planmode-attachment" class="header">10.5.2 PlanMode 첨부</a>

``` typescript
// services/compact/compact.ts:552-555
const planModeAttachment = await createPlanModeAttachmentIfNeeded(context)
if (planModeAttachment) {
  postCompactFileAttachments.push(planModeAttachment)
}
```

Plan 첨부 파일은 **계획 콘텐츠**를 복원하고, PlanMode 첨부 파일은 **모드 상태**를 복원합니다. `createPlanModeAttachmentIfNeeded`(1542-1560행)은 사용자가 현재 계획 모드(`mode === 'plan'`)에 있는지 확인합니다. 그렇다면 `reminderType: 'full'` 플래그가 포함된 `plan_mode` 유형 첨부 파일을 삽입하여 모델이 일반 실행 모드로 돌아가는 대신 압축 후에도 계획 모드에서 계속 작동하도록 합니다.

이 두 첨부 파일은 함께 작동합니다. Plan 첨부 파일은 모델에 "이 계획을 실행 중입니다"라고 알려주고 PlanMode 첨부 파일은 모델에 "계속 계획 모드에서 작업해야 합니다"라고 알려줍니다. 둘 중 하나가 누락되면 행동 편차가 발생할 수 있습니다.

------------------------------------------------------------------------

## <a href="#106-delta-attachments-re-announcing-tools-and-instructions"
class="header">10.6 델타 첨부 파일: 도구 및 지침 재공지</a>

압축은 파일 상태만 지우는 것이 아니라 이전 델타 첨부 파일도 모두 지웁니다. 델타 첨부 파일은 새로 등록된 지연된 도구, 새로 발견된 에이전트, 새로 로드된 MCP 지침 등 대화 중에 시스템이 모델에 점진적으로 알리는 "증분 정보"입니다. 압축 후에는 이 정보가 이전 메시지와 함께 사라집니다.

### <a href="#1061-full-replay-of-three-delta-types" class="header">10.6.1 세 가지 델타 유형의 전체 재생</a>

``` typescript
// services/compact/compact.ts:563-585
// Compaction ate prior delta attachments. Re-announce from the current
// state so the model has tool/instruction context on the first
// post-compact turn. Empty message history -> diff against nothing ->
// announces the full set.
for (const att of getDeferredToolsDeltaAttachment(
  context.options.tools,
  context.options.mainLoopModel,
  [],
  { callSite: 'compact_full' },
)) {
  postCompactFileAttachments.push(createAttachmentMessage(att))
}
for (const att of getAgentListingDeltaAttachment(context, [])) {
  postCompactFileAttachments.push(createAttachmentMessage(att))
}
for (const att of getMcpInstructionsDeltaAttachment(
  context.options.mcpClients,
  context.options.tools,
  context.options.mainLoopModel,
  [],
)) {
  postCompactFileAttachments.push(createAttachmentMessage(att))
}
```

소스 주석은 이 코드의 영리한 디자인을 보여줍니다. **빈 배열 `[]`를 메시지 기록으로 전달**.

일반적인 대화가 진행되는 동안 델타 첨부 기능은 현재 상태를 메시지 기록에 이미 표시된 상태와 비교하여 "델타"만 보냅니다. 그러나 압축 후에는 비교할 메시지 기록이 없습니다. 빈 배열을 전달하면 diff 기준선이 비어 있으므로 함수가 **완전한** 도구 및 명령 선언을 생성합니다.

세 가지 델타 연결 유형과 해당 목적은 다음과 같습니다.

<div class="table-wrapper">

| 델타 유형 | 기능 | 복원된 콘텐츠 |
|----|----|----|
| 지연된 도구 | `getDeferredToolsDeltaAttachment` | 전체 스키마가 아직 로드되지 않은 도구 목록으로, `ToolSearch`를 통해 요청 시 스키마를 가져올 수 있음을 모델에 알립니다. |
| 에이전트 목록 | `getAgentListingDeltaAttachment` | 사용 가능한 하위 에이전트 목록으로 모델에 작업을 위임할 수 있음을 알려줍니다. |
| MCP 지침 | `getMcpInstructionsDeltaAttachment` | 모델이 외부 서비스 사용 규칙을 따르도록 보장하는 MCP 서버에서 제공되는 지침 및 제약 조건 |

</div>

`callSite: 'compact_full'` 태그는 원격 측정 분석에 사용되어 일반 증분 선언과 압축 후 전체 재생을 구별합니다.

### <a href="#1062-async-agent-attachments" class="header">10.6.2 비동기 에이전트 첨부</a>

``` typescript
// services/compact/compact.ts:532-539
const [fileAttachments, asyncAgentAttachments] = await Promise.all([
  createPostCompactFileAttachments(
    preCompactReadFileState,
    context,
    POST_COMPACT_MAX_FILES_TO_RESTORE,
  ),
  createAsyncAgentAttachmentsIfNeeded(context),
])
```

`createAsyncAgentAttachmentsIfNeeded`(1568-1599행)는 백그라운드에서 실행 중인 비동기 에이전트가 있는지 또는 결과가 검색되지 않은 완료된 에이전트가 있는지 확인합니다. 그렇다면 에이전트 설명, 상태 및 진행 요약을 포함하여 각 에이전트에 대해 `task_status` 유형 첨부 파일을 생성합니다. 이렇게 하면 모델이 압축 후 백그라운드 작업을 "잊고" 동일한 작업을 중복적으로 시작하는 것을 방지할 수 있습니다.

파일 복원 및 비동기 에이전트 첨부 생성은 **병렬**(`Promise.all`)로 실행됩니다. 두 가지가 독립적이고 순차적으로 기다릴 이유가 없기 때문에 성능이 최적화됩니다.

------------------------------------------------------------------------

## <a href="#107-the-complete-restoration-orchestration"
class="header">10.7 완전한 복원 오케스트레이션</a>

이제 모든 복원 단계를 종합하고 압축 후 상태 복원의 전체 조정을 살펴보겠습니다(`compact.ts` 행 517-585).

``` mermaid
flowchart TD
    subgraph Step1["Step 1: Snapshot and Clear"]
        S1A["cacheToObject(readFileState)<br/>Save file state snapshot"]
        S1B["readFileState.clear()<br/>Clear file cache"]
        S1C["loadedNestedMemoryPaths.clear()<br/>Clear memory paths"]
        S1A --> S1B --> S1C
    end

    subgraph Step2["Step 2: Generate Attachments in Parallel"]
        S2A["createPostCompactFileAttachments<br/>File restoration attachments"]
        S2B["createAsyncAgentAttachmentsIfNeeded<br/>Async agent attachments"]
    end

    subgraph Step3["Step 3: Generate Attachments Sequentially"]
        S3A["createPlanAttachmentIfNeeded<br/>Plan content attachment"]
        S3B["createPlanModeAttachmentIfNeeded<br/>Plan mode attachment"]
        S3C["createSkillAttachmentIfNeeded<br/>Invoked skills attachment"]
        S3A --> S3B --> S3C
    end

    subgraph Step4["Step 4: Delta Full Replay"]
        S4A["getDeferredToolsDeltaAttachment<br/>Deferred tools"]
        S4B["getAgentListingDeltaAttachment<br/>Agent listing"]
        S4C["getMcpInstructionsDeltaAttachment<br/>MCP instructions"]
    end

    Step1 --> Step2
    Step2 --> Step3
    Step3 --> Step4
    Step4 --> Step5["Step 5: Merge into postCompactFileAttachments<br/>Sent with the first post-compaction message to the model"]
```

이 오케스트레이션의 주요 특징은 **계층화되고 선택적**입니다. 모든 상태가 복원되는 것은 아니며 복원 방법도 다릅니다. 파일은 디스크에서 다시 읽어서 복원되고, 기술은 잘린 재주입을 통해 복원되고, 계획은 전용 첨부 파일을 통해 복원되고, 도구 선언은 델타 재생을 통해 복원됩니다. 각 상태 유형에는 가장 적합한 복원 채널이 있습니다.

------------------------------------------------------------------------

## <a href="#108-what-users-can-do" class="header">10.8 사용자가 할 수 있는 일</a>

압축 후 복원 메커니즘을 이해하면 다음 전략을 채택하여 장기 세션 경험을 최적화할 수 있습니다.

### <a href="#1081-keep-file-reads-focused" class="header">10.8.1 파일 읽기에 집중하기</a>

압축 후에는 가장 최근에 읽은 5개의 파일만 복원됩니다. 모델이 한 대화에서 20개의 파일을 읽도록 한 경우 마지막 5개 파일만 자동으로 복원됩니다. 이는 대화의 전반부에서 모델을 읽은 "참조 파일"(테스트 케이스, 유형 정의, 구성 파일)이 압축 후에 모두 손실될 가능성이 있음을 의미합니다.

**전략**: 복잡한 작업을 실행할 때 "모든 관련 파일을 먼저 읽는 것"보다는 모델이 **다음에 편집해야 하는** 파일을 읽도록 우선순위를 정하세요. 마지막으로 읽은 파일은 압축 후에도 보존될 가능성이 높습니다. 파일이 작업에 중요하지만 한동안 읽지 않은 경우 압축이 가까워지고 있음을 감지하면(예: 대화가 30회 이상 진행된 경우) 모델이 해당 파일을 다시 읽고 타임스탬프를 새로 고치도록 하는 것이 좋습니다.

### <a href="#1082-truncation-expectations-for-large-files"
class="header">10.8.2 대용량 파일에 대한 잘림 예상</a>

각 파일 복원은 5K 토큰(언어에 따라 약 2,000~2,500줄의 코드)으로 제한됩니다. 크기가 큰 파일을 편집하는 경우 모델은 압축 후 파일의 시작 부분만 볼 수 있습니다.

**전략**: 압축이 발생할 수 있는 지점(대화의 길이가 매우 길어진 경우)에서는 모델이 대용량 파일의 특정 영역에 집중하도록 명시적으로 상기시킵니다. 또는 더 나은 방법은 `CLAUDE.md`에 키 제약 조건을 작성하는 것입니다. 압축의 영향을 받지 않습니다.

### <a href="#1083-post-compaction-skill-behavior-changes"
class="header">10.8.3 압축 후 스킬 동작 변경</a>

스킬이 5K 토큰으로 잘린 후 파일 끝에 있는 참조 콘텐츠가 손실될 수 있습니다. 압축 후 스킬의 동작이 변경되는 경우 이는 잘림으로 인한 것일 수 있습니다.

**전략**: 가장 중요한 기술 지침을 기술 파일의 끝이 아닌 **시작**에 배치하세요. Claude Code의 잘림 전략은 헤드를 보존합니다. 즉, 기술 파일은 "중요 지침을 먼저, 보충 참조를 나중에"로 구성해야 합니다.

### <a href="#1084-using-plan-mode-to-survive-compaction"
class="header">10.8.4 압축에서 살아남기 위해 계획 모드 사용</a>

다단계 작업을 실행하는 경우 계획 모드를 사용하면 압축 후 계획이 완전히 보존됩니다. 계획 첨부 파일에는 50K 파일 예산이 적용되지 않습니다. 자체적인 독립적인 복원 채널이 있습니다.

**전략**: 압축 경계에 걸쳐 있을 수 있는 복잡한 작업의 경우 모델이 먼저 계획(`/plan`)을 만든 다음 단계별로 실행하도록 합니다. 실행 중에 압축이 발생하더라도 모델은 계획 컨텍스트를 복원하고 작업을 계속할 수 있습니다.

### <a href="#1085-watch-for-post-compaction-amnesia-patterns"
class="header">10.8.5 "다짐 후 기억상실" 패턴을 관찰하세요.</a>

모델이 갑자기 압축된 후 다음과 같은 경우:

- "방금" 읽은 파일을 다시 읽습니다. 이 파일은 순위가 6위 이하일 수 있으며 복원되지 않았습니다.
- 백그라운드 에이전트를 잊어버립니다. 에이전트가 `retrieved` 또는 `pending`로 표시되었는지 확인하세요.
- 더 이상 MCP 도구의 제약 조건을 따르지 않습니다. 일반적으로 델타 재생이 이를 다루지만 극단적인 경우에는 차이가 있을 수 있습니다.
- 이전에 거부된 접근 방식을 다시 제안합니다. 요약은 "거부된 것"보다는 "완료된 것"을 보존하는 경향이 있습니다.

이는 모두 일반적인 엔지니어링 상충 관계입니다. 예산은 제한되어 있으며 100% 복원은 가능하지도 필요하지도 않습니다. 어떤 정보가 압축에서 "생존"하고 어떤 정보가 손실되는지 이해하는 것은 긴 세션을 탐색하는 핵심 기술입니다.

### <a href="#1086-cumulative-effects-of-multiple-compactions"
class="header">10.8.6 다중 압축의 누적 효과</a>

매우 긴 세션은 여러 번의 압축을 거칠 수 있습니다. 각 압축:

- 모든 파일 상태 캐시를 지우고 다시 작성합니다(최대 5개 파일).
- 스킬 콘텐츠를 다시 자릅니다(원래 콘텐츠에서 매번 "잘림 잘림" 없음).
- 델타 첨부 파일을 재생성합니다(전체 재생).

그러나 요약은 **되돌릴 수 없습니다**. 두 번째 압축의 요약은 "첫 번째 요약 + 후속 대화"에서 생성되며 각 패스마다 정보 밀도가 감소합니다. 서너 번 압축한 후에는 대화 시작 부분의 세부 사항을 보존하는 것이 사실상 불가능합니다.

**전략**: 예상되는 매우 긴 작업의 경우 보존해야 할 중요한 정보를 명시적으로 나열하는 사용자 지정 지침과 함께 주요 중간 단계에서 `/compact`를 사전에 사용합니다. 시스템이 자동으로 압축될 때까지 기다리지 마십시오. 이때는 요약의 초점을 제어할 수 없습니다.

------------------------------------------------------------------------

## <a href="#109-summary" class="header">10.9 요약</a>

압축 후 상태 복원은 Claude Code가 "정보 완전성"과 "토큰 경제" 사이에서 균형을 이루는 것을 반영합니다.

1. **스냅샷 지우기 패턴**: 지우기 전에 장면을 저장하여 복원에 기초가 있고 캐시 상태가 일관되는지 확인합니다.
2. **계층화된 예산**: 파일 복원에 50K, 기술 복원에 25K, 독립적인 계획 채널 - 주마다 복원 예산과 전략이 다릅니다.
3. **선택적 복원**: 타임스탬프 정렬 + 제외 규칙 + 예산 관리 - 3개의 필터링 레이어를 통해 가장 가치 있는 콘텐츠만 복원됩니다.
4. **의도적인 비복원**: `sentSkillNames`의 보존은 직관에 어긋나지만 올바른 결정입니다. 4K 토큰 기술 목록 주입 비용이 이점을 초과합니다.
5. **델타 전체 재생**: 전체 재생을 트리거하기 위해 빈 메시지 기록을 전달하는 것은 기존 증분 메커니즘을 영리하게 재사용하는 것입니다.

핵심 통찰: 압축은 "망각"이 아니라 "선택적으로 기억"하는 것입니다. 이 선택의 논리를 이해하면 모델이 압축 후 무엇을 기억하고 무엇을 잊어버릴지 예측하고 이에 따라 워크플로를 조정할 수 있습니다.

------------------------------------------------------------------------

## <a href="#version-evolution-v2191-changes" class="header">버전 진화: v2.1.91 변경 사항</a>

> 다음 분석은 v2.1.88 소스 코드 추론과 결합된 v2.1.91 번들 신호 비교를 기반으로 합니다.

### <a href="#stalereadfilestatehint-and-file-state-tracking"
class="header">staleReadFileStateHint 및 파일 상태 추적</a>

v2.1.91은 도구 결과 메타데이터에 새로운 `staleReadFileStateHint` 필드를 추가합니다. 도구 실행(예: Bash 명령)으로 인해 이전에 읽은 파일의 mtime이 변경되면 시스템은 부실 힌트를 모델에 보냅니다. 이는 이 장에서 설명하는 파일 상태 추적 시스템을 "압축 후 파일 컨텍스트 복원"에서 "한 차례 내 파일 변경 감지"까지 확장합니다.

v2.1.88에서는 `readFileState` 캐시(`cli/print.ts:1147-1177`)가 소스 코드에 이미 존재했습니다. v2.1.91에서는 이를 모델이 인식할 수 있는 출력 필드로 노출합니다.

------------------------------------------------------------------------

## <a href="#version-evolution-v21100-changes" class="header">버전 발전: v2.1.100 변경 사항</a>

> 다음 분석은 v2.1.88 소스 코드 추론과 결합된 v2.1.100 번들 신호 비교를 기반으로 합니다.

### <a href="#tool-result-dedup" class="header">도구 결과 중복 제거</a>

v2.1.100에는 컨텍스트 예산을 크게 최적화하는 도구 결과 중복 제거 메커니즘(`tengu_tool_result_dedup`)이 도입되었습니다. 모델이 동일한 콘텐츠를 반환하는 연속 도구 호출(예: 동일한 파일을 여러 번 읽기)을 수행하면 시스템은 더 이상 전체 결과를 반복적으로 주입하지 않고 짧은 참조 ID로 바꿉니다.

``` javascript
// v2.1.100 bundle reverse engineering — replacement on dedup hit
let H = `<identical to result [r${j}] from your ${$.toolName} call earlier — refer to that output>`;
d("tengu_tool_result_dedup", {
  hit: true,
  toolName: OK(K),
  originalBytes: A,
  savedBytes: A - H.length  // Track bytes saved
});
return { ...q, content: H };

// On dedup miss — register new result
r += 1;
let j = `r${_.counter}`;   // Short ID: r1, r2, r3...
_.seen.set(w, { shortId: j, toolName: K });
```

**작동 방식**: 시스템은 도구 결과 콘텐츠의 djb2 해시로 입력된 `seen` 맵을 유지 관리하고 짧은 ID와 도구 이름을 저장합니다. 중복 제거는 256바이트에서 50,000바이트 사이의 문자열 결과에만 적용됩니다. 너무 짧으면 중복 제거할 가치가 없으며, 너무 길면 이미 잘릴 수 있습니다. 첫 번째 발생은 일반적으로 `[result-id: rN]` 태그가 추가된 상태로 주입됩니다. 후속 동일한 결과는 `<identical to result [rN]...>` 참조로 대체됩니다.

**컨텍스트 예산 영향**: 중복 제거는 대화 기록에서 토큰 소비를 직접적으로 줄입니다. 일반적인 파일 읽기 결과는 수천 개의 토큰일 수 있습니다. 이를 참조로 교체하는 데 드는 비용은 토큰 20개에 불과합니다. `savedBytes` 필드는 정확한 절감액 추적을 제공하여 컨텍스트 관리 관찰 가능성에 새로운 차원을 추가합니다(29장 참조).

이는 이 장에 설명된 압축 후 파일 복원 메커니즘을 보완합니다. "최근 5개 파일"의 압축 후 복원은 모델이 편집 중인 내용을 알 수 있도록 보장하고, 중복 제거는 압축 임계값에 도달하기 전에 중복 콘텐츠가 컨텍스트 예산을 불필요하게 소비하지 않도록 보장합니다.

### <a href="#sdk-toolsdts-changes" class="header">sdk-tools.d.ts 변경 사항</a>

v2.1.100에서는 도구 유형 정의에 두 가지 사소한 조정이 이루어졌습니다.

1. **`originalFile: string` → `string | null`**: 편집 도구의 `originalFile` 필드가 null 허용으로 완화되어 새 파일 생성을 지원합니다(참조할 원본 파일 없음).
2. **`toolStats` 통계 필드**: 비용 분석 및 행동 통찰력을 위한 새로운 7차원 세션 수준 도구 사용 통계(24장의 전체 필드 정의 및 Dream 시스템 상관 분석)
