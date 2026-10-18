"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { bindToast, TOAST_MS, type ToastOptions, type ToastTone } from "@/lib/toast-bus";

type Toast = { id: number; text: string; tone: ToastTone; durationMs: number; action?: { label: string; run: () => void } };

const ToastContext = createContext<(text: string, options?: ToastOptions) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((rows) => rows.filter((row) => row.id !== id)), []);
  const push = useCallback((text: string, options?: ToastOptions) => {
    const id = Date.now() + Math.random();
    const next = { id, text, tone: options?.tone ?? "info", action: options?.action, durationMs: Math.max(1500, options?.durationMs ?? TOAST_MS) };
    setToasts((rows) => [...rows, next].slice(-4));
  }, []);
  bindToast(push);
  useEffect(() => () => bindToast(null), []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-[80] flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Closes itself when its bar runs out. Pointing at it or focusing it pauses both, so an action stays reachable. */
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  const left = useRef(toast.durationMs);
  const started = useRef(0);
  const close = useRef(onDismiss);
  close.current = onDismiss;
  useEffect(() => {
    if (paused) return;
    started.current = Date.now();
    const timer = window.setTimeout(() => close.current(), left.current);
    return () => {
      window.clearTimeout(timer);
      left.current = Math.max(0, left.current - (Date.now() - started.current));
    };
  }, [paused]);
  return (
    <div
      role="status"
      className={`m-toast pointer-events-auto flex max-w-[560px] items-center gap-3 overflow-hidden rounded-md border bg-raised px-3 py-2 text-[13px] shadow-pop ${
        toast.tone === "error" ? "border-danger/60 text-[#ffb4ae]" : "border-line-strong text-ink"
      }`}
      data-motion-slot="control.toast"
      data-state="on"
      data-paused={paused || undefined}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setPaused(false)}
    >
      <span>{toast.text}</span>
      <span className="m-drain" style={{ animationDuration: `${toast.durationMs}ms`, animationPlayState: paused ? "paused" : "running" }} aria-hidden />
      {toast.action ? (
        <button
          type="button"
          className="font-medium text-accent hover:underline"
          onClick={() => {
            toast.action!.run();
            onDismiss();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" className="text-faint hover:text-ink" aria-label="Dismiss" onClick={onDismiss}>
        <X size={14} />
      </button>
    </div>
  );
}
