import type { MetadataRoute } from "next";
import { getAllDocuments } from "@/lib/content";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://claude-code-harness.vercel.app";
  const docs = getAllDocuments().map((doc) => ({
    url: `${base}/read/${doc.slug}`,
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));

  return [
    {
      url: base,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${base}/read`,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    ...docs,
  ];
}
