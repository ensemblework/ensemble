"use client";

export type ToastTone = "info" | "error" | "ok";
/** `durationMs`: how long it stays; 8 seconds by default. */
export type ToastOptions = { tone?: ToastTone; action?: { label: string; run: () => void }; durationMs?: number };

type Push = (text: string, options?: ToastOptions) => void;

let push: Push | null = null;

export function bindToast(fn: Push | null) {
  push = fn;
}

export function emitToast(text: string, options?: ToastOptions) {
  push?.(text, options);
}
