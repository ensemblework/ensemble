"use client";

import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { useEffect, useMemo, useState } from "react";
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

/** Same CodeMirror themes as the Code tab, loaded only when this pane opens. */
export function PlotCodePane(props: { value: string; onChange: (value: string) => void }) {
  return <IdeSpace className="flex h-full min-h-0 flex-col rounded-lg border border-line"><ThemedPlotCode {...props} /></IdeSpace>;
}

function ThemedPlotCode({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px), (max-height: 500px)");
    const sync = () => setPhone(media.matches); sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const ide = useIdeTheme();
  const custom = useMemo(() => (ide?.editor ? codeMirrorTheme(ide) : null), [ide]);
  return (
    <>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-2 py-1.5"><span className="text-[10px] text-muted">Theme shared with Code</span><ThemeControl /></div>
    {phone && <p className="shrink-0 px-3 py-2 text-[11px] text-muted">View code here. Use a larger screen to edit.</p>}
    <CodeMirror
      value={value}
      readOnly={phone}
      editable={!phone}
      height="100%"
      minHeight="0px"
      theme={custom ? "none" : oneDark}
      extensions={[python(), scroll, ...(custom ? [custom] : [blend]), remeasureOnFontLoad]}
      onChange={onChange}
      className="min-h-0 flex-1 overflow-hidden rounded-b-lg"
    />
    </>
  );
}
