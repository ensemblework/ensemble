import type { Metadata } from "next";
import { BrandStatus } from "@/components/brand/BrandStatus";
import "@/components/brand/brand-pages.css";

export const metadata: Metadata = { title: "Page not found · Ensemble", robots: { index: false } };

/** Standalone branded 404. Middleware rewrites signed-out unknown URLs here. */
export default function MissingPage() {
  return <BrandStatus kind="404" />;
}
