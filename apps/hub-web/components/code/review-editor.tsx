"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The Code tab's editor (docs/16 §1): one document, the file on disk, compared with what it is
 * reviewed against (before the run, plus the changes accepted so far; for a checkout, the index).
 *
 * - Changes view: unchanged stretches fold away; each change shows the lines it replaced above it.
 *   An agent's change, exactly as the agent made it, has Accept (Alt+Y) and Reject (Alt+N). Anything
 *   else that differs is "Your edit" with Revert (Alt+N): git cannot tell who typed, so a change that
 *   is not exactly the agent's is yours. Whether a change is decided is read from the text itself:
 *   reject it and the old lines are back in the document (Ctrl+Z brings the change back); accept it
 *   and it becomes part of what is compared against, and leaves the view.
 * - File view (F4): the same document, whole, with folding and change bars in the gutter.
 *
 * F7 / Shift+F7 move between changes; past the last one, `onEdge` moves to the next file.
 */
import { acceptChunk, Chunk, getChunks, getOriginalDoc, goToNextChunk, goToPreviousChunk, originalDocChangeEffect, rejectChunk, unifiedMergeView } from "@codemirror/merge";
import { ChangeSet, Compartment, EditorState, Prec, StateEffect, StateField, Text, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { codeMirrorTheme } from "@/components/code/codemirror-theme";
import { blend, languageExtension, typeface } from "@/components/code/file-editor";
import { useIdeTheme } from "@/components/code/ide-theme-context";
import { remeasureOnFontLoad } from "@/lib/editor-font";

export type ReviewMode = "changes" | "file";

export type ChunkCounts = { agent: number; yours: number };

export type ReviewEditorHandle = {
  /** Accept the agent's change at the cursor. */
  accept(): boolean;
  /** Reject the agent's change, or revert your edit, at the cursor. */
  reject(): boolean;
  next(): void;
  previous(): void;
  focus(): void;
  /** The text now (what a save writes). */
  text(): string;
};

type Props = {
  path: string;
  /** What the file is compared against. */
  original: string;
  /** The file now. */
  value: string;
  /** The file before the run and as the run left it, to tell the agent's changes from yours. Null for a checkout. */
  start: string | null;
  agent: string | null;
  kind: "review" | "repo";
  mode: ReviewMode;
  readOnly: boolean;
  fontSize: number;
  /** Move the cursor to this line and show it (a search result, a file opened at a line). */
  reveal?: { line: number; nonce: number } | null;
  onChange: (text: string) => void;
  onAccept: (original: string) => void;
  onCursor: (line: number, column: number) => void;
  onSave: () => void;
  onEdge: (direction: 1 | -1) => void;
  onCounts: (counts: ChunkCounts) => void;
};

const DIFF = { scanLimit: 500 };

/** What a chunk says: the text it takes out and the text it puts in, wherever it sits. */
function signature(a: Text, b: Text, chunk: Chunk): string {
  return `${a.sliceString(chunk.fromA, chunk.toA)}\u0000${b.sliceString(chunk.fromB, chunk.toB)}`;
}

function agentSignatures(start: string | null, agent: string | null): Set<string> {
  if (start === null && agent === null) return new Set();
  const a = Text.of((start ?? "").split("\n"));
  const b = Text.of((agent ?? "").split("\n"));
  return new Set(Chunk.build(a, b, DIFF).map((chunk) => signature(a, b, chunk)));
}

type Classified = { chunk: Chunk; agent: boolean };

function classify(state: EditorState, agentSigs: Set<string>, kind: "review" | "repo"): Classified[] {
  const found = getChunks(state);
  if (!found) return [];
  const original = getOriginalDoc(state);
  return found.chunks.map((chunk) => ({ chunk, agent: kind === "review" && agentSigs.has(signature(original, state.doc, chunk)) }));
}

class ChunkBar extends WidgetType {
  constructor(
    readonly agent: boolean,
    readonly kind: "review" | "repo",
    readonly at: number,
    readonly act: (action: "accept" | "reject", at: number) => void,
  ) {
    super();
  }
  eq(other: ChunkBar): boolean {
    return other.agent === this.agent && other.kind === this.kind && other.at === this.at;
  }
  toDOM(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = `cm-chunkBar ${this.agent ? "cm-chunkBar-agent" : "cm-chunkBar-yours"}`;
    const label = document.createElement("span");
    label.className = "cm-chunkBar-label";
    label.textContent = this.kind === "repo" ? "Change" : this.agent ? "Agent change" : "Your edit";
    bar.appendChild(label);
    const button = (text: string, title: string, action: "accept" | "reject") => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = text;
      element.title = title;
      element.className = `cm-chunkBar-button cm-chunkBar-${action}`;
      element.onmousedown = (event) => {
        event.preventDefault();
        this.act(action, this.at);
      };
      bar.appendChild(element);
    };
    if (this.kind === "repo") {
      button("Stage", "Stage this change (Alt+Y)", "accept");
      button("Discard", "Put the staged lines back (Alt+N)", "reject");
    } else if (this.agent) {
      button("Accept", "Keep this change (Alt+Y)", "accept");
      button("Reject", "Put the old lines back (Alt+N). Ctrl+Z brings the change back.", "reject");
    } else {
      button("Revert", "Put these lines back as they were (Alt+N)", "reject");
    }
    return bar;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** Asks the change marks to be worked out again (the merge view had not measured yet). */
const refreshMarks = StateEffect.define<null>();

/**
 * Marks your edits in blue and puts a bar with the actions above each change (Changes view). Block
 * widgets change the layout, so they come from a state field, not a view plugin.
 */
function chunkDecorations(getAgentSigs: () => Set<string>, kind: "review" | "repo", act: (action: "accept" | "reject", at: number) => void, controls: () => boolean) {
  const build = (state: EditorState): DecorationSet => {
    const ranges = [];
    const show = controls();
    const doc = state.doc;
    for (const { chunk, agent } of classify(state, getAgentSigs(), kind)) {
      const at = Math.min(chunk.fromB, doc.length);
      const first = doc.lineAt(at);
      if (show) ranges.push(Decoration.widget({ widget: new ChunkBar(agent, kind, at, act), side: -2, block: true }).range(first.from));
      if (agent || kind !== "review" || chunk.toB <= chunk.fromB) continue;
      // Your edit: every line of it, in blue.
      for (let line = first; ; line = doc.line(line.number + 1)) {
        ranges.push(Decoration.line({ class: "cm-yoursLine" }).range(line.from));
        if (line.number >= doc.lines || line.to + 1 >= chunk.toB) break;
      }
    }
    return Decoration.set(ranges, true);
  };
  return StateField.define<DecorationSet>({
    create: build,
    update: (marks, tr) => (tr.docChanged || tr.effects.length || tr.reconfigured ? build(tr.state) : marks),
    provide: (field) => EditorView.decorations.from(field),
  });
}

const reviewChrome = EditorView.baseTheme({
  ".cm-chunkBar": { display: "flex", alignItems: "center", gap: "6px", padding: "2px 8px", fontFamily: "var(--font-sans, system-ui)", fontSize: "11.5px", borderTop: "1px solid var(--line, rgba(127,127,127,.25))" },
  ".cm-chunkBar-agent": { backgroundColor: "rgba(46, 160, 67, 0.10)" },
  ".cm-chunkBar-yours": { backgroundColor: "rgba(56, 132, 255, 0.12)" },
  ".cm-chunkBar-label": { opacity: "0.75", marginRight: "4px" },
  ".cm-chunkBar-button": { border: "1px solid rgba(127,127,127,.35)", borderRadius: "4px", padding: "0 6px", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" },
  ".cm-chunkBar-accept": { borderColor: "rgba(46, 160, 67, 0.6)" },
  ".cm-chunkBar-reject": { borderColor: "rgba(248, 81, 73, 0.6)" },
  ".cm-yoursLine": { backgroundColor: "rgba(56, 132, 255, 0.14) !important" },
  "&.cm-reviewFile .cm-deletedChunk": { display: "none" },
  "&.cm-reviewFile .cm-insertedLine, &.cm-reviewFile .cm-changedLine": { backgroundColor: "transparent !important" },
});

export const ReviewEditor = forwardRef<ReviewEditorHandle, Props>(function ReviewEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const ide = useIdeTheme();
  const agentSigs = useMemo(() => agentSignatures(props.start, props.agent), [props.start, props.agent]);
  const sigsRef = useRef(agentSigs);
  sigsRef.current = agentSigs;
  const compartments = useMemo(() => ({ theme: new Compartment(), mode: new Compartment(), editable: new Compartment(), size: new Compartment() }), []);

  const counts = (state: EditorState) => {
    const all = classify(state, sigsRef.current, latest.current.kind);
    latest.current.onCounts({ agent: all.filter((row) => row.agent).length, yours: all.filter((row) => !row.agent).length });
  };

  const act = (action: "accept" | "reject", at?: number): boolean => {
    const editor = view.current;
    if (!editor || latest.current.readOnly) return false;
    const pos = at ?? editor.state.selection.main.head;
    const found = classify(editor.state, sigsRef.current, latest.current.kind).find(({ chunk }) => pos >= chunk.fromB && pos <= Math.max(chunk.toB, chunk.fromB));
    if (!found) return false;
    // Your own edit is never "accepted": it is already yours. Alt+Y only keeps an agent's change (or stages, in a checkout).
    if (action === "accept" && !found.agent && latest.current.kind === "review") return false;
    if (action === "accept") {
      if (!acceptChunk(editor, pos)) return false;
      latest.current.onAccept(getOriginalDoc(editor.state).toString());
    } else if (!rejectChunk(editor, pos)) return false;
    return true;
  };

  const modeExtension = (mode: ReviewMode, original: string): Extension => [
    unifiedMergeView({
      original,
      mergeControls: false,
      gutter: true,
      highlightChanges: mode === "changes",
      syntaxHighlightDeletions: true,
      diffConfig: DIFF,
      ...(mode === "changes" ? { collapseUnchanged: { margin: 3, minSize: 6 } } : {}),
    }),
    mode === "file" ? EditorView.editorAttributes.of({ class: "cm-reviewFile" }) : [],
  ];

  const themeExtension = () => {
    const custom = ide?.editor ? codeMirrorTheme(ide) : null;
    return custom ? [custom, typeface] : [oneDark, blend];
  };

  // The document and what it is compared against are set when the editor opens; a new file or a
  // reload from disk opens a new editor (the parent keys it).
  useEffect(() => {
    if (!host.current) return;
    const current = latest.current;
    const state = EditorState.create({
      doc: current.value,
      extensions: [
        basicSetup({ foldGutter: true, highlightActiveLine: true, autocompletion: false }),
        ...languageExtension(current.path),
        compartments.theme.of(themeExtension()),
        compartments.size.of(EditorView.theme({ "&": { fontSize: `${current.fontSize}px` } })),
        compartments.editable.of([EditorView.editable.of(!current.readOnly), EditorState.readOnly.of(current.readOnly)]),
        compartments.mode.of(modeExtension(current.mode, current.original)),
        chunkDecorations(() => sigsRef.current, current.kind, (action, at) => void act(action, at), () => latest.current.mode === "changes" && !latest.current.readOnly),
        reviewChrome,
        remeasureOnFontLoad,
        EditorView.lineWrapping,
        Prec.highest(
          keymap.of([
            { key: "Alt-y", run: () => act("accept") },
            { key: "Alt-n", run: () => act("reject") },
            {
              key: "F7",
              run: (editor) => {
                const before = editor.state.selection.main.head;
                goToNextChunk(editor);
                if (editor.state.selection.main.head <= before) latest.current.onEdge(1);
                return true;
              },
            },
            {
              key: "Shift-F7",
              run: (editor) => {
                const before = editor.state.selection.main.head;
                goToPreviousChunk(editor);
                if (editor.state.selection.main.head >= before) latest.current.onEdge(-1);
                return true;
              },
            },
            {
              key: "Mod-s",
              run: () => {
                latest.current.onSave();
                return true;
              },
            },
          ]),
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            latest.current.onCursor(line.number, head - line.from + 1);
          }
          if (update.docChanged || update.transactions.some((tr) => tr.effects.length)) counts(update.state);
        }),
      ],
    });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    // Chunks are computed once the merge view has its first measure.
    const timer = window.setTimeout(() => {
      editor.dispatch({ effects: refreshMarks.of(null) });
      counts(editor.state);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      editor.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const original = getOriginalDoc(editor.state)?.toString() ?? props.original;
    editor.dispatch({ effects: compartments.mode.reconfigure(modeExtension(props.mode, original)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.theme.reconfigure(themeExtension()) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ide]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.size.reconfigure(EditorView.theme({ "&": { fontSize: `${props.fontSize}px` } })) });
  }, [props.fontSize, compartments]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.editable.reconfigure([EditorView.editable.of(!props.readOnly), EditorState.readOnly.of(props.readOnly)]) });
  }, [props.readOnly, compartments]);

  // What is compared against changed elsewhere (an accept saved, then reloaded): follow it without a new editor.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const now = getOriginalDoc(editor.state);
    if (!now || now.toString() === props.original) return;
    const changes = ChangeSet.of({ from: 0, to: now.length, insert: props.original }, now.length);
    editor.dispatch({ effects: originalDocChangeEffect(editor.state, changes) });
  }, [props.original]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !props.reveal) return;
    const line = editor.state.doc.line(Math.min(Math.max(1, props.reveal.line), editor.state.doc.lines));
    editor.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    editor.focus();
  }, [props.reveal]);

  useImperativeHandle(ref, () => ({
    accept: () => act("accept"),
    reject: () => act("reject"),
    next: () => {
      if (view.current) goToNextChunk(view.current);
    },
    previous: () => {
      if (view.current) goToPreviousChunk(view.current);
    },
    focus: () => view.current?.focus(),
    text: () => view.current?.state.doc.toString() ?? latest.current.value,
  }));

  return <div ref={host} className="h-full min-h-0 overflow-hidden [&_.cm-editor]:h-full" data-testid="review-editor" data-mode={props.mode} />;
});
