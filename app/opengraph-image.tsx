import { ImageResponse } from "next/og";
import { AUTHOR_NAME, SITE_NAME, SITE_URL, SOURCE_URL } from "@/lib/site";

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = "image/png";

export default function OpenGraphImage() {
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
            background: "rgba(255,255,255,0.72)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            <div
              style={{
                display: "flex",
                color: "#8b2f1d",
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: "-0.02em",
              }}
            >
              Harness Engineering 한국어판
            </div>
            <div
              style={{
                display: "flex",
                maxWidth: "880px",
                fontSize: 58,
                fontWeight: 800,
                lineHeight: 1.2,
                letterSpacing: "-0.04em",
              }}
            >
              좋은 분석이 한국어로 다시 읽히고, 함께 공부하는 출발점이 되기를 바랐습니다.
            </div>
            <div
              style={{
                display: "flex",
                maxWidth: "860px",
                color: "#5f574f",
                fontSize: 28,
                lineHeight: 1.45,
              }}
            >
              Claude Code 내부 구조를 함께 읽고 분석하며, 자기만의 하네스와 에이전트를
              설계해볼 수 있도록 만든 공개 학습용 웹 아카이브
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
              <div style={{ display: "flex" }}>{SITE_URL.replace("https://", "")}</div>
            </div>
            <div
              style={{
                display: "flex",
                maxWidth: "410px",
                textAlign: "right",
                lineHeight: 1.35,
              }}
            >
              Source: {SOURCE_URL.replace("https://", "")}
            </div>
          </div>
        </div>
      </div>
    ),
    size
  );
}

