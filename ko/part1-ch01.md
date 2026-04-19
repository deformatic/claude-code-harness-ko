# <a href="#chapter-1-the-full-tech-stack-of-an-ai-coding-agent"
class="header">1장: AI 코딩 에이전트의 전체 기술 스택</a>

> **포지셔닝**: 이 장에서는 Claude Code의 전체 기술을 분석합니다.
> 스택 — Bun 런타임, React Ink 터미널 UI, TypeScript 유형 시스템 —
> 3-Layer Architecture가 어떻게 그 위에 구체적으로 구현되는지
> 이러한 기술 선택 중 하나입니다. 전제 조건: 없음, 읽을 수 있음
> 독립적으로. 대상 독자: CC 아키텍처를 접하는 독자
> 처음으로 Bun을 이해하고 싶은 개발자 +
> React Ink + TypeScript 기술 선택.

## <a href="#why-this-matters" class="header">이것이 중요한 이유</a>

AI 코딩 에이전트가 "사용자 입력 수신"에서 "사용자 입력 수신"까지 어떻게 진행되는지 이해합니다.
"코드베이스에서 작업 수행"을 수행하려면 먼저 해당 내용을 이해해야 합니다.
기술 스택. 기술 스택은 단순히 성능을 결정하는 것이 아닙니다.
천장 - 건축적 경계를 결정합니다. 무엇을 할 수 있는지
컴파일 타임에 런타임으로 연기해야 ​​할 사항과
모델 자체를 결정합니다.

Claude Code의 기술 스택 선택은 핵심 철학을 드러냅니다. **AI
코딩 에이전트는 전통적인 CLI 도구가 아닙니다. "에서 실행되는 시스템입니다.
배포' 모델은 도구를 사용하는 것뿐만 아니라 이를 작성할 수 있습니다.
자신의 도구**. 이는 전체 기술 스택이 "
일류시민 모델'을 염두에 두고 창업 초기부터
빌드 시간 기능 플래그 제거를 위한 최적화 - 모든 레이어
이 목표를 달성합니다.

이 장에서는 전체를 관통하는 핵심 개념을 설정합니다.
책 — **3계층 아키텍처** —를 통해 시연합니다.
클로드 코드에서 구체적으로 구현된 소스 코드 분석
v2.1.88. 자체 AI 에이전트를 구축하는 경우 아키텍처 모델
이 장의 시작 최적화 전략은 직접적으로
빌린; Claude Code가 왜 그렇게 작동하는지 이해하고 싶다면
그렇습니다. Three-Layer Architecture는 가장 기본적인 참고 자료입니다.
책에 나오는 프레임워크.

-----------------------------------------------------------

## <a href="#source-code-analysis" class="header">소스코드 분석</a>

### <a href="#11-tech-stack-overview-typescript--react-ink--bun"
class="header">1.1 기술 스택 개요: TypeScript + React Ink + Bun</a>

Claude Code의 기술 선택은 한 문장으로 요약될 수 있습니다.
**유형 안전성을 위한 TypeScript, 구성 요소화된 터미널 UI를 위한 React Ink
기능 및 시작 속도 및 빌드 시간 최적화를 위한 Bun**.

#### <a href="#typescript-the-application-layer-language"
class="header">TypeScript: 애플리케이션 계층 언어</a>

전체 코드베이스는 1,884개의 TypeScript 소스 파일로 구성됩니다.
TypeScript의 유형 시스템은 AI 에이전트 개발에서 고유한 이점을 가지고 있습니다.
도구 입력/출력 스키마는 유형에서 직접 생성될 수 있습니다.
정의 및 이러한 스키마는 모델에 전송되는 JSON 스키마가 됩니다.
— 유형 정의, 런타임 검증 및 모델 지침이 통합되었습니다.
하나로.

#### <a href="#react-ink-the-terminal-ui-framework" class="header">반응 잉크:
터미널 UI 프레임워크</a>

Claude Code의 대화형 인터페이스는 전통적인 readline REPL이 아닙니다.
그러나 완전한 React 애플리케이션입니다. React Ink는 React의 구성 요소 모델을 제공합니다.
복잡한 UI 상태 관리(스트리밍 출력,
병렬 다중 도구 표시, 권한 대화 상자)를 표현합니다.
선언적으로. 기본 UI 구성 요소는 다음 위치에 있습니다.
`restored-src/src/screens/REPL.tsx`(그 자체가 React 구성요소임)
5,000줄이 넘는다.

#### <a href="#bun-runtime-and-build-tool" class="header">번: 런타임 및
빌드 도구</a>

Bun은 여기서 이중 역할을 수행합니다.

1. **런타임**: Node.js보다 빠른 시작 속도, CLI에 중요
도구 — 사용자는 `claude`를 입력한 후 즉각적인 응답을 기대합니다.
2. **빌드 도구**: 에서 제공하는 `feature()` 기능을 통해
`bun:bundle`, 빌드 타임 DCE(Dead Code Elimination)를 활성화합니다.
이는 전체 기능 플래그 시스템의 초석입니다.

-----------------------------------------------------------

### <a href="#12-entry-point-analysis-startup-orchestration-in-maintsx"
class="header">1.2 진입점 분석: 시작 오케스트레이션
<code>main.tsx</code></a>

`main.tsx`은 전체 애플리케이션의 진입점입니다. 처음 20
코드 줄은 신중하게 설계된 시작 최적화를 보여줍니다.
전략.

