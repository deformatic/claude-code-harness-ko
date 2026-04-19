import type { MetadataRoute } from "next";
import { getAllDocuments } from "@/lib/content";
import { SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = SITE_URL;
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
