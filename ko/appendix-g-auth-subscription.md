# <a
href="#appendix-g-authentication--subscription-system--from-oauth-to-compliance-boundaries"
class="header">부록 G: 인증 &amp; 구독 시스템 — OAuth에서 규정 준수 경계까지</a>

> 이 부록에서는 소스 코드를 기반으로 Claude Code v2.1.88의 인증 아키텍처 및 구독 시스템을 분석하고, Anthropic의 2026년 4월 타사 도구 금지와 관련하여 에이전트를 구축하는 개발자의 규정 준수 경계를 조사합니다.

## <a href="#g1-dual-track-oauth-authentication-architecture"
class="header">G.1 이중 트랙 OAuth 인증 아키텍처</a>

Claude Code는 두 가지 유형의 사용자 그룹에 서비스를 제공하는 서로 다른 두 가지 인증 경로를 지원합니다.

### <a href="#g11-claudeai-subscription-users" class="header">G.1.1 Claude.ai 구독 사용자</a>

구독 사용자(Pro/Max/Team/Enterprise)는 Claude.ai의 OAuth 엔드포인트를 통해 인증합니다.

사용자 → claude 로그인 → claude.com/cai/oauth/authorize → 인증 페이지(PKCE 흐름) → 콜백 → exchangeCodeForTokens() → OAuth access_token + Refresh_token → 토큰을 직접 사용하여 Anthropic API 호출(API 키 필요 없음)

``` typescript
// restored-src/src/constants/oauth.ts:18-20
const CLAUDE_AI_INFERENCE_SCOPE = 'user:inference'
const CLAUDE_AI_PROFILE_SCOPE = 'user:profile'
```

주요 범위:

- `user:inference` — 모델 호출 권한
- `user:profile` — 계정 정보 읽기
- `user:sessions` — 세션 관리
- `user:mcp` — MCP 서버 액세스
- `user:file_upload` — 파일 업로드

OAuth 구성(`restored-src/src/constants/oauth.ts:60-234`):

<div class="table-wrapper">

| 구성 | 생산 가치 |
|-------------------|----------------------------------------------|
| 승인 URL | `https://claude.com/cai/oauth/authorize` |
| 토큰 URL | `https://platform.claude.com/v1/oauth/token` |
| 클라이언트 ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| PKCE | 필수(S256) |

</div>

### <a href="#g12-console-api-users" class="header">G.1.2 콘솔 API 사용자</a>

콘솔 사용자(사용한 만큼 지불)는 Anthropic 개발자 플랫폼을 통해 인증합니다.

사용자 → claude 로그인 → platform.claude.com/oauth/authorize → 권한 부여(범위: org:create_api_key) → 콜백 → exchangeCodeForTokens() → OAuth 토큰 → createAndStoreApiKey() → 임시 API 키 생성 → 키를 사용하여 API 호출

차이점: 콘솔 사용자에게는 추가 단계가 있습니다. OAuth 후에 API 키가 생성되고 실제 API 호출은 토큰 기반 인증이 아닌 키 기반 인증을 사용합니다.

### <a href="#g13-third-party-providers" class="header">G.1.3 제3자 제공업체</a>

Anthropic의 자체 인증 외에도 Claude Code는 다음을 지원합니다.

<div class="table-wrapper">

| 공급자 | 환경변수 | 인증 방법 |
|----------------|-----------------------------|-----------------------|
| AWS 기반암 | `CLAUDE_CODE_USE_BEDROCK=1` | AWS 자격 증명 체인 |
| GCP 버텍스 AI | `CLAUDE_CODE_USE_VERTEX=1` | GCP 사용자 인증 정보 |
| 아주르 파운드리 | `CLAUDE_CODE_USE_FOUNDRY=1` | Azure 자격 증명 |
| 직접 API 키 | `ANTHROPIC_API_KEY=sk-...` | 직접 통과 |
| API 키 도우미 | `apiKeyHelper` 구성 | 사용자 정의 명령 |

</div>

``` typescript
// restored-src/src/utils/auth.ts:208-212
type ApiKeySource =
  | 'ANTHROPIC_API_KEY'     // Environment variable
  | 'apiKeyHelper'          // Custom command
  | '/login managed key'    // OAuth-generated key
  | 'none'                  // No authentication
```

## <a href="#g2-subscription-tiers-and-rate-limits" class="header">G.2 구독 등급 및 요금 제한</a>

### <a href="#g21-four-tier-subscriptions" class="header">G.2.1 4계층 구독</a>

