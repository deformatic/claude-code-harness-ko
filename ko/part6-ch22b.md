# <a
href="#chapter-22b-plugin-system----extension-engineering-from-packaging-to-marketplace"
class="header">22b장: 플러그인 시스템 - 패키징에서 마켓플레이스까지의 확장 엔지니어링</a>

> **포지셔닝**: 이 장에서는 확장 아키텍처의 최상위 컨테이너인 Claude Code의 플러그인 시스템을 분석하고 패키징과 배포부터 시장까지 전체 엔지니어링을 포괄합니다. 전제 조건: 22장. 대상 독자: 패키징에서 마켓플레이스까지 CC 플러그인의 확장 엔지니어링을 이해하려는 독자.

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

22장에서는 스킬 시스템을 분석했습니다. 즉 Claude Code가 마크다운 파일을 모델 실행 가능한 명령으로 변환하는 방법을 분석했습니다. 그러나 기술은 Claude Code의 확장 메커니즘 중 빙산의 일각에 불과합니다. 일련의 스킬, 여러 Hook, 두 개의 MCP 서버 및 일련의 사용자 정의 명령을 배포 가능한 제품으로 패키징하려는 경우 필요한 것은 스킬 시스템이 아니라 **플러그인 시스템**입니다.

플러그인은 Claude Code 확장 아키텍처의 최상위 컨테이너입니다. 이는 "능력을 정의하는 방법"이 아니라 일련의 더 어려운 질문에 답합니다. **능력을 발견하는 방법은 무엇입니까? 그들을 신뢰하는 방법은 무엇입니까? 설치, 업데이트 및 제거 방법은 무엇입니까? 수천 명의 사용자가 서로 방해하지 않고 동일한 플러그인을 사용하도록 하는 방법은 무엇입니까?**

이러한 질문의 엔지니어링 복잡성은 기술 자체를 훨씬 능가합니다. Claude Code는 약 1,700줄의 Zod 스키마를 사용하여 플러그인 매니페스트 형식을 정의하고, 25개의 식별된 통합 오류 유형을 사용하여 로드 오류를 처리하고, 버전이 지정된 캐싱을 사용하여 다양한 플러그인 버전을 격리하고, 저장소를 보호하여 민감한 구성을 분리합니다. 이 인프라는 오픈 소스 생태계와 유사한 폐쇄 소스 AI 에이전트 제품 확장 기능을 제공하며 이것이 이 장에서 분석할 핵심 설계입니다.

22장이 "플러그인 내부에 무엇이 있는지"를 분석했다면, 이번 장은 "플러그인 컨테이너 자체가 어떻게 설계되어 있는지"를 분석한다.

## <a href="#source-code-analysis" class="header">소스 코드 분석</a>

### <a href="#22b1-plugin-manifest-nearly-1700-lines-of-zod-schema-design"
class="header">22b.1 플러그인 매니페스트: 약 1,700줄의 Zod 스키마 디자인</a>

플러그인에 관한 모든 것은 플러그인의 메타데이터와 플러그인이 제공하는 모든 구성 요소를 정의하는 JSON 매니페스트 파일인 `plugin.json`로 시작됩니다. 이 매니페스트의 유효성 검사 스키마는 1,681줄(`schemas.ts`)을 사용하므로 Claude Code에서 가장 큰 단일 스키마 정의가 됩니다.

매니페스트의 최상위 구조는 11개의 하위 스키마로 구성됩니다.

``` typescript
// restored-src/src/utils/plugins/schemas.ts:884-898
export const PluginManifestSchema = lazySchema(() =>
  z.object({
    ...PluginManifestMetadataSchema().shape,
    ...PluginManifestHooksSchema().partial().shape,
    ...PluginManifestCommandsSchema().partial().shape,
    ...PluginManifestAgentsSchema().partial().shape,
    ...PluginManifestSkillsSchema().partial().shape,
    ...PluginManifestOutputStylesSchema().partial().shape,
    ...PluginManifestChannelsSchema().partial().shape,
    ...PluginManifestMcpServerSchema().partial().shape,
    ...PluginManifestLspServerSchema().partial().shape,
    ...PluginManifestSettingsSchema().partial().shape,
    ...PluginManifestUserConfigSchema().partial().shape,
  }),
)
```

`MetadataSchema`를 제외하고 나머지 10개의 하위 스키마는 모두 `.partial()`를 사용합니다. 즉, 플러그인이 모든 하위 세트를 제공할 수 있다는 의미입니다. 후크 전용 플러그인과 완전한 툴체인을 제공하는 플러그인은 동일한 매니페스트 형식을 공유하며 단지 서로 다른 필드를 채웁니다.

