import Link from "next/link";
import { getDocumentsBySection, getPartGroups } from "@/lib/content";

export function DocsSidebar({ currentSlug }: { currentSlug?: string }) {
  const preface = getDocumentsBySection("preface");
  const appendices = getDocumentsBySection("appendix");
  const parts = getPartGroups();

  return (
    <aside className="docs-sidebar" aria-label="문서 탐색">
      <div className="docs-sidebar__section">
        <div className="docs-sidebar__heading">Preface</div>
        <nav className="docs-sidebar__nav">
          {preface.map((doc) => (
            <Link
              key={doc.slug}
              href={`/read/${doc.slug}`}
              className={doc.slug === currentSlug ? "docs-link docs-link--active" : "docs-link"}
            >
              {doc.title}
            </Link>
          ))}
        </nav>
      </div>

      {parts.map((part) => (
        <div key={part.label} className="docs-sidebar__section">
          <div className="docs-sidebar__heading">{part.label}</div>
          <nav className="docs-sidebar__nav">
            {part.docs.map((doc) => (
              <Link
                key={doc.slug}
                href={`/read/${doc.slug}`}
                className={doc.slug === currentSlug ? "docs-link docs-link--active" : "docs-link"}
              >
                {doc.title}
              </Link>
            ))}
          </nav>
        </div>
      ))}

      <div className="docs-sidebar__section">
        <div className="docs-sidebar__heading">Appendix</div>
        <nav className="docs-sidebar__nav">
          {appendices.map((doc) => (
            <Link
              key={doc.slug}
              href={`/read/${doc.slug}`}
              className={doc.slug === currentSlug ? "docs-link docs-link--active" : "docs-link"}
            >
              {doc.title}
            </Link>
          ))}
        </nav>
      </div>
    </aside>
  );
}
