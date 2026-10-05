"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { ConnectOs } from "@/lib/connect/configs";
import { cx } from "../ui";

const OS: Array<{ id: ConnectOs; label: string }> = [
  { id: "mac", label: "Mac" },
  { id: "windows", label: "Windows" },
  { id: "linux", label: "Linux" },
];

export function OsTabs({ value, onChange }: { value: ConnectOs; onChange: (os: ConnectOs) => void }) {
  return (
    <div role="tablist" aria-label="Which computer is this?" className="inline-flex rounded-lg border border-line bg-raised p-0.5">
      {OS.map((os) => (
        <button
          key={os.id}
          type="button"
          role="tab"
          id={`os-${os.id}`}
          aria-selected={value === os.id}
          className={cx(
            "rounded-md px-2.5 py-1 text-[12.5px]",
            value === os.id ? "bg-panel font-medium text-ink shadow-sm" : "text-muted hover:text-ink",
          )}
          onClick={() => onChange(os.id)}
        >
          {os.label}
        </button>
      ))}
    </div>
  );
}

export function CopyBlock({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg/70">
      <div className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5">
        <span className="text-[12px] text-muted">{label}</span>
        <button
          type="button"
          className="btn py-0.5 text-[12px]"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setDone(true);
              window.setTimeout(() => setDone(false), 1600);
            });
          }}
        >
          {done ? <Check size={12} /> : <Copy size={12} />} {done ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[12px] leading-5 text-ink">{text}</pre>
    </div>
  );
}

export function StatusPill({
  state,
}: {
  state: "connected" | "running" | "not_running" | "loading";
}) {
  const spec = {
    loading: { label: "Checking…", hint: "Looking at this computer.", dot: "bg-faint" },
    connected: { label: "Connected", hint: "An app is reading Ensemble right now.", dot: "bg-ok" },
    running: { label: "Ready and waiting", hint: "The shared connection is on.", dot: "bg-ok pulse-dot" },
    not_running: { label: "Not started", hint: "Apps can still start Ensemble themselves.", dot: "bg-warn" },
  }[state];
  return (
    <div role="status" aria-live="polite" className="tile flex items-center gap-2.5 rounded-xl bg-panel px-3 py-2">
      <span className={cx("h-2 w-2 shrink-0 rounded-full", spec.dot)} />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{spec.label}</span>
        <span className="block text-[12px] text-muted">{spec.hint}</span>
      </span>
    </div>
  );
}
