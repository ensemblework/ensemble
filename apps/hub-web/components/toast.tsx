"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { X } from "lucide-react";
import { bindToast, type ToastOptions, type ToastTone } from "@/lib/toast-bus";

type Toast = { id: number; text: string; tone: ToastTone; action?: { label: string; run: () => void } };

const ToastContext = createContext<(text: string, options?: ToastOptions) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, options?: ToastOptions) => {
    const id = Date.now() + Math.random();
    const next = { id, text, tone: options?.tone ?? "info", action: options?.action };
    setToasts((rows) => [...rows, next].slice(-4));
    window.setTimeout(() => setToasts((rows) => rows.filter((row) => row.id !== id)), 8000);
  }, []);
  bindToast(push);
  useEffect(() => () => bindToast(null), []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-[80] flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={`m-toast pointer-events-auto flex max-w-[560px] items-center gap-3 rounded-md border bg-raised px-3 py-2 text-[13px] shadow-pop ${
              toast.tone === "error" ? "border-danger/60 text-[#ffb4ae]" : "border-line-strong text-ink"
            }`}
            data-motion-slot="control.toast"
            data-state="on"
          >
            <span>{toast.text}</span>
            <span className="m-drain" style={{ animationDuration: "8s" }} aria-hidden />
            {toast.action ? (
              <button
                type="button"
                className="font-medium text-accent hover:underline"
                onClick={() => {
                  toast.action!.run();
                  setToasts((rows) => rows.filter((row) => row.id !== toast.id));
                }}
              >
                {toast.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="text-faint hover:text-ink"
              aria-label="Dismiss"
              onClick={() => setToasts((rows) => rows.filter((row) => row.id !== toast.id))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
