# <a href="#chapter-16-permission-system" class="header">제 16 장: 허가 시스템</a>

[중국어 원문 보기](../../part5/ch16.html)

> **포지셔닝**: 이 장에서는 Claude Code의 6가지 권한 모드, 3계층 규칙 일치 메커니즘 및 전체 유효성 검사-권한-분류 파이프라인을 분석합니다. 전제 조건: 4장(시작 흐름). 대상 독자: CC의 6가지 권한 모드와 3단계 권한 파이프라인을 이해하려는 독자 또는 자신의 에이전트에 대한 권한 모델을 설계해야 하는 개발자.

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

임의의 셸 명령을 실행하고 사용자 코드베이스의 모든 파일을 읽고 쓸 수 있는 AI 에이전트 — 권한 시스템의 설계 품질에 따라 사용자 신뢰의 상한이 직접적으로 결정됩니다. 너무 관대하면 사용자는 보안 위험에 직면하게 됩니다. 악의적인 프롬프트 삽입은 `rm -rf /`를 트리거하거나 SSH 키를 훔칠 수 있습니다. 너무 제한적이며 모든 작업에서 확인 대화 상자가 표시되어 AI 코딩 도우미가 "사람의 지속적인 클릭이 필요한 자동화 도구"로 축소됩니다.

Claude Code의 권한 시스템은 6가지 권한 모드, 3계층 규칙 일치 메커니즘 및 완전한 유효성 검사-권한-분류 파이프라인을 통해 이러한 두 가지 극단 사이의 균형을 찾으려고 시도하며 "안전한 작업은 자동으로 통과하고, 위험한 작업은 수동 확인이 필요하며, 모호한 사례는 AI 분류기에 의해 판정"되는 계층형 제어를 달성합니다.

이 장에서는 이 권한 시스템의 설계와 구현을 철저하게 분석합니다.

------------------------------------------------------------------------

## <a href="#161-six-permission-modes" class="header">16.1 6가지 권한 모드</a>

권한 모드는 전체 시스템의 최고 수준 제어 스위치입니다. 사용자는 Shift+Tab을 통해 모드를 순환하거나 `--permission-mode` CLI 인수를 통해 모드를 지정합니다. 모든 모드는 `types/permissions.ts`에 정의되어 있습니다.

``` typescript
// types/permissions.ts:16-22
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const
```

내부적으로 완전한 유형 통합을 구성하는 두 가지 추가 비공개 모드(`auto` 및 `bubble`)가 있습니다.

``` typescript
// types/permissions.ts:28-29
export type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'
export type PermissionMode = InternalPermissionMode
```

각 모드의 동작 설명은 다음과 같습니다.

<div class="table-wrapper">

| 방법 | 상징 | 행동 | 일반적인 시나리오 |
|----|----|----|----|
| `default` | (없음) | 모든 도구 호출에는 사용자 확인이 필요합니다. | 최초 사용, 높은 보안 환경 |
| `acceptEdits` | `>>` | 작업 디렉토리 내의 파일 편집은 자동으로 전달됩니다. 쉘 명령에는 여전히 확인이 필요합니다 | 일일 코딩 지원 |
| `plan` | `⏸` | AI는 읽고 검색만 할 수 있습니다. 쓰기 작업이 실행되지 않습니다. | 코드 검토, 아키텍처 계획 |
| `bypassPermissions` | `>>` | 모든 권한 확인을 건너뜁니다(안전 확인 제외). | 신뢰할 수 있는 환경에서의 일괄 작업 |
| `dontAsk` | `>>` | 모든 `ask` 결정을 `deny`로 변환합니다. 확인 메시지를 표시하지 않음 | 자동화된 CI/CD 파이프라인 |
| `auto` | `>>` | AI 분류기가 자동으로 판정합니다. 내부 전용 | 인류 내부 발달 |

</div>

각 모드에는 제목, 약어, 기호 및 색상 키가 포함된 해당 구성 개체(`PermissionMode.ts:42-91`)가 있습니다. 특히 `auto` 모드는 `feature('TRANSCRIPT_CLASSIFIER')` 컴파일 타임 기능 게이트를 통해 등록됩니다. 외부 빌드에서 이 코드는 Bun의 데드 코드 제거를 통해 완전히 제거됩니다.

### <a href="#mode-switching-cycle-logic" class="header">모드 전환 주기 논리</a>

`getNextPermissionMode`(`getNextPermissionMode.ts:34-79`)는 Shift+Tab 순환 순서를 정의합니다.

외부 사용자: 기본값 → acceptEdits → 계획 → [bypassPermissions] → 기본값 내부 사용자: 기본값 → [bypassPermissions] → [auto] → 기본값

`auto` 모드가 두 기능을 모두 대체하므로 내부 사용자는 `acceptEdits` 및 `plan`를 건너뜁니다. `bypassPermissions`는 `isBypassPermissionsModeAvailable` 플래그가 `true`인 경우에만 사이클에 나타납니다. `auto` 모드에는 기능 게이트와 런타임 가용성 확인이 모두 필요합니다.