``` mermaid
graph TB
    M["plugin.json<br/>PluginManifest"]
    M --> Meta["Metadata<br/>name, version, author,<br/>keywords, dependencies"]
    M --> Hooks["Hooks<br/>hooks.json or inline"]
    M --> Cmds["Commands<br/>commands/*.md"]
    M --> Agents["Agents<br/>agents/*.md"]
    M --> Skills["Skills<br/>skills/**/SKILL.md"]
    M --> OS["Output Styles<br/>output-styles/*"]
    M --> Channels["Channels<br/>MCP message injection"]
    M --> MCP["MCP Servers<br/>config or .mcp.json"]
    M --> LSP["LSP Servers<br/>config or .lsp.json"]
    M --> Settings["Settings<br/>preset values"]
    M --> UC["User Config<br/>prompt user at install"]

    style M fill:#e3f2fd
    style Meta fill:#fff3e0
    style UC fill:#fce4ec
```

이 디자인에서 주목할 만한 점은 세 가지입니다.

**첫 번째, 경로 보안 유효성 검사.** 매니페스트의 모든 파일 경로는 `./`로 시작해야 하며 `..`를 포함할 수 없습니다. 이는 플러그인이 경로 탐색을 통해 호스트 시스템의 다른 파일에 액세스하는 것을 방지합니다.

**두 번째, 마켓플레이스 이름 예약.** 매니페스트 유효성 검사는 마켓플레이스 이름에 여러 필터링 레이어를 적용합니다.

``` typescript
// restored-src/src/utils/plugins/schemas.ts:19-28
export const ALLOWED_OFFICIAL_MARKETPLACE_NAMES = new Set([
  'claude-code-marketplace',
  'claude-code-plugins',
  'claude-plugins-official',
  'anthropic-marketplace',
  'anthropic-plugins',
  'agent-skills',
  'life-sciences',
  'knowledge-work-plugins',
])
```

유효성 검사 체인에는 공백 없음, 경로 구분 기호 없음, 공식 이름 가장 없음, 예약된 이름 없음 `inline`(`--plugin-dir` 세션 플러그인용) 또는 `builtin`(내장 플러그인용)가 포함됩니다. 모든 검증은 Zod의 `.refine()` 체인 표현식을 사용하여 `MarketplaceNameSchema`(216-245행)에서 완료됩니다.

**셋째, 명령을 인라인으로 정의할 수 있습니다.** 파일에서 로드하는 것 외에도 `CommandMetadataSchema`를 통해 명령을 인라인할 수도 있습니다.

``` typescript
// restored-src/src/utils/plugins/schemas.ts:385-416
export const CommandMetadataSchema = lazySchema(() =>
  z.object({
      source: RelativeCommandPath().optional(),
      content: z.string().optional(),
      description: z.string().optional(),
      argumentHint: z.string().optional(),
      // ...
  }),
)
```

`source`(파일 경로) 및 `content`(인라인 마크다운)은 상호 배타적입니다. 이를 통해 추가 Markdown 파일을 생성하지 않고도 작은 플러그인이 `plugin.json`에 직접 명령 내용을 포함할 수 있습니다.

### <a href="#22b2-lifecycle-5-phases-from-discovery-to-component-loading"
class="header">22b.2 라이프사이클: 검색부터 구성요소 로딩까지 5단계</a>

플러그인은 디스크에 있는 파일부터 Claude Code에서 사용되기까지 5단계를 거칩니다.

``` mermaid
flowchart LR
    A["Discover<br/>marketplace or<br/>--plugin-dir"] --> B["Install<br/>git clone / npm /<br/>copy to versioned cache"]
    B --> C["Validate<br/>Zod Schema<br/>parse plugin.json"]
    C --> D["Load<br/>Hooks / Commands /<br/>Skills / MCP / LSP"]
    D --> E["Enable<br/>Write to settings.json<br/>Register components to runtime"]

    style A fill:#e3f2fd
    style C fill:#fff3e0
    style E fill:#e8f5e9
```

**검색 단계**에는 두 가지 소스가 있습니다(우선순위에 따라).

``` typescript
// restored-src/src/utils/plugins/pluginLoader.ts:1-33
// Plugin Discovery Sources (in order of precedence):
// 1. Marketplace-based plugins (plugin@marketplace format in settings)
// 2. Session-only plugins (from --plugin-dir CLI flag or SDK plugins option)
```

**설치 단계**의 핵심 설계는 **버전 관리 캐싱**입니다. 각 플러그인은 원래 위치에서 실행되지 않고 `~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/`에 복사됩니다. 이는 동일한 플러그인의 다른 버전이 간섭하지 않음을 보장합니다. 제거하려면 캐시 디렉터리만 삭제하면 됩니다. 오프라인 시나리오는 캐시에서 부팅할 수 있습니다.

