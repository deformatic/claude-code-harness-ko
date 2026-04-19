# <a
href="#chapter-18b-sandbox-system--multi-platform-isolation-from-seatbelt-to-bubblewrap"
class="header">18b장: 샌드박스 시스템 — 안전벨트에서 버블랩까지 다중 플랫폼 격리</a>

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

임의의 쉘 명령을 실행할 수 있는 AI 에이전트는 엄청난 힘을 부여하면서 위험한 문을 엽니다. 프롬프트 삽입으로 조작된 에이전트는 `~/.ssh/id_rsa`를 읽고, 중요한 파일을 외부 서버로 보내거나, 자체 구성 파일을 수정하여 권한 제어를 영구적으로 우회할 수도 있습니다. 16장에서 분석된 권한 시스템은 애플리케이션 계층에서 위험한 작업을 차단하고 17장의 YOLO 분류자는 "빠른 모드"에서 허용 결정을 내립니다. 그러나 이는 모두 "권고" 소프트 경계입니다. 악성 명령이 운영 체제 수준에 도달하면 애플리케이션 계층 차단은 쓸모가 없습니다.

샌드박스는 Claude Code 보안 아키텍처의 마지막 하드 경계입니다. macOS에서는 `sandbox-exec`(안전벨트 프로필), Linux에서는 Bubblewrap(사용자 공간 네임스페이스) + seccomp(시스템 호출 필터링) 등 OS 커널 제공 격리 메커니즘을 활용하여 프로세스 수준에서 파일 시스템 및 네트워크 액세스 제어를 시행합니다. 모든 애플리케이션 계층 방어를 우회하더라도 샌드박스는 승인되지 않은 파일 읽기/쓰기 및 네트워크 액세스를 계속 차단할 수 있습니다.

