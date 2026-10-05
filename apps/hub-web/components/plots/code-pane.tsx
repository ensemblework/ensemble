"use client";

import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { useMemo } from "react";
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
export function PlotCodePane({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const ide = useIdeTheme();
  const custom = useMemo(() => (ide?.editor ? codeMirrorTheme(ide) : null), [ide]);
  return (
    <CodeMirror
      value={value}
      height="100%"
      minHeight="0px"
      theme={custom ? "none" : oneDark}
      extensions={[python(), scroll, ...(custom ? [custom] : [blend]), remeasureOnFontLoad]}
      onChange={onChange}
      className="h-full overflow-hidden rounded-lg border border-line"
    />
  );
}
