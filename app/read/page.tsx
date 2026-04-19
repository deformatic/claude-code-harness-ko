import { DocsSidebar } from "@/components/docs-sidebar";
import Link from "next/link";
import { SectionHeader } from "@/components/section-header";
import { getDocumentsBySection, getPartGroups } from "@/lib/content";

export const metadata = {
  title: "읽기 허브",
  description: "Claude Code Harness 전체 문서를 파트별로 탐색하는 읽기 허브",
};

export default function ReadIndexPage() {
  const preface = getDocumentsBySection("preface");
  const appendices = getDocumentsBySection("appendix");
  const parts = getPartGroups();

  return (
    <main className="page-section">
      <div className="container docs-layout">
        <DocsSidebar />
        <section className="docs-index">
          <SectionHeader
            title="Table of Contents"
            description="책의 순서를 따라 서문, 본문, 부록으로 정렬했습니다."
          />

          <section className="toc-section">
            <h3 className="toc-section__title">서문</h3>
            <div className="list-stack">
              {preface.map((doc) => (
                <Link key={doc.slug} href={`/read/${doc.slug}`} className="list-cell">
                  <div>
                    <div className="list-cell__title">{doc.title}</div>
                    <div className="list-cell__meta">{doc.summary}</div>
                  </div>
                </Link>
              ))}
            </div>
          </section>

          {parts.map((part) => (
            <section key={part.label} className="toc-section">
              <h3 className="toc-section__title">{part.label}</h3>
              <div className="list-stack">
                {part.docs.map((doc) => (
                  <Link key={doc.slug} href={`/read/${doc.slug}`} className="list-cell">
                    <div>
                      <div className="list-cell__title">{doc.title}</div>
                      <div className="list-cell__meta">{doc.summary}</div>
                    </div>
                    <div className="list-cell__badge">{doc.slug}</div>
                  </Link>
                ))}
              </div>
            </section>
          ))}

          <section className="toc-section">
            <h3 className="toc-section__title">부록</h3>
            <div className="list-stack">
              {appendices.map((doc) => (
                <Link key={doc.slug} href={`/read/${doc.slug}`} className="list-cell">
                  <div>
                    <div className="list-cell__title">{doc.title}</div>
                    <div className="list-cell__meta">{doc.summary}</div>
                  </div>
                  <div className="list-cell__badge">Appendix</div>
                </Link>
              ))}
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
