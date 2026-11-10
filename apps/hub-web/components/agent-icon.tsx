/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { forwardRef } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import { EnsembleMark } from "./brand/Logo";

/**
 * The icon for an agent's work: Ensemble's mark in the text colour, shaped like a Lucide icon so it
 * drops in wherever one is expected. Ensemble draws no robots (AGENTS.md, "UI rules").
 */
export const AgentIcon = forwardRef<SVGSVGElement, LucideProps>(function AgentIcon({ size = 24, className, style, "aria-hidden": hidden }, _ref) {
  return <EnsembleMark size={Number(size)} tone="mono" className={className} style={style} aria-hidden={hidden ?? true} />;
}) as LucideIcon;

/** "Ask Ensemble": Ensemble's mark in its own colours, so asking the AI never looks like an ordinary row. */
export const EnsembleIcon = forwardRef<SVGSVGElement, LucideProps>(function EnsembleIcon({ size = 24, className, style }, _ref) {
  return <EnsembleMark size={Number(size)} className={className} style={style} aria-hidden />;
}) as LucideIcon;
