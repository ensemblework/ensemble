import type { ReactNode } from "react";
import { desktopPlaceholder } from "@/lib/desktop-export";
import { ActivePlaceGate } from "@/components/active-place-gate";

export function generateStaticParams() {
  return desktopPlaceholder({ id: "_" });
}

export default function SharedItemLayout({ children }: { children: ReactNode }) {
  return <ActivePlaceGate>{children}</ActivePlaceGate>;
}