#### <a href="#parallel-prefetch" class="header">병렬 프리페치</a>

``` typescript
// restored-src/src/main.tsx:9-20 (ESLint comments and blank lines omitted)
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js';
profileCheckpoint('main_tsx_entry');

import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';
startMdmRawRead();

import { ensureKeychainPrefetchCompleted, startKeychainPrefetch }
  from './utils/secureStorage/keychainPrefetch.js';
startKeychainPrefetch();
```

코드 구성에 유의하세요. 각 `import` 바로 뒤에는
부작용 전화. 소스 주석(`restored-src/src/main.tsx:1-8`)
설계 의도를 명시적으로 설명합니다.

1. **`profileCheckpoint`**: 항목 앞에 항목 타임스탬프를 표시합니다.
헤비급 모듈 평가 시작
2. **`startMdmRawRead`**: MDM(모바일 장치 관리)을 생성합니다.
하위 프로세스(macOS의 경우 `plutil` / Windows의 경우 `reg query`)를 허용합니다.
후속 ~135ms 가져오기 평가와 동시에 실행
3. **`startKeychainPrefetch`**: 두 개의 macOS 키체인 읽기를 시작합니다.
병렬 작업(OAuth 토큰 및 레거시 API 키) — 없음
미리 가져오면 `isRemoteManagedSettingsEligible()`이(가) 읽을 것입니다.
동기 생성을 통해 순차적으로 각 시작에 ~65ms를 추가합니다.

이 세 가지 작업은 동일한 패턴을 따릅니다. **I/O 집약적인 푸시
모듈 로딩 중에 작업을 "데드 타임"으로 실행
평행한**. 이것은 우연한 최적화가 아닙니다. ESLint 주석
`// eslint-disable-next-line custom-rules/no-top-level-side-effects`
팀에 최상위 수준의 부작용을 금지하는 맞춤 규칙이 있음을 나타냅니다.
이는 신중하게 고려한 후 고의적으로 면제된 것입니다.

**실패 모드**: 이러한 미리 가져오기 작업은 모두 "최선의 노력"입니다. 만약에
키체인 액세스가 거부되었습니다(사용자가 승인하지 않음).
`ensureKeychainPrefetchCompleted()`은 null을 반환하고 앱은 대체됩니다.
대화형 자격 증명 프롬프트에. MDM 하위 프로세스가 시간 초과되면
후속 `plutil` 호출은 동기적으로 재시도됩니다. 이는 "낙관적
병렬 + 비관적 폴백' 설계로 프리패치 실패 보장
시작을 차단하지 마십시오.

#### <a href="#lazy-import" class="header">지연 가져오기</a>

병렬 프리페치 후 `main.tsx`은 두 번째 시작을 보여줍니다.
최적화 전략 — 조건부 지연 가져오기:

``` typescript
// restored-src/src/main.tsx:70-80 (helper functions and ESLint comments omitted)
const getTeammateUtils = () =>
  require('./utils/teammate.js') as typeof import('./utils/teammate.js');
// ...

const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js') as ...
  : null;

const assistantModule = feature('KAIROS')
  ? require('./assistant/index.js') as ...
  : null;
```

여기에는 두 가지 다른 지연 로딩 전략이 있습니다:

- **기능이 래핑된 `require`** (예: `getTeammateUtils`): 다음과 같이 사용됩니다.
순환 종속성 깨기
(`teammate.ts -> AppState.tsx -> ... -> main.tsx`), 해결
호출될 때만 모듈
- **기능 플래그 보호 `require`** (예: `coordinatorModeModule`):
빌드 시간 제거를 위해 Bun의 `feature()`을 사용합니다.
`COORDINATOR_MODE`은 `false`이고 전체 `require` 표현식과 해당 표현식
가져온 모듈 트리가 빌드 출력에서 ​​제거됩니다.

#### <a href="#startup-flow-overview" class="header">시작 흐름
개요</a>

``` mermaid
flowchart TD
    A["main.tsx Entry"] --> B["profileCheckpoint<br/>Mark entry time"]
    B --> C["Parallel Prefetch"]
    C --> C1["startMdmRawRead<br/>MDM Subprocess"]
    C --> C2["startKeychainPrefetch<br/>Keychain Read"]
    C --> C3["Module Loading<br/>~135ms import evaluation"]
    C1 & C2 & C3 --> D["feature() Evaluation<br/>Build-time Flag Resolution"]
    D --> E["Conditional require<br/>Lazy Import of Experimental Modules"]
    E --> F["React Ink Render<br/>REPL.tsx Mount"]

    style C fill:#e8f4f8,stroke:#2196F3
    style D fill:#fff3e0,stroke:#FF9800
```

**그림 1-1: main.tsx 시작 흐름**

#### <a href="#feature-flags-as-gates" class="header">기능 플래그
게이트</a>

21번째 줄부터 `feature('...')` 함수가 전체적으로 나타납니다.
항목 파일:

``` typescript
// restored-src/src/main.tsx:21
import { feature } from 'bun:bundle';
```

`bun:bundle`의 이 `feature()` 함수는 다음을 이해하는 데 핵심입니다.
전체 기능 플래그 시스템. 이는 런타임 조건이 아닙니다.
**컴파일 시간 상수**. Bun의 번들러가 `feature('X')`을 처리할 때,
빌드에 따라 `true` 또는 `false` 리터럴로 대체합니다.
구성 및 JavaScript 엔진의 데드 코드 제거로 제거됩니다.
도달할 수 없는 가지.

