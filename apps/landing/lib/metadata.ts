import type { Metadata } from "next";
import { site } from "@/lib/site";

// A page that sets its own Open Graph fields loses the inherited image, so every
// page names it. The file is app/opengraph-image.tsx.
const OG_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  type: "image/png",
  alt: "Ensemble: you and your agent, in the same key",
};

/** Title, description, canonical address and share card for one page. `title` is the whole <title>. */
export function pageMetadata({ path, title, description }: { path: string; title: string; description: string }): Metadata {
  const url = path === "/" ? site.url : `${site.url}${path}`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", url, siteName: site.name, locale: "en_US", title, description, images: [OG_IMAGE] },
    twitter: { card: "summary_large_image", title, description, images: [OG_IMAGE.url] },
  };
}
