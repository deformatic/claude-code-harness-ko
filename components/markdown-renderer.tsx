import Link from "next/link";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { normalizeImageSrc } from "@/lib/content";

function CodeBlock({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  const language = className?.replace("language-", "") || "text";
  return (
    <div className="code-block">
      <div className="code-block__label">
        <span>{language}</span>
      </div>
      <pre className={className}>
        <code>{children}</code>
      </pre>
    </div>
  );
}

export function MarkdownRenderer({ markdown }: { markdown: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSlug]}
        components={{
          a({ href, children, ...props }) {
            if (!href) return <a {...props}>{children}</a>;
            const isInternal = href.startsWith("/");
            if (isInternal) {
              return (
                <Link href={href} {...props}>
                  {children}
                </Link>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" {...props}>
                {children}
              </a>
            );
          },
          pre({ children }) {
            const child = children as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
            const language = child?.props?.className || "";
            const value =
              typeof child?.props?.children === "string"
                ? child.props.children
                : Array.isArray(child?.props?.children)
                  ? child.props.children.join("")
                  : "";

            if (language.includes("language-mermaid")) {
              return <MermaidDiagram chart={value} />;
            }

            return <CodeBlock className={language}>{child?.props?.children}</CodeBlock>;
          },
          table({ children }) {
            return (
              <div className="table-scroll">
                <table>{children}</table>
              </div>
            );
          },
          img({ src, alt }) {
            const normalized = normalizeImageSrc(typeof src === "string" ? src : "");
            return <img src={normalized} alt={alt || ""} />;
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
