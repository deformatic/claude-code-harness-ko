# <a
href="#appendix-g-authentication--subscription-system--from-oauth-to-compliance-boundaries"
class="header">Appendix G: Authentication &amp; Subscription System —
From OAuth to Compliance Boundaries</a>

> This appendix analyzes the authentication architecture and
> subscription system of Claude Code v2.1.88 based on its source code,
> and examines the compliance boundaries for developers building Agents
> in the context of Anthropic's April 2026 ban on third-party tools.

## <a href="#g1-dual-track-oauth-authentication-architecture"
class="header">G.1 Dual-Track OAuth Authentication Architecture</a>

Claude Code supports two distinctly different authentication paths,
serving two types of user groups.

### <a href="#g11-claudeai-subscription-users" class="header">G.1.1
Claude.ai Subscription Users</a>

Subscription users (Pro/Max/Team/Enterprise) authenticate through
Claude.ai's OAuth endpoint:

    User → claude login → claude.com/cai/oauth/authorize
      → Authorization page (PKCE flow)
      → Callback → exchangeCodeForTokens()
      → OAuth access_token + refresh_token
      → Use token directly to call Anthropic API (no API key needed)

``` typescript
// restored-src/src/constants/oauth.ts:18-20
const CLAUDE_AI_INFERENCE_SCOPE = 'user:inference'
const CLAUDE_AI_PROFILE_SCOPE = 'user:profile'
```

Key scopes:

- `user:inference` — Permission to invoke the model
- `user:profile` — Read account information
- `user:sessions` — Session management
- `user:mcp` — MCP server access
- `user:file_upload` — File upload

OAuth configuration (`restored-src/src/constants/oauth.ts:60-234`):

<div class="table-wrapper">

| Configuration     | Production Value                             |
|-------------------|----------------------------------------------|
| Authorization URL | `https://claude.com/cai/oauth/authorize`     |
| Token URL         | `https://platform.claude.com/v1/oauth/token` |
| Client ID         | `9d1c250a-e61b-44d9-88ed-5944d1962f5e`       |
| PKCE              | Required (S256)                              |

</div>

### <a href="#g12-console-api-users" class="header">G.1.2 Console API
Users</a>

Console users (pay-as-you-go) authenticate through the Anthropic
developer platform:

    User → claude login → platform.claude.com/oauth/authorize
      → Authorization (scope: org:create_api_key)
      → Callback → exchangeCodeForTokens()
      → OAuth token → createAndStoreApiKey()
      → Generate temporary API key → Use key to call API

The difference: Console users have an additional step — after OAuth, an
API key is created, and actual API calls use key-based authentication
rather than token-based authentication.

### <a href="#g13-third-party-providers" class="header">G.1.3 Third-Party
Providers</a>

In addition to Anthropic's own authentication, Claude Code also
supports:

<div class="table-wrapper">

| Provider       | Environment Variable        | Authentication Method |
|----------------|-----------------------------|-----------------------|
| AWS Bedrock    | `CLAUDE_CODE_USE_BEDROCK=1` | AWS credential chain  |
| GCP Vertex AI  | `CLAUDE_CODE_USE_VERTEX=1`  | GCP credentials       |
| Azure Foundry  | `CLAUDE_CODE_USE_FOUNDRY=1` | Azure credentials     |
| Direct API key | `ANTHROPIC_API_KEY=sk-...`  | Direct passthrough    |
| API Key Helper | `apiKeyHelper` config       | Custom command        |

</div>

``` typescript
// restored-src/src/utils/auth.ts:208-212
type ApiKeySource =
  | 'ANTHROPIC_API_KEY'     // Environment variable
  | 'apiKeyHelper'          // Custom command
  | '/login managed key'    // OAuth-generated key
  | 'none'                  // No authentication
```

## <a href="#g2-subscription-tiers-and-rate-limits" class="header">G.2
Subscription Tiers and Rate Limits</a>

### <a href="#g21-four-tier-subscriptions" class="header">G.2.1 Four-Tier
Subscriptions</a>

