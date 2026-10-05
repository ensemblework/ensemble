import type { ReactNode } from "react";
import { desktopPlaceholder } from "@/lib/desktop-export";

export function generateStaticParams() {
  return desktopPlaceholder({ id: "_" });
}

export default function TaskIdLayout({ children }: { children: ReactNode }) {
  return children;
}
