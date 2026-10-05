"use client";
// Replaces the root layout when it throws, so it brings its own <html>/<body>
// and reads the same appearance record the rest of the app persists.
import { BrandStatus } from "@/components/brand/BrandStatus";
import { BRAND_PAGE_BOOT } from "@/lib/brand-page-boot";
import "@/components/brand/brand-pages.css";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" data-theme="dark" data-motion-theme="expressive">
      <head>
        <script dangerouslySetInnerHTML={{ __html: BRAND_PAGE_BOOT }} />
      </head>
      <body style={{ margin: 0 }}>
        <BrandStatus kind="500" reset={reset} />
      </body>
    </html>
  );
}