소스 코드(`restored-src/src/utils/auth.ts:1662-1711`)의 구독 감지 기능은 전체 계층 계층을 보여줍니다.

<div class="table-wrapper">

| 층 | 조직 유형 | 비율 승수 | 가격 (월간) |
|----------------|---------------------|-----------------|-----------------|
| **찬성** | `claude_pro` | 1x | \$20 |
| **최대** | `claude_max` | 5배 또는 20배 | \$100 / \$200 |
| **팀** | `claude_team` | 5배(프리미엄) | 좌석당 |
| **기업** | `claude_enterprise` | 관습 | 계약에 따라 |

</div>

``` typescript
// restored-src/src/utils/auth.ts:1662-1711
function getSubscriptionType(): 'max' | 'pro' | 'team' | 'enterprise' | null
function isMaxSubscriber(): boolean
function isTeamPremiumSubscriber(): boolean  // Team with 5x rate limit
function getRateLimitTier(): string  // e.g., 'default_claude_max_20x'
```

### <a href="#g22-rate-limit-tiers" class="header">G.2.2 속도 제한 계층</a>

`getRateLimitTier()`에서 반환된 값은 API 호출 빈도 한도에 직접적인 영향을 미칩니다.

- `default_claude_max_20x` — 최대 최고 등급, 기본 속도의 20배
- `default_claude_max_5x` — 최대 표준 등급/팀 프리미엄
- 기본값 — 프로 및 일반 팀

### <a href="#g23-extra-usage" class="header">G.2.3 추가 사용</a>

특정 작업으로 인해 추가 청구가 발생합니다(`restored-src/src/utils/extraUsage.ts:4-24`):

``` typescript
function isBilledAsExtraUsage(): boolean {
  // The following cases trigger Extra Usage billing:
  // 1. Claude.ai subscription users using Fast Mode
  // 2. Using 1M context window models (Opus 4.6, Sonnet 4.6)
}
```

지원되는 청구 유형:

- `stripe_subscription` — 표준 스트라이프 구독
- `stripe_subscription_contracted` — 계약 기반
- `apple_subscription` — Apple IAP
- `google_play_subscription` — Google Play

## <a href="#g3-token-management-and-secure-storage" class="header">G.3 토큰 관리 및 안전한 저장</a>

### <a href="#g31-token-lifecycle" class="header">G.3.1 토큰 수명주기</a>

토큰 획득 → macOS 키체인에 저장 → 필요할 때 키체인에서 읽기 → 만료 5분 전 자동 새로 고침 → 새로 고침 실패 시 재시도(최대 3회) → 모든 재시도 실패 → 사용자에게 다시 로그인하라는 메시지 표시

주요 구현(`restored-src/src/utils/auth.ts`):

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

### <a href="#g32-secure-storage" class="header">G.3.2 안전한 저장</a>

- **macOS**: 키체인 서비스(암호화된 저장소)
- **Linux**: libsecret / 파일 시스템 대체
- **하위 프로세스 전달**: 파일 설명자(`CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`)를 통해, 환경 변수 누출 방지
- **API 키 도우미**: 기본 5분 캐시 TTL을 사용하여 키를 얻기 위한 맞춤 명령을 지원합니다.

### <a href="#g33-logout-cleanup" class="header">G.3.3 로그아웃 정리</a>

`performLogout()`(`restored-src/src/commands/logout/logout.tsx:16-48`)는 완전한 정리를 수행합니다.

1. 원격 측정 데이터 플러시(유실되는 항목이 없는지 확인)
2. API 키 제거
3. 키체인에서 모든 자격 증명을 삭제합니다.
4. 구성에서 OAuth 계정 정보 지우기
5. 선택사항: 온보딩 상태 지우기
6. 모든 캐시 무효화: OAuth 토큰, 사용자 데이터, 베타 기능, GrowthBook, 정책 제한

## <a href="#g4-permissions-and-roles" class="header">G.4 권한 및 역할</a>

OAuth 프로필에서 반환된 조직 역할에 따라 사용자의 기능 경계가 결정됩니다.

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

| 능력 | 필수 역할 |
|----|----|
| 액세스 콘솔 청구 | 관리자 또는 청구(비구독 사용자) |
| Claude.ai 청구서에 액세스 | Max/Pro 자동; 팀/기업에는 관리자/청구/소유자가 필요합니다. |
| 추가 사용량 토글 | Claude.ai 구독 + 지원되는 billingType |
| `/upgrade` 명령 | 최대 20배가 아닌 사용자 |