> **참고**: `bun:bundle`의 `feature()`은(는) 공개적으로 문서화된 Bun이 아닙니다.
> API이지만 Anthropic의 사용자 정의 조건부 컴파일 메커니즘입니다.
> 파이프라인을 구축합니다. 이는 Claude Code의 빌드가
> Bun의 특정 버전.

-----------------------------------------------------------

### <a href="#13-three-layer-architecture" class="header">1.3 3레이어
아키텍처</a>

Claude Code의 아키텍처는 세 개의 레이어로 나눌 수 있습니다.
명확하게 정의된 책임. 이 건축 모델은
후속 장에서 반복적으로 참조 — 3장의 에이전트 루프
애플리케이션 계층에서 실행됩니다. 4장의 도구 실행 조정
애플리케이션 및 런타임 계층과 13~15장의 캐싱을 포괄합니다.
최적화에는 세 가지 계층 모두에 걸친 협업이 포함됩니다.

``` mermaid
graph TB
    subgraph L1["Application Layer"]
        direction TB
        TS["TypeScript Source<br/>1,884 files"]
        RI["React Ink<br/>Terminal UI Framework"]
        AL["Agent Loop<br/>query.ts State Machine"]
        TL["Tool System<br/>40+ tools"]
        SP["System Prompt<br/>Segmented Composition"]

        TS --> RI
        TS --> AL
        TS --> TL
        TS --> SP
    end

    subgraph L2["Runtime Layer"]
        direction TB
        BUN["Bun Runtime<br/>Fast Startup + ESM"]
        BB["bun:bundle<br/>feature() DCE"]
        JSC["JavaScriptCore<br/>JS Engine"]

        BUN --> BB
        BUN --> JSC
    end

    subgraph L3["External Dependencies Layer"]
        direction TB
        NPM["npm Packages<br/>commander, chalk, lodash-es..."]
        API["Anthropic API<br/>Model Calls + Prompt Cache"]
        MCP_S["MCP Servers<br/>External Tool Extensions"]
        GB["GrowthBook<br/>Runtime Feature Flags"]
    end

    L1 --> L2
    L2 --> L3
    L3 -.->|"Model responses, Flag values<br/>percolate upward"| L1

    style L1 fill:#e8f4f8,stroke:#2196F3,stroke-width:2px
    style L2 fill:#fff3e0,stroke:#FF9800,stroke-width:2px
    style L3 fill:#f3e5f5,stroke:#9C27B0,stroke-width:2px
```

**그림 1-2: Claude Code 3계층 아키텍처**

#### <a href="#application-layer-typescript" class="header">애플리케이션 계층
(타입스크립트)</a>

애플리케이션 계층은 모든 비즈니스 로직이 상주하는 곳입니다. 여기에는 다음이 포함됩니다.

- **에이전트 루프**(`query.ts`): 에이전트 루프를 조정하는 핵심 상태 머신
"모델 호출 -\> 도구 실행 -\> 계속 결정" 루프(참조
제3장)
- **도구 시스템** (`tools.ts` + `tools/` 디렉토리): 등록,
권한 확인 및 40개 이상의 도구 실행(2장 참조)
- **시스템 프롬프트** (`constants/prompts.ts`): 분할된 구성
프롬프트 아키텍처(5장 참조)
- **React Ink UI** (`screens/REPL.tsx`): 선언적 렌더링
터미널 인터페이스

#### <a href="#runtime-layer-bunjsc" class="header">런타임 레이어
(번/JSC)</a>

런타임 계층은 세 가지 주요 기능을 제공합니다.

1. **빠른 시작**: Bun의 시작 속도는 CLI 도구에 매우 중요합니다.
경험
2. **빌드 시간 최적화**: `bun:bundle`의 `feature()` 기능
컴파일 타임 기능 플래그 제거 가능
3. **JavaScript 엔진**: Bun은 JavaScriptCore(JSC, Safari의 JS)를 사용합니다.
엔진) V8이 아닌 후드 아래

#### <a href="#external-dependencies-layer" class="header">외부
종속성 계층</a>

외부 종속성 계층에는 다음이 포함됩니다.

- **npm 패키지**: `commander`(CLI 인수 구문 분석), `chalk`
(터미널 색상), `lodash-es` (유틸리티 기능) 등
- **Anthropic API**: 모델 호출 및 프롬프트 캐시를 위한 서버 측
- **MCP(Model Context Protocol) 서버**: 외부 도구 확장
능력
- **GrowthBook**: 런타임 A/B 테스트 및 기능 플래그 서비스

### <a href="#appstate-cross-layer-state-management"
class="header">AppState: 교차 레이어 상태 관리</a>

3계층 아키텍처는 코드의 정적 구성을 설명합니다.
하지만 런타임 시 레이어에는 조정을 위해 공유 상태 컨테이너가 필요합니다.
행동. Claude Code의 솔루션은 `AppState`입니다. — Zustand에서 영감을 얻었습니다.
`restored-src/src/state/`에 정의된 불변 상태 저장소
예배 규칙서.

#### <a href="#the-stores-minimal-implementation" class="header">가게의
최소 구현</a>

상태 저장소의 핵심은 단 34줄의 코드입니다.
(`restored-src/src/state/store.ts:1-34`):