``` typescript
// getNextPermissionMode.ts:17-29
function canCycleToAuto(ctx: ToolPermissionContext): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const gateEnabled = isAutoModeGateEnabled()
    const can = !!ctx.isAutoModeAvailable && gateEnabled
    // ...
    return can
  }
  return false
}
```

### <a href="#side-effects-of-mode-transitions" class="header">모드 전환의 부작용</a>

모드 전환은 열거형 값만 변경하는 것이 아닙니다. `transitionPermissionMode`(`permissionSetup.ts:597-646`)는 전환 부작용을 처리합니다.

1. **계획 모드 진입**: `prepareContextForPlanMode`를 호출하여 현재 모드를 `prePlanMode`에 저장합니다.
2. **자동 모드 시작**: `stripDangerousPermissionsForAutoMode`를 호출하여 위험한 허용 규칙을 제거합니다(자세한 내용은 아래 참조).
3. **자동 모드 종료**: `restoreDangerousPermissions`를 호출하여 제거된 규칙을 복원합니다.
4. **계획 모드 종료**: `hasExitedPlanMode` 상태 플래그를 설정합니다.

------------------------------------------------------------------------

## <a href="#162-permission-rule-system" class="header">16.2 권한 규칙 시스템</a>

권한 모드는 대략적인 스위치입니다. 권한 규칙은 세분화된 제어를 제공합니다. 규칙은 세 부분으로 구성됩니다.

``` typescript
// types/permissions.ts:75-79
export type PermissionRule = {
  source: PermissionRuleSource
  ruleBehavior: PermissionBehavior    // 'allow' | 'deny' | 'ask'
  ruleValue: PermissionRuleValue
}
```

`PermissionRuleValue`는 대상 도구와 선택적 콘텐츠 한정자를 지정합니다.

``` typescript
// types/permissions.ts:67-70
export type PermissionRuleValue = {
  toolName: string
  ruleContent?: string    // e.g., "npm install", "git:*"
}
```

### <a href="#rule-source-hierarchy" class="header">규칙 소스 계층</a>

규칙에는 8개의 소스(`types/permissions.ts:54-62`)가 있으며 가장 높은 우선순위에서 가장 낮은 우선순위로 순위가 매겨집니다.

<div class="table-wrapper">

| 원천 | 위치 | 공유 |
|----|----|----|
| `policySettings` | 엔터프라이즈 관리형 정책 | 모든 사용자에게 푸시됨 |
| `projectSettings` | `.claude/settings.json` | git에 전념하고 팀 공유 |
| `localSettings` | `.claude/settings.local.json` | Gitignored, 로컬 전용 |
| `userSettings` | `~/.claude/settings.json` | 사용자 글로벌 |
| `flagSettings` | `--settings` CLI 인수 | 실행 시간 |
| `cliArg` | `--allowed-tools` 및 기타 CLI 인수 | 실행 시간 |
| `command` | 명령줄 하위 명령 컨텍스트 | 실행 시간 |
| `session` | 세션 중 임시 규칙 | 현재 세션만 |

</div>

### <a href="#rule-string-format-and-parsing" class="header">규칙 문자열 형식 및 구문 분석</a>

규칙은 `ToolName` 또는 `ToolName(content)` 형식으로 구성 파일에 문자열로 저장됩니다. 구문 분석은 이스케이프된 괄호를 처리하는 `permissionRuleParser.ts`의 `permissionRuleValueFromString` 함수(93-133행)에 의해 처리됩니다. 규칙 콘텐츠 자체에 괄호(예: `python -c "print(1)"`)가 포함될 수 있기 때문입니다.

특수 사례: `Bash()` 및 `Bash(*)`는 모두 `Bash`와 동등한 도구 수준 규칙(콘텐츠 한정자 없음)으로 처리됩니다.

------------------------------------------------------------------------

## <a href="#163-three-rule-matching-modes" class="header">16.3 세 가지 규칙 매칭 모드</a>

쉘 명령 권한 규칙은 `shellRuleMatching.ts`의 `parsePermissionRule` 함수(159-184행)에 의해 구별된 통합 유형으로 구문 분석되는 세 가지 일치 모드를 지원합니다.

``` typescript
// shellRuleMatching.ts:25-38
export type ShellPermissionRule =
  | { type: 'exact'; command: string }
  | { type: 'prefix'; prefix: string }
  | { type: 'wildcard'; pattern: string }
```

### <a href="#exact-matching" class="header">정확한 일치</a>

와일드카드가 없는 규칙에는 정확한 명령 일치가 필요합니다.

<div class="table-wrapper">

| 규칙 | 성냥 | 일치하지 않음 |
|---------------|---------------|----------------------|
| `npm install` | `npm install` | `npm install lodash` |
| `git status` | `git status` | `git status --short` |

</div>

### <a href="#prefix-matching-legacy--syntax" class="header">접두사 일치(레거시 <code>:*</code> 구문)</a>

`:*`로 끝나는 규칙은 접두사 일치를 사용합니다. 이는 이전 버전과의 호환성을 위한 레거시 구문입니다.

