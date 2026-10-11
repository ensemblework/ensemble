import type { MetadataRoute } from "next";
import { site } from "@/lib/site";
import { TOPICS } from "@/lib/topics";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = site.updated;
  return [
    { url: site.url, lastModified, changeFrequency: "weekly", priority: 1 },
    ...TOPICS.map((t) => ({
      url: `${site.url}/${t.slug}`,
      lastModified,
      changeFrequency: "monthly" as const,
      priority: 0.9,
    })),
    { url: `${site.url}/download`, lastModified, changeFrequency: "weekly", priority: 0.8 },
    { url: `${site.url}/privacy`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${site.url}/terms`, changeFrequency: "yearly", priority: 0.2 },
  ];
}