이 시스템의 엔지니어링 복잡성은 단순한 "구성 옵션 전환"이 제안하는 것보다 훨씬 더 복잡합니다. 이중 플랫폼 차이점(macOS 경로 수준 안전 벨트 구성 대 Linux 바인드 마운트 + seccomp 조합), 5계층 구성 우선 순위 병합 논리, Git Worktrees에 대한 특수 경로 요구 사항, 엔터프라이즈 MDM 정책 잠금 및 실제 보안 취약점(#29316 Bare Git Repo 공격)에 대한 방어를 처리해야 합니다. 이 장에서는 소스 코드에서 이 다중 플랫폼 격리 아키텍처 전체를 분석합니다.

## <a href="#source-code-analysis" class="header">소스 코드 분석</a>

### <a href="#18b1-dual-platform-sandbox-architecture" class="header">18b.1 듀얼 플랫폼 샌드박스 아키텍처</a>

Claude Code의 샌드박스 구현은 두 개의 레이어로 나뉩니다. 외부 패키지 `@anthropic-ai/sandbox-runtime`는 기본 플랫폼별 격리 기능을 제공하는 반면 `sandbox-adapter.ts`는 이를 Claude Code의 설정 시스템, 권한 규칙 및 도구 통합에 연결하는 어댑터 레이어 역할을 합니다.

플랫폼 지원 감지 로직은 memoize를 통해 캐시된 `isSupportedPlatform()`에 있습니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:491-493
const isSupportedPlatform = memoize((): boolean => {
  return BaseSandboxManager.isSupportedPlatform()
})
```

세 가지 범주의 플랫폼이 지원됩니다.

<div class="table-wrapper">

| 플랫폼 | 절연 기술 | 파일 시스템 격리 | 네트워크 격리 |
|----|----|----|----|
| macOS | `sandbox-exec`(안전벨트 프로필) | 프로필 규칙 제어 경로 액세스 | 프로필 규칙 + Unix 소켓 경로 필터링 |
| 리눅스 | 버블랩(bwrap) | 읽기 전용 루트 마운트 + 쓰기 가능한 화이트리스트 바인드 마운트 | seccomp 시스템 호출 필터링 |
| WSL2 | Linux와 동일(Bubblewrap) | 리눅스와 동일 | 리눅스와 동일 |

</div>

WSL1은 전체 Linux 커널 네임스페이스 지원을 제공하지 않으므로 명시적으로 제외됩니다.

``` typescript
// restored-src/src/commands/sandbox-toggle/sandbox-toggle.tsx:14-17
if (!SandboxManager.isSupportedPlatform()) {
  const errorMessage = platform === 'wsl'
    ? 'Error: Sandboxing requires WSL2. WSL1 is not supported.'
    : 'Error: Sandboxing is currently only supported on macOS, Linux, and WSL2.';
```

두 플랫폼 간의 주요 차이점은 **glob 패턴 지원**입니다. macOS의 Seatbelt Profile은 와일드카드 경로 일치를 지원하는 반면 Linux의 Bubblewrap은 정확한 바인드 마운트만 수행할 수 있습니다. `getLinuxGlobPatternWarnings()`는 Linux에서 호환되지 않는 glob 패턴을 감지하고 사용자에게 경고합니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:597-601
function getLinuxGlobPatternWarnings(): string[] {
  const platform = getPlatform()
  if (platform !== 'linux' && platform !== 'wsl') {
    return []
  }
```

### <a href="#18b2-sandboxmanager-the-adapter-pattern" class="header">18b.2 SandboxManager: 어댑터 패턴</a>

`SandboxManager` 디자인은 클래식 어댑터 패턴을 사용합니다. 25개 이상의 메소드로 `ISandboxManager` 인터페이스를 구현합니다. 일부 메소드에는 Claude Code 관련 로직이 포함되어 있고 다른 메소드는 `BaseSandboxManager`(`@anthropic-ai/sandbox-runtime`의 핵심 클래스)로 직접 전달됩니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:880-922
export interface ISandboxManager {
  initialize(sandboxAskCallback?: SandboxAskCallback): Promise<void>
  isSupportedPlatform(): boolean
  isPlatformInEnabledList(): boolean
  getSandboxUnavailableReason(): string | undefined
  isSandboxingEnabled(): boolean
  isSandboxEnabledInSettings(): boolean
  checkDependencies(): SandboxDependencyCheck
  isAutoAllowBashIfSandboxedEnabled(): boolean
  areUnsandboxedCommandsAllowed(): boolean
  isSandboxRequired(): boolean
  areSandboxSettingsLockedByPolicy(): boolean
  // ... plus getFsReadConfig, getFsWriteConfig, getNetworkRestrictionConfig, etc.
  wrapWithSandbox(command: string, binShell?: string, ...): Promise<string>
  cleanupAfterCommand(): void
  refreshConfig(): void
  reset(): Promise<void>
}
```

내보낸 `SandboxManager` 객체는 이러한 계층화를 명확하게 보여줍니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:927-967
export const SandboxManager: ISandboxManager = {
  // Custom implementations (Claude Code-specific logic)
  initialize,
  isSandboxingEnabled,
  areSandboxSettingsLockedByPolicy,
  setSandboxSettings,
  wrapWithSandbox,
  refreshConfig,
  reset,

  // Forward to base sandbox manager (direct forwarding)
  getFsReadConfig: BaseSandboxManager.getFsReadConfig,
  getFsWriteConfig: BaseSandboxManager.getFsWriteConfig,
  getNetworkRestrictionConfig: BaseSandboxManager.getNetworkRestrictionConfig,
  // ...
  cleanupAfterCommand: (): void => {
    BaseSandboxManager.cleanupAfterCommand()
    scrubBareGitRepoFiles()  // CC-specific: clean up Bare Git Repo attack remnants
  },
}
```

초기화 흐름(`initialize()`)은 비동기식이며 신중하게 설계된 경쟁 조건 가드를 포함합니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:730-792
async function initialize(sandboxAskCallback?: SandboxAskCallback): Promise<void> {
  if (initializationPromise) {
    return initializationPromise  // Prevent duplicate initialization
  }
  if (!isSandboxingEnabled()) {
    return
  }
  // Create Promise synchronously (before await) to prevent race conditions
  initializationPromise = (async () => {
    // 1. Resolve Worktree main repo path (once only)
    if (worktreeMainRepoPath === undefined) {
      worktreeMainRepoPath = await detectWorktreeMainRepoPath(getCwdState())
    }
    // 2. Convert CC settings to sandbox-runtime config
    const settings = getSettings_DEPRECATED()
    const runtimeConfig = convertToSandboxRuntimeConfig(settings)
    // 3. Initialize the underlying sandbox
    await BaseSandboxManager.initialize(runtimeConfig, wrappedCallback)
    // 4. Subscribe to settings changes, dynamically update sandbox config
    settingsSubscriptionCleanup = settingsChangeDetector.subscribe(() => {
      const newConfig = convertToSandboxRuntimeConfig(getSettings_DEPRECATED())
      BaseSandboxManager.updateConfig(newConfig)
    })
  })()
  return initializationPromise
}
```

다음 순서도는 초기화부터 명령 실행까지 샌드박스의 전체 수명주기를 보여줍니다.

``` mermaid
flowchart TD
    A[Claude Code Startup] --> B{isSandboxingEnabled?}
    B -->|No| C[Skip Sandbox Initialization]
    B -->|Yes| D[detectWorktreeMainRepoPath]
    D --> E[convertToSandboxRuntimeConfig]
    E --> F[BaseSandboxManager.initialize]
    F --> G[Subscribe to Settings Changes]

    H[Bash Command Arrives] --> I{shouldUseSandbox?}
    I -->|No| J[Execute Directly]
    I -->|Yes| K[SandboxManager.wrapWithSandbox]
    K --> L[Create Sandbox Temp Directory]
    L --> M[Execute in Isolated Environment]
    M --> N[cleanupAfterCommand]
    N --> O[scrubBareGitRepoFiles]

    style B fill:#f9f,stroke:#333
    style I fill:#f9f,stroke:#333
    style O fill:#faa,stroke:#333
```

### <a href="#18b3-configuration-system-five-layer-priority"
class="header">18b.3 구성 시스템: 5계층 우선순위</a>

샌드박스 구성 병합은 Claude Code의 일반적인 5계층 설정 시스템을 상속하지만(CLAUDE.md의 우선순위 논의는 19장 참조) 샌드박스는 그 위에 자체 의미 계층을 추가합니다.

가장 낮은 것부터 가장 높은 것까지 5개의 우선순위 계층은 다음과 같습니다.

``` typescript
// restored-src/src/utils/settings/constants.ts:7-22
export const SETTING_SOURCES = [
  'userSettings',      // Global user settings (~/.claude/settings.json)
  'projectSettings',   // Shared project settings (.claude/settings.json)
  'localSettings',     // Local settings (.claude/settings.local.json, gitignored)
  'flagSettings',      // CLI --settings flag
  'policySettings',    // Enterprise MDM managed settings (managed-settings.json)
] as const
```

샌드박스 구성 스키마는 `sandboxTypes.ts`에서 Zod에 의해 정의되었으며 전체 시스템에 대한 단일 진실 소스 역할을 합니다.

``` typescript
// restored-src/src/entrypoints/sandboxTypes.ts:91-144
export const SandboxSettingsSchema = lazySchema(() =>
  z.object({
    enabled: z.boolean().optional(),
    failIfUnavailable: z.boolean().optional(),
    autoAllowBashIfSandboxed: z.boolean().optional(),
    allowUnsandboxedCommands: z.boolean().optional(),
    network: SandboxNetworkConfigSchema(),
    filesystem: SandboxFilesystemConfigSchema(),
    ignoreViolations: z.record(z.string(), z.array(z.string())).optional(),
    enableWeakerNestedSandbox: z.boolean().optional(),
    enableWeakerNetworkIsolation: z.boolean().optional(),
    excludedCommands: z.array(z.string()).optional(),
    ripgrep: z.object({ command: z.string(), args: z.array(z.string()).optional() }).optional(),
  }).passthrough(),  // .passthrough() allows undeclared fields (e.g., enabledPlatforms)
)
```

뒤에 오는 `.passthrough()`에 주목하세요. 이는 의도적인 설계 결정입니다. `enabledPlatforms`는 `.passthrough()`가 공식 선언 없이 스키마에 존재할 수 있도록 허용하는 문서화되지 않은 엔터프라이즈 설정입니다. 소스 코드 주석은 배경을 드러냅니다.

``` typescript
// restored-src/src/entrypoints/sandboxTypes.ts:104-111
// Note: enabledPlatforms is an undocumented setting read via .passthrough()
// Added to unblock NVIDIA enterprise rollout: they want to enable
// autoAllowBashIfSandboxed but only on macOS initially, since Linux/WSL
// sandbox support is newer and less battle-tested.
```

`convertToSandboxRuntimeConfig()`는 구성 병합의 핵심 기능입니다. 모든 설정 소스를 반복하여 Claude Code의 권한 규칙과 샌드박스 파일 시스템 구성을 `sandbox-runtime`가 이해할 수 있는 통합 형식으로 변환합니다. 키 경로 확인 논리는 이 프로세스 중에 두 가지 다른 경로 규칙을 처리합니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:99-119
export function resolvePathPatternForSandbox(
  pattern: string, source: SettingSource
): string {
  // Permission rule convention: //path → absolute path, /path → relative to settings file directory
  if (pattern.startsWith('//')) {
    return pattern.slice(1)  // "//.aws/**" → "/.aws/**"
  }
  if (pattern.startsWith('/') && !pattern.startsWith('//')) {
    const root = getSettingsRootPathForSource(source)
    return resolve(root, pattern.slice(1))
  }
  return pattern  // ~/path and ./path pass through to sandbox-runtime
}
```

그리고 \#30067 수정 후의 파일 시스템 경로 확인은 다음과 같습니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:138-146
export function resolveSandboxFilesystemPath(
  pattern: string, source: SettingSource
): string {
  // sandbox.filesystem.* uses standard semantics: /path = absolute path (different from permission rules!)
  if (pattern.startsWith('//')) return pattern.slice(1)
  return expandPath(pattern, getSettingsRootPathForSource(source))
}
```

여기에는 미묘하지만 중요한 차이점이 있습니다. 권한 규칙에서 `/path`는 "설정 파일 디렉터리에 상대적"을 의미하고 `sandbox.filesystem.allowWrite`에서 `/path`는 절대 경로를 의미합니다. 이 불일치로 인해 한때 버그 \#30067가 발생했습니다. 사용자는 `sandbox.filesystem.allowWrite`에 `/Users/foo/.cargo`를 절대 경로로 예상했지만 시스템에서는 이를 권한 규칙 규칙에 따라 상대 경로로 해석했습니다.

### <a href="#18b4-filesystem-isolation" class="header">18b.4 파일 시스템 격리</a>

파일 시스템 격리를 위한 핵심 전략은 **읽기 전용 루트 + 쓰기 가능한 화이트리스트**입니다. `convertToSandboxRuntimeConfig()`로 구축된 구성에서 `allowWrite`는 기본적으로 현재 작업 디렉터리와 Claude 임시 디렉터리만 사용합니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:225-226
const allowWrite: string[] = ['.', getClaudeTempDir()]
const denyWrite: string[] = []
```

또한 시스템은 중요한 파일이 샌드박스 명령에 의해 변조되는 것을 방지하기 위해 여러 계층의 하드코딩된 쓰기 거부 규칙을 추가합니다.

**파일 보호 설정** — 샌드박스 이스케이프 방지:

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:232-255
// Deny writing to all layers of settings.json
const settingsPaths = SETTING_SOURCES.map(source =>
  getSettingsFilePathForSource(source),
).filter((p): p is string => p !== undefined)
denyWrite.push(...settingsPaths)
denyWrite.push(getManagedSettingsDropInDir())

// If the user cd'd to a different directory, protect that directory's settings files too
if (cwd !== originalCwd) {
  denyWrite.push(resolve(cwd, '.claude', 'settings.json'))
  denyWrite.push(resolve(cwd, '.claude', 'settings.local.json'))
}

// Protect .claude/skills — skill files have the same privilege level as commands/agents
denyWrite.push(resolve(originalCwd, '.claude', 'skills'))
```

**Git Worktree 지원** — Worktree의 Git 작업은 기본 저장소의 `.git` 디렉터리(예: `index.lock`)에 작성해야 합니다. 시스템은 초기화 중에 작업 트리를 감지하고 기본 저장소 경로를 캐시합니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:422-445
async function detectWorktreeMainRepoPath(cwd: string): Promise<string | null> {
  const gitPath = join(cwd, '.git')
  const gitContent = await readFile(gitPath, { encoding: 'utf8' })
  const gitdirMatch = gitContent.match(/^gitdir:\s*(.+)$/m)
  // gitdir format: /path/to/main/repo/.git/worktrees/worktree-name
  const marker = `${sep}.git${sep}worktrees${sep}`
  const markerIndex = gitdir.lastIndexOf(marker)
  if (markerIndex > 0) {
    return gitdir.substring(0, markerIndex)
  }
}
```

작업 트리가 감지되면 기본 저장소 경로가 쓰기 가능한 화이트리스트에 추가됩니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:286-288
if (worktreeMainRepoPath && worktreeMainRepoPath !== cwd) {
  allowWrite.push(worktreeMainRepoPath)
}
```

**추가 디렉터리 지원** — `--add-dir` CLI 인수 또는 `/add-dir` 명령을 통해 추가된 디렉터리에도 쓰기 권한이 필요합니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:295-299
const additionalDirs = new Set([
  ...(settings.permissions?.additionalDirectories || []),
  ...getAdditionalDirectoriesForClaudeMd(),
])
allowWrite.push(...additionalDirs)
```

### <a href="#18b5-network-isolation" class="header">18b.5 네트워크 격리</a>

네트워크 격리는 Claude Code의 `WebFetch` 권한 규칙과 긴밀하게 통합된 **도메인 화이트리스트** 메커니즘을 사용합니다. `convertToSandboxRuntimeConfig()`는 권한 규칙에서 허용된 도메인을 추출합니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:178-210
const allowedDomains: string[] = []
const deniedDomains: string[] = []

if (shouldAllowManagedSandboxDomainsOnly()) {
  // Enterprise policy mode: only use domains from policySettings
  const policySettings = getSettingsForSource('policySettings')
  for (const domain of policySettings?.sandbox?.network?.allowedDomains || []) {
    allowedDomains.push(domain)
  }
  for (const ruleString of policySettings?.permissions?.allow || []) {
    const rule = permissionRuleValueFromString(ruleString)
    if (rule.toolName === WEB_FETCH_TOOL_NAME && rule.ruleContent?.startsWith('domain:')) {
      allowedDomains.push(rule.ruleContent.substring('domain:'.length))
    }
  }
} else {
  // Normal mode: merge domain configuration from all layers
  for (const domain of settings.sandbox?.network?.allowedDomains || []) {
    allowedDomains.push(domain)
  }
  // ... extract domains from WebFetch(domain:xxx) permission rules
}
```

**Unix 소켓 필터링**은 두 플랫폼의 가장 큰 차이점입니다. macOS의 Seatbelt는 경로별 Unix 소켓 필터링을 지원하는 반면 Linux의 seccomp는 소켓 경로를 구별할 수 없습니다. "모두 허용" 또는 "모두 거부"만 수행할 수 있습니다.

``` typescript
// restored-src/src/entrypoints/sandboxTypes.ts:28-36
allowUnixSockets: z.array(z.string()).optional()
  .describe('macOS only: Unix socket paths to allow. Ignored on Linux (seccomp cannot filter by path).'),
allowAllUnixSockets: z.boolean().optional()
  .describe('If true, allow all Unix sockets (disables blocking on both platforms).'),
```

**`allowManagedDomainsOnly` 정책**은 엔터프라이즈급 네트워크 격리의 핵심입니다. 기업이 `policySettings`를 통해 이 옵션을 활성화하면 사용자, 프로젝트 및 로컬 레이어의 모든 도메인 구성이 무시됩니다. 기업 정책의 도메인 및 `WebFetch` 규칙만 적용됩니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:152-157
export function shouldAllowManagedSandboxDomainsOnly(): boolean {
  return (
    getSettingsForSource('policySettings')?.sandbox?.network
      ?.allowManagedDomainsOnly === true
  )
}
```

또한 이 정책을 시행하기 위해 초기화 중에 `sandboxAskCallback`가 래핑됩니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:745-755
const wrappedCallback: SandboxAskCallback | undefined = sandboxAskCallback
  ? async (hostPattern: NetworkHostPattern) => {
      if (shouldAllowManagedSandboxDomainsOnly()) {
        logForDebugging(
          `[sandbox] Blocked network request to ${hostPattern.host} (allowManagedDomainsOnly)`,
        )
        return false  // Hard reject, do not ask the user
      }
      return sandboxAskCallback(hostPattern)
    }
  : undefined
```

**HTTP/SOCKS 프록시 지원**을 통해 기업은 프록시 서버를 통해 에이전트 네트워크 트래픽을 모니터링하고 감사할 수 있습니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:360-368
return {
  network: {
    allowedDomains,
    deniedDomains,
    allowUnixSockets: settings.sandbox?.network?.allowUnixSockets,
    allowAllUnixSockets: settings.sandbox?.network?.allowAllUnixSockets,
    allowLocalBinding: settings.sandbox?.network?.allowLocalBinding,
    httpProxyPort: settings.sandbox?.network?.httpProxyPort,
    socksProxyPort: settings.sandbox?.network?.socksProxyPort,
  },
```

`enableWeakerNetworkIsolation` 옵션은 특별한 주의를 기울일 가치가 있습니다. TLS 인증서를 확인하기 위해 Go로 컴파일된 CLI 도구(예: `gh`, `gcloud`, `terraform`)에 필요한 macOS의 `com.apple.trustd.agent` 서비스에 액세스할 수 있습니다. 그러나 이 옵션을 활성화하면 **보안이 감소**합니다. 왜냐하면 trustd 서비스 자체가 잠재적인 데이터 유출 채널이기 때문입니다.

``` typescript
// restored-src/src/entrypoints/sandboxTypes.ts:125-133
enableWeakerNetworkIsolation: z.boolean().optional()
  .describe(
    'macOS only: Allow access to com.apple.trustd.agent in the sandbox. ' +
    'Needed for Go-based CLI tools (gh, gcloud, terraform, etc.) to verify TLS certificates ' +
    'when using httpProxyPort with a MITM proxy and custom CA. ' +
    '**Reduces security** — opens a potential data exfiltration vector through the trustd service. Default: false',
  ),
```

### <a href="#18b6-bash-tool-integration" class="header">18b.6 Bash 도구 통합</a>

샌드박스는 궁극적으로 Bash 도구를 통해 사용자와 상호 작용합니다. 의사결정 체인은 `shouldUseSandbox()`로 시작하여 `Shell.exec()`의 래핑을 거쳐 운영 체제 수준에서 격리된 실행으로 끝납니다.

**`shouldUseSandbox()` 결정 논리**는 명확한 우선순위 체인을 따릅니다.

``` typescript
// restored-src/src/tools/BashTool/shouldUseSandbox.ts:130-153
export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  // 1. Sandbox not enabled → don't use
  if (!SandboxManager.isSandboxingEnabled()) {
    return false
  }
  // 2. dangerouslyDisableSandbox=true and policy allows it → don't use
  if (input.dangerouslyDisableSandbox &&
      SandboxManager.areUnsandboxedCommandsAllowed()) {
    return false
  }
  // 3. No command → don't use
  if (!input.command) {
    return false
  }
  // 4. Command matches exclusion list → don't use
  if (containsExcludedCommand(input.command)) {
    return false
  }
  // 5. All other cases → use sandbox
  return true
}
```

`containsExcludedCommand()`의 구현은 보이는 것보다 더 복잡합니다. 사용자가 구성한 `excludedCommands`를 확인할 뿐만 아니라 복합 명령(`&&`와 결합)을 분할하고 일치를 위해 환경 변수 접두사 및 안전 래퍼(예: `timeout`)를 반복적으로 제거합니다. 이렇게 하면 `docker`가 제외 목록에 있다는 이유로 `docker ps && curl evil.com`와 같은 명령이 샌드박스를 완전히 건너뛰는 것을 방지할 수 있습니다.

``` typescript
// restored-src/src/tools/BashTool/shouldUseSandbox.ts:60-68
// Split compound commands to prevent a compound command from
// escaping the sandbox just because its first subcommand matches
let subcommands: string[]
try {
  subcommands = splitCommand_DEPRECATED(command)
} catch {
  subcommands = [command]
}
```

**명령 래핑 흐름**은 `Shell.ts`에서 완료됩니다. `shouldUseSandbox`가 true인 경우 명령 문자열은 `SandboxManager.wrapWithSandbox()`로 전달되며, 여기서 기본 sandbox-runtime은 격리 매개변수를 사용하여 이를 실제 시스템 호출로 래핑합니다.

``` typescript
// restored-src/src/utils/Shell.ts:259-273
if (shouldUseSandbox) {
  commandString = await SandboxManager.wrapWithSandbox(
    commandString,
    sandboxBinShell,
    undefined,
    abortSignal,
  )
  // Create sandbox temp directory with secure permissions
  try {
    const fs = getFsImplementation()
    await fs.mkdir(sandboxTmpDir, { mode: 0o700 })
  } catch (error) {
    logForDebugging(`Failed to create ${sandboxTmpDir} directory: ${error}`)
  }
}
```

특히 주목해야 할 점은 **샌드박스에서의 PowerShell 처리**입니다. 내부적으로 `wrapWithSandbox`는 명령을 `<binShell> -c '<cmd>'`로 래핑하지만 이 프로세스 중에 PowerShell의 `-NoProfile -NonInteractive` 인수가 손실됩니다. 해결 방법은 PowerShell 명령을 Base64 형식으로 미리 인코딩한 다음 `/bin/sh`를 샌드박스의 내부 셸로 사용하는 것입니다.

``` typescript
// restored-src/src/utils/Shell.ts:247-257
// Sandboxed PowerShell: wrapWithSandbox hardcodes `<binShell> -c '<cmd>'` —
// using pwsh there would lose -NoProfile -NonInteractive
const isSandboxedPowerShell = shouldUseSandbox && shellType === 'powershell'
const sandboxBinShell = isSandboxedPowerShell ? '/bin/sh' : binShell
```

**`dangerouslyDisableSandbox` 매개변수**를 사용하면 AI 모델이 샌드박스 제한으로 인해 오류가 발생할 때 샌드박스를 우회할 수 있습니다. 그러나 기업은 `allowUnsandboxedCommands: false`를 통해 이 매개변수를 완전히 비활성화할 수 있습니다.

``` typescript
// restored-src/src/entrypoints/sandboxTypes.ts:113-119
allowUnsandboxedCommands: z.boolean().optional()
  .describe(
    'Allow commands to run outside the sandbox via the dangerouslyDisableSandbox parameter. ' +
    'When false, the dangerouslyDisableSandbox parameter is completely ignored and all commands must run sandboxed. ' +
    'Default: true.',
  ),
```

BashTool의 프롬프트(도구 프롬프트에 대한 설명은 8장 참조)도 이 설정을 기반으로 모델에 대한 지침을 동적으로 조정합니다.

``` typescript
// restored-src/src/tools/BashTool/prompt.ts:228-256
const sandboxOverrideItems: Array<string | string[]> =
  allowUnsandboxedCommands
    ? [
        'You should always default to running commands within the sandbox...',
        // Guides the model to only use dangerouslyDisableSandbox when evidence like "Operation not permitted" is seen
      ]
    : [
        'All commands MUST run in sandbox mode - the `dangerouslyDisableSandbox` parameter is disabled by policy.',
        'Commands cannot run outside the sandbox under any circumstances.',
      ]
```

다음 순서도는 명령 입력부터 샌드박스 실행까지의 전체 결정 경로를 보여줍니다.

``` mermaid
flowchart TD
    A["BashTool Receives Command"] --> B{sandbox.enabled?}
    B -->|No| Z["Execute Directly (No Sandbox)"]
    B -->|Yes| C{dangerouslyDisableSandbox?}
    C -->|Yes| D{areUnsandboxedCommandsAllowed?}
    D -->|Yes| Z
    D -->|No| E["Ignore dangerouslyDisableSandbox"]
    C -->|No| E
    E --> F{Command matches excludedCommands?}
    F -->|Yes| Z
    F -->|No| G["Shell.exec with shouldUseSandbox=true"]
    G --> H["SandboxManager.wrapWithSandbox()"]
    H --> I["Create Sandbox Temp Dir (0o700)"]
    I --> J["Execute in Isolated Environment"]
    J --> K["cleanupAfterCommand()"]
    K --> L["scrubBareGitRepoFiles()"]

    style B fill:#fcf,stroke:#333
    style D fill:#fcf,stroke:#333
    style F fill:#fcf,stroke:#333
    style L fill:#faa,stroke:#333
```

### <a href="#18b7-security-edge-case-bare-git-repo-attack-defense"
class="header">18b.7 보안 엣지 사례: Bare Git Repo 공격 방어</a>

이는 전체 샌드박스 시스템에서 가장 인상적인 보안 엔지니어링 사례입니다. 문제 \#29316은 실제 샌드박스 탈출 공격 경로를 설명합니다.

**공격 원리**: Git의 `is_git_directory()` 기능은 `HEAD`, `objects/`, `refs/` 및 기타 파일이 있는지 확인하여 디렉터리가 Git 저장소인지 여부를 결정합니다. 공격자가 프롬프트 삽입을 통해 샌드박스 내부에 이러한 파일을 생성하고 `config`의 `core.fsmonitor`가 악성 스크립트를 가리키도록 설정하면 Claude Code의 **샌드박스 처리되지 않은** Git 작업(예: `git status`)은 현재 디렉터리를 Bare Git Repo로 잘못 식별하고 해당 시점에서 샌드박스 외부에서 `core.fsmonitor`에 지정된 임의 코드를 실행합니다.

**방어 전략**: 이는 예방과 정리라는 두 가지 라인을 따릅니다.

**기존** Git 파일(`HEAD`, `objects`, `refs`, `hooks`, `config`)의 경우 시스템은 해당 파일을 `denyWrite` 목록에 추가하고 샌드박스 런타임 바인드 마운트는 읽기 전용으로 마운트합니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:257-280
// SECURITY: Git's is_git_directory() treats cwd as a bare repo if it has
// HEAD + objects/ + refs/. An attacker planting these (plus a config with
// core.fsmonitor) escapes the sandbox when Claude's unsandboxed git runs.
bareGitRepoScrubPaths.length = 0
const bareGitRepoFiles = ['HEAD', 'objects', 'refs', 'hooks', 'config']
for (const dir of cwd === originalCwd ? [originalCwd] : [originalCwd, cwd]) {
  for (const gitFile of bareGitRepoFiles) {
    const p = resolve(dir, gitFile)
    try {
      statSync(p)
      denyWrite.push(p)  // File exists → read-only bind-mount
    } catch {
      bareGitRepoScrubPaths.push(p)  // File doesn't exist → record for post-command cleanup
    }
  }
}
```

**존재하지 않는** Git 파일(예: 샌드박스 명령 실행 중에 공격자가 심을 수 있는 파일)의 경우 시스템은 정리를 위해 각 명령 후에 `scrubBareGitRepoFiles()`를 호출합니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:404-414
function scrubBareGitRepoFiles(): void {
  for (const p of bareGitRepoScrubPaths) {
    try {
      rmSync(p, { recursive: true })
      logForDebugging(`[Sandbox] scrubbed planted bare-repo file: ${p}`)
    } catch {
      // ENOENT is the expected common case — nothing was planted
    }
  }
}
```

소스 코드 주석에서는 모든 Git 파일에 `denyWrite`를 사용할 수 없는 이유를 설명합니다.

> 이러한 경로를 무조건 거부하면 샌드박스 런타임이 존재하지 않는 경로에 `/dev/null`를 마운트하게 되며, 이로 인해 (a) 호스트에 0바이트 HEAD 스텁이 남고 (b) bwrap 내부에서 `git log HEAD`가 중단됩니다("모호한 인수").

이 방어는 `cleanupAfterCommand()`에 통합되어 모든 샌드박스 명령 실행 후에 정리가 발생하도록 합니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:963-966
cleanupAfterCommand: (): void => {
  BaseSandboxManager.cleanupAfterCommand()
  scrubBareGitRepoFiles()
},
```

### <a href="#18b8-enterprise-policies-and-compliance" class="header">18b.8 기업 정책 및 규정 준수</a>

Claude Code의 샌드박스 시스템은 기업 배포를 위한 포괄적인 정책 제어 기능을 제공합니다.

**MDM `settings.d/` 디렉터리**: 기업은 `getManagedSettingsDropInDir()`에서 지정한 관리 설정 디렉터리를 통해 샌드박스 정책을 배포할 수 있습니다. 이 디렉토리의 구성 파일은 자동으로 `policySettings`의 가장 높은 우선순위를 받습니다.

**`failIfUnavailable`**: `true`로 설정하면 샌드박스를 시작할 수 없는 경우(종속성 누락, 지원되지 않는 플랫폼 등) Claude Code는 성능 저하 모드에서 실행되지 않고 직접 종료됩니다. 이는 엔터프라이즈급 하드 게이트입니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:479-485
function isSandboxRequired(): boolean {
  const settings = getSettings_DEPRECATED()
  return (
    getSandboxEnabledSetting() &&
    (settings?.sandbox?.failIfUnavailable ?? false)
  )
}
```

**`areSandboxSettingsLockedByPolicy()`**는 우선 순위가 더 높은 설정 소스(`flagSettings` 또는 `policySettings`)가 샌드박스 구성을 잠갔는지 확인하여 사용자가 로컬에서 수정할 수 없도록 합니다.

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:647-664
function areSandboxSettingsLockedByPolicy(): boolean {
  const overridingSources = ['flagSettings', 'policySettings'] as const
  for (const source of overridingSources) {
    const settings = getSettingsForSource(source)
    if (
      settings?.sandbox?.enabled !== undefined ||
      settings?.sandbox?.autoAllowBashIfSandboxed !== undefined ||
      settings?.sandbox?.allowUnsandboxedCommands !== undefined
    ) {
      return true
    }
  }
  return false
}
```

`/sandbox` 명령 구현에서 정책이 설정을 잠근 경우 사용자에게 명확한 오류 메시지가 표시됩니다.

``` typescript
// restored-src/src/commands/sandbox-toggle/sandbox-toggle.tsx:33-37
if (SandboxManager.areSandboxSettingsLockedByPolicy()) {
  const message = color('error', themeName)(
    'Error: Sandbox settings are overridden by a higher-priority configuration and cannot be changed locally.'
  );
  onDone(message);
}
```

**`enabledPlatforms`**(문서화되지 않음)를 통해 기업은 특정 플랫폼에서만 샌드박스를 활성화할 수 있습니다. This was added for NVIDIA's enterprise deployment — they wanted to enable `autoAllowBashIfSandboxed` on macOS first, then expand to Linux once the Linux sandbox matured:

``` typescript
// restored-src/src/utils/sandbox/sandbox-adapter.ts:505-526
function isPlatformInEnabledList(): boolean {
  const settings = getInitialSettings()
  const enabledPlatforms = (
    settings?.sandbox as { enabledPlatforms?: Platform[] } | undefined
  )?.enabledPlatforms
  if (enabledPlatforms === undefined) {
    return true  // All platforms enabled by default when not set
  }
  const currentPlatform = getPlatform()
  return enabledPlatforms.includes(currentPlatform)
}
```

**격리와 그 장단점을 약화시키는 옵션**:

<div class="table-wrapper">

| 옵션 | 효과 | 보안 영향 |
|----|----|----|
| `enableWeakerNestedSandbox` | 샌드박스 내부에 중첩된 샌드박스 허용 | 격리 깊이 감소 |
| `enableWeakerNetworkIsolation` | macOS에서 `trustd.agent`에 대한 액세스 허용 | 데이터 유출 벡터를 엽니다. |
| `allowUnsandboxedCommands: true` | `dangerouslyDisableSandbox` 매개변수를 활성화합니다. | 완전한 샌드박스 우회 허용 |
| `excludedCommands` | 특정 명령은 샌드박스를 건너뜁니다. | 제외된 명령에는 격리 보호가 없습니다. |

</div>

## <a href="#pattern-extraction" class="header">패턴 추출</a>

### <a href="#pattern-multi-platform-sandbox-adapter"
class="header">패턴: 다중 플랫폼 샌드박스 어댑터</a>

**문제 해결**: 다양한 운영 체제는 완전히 다른 격리 기본 요소(macOS Seatbelt 대 Linux 네임스페이스 + seccomp)를 제공하며 애플리케이션 계층에는 샌드박스의 수명 주기, 구성 및 실행을 관리하기 위한 통합 인터페이스가 필요합니다.

**접근하다**:

1. **외부 패키지는 플랫폼 차이점을 처리합니다**: `@anthropic-ai/sandbox-runtime`는 macOS `sandbox-exec`와 Linux `bwrap` + `seccomp` 간의 차이점을 캡슐화하여 통합 `BaseSandboxManager` API를 제공합니다.
2. **어댑터 레이어는 비즈니스 차이점을 처리합니다**: `sandbox-adapter.ts`는 애플리케이션별 구성 시스템(5개 레이어 설정, 권한 규칙, 경로 규칙)을 `sandbox-runtime`의 `SandboxRuntimeConfig` 형식으로 변환합니다.
3. **인터페이스는 메소드 테이블을 내보냅니다**: `ISandboxManager` 인터페이스는 "사용자 정의 구현" 메소드와 "직접 전달" 메소드를 명시적으로 구별하여 코드 의도를 명확하게 만듭니다.

**전제조건**:

- 기본 격리 패키지는 플랫폼에 구애받지 않는 인터페이스(`wrapWithSandbox`, `initialize`, `updateConfig`)를 제공해야 합니다.
- 어댑터는 모든 애플리케이션별 개념 변환(경로 확인 규칙, 권한 규칙 추출)을 처리해야 합니다.
- `cleanupAfterCommand()`와 같은 확장 포인트는 어댑터가 자체 로직을 삽입할 수 있도록 허용해야 합니다.

**Claude 코드의 매핑**:

<div class="table-wrapper">

| 요소 | 역할 |
|---------------------------------|------------------|
| `@anthropic-ai/sandbox-runtime` | 적응자 |
| `sandbox-adapter.ts` | 어댑터 |
| `ISandboxManager` | 대상 인터페이스 |
| `BashTool`, `Shell.ts` | 고객 |

</div>

### <a href="#pattern-five-layer-configuration-merging-with-policy-locking"
class="header">패턴: 정책 잠금을 사용한 5계층 구성 병합</a>

**문제 해결**: 샌드박스 구성은 사용자 유연성과 기업 보안 규정 준수 간의 균형을 유지해야 합니다. 사용자는 쓰기 가능한 경로와 네트워크 도메인을 사용자 정의해야 하며, 기업은 사용자가 이를 우회하지 못하도록 중요한 설정을 잠가야 합니다.

**접근하다**:

1. **우선순위가 낮은 소스는 기본값을 제공**: `userSettings` 및 `projectSettings`는 기본 구성을 제공합니다.
2. **우선순위가 높은 소스 재정의 또는 잠금**: `policySettings`에서 `sandbox.enabled: true`를 설정하면 모든 낮은 우선순위 설정이 재정의됩니다.
3. **`allowManagedDomainsOnly`와 같은 정책 스위치**: 병합 로직 중에 우선순위가 낮은 소스의 데이터를 선택적으로 무시합니다.
4. **`areSandboxSettingsLockedByPolicy()`는 잠금 상태를 감지합니다**: UI 레이어는 이 결과에 따라 설정 수정 진입점을 비활성화합니다.

**전제조건**:

- 설정 시스템은 병합된 결과를 반환하는 것뿐만 아니라 소스별 쿼리(`getSettingsForSource`)를 지원해야 합니다.
- 경로 확인은 소스를 인식해야 합니다(동일한 `/path`가 다른 소스의 다른 절대 경로로 확인될 수 있음)
- 정책 잠금 감지는 설정 작성 시가 아닌 UI 진입점에서 수행되어야 합니다.

**Claude 코드의 매핑**: `SETTING_SOURCES`는 우선 순위 체인 `userSettings -> projectSettings -> localSettings -> flagSettings -> policySettings`를 정의합니다. `convertToSandboxRuntimeConfig()`는 모든 소스를 반복하고 각 소스의 규칙에 따라 경로를 확인하는 반면 `shouldAllowManagedSandboxDomainsOnly()` 및 `shouldAllowManagedReadPathsOnly()`는 엔터프라이즈 정책의 "하드 재정의"를 구현합니다.

## <a href="#what-users-can-do" class="header">사용자가 할 수 있는 일</a>

1. **프로젝트에서 샌드박스 활성화**: `.claude/settings.local.json`에서 `{ "sandbox": { "enabled": true } }`를 설정하거나 대화형 구성을 위해 `/sandbox` 명령을 실행하세요. 활성화되면 모든 Bash 명령은 기본적으로 샌드박스 내에서 실행됩니다.

2. **Add network whitelists for development tools**: If build tools (npm, pip, cargo) need to download dependencies, add the required domains to `sandbox.network.allowedDomains`, such as `["registry.npmjs.org", "crates.io"]`. 이는 `WebFetch(domain:xxx)` 허용 권한 규칙을 통해서도 달성할 수 있습니다. 샌드박스는 이러한 도메인을 자동으로 추출합니다.

3. **Exclude specific commands from the sandbox**: Use `/sandbox exclude "docker compose:*"` to exclude commands that require special privileges (such as Docker, systemctl) from the sandbox. 이는 보안 경계가 아닌 편의 기능입니다. 제외된 명령에는 샌드박스 보호 기능이 없습니다.

4. **Ensure compatibility with Git Worktrees**: If you use Claude Code in a Git Worktree, the system automatically detects it and adds the main repository path to the writable whitelist. `index.lock` 관련 오류가 발생하는 경우 `.git` 파일의 `gitdir` 참조가 올바른지 확인하세요.

5. **Force sandbox in enterprise deployments**: Set `{ "sandbox": { "enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false } }` in managed settings to force all users to run inside the sandbox with no bypass allowed. `network.allowManagedDomainsOnly: true`와 결합하여 네트워크 액세스 허용 목록을 잠급니다.

6. **샌드박스 문제 디버그**: 샌드박스 제한으로 인해 명령이 실패하면 stderr에는 `<sandbox_violations>` 태그에 위반 정보가 포함됩니다. `/sandbox`를 실행하여 현재 샌드박스 상태와 종속성 검사 결과를 확인하세요. Linux에서 glob 패턴 경고가 표시되면 와일드카드 경로를 정확한 경로로 바꾸십시오(Bubblewrap은 glob을 지원하지 않음).