<div class="table-wrapper">

| 규칙 | 성냥 | 일치하지 않음 |
|---------|--------------------------------------------|------------------------|
| `npm:*` | `npm install`, `npm run build`, `npm test` | `npx create-react-app` |
| `git:*` | `git add .`, `git commit -m "msg"` | `gitk` |

</div>

접두사 추출은 `permissionRuleExtractPrefix`(43-48행)에 의해 수행됩니다. 정규식 `/^(.+):\*$/`는 `:*` 이전의 모든 것을 접두사로 캡처합니다.

### <a href="#wildcard-matching" class="header">와일드카드 일치</a>

이스케이프되지 않은 `*`(후행 `:*` 제외)가 포함된 규칙은 와일드카드 일치를 사용합니다. `matchWildcardPattern`(90-154행)는 패턴을 정규식으로 변환합니다.

<div class="table-wrapper">

| 규칙 | 성냥 | 일치하지 않음 |
|----|----|----|
| `git add *` | `git add .`, `git add src/main.ts`, 베어 `git add` | `git commit` |
| `docker build -t *` | `docker build -t myapp` | `docker run myapp` |
| `echo \*` | `echo *`(문자 그대로 별표) | `echo hello` |

</div>

와일드카드 일치에는 신중하게 설계된 동작이 있습니다. 패턴이 ` *`(공백 + 와일드카드)로 끝나고 전체 패턴에 이스케이프되지 않은 `*`가 하나만 포함된 경우 후행 공백과 인수는 선택 사항입니다. 이는 `git *`가 `git add` 및 기본 `git`(142-145행)와 모두 일치함을 의미합니다. 이는 `git:*`와 같은 접두사 규칙과 일치하는 와일드카드 의미를 유지합니다.

이스케이프 메커니즘은 정규식 변환 중에 `\*`(문자 별표)와 `*`(와일드카드) 간의 혼동을 방지하기 위해 널 바이트 센티널 자리 표시자(14-17행)를 사용합니다.

``` typescript
// shellRuleMatching.ts:14-17
const ESCAPED_STAR_PLACEHOLDER = '\x00ESCAPED_STAR\x00'
const ESCAPED_BACKSLASH_PLACEHOLDER = '\x00ESCAPED_BACKSLASH\x00'
```

------------------------------------------------------------------------

## <a href="#164-validation-permission-classification-pipeline"
class="header">16.4 검증-권한-분류 파이프라인</a>

> **대화형 버전**: [권한 결정 트리 애니메이션을 보려면 클릭하세요](permission-viz.html) — 다양한 도구 호출 시나리오(파일 읽기 / Bash rm / 편집 / .env 쓰기)를 선택하고 요청이 3단계 파이프라인을 통해 어떻게 흐르는지 살펴보세요.

AI 모델이 도구 호출을 시작하면 요청은 3단계 파이프라인을 통과하여 실행 여부를 결정합니다. 핵심 진입점은 `hasPermissionsToUseTool`(`permissions.ts:473`)로, 내부 함수 `hasPermissionsToUseToolInner`를 호출하여 처음 두 단계를 실행한 다음 외부 계층에서 세 번째 단계의 분류자 논리를 처리합니다.

``` mermaid
flowchart TD
    START["Tool call request"] --> S1A{"Step 1a:<br/>Tool-level deny rule?"}
    S1A -- Match --> DENY["❌ deny"]
    S1A -- No match --> S1B{"Step 1b:<br/>Tool-level ask rule?"}
    S1B -- "Match (sandbox can skip)" --> ASK1["⚠️ ask"]
    S1B -- No match --> S1C{"Step 1c:<br/>tool.checkPermissions()"}
    S1C -- deny --> DENY
    S1C -- ask --> ASK1
    S1C -- Pass --> S1E{"Step 1e:<br/>Requires user interaction?"}
    S1E -- Yes --> ASK1
    S1E -- No --> S1F{"Step 1f:<br/>Content-level ask rule?<br/>(bypass-immune)"}
    S1F -- Match --> ASK1
    S1F -- No match --> S1G{"Step 1g:<br/>Safety check<br/>.git/.claude etc?<br/>(bypass-immune)"}
    S1G -- Hit --> ASK1
    S1G -- Pass --> PHASE2

    subgraph PHASE2 ["Phase Two: Mode Adjudication"]
        S2A{"Step 2a:<br/>bypassPermissions?"}
        S2A -- Yes --> ALLOW["✅ allow"]
        S2A -- No --> S2B{"Step 2b:<br/>Tool-level allow rule?"}
        S2B -- Match --> ALLOW
        S2B -- No match --> S2C{"Step 2c:<br/>Tool's own allow?"}
        S2C -- Yes --> ALLOW
        S2C -- No --> ASK2["⚠️ ask"]
    end

    ASK1 --> PHASE3
    ASK2 --> PHASE3

    subgraph PHASE3 ["Phase Three: Mode Post-Processing"]
        MODE{"Current permission mode?"}
        MODE -- dontAsk --> DENY2["❌ deny (never prompt)"]
        MODE -- auto --> CLASSIFIER["🤖 Classifier adjudication"]
        MODE -- default --> DIALOG["💬 Show permission dialog"]
        CLASSIFIER -- Safe --> ALLOW2["✅ allow"]
        CLASSIFIER -- Unsafe --> ASK3["⚠️ ask → dialog"]
    end
```

