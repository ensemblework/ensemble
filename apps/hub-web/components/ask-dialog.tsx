"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog } from "./ui";

type Ask =
  | { kind: "text"; title: string; label?: string; placeholder?: string; initial?: string; confirm?: string; resolve: (value: string | null) => void }
  | { kind: "confirm"; title: string; body?: string; confirm?: string; danger?: boolean; resolve: (value: boolean) => void };

let show: ((ask: Ask) => void) | null = null;

/** An in-app text prompt. Resolves null on Cancel or Escape. */
export function askText(options: { title: string; label?: string; placeholder?: string; initial?: string; confirm?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    if (!show) return resolve(null);
    show({ kind: "text", ...options, resolve });
  });
}

/** An in-app confirmation. Resolves false on Cancel or Escape. */
export function confirmAction(options: { title: string; body?: string; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) return resolve(false);
    show({ kind: "confirm", ...options, resolve });
  });
}

/** Mounted once (providers.tsx). Replaces the browser's own prompt() and confirm() boxes. */
export function AskHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    show = (next) => {
      setValue(next.kind === "text" ? (next.initial ?? "") : "");
      setAsk(next);
    };
    return () => {
      show = null;
    };
  }, []);
  useEffect(() => {
    if (ask?.kind === "text") window.setTimeout(() => input.current?.select(), 30);
  }, [ask]);
  if (!ask) return null;
  const close = (result: string | boolean | null) => {
    if (ask.kind === "text") ask.resolve(typeof result === "string" ? result : null);
    else ask.resolve(result === true);
    setAsk(null);
  };
  return (
    <Dialog open onClose={() => close(null)} title={ask.title} width={440}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          close(ask.kind === "text" ? value.trim() : true);
        }}
      >
        {ask.kind === "text" ? (
          <label className="block">
            {ask.label ? <span className="mb-1.5 block text-[12.5px] text-muted">{ask.label}</span> : null}
            <input ref={input} autoFocus className="field w-full" value={value} placeholder={ask.placeholder} onChange={(event) => setValue(event.target.value)} maxLength={120} />
          </label>
        ) : ask.body ? (
          <p className="text-[13.5px] leading-5 text-muted">{ask.body}</p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => close(null)}>
            Cancel
          </button>
          <button
            type="submit"
            autoFocus={ask.kind === "confirm"}
            className={ask.kind === "confirm" && ask.danger ? "btn btn-danger" : "btn-primary"}
            disabled={ask.kind === "text" && !value.trim()}
          >
            {ask.confirm ?? (ask.kind === "text" ? "Create" : "Continue")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
