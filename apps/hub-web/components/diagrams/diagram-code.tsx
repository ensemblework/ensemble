"use client";

import { toggleComment } from "@codemirror/commands";
import { linter, lintGutter, setDiagnostics, type Diagnostic as LintDiagnostic } from "@codemirror/lint";
import { Prec } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { PALETTE, parseDiagram, printDiagram, resolveColor, scanDiagram, type Diagnostic, type DiagramModel, type PaletteColor } from "@ensemble/block-diagrams";
import { SHORTCUTS, eventMatchesChord } from "@ensemble/shared-types";
import CodeMirror from "@uiw/react-codemirror";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { codeMirrorTheme } from "@/components/code/codemirror-theme";
import { useIdeTheme } from "@/components/code/ide-theme-context";
import { isApplePlatform } from "@/lib/platform";
import { remeasureOnFontLoad } from "@/lib/editor-font";
import { diagramLanguage } from "./diagram-language";

const blend = EditorView.theme({
  "&": { backgroundColor: "transparent", fontSize: "12.5px", height: "100%" },
  ".cm-gutters": { backgroundColor: "transparent", borderRight: "1px solid var(--line)", color: "var(--faint)" },
  ".cm-scroller, .cm-content, .cm-gutters": { fontFamily: "var(--font-mono)", lineHeight: "1.45" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--hover) 80%, transparent)" },
});

const typeface = EditorView.theme({
  "&": { fontSize: "12.5px", height: "100%" },
  ".cm-scroller, .cm-content, .cm-gutters": { fontFamily: "var(--font-mono)", lineHeight: "1.45" },
});

function wavy(color: string): string {
  const path = `<path d="m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0" stroke="${color}" fill="none" stroke-width=".7"/>`;
  return `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="6" height="3">${encodeURIComponent(path)}</svg>')`;
}

function marker(svgBody: string): string {
  return `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${encodeURIComponent(svgBody)}</svg>')`;
}

const diagnosticsTheme = EditorView.theme({
  ".cm-lintRange": { backgroundPosition: "left bottom", backgroundRepeat: "repeat-x" },
  ".cm-lintRange-error": { backgroundImage: wavy("#e5484d") },
  ".cm-lintRange-warning": { backgroundImage: wavy("#f5a524") },
  ".cm-lintRange-info": { backgroundImage: wavy("#3b82f6") },
  ".cm-lintPoint:after": { borderBottomColor: "#e5484d" },
  ".cm-lintPoint-warning:after": { borderBottomColor: "#f5a524" },
  ".cm-lintPoint-info:after": { borderBottomColor: "#3b82f6" },
  ".cm-diagnostic": { background: "var(--panel)", color: "var(--ink)" },
  ".cm-diagnostic-error": { borderLeftColor: "#e5484d" },
  ".cm-diagnostic-warning": { borderLeftColor: "#f5a524" },
  ".cm-diagnostic-info": { borderLeftColor: "#3b82f6" },
  ".cm-diagnosticAction": {
    background: "transparent",
    color: "var(--ink)",
    border: "1px solid var(--line)",
    borderRadius: "6px",
    padding: "1px 6px",
  },
  ".cm-tooltip": {
    background: "var(--panel)",
    color: "var(--ink)",
    border: "1px solid var(--line)",
    borderRadius: "8px",
  },
  ".cm-tooltip.cm-tooltip-hover": { padding: "0" },
  ".diagram-hover": { padding: "6px 8px", maxWidth: "280px", fontSize: "12.5px", lineHeight: "1.4" },
  ".cm-lint-marker-error": { content: marker(`<circle cx="20" cy="20" r="15" fill="#e5484d"/>`) },
  ".cm-lint-marker-warning": { content: marker(`<path fill="#f5a524" d="M20 6L37 35L3 35Z"/>`) },
  ".cm-lint-marker-info": { content: marker(`<circle cx="20" cy="20" r="14" fill="#3b82f6"/>`) },
});

function swatchColor(value: string): string | null {
  const resolved = resolveColor(value);
  if (!resolved) return null;
  if (resolved.startsWith("#")) return resolved;
  return PALETTE.light[resolved as PaletteColor]?.stroke ?? null;
}

class SwatchWidget extends WidgetType {
  constructor(readonly color: string) {
    super();
  }
  eq(other: SwatchWidget) {
    return other.color === this.color;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "diagram-swatch";
    el.style.background = this.color;
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

const colorSwatches = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = swatchesFor(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = swatchesFor(update.view);
    }
  },
  { decorations: (value) => value.decorations },
);

function swatchesFor(view: EditorView): DecorationSet {
  const tokens = scanDiagram(view.state.doc.toString());
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    for (const token of tokens) {
      if (token.kind !== "color" || token.to <= from || token.from >= to) continue;
      const color = swatchColor(token.value);
      if (!color) continue;
      ranges.push(Decoration.widget({ widget: new SwatchWidget(color), side: -1 }).range(token.from));
    }
  }
  return Decoration.set(ranges, true);
}

function chord(id: string) {
  return SHORTCUTS.find((binding) => binding.id === id);
}