### <a href="#phase-one-rule-validation" class="header">1단계: 규칙 검증</a>

이것은 가장 방어적인 단계입니다. 모든 종료 경로는 모드 판정보다 우선합니다. 주요 단계:

**1a-1b단계**(`permissions.ts:1169-1206`) 도구 수준 거부 및 요청 규칙을 확인합니다. `Bash`가 전체적으로 거부되면 모든 Bash 명령이 거부됩니다. 도구 수준 질문 규칙에는 한 가지 예외가 있습니다. 샌드박스가 활성화되고 `autoAllowBashIfSandboxed`가 켜져 있으면 샌드박스 명령은 질문 규칙을 건너뛸 수 있습니다.

**1c단계**(`permissions.ts:1214-1223`)는 도구의 자체 `checkPermissions()` 메서드를 호출합니다. 각 도구 유형(Bash, FileEdit, PowerShell 등)은 자체 권한 확인 논리를 구현합니다. 예를 들어 Bash 도구는 명령을 구문 분석하고, 하위 명령을 확인하고, 허용/거부 규칙을 일치시킵니다.

**1f단계**(`permissions.ts:1244-1250`)는 중요한 설계입니다. 콘텐츠 수준 질문 규칙(예: `Bash(npm publish:*)`)은 `bypassPermissions` 모드에서도 메시지를 표시해야 합니다. 이는 사용자가 명시적으로 구성한 질문 규칙이 "게시하기 전에 확인하고 싶습니다."라는 명확한 보안 의도를 나타내기 때문입니다.

**1g단계**(`permissions.ts:1255-1258`)도 마찬가지로 우회 면역입니다. `.git/`, `.claude/`, `.vscode/` 및 셸 구성 파일(`.bashrc`, `.zshrc` 등)에 대한 쓰기 작업에는 항상 확인이 필요합니다.

### <a href="#phase-two-mode-adjudication" class="header">2단계: 모드 판정</a>

도구 호출이 거부되거나 강제로 요청되지 않고 1단계를 통과한 경우 모드 판정으로 들어갑니다. `bypassPermissions` 모드는 이 시점에서 직접 허용됩니다. 다른 모드에서는 허용 규칙과 도구 자체의 허용 결정이 확인됩니다.

### <a href="#phase-three-mode-post-processing" class="header">3단계: 모드 후처리</a>

이는 권한 결정 파이프라인의 마지막 관문입니다. `dontAsk` 모드는 모든 요청 결정을 거부로 변환하여 비대화형 환경에 적합합니다(`permissions.ts:505-517`). `auto` 모드는 전체 권한 시스템에서 가장 복잡한 경로인 판정을 위한 AI 분류기를 시작합니다(아래에 자세히 설명되어 있음).

------------------------------------------------------------------------

## <a
href="#165-isdangerousbashpermission-protecting-the-classifiers-safety-boundary"
class="header">16.5 <code>isDangerousBashPermission()</code>: 분류자의 안전 경계 보호</a>

사용자가 다른 모드에서 `auto` 모드로 전환하면 시스템은 `stripDangerousPermissionsForAutoMode`를 호출하여 특정 허용 규칙을 일시적으로 제거합니다. 스트립된 규칙은 삭제되지 않지만 `strippedDangerousRules` 필드에 저장되며 자동 모드를 종료하면 복원됩니다.

규칙이 "위험"한지 여부를 결정하는 핵심 기능은 `isDangerousBashPermission`(`permissionSetup.ts:94-147`)입니다.

``` typescript
// permissionSetup.ts:94-107
export function isDangerousBashPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (toolName !== BASH_TOOL_NAME) { return false }
  if (ruleContent === undefined || ruleContent === '') { return true }
  const content = ruleContent.trim().toLowerCase()
  if (content === '*') { return true }
  // ...check DANGEROUS_BASH_PATTERNS
}
```

위험한 규칙 패턴에는 다음과 같은 5가지 형태가 있습니다.

1. **도구 수준 허용**: `Bash`(ruleContent 없음) 또는 `Bash(*)` — 모든 명령 허용
2. **독립형 와일드카드**: `Bash(*)` — 도구 수준 허용과 동일
3. **인터프리터 접두사**: `Bash(python:*)` ​​— 임의의 Python 코드 실행을 허용합니다.
4. **통역사 와일드카드**: `Bash(python *)` — 위와 동일
5. **플래그 와일드카드가 있는 해석기**: `Bash(python -*)` — `python -c 'arbitrary code'` 허용

위험한 명령 접두사는 `dangerousPatterns.ts:44-80`에 정의되어 있습니다.

