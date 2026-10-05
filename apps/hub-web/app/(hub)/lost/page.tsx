import type { Metadata } from "next";
import { BrandStatus } from "@/components/brand/BrandStatus";
import "@/components/brand/brand-pages.css";

export const metadata: Metadata = { title: "Page not found · Ensemble", robots: { index: false, follow: false } };

/** Rewrite target for a signed-in unknown URL. The address bar stays put. */
export default function LostPage() {
  return <BrandStatus kind="404" shell />;
}
