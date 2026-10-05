"use client";
// app/error.tsx: route-level error boundary (the root layout, theme and fonts stay mounted)
import { useEffect } from "react";
import { BrandStatus } from "@/components/brand/BrandStatus";
import "@/components/brand/brand-pages.css";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return <BrandStatus kind={offline ? "offline" : "500"} reset={reset} />;
}
