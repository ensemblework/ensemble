export type LogoTone = "auto" | "gold" | "white" | "ink" | "mono";
export interface LogoOptions { id?: string; tone?: LogoTone; label?: string; micro?: boolean }
export function svgBody(options?: LogoOptions): string;
export function staticSVG(size?: number, options?: LogoOptions): string;