function matches(event: KeyboardEvent, id: string): boolean {
  const binding = chord(id);
  if (!binding) return false;
  const apple = isApplePlatform();
  const keys = apple ? binding.mac : binding.other;
  return Boolean(keys && eventMatchesChord(event, keys, apple));
}

function formatDocument(view: EditorView): boolean {
  const current = view.state.doc.toString();
  const printed = printDiagram(parseDiagram(current).model);
  if (printed !== current) {
    view.dispatch({ changes: { from: 0, to: current.length, insert: printed } });
  }
  return true;
}

function toLint(view: EditorView, items: Diagnostic[]): LintDiagnostic[] {
  const doc = view.state.doc;
  const max = doc.length;
  return items.flatMap((item) => {
    let from = item.from;
    let to = item.to;
    if (from == null || to == null) {
      const lineNo = Math.min(Math.max(1, item.line), doc.lines);
      const line = doc.line(lineNo);
      from = line.from;
      to = Math.max(line.from, line.to);
    }
    from = Math.max(0, Math.min(from, max));
    to = Math.max(from, Math.min(to, max));
    return [
      {
        from,
        to,
        severity: item.severity,
        message: item.message,
        actions: item.fixes?.map((fix) => ({
          name: fix.title,
          apply(editor: EditorView) {
            const length = editor.state.doc.length;
            const start = Math.max(0, Math.min(fix.from, length));
            const end = Math.max(start, Math.min(fix.to, length));
            editor.dispatch({ changes: { from: start, to: end, insert: fix.insert }, scrollIntoView: true });
          },
        })),
      },
    ];
  });
}

export type DiagramCodeHandle = {
  focusLine: (line: number, from?: number, to?: number) => void;
  getView: () => EditorView | null;
  format: () => void;
  comment: () => void;
};

export const DiagramCode = forwardRef<
  DiagramCodeHandle,
  {
    value: string;
    diagnostics: Diagnostic[];
    model: DiagramModel | null;
    onChange: (value: string) => void;
  }
>(function DiagramCode({ value, diagnostics, model, onChange }, ref) {
  const ide = useIdeTheme();
  const viewRef = useRef<EditorView | null>(null);
  const diagnosticsRef = useRef(diagnostics);
  const modelRef = useRef(model);
  const onChangeRef = useRef(onChange);
  diagnosticsRef.current = diagnostics;
  modelRef.current = model;
  onChangeRef.current = onChange;
  const emit = useCallback((value: string) => onChangeRef.current(value), []);
  const custom = useMemo(() => (ide?.editor ? codeMirrorTheme(ide) : null), [ide]);
  const setup = useMemo(
    () => ({
      lineNumbers: true,
      highlightActiveLine: true,
      highlightActiveLineGutter: true,
      bracketMatching: true,
      foldGutter: true,
      autocompletion: true,
      closeBrackets: true,
      lintKeymap: false,
    }),
    [],
  );
  const language = useMemo(() => diagramLanguage(() => modelRef.current), []);

  function publish(view: EditorView) {
    view.dispatch(setDiagnostics(view.state, toLint(view, diagnosticsRef.current)));
  }

  useImperativeHandle(ref, () => ({
    getView: () => viewRef.current,
    focusLine(line, from, to) {
      const view = viewRef.current;
      if (!view) return;
      const doc = view.state.doc;
      const row = doc.line(Math.min(Math.max(1, line), doc.lines));
      const anchor = from == null ? row.from : Math.max(0, Math.min(from, doc.length));
      const head = to == null ? anchor : Math.max(anchor, Math.min(to, doc.length));
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
      view.focus();
    },
    format() {
      const view = viewRef.current;
      if (!view) return;
      formatDocument(view);
      view.focus();
    },
    comment() {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      toggleComment(view);
    },
  }));

  useEffect(() => {
    const view = viewRef.current;
    if (view) publish(view);
  }, [diagnostics, custom]);

  const extensions = useMemo(
    () => [
      language,
      colorSwatches,
      ...(custom ?? [blend]),
      ...(custom ? [typeface] : []),
      linter((view) => toLint(view, diagnosticsRef.current), { delay: 220 }),
      lintGutter(),
      diagnosticsTheme,
      EditorView.lineWrapping,
      remeasureOnFontLoad,
      EditorView.contentAttributes.of({ "aria-label": "Diagram text", spellcheck: "false" }),
      Prec.high(
        keymap.of([
          {
            key: "Mod-/",
            run: toggleComment,
          },
          {
            key: "Alt-Shift-i",
            run: formatDocument,
          },
        ]),
      ),
      EditorView.domEventHandlers({
        keydown(event, view) {
          if (matches(event, "diagram-comment")) {
            event.preventDefault();
            toggleComment(view);
            return true;
          }
          if (matches(event, "diagram-format")) {
            event.preventDefault();
            formatDocument(view);
            return true;
          }
          return false;
        },
      }),
    ],
    [custom, language],
  );

  return (
    <CodeMirror
      value={value}
      height="100%"
      theme={custom ? "none" : oneDark}
      basicSetup={setup}
      extensions={extensions}
      onChange={emit}
      onCreateEditor={(view) => {
        viewRef.current = view;
        publish(view);
      }}
      className="diagram-code h-full"
    />
  );
});