``` typescript
// dangerousPatterns.ts:44-80
export const DANGEROUS_BASH_PATTERNS: readonly string[] = [
  ...CROSS_PLATFORM_CODE_EXEC,  // python, node, ruby, perl, ssh, etc.
  'zsh', 'fish', 'eval', 'exec', 'env', 'xargs', 'sudo',
  // Additional Anthropic-internal patterns...
]
```

크로스 플랫폼 코드 실행 진입점(`CROSS_PLATFORM_CODE_EXEC`, 18-42행)은 모든 주요 스크립트 해석기(python/node/ruby/perl/php/lua), 패키지 실행기(npx/bunx/npm run), 셸(bash/sh) 및 원격 명령 실행 도구(ssh)를 포함합니다.

내부 사용자에는 `gh`, `curl`, `wget`, `git`, `kubectl`, `aws` 등이 추가로 포함됩니다. 이는 `process.env.USER_TYPE === 'ant'` 게이트에 의해 외부 빌드에서 제외됩니다.

PowerShell에는 PowerShell 관련 위험한 명령(`Invoke-Expression`, `Start-Process`, `Add-Type`, `New-Object` 등)을 추가로 감지하고 `.exe` 접미사 변형(`python.exe`, `npm.exe`).

------------------------------------------------------------------------

## <a href="#166-path-permission-validation-and-unc-protection"
class="header">16.6 경로 권한 유효성 검사 및 UNC 보호</a>

파일 작업 권한 유효성 검사는 `pathValidation.ts`의 `validatePath` 함수(373-485행)에 의해 실행됩니다. 이는 다단계 보안 파이프라인입니다.

### <a href="#path-validation-pipeline" class="header">경로 검증 파이프라인</a>

입력 경로 │ ├─ 1. 따옴표 제거, 확장 ~ ──→ cleanPath ├─ 2. UNC 경로 감지 ──→ 일치하면 거부 ├─ 3. 위험한 물결표 변형 감지(~root, ~+, ~-) ──→ 일치하면 거부 ├─ 4. 셸 확장 구문 감지($VAR, %VAR%) ──→ 일치하면 거부 ├─ 5. Glob 패턴 감지 ──→ 쓰기 거부; 읽기를 위한 기본 디렉터리 검증 ├─ 6. 절대 경로 확인 + 심볼릭 링크 확인 └─ 7. isPathAllowed() 다단계 확인

### <a href="#unc-path-ntlm-leak-protection" class="header">UNC 경로 NTLM 누출 방지</a>

Windows에서 애플리케이션이 UNC 경로(예: `\\attacker-server\share\file`)에 액세스하면 운영 체제는 인증을 위해 자동으로 NTLM 인증 자격 증명을 보냅니다. 공격자는 이 메커니즘을 악용할 수 있습니다. 즉각적인 주입을 통해 AI가 악의적인 서버를 가리키는 UNC 경로를 읽거나 쓰게 함으로써 사용자의 NTLM 해시를 훔칠 수 있습니다.

`containsVulnerableUncPath`(`shell/readOnlyCommandValidation.ts:1562`)는 세 가지 UNC 경로 변형을 감지합니다.

``` typescript
// readOnlyCommandValidation.ts:1562-1596
export function containsVulnerableUncPath(pathOrCommand: string): boolean {
  if (getPlatform() !== 'windows') { return false }

  // 1. Backslash UNC: \\server\share
  const backslashUncPattern = /\\\\[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i

  // 2. Forward-slash UNC: //server/share (excluding :// in URLs)
  const forwardSlashUncPattern = /(?<!:)\/\/[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i

  // 3. Mixed separators: /\\server (Cygwin/bash environments)
  // ...
}
```

두 번째 정규식은 `(?<!:)` 부정형 뒤돌아보기를 사용하여 `https://`와 같은 URL을 제외합니다. 이는 합법적인 이중 슬래시 사용 사례입니다. 호스트 이름 패턴 `[^\s\\/]+`는 문자 화이트리스트 대신 제외 세트를 사용하여 유니코드 동형 문자 공격을 포착합니다(예: 라틴어 'a'를 키릴 문자 'а'로 대체).

### <a href="#toctou-protection" class="header">TOCTOU 보호</a>

경로 검증은 또한 여러 TOCTOU(Time-of-Check-to-Time-of-Use) 공격을 방어합니다.

- **위험한 물결표 변형**(401-411행): `~root`는 검증 중에 `/cwd/~root/...`에 대한 상대 경로로 확인되지만 Shell은 실행 시 이를 `/var/root/...`로 확장합니다.
- **셸 변수 확장**(423-436행): `$HOME/.ssh/id_rsa`는 검증 중에는 리터럴 문자열이지만 Shell은 실행 시 이를 실제 경로로 확장합니다.
- **Zsh는 확장과 동일**(동일): `=rg`는 Zsh에서 `/usr/bin/rg`로 확장됩니다.

이러한 모든 경우는 수동 사용자 확인이 필요한 특정 문자(`$`, `%`, `=`)가 포함된 경로를 거부함으로써 방어됩니다.

