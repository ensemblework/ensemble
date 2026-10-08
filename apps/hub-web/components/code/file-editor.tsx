"use client";

import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror, { EditorView, type Extension, type ViewUpdate } from "@uiw/react-codemirror";
import { useMemo } from "react";
import { useIdeTheme } from "@/components/code/ide-theme-context";
import { codeMirrorTheme } from "@/components/code/codemirror-theme";
import { remeasureOnFontLoad } from "@/lib/editor-font";

function languageExtension(path: string): Extension[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return [javascript({ jsx: ext.endsWith("x"), typescript: ext.startsWith("t") })];
  if (ext === "py") return [python()];
  if (ext === "json") return [json()];
  if (["md", "markdown"].includes(ext)) return [markdown()];
  return [];
}

/** Ensemble Default blends the editor into the app. A chosen theme paints its own surface. */
const blend = EditorView.theme({
  "&": { backgroundColor: "transparent", fontSize: "12.5px", height: "100%" },
  ".cm-gutters": { backgroundColor: "transparent", borderRight: "1px solid var(--line)" },
  ".cm-scroller, .cm-content, .cm-gutters": { fontFamily: "var(--font-mono)" },
});
const typeface = EditorView.theme({
  "&": { fontSize: "12.5px", height: "100%" },
  ".cm-scroller, .cm-content, .cm-gutters": { fontFamily: "var(--font-mono)" },
});

export function FileEditor({
  path,
  value,
  onChange,
  onCursor,
  onSave,
  readOnly = false,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onCursor: (line: number, column: number) => void;
  onSave: () => void;
  readOnly?: boolean;
}) {
  const ide = useIdeTheme();
  const custom = useMemo(() => (ide?.editor ? codeMirrorTheme(ide) : null), [ide]);
  const extensions = useMemo(
    () => [
      ...languageExtension(path),
      ...(custom ?? [blend]),
      ...(custom ? [typeface] : []),
      remeasureOnFontLoad,
      EditorView.lineWrapping,
      EditorView.domEventHandlers({
        keydown(event) {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            onSave();
            return true;
          }
          return false;
        },
      }),
    ],
    [path, onSave, custom],
  );
  return (
    <CodeMirror
      value={value}
      height="100%"
      theme={custom ? "none" : oneDark}
      extensions={extensions}
      readOnly={readOnly}
      editable={!readOnly}
      onChange={onChange}
      onUpdate={(update: ViewUpdate) => {
        if (!update.selectionSet && !update.docChanged) return;
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        onCursor(line.number, head - line.from + 1);
      }}
      className="h-full"
    />
  );
}
