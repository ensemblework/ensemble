"use client";

export type ToastTone = "info" | "error" | "ok";
/** How long a toast stays, unless it is pointed at: its bar runs down over this time. */
export const TOAST_MS = 3000;

/** `durationMs`: how long it stays; `TOAST_MS` by default. */
export type ToastOptions = { tone?: ToastTone; action?: { label: string; run: () => void }; durationMs?: number };

type Push = (text: string, options?: ToastOptions) => void;

let push: Push | null = null;

export function bindToast(fn: Push | null) {
  push = fn;
}

export function emitToast(text: string, options?: ToastOptions) {
  push?.(text, options);
}
