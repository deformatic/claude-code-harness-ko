"use client";

import mermaid from "mermaid";
import { useEffect, useId, useState } from "react";

let mermaidInitialized = false;

function ensureMermaid() {
  if (mermaidInitialized) {
    return;
  }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: "neutral",
    fontFamily:
      '"Pretendard JP", Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif',
  });
  mermaidInitialized = true;
}

export function MermaidDiagram({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function renderChart() {
      try {
        ensureMermaid();
        const result = await mermaid.render(`mermaid-${id}`, chart);
        if (!cancelled) {
          setSvg(result.svg);
          setError("");
        }
      } catch (cause) {
        if (!cancelled) {
          console.error("Failed to render Mermaid diagram", cause);
          setError("Mermaid 다이어그램을 렌더링하지 못했습니다.");
          setSvg("");
        }
      }
    }

    void renderChart();

    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  if (error) {
    return (
      <div className="mermaid-fallback" role="img" aria-label="Mermaid diagram fallback">
        <strong>{error}</strong>
        <pre>{chart}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="mermaid-loading" aria-live="polite">
        Mermaid diagram rendering...
      </div>
    );
  }

  return (
    <div
      className="mermaid-diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
