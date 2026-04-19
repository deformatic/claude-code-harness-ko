# Claude Code Harness KO

한국어 사용자들도 Claude Code 내부 구조를 깊게 읽고, 함께 분석하고, 자기만의 하네스와 에이전트를 설계해볼 수 있도록 만든 공개 학습용 웹 아카이브입니다.

이 프로젝트는 원문의 훌륭한 분석을 한국어로 옮기는 데서 멈추지 않고, 책처럼 차분하게 읽을 수 있는 웹 형태로 다시 구성하는 것을 목표로 합니다. 혼자 보기 아까운 자료를 더 많은 한국어 독자들이 함께 공부하고 토론할 수 있는 출발점이 되었으면 하는 마음으로 만들었습니다.

## Live

- Production: [https://claude-code-harness-ko.vercel.app](https://claude-code-harness-ko.vercel.app)

## Source

- Original source: [https://zhanghandong.github.io/harness-engineering-from-cc-to-ai-coding/](https://zhanghandong.github.io/harness-engineering-from-cc-to-ai-coding/)

## Author

- 유민수 개발자
- Website: [https://www.deformatic.ai.kr](https://www.deformatic.ai.kr)

## Purpose

- 하네스 엔지니어링을 직접 구성해보고 싶은 분들을 위한 한국어 학습 자료
- Claude Code를 단순 사용법이 아니라 구조와 설계 관점에서 분석해보고 싶은 분들을 위한 읽기용 웹판
- 좋은 원문 분석을 한국어 사용자들도 함께 읽고, 토론하고, 다시 구현으로 이어갈 수 있게 만드는 공개 아카이브

## Project Structure

- `ko/`: 한국어 번역 문서
- `raw/en/`: 원문 보관본
- `app/`: Next.js App Router 페이지
- `components/`: 문서 렌더링 UI 컴포넌트
- `lib/`: 문서 로더, 정규화, 링크 변환 로직

## Tech Stack

- Next.js App Router
- React
- TypeScript
- React Markdown
- Mermaid
- Vercel

## Local Development

```bash
pnpm install
pnpm dev
```

브라우저에서 `http://localhost:3000`으로 열면 됩니다.

## Build

```bash
pnpm build
pnpm start
```

## Notes

- 문서는 빌드 시점에 `ko/*.md`를 읽어 정적으로 생성됩니다.
- 일부 원문 링크는 내부 문서 링크로 정규화됩니다.
- Mermaid 다이어그램은 클라이언트에서 렌더링됩니다.
