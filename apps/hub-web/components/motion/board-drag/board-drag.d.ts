export type MotionTheme = "expressive" | "minimal-quiet" | "minimal-dot";
export type BoardDragState = "idle" | "hover" | "pressed" | "pickup" | "dragging" | "over" | "reorder" | "drop" | "invalid" | "cancel" | "agent" | "done" | "keyboard";
export type HapticKind = "lift" | "drop" | "cancel" | "invalid";
type Timing = { spring?: [number, number]; ms?: number; ease?: string };
export interface StyleSettings {
  tilt: { cap: number; perPxS: number; k: number; c: number };
  lift: { scale: number; opacity: number; k: number; c: number };
  shadow: number; tether: boolean; placeholder: "stitch" | "hairline" | "dot";
  flip: Timing; drop: Timing; cancel: Timing; glide: Timing;
  agent: "crane" | "glide" | "dot"; done: "hop" | "glide" | "dot"; owner: "spin" | "fade";
  countPop: boolean; sparks: boolean; land: boolean;
}
export interface DropDetail { id: string; from: string; to: string; index: number; beforeId: string | null; afterId: string | null; changed: boolean; via: "pointer" | "keyboard" }
export interface MountOptions {
  card?: string; column?: string; list?: string; footer?: string; count?: string;
  accepts?: (card: HTMLElement, column: HTMLElement) => boolean;
  /** Return false or a rejecting promise (server said no) and the card animates back. */
  onDrop?: (detail: DropDetail) => void | boolean | Promise<unknown>;
  title?: (card: HTMLElement) => string; columnName?: (column: HTMLElement) => string;
  scroller?: HTMLElement | null; touch?: { delay: number; tolerance: number }; mouse?: { distance: number };
  /** false: another library owns input (dnd-kit); only play()/agentMove()/complete() run. */
  input?: boolean;
}
export interface BoardDrag {
  readonly state: BoardDragState;
  readonly dragging: { id: string; mode: "pointer" | "keyboard" | "agent"; maxTilt: number; x: number; y: number } | null;
  agentMove(id: string, column: string, index?: number): Promise<boolean>;
  complete(id: string, column?: string): Promise<boolean>;
  play(card: HTMLElement, fromRect: DOMRect | { left: number; top: number; width: number; height: number }, kind?: "agent" | "done"): Promise<boolean>;
  cancel(): void; refresh(): void; destroy(): void;
}
export function mount(root: HTMLElement, options?: MountOptions): BoardDrag;
export function flipFrom(el: HTMLElement, firstRect: { left: number; top: number }, theme: MotionTheme, reduced: boolean): Animation | null;
export class Lift {
  constructor(tiltEl: HTMLElement, shadowEl: HTMLElement | null, settings: StyleSettings, reduced: boolean);
  pickup(): void; vel(vxPxPerS: number): void; release(): Promise<void>; stop(): void; readonly maxTilt: number;
}
export const STYLES: Record<MotionTheme, StyleSettings>;
export const TOUCH: { delay: number; tolerance: number };
export const MOUSE: { distance: number };
export const AUTOSCROLL: { edge: number; maxSpeed: number };
export const REDUCED_FADE: number;
export function springEasing(k: number, c: number): { easing: string; duration: number };
export function timing(spec: Timing, reduced: boolean): { easing: string; duration: number };
export function haptic(kind: HapticKind, el?: Element): void;
export function themeOf(el: Element): MotionTheme;
export function reducedOf(el: Element): boolean;
export function exportSettings(): Record<MotionTheme, unknown>;
declare global {
  interface Window { __ensembleHaptic?: (kind: HapticKind) => void }
  interface WindowEventMap { "ensemble:haptic": CustomEvent<{ kind: HapticKind; reduced: boolean }> }
}
