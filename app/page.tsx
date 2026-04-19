import Link from "next/link";
import { SectionHeader } from "@/components/section-header";
import { getAllDocuments, getPartGroups } from "@/lib/content";

const readingPaths = [
  {
    label: "Path A",
    title: "Agent Builders",
    description:
      "아키텍처, 루프, 프롬프트, 컨텍스트 관리, 멀티 에이전트까지 제품 중심으로 따라가는 경로",
  },
  {
    label: "Path B",
    title: "Security Engineers",
    description:
      "권한, YOLO 분류기, 훅, 프롬프트 인젝션 방어까지 안전 경계를 중심으로 읽는 경로",
  },
  {
    label: "Path C",
    title: "Performance Optimization",
    description:
      "자동 압축, 토큰 예산, 프롬프트 캐싱, 추론 제어까지 비용과 지연시간에 집중하는 경로",
  },
];

export default function HomePage() {
  const docs = getAllDocuments();
  const parts = getPartGroups();

  return (
    <main>
      <section className="hero">
        <div className="container">
          <div className="hero__card hero__card--book">
            <div>
              <span className="eyebrow">Harness Engineering 한국어판</span>
              <h1>좋은 분석이 한국어로 다시 읽히고, 함께 공부하는 출발점이 되기를 바랐습니다.</h1>
              <p>
                이 사이트는 Claude Code를 깊게 이해하고 싶은 한국어 독자들을 위해 만들었습니다.
                이미 훌륭하게 정리된 원문 분석을 한국어로 옮기고, 책처럼 차분하게 읽을 수 있는
                웹 형태로 다시 묶었습니다.
              </p>
              <p className="hero__lead">
                하네스 엔지니어링을 직접 구성해보고 싶은 분들, AI 코딩 에이전트를 구조적으로
                분석하고 싶은 분들, 혼자 보기 아까운 자료를 함께 공부하고 싶은 분들이 이곳에서
                같은 문장을 읽고 같은 구조를 짚어가며, 자기만의 구현으로 이어갈 수 있기를 바랐습니다.
              </p>
              <div className="hero__actions">
                <Link href="/read" className="button button--primary">
                  목차 열기
                </Link>
                <Link href="/read/preface" className="button button--secondary">
                  서문부터 보기
                </Link>
              </div>
            </div>
            <div className="book-panel book-cover">
              <div className="book-panel__title">왜 이 사이트를 만들었나</div>
              <p className="book-cover__text">
                원문을 그대로 소비하는 데서 멈추지 않고, 한국어 사용자들도 함께 분석하고 토론하고,
                결국 자기만의 하네스와 에이전트를 설계하는 출발점이 되었으면 했습니다.
              </p>
              <div className="hero__meta">
                <div className="hero__stat">
                  <strong>{docs.length}</strong>
                  <span>개의 문서와 부록</span>
                </div>
                <div className="hero__stat">
                  <strong>7 Parts</strong>
                  <span>아키텍처부터 실전 교훈까지</span>
                </div>
                <div className="hero__stat">
                  <strong>한국어 독자용</strong>
                  <span>분석과 학습을 위한 읽기 중심 웹판</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="page-section">
        <div className="container">
          <SectionHeader
            title="이 자료가 필요한 사람들"
            description="원문이 가진 읽기 경로를 유지하되, 한국어 독자 관점에서 바로 들어갈 수 있게 정리했습니다."
          />
          <div className="book-sections">
            <div className="book-sections__main">
              {readingPaths.map((path) => (
                <article key={path.label} className="chapter-card">
                  <div className="card__label">{path.label}</div>
                  <h3>{path.title}</h3>
                  <p>{path.description}</p>
                </article>
              ))}
            </div>
            <div className="book-sections__side">
              <div className="chapter-card">
                <div className="card__label">Read in order</div>
                <h3>목차</h3>
                <div className="book-panel__toc">
                  <Link href="/read/preface">Preface</Link>
                  {parts.map((part) => (
                    <Link key={part.label} href={`/read/${part.docs[0].slug}`}>
                      {part.label}
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="page-section">
        <div className="container">
          <SectionHeader
            title="파트별 진입"
            description="각 파트의 첫 장으로 바로 들어갈 수 있습니다."
          />
          <div className="chapter-grid">
            {parts.map((part) => (
              <article key={part.label} className="chapter-card">
                <div className="card__label">{part.label}</div>
                <h3>{part.docs[0]?.title.replace(/:.*$/, "") || part.label}</h3>
                <p>{part.docs.length}개 문서</p>
                <div className="inline-actions" style={{ marginTop: 18 }}>
                  <Link href={`/read/${part.docs[0].slug}`} className="button button--secondary">
                    이 파트 읽기
                  </Link>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