### <a href="#ispathallowed-multi-step-check"
class="header"><code>isPathAllowed()</code> 다단계 확인</a>

경로 삭제 후 `isPathAllowed`(`pathValidation.ts:141-263`)는 최종 권한 판정을 수행합니다.

1. **거부 규칙이 우선적으로 적용됨**: 일치하는 거부 규칙이 있으면 즉시 거부됩니다.
2. **내부 편집 가능한 경로**: `~/.claude/` 아래의 계획 파일, 스크래치패드, 에이전트 메모리 및 기타 내부 경로는 자동으로 편집이 허용됩니다.
3. **안전 확인**: 위험한 디렉터리(`.git/`, `.claude/`)에 대한 쓰기 작업과 셸 구성 파일에 확인을 위한 플래그가 지정됩니다.
4. **작업 디렉터리 확인**: 경로가 허용된 작업 디렉터리 내에 있으면 `read` 작업이 자동으로 전달됩니다. `write` 작업에는 `acceptEdits` 모드가 필요합니다.
5. **샌드박스 쓰기 허용 목록**: 샌드박스가 활성화되면 구성된 쓰기 가능 디렉터리가 자동으로 허용됩니다.
6. **허용 규칙**: 허용 규칙이 일치하면 권한이 부여됩니다.

------------------------------------------------------------------------

## <a href="#167-auto-modes-classifier-pipeline" class="header">16.7 자동 모드의 분류자 파이프라인</a>

권한 모드가 `auto`이고 도구 호출이 3단계의 요청 결정에 도달하면 시스템은 AI 판정을 위한 YOLO 분류자(`yoloClassifier.ts`)를 시작합니다. 분류기의 설계 철학은 다음과 같습니다. 대부분의 경우 AI는 작업이 안전한지 여부를 결정할 수 있습니다.

### <a href="#safe-tool-whitelist" class="header">안전한 도구 화이트리스트</a>

모든 도구가 분류기를 통과할 필요는 없습니다. `classifierDecision.ts`는 읽기 전용 작업(FileRead, Grep, Glob), 메타데이터 작업(작업 관련 도구) 및 UI 도구(EnterPlanMode, AskUserQuestion)를 포함하는 안전 화이트리스트(`SAFE_YOLO_ALLOWLISTED_TOOLS`, 56-94행)를 정의합니다. 화이트리스트에 있는 도구는 직접 허용됩니다.

### <a href="#acceptedits-fast-path" class="header">acceptEdits 빠른 경로</a>

분류자를 호출하기 전에 시스템은 `acceptEdits` 모드 검사(`permissions.ts:600-648`)를 시뮬레이션합니다. 도구가 `acceptEdits` 모드에서 허용되는 경우(예: 작업 디렉터리 내의 파일 편집) 분류자를 건너뛰고 권한이 직접 부여됩니다. 이렇게 하면 불필요한 API 호출을 피할 수 있습니다. 그러나 `Agent`(하위 에이전트) 및 `REPL`(코드 실행) 도구는 명시적으로 제외됩니다. 경로만으로는 안전성을 결정할 수 없습니다.

### <a href="#consecutive-denial-tracking" class="header">연속 거부 추적</a>

`denialTracking.ts`는 연속 거부 카운터를 구현합니다. 분류자가 작업을 여러 번 연속으로 거부하면 시스템은 잠재적인 분류자의 잘못된 판단에 대한 안전망인 수동 프롬프트 모드로 저하됩니다. 도구 호출이 성공할 때마다 카운터가 재설정됩니다.

### <a href="#the-classifiers-two-stage-architecture" class="header">분류자의 2단계 아키텍처</a>

YOLO 분류기(`yoloClassifier.ts`)는 2단계 결정 프로세스를 사용합니다.

1. **1단계(빠름)**: 저지연 모델이 빠른 판단을 내립니다.
2. **2단계(사고)**: 1단계가 불확실할 때 더 강력한 모델이 더 심층적인 분석을 수행합니다.

분류자는 현재 세션 컨텍스트(도구 호출 기록, 사용자 메시지)와 판정을 기다리는 명령을 수신하고 `shouldBlock` 부울과 이유 설명을 반환합니다. 결과 구조에는 후속 분석을 위한 자세한 원격 분석 필드(토큰 사용량, 대기 시간, 요청 ID)가 포함되어 있습니다.

------------------------------------------------------------------------

## <a href="#168-dangerous-file-and-directory-protection"
class="header">16.8 위험한 파일 및 디렉토리 보호</a>

`filesystem.ts`는 보호된 개체의 두 가지 범주를 정의합니다.

``` typescript
// filesystem.ts:57-79
export const DANGEROUS_FILES = [
  '.gitconfig', '.gitmodules',
  '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile',
  '.ripgreprc', '.mcp.json', '.claude.json',
] as const

export const DANGEROUS_DIRECTORIES = [
  '.git', '.vscode', '.idea', '.claude',
] as const
```

