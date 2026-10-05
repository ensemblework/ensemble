import type { MetadataRoute } from "next";

// Static export has no request to render this against. The file never reads one.
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: ["/marketplace"] },
  };
}
