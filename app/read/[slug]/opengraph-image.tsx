import { ImageResponse } from "next/og";
import { getDocumentBySlug } from "@/lib/content";
import { AUTHOR_NAME, SITE_NAME } from "@/lib/site";

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = "image/png";

type ImageProps = {
  params: Promise<{ slug: string }>;
};

export default async function OpenGraphImage({ params }: ImageProps) {
  const { slug } = await params;
  const doc = getDocumentBySlug(slug);

  const title = doc?.title ?? "Claude Code Harness";
  const summary = doc?.summary ?? "한국어로 읽는 Claude Code 분석 아카이브";
  const meta = doc?.partLabel ?? slug;

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          padding: "56px",
          background:
            "linear-gradient(180deg, rgba(248,245,238,1) 0%, rgba(242,237,226,1) 100%)",
          color: "#1f1a15",
          fontFamily:
            '"Pretendard JP", Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif',
        }}
      >
        <div
          style={{
            display: "flex",
            width: "100%",
            flexDirection: "column",
            justifyContent: "space-between",
            border: "1px solid rgba(46,42,37,0.12)",
            borderRadius: "28px",
            padding: "48px",
            background: "rgba(255,255,255,0.78)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            <div
              style={{
                display: "flex",
                color: "#8b2f1d",
                fontSize: 22,
                fontWeight: 700,
              }}
            >
              {meta}
            </div>
            <div
              style={{
                display: "flex",
                maxWidth: "900px",
                fontSize: 60,
                fontWeight: 800,
                lineHeight: 1.18,
                letterSpacing: "-0.04em",
              }}
            >
              {title}
            </div>
            <div
              style={{
                display: "flex",
                maxWidth: "860px",
                color: "#5f574f",
                fontSize: 28,
                lineHeight: 1.42,
              }}
            >
              {summary}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              gap: "24px",
              fontSize: 24,
              color: "#726a61",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", fontWeight: 700, color: "#1f1a15" }}>
                {SITE_NAME}
              </div>
              <div style={{ display: "flex" }}>{AUTHOR_NAME}</div>
            </div>
            <div style={{ display: "flex" }}>{slug}</div>
          </div>
        </div>
      </div>
    ),
    size
  );
}

