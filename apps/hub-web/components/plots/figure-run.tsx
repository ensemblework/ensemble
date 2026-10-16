"use client";

import { Play } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { usePythonStatus } from "@/lib/plots/browser-python";
import { usePersistentState } from "@/lib/prefs";
import { renderPlot, scriptErrorLine } from "@/lib/plots/render";
import { useModKey } from "@/lib/platform";
import { cx } from "@/components/ui";

export type FigureRun = { status: "idle" | "running" | "done" | "failed"; image: string | null; error: string; line: number | null };

/** Runs a Code panel's script to a PNG, on the server or in this browser (`renderPlot`). A newer run wins over a slower older one. */
export function useFigureRun(workspaceId: string | null) {
  const [state, setState] = useState<FigureRun>({ status: "idle", image: null, error: "", line: null });
  const latest = useRef(0);
  const run = useCallback(
    async (code: string) => {
      if (!workspaceId) return;
      const id = ++latest.current;
      setState((current) => ({ ...current, status: "running", error: "", line: null }));
      try {
        const result = await renderPlot(workspaceId, { format: "png", code });
        if (id !== latest.current) return;
        setState({ status: "done", image: `data:image/png;base64,${result.data}`, error: "", line: null });
      } catch (error) {
        if (id !== latest.current) return;
        const message = error instanceof Error ? error.message : "The script failed.";
        setState((current) => ({ status: "failed", image: current.image, error: message, line: scriptErrorLine(message) }));
      }
    },
    [workspaceId],
  );
  return { state, run };
}

export function RunButton({ running, disabled, onRun }: { running: boolean; disabled?: boolean; onRun: () => void }) {
  const mod = useModKey();
  return (
    <button type="button" className="btn-primary shrink-0 gap-1 px-2 py-0.5 text-[12px]" disabled={disabled || running} onClick={onRun} title={`Run (${mod}+Enter or Shift+Enter)`} data-plot-run>
      <Play size={12} aria-hidden /> {running ? "Running…" : "Run"}
      <span className="hidden text-[10.5px] opacity-75 sm:inline">{mod}↵</span>
    </button>
  );
}

/** The figure the last run drew, or why it failed with the line. A failed run keeps the last figure, dimmed. */
export function FigureOutput({ state, placeholder }: { state: FigureRun; placeholder: string }) {
  const python = usePythonStatus();
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2" data-plot-figure-output={state.status}>
      {state.status === "running" ? (
        <p className="shrink-0 text-[12px] text-muted" role="status">
          {python === "loading" ? "Starting Python in your browser (the first time only, about 30 MB)…" : "Running the code…"}
        </p>
      ) : null}
      {state.status === "failed" ? (
        <pre className="max-h-40 shrink-0 overflow-auto whitespace-pre-wrap rounded-md border border-line px-2 py-1.5 font-mono text-[12px] text-danger" role="alert" data-plot-run-error>
          {state.error}
        </pre>
      ) : null}
      {state.image ? (
        <img src={state.image} alt="Figure from the code" data-plot-figure className={cx("min-h-0 w-full flex-1 object-contain", state.status !== "done" && "opacity-50")} />
      ) : state.status === "idle" ? (
        <p className="m-auto max-w-xs px-4 text-center text-[13px] text-muted">{placeholder}</p>
      ) : null}
    </div>
  );
}

/** Code panels put the figure under the code, so the code has the full width; this browser can ask for it beside the code instead. */
export function useFigureBeside() {
  const [beside, setBeside] = usePersistentState("ensemble.plots.figure-beside", false);
  return [beside, setBeside] as const;
}

/** Only wide screens have room for the figure beside the code. */
export function FigureBesideToggle({ beside, onChange }: { beside: boolean; onChange: (beside: boolean) => void }) {
  return (
    <button
      type="button"
      className="btn hidden px-2 py-0.5 text-[12px] lg:inline-flex"
      aria-pressed={beside}
      title={beside ? "Put the figure under the code, so the code has the full width" : "Show the figure beside the code"}
      onClick={() => onChange(!beside)}
      data-plot-figure-beside={beside ? "1" : "0"}
    >
      Figure beside code
    </button>
  );
}