다음 파일과 디렉터리는 코드 실행이나 데이터 추출에 사용될 수 있습니다.

- `.gitconfig`는 임의 코드를 실행하도록 `core.sshCommand`를 구성할 수 있습니다.
- `.bashrc`/`.zshrc`는 Shell이 ​​시작될 때마다 자동으로 실행됩니다.
- `.vscode/settings.json`는 작업을 구성하고 터미널에서 자동 실행이 가능합니다.

이러한 경로에 대한 쓰기 작업은 `checkPathSafetyForAutoEdit`에서 `safetyCheck` 유형으로 표시되며 우회 내성이 있습니다. `bypassPermissions` 모드에서도 사용자 확인이 필요합니다. 그러나 `auto` 모드에서는 일부 안전 검사(예: 민감한 파일 경로)가 `classifierApprovable: true`로 표시되어 컨텍스트가 충분할 때 분류자가 자동으로 승인할 수 있습니다.

### <a href="#dangerous-removal-path-detection" class="header">위험한 제거 경로 감지</a>

`isDangerousRemovalPath`(`pathValidation.ts:331-367`)는 루트 디렉터리, 홈 디렉터리, Windows 드라이브 루트 및 직계 하위 항목(`/usr`, `/tmp`, `C:\Windows`)의 삭제를 방지합니다. 또한 경로 구분 기호 표준화도 처리합니다. Windows 환경에서는 `C:\\Windows`와 `C:/Windows`가 모두 올바르게 식별됩니다.

------------------------------------------------------------------------

## <a href="#169-shadowed-rule-detection" class="header">16.9 섀도잉 규칙 감지</a>

사용자가 모순되는 권한 규칙을 구성하는 경우(예: 프로젝트 설정에서는 `Bash`를 거부하지만 로컬 설정에서는 `Bash(git:*)`를 허용) 허용 규칙이 적용되지 않습니다. `shadowedRuleDetection.ts`의 `UnreachableRule` 유형(19-25행)은 다음과 같은 경우를 기록합니다.

``` typescript
export type UnreachableRule = {
  rule: PermissionRule
  reason: string
  shadowedBy: PermissionRule
  shadowType: ShadowType       // 'ask' | 'deny'
  fix: string
}
```

시스템은 우선 순위가 더 높은 거부/질문 규칙에 의해 가려진 허용 규칙과 이를 수정하는 방법을 감지하고 사용자에게 경고합니다.

------------------------------------------------------------------------

## <a href="#1610-permission-update-persistence" class="header">16.10 권한 업데이트 지속성</a>

권한 업데이트는 `PermissionUpdate` 통합 유형(`types/permissions.ts:98-131`)을 통해 설명되며 `addRules`, `replaceRules`, `removeRules`, `setMode`, `addDirectories`, `removeDirectories`의 6개 작업을 지원합니다. 각 작업은 대상 저장 위치(`PermissionUpdateDestination`)를 지정합니다.

사용자가 권한 대화 상자에서 "항상 허용"을 선택하면 시스템은 일반적으로 `localSettings`(git에 커밋되지 않은 로컬 설정)를 대상으로 하는 `addRules` 업데이트를 생성합니다. 셸 도구의 제안 생성 기능(`shellRuleMatching.ts:189-228`)은 명령 특성을 기반으로 정확한 일치 또는 접두사 일치 제안을 생성합니다.

------------------------------------------------------------------------

## <a href="#1611-design-reflections" class="header">16.11 디자인 반영</a>

Claude Code의 권한 시스템은 몇 가지 주목할만한 디자인 원칙을 보여줍니다.

**심층적인 방어.** 파이프라인 전면에서 규칙 차단을 거부하고 안전 검사에 우회 면역 기능이 있으며 자동 모드는 진입 시 위험한 규칙을 제거합니다. 여러 보호 계층을 통해 단일 실패 지점으로 인해 보안 공백이 발생하지 않도록 합니다.

**안전 의도는 재정의할 수 없습니다.** 사용자가 명시적으로 구성한 질문 규칙(1f단계) 및 시스템 안전 확인(1g단계)은 `bypassPermissions` 모드의 영향을 받지 않습니다. 이 설계는 바이패스 모드(일괄 작업 효율성)의 가치를 인정하는 동시에 사용자가 의도적으로 설정한 안전 경계를 보호합니다.

**TOCTOU 일관성.** 경로 유효성 검사 시스템은 "유효성 검사 시간"과 "실행 시간" 사이에 의미상 차이를 생성할 수 있는 모든 경로 패턴(셸 변수, 물결표 변형, Zsh는 확장과 같음)을 올바르게 구문 분석하기보다는 거부합니다. 즉, "영리한" 호환성 전략보다 안전하고 보수적인 전략을 선택합니다.

**교체가 아닌 안전망으로서의 분류자.** 자동 모드 분류자는 권한 확인을 대체하는 것이 아니라 규칙 검증 후 보충 레이어입니다. 시스템 폭주를 방지하기 위해 연속적인 거부 저하 메커니즘을 통해 "규칙에 명확한 답이 없는" 회색 영역만 처리합니다.