</div>

## <a href="#g5-telemetry-and-account-tracking" class="header">G.5 원격 측정 및 계정 추적</a>

인증 시스템은 원격 측정(`restored-src/src/services/analytics/metadata.ts`)과 긴밀하게 통합되어 있습니다.

- `isClaudeAiAuth` — Claude.ai 인증이 사용되고 있는지 여부
- `subscriptionType` — DAU 계층별 분석에 사용됩니다.
- `accountUuid` / `emailAddress` — 원격 측정 헤더에 전달됨

주요 분석 이벤트:

tengu_oauth_flow_start → OAuth 흐름 시작 tengu_oauth_success → OAuth 성공 tengu_oauth_token_refresh_success/failure → 토큰 새로 고침 결과 tengu_oauth_profile_fetch_success → 프로필 가져오기 성공

## <a href="#g6-compliance-boundary-analysis" class="header">G.6 준수 경계 분석</a>

### <a href="#g61-background-the-april-2026-openclaw-incident"
class="header">G.6.1 배경: 2026년 4월 OpenClaw 사건</a>

2026년 4월, Anthropic은 타사 도구가 OAuth를 통해 구독 할당량을 사용하는 것을 공식적으로 금지했습니다. 핵심 이유:

1. **지속 불가능한 비용**: OpenClaw와 같은 도구는 자동화된 에이전트를 연중무휴 24시간 실행하여 일일 API 비용으로 \$1,000-5,000를 소비합니다. 이는 \$200/월 Max 구독으로 감당할 수 있는 금액을 훨씬 초과합니다.
2. **캐시 최적화 우회**: Claude Code의 4계층 프롬프트 캐시(13~14장 참조)는 비용을 90%까지 절감할 수 있습니다. API를 직접 호출하는 타사 도구는 100% 캐시 누락을 초래합니다.
3. **약관 수정**: OAuth `user:inference` 범위는 공식 제품 사용으로만 제한되었습니다.

### <a href="#g62-behavior-classification" class="header">G.6.2 행동 분류</a>

<div class="table-wrapper">

| 행동 | 기술적 구현 | 위험 수준 |
|----|----|----|
| Claude Code CLI 수동 사용 | 대화형 `claude` 명령 | **안전함** — 공식 제품의 사용 목적 |
| 스크립트된 `claude -p` 호출 | 쉘 스크립트 자동화 | **안전** — 공식적으로 지원되는 비대화형 모드 |
| cc-sdk 시작 클로드 하위 프로세스 | `cc_sdk::query()` ​​/ `cc_sdk::llm::query()` | **낮은 위험** — 전체 CLI 파이프라인(캐시 포함)을 통과합니다. |
| Claude Code가 호출한 MCP 서버 | rmcp / MCP 프로토콜 | **안전함** — 공식 확장 메커니즘 |
| 개인 도구를 구축하는 Agent SDK | `@anthropic-ai/claude-code` SDK | **안전함** — 공식 SDK 사용 목적 |
| API를 직접 호출하기 위해 OAuth 토큰 추출 | 클로드 코드 CLI 우회 | **높은 위험** — 이는 금지된 행동입니다. |
| CI/CD의 자동화 | CI의 `claude -p` | **회색 영역** — 빈도 및 사용량에 따라 다름 |
| clude에 의존하는 오픈 소스 도구 배포 | 사용자가 자신을 인증합니다. | **회색 영역** — 사용 패턴에 따라 다름 |
| 연중무휴 자동화된 데몬 | 지속적인 구독 할당량 소비 | **높은 위험** — OpenClaw 패턴 |

</div>

### <a
href="#g63-the-key-distinction-whether-you-go-through-claude-codes-infrastructure"
class="header">G.6.3 주요 차이점: Claude Code의 인프라를 통과하는지 여부</a>

가장 중요한 기준은 다음과 같습니다.

안전한 경로: 귀하의 코드 → cc-sdk → claude CLI 하위 프로세스 → CC 인프라(캐시 포함) → API ↑ 프롬프트 캐시를 통과하므로 Anthropic의 비용은 관리 가능한 상태로 유지됩니다.

위험한 경로: 코드 → OAuth 토큰 추출 → Anthropic API 직접 호출 ↑ 프롬프트 캐시 우회, 모든 요청은 정가입니다.

