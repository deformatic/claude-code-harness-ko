import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://claude-code-harness.vercel.app"),
  title: {
    default: "Claude Code Harness",
    template: "%s | Claude Code Harness",
  },
  description:
    "Claude Code Harness 문서를 가독성 중심의 정적 웹사이트로 정리한 한국어 아카이브.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        <div className="site-shell">
          <header className="top-nav">
            <div className="top-meta">
              <div className="container top-meta__inner">
                <a
                  className="top-meta__link"
                  href="https://zhanghandong.github.io/harness-engineering-from-cc-to-ai-coding/"
                  target="_blank"
                  rel="noreferrer"
                >
                  출처 보기 (zhanghandong.github.io/harness-engineering-from-cc-to-ai-coding)
                </a>
                <span className="top-meta__divider" aria-hidden="true">
                  /
                </span>
                <a
                  className="top-meta__link"
                  href="https://www.deformatic.ai.kr"
                  target="_blank"
                  rel="noreferrer"
                >
                  유민수 개발자 (www.deformatic.ai.kr) 작성
                </a>
              </div>
            </div>
            <div className="container top-nav__inner">
              <Link href="/" className="brand">
                <span className="brand__eyebrow">한국어 번역 아카이브</span>
                <span className="brand__title">Claude Code Harness</span>
              </Link>
              <nav className="nav-links" aria-label="전역 탐색">
                <Link className="nav-link" href="/">
                  홈
                </Link>
                <Link className="nav-link" href="/read">
                  읽기 허브
                </Link>
              </nav>
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