이러한 원칙은 보안과 유용성의 균형을 유지하는 권한 아키텍처를 형성합니다. 과도한 보수주의로 인해 AI 에이전트의 가치가 손실되거나 과도한 신뢰로 인해 사용자가 위험에 노출되지 않습니다.

------------------------------------------------------------------------

## <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

### <a href="#permission-mode-selection-recommendations"
class="header">권한 모드 선택 권장 사항</a>

- **일일 개발**: `acceptEdits` 모드 사용 — 파일 편집이 자동으로 통과되지만 셸 명령에는 여전히 확인이 필요하며 보안과 효율성의 최상의 균형을 유지합니다.
- **코드 검토/아키텍처 탐색**: `plan` 모드 사용 — AI는 읽고 검색만 할 수 있어 우발적인 수정이 발생하지 않습니다.
- **일괄 자동화 작업**: `bypassPermissions` 모드를 사용합니다. 하지만 안전 확인(`.git/`, `.bashrc` 등에 대한 쓰기 작업)에는 여전히 확인이 필요합니다.

### <a href="#rule-configuration-tips" class="header">규칙 구성 팁</a>

- `.claude/settings.json`(프로젝트 수준)를 사용하여 git에 커밋된 팀 공유 허용/거부 규칙을 정의합니다.
- `.claude/settings.local.json`(로컬 수준)를 사용하여 개인 기본 설정 규칙을 정의하고 자동으로 무시됩니다.
- 와일드카드 구문을 사용하여 규칙 단순화: `Bash(git *)`는 모든 git 하위 명령을 허용합니다.
- 거부 규칙을 구성한 후 허용 규칙이 적용되지 않으면 규칙 섀도잉을 확인하세요. 시스템이 섀도잉된 규칙을 표시하고 수정 사항을 제안합니다.

### <a href="#security-considerations" class="header">보안 고려 사항</a>

- `bypassPermissions`가 활성화된 경우에도 `.gitconfig`, `.bashrc`, `.zshrc`와 같은 위험한 파일에 대한 쓰기 작업에는 여전히 확인이 필요합니다. 이는 의도적인 보안 설계입니다.
- `auto` 모드를 사용할 때 시스템은 위험한 Bash 허용 규칙(예: `Bash(python:*)`)을 자동으로 제거합니다. 자동 모드를 종료하면 복원됩니다.
- Shift+Tab으로 언제든지 모드 전환 가능

------------------------------------------------------------------------

## <a href="#version-evolution-v2191-changes" class="header">버전 진화: v2.1.91 변경 사항</a>

> 다음 분석은 v2.1.88 소스 코드 추론과 결합된 v2.1.91 번들 신호 비교를 기반으로 합니다.

### <a href="#auto-mode-formalization" class="header">자동 모드 형식화</a>

v2.1.88에서는 `auto` 모드가 내부 코드(`resetAutoModeOptInForDefaultOffer.ts`, `spawnMultiAgent.ts:227`)에 이미 존재했지만 `sdk-tools.d.ts`의 공개 API 정의에는 나타나지 않았습니다. v2.1.91에는 공식적으로 다음이 포함됩니다.

``` diff
- mode?: "acceptEdits" | "bypassPermissions" | "default" | "dontAsk" | "plan";
+ mode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
```

즉, SDK 사용자는 이제 공개 API를 통해 자동 모드를 명시적으로 요청할 수 있습니다. 즉, TRANSCRIPT_CLASSIFIER에 의해 구동되는 자동 권한 승인입니다.

### <a href="#bash-security-pipeline-simplification" class="header">Bash 보안 파이프라인 단순화</a>

v2.1.91은 tree-sitter WASM AST 파서와 관련된 모든 인프라를 제거합니다.

<div class="table-wrapper">

| 제거된 신호 | 원래 목적 |
|----|----|
| `tengu_tree_sitter_load` | WASM 모듈 로드 추적 |
| `tengu_tree_sitter_security_divergence` | AST 대 정규식 구문 분석 발산 감지 |
| `tengu_tree_sitter_shadow` | 섀도우 모드 병렬 테스트 |
| `tengu_bash_security_check_triggered` | 23개의 보안 검사 트리거 |
| `CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK` | 주입 확인 비활성화 스위치 |

</div>

**제거 이유**: v2.1.88 소스 코드 주석 CC-643은 성능 문제를 문서화했습니다. 복잡한 복합 명령이 `splitCommand`를 트리거하여 지수 하위 명령 배열을 생성하고 각각 트리 시터 구문 분석 + ~20개의 유효성 검사기 + logEvent를 실행하여 이벤트 루프의 마이크로태스크 체인 고갈을 유발하고 REPL 100% CPU 정지를 유발했습니다.

v2.1.91은 순수한 JavaScript 정규식/쉘 인용 구성표로 되돌아갑니다. 이 장의 섹션 16.x에 설명된 `treeSitterAnalysis.ts`(507라인 AST 수준 분석)는 v2.1.88에만 적용됩니다.