**로딩 단계**에서는 `memoize`를 사용하여 각 구성 요소가 한 번만 로드되도록 합니다. `getPluginCommands()` 및 `getPluginSkills()`는 모두 메모된 비동기 공장 기능입니다. 이는 에이전트 성능에 중요합니다. 모든 도구 호출에서 후크가 실행될 수 있으며 매번 Markdown 파일을 다시 구문 분석하면 대기 시간이 누적됩니다.

구성 요소 로딩 우선 순위도 주목할 만합니다. `loadAllCommands()`에서 등록 순서는 다음과 같습니다.

1. 번들 기술(빌드 시 컴파일됨)
2. 내장 플러그인 스킬(내장 플러그인에서 제공하는 스킬)
3. 스킬 디렉터리 명령(사용자 로컬 `~/.claude/skills/`)
4. 워크플로 명령
5. **플러그인 명령**(마켓플레이스에 설치된 플러그인의 명령)
6. 플러그인 스킬
7. 내장 명령

이 순서는 다음을 의미합니다. 사용자 로컬 사용자 정의 기술은 동일한 이름의 플러그인 명령보다 우선합니다. -- 사용자 사용자 정의는 플러그인에 의해 절대 무시되지 않습니다.

### <a href="#22b3-trust-model-layered-trust-and-pre-install-audit"
class="header">22b.3 신뢰 모델: 계층화된 신뢰 및 사전 설치 감사</a>

플러그인 시스템은 에이전트 고유의 신뢰 문제에 직면해 있습니다. 플러그인은 단순히 수동적인 UI 확장이 아닙니다. 플러그인은 후크를 통해 도구 실행 전후에 명령을 주입하고 MCP 서버를 통해 새로운 도구를 제공하며 기술을 통해 모델 동작에 영향을 미칠 수도 있습니다.

Claude Code의 반응은 **계층화된 신뢰**입니다.

**레이어 1: 지속적인 보안 경고.** 플러그인 관리 인터페이스에서 `PluginTrustWarning` 구성 요소가 항상 표시됩니다.

``` typescript
// restored-src/src/commands/plugin/PluginTrustWarning.tsx:1-31
// "Make sure you trust a plugin before installing, updating, or using it"
```

이는 일회성 팝업 확인이 아니라 `/plugin` 관리 인터페이스에 **지속적으로 표시되는** 경고입니다. 사용자는 플러그인 관리 인터페이스에 들어갈 때마다 이를 보게 됩니다. "설치 시 한 번 확인하고 다시 언급하지 않는 것"보다 안전하지만 모든 작업에서 팝업되는 것만큼 방해가 되지는 않습니다.

**레이어 2: 프로젝트 수준 신뢰.** `TrustDialog` 구성 요소는 프로젝트 디렉터리에서 보안 감사를 수행하여 MCP 서버, 후크, bash 권한, API 키 도우미, 위험한 환경 변수 등을 확인합니다. 신뢰 상태는 프로젝트 구성의 `hasTrustDialogAccepted` 필드에 저장되고 디렉터리 계층 구조를 검색합니다. 상위 디렉터리가 신뢰할 수 있는 경우 하위 디렉터리는 신뢰를 상속합니다.

**레이어 3: 민감한 값 격리.** `sensitive: true`로 표시된 플러그인 옵션은 `settings.json`가 아닌 보안 저장소(macOS의 키체인, 다른 플랫폼의 `.credentials.json`)에 저장됩니다.

``` typescript
// restored-src/src/utils/plugins/pluginOptionsStorage.ts:1-13
// Storage splits by `sensitive`:
//   - `sensitive: true`  → secureStorage (keychain on macOS, .credentials.json elsewhere)
//   - everything else    → settings.json `pluginConfigs[pluginId].options`
```

로드 시 두 소스가 병합되며 보안 저장소가 우선적으로 적용됩니다.

``` typescript
// restored-src/src/utils/plugins/pluginOptionsStorage.ts:56-77
export const loadPluginOptions = memoize(
  (pluginId: string): PluginOptionValues => {
    // ...
    // secureStorage wins on collision — schema determines destination so
    // collision shouldn't happen, but if a user hand-edits settings.json we
    // trust the more secure source.
    return { ...nonSensitive, ...sensitive }
  },
)
```

소스 코드 주석은 실용적인 고려 사항을 보여줍니다. `memoize`는 단순한 성능 최적화가 아니라 보안 필요성입니다. 각 키 체인 읽기는 `security find-generic-password` 하위 프로세스(~50-100ms)를 트리거하며 모든 도구 호출에서 Hooks가 실행되는 경우 메모하지 않으면 눈에 띄는 대기 시간이 발생합니다.

### <a
href="#22b4-marketplace-system-discovery-installation-and-dependency-resolution"
class="header">22b.4 마켓플레이스 시스템: 검색, 설치 및 종속성 해결</a>

