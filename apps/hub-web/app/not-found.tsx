// app/not-found.tsx  (also rendered for notFound() calls)
import type { Metadata } from "next";
import { BrandStatus } from "@/components/brand/BrandStatus";
import "@/components/brand/brand-pages.css";

export const metadata: Metadata = { title: "Page not found · Ensemble", robots: { index: false } };

export default function NotFound() {
  return <BrandStatus kind="404" />;
}
