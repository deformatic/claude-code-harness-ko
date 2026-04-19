import type { TocItem } from "@/lib/content";

export function ReaderToc({ items }: { items: TocItem[] }) {
  if (!items.length) {
    return null;
  }

  return (
    <aside className="toc" aria-label="문서 목차">
      <h2>On this page</h2>
      <nav>
        {items.map((item) => (
          <a key={item.id} href={`#${item.id}`} data-depth={item.depth}>
            {item.text}
          </a>
        ))}
      </nav>
    </aside>
  );
}