``` typescript
// restored-src/src/state/store.ts:10-34
export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,
    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return   // Reference equality → skip notification
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

이 스토어에는 세 가지 주요 디자인 특성이 있습니다.

1. **불변 업데이트**: `setState`은 `(prev) => next`을 허용합니다.
업데이터 기능; 호출자는 새로운 객체를 반환해야 합니다.
제자리에서 돌연변이), `Object.is`이 실제인지 여부를 결정합니다.
변화가 발생했습니다
2. **게시-구독**: 관찰자 패턴은 다음을 통해 구현됩니다.
`subscribe` / `listeners`; 모든 코드(React 또는 비React)는
상태 변경 구독
3. **콜백 변경**: 모든 상태에서 `onChange` 후크가 호출됩니다.
변화; `onChangeAppState`
(`restored-src/src/state/onChangeAppState.ts:43`)는 이를 사용하여
CCR/SDK에 대한 권한 모드 변경 동기화, 자격 증명 지우기
캐시, 환경 변수 적용 및 기타 부작용

#### <a href="#react-side-usesyncexternalstore-integration"
class="header">반응 측: useSyncExternalStore 통합</a>

React 구성 요소는 `useAppState` Hook을 통해 상태 슬라이스를 구독합니다.
(`restored-src/src/state/AppState.tsx:142-163`):

``` typescript
// restored-src/src/state/AppState.tsx:142-163
export function useAppState(selector) {
  const store = useAppStore();
  const get = () => selector(store.getState());
  return useSyncExternalStore(store.subscribe, get, get);
}
```

`useSyncExternalStore`은 안전을 위해 특별히 설계된 React 18 API입니다.
외부 저장소를 React의 동시 모드와 통합합니다. 각
구성 요소는 관심 있는 슬라이스만 구독합니다. 예를 들어 다음과 같습니다.
`useAppState(s => s.verbose)`은 다음 경우에만 다시 렌더링을 트리거합니다.
`verbose` 필드가 변경됩니다. REPL.tsx에는 20개 이상의 `useAppState` 호출이 있습니다.
(`restored-src/src/screens/REPL.tsx:618-639`), 각각 정확하게 선택
단일 상태 필드로 불필요한 UI 새로 고침을 방지합니다.

#### <a href="#non-react-side-direct-store-access" class="header">비반응
측면: 매장 직접 접속</a>

React 구성 요소 트리 외부 — CLI 처리기, 도구 실행기, 후크
콜백 — 코드는 `store.getState()`을 통해 직접 상태를 읽고 씁니다.
`store.setState()`을 통해. 예를 들어:

- 요청 취소 중 작업 목록 읽기:
`store.getState().tasks`
(`restored-src/src/hooks/useCancelRequest.ts:173`)
- MCP 연결 관리에서 클라이언트 목록 읽기:
`store.getState().mcp.clients`
(`restored-src/src/services/mcp/useManageMCPConnections.ts:1044`)
- 받은편지함 폴링에서 팀 컨텍스트 읽기: `store.getState()`
(`restored-src/src/hooks/useInboxPoller.ts:143`)

이 이중 액세스 패턴 — 구독 기반 `useAppState`을 통해 반응합니다.
명령형 `getState()`을 통한 non-React — 동일한 상태 저장을 허용합니다.
선언적 UI 렌더링과 필수 비즈니스를 동시에 제공합니다.
논리.

#### <a href="#the-scale-of-state" class="header">상태 규모</a>

`AppState`의 유형 정의
(`restored-src/src/state/AppStateStore.ts:89-452`)은 360개 이상의 줄에 걸쳐 있습니다.
다음을 다루는 60개 이상의 최상위 필드 포함: 설정 스냅샷
(`settings`), 권한 컨텍스트(`toolPermissionContext`), MCP
연결 상태(`mcp`), 플러그인 시스템(`plugins`), 작업 레지스트리
(`tasks`), 팀 협업 컨텍스트(`teamContext`), 추측
실행(`speculation`) 등이 있습니다. 핵심 필드는 다음과 같이 래핑됩니다.
`DeepImmutable<>`은 컴파일 시간 불변성을 보장하지만 필드는
`tasks`, `mcp` 및 `plugins`와 같은 함수 유형을 포함하는 것은
제외된.

이 주립 상점의 디자인은 Claude Code 아키텍처를 반영합니다.
철학: **흩어진 모듈 수준 변수를 단일 변수로 대체
상태 흐름과 종속성을 추적 가능하게 만드는 전역 상태 저장소**. 언제
후속 장에서는 "에이전트 루프가 권한 모드를 읽습니다"라고 언급합니다.
또는 "도구 실행자가 MCP 연결을 확인합니다"라고 하면 모두 액세스 중입니다.
동일한 `AppState` 인스턴스의 다른 조각.

-----------------------------------------------------------

#### <a href="#the-significance-of-layer-boundaries" class="header">
레이어 경계의 중요성</a>

Three-Layer Architecture의 핵심은 **방향에 있습니다.
레이어 간 정보 흐름**:

- 애플리케이션 계층 -\> 런타임 계층: TypeScript 코드는 다음으로 컴파일됩니다.
자바스크립트; `feature()` 호출이 이 시점에서 해결되었습니다.
- 런타임 계층 -\> 외부 종속성 계층: HTTP 요청, npm
패키지 로딩, MCP 연결
- 외부 종속성 레이어 -\> 애플리케이션 레이어: 모델 응답,
도구 결과, 기능 플래그 값 — 이 정보는 ** 투과됩니다.
상향** 두 계층을 통해 다시 애플리케이션 계층으로

이 여과 경로를 이해하는 것이 중요합니다.
`tengu_*` 기능 플래그에 대한 새 값을 반환하지만
빌드 시간 `feature()` 함수(이미 빌드 시 구워졌습니다.)
시간)이 아니라 런타임 조건부 논리입니다. Claude Code에는 **두 가지가 있습니다.
병렬 기능 플래그 메커니즘**: 빌드 시간 `feature()` 및 런타임
다양한 목적을 제공하는 GrowthBook(자세한 내용은 나중에 설명)

-----------------------------------------------------------

### <a href="#14-why-on-distribution-matters" class="header">1.4 "On" 이유
유통'이 중요하다</a>

'배포에 대하여'는 클로드 코드를 이해하는 핵심 개념이다.
아키텍처 결정과 이 책의 핵심 주장 중 하나입니다.
기존 CLI 도구는 개발 시 **모든 기능을 정의합니다.
시간** 후 사용자에게 배포합니다. 하지만 AI 코딩 에이전트는 다르다
— 해당 동작은 **사용 시 모델에 의해 동적으로 결정됩니다.
시간**.

구체적으로:

1. **모델은 도구를 선택합니다**: 에이전트 루프의 각 반복에서
모델은 호출할 도구와 전달할 매개변수를 결정합니다. 에이
도구의 `description` 및 `inputSchema`은 단순한 문서가 아닙니다.
모델에 전송된 지침입니다.
2. **모델은 자체 도구를 작성합니다**: `BashTool`을 통해 모델은
임의의 쉘 명령을 실행할 수 있습니다. `FileWriteTool`을 통해
모델은 새 파일을 만들 수 있습니다. `SkillTool`을 통해 모델을 로드할 수 있습니다.
사용자 정의 프롬프트 템플릿 실행
3. **모델은 자체 컨텍스트에 따라 작동합니다**: 압축을 통해
Microcompact 및 Context Collapse에 참여하는 모델
자체 컨텍스트 창 관리

이는 기술 스택이 전통적인 차원을 고려해야 함을 의미합니다.
소프트웨어는 다음을 수행하지 않습니다. **모델은 런타임의 일부이며 해당 동작
코드에 의해 완전히 제어되지는 않지만 코드에 의해 집합적으로 형성됩니다.
프롬프트, 도구 설명 및 컨텍스트**.

#### <a href="#deep-impact-on-architecture" class="header">딥 임팩트
아키텍처</a>

"배포에 관하여"는 단지 추상적인 개념이 아니라 직접적으로 형태를 형성하는 것입니다.
Claude Code의 몇 가지 핵심 아키텍처 결정:

**테스트 및 검증의 근본적인 어려움.** 기존
소프트웨어는 단위 및 통합 테스트를 통해 모든 코드 경로를 포괄할 수 있습니다.
그러나 모델이 의사결정에 참여할 때 동일한 입력이
다양한 도구 호출 순서를 생성합니다. Claude Code의 접근 방식은 다음과 같습니다.
가능한 모든 모델 동작을 다루려고 노력하는 대신 (a)를 통해
페일클로즈 기본값(2장 참조)은 모든 도구 호출이 안전한지 확인합니다. (b)
권한 시스템(16장 참조)을 통해 인간 체크포인트 설정
위험한 작업 전, (c) A/B 테스트를 통해(7장 참조)
실제 사용 시 동작 변경 사항을 검증합니다.

**API 계약에 따른 도구 설명.** 기존 소프트웨어에서는 API
문서는 인간 개발자를 위한 것입니다. AI 에이전트의 도구 설명
모델에 대한 지침입니다. 이는 도구의 `description` 필드를 의미합니다.
"이 도구의 기능"만 설명할 수는 없으며 "언제
모델은 이 도구를 사용해야 합니다." 8장에서는 도구가 어떻게 사용되는지 심층적으로 분석합니다.
프롬프트는 "마이크로 하네스" 역할을 합니다.

**기능 플래그는 모델의 인지 경계를 제어합니다.**
`feature('WEB_BROWSER_TOOL')`는 `false`입니다. 모델은 사용할 수 없을 뿐만 아니라
브라우저 도구 - 브라우저 도구가 존재하는지조차 알지 못합니다.
도구 스키마에는 이를 포함하지 않습니다.

``` typescript
// restored-src/src/tools.ts:117-119
const WebBrowserTool = feature('WEB_BROWSER_TOOL')
  ? require('./tools/WebBrowserTool/WebBrowserTool.js').WebBrowserTool
  : null;