The subscription detection function in the source code
(`restored-src/src/utils/auth.ts:1662-1711`) reveals the complete tier
hierarchy:

<div class="table-wrapper">

| Tier           | Organization Type   | Rate Multiplier | Price (Monthly) |
|----------------|---------------------|-----------------|-----------------|
| **Pro**        | `claude_pro`        | 1x              | \$20            |
| **Max**        | `claude_max`        | 5x or 20x       | \$100 / \$200   |
| **Team**       | `claude_team`       | 5x (Premium)    | Per seat        |
| **Enterprise** | `claude_enterprise` | Custom          | By contract     |

</div>

``` typescript
// restored-src/src/utils/auth.ts:1662-1711
function getSubscriptionType(): 'max' | 'pro' | 'team' | 'enterprise' | null
function isMaxSubscriber(): boolean
function isTeamPremiumSubscriber(): boolean  // Team with 5x rate limit
function getRateLimitTier(): string  // e.g., 'default_claude_max_20x'
```

### <a href="#g22-rate-limit-tiers" class="header">G.2.2 Rate Limit
Tiers</a>

The values returned by `getRateLimitTier()` directly affect the API call
frequency cap:

- `default_claude_max_20x` — Max highest tier, 20x the default rate
- `default_claude_max_5x` — Max standard tier / Team Premium
- Default — Pro and regular Team

### <a href="#g23-extra-usage" class="header">G.2.3 Extra Usage</a>

Certain operations trigger additional billing
(`restored-src/src/utils/extraUsage.ts:4-24`):

``` typescript
function isBilledAsExtraUsage(): boolean {
  // The following cases trigger Extra Usage billing:
  // 1. Claude.ai subscription users using Fast Mode
  // 2. Using 1M context window models (Opus 4.6, Sonnet 4.6)
}
```

Supported billing types:

- `stripe_subscription` — Standard Stripe subscription
- `stripe_subscription_contracted` — Contract-based
- `apple_subscription` — Apple IAP
- `google_play_subscription` — Google Play

## <a href="#g3-token-management-and-secure-storage" class="header">G.3
Token Management and Secure Storage</a>

### <a href="#g31-token-lifecycle" class="header">G.3.1 Token Lifecycle</a>

    Obtain token → Store in macOS Keychain → Read from Keychain when needed
      → Auto-refresh 5 minutes before expiry → Retry on refresh failure (up to 3 times)
      → All retries fail → Prompt user to re-login

Key implementation (`restored-src/src/utils/auth.ts`):

``` typescript
// Expiry check: 5-minute buffer
function isOAuthTokenExpired(token): boolean {
  return token.expires_at < Date.now() + 5 * 60 * 1000
}

// Auto-refresh
async function checkAndRefreshOAuthTokenIfNeeded() {
  // Token refresh with retry logic
  // Clears cache on failure, re-fetches on next call
}
```

### <a href="#g32-secure-storage" class="header">G.3.2 Secure Storage</a>

- **macOS**: Keychain Services (encrypted storage)
- **Linux**: libsecret / filesystem fallback
- **Subprocess passing**: Via File Descriptor
  (`CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`), avoiding environment variable
  leakage
- **API Key Helper**: Supports custom commands to obtain keys, with a
  default 5-minute cache TTL

### <a href="#g33-logout-cleanup" class="header">G.3.3 Logout Cleanup</a>

`performLogout()` (`restored-src/src/commands/logout/logout.tsx:16-48`)
performs a complete cleanup:

1.  Flush telemetry data (ensure nothing is lost)
2.  Remove API key
3.  Wipe all credentials from Keychain
4.  Clear OAuth account information from configuration
5.  Optional: Clear onboarding state
6.  Invalidate all caches: OAuth token, user data, beta features,
    GrowthBook, policy limits

## <a href="#g4-permissions-and-roles" class="header">G.4 Permissions and
Roles</a>

