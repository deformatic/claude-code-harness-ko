import { DocsSidebar } from "@/components/docs-sidebar";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { getAllDocuments, getDocumentBySlug } from "@/lib/content";
import { SITE_NAME, SITE_URL } from "@/lib/site";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  return getAllDocuments().map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    return {};
  }
  return {
    title: doc.title,
    description: doc.summary,
    alternates: {
      canonical: `/read/${doc.slug}`,
    },
    openGraph: {
      title: doc.title,
      description: doc.summary,
      url: `${SITE_URL}/read/${doc.slug}`,
      siteName: SITE_NAME,
      locale: "ko_KR",
      type: "article",
      images: [
        {
          url: `/read/${doc.slug}/opengraph-image`,
          width: 1200,
          height: 630,
          alt: `${doc.title} Open Graph image`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: doc.title,
      description: doc.summary,
      images: [`/read/${doc.slug}/opengraph-image`],
    },
  };
}

export default async function ReadDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    notFound();
  }

  const prev = doc.prevSlug ? getDocumentBySlug(doc.prevSlug) : null;
  const next = doc.nextSlug ? getDocumentBySlug(doc.nextSlug) : null;

  return (
    <main className="page-section">
      <div className="container docs-layout docs-layout--reader">
        <DocsSidebar currentSlug={doc.slug} />
        <section className="reader">
          <header className="reader__header">
            <div className="meta-row">
              <span className="pill">{doc.partLabel ?? doc.section}</span>
              <span className="pill">{doc.slug}</span>
              {doc.externalSourceUrl ? (
                <a className="pill" href={doc.externalSourceUrl} target="_blank" rel="noreferrer">
                  원문 링크
                </a>
              ) : null}
            </div>
            <h1>{doc.title}</h1>
            <p>{doc.summary}</p>
          </header>

          <div className="prose-wrap">
            <MarkdownRenderer markdown={doc.markdownBody} />
          </div>

          <nav className="reader-nav" aria-label="문서 이동">
            {prev ? (
              <Link href={`/read/${prev.slug}`} className="reader-nav__item">
                <span className="reader-nav__label">이전 문서</span>
                <span className="reader-nav__title">{prev.title}</span>
              </Link>
            ) : (
              <div className="reader-nav__item">
                <span className="reader-nav__label">이전 문서</span>
                <span className="reader-nav__title">없음</span>
              </div>
            )}
            {next ? (
              <Link href={`/read/${next.slug}`} className="reader-nav__item">
                <span className="reader-nav__label">다음 문서</span>
                <span className="reader-nav__title">{next.title}</span>
              </Link>
            ) : (
              <div className="reader-nav__item">
                <span className="reader-nav__label">다음 문서</span>
                <span className="reader-nav__title">없음</span>
              </div>
            )}
          </nav>
        </section>
      </div>
    </main>
  );
}
