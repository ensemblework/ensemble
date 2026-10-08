import type { ReactNode } from "react";
import { desktopPlaceholder } from "@/lib/desktop-export";

export function generateStaticParams() {
  return desktopPlaceholder({ token: "_" });
}

export default function PublicLinkLayout({ children }: { children: ReactNode }) {
  return children;
}