플러그인 마켓플레이스는 설치 가능한 플러그인 세트를 설명하는 JSON 매니페스트입니다. Marketplace 소스는 9가지 유형을 지원합니다.

``` typescript
// restored-src/src/utils/plugins/schemas.ts:906-907
export const MarketplaceSourceSchema = lazySchema(() =>
  z.discriminatedUnion('source', [
    // url, github, git, npm, file, directory, hostPattern, pathPattern, settings
  ]),
)
```

이러한 유형은 직접 URL부터 GitHub 리포지토리, npm 패키지, 로컬 디렉터리까지 거의 모든 배포 방법을 포괄합니다. `hostPattern` 및 `pathPattern`는 기업 배포 시나리오를 위해 설계된 사용자의 호스트 이름 또는 프로젝트 경로를 기반으로 자동 추천 마켓플레이스를 지원합니다.

Marketplace 로딩은 **우아한 성능 저하**를 사용합니다.

``` typescript
// restored-src/src/utils/plugins/marketplaceHelpers.ts
loadMarketplacesWithGracefulDegradation() // Single marketplace failure doesn't affect others
```

함수 이름 자체는 설계 선언입니다. 다중 소스 시스템에서는 단일 소스의 오류로 인해 전체 시스템을 사용할 수 없게 되어서는 안 됩니다.

**종속성 해결**은 또 다른 중요한 메커니즘입니다. 플러그인은 매니페스트에서 종속성을 선언할 수 있습니다.

``` typescript
// restored-src/src/utils/plugins/schemas.ts:313-318
dependencies: z
  .array(DependencyRefSchema())
  .optional()
  .describe(
    'Plugins that must be enabled for this plugin to function. Bare names (no "@marketplace") are resolved against the declaring plugin\'s own marketplace.',
  ),
```

`my-dep`와 같은 기본 이름은 선언하는 플러그인의 마켓플레이스에서 자동으로 확인되므로 동일한 마켓플레이스에서 종속성을 강제할 때 중복되는 마켓플레이스 이름 작성을 방지합니다.

**설치 범위**는 4가지 수준으로 구분됩니다.

<div class="table-wrapper">

| 범위 | 저장 위치 | 시계 | 일반적인 사용 |
|----|----|----|----|
| `user` | `~/.claude/plugins/` | 모든 프로젝트 | 개인 공용 도구 |
| `project` | `.claude/plugins/` | 모든 프로젝트 협력자 | 팀 표준 도구 |
| `local` | `.claude-code.json` | 현재 세션 | 임시 테스트 |
| `managed` | `managed-settings.json` | 정책 제어 | 기업 통합 관리 |

</div>

이 네 가지 범위의 디자인은 Git의 구성 계층 구조(시스템 -\> 글로벌 -\> 로컬)와 유사하지만 엔터프라이즈 정책 제어를 위해 `managed` 레이어가 추가되었습니다.

### <a
href="#22b5-error-governance-25-error-variants-with-type-safe-handling"
class="header">22b.5 오류 거버넌스: 유형 안전 처리를 갖춘 25가지 오류 변형</a>

대부분의 플러그인 시스템은 "오류 메시지에 '찾을 수 없음'이 포함된 경우"라는 문자열 일치로 오류를 처리합니다. Claude Code는 훨씬 더 엄격한 접근 방식인 **차별적 결합**을 사용합니다.

``` typescript
// restored-src/src/types/plugin.ts:101-283
export type PluginError =
  | { type: 'path-not-found'; source: string; plugin?: string; path: string; component: PluginComponent }
  | { type: 'git-auth-failed'; source: string; plugin?: string; gitUrl: string; authType: 'ssh' | 'https' }
  | { type: 'git-timeout'; source: string; plugin?: string; gitUrl: string; operation: 'clone' | 'pull' }
  | { type: 'network-error'; source: string; plugin?: string; url: string; details?: string }
  | { type: 'manifest-parse-error'; source: string; plugin?: string; manifestPath: string; parseError: string }
  | { type: 'manifest-validation-error'; source: string; plugin?: string; manifestPath: string; validationErrors: string[] }
  // ... 16+ more variants
  | { type: 'marketplace-blocked-by-policy'; source: string; marketplace: string; blockedByBlocklist?: boolean; allowedSources: string[] }
  | { type: 'dependency-unsatisfied'; source: string; plugin: string; dependency: string; reason: 'not-enabled' | 'not-found' }
  | { type: 'generic-error'; source: string; plugin?: string; error: string }
```

