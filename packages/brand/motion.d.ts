import type { LogoOptions, LogoTone } from './index';
export type MorphKind = "unfurl" | "infinity" | "relay" | "threadline" | "beacon";
export type MorphState = "idle" | "once" | "loop" | "settle";
export type MorphStyle = "expressive";
export interface MorphController {
  readonly state: MorphState | "pending";
  once(): Promise<void>;
  loop(options?: { delay?: number; kind?: MorphKind }): MorphController;
  settle(): Promise<void>;
  idle(): void;
  destroy(): void;
  seek(mode: "once" | "loop" | "loopLarge", seconds: number): void;
}
export function mount(el: HTMLElement, options?: { size?: number; kind?: MorphKind; tone?: LogoTone; flat?: boolean }): MorphController;
export function autoMount(scope?: ParentNode): MorphController[];
export function staticSVG(size?: number, options?: LogoOptions): string;
export const BASE: { once: number; loop: number; loopLarge: number; settle: number; ramp: number; onceRamp: number; settleEase: string };
export const kinds: Record<MorphKind, { name: string; duration: number; loop: number }>;
