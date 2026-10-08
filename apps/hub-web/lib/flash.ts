"use client";

import { emitToast, type ToastOptions } from "./toast-bus";

const KEY = "ensemble.flash";

/** A toast that survives the next full page load (after a space switch, say). */
export function flash(text: string, options?: ToastOptions): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ text, tone: options?.tone ?? "info" }));
  } catch {
    emitToast(text, options);
  }
}

export function consumeFlash(): void {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return;
    sessionStorage.removeItem(KEY);
    const value = JSON.parse(raw) as { text?: string; tone?: ToastOptions["tone"] };
    if (value.text) emitToast(value.text, { tone: value.tone });
  } catch {
    // Storage is off: nothing was saved.
  }
}