25개의 고유한 오류 유형(`lsp-config-invalid`가 두 번 나타나는 26개의 통합 변형), 각각 해당 오류와 관련된 컨텍스트 필드가 있습니다. `git-auth-failed`는 `authType`(ssh 또는 https)를 전달하고, `marketplace-blocked-by-policy`는 `allowedSources`(허용된 소스 목록)를 전달하며, `dependency-unsatisfied`는 `reason`(활성화되지 않거나 찾을 수 없음)를 전달합니다.

소스 코드 주석에는 진보적인 전략도 나와 있습니다.

``` typescript
// restored-src/src/types/plugin.ts:86-99
// IMPLEMENTATION STATUS:
// Currently used in production (2 types):
// - generic-error: Used for various plugin loading failures
// - plugin-not-found: Used when plugin not found in marketplace
//
// Planned for future use (10 types - see TODOs in pluginLoader.ts):
// These unused types support UI formatting and provide a clear roadmap for
// improving error specificity.
```

먼저 완전한 유형을 정의한 다음 점진적으로 구현하십시오. 이것이 "유형 우선" 진화 전략입니다. 22가지 오류 유형을 정의한다고 해서 모든 오류 유형을 즉시 구현할 필요는 없지만 일단 정의되면 새로운 오류 처리 코드는 새로운 문자열 사례를 지속적으로 추가하는 대신 명확한 대상 유형을 갖습니다.

### <a
href="#22b6-auto-update-and-recommendations-three-recommendation-sources"
class="header">22b.6 자동 업데이트 및 권장 사항: 세 가지 권장 사항 소스</a>

플러그인 시스템의 "풀"(사용자 사전 설치) 및 "푸시"(시스템 권장 설치)는 모두 완전한 디자인을 가지고 있습니다.

**자동 업데이트**는 기본적으로 공식 마켓플레이스에 대해서만 활성화되어 있지만 특정 마켓플레이스는 제외됩니다.

``` typescript
// restored-src/src/utils/plugins/schemas.ts:35
const NO_AUTO_UPDATE_OFFICIAL_MARKETPLACES = new Set(['knowledge-work-plugins'])
```

업데이트가 완료된 후 사용자는 알림 시스템을 통해 `/reload-plugins`를 실행하여 새로 고치라는 알림을 받습니다(후크 시스템에 대한 18장 참조). 여기에는 우아한 경쟁 조건 처리가 있습니다. REPL이 마운트되기 전에 업데이트가 완료될 수 있으므로 알림은 `pendingNotification` 대기열 버퍼를 사용합니다.

**추천 시스템**에는 세 가지 소스가 있습니다.

1. **Claude 코드 힌트**: 외부 도구(예: SDK)는 stderr를 통해 `<claude-code-hint />` 태그를 출력합니다. CC는 이를 구문 분석하고 해당 플러그인을 권장합니다.
2. **LSP 감지**: 특정 확장자를 가진 파일을 편집할 때 시스템에 해당 LSP 바이너리가 있지만 관련 플러그인이 설치되지 않은 경우 자동 추천이 발생합니다.
3. **맞춤 권장 사항**: `usePluginRecommendationBase`에서 제공하는 범용 상태 시스템을 통해

세 가지 소스 모두 핵심 제약 조건을 공유합니다. **각 플러그인은 세션당 최대 한 번 권장됩니다**(한 번만 표시 의미). 이는 구성 지속성을 통해 구현됩니다. 이미 권장되는 플러그인 ID는 구성 파일에 기록되어 세션 간 반복을 방지합니다. 추천 메뉴에는 사용자 활성 취소와 다양한 분석 이벤트에 대한 시간 초과 해제를 구별하는 30초 자동 해제 메커니즘도 있습니다.

### <a
href="#22b7-command-migration-pattern-progressive-evolution-from-built-in-to-plugin"
class="header">22b.7 명령 마이그레이션 패턴: 내장에서 플러그인으로 점진적인 진화</a>

Claude Code는 내장 명령을 플러그인으로 점진적으로 마이그레이션하고 있습니다. `createMovedToPluginCommand` 공장 기능은 다음과 같은 진화 전략을 보여줍니다.

``` typescript
// restored-src/src/commands/createMovedToPluginCommand.ts:22-65
export function createMovedToPluginCommand({
  name, description, progressMessage,
  pluginName, pluginCommand,
  getPromptWhileMarketplaceIsPrivate,
}: Options): Command {
  return {
    type: 'prompt',
    // ...
    async getPromptForCommand(args, context) {
      if (process.env.USER_TYPE === 'ant') {
        return [{ type: 'text', text: `This command has been moved to a plugin...` }]
      }
      return getPromptWhileMarketplaceIsPrivate(args, context)
    },
  }
}
```

