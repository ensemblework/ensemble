import type { LogoOptions, LogoTone } from './index';
/** The beacon role is the quiet, intermittent infinity used for peripheral activity. */
export type MorphKind = "unfurl" | "infinity" | "relay" | "threadline" | "beacon";
export type MorphState = "idle" | "once" | "loop" | "settle";
export type MorphStyle = "expressive";
export interface MorphController {
  readonly state: MorphState | "pending";
  once(): Promise<void>;
  /** Remains still between finite gestures; repeated calls with the same kind do not restart it. */
  loop(options?: { delay?: number; kind?: MorphKind }): MorphController;
  /** Returns from the current pose. Call idle() when completed content must appear immediately. */
  settle(): Promise<void>;
  idle(): void;
  destroy(): void;
  /** A static sample from the same evaluator used by live playback. */
  seek(mode: "once" | "loop" | "loopLarge", seconds: number): void;
}
export function mount(el: HTMLElement, options?: { size?: number; kind?: MorphKind; tone?: LogoTone; flat?: boolean }): MorphController;
export function autoMount(scope?: ParentNode): MorphController[];
export function staticSVG(size?: number, options?: LogoOptions): string;
export const BASE: { once: number; loop: number; loopLarge: number; settle: number; ramp: number; onceRamp: number; settleEase: string };
/** duration is the entrance duration; loop is the full gesture and rest cycle, in milliseconds. */
export const kinds: Record<MorphKind, { name: string; duration: number; loop: number }>;
