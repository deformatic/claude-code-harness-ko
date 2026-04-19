import type { Metadata } from "next";
import Link from "next/link";
import { AUTHOR_NAME, AUTHOR_URL, SITE_NAME, SITE_REPO_URL, SITE_URL, SOURCE_URL } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: `%s | ${SITE_NAME}`,
  },
  description:
    "Claude Code Harness 원문 분석을 한국어로 함께 읽고 공부할 수 있도록 구성한 공개 학습용 웹 아카이브.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: SITE_NAME,
    description:
      "Claude Code Harness 원문 분석을 한국어로 함께 읽고 공부할 수 있도록 구성한 공개 학습용 웹 아카이브.",
    url: SITE_URL,
    siteName: SITE_NAME,
    locale: "ko_KR",
    type: "website",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: `${SITE_NAME} Open Graph image`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description:
      "Claude Code Harness 원문 분석을 한국어로 함께 읽고 공부할 수 있도록 구성한 공개 학습용 웹 아카이브.",
    images: ["/opengraph-image"],
  },
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
                  href={SOURCE_URL}
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
                  href={AUTHOR_URL}
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
                <a
                  className="nav-link nav-link--icon"
                  href={SITE_REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="GitHub 저장소 보기"
                  title="GitHub 저장소 보기"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M12 2C6.477 2 2 6.596 2 12.266c0 4.535 2.865 8.384 6.839 9.742.5.096.682-.223.682-.496 0-.245-.009-.894-.014-1.754-2.782.618-3.369-1.38-3.369-1.38-.455-1.183-1.11-1.498-1.11-1.498-.908-.637.069-.624.069-.624 1.004.072 1.532 1.056 1.532 1.056.892 1.566 2.341 1.114 2.91.852.091-.666.349-1.114.635-1.37-2.221-.26-4.555-1.14-4.555-5.073 0-1.121.39-2.038 1.029-2.756-.103-.261-.446-1.312.098-2.735 0 0 .84-.276 2.75 1.053A9.325 9.325 0 0 1 12 7.32c.85.004 1.705.118 2.504.347 1.909-1.329 2.747-1.053 2.747-1.053.546 1.423.203 2.474.1 2.735.64.718 1.027 1.635 1.027 2.756 0 3.944-2.338 4.81-4.566 5.066.359.319.679.948.679 1.911 0 1.379-.012 2.492-.012 2.83 0 .276.18.597.688.495C19.138 20.646 22 16.799 22 12.266 22 6.596 17.523 2 12 2Z"
                    />
                  </svg>
                </a>
              </nav>
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
