"use client";

import { python } from "@codemirror/lang-python";
import { setDiagnostics } from "@codemirror/lint";
import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IdeSpace, ThemeControl } from "@/components/code/ide-theme";
import { useIdeTheme } from "@/components/code/ide-theme-context";
import { codeMirrorTheme } from "@/components/code/codemirror-theme";
import { remeasureOnFontLoad } from "@/lib/editor-font";

const scroll = EditorView.theme({
  ".cm-scroller": { overflow: "auto" },
});

const blend = EditorView.theme({
  "&": { backgroundColor: "transparent", fontSize: "12.5px", height: "100%" },
  ".cm-gutters": { backgroundColor: "transparent", borderRight: "1px solid var(--line)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", overflow: "auto" },
  ".cm-content, .cm-gutters": { fontFamily: "var(--font-mono)" },
});

type PaneProps = {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl/Cmd+Enter and Shift+Enter call this. */
  onRun?: () => void;
  /** The line the last run failed on, marked in the editor. */
  errorLine?: number | null;
  errorText?: string;
  /** Buttons for the toolbar, before the theme picker. */
  actions?: ReactNode;
};

/** Same CodeMirror themes as the Code tab, loaded only when this pane opens. */
export function PlotCodePane(props: PaneProps) {
  return <IdeSpace className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-line"><ThemedPlotCode {...props} /></IdeSpace>;
}

function ThemedPlotCode({ value, onChange, onRun, errorLine = null, errorText = "", actions }: PaneProps) {
  const [phone, setPhone] = useState(false);
  const [view, setView] = useState<EditorView | null>(null);
  const run = useRef(onRun);
  run.current = onRun;
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px), (max-height: 500px)");
    const sync = () => setPhone(media.matches); sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const ide = useIdeTheme();
  const custom = useMemo(() => (ide?.editor ? codeMirrorTheme(ide) : null), [ide]);
  const runKeys = useMemo(() => {
    const go = () => {
      if (!run.current) return false;
      run.current();
      return true;
    };
    return Prec.highest(keymap.of([{ key: "Mod-Enter", run: go }, { key: "Shift-Enter", run: go }]));
  }, []);
  useEffect(() => {
    if (!view) return;
    const lines = view.state.doc.lines;
    const diagnostics = errorLine && errorLine >= 1 && errorLine <= lines
      ? [{ from: view.state.doc.line(errorLine).from, to: view.state.doc.line(errorLine).to, severity: "error" as const, message: errorText || "The run failed here." }]
      : [];
    view.dispatch(setDiagnostics(view.state, diagnostics));
  }, [view, errorLine, errorText]);
  return (
    <>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-2 py-1.5">
      {actions}
      <span className="ml-auto flex items-center gap-2"><span className="text-[10px] text-muted">Theme shared with Code</span><ThemeControl /></span>
    </div>
    {phone && <p className="shrink-0 px-3 py-2 text-[11px] text-muted">View code here. Use a larger screen to edit.</p>}
    <CodeMirror
      value={value}
      readOnly={phone}
      editable={!phone}
      height="100%"
      minHeight="0px"
      theme={custom ? "none" : oneDark}
      extensions={[python(), runKeys, scroll, ...(custom ? [custom] : [blend]), remeasureOnFontLoad]}
      onChange={onChange}
      onCreateEditor={setView}
      className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-b-lg"
    />
    </>
  );
}
