import type { Metadata } from "next";
import type { ReactNode } from "react";
import { desktopPlaceholder } from "@/lib/desktop-export";

// A public link shares one item with whoever has the address. It is not meant to
// turn up in search results, even when the address is posted somewhere public.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export function generateStaticParams() {
  return desktopPlaceholder({ token: "_" });
}

export default function PublicLinkLayout({ children }: { children: ReactNode }) {
  return children;
}