```

이는 "배포 중"을 가장 직접적으로 표현한 것입니다.
결정은 모델의 런타임 기능 경계에 직접적인 영향을 미칩니다.

#### <a href="#comparison-with-traditional-software"
class="header">기존 소프트웨어와의 비교</a>

<div class="table-wrapper">

| 차원 | 기존 CLI 도구 | AI 코딩 에이전트 |
|----|----|----|
| 행동 결정론 | 결정론적 — 동일한 입력이 동일한 출력을 생성 | 비결정적 - 모델이 다른 도구 순서를 선택할 수 있음 |
| 능력 경계 | 컴파일 타임에 수정됨 | 빌드 시간(`feature()`) + 런타임(모델 결정)에 의해 이중으로 결정 |
| API 문서 독자 | 인간 개발자 | 모델 - 문서는 참조가 아닌 지침입니다 |
| 테스트 전략 | 표지 코드 경로 | 안전 경계(권한 + 페일클로즈) |
| 버전 관리 | 코드 버전 = 동작 버전 | 코드 버전 x 모델 버전 x 프롬프트 버전 |

</div>

-----------------------------------------------------------

### <a href="#15-build-time-dead-code-elimination-how-feature-works"
class="header">1.5 빌드 시 데드 코드 제거: 방법
<code>feature()</code> 작동</a>

`feature()` 함수는 Bun의 번들러 모듈 `bun:bundle`에서 제공됩니다.
빌드 타임을 구현하기 위해 Claude Code에서 광범위하게 사용됩니다.
조건부 컴파일.

#### <a href="#mechanism" class="header">메커니즘</a>

Bun의 번들러가 `feature('X')` 호출을 발견하면:

1. 빌드 구성에서 `X` 값을 조회합니다.
2. `feature('X')`을 리터럴 `true` 또는 `false`로 대체합니다.
3. JavaScript 엔진의 최적화 프로그램은 도달할 수 없는 분기를 식별합니다.
그리고 그것들을 제거합니다

이는 다음 코드를 의미합니다.

``` typescript
const SleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null;
```

`PROACTIVE=false, KAIROS=false`을 사용한 빌드에서는 다음과 같습니다.

``` typescript
const SleepTool = false || false
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null;
```

그런 다음 `const SleepTool = null;` 및 `SleepTool.js`에 최적화됩니다.
전체 종속성 트리와 함께 최종 번들에는 표시되지 않습니다.

#### <a href="#usage-patterns" class="header">사용 패턴</a>

`tools.ts`에서 `feature()` 사용은 네 가지 패턴을 따릅니다. 단일 플래그
가드, 다중 플래그 OR 조합, 다중 플래그 AND 조합 및 배열
확산. 이러한 패턴은 `commands.ts`에도 나타납니다.
(`restored-src/src/commands.ts:59-100`), 가용성 제어
슬래시 명령. 도구 등록 파이프라인의 전체 분석
2장에서 다룬다.

#### <a href="#distinction-from-runtime-flags" class="header">구별
런타임 플래그에서</a>

Claude Code에는 혼동하기 쉬운 두 가지 기능 플래그 메커니즘이 있습니다.

<div class="table-wrapper">

| 차원 | 빌드 시간 `feature()` | 런타임 성장책 `tengu_*` |
|----|----|----|
| 해결 시기 | 빵 동고중 | 세션 시작 시 GrowthBook에서 가져옴 |
| 영향 범위 | 번들에 코드가 존재하는지 여부 | 코드 논리의 런타임 분기 |
| 수정 방법 | 재구축 및 릴리스 필요 | 서버 측 구성이 즉시 적용됩니다 |
| 일반적인 사용 사례 | 실험적 기능을 위한 완전한 모듈 트리 제거 | A/B 테스트, 점진적 출시 |
| 예 | `feature('KAIROS')` | `tengu_ultrathink_enabled` |

</div>

둘은 상호보완적입니다. `feature()`은 "이 기능이 존재합니까?"를 의미합니다.
GrowthBook은 "어떤 사용자가 이 기능을 사용할 수 있는지"에 대한 것입니다. 특징
일반적으로 모듈 로딩은 `feature()`에 의해 먼저 보호되고 그 다음에는
GrowthBook에 의해 제어되는 런타임 동작.

-----------------------------------------------------------

### <a href="#16-tool-registration-pipeline-feature-flags-in-practice"
class="header">1.6 도구 등록 파이프라인: 기능 플래그
연습</a>

`tools.ts`의 `getAllBaseTools()` 함수
(`restored-src/src/tools.ts:193-251`)가 가장 집중된 쇼케이스입니다.
기능 플래그 시스템의 네 가지 도구를 보여줍니다.
등록 전략:

#### <a href="#strategy-1-unconditional-registration" class="header">전략
1: 무조건 등록</a>

``` typescript
// restored-src/src/tools.ts:195-209 (only listing some core tools)
AgentTool,
TaskOutputTool,
BashTool,
// ... GlobTool/GrepTool (conditional, see Strategy 4)
FileReadTool,
FileEditTool,
FileWriteTool,
NotebookEditTool,
WebFetchTool,
WebSearchTool,
// ...
```

이는 핵심 도구(약 12개)이며 항상 추가 비용 없이 사용할 수 있습니다.
정황.

#### <a href="#strategy-2-build-time-feature-flag-guard"
class="header">전략 2: 빌드 시간 기능 플래그 가드</a>

``` typescript
// restored-src/src/tools.ts:217
...(WebBrowserTool ? [WebBrowserTool] : []),
```

`WebBrowserTool`은(는) 다음을 통해 파일 상단에서 보호됩니다.
`feature('WEB_BROWSER_TOOL')` — 플래그가 false인 경우 변수는
`null`, 이는 빈 배열로 확산됩니다. **도구의 전체 코드
빌드 출력**에 존재하지 않습니다.

#### <a href="#strategy-3-runtime-environment-variable-guard"
class="header">전략 3: 런타임 환경 변수 가드</a>

``` typescript
// restored-src/src/tools.ts:214-215
...(process.env.USER_TYPE === 'ant' ? [ConfigTool] : []),
...(process.env.USER_TYPE === 'ant' ? [TungstenTool] : []),
```

`ConfigTool` 및 `TungstenTool`은 런타임에 의해 제어됩니다.
환경 변수 `USER_TYPE` - 해당 코드가 빌드 출력에 존재합니다.
그러나 Anthropic 내부 사용자(`ant`)에게만 표시됩니다. 이것은
A/B 테스트를 위한 "스테이징 영역" 패턴: 이전에 내부적으로 검증
외부 사용자에게 공개됩니다.

#### <a href="#strategy-4-runtime-function-guard" class="header">전략 4:
런타임 함수 가드</a>

``` typescript
// restored-src/src/tools.ts:201
...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
```

이것은 역방향 가드입니다. Bun의 단일 파일 실행 파일에 검색이 있는 경우
내장된 도구(`bfs`/`ugrep`), 독립형 `GlobTool` 및 `GrepTool`
모델이 이러한 내장 도구에 액세스할 수 있기 때문에 실제로 제거됩니다.
`BashTool`을 통해. 이 전략은 동등한 검색 기능을 보장합니다.
서로 다른 기본 버전을 사용하여 다양한 빌드 버전에 걸쳐
구현.

-----------------------------------------------------------

### <a href="#17-the-full-landscape-of-89-feature-flags" class="header">1.7
89개 기능 플래그의 전체 모습</a>

소스 코드에서 모든 `feature('...')` 호출을 추출하여
89개의 빌드 타임 기능 플래그를 식별했습니다. 전체 목록과
분류는 부록 D에서 확인할 수 있습니다. 여기서는 이러한 항목에 중점을 둡니다.
플래그는 제품 방향에 대해 공개합니다.

**KAIROS 계열**(6개의 플래그, 84개 이상의 결합 참조): 이것은
완전한 "보조 모드" 제품을 가리키는 가장 큰 플래그 클러스터 —
자율 백그라운드 작업(`KAIROS`), 메모리 큐레이션
(`KAIROS_DREAM`), 푸시 알림(`KAIROS_PUSH_NOTIFICATION`),
GitHub Webhook 통합(`KAIROS_GITHUB_WEBHOOKS`). 이것은 아니다
CLI 도구의 향상 - 완전히 다른 제품 형태입니다.

**다중 에이전트 오케스트레이션** (`COORDINATOR_MODE` + `TEAMMEM` +
`UDS_INBOX`, 90개 이상의 통합 참조): 다중 에이전트를 위한 인프라
협업 — 작업자 할당, 팀원 메모리 공유, Unix 도메인
소켓 프로세스 간 통신(20장 참조)

**원격 및 분산** (`BRIDGE_MODE` + `DAEMON` + `CCR_*`): 원격
제어 및 분산 실행 — 로컬에서 Claude Code 확장
원격으로 제어 가능한 에이전트 플랫폼에 대한 CLI입니다.

**컨텍스트 최적화** (`CONTEXT_COLLAPSE` + `CACHED_MICROCOMPACT` +
`REACTIVE_COMPACT`): 컨텍스트 관리의 세 가지 세분화
200K 내에서 팀의 지속적인 탐색을 반영하는 전략
토큰 창(3부 참조).

**분류자 시스템** (`TRANSCRIPT_CLASSIFIER` 69개 참조 +
`BASH_CLASSIFIER` 참고문헌 33개): 두 가지 주요 분류자가 핵심이다
자동 모드 — 전자는 권한을 결정하고 후자는 분석합니다.
안전 명령(17장 참조).

89개 Flags의 수는 이야기를 말해줍니다. Claude Code는 마구간이 아닙니다.
완제품이지만 빠르게 반복되는 실험 플랫폼입니다. 각
플래그는 탐구되는 방향을 나타내며, 그 존재는
"유통" 철학을 직접적으로 표현한 팀입니다.
모델이 무엇을 할 수 있고 무엇을 해야 하는지 지속적으로 실험합니다.

-----------------------------------------------------------

## <a href="#pattern-extraction" class="header">패턴 추출</a>

### <a href="#pattern-1-parallel-prefetch-at-startup" class="header">패턴
1: 시작 시 병렬 프리페치</a>

- **문제 해결**: CLI 도구 시작 시간이 사용자에게 직접적인 영향을 미칩니다
경험; I/O 작업(키체인 읽기, MDM 쿼리) 블록 시작
- **핵심 접근 방식**: I/O 집약적인 작업을 "데드 타임"으로 밀어 넣습니다.
모듈을 로딩하는 동안 병렬로 실행됩니다. `ensureXxxCompleted()` 사용
필요할 때 결과를 기다리기 위해
- **전제 조건**: I/O 작업은 멱등성, 오류 방지 기능을 갖추고 있어야 합니다.
명확한 시간 초과 및 대체 경로가 있어야 합니다.
- **출처 참조**: `restored-src/src/main.tsx:9-20`

### <a href="#pattern-2-dual-layer-feature-flags" class="header">패턴 2:
이중 레이어 기능 플래그</a>

- **문제 해결됨**: 실험적 기능을 다양한 방식으로 제어해야 함
세분성 — "코드에 기능이 존재합니까?" 및 "어떤 사용자가
기능 가져오기'는 두 개의 독립적인 차원입니다.
- **핵심 접근 방식**: 빌드 시간 `feature()`은 전체 모듈을 제거합니다.
나무; 런타임 GrowthBook은 동작 매개변수를 제어합니다. 전자
모델이 "볼" 수 있는 도구를 결정합니다. 후자가 결정한다
모델의 동작 구성
- **전제 조건**: 빌드 도구가 컴파일 시간 상수를 지원합니다.
교체 및 DCE; 런타임 플래그 서비스(예: GrowthBook,
LaunchDarkly)를 사용할 수 있습니다.
- **소스 참조**: `restored-src/src/main.tsx:21`(기능 가져오기),
`restored-src/src/tools.ts:117-119` (툴 게이팅)

### <a href="#pattern-3-model-aware-api-design" class="header">패턴 3:
모델 인식 API 설계</a>

- **문제 해결**: AI 에이전트 아키텍처는 설계뿐만 아니라
인간 개발자뿐만 아니라 모델을 위한 도구 설명은 다음과 같습니다.
단순한 문서가 아닌 모델의 지침
- **핵심 접근 방식**: 도구의 `description` 및 `inputSchema`
인간 문서화, 런타임이라는 세 가지 목적을 동시에 수행합니다.
검증 및 모델 지침. 유형 정의 -\> 스키마 -\>
모델 지침이 하나로 통합됨
- **선행조건**: 스키마 생성을 지원하는 타입 시스템
(예: TypeScript + Zod)
- **소스 참조**: `restored-src/src/Tool.ts` (도구 인터페이스
정의, 2장 참조)

### <a href="#pattern-4-fail-closed-defaults" class="header">패턴 4:
페일클로즈 기본값</a>

- **문제 해결됨**: 새로운 도구에 보안 또는 동시성이 도입될 수 있음
위험; 기본값은 "누군가가 잊어버렸을 때의 동작을 결정합니다.
구성"
- **핵심 접근 방식**: 모든 도구 속성의 기본값은 가장 안전한 값입니다.
(`isConcurrencySafe: false`, `isReadOnly: false`); 명백한
잠금을 해제하려면 선언이 필요합니다.
- **전제 조건**: "안전함"과 "안전하지 않음"에 대한 명확한 정의
중앙 위치에서 관리되는 기본값
- **출처 참조**: `restored-src/src/Tool.ts:748-761`
(`TOOL_DEFAULTS`, 2장과 25장 참조)

-----------------------------------------------------------

## <a href="#what-you-can-do" class="header">할 수 있는 일</a>

자신만의 AI 에이전트 시스템을 구축하는 경우 실행 가능한 방법은 다음과 같습니다.
이 장의 분석에서 직접 적용할 수 있는 제안은 다음과 같습니다.

1. **시작 시간을 최적화합니다.** 컴퓨터에서 I/O 차단 지점을 식별합니다.
에이전트의 시작 경로(인증 정보 읽기, 구성 로드, 모델
워밍업)을 수행하고 병렬화합니다. 사용자가 인식하는 '최초 도달 시간'
반응'은 도구 품질 판단에 직접적인 영향을 미칩니다.
2. **빌드 타임 플래그와 런타임 플래그를 구별합니다.**
실험적 기능을 사용하려면 빌드 시간 제거를 사용하는 것이 좋습니다.
"기능이 존재하는지 여부"를 제어합니다(어떤 도구에 영향을 미치는지)
모델은 볼 수 있음) 및 "기능을 얻는 사람"을 제어하는 ​​런타임 플래그
(A/B 테스트, 점진적 출시)
3. **모델 친화적인 도구 설명을 디자인합니다.** 도구 설명
인간만을 위한 것이 아니라 모델 도구의 기초입니다.
선택. 다양한 설명 문구를 테스트하고 다음 사항을 관찰하십시오.
모델의 도구 선택 동작이 변경됩니다.
4. **기본값을 감사합니다.** 모든 기본값을 확인합니다.
도구 시스템의 구성 항목 - 새 도구 개발자인 경우
속성 설정을 잊어버린 경우 시스템의 동작은 다음과 같아야 합니다.
가장 안전하지만 가장 허용적이지는 않음
5. **3계층 아키텍처를 진단 프레임워크로 사용합니다.**
에이전트 동작이 비정상입니다. 3계층 모델을 사용하여
문제: 애플리케이션 계층 논리(프롬프트/도구 설명)입니까?
런타임 계층 구성(기능 플래그 상태)? 또는
외부 종속성 계층 응답(API 반환/MCP 서버 상태)?

다음 장에서는 도구 시스템, 즉 모델의 시스템에 대해 자세히 알아보겠습니다.
"손" - 40개 이상의 도구가 어떻게 확장 가능한 기능 시스템을 형성하는지 알아보세요.
통합 인터페이스 계약, 권한 모델 및 기능 플래그를 통해
근위 연대.

-----------------------------------------------------------

### <a href="#version-evolution-notes" class="header">버전 진화
참고</a>

> 본 장의 핵심 분석은 v2.1.88 소스코드를 기준으로 작성되었습니다. 처럼
> v2.1.92에서는 기술 스택에 큰 구조적 변화가 없습니다.
> 이 장에서는 시작 흐름을 다룹니다. 특정 신호 변경의 경우
> [부록 E](../appendix/e-version-evolution.html)를 참조하세요.
