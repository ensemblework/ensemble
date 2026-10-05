export type MorphStyle = "expressive" | "minimal-quiet" | "minimal-dot";
export type MorphState = "idle" | "once" | "loop" | "settle";
export interface MorphController {
  readonly state: "idle" | "pending" | "once" | "loop" | "settle";
  once(): Promise<void>;
  loop(opts?: { delay?: number }): MorphController;
  settle(): Promise<void>;
  idle(): void;
  destroy(): void;
  seek(mode: "once" | "loop" | "loopLarge", t: number): void;
  /** Paint the settle from a loop/once position at time t, k = 0..1 of the settle. For filmstrips and video. */
  seekSettle(mode: "once" | "loop" | "loopLarge", t: number, k: number): void;
}
export function mount(el: HTMLElement, opts?: { size?: number }): MorphController;
export function autoMount(scope?: ParentNode): MorphController[];
export function staticSVG(size: number, opts?: { label?: string }): string;
export function exportKeyframes(fps?: number, sizes?: number[]): unknown;
/** Seconds. Every style maps to the same values (one Expressive morph everywhere). */
export interface MorphTiming { once: number; loop: number; loopLarge: number; settle: number; ramp: number; onceRamp: number; settleEase: string }
export const BASE: MorphTiming; // once 1.5, loop 2.7, loopLarge 2.7, settle 0.38, ramp 0.35, onceRamp 0.3
export const TIMING: Record<MorphStyle, MorphTiming>;
