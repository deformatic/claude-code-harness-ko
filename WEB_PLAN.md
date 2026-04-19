# 웹 배포 설계 초안

## 목표

- 이 저장소의 한국어 문서를 Vercel에 배포 가능한 홈페이지 형태의 웹사이트로 제공한다.
- 첫 화면은 "문서 저장소"가 아니라 책/아카이브처럼 보여야 한다.
- 각 문서는 개별 URL을 가지며, 검색 엔진과 공유 링크에 적합해야 한다.
- 런타임에 외부 원문 사이트를 가져오지 않고, 현재 저장소의 `ko/*.md`를 기준으로 정적 생성한다.

## 현재 상태 요약

- 저장소는 웹 애플리케이션이 아니라 문서 묶음이다.
- 주요 콘텐츠는 `ko/*.md`에 있다.
- 문서 안에는 일반 Markdown 외에 다음 요소가 섞여 있다.
- raw HTML heading: `<a href="#..." class="header">...</a>`
- 이미지 태그: `<img ... />`
- wrapper div: `<div class="table-wrapper">`
- 표
- 코드 블록
- Mermaid 블록
- 외부 링크
- 일부 문서는 기존 영문 GitHub Pages URL을 직접 가리킨다.

즉, 배포 핵심은 "홈페이지 제작"보다 먼저 "문서 렌더링 파이프라인 확정"이다.

## 권장 방향

- 프레임워크: Next.js App Router
- 배포 대상: Vercel
- 렌더링 전략: SSG(Static Site Generation) 우선
- 콘텐츠 소스: 로컬 Markdown 파일 직접 로드
- 검색/필터: 1차에서는 클라이언트 검색 또는 간단한 정적 인덱스

이 방향을 권장하는 이유:

- Vercel과 가장 자연스럽게 맞물린다.
- 문서 수가 많지만 API 서버가 필요 없다.
- 각 장을 빌드 시점에 HTML로 생성할 수 있다.
- 추후 검색, 다국어, OG 이미지, sitemap 확장이 쉽다.

## 정보 구조

### 1. 홈페이지 `/`

- 강한 서문형 히어로 섹션
- 책 소개
- 추천 읽기 경로 3종
- 파트별 구조 요약
- 대표 챕터 바로가기
- "바로 읽기" CTA

이 페이지는 문서 목록보다 먼저 "왜 읽어야 하는지"를 전달해야 한다.

### 2. 읽기 허브 `/read`

- 전체 목차
- 파트별 묶음
- 최근/추천 챕터
- 부록 구분
- 검색 입력

### 3. 문서 상세 `/read/[slug]`

- 본문 렌더링
- 우측 또는 상단 TOC
- 이전/다음 문서 이동
- 현재 파트 정보
- 원문 관련 링크

### 4. 읽기 경로 `/paths/[id]`

- Agent Builders
- Security Engineers
- Performance Optimization

이 페이지는 이후 추가 가능하지만, 구조상 초기에 고려해야 링크 설계가 흔들리지 않는다.

## 디자인 방향

### 톤

- "블로그"보다 "기술 아카이브 + 북 리더"에 가깝게 설계
- 지나치게 SaaS스럽지 않게 구성
- 첫 화면은 강한 제목, 구조화된 카드, 묵직한 타이포그래피 중심
- 다만 시각 언어는 원티드 Montage의 차분하고 읽기 쉬운 톤을 따른다.

### 비주얼 제안

- 배경: Montage의 `Background - Normal/Alternative` 계열처럼 안정적인 밝은 중립 배경
- 포인트 컬러: `Primary`를 액션에 제한적으로 사용하고, 본문은 `Label` 계열 대비로 해결
- 타이포그래피:
- 제목: 원티드 기본 방향에 맞춰 Pretendard JP 계열 우선
- 본문: Body Reading 스케일을 기본으로 사용
- 레이아웃:
- 홈페이지는 12컬럼 기반의 넓은 정보 구조
- 문서 상세는 읽기 밀도가 높은 narrow column 중심
- 간격은 8px 기반, 실제 UI 간격은 4배수 우선

### Montage 기준 적용 메모

- Typography:
- Display는 히어로 타이틀에만 제한적으로 사용
- 섹션 제목은 `Title` 또는 `Heading`
- 본문은 `Body 1/Reading`
- 보조 정보는 `Label 1/Reading` 또는 `Caption`
- Grid:
- 데스크톱은 최대 폭 1100px 기준
- 모바일 우선 반응형
- 20px gutter와 8px spacing 체계 준수
- Color:
- 본문 가독성은 `Label Normal/Strong` 중심
- 카드/패널은 `Background Alternative`, 구분선은 `Line Normal`
- 강조 배지는 `Accent` 또는 `Status` 계열로 제한 사용

### 가독성 원칙

- 문서 상세는 한 줄 폭을 과도하게 넓히지 않는다.
- 본문 line-height는 읽기용 스케일을 우선 사용한다.
- heading, 표, 코드블록, callout 간 간격 대비를 분명히 둔다.
- 강한 색 대비보다 타이포 위계와 여백으로 정보 구조를 드러낸다.
- 첫 화면도 장식보다 탐색성과 스캔 가능성을 우선한다.

### 핵심 UI 컴포넌트

- Hero
- Reading paths cards
- Part grid
- Chapter list
- Sticky table of contents
- Markdown prose renderer
- Prev/next navigator
- Callout / evidence badge

### Montage 컴포넌트 매핑