이 기능은 실용적인 문제를 해결합니다. **마켓플레이스가 아직 공개되지 않은 동안 명령을 마이그레이션하는 방법** 답은 사용자 유형별로 나누는 것입니다. 내부 사용자(`USER_TYPE === 'ant'`)는 플러그인 설치 지침을 보고 외부 사용자는 원래 인라인 프롬프트를 봅니다. 마켓플레이스가 공개되면 `getPromptWhileMarketplaceIsPrivate` 매개변수와 분기 논리를 제거할 수 있습니다.

이미 마이그레이션된 명령에는 `pr-comments`(PR 주석 가져오기) 및 `security-review`(보안 감사)가 포함됩니다. 마이그레이션 후 명령은 `pluginName:commandName` 형식으로 이름이 지정되어 네임스페이스 격리를 유지합니다.

이 패턴의 더 깊은 의미는 다음과 같습니다. **Claude Code는 완전한 기능을 갖춘 단일체에서 플랫폼으로 진화하고 있습니다**. 내장된 명령이 플러그인이 된다는 것은 전체 프로젝트를 포크하지 않고도 커뮤니티에서 이러한 기능을 대체, 확장 또는 재결합할 수 있음을 의미합니다.

### <a href="#22b8-plugins-agent-design-philosophy-significance"
class="header">22b.8 플러그인의 에이전트 디자인 철학 의의</a>

더 높은 수준의 관점으로 돌아갑니다. AI Agent에 플러그인 시스템이 필요한 이유는 무엇입니까?

**전통적인 소프트웨어 플러그인 시스템**(예: VS Code, Vim)은 "사용자가 편집기 동작을 사용자 정의할 수 있도록 허용"(기본적으로 UI 및 기능 확장) 문제를 해결합니다. 그러나 **AI 에이전트의 플러그인 시스템**은 근본적으로 다른 문제인 **에이전트 기능의 런타임 구성성**을 해결합니다.

Claude Code Agent가 각 세션에서 수행할 수 있는 작업은 로드된 도구, 기술 및 후크에 따라 다릅니다. 플러그인 시스템은 이 기능 세트를 동적으로 조정 가능하게 만듭니다.

1. **기능 언로드 가능성**: 사용자는 전체 플러그인을 비활성화하여 관련 기능 그룹을 종료할 수 있습니다. 이는 전통적인 "기능 끄기"가 아닙니다. 에이전트가 런타임 시 인지 및 행동 기능의 전체 차원을 잃게 됩니다.

2. **기능 소스 다양화**: 에이전트 기능은 더 이상 한 조직의 개발 팀에서만 제공되는 것이 아니라 시장의 여러 제공업체에서 제공됩니다. `createMovedToPluginCommand`의 존재는 이러한 방향을 증명합니다. 심지어 Anthropic의 자체 내장 명령도 플러그인으로 마이그레이션되고 있습니다.

3. **기능 경계에 대한 사용자 제어**: 4단계 설치 범위(사용자/프로젝트/로컬/관리)를 통해 다양한 이해관계자가 다양한 수준의 기능 경계를 제어할 수 있습니다. 기업 관리자는 `managed` 정책을 사용하여 허용된 마켓플레이스 및 플러그인을 제한합니다. 프로젝트 리더는 팀 전체 구성을 위해 `project` 범위를 사용합니다. 개발자는 개인 취향에 맞게 `user` 범위를 사용합니다.

4. **기능 전제 조건으로서의 신뢰**: 기존 플러그인 시스템에서 신뢰 확인은 설치 시 일회성 확인입니다. 에이전트 컨텍스트에서는 신뢰가 더 큰 비중을 차지합니다. 신뢰할 수 있는 플러그인은 후크(18장 참조)를 통해 **모든 도구 호출 전후에** 명령을 실행하고 MCP 서버를 통해 모델에 **새 도구**를 제공할 수 있습니다. 이것이 클로드 코드의 신뢰 모델이 일회성이 아닌 계층적이고 연속적인 이유입니다.

이러한 관점에서 `PluginManifest`의 11개 하위 스키마는 단순히 "플러그인이 제공할 수 있는 것을 정의"하는 것이 아니라 **에이전트 기능의 플러그 가능한 11가지 차원**을 정의합니다.

### <a href="#22b9-a-third-path-between-open-source-and-closed-source"
class="header">22b.9 오픈 소스와 폐쇄 소스 사이의 세 번째 경로</a>

Claude Code는 비공개 소스 상용 제품입니다. 그러나 플러그인 시스템은 **폐쇄형 코어 + 개방형 생태계**라는 흥미로운 중간 지점을 만듭니다.

**시장 이름 예약 메커니즘**(섹션 22b.1)은 이 전략의 구체적인 구현을 보여줍니다. 8개의 공식 예약 이름은 ​​Anthropic의 브랜드 네임스페이스를 보호하지만 `MarketplaceNameSchema` 검증 논리는 **의도적으로 간접적인 변형을 차단하지 않습니다**:

