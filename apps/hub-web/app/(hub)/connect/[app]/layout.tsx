import type { ReactNode } from "react";
import { desktopPlaceholder } from "@/lib/desktop-export";

export function generateStaticParams() {
  return desktopPlaceholder({ app: "_" });
}

export default function ConnectAppLayout({ children }: { children: ReactNode }) {
  return children;
}
