import type { ReactNode } from "react";
import "@/components/diagrams/diagrams.css";

/** The list and the editor share the diagram chrome styles. */
export default function DiagramsLayout({ children }: { children: ReactNode }) {
  return children;
}