``` typescript
// restored-src/src/utils/plugins/schemas.ts:7-13
// This validation blocks direct impersonation attempts like "anthropic-official",
// "claude-marketplace", etc. Indirect variations (e.g., "my-claude-marketplace")
// are not blocked intentionally to avoid false positives on legitimate names.
```

이는 신중하게 고려된 설계입니다. 사칭을 방지할 만큼 엄격하지만 커뮤니티가 자체 마켓플레이스를 구축하기 위해 "claude"라는 단어를 사용하는 것을 억제하지 않을 만큼 관대합니다.

**차별화된 자동 업데이트 전략**에도 이러한 포지셔닝이 반영됩니다. 공식 마켓플레이스는 기본적으로 자동 업데이트가 활성화되어 있고, 커뮤니티 마켓플레이스는 기본적으로 비활성화되어 있습니다. 이는 커뮤니티 마켓플레이스의 존재를 차단하지 않고 공식 마켓플레이스에 배포 이점을 제공합니다.

**`managed` 설치 범위 계층**은 상업적 고려 사항을 더욱 드러냅니다. 기업은 `managed-settings.json`(읽기 전용 정책 파일)를 통해 허용된 마켓플레이스와 플러그인을 제어할 수 있습니다. 이는 승인된 범위 내에서 확장 유연성을 유지하면서 "내 직원은 승인된 플러그인만 사용할 수 있습니다"라는 기업 고객의 요구를 충족합니다.

``` mermaid
graph TB
    subgraph Managed["Managed (Enterprise Policy)"]
        direction TB
        Policy["blockedMarketplaces /<br/>strictKnownMarketplaces"]
        subgraph Official["Official (Anthropic)"]
            direction TB
            OfficialFeatures["Reserved names + default auto-update"]
            subgraph Community["Community"]
                CommunityFeatures["Free to create, no auto-update"]
            end
        end
    end

    style Managed fill:#fce4ec
    style Official fill:#e3f2fd
    style Community fill:#e8f5e9
```

이 3계층 구조를 통해 Claude Code는 상업과 개방 사이의 균형을 찾을 수 있습니다.

- **For Anthropic**: 핵심 제품을 비공개 소스로 유지하고 공식 시장을 통해 품질과 보안을 관리합니다.
- **커뮤니티용**: 완전한 플러그인 API 및 마켓플레이스 메커니즘을 제공하여 제3자 배포를 허용합니다.
- **기업용**: 정책 레이어를 통해 거버넌스 기능을 제공하여 규정 준수 요구 사항을 충족합니다.

에이전트 생태계 빌더를 위한 요점: **생태계 효과를 달성하기 위해 핵심을 오픈 소스화할 필요는 없습니다**. 확장 인터페이스를 열고, 배포 인프라(마켓플레이스)를 제공하고, 거버넌스 메커니즘(신뢰 + 정책)을 설정하기만 하면 커뮤니티가 에이전트를 중심으로 가치를 구축할 수 있습니다.

그러나 이 패턴에는 내재된 위험이 있습니다. **생태계는 플랫폼의 선의에 달려 있습니다**. 플랫폼이 플러그인 API를 강화하거나, 시장 승인을 제한하거나, 배포 규칙을 변경하는 경우 생태계 참가자는 포크 대체가 없습니다. 이는 오픈 소스 기반 거버넌스와 비교할 때 폐쇄형 코어의 근본적인 단점입니다. Claude Code는 현재 개방형 매니페스트 형식과 다중 소스 마켓플레이스 메커니즘을 통해 이러한 위험을 줄이지만, 장기적인 생태계 건전성은 여전히 ​​플랫폼의 거버넌스 약속에 달려 있습니다.

------------------------------------------------------------------------

## <a href="#pattern-distillation" class="header">패턴 증류</a>

### <a href="#pattern-one-manifest-as-contract" class="header">패턴 1: 계약으로 명시</a>

**문제 해결**: 확장 시스템은 런타임 오류 없이 타사 기여를 어떻게 검증합니까?

**코드 템플릿**: 스키마 유효성 검사 라이브러리(예: Zod)를 사용하여 각 필드에 유형, 제약 조건 및 설명이 포함된 전체 매니페스트 형식을 정의합니다. 매니페스트 유효성 검사는 로딩 단계에서 완료되며, 유효성 검사에 실패하면 런타임 예외가 아닌 구조적 오류가 생성됩니다. 모든 파일 경로는 `./`로 시작해야 하며 `..` 탐색은 허용되지 않습니다.

**전제 조건**: 확장 시스템은 신뢰할 수 없는 소스의 구성 파일을 허용합니다.