Claude Code의 `getCacheControl()` 기능(`restored-src/src/services/api/claude.ts:358-374`)은 전역, 조직 및 세션의 세 가지 수준 캐시 중단점을 신중하게 설계합니다. CLI를 통해 전송된 요청은 자동으로 이 캐시 최적화의 이점을 얻습니다. API를 직접 호출하는 타사 도구는 이러한 캐시를 재사용할 수 없습니다. 이것이 비용 문제의 근본 원인입니다.

**빠른 확인: `claude` 하위 프로세스가 생성됩니까?**

이는 가장 간단한 준수 기준입니다. `claude` CLI 하위 프로세스를 통해 통신하는 모든 접근 방식은 CC의 전체 인프라(프롬프트 캐시 + 원격 측정 + 권한 확인)를 통과하여 Anthropic의 비용을 관리 가능하게 유지합니다. API를 호출하면 모든 것이 직접 우회됩니다.

<div class="table-wrapper">

| 접근하다 | 생성 과정? | 준수 |
|----|:--:|----|
| cc-sdk `query()` | 예 — `Command::new("claude")` | 준수 |
| cc-sdk `llm::query()` | 예 — 동일, 게다가 `--tools ""` | 준수 |
| 에이전트 SDK(`@anthropic-ai/claude-code`) | 예 - 공식 SDK가 clude를 생성합니다. | 준수 |
| `claude -p "..."` 쉘 스크립트 | 예 | 준수 |
| CC에 의해 호출되는 MCP 서버 | 예 - CC가 시작합니다. | 준수 |
| OAuth 토큰 추출 -\> `fetch("api.anthropic.com")` | **아니요** — CLI를 우회합니다. | **비준수** |
| OpenClaw 및 기타 타사 에이전트 | **아니요** — API를 직접 호출합니다. | **비준수** |

</div>

### <a href="#g64-compliance-of-this-books-example-code"
class="header">G.6.4 이 책의 예제 코드 준수</a>

이 책의 30장에 있는 코드 검토 에이전트는 다음 접근 방식을 사용합니다.

<div class="table-wrapper">

| 백엔드 | 구현 | 규정 준수 |
|----|----|----|
| `CcSdkBackend` | cc-sdk 시작 clude CLI 하위 프로세스 | **규정 준수** — 공식 CLI를 통과합니다. |
| `CcSdkWsBackend` | CC 인스턴스에 대한 WebSocket 연결 | **규정 준수** — 공식 프로토콜을 따릅니다. |
| `CodexBackend` | Codex 구독(Anthropic이 아닌 OpenAI) | **해당 사항 없음** — 인류와 관련되지 않음 |
| MCP 서버 모드 | MCP를 통한 Claude Code 통화 | **규정 준수** — 공식 확장 메커니즘 |

</div>

**권장사항**:

1. 다른 목적으로 `~/.claude/`에서 OAuth 토큰을 추출하지 마세요.
2. 연중무휴 자동화된 데몬을 구축하지 마세요
3. Anthropic 구독에 의존하지 않는 대안으로 `CodexBackend`를 유지하세요.
4. 빈도가 높은 자동화가 필요한 경우 구독 대신 API 키 종량제 청구를 사용하세요.

## <a href="#g7-key-environment-variable-index" class="header">G.7 주요 환경 변수 지수</a>

<div class="table-wrapper">

| 변하기 쉬운 | 목적 | 원천 |
|----|----|----|
| `ANTHROPIC_API_KEY` | 직접 API 키 | 사용자 구성 |
| `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` | 사전 인증된 새로 고침 토큰 | 자동화된 배포 |
| `CLAUDE_CODE_OAUTH_SCOPES` | 새로 고침 토큰의 범위 | 위와 함께 사용됨 |
| `CLAUDE_CODE_ACCOUNT_UUID` | 계정 UUID(SDK 호출자용) | SDK 통합 |
| `CLAUDE_CODE_USER_EMAIL` | 사용자 이메일(SDK 호출자용) | SDK 통합 |
| `CLAUDE_CODE_ORGANIZATION_UUID` | 조직 UUID | SDK 통합 |
| `CLAUDE_CODE_USE_BEDROCK` | AWS 기반암 활성화 | 타사 통합 |
| `CLAUDE_CODE_USE_VERTEX` | GCP Vertex AI 활성화 | 타사 통합 |
| `CLAUDE_CODE_USE_FOUNDRY` | Azure Foundry 활성화 | 타사 통합 |
| `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` | API 키에 대한 파일 설명자 | 안전한 통과 |
| `CLAUDE_CODE_CUSTOM_OAUTH_URL` | 커스텀 OAuth 엔드포인트 | FedStart 배포 |

</div>