The organization role returned by the OAuth profile determines the
user's capability boundaries:

``` typescript
// restored-src/src/utils/billing.ts
// Console billing access
function hasConsoleBillingAccess(): boolean {
  // Requires: non-subscription user + admin or billing role
}

// Claude.ai billing access
function hasClaudeAiBillingAccess(): boolean {
  // Max/Pro automatically have access
  // Team/Enterprise require admin, billing, owner, or primary_owner
}
```

<div class="table-wrapper">

| Capability | Required Role |
|----|----|
| Access Console billing | admin or billing (non-subscription users) |
| Access Claude.ai billing | Max/Pro automatic; Team/Enterprise require admin/billing/owner |
| Extra usage toggle | Claude.ai subscription + supported billingType |
| `/upgrade` command | Non-Max 20x users |

</div>

## <a href="#g5-telemetry-and-account-tracking" class="header">G.5
Telemetry and Account Tracking</a>

The authentication system is deeply integrated with telemetry
(`restored-src/src/services/analytics/metadata.ts`):

- `isClaudeAiAuth` — Whether Claude.ai authentication is being used
- `subscriptionType` — Used for DAU-by-tier analysis
- `accountUuid` / `emailAddress` — Passed in telemetry headers

Key analytics events:

    tengu_oauth_flow_start          → OAuth flow initiated
    tengu_oauth_success             → OAuth successful
    tengu_oauth_token_refresh_success/failure → Token refresh result
    tengu_oauth_profile_fetch_success → Profile fetch successful

## <a href="#g6-compliance-boundary-analysis" class="header">G.6 Compliance
Boundary Analysis</a>

### <a href="#g61-background-the-april-2026-openclaw-incident"
class="header">G.6.1 Background: The April 2026 OpenClaw Incident</a>

In April 2026, Anthropic officially banned third-party tools from using
subscription quotas via OAuth. The core reasons:

1.  **Unsustainable costs**: Tools like OpenClaw ran automated Agents
    24/7, consuming \$1,000-5,000 in daily API costs — far exceeding
    what a \$200/month Max subscription could cover
2.  **Bypassing cache optimization**: Claude Code's four-layer prompt
    cache (see Chapters 13-14) can reduce costs by 90%; third-party
    tools calling the API directly result in 100% cache misses
3.  **Terms modification**: The OAuth `user:inference` scope was
    restricted to official product usage only

### <a href="#g62-behavior-classification" class="header">G.6.2 Behavior
Classification</a>

<div class="table-wrapper">

| Behavior | Technical Implementation | Risk Level |
|----|----|----|
| Manual use of Claude Code CLI | Interactive `claude` command | **Safe** — Intended use of the official product |
| Scripted `claude -p` calls | Shell script automation | **Safe** — Officially supported non-interactive mode |
| cc-sdk launching claude subprocess | `cc_sdk::query()` / `cc_sdk::llm::query()` | **Low risk** — Goes through the full CLI pipeline (including cache) |
| MCP Server called by Claude Code | rmcp / MCP protocol | **Safe** — Official extension mechanism |
| Agent SDK building personal tools | `@anthropic-ai/claude-code` SDK | **Safe** — Intended use of the official SDK |
| Extracting OAuth token to call API directly | Bypassing Claude Code CLI | **High risk** — This is the banned behavior |
| Automation in CI/CD | `claude -p` in CI | **Gray area** — Depends on frequency and usage |
| Distributing open-source tools that depend on claude | Users authenticate themselves | **Gray area** — Depends on usage patterns |
| 24/7 automated daemon | Continuous subscription quota consumption | **High risk** — The OpenClaw pattern |

</div>

### <a
href="#g63-the-key-distinction-whether-you-go-through-claude-codes-infrastructure"
class="header">G.6.3 The Key Distinction: Whether You Go Through Claude
Code's Infrastructure</a>

