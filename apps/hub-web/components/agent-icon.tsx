/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { forwardRef } from "react";
import type { LucideProps } from "lucide-react";
import { agentSvgBody } from "@ensemble/brand/agent";
/** Ensemble's woven agent mark; one geometry in web and native interfaces. */
export const AgentIcon = forwardRef<SVGSVGElement, LucideProps>(function AgentIcon({ size = 24, color = "currentColor", strokeWidth = 1.8, ...props }, ref) {
  return <svg ref={ref} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props} dangerouslySetInnerHTML={{ __html: agentSvgBody() }}/>;
});