- 상단 전역 탐색: `Top navigation`
- 홈 섹션 제목: `Section header`
- 추천 경로/파트 요약: `Card` 또는 `List card`
- 문서 목록: `List cell`
- 문서 상세 TOC 전환: `Tab` 또는 단순 anchor nav
- 검색 UI: `Search field`
- 펼침형 파트 목록: `Accordion`
- 빈 상태/오류 상태: `Fallback view`
- 로딩 상태: `Skeleton`

## 콘텐츠 처리 아키텍처

### 원칙

- 문서는 빌드 시점에 읽고 가공한다.
- 브라우저에서 Markdown 파일을 fetch해서 렌더링하지 않는다.
- 이유는 SEO, 성능, Vercel 캐시, 내부 링크 정규화 때문이다.

### 처리 흐름

1. `ko/*.md` 파일 스캔
2. 파일명 기준으로 slug 생성
3. 제목, 파트, 순서 메타데이터 추출
4. Markdown 본문 정규화
5. React Markdown 기반 렌더링
6. 정적 페이지 생성

### 정규화에서 필요한 처리

- heading 내부의 `<a class="header">...</a>` 제거 후 순수 heading text로 변환
- `<div class="table-wrapper">`는 허용하되 스타일 컴포넌트로 감싼다
- 외부 영문 URL을 내부 라우트로 치환 가능한 경우 치환
- 이미지 상대 경로를 실제 정적 자산 경로로 해석
- Mermaid code fence는 클라이언트 컴포넌트에서 렌더링

## 라우팅 규칙

- `ko/preface.md` -> `/read/preface`
- `ko/part1-ch01.md` -> `/read/part1-ch01`
- `ko/appendix-a-file-index.md` -> `/read/appendix-a-file-index`
- `ko/01-map-toc.md`는 사용자 노출 페이지가 아니라 메타데이터 소스로 우선 사용

## 메타데이터 전략

별도 frontmatter가 없으므로 1차는 아래 규칙으로 메타데이터를 생성한다.

- `slug`: 파일명
- `title`: 첫 번째 h1
- `order`: 파일명 또는 `01-map-toc.md` 기반
- `section`: preface / part / appendix
- `partLabel`: `Part I`, `Part II` 등

권장:

- 추후 `content-manifest.ts` 또는 생성 스크립트로 메타데이터를 고정
- 문서 파일에 frontmatter를 직접 넣는 작업은 2차로 미룸

## 렌더링 스택 권장안

- `next`
- `react`
- `react-dom`
- `react-markdown`
- `remark-gfm`
- `rehype-raw`
- `rehype-slug`
- `rehype-autolink-headings`
- `gray-matter`는 현 시점에서는 선택 사항
- Mermaid는 클라이언트 렌더링

주의:

- `rehype-raw`를 쓰므로 허용 HTML 범위를 의식해서 콘텐츠를 다뤄야 한다.
- 다만 현재 문서가 저장소 내부 자산이므로 외부 사용자 입력보다는 위험이 낮다.

## 1차 구현 범위

- Next.js 앱 기본 골격
- 홈페이지 `/`
- 읽기 허브 `/read`
- 문서 상세 `/read/[slug]`
- 로컬 Markdown 로더
- 제목/목차/이전다음 링크
- 코드 블록, 표, Mermaid, 이미지 렌더링
- 기본 SEO metadata
- `sitemap.ts`
- `robots.ts`
- 스타일 토큰을 Montage 방향으로 매핑한 CSS 변수 정의
- Pretendard JP 기반 타이포 스케일 적용

## 2차 구현 범위

- 전문 검색
- 읽기 진행 상태 저장
- 테마 전환
- 문장 공유 anchor
- OG 이미지 자동 생성
- 원문/번역 비교 보기

## 바로 체크해야 할 리스크

### 1. 이미지 자산 부재

- `ko/preface.md`는 `./assets/cover-en.jpeg`를 참조한다.
- 실제 자산 위치를 확인하고 `public/`로 옮기거나 복사해야 한다.

### 2. 내부 링크 정규화

- 현재 일부 링크는 외부 영문 GitHub Pages URL을 가리킨다.
- 배포 사이트 내부 링크로 바꿀지, 원문 링크로 유지할지 정책을 정해야 한다.

권장:

- 문서 본문 링크는 가능한 범위에서 내부 라우트로 변환
- 원문 링크는 별도 "원문 보기" 액션으로 분리

### 3. heading 구조의 HTML 혼합

- 현재 h1/h2 텍스트가 anchor 태그로 감싸져 있다.
- 렌더러에서 이 구조를 그대로 쓰면 중복 앵커 또는 TOC 파싱 오류가 날 수 있다.

### 4. Markdown 품질 편차

- 일부 번역 문서는 줄바꿈이 과도해 문단이 잘게 쪼개져 있다.
- 1차는 렌더링으로 수용하고, 2차에서 문서 정제 작업을 고려한다.

## 실행 순서

1. 웹 IA와 디자인 방향 확정
2. Markdown 로더/정규화 규칙 구현
3. 문서 상세 페이지 렌더링 완성
4. 홈페이지와 읽기 허브 연결
5. Vercel 배포 설정

## 결론

이 프로젝트에서 제일 먼저 정해야 하는 것은 "Vercel 설정"이 아니라 아래 두 가지다.

- 어떤 홈페이지 경험을 줄 것인가
- `ko/*.md`를 어떤 규칙으로 웹 문서로 정규화할 것인가

이 두 축이 고정되면, 배포 자체는 비교적 단순한 후속 작업이 된다.