### <a href="#pattern-two-type-first-evolution" class="header">패턴 2: 유형 우선 진화</a>

**문제 해결**: 모든 오류 사이트를 일회성 리팩토링하지 않고 대규모 시스템에서 오류 처리를 점진적으로 개선하는 방법은 무엇입니까?

**코드 템플릿**: 전체 식별 결합 오류 유형(22종)을 먼저 정의하되 일부 사이트(2종)에서만 사용하고 나머지는 "향후 사용 예정"으로 표시합니다. 새 코드에는 명확한 대상 유형이 있으며 이전 코드는 점진적으로 마이그레이션될 수 있습니다.

**전제 조건**: 팀은 일시적으로 사용되지 않는 유형 정의를 허용하고 이를 "데드 코드"가 아닌 "유형 로드맵"으로 처리합니다.

### <a href="#pattern-three-sensitive-value-shunting" class="header">패턴 3: 민감한 값 전환</a>

**문제 해결**: 플러그인 구성에서 API 키, 비밀번호 및 기타 민감한 값을 안전하게 저장하는 방법은 무엇입니까?

**코드 템플릿**: 스키마의 각 구성 필드를 `sensitive: true/false`로 표시합니다. 저장 중 전환 - 민감한 값은 시스템 보안 저장소(예: macOS 키체인)로 이동하고, 민감하지 않은 값은 일반 구성 파일로 이동합니다. 읽을 때 두 소스를 모두 보안 저장소에 우선적으로 병합합니다. 반복적인 보안 저장소 액세스를 방지하려면 `memoize` 캐싱을 사용하세요.

**전제조건**: 대상 플랫폼은 보안 저장소 API(키체인, 자격 ​​증명 관리자 등)를 제공합니다.

### <a href="#pattern-four-closed-core-open-ecosystem"
class="header">패턴 4: 폐쇄형 코어, 개방형 생태계</a>

**문제 해결**: 비공개 소스 제품은 어떻게 오픈 소스 생태계의 확장 효과를 달성합니까?

**핵심 접근 방식**: 개방형 확장 매니페스트 형식 + 다중 소스 마켓플레이스 검색 + 계층화된 정책 제어(섹션 22b.9의 전체 분석 참조). 주요 디자인: 브랜드 네임스페이스를 예약하되 커뮤니티에서 브랜드 용어를 사용하는 것을 제한하지 마세요. 공식 마켓플레이스는 유통상의 이점이 있지만 제3자 마켓플레이스를 배제하지는 않습니다.

**위험**: 생태계 상태는 플랫폼의 거버넌스 약속에 따라 달라지며 포크 폴백이 없습니다.

**전제조건**: 제품은 이미 생태계를 매력적으로 만들 만큼 충분한 사용자 기반을 갖추고 있습니다.

------------------------------------------------------------------------

## <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

1. **자신만의 플러그인 구축**: `plugin.json`를 생성하고 `commands/`, `skills/`, `hooks/`에 구성 요소 파일을 배치하고 `claude plugin validate`로 매니페스트 형식의 유효성을 검사합니다. 최소한의 단일 후크 플러그인으로 시작한 다음 점차적으로 구성요소를 추가하세요.

2. **플러그인 신뢰 경계 디자인**: 플러그인에 API 키가 필요한 경우 `userConfig`에 `sensitive: true`로 표시하세요. 명령 문자열에 민감한 값을 하드코딩하지 마세요. `${user_config.KEY}` 템플릿 변수를 사용하고 Claude Code의 스토리지 시스템이 보안을 처리하도록 하세요.

3. **설치 범위를 사용하여 팀 도구 관리**: `project` 범위(`.claude/plugins/`)에 팀 표준 도구를 설치하고 `user` 범위에 개인 기본 설정 도구를 설치합니다. 이런 방식으로 `.claude/plugins/`를 Git에 커밋할 수 있으며 팀 구성원은 자동으로 통합 도구 세트를 얻게 됩니다.

4. **자신의 에이전트를 위한 플러그인 시스템을 설계할 때 Claude Code의 계층화를 참조하세요**: 매니페스트 유효성 검사(제3자 입력에 대한 방어) + 버전이 지정된 캐시(격리) + 보안 저장소 전환(민감한 값 보호) + 정책 계층(기업 거버넌스). 이 4개 계층은 실행 가능한 최소 플러그인 인프라입니다.

5. **"명령 마이그레이션" 전략을 고려하세요**: 에이전트에 커뮤니티 유지 관리를 위해 계획된 기능이 내장되어 있는 경우 `createMovedToPluginCommand` 분기 패턴을 참조하세요. 내부 사용자는 먼저 마이그레이션하고 테스트하고 외부 사용자는 기존 환경을 유지한 다음 마켓플레이스가 공개되면 균일하게 전환합니다.