This is the most critical criterion:

    Safe path:
      Your code → cc-sdk → claude CLI subprocess → CC infrastructure (with cache) → API
      ↑ Goes through prompt cache, Anthropic's costs stay manageable

    Dangerous path:
      Your code → Extract OAuth token → Call Anthropic API directly
      ↑ Bypasses prompt cache, every request is full price

Claude Code's `getCacheControl()` function
(`restored-src/src/services/api/claude.ts:358-374`) carefully designs
three-level cache breakpoints: global, organization, and session.
Requests sent through the CLI automatically benefit from this cache
optimization. Third-party tools calling the API directly cannot reuse
these caches — this is the root cause of the cost problem.

**Quick Check: Does it spawn a `claude` subprocess?**

This is the simplest compliance criterion. All approaches that
communicate through a `claude` CLI subprocess go through CC's full
infrastructure (prompt cache + telemetry + permission checks), keeping
Anthropic's costs manageable; calling the API directly bypasses
everything.

<div class="table-wrapper">

| Approach | Spawns process? | Compliant |
|----|:--:|----|
| cc-sdk `query()` | Yes — `Command::new("claude")` | Compliant |
| cc-sdk `llm::query()` | Yes — same, plus `--tools ""` | Compliant |
| Agent SDK (`@anthropic-ai/claude-code`) | Yes — official SDK spawns claude | Compliant |
| `claude -p "..."` Shell script | Yes | Compliant |
| MCP Server called by CC | Yes — CC initiates it | Compliant |
| Extract OAuth token -\> `fetch("api.anthropic.com")` | **No** — bypasses CLI | **Non-compliant** |
| OpenClaw and other third-party Agents | **No** — calls API directly | **Non-compliant** |

</div>

### <a href="#g64-compliance-of-this-books-example-code"
class="header">G.6.4 Compliance of This Book's Example Code</a>

The Code Review Agent in Chapter 30 of this book uses the following
approaches:

<div class="table-wrapper">

| Backend | Implementation | Compliance |
|----|----|----|
| `CcSdkBackend` | cc-sdk launching claude CLI subprocess | **Compliant** — Goes through the official CLI |
| `CcSdkWsBackend` | WebSocket connection to CC instance | **Compliant** — Goes through the official protocol |
| `CodexBackend` | Codex subscription (OpenAI, not Anthropic) | **Not applicable** — Does not involve Anthropic |
| MCP Server mode | Claude Code calling via MCP | **Compliant** — Official extension mechanism |

</div>

**Recommendations**:

1.  Do not extract OAuth tokens from `~/.claude/` for other purposes
2.  Do not build 24/7 automated daemons
3.  Retain `CodexBackend` as an alternative that does not depend on
    Anthropic subscriptions
4.  If high-frequency automation is needed, use API key pay-as-you-go
    billing instead of subscriptions

## <a href="#g7-key-environment-variable-index" class="header">G.7 Key
Environment Variable Index</a>

<div class="table-wrapper">

| Variable | Purpose | Source |
|----|----|----|
| `ANTHROPIC_API_KEY` | Direct API key | User-configured |
| `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` | Pre-authenticated refresh token | Automated deployments |
| `CLAUDE_CODE_OAUTH_SCOPES` | Scopes for the refresh token | Used with the above |
| `CLAUDE_CODE_ACCOUNT_UUID` | Account UUID (for SDK callers) | SDK integration |
| `CLAUDE_CODE_USER_EMAIL` | User email (for SDK callers) | SDK integration |
| `CLAUDE_CODE_ORGANIZATION_UUID` | Organization UUID | SDK integration |
| `CLAUDE_CODE_USE_BEDROCK` | Enable AWS Bedrock | Third-party integration |
| `CLAUDE_CODE_USE_VERTEX` | Enable GCP Vertex AI | Third-party integration |
| `CLAUDE_CODE_USE_FOUNDRY` | Enable Azure Foundry | Third-party integration |
| `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` | File descriptor for API key | Secure passing |
| `CLAUDE_CODE_CUSTOM_OAUTH_URL` | Custom OAuth endpoint | FedStart deployments |

</div>
