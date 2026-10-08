"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MIN_VIEWPORT,
  addBlock,
  addTextBox,
  connectBlocks,
  errorCount,
  looksLikeMermaid,
  moveItem,
  parseDiagram,
  printDiagram,
  removeItems,
  renameItem,
  setTitle,
  toggleLock,
  type Diagnostic,
  type DiagnosticFix,
  type DiagramModel,
  type PortName,
  type ShapeId,
} from "@ensemble/block-diagrams";
import { SHORTCUTS, eventMatchesChord } from "@ensemble/shared-types";
import { ChevronRight, Lock, Type } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { IdeSpace, ThemeControl } from "@/components/code/ide-theme";
import { useToast } from "@/components/toast";
import { ApiError, api } from "@/lib/api";
import { isApplePlatform } from "@/lib/platform";
import { DiagramCanvas, type DiagramCanvasHandle } from "./canvas";
import type { DiagramCodeHandle } from "./diagram-code";
import { DiagramMore } from "./diagram-more";
import { downloadDiagram, type DiagramExportKind } from "./export-image";
import { ShapeGlyph } from "./glyph";
import { layoutInBackground } from "./layout-client";
import { useSpaceAccess } from "@/lib/access";
import { PagePeople } from "../sharing/page-people";
import { ShareButton } from "../sharing/share-dialog";

const DiagramCode = dynamic(() => import("./diagram-code").then((mod) => mod.DiagramCode), {
  ssr: false,
  loading: () => <div className="skeleton h-full w-full" />,
});

const SHAPES: Array<{ shape: ShapeId; label: string }> = [
  { shape: "rectangle", label: "Rectangle" },
  { shape: "rounded", label: "Rounded" },
  { shape: "diamond", label: "Diamond" },
  { shape: "circle", label: "Circle" },
  { shape: "ellipse", label: "Ellipse" },
  { shape: "cylinder", label: "Database" },
  { shape: "server", label: "Server" },
  { shape: "triangle", label: "Triangle" },
  { shape: "parallelogram", label: "Parallelogram" },
  { shape: "document", label: "Document" },
  { shape: "cloud", label: "Cloud" },
  { shape: "actor", label: "Person" },
  { shape: "hexagon", label: "Hexagon" },
  { shape: "note", label: "Note" },
  { shape: "trapezoid", label: "Trapezoid" },
];

function useRoomy(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    const check = () => setOk(window.innerWidth >= MIN_VIEWPORT.width && window.innerHeight >= MIN_VIEWPORT.height);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return ok;
}

function mergeLayout(previous: DiagramModel, next: DiagramModel, source: string): DiagramModel {
  if (/^\s*layout\b/im.test(source)) return next;
  const layout = { ...next.layout };
  for (const id of [...Object.keys(next.nodes), ...Object.keys(next.texts), ...Object.keys(next.groups)]) {
    if (!layout[id] && previous.layout[id]) layout[id] = previous.layout[id]!;
  }
  return { ...next, layout };
}

function typingTarget(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable=true], .cm-editor"));
}

export function DiagramEditor({ id, shared }: { id: string; shared?: { role: "view" | "edit" } }) {
  const access = useSpaceAccess();
  const readOnly = shared ? shared.role !== "edit" : !access.canEdit;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const roomy = useRoomy();
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["diagram", id], queryFn: () => api.diagram(id) });
  const [text, setText] = useState("");
  const [model, setModel] = useState<DiagramModel | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [version, setVersion] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [menu, setMenu] = useState(false);
  const [focusExport, setFocusExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [focus, setFocus] = useState(false);
  const [textWidth, setTextWidth] = useState(440);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [codeReady, setCodeReady] = useState(false);
  const [activeProblem, setActiveProblem] = useState<number | null>(null);
  const [selected, setSelected] = useState<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] });
  const select = (next: { nodes: string[]; edges: string[] }) => {
    setSelected((current) => {
      const sameNodes = current.nodes.length === next.nodes.length && current.nodes.every((id, index) => id === next.nodes[index]);
      const sameEdges = current.edges.length === next.edges.length && current.edges.every((id, index) => id === next.edges[index]);
      return sameNodes && sameEdges ? current : next;
    });
  };
  const [fitTick, setFitTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);
  const epoch = useRef(0);
  const printed = useRef("");
  const dirtyRef = useRef(false);
  const codeRef = useRef<DiagramCodeHandle>(null);
  const parseTimer = useRef<number | null>(null);
  const sawProblems = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<DiagramCanvasHandle>(null);
  const focusRef = useRef(false);
  const menuRef = useRef(false);
  const focusExportRef = useRef(false);
  const textWidthRef = useRef(440);
  const textRef = useRef("");
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const restoring = useRef(false);
  const versionRef = useRef(1);
  const modelRef = useRef<DiagramModel | null>(null);
  const selectedRef = useRef(selected);
  modelRef.current = model;
  selectedRef.current = selected;
  dirtyRef.current = dirty;
  textRef.current = text;
  versionRef.current = version;
  focusRef.current = focus;
  menuRef.current = menu;
  focusExportRef.current = focusExport;
  textWidthRef.current = textWidth;

  useEffect(() => {
    if (focus) return;
    const timer = window.setTimeout(() => setCodeReady(true), 32);
    return () => window.clearTimeout(timer);
  }, [focus]);

  useEffect(() => {
    const row = query.data?.diagram;
    if (!row || loaded.current) return;
    loaded.current = true;
    const parsed = parseDiagram(row.source);
    const mermaid = looksLikeMermaid(row.source);
    const initial = mermaid ? printDiagram(parsed.model) : row.source;
    printed.current = initial;
    setText(initial);
    setModel(parsed.model);
    setDiagnostics(mermaid ? [] : parsed.diagnostics);
    setVersion(row.version);
    const missing = Object.keys(parsed.model.nodes).some((nodeId) => !parsed.model.layout[nodeId]) || Object.keys(parsed.model.texts).some((textId) => !parsed.model.layout[textId]);
    if (!missing) return;
    const ticket = ++epoch.current;
    void layoutInBackground(parsed.model).then((laid) => {
      if (ticket !== epoch.current) return;
      if (dirtyRef.current || modelRef.current?.meta.title !== parsed.model.meta.title) return;
      // Keep a broken document as the user wrote it. Printing would rewrite typos and drop the lines they still need to fix.
      // Positions computed on open are for the canvas only. Writing them back
      // would mark a diagram the person has not edited as unsaved.
      setModel(laid);
      setFitTick((value) => value + 1);
    });
  }, [query.data, id]);

  const adopt = (source: string, nextVersion: number) => {
    epoch.current += 1;
    const parsed = parseDiagram(source);
    printed.current = source;
    textRef.current = source;
    versionRef.current = nextVersion;
    setText(source);
    setModel(parsed.model);
    setDiagnostics(parsed.diagnostics);
    setVersion(nextVersion);
    setDirty(false);
    setSaveState("saved");
    setFitTick((value) => value + 1);
    void client.invalidateQueries({ queryKey: ["diagram", id] });
  };

  const save = useMutation({
    mutationFn: async () => {
      const current = modelRef.current;
      if (!current) return null;
      const source = textRef.current;
      const sentVersion = versionRef.current;
      const result = await api.updateDiagram(id, {
        source,
        title: current.meta.title.trim() || "Untitled diagram",
        version: sentVersion,
      });
      return { result, source, sentVersion };
    },
    onSuccess: (payload) => {
      if (!payload) return;
      setVersion(payload.result.diagram.version);
      if (textRef.current === payload.source && versionRef.current === payload.sentVersion) {
        setDirty(false);
        setSaveState("saved");
      }
      void client.invalidateQueries({ queryKey: ["diagrams"] });
    },
    onError: (error) => {
      setSaveState("error");
      toast(error instanceof Error ? error.message : "Couldn't save the diagram.", { tone: "error" });
      if (error instanceof ApiError && error.status === 409) void query.refetch();
    },
  });

  useEffect(() => {
    if (!dirty || !model || save.isPending) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => save.mutate(), 800);
    return () => window.clearTimeout(timer);
  }, [dirty, text, model, version, save.isPending]); // eslint-disable-line react-hooks/exhaustive-deps

  // Someone else saved this diagram: take their version when you have nothing unsaved.
  useEffect(() => {
    const onRemote = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; version?: number }>).detail;
      if (detail?.id !== id || !detail.version || detail.version <= versionRef.current) return;
      if (dirtyRef.current || save.isPending) return;
      void api
        .diagram(id)
        .then(({ diagram }) => {
          if (dirtyRef.current || diagram.version <= versionRef.current) return;
          epoch.current += 1;
          const parsed = parseDiagram(diagram.source);
          printed.current = diagram.source;
          textRef.current = diagram.source;
          versionRef.current = diagram.version;
          setText(diagram.source);
          setModel(parsed.model);
          setDiagnostics(parsed.diagnostics);
          setVersion(diagram.version);
        })
        .catch(() => undefined);
    };
    window.addEventListener("ensemble:diagram", onRemote);
    return () => window.removeEventListener("ensemble:diagram", onRemote);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function commit(next: DiagramModel) {
    // View only: nothing changes, so nothing saves.
    if (readOnlyRef.current) return;
    if (parseTimer.current != null) {
      window.clearTimeout(parseTimer.current);
      parseTimer.current = null;
    }
    const printedText = printDiagram(next);
    if (!restoring.current && printedText !== textRef.current) {
      undoStack.current.push(textRef.current);
      if (undoStack.current.length > 80) undoStack.current.shift();
      redoStack.current = [];
    }
    printed.current = printedText;
    textRef.current = printedText;
    setModel(next);
    setText(printedText);
    setDiagnostics([]);
    setDirty(true);
  }

  function applyParsed(value: string) {
    if (value === printed.current) return;
    const current = modelRef.current;
    const parsed = parseDiagram(value);
    if (looksLikeMermaid(value) && errorCount(parsed.diagnostics) === 0) {
      const converted = printDiagram(parsed.model);
      printed.current = converted;
      textRef.current = converted;
      setText(converted);
      setModel(current ? mergeLayout(current, parsed.model, converted) : parsed.model);
      setDiagnostics([]);
      setDirty(true);
      toast("Converted the Mermaid flowchart.");
      return;
    }
    setModel(current ? mergeLayout(current, parsed.model, value) : parsed.model);
    setDiagnostics(parsed.diagnostics);
    setDirty(true);
  }

  function onText(value: string, immediate = false) {
    textRef.current = value;
    setText(value);
    if (parseTimer.current != null) {
      window.clearTimeout(parseTimer.current);
      parseTimer.current = null;
    }
    if (immediate) {
      applyParsed(value);
      return;
    }
    parseTimer.current = window.setTimeout(() => {
      parseTimer.current = null;
      applyParsed(textRef.current);
    }, 70);
  }

  async function reorganize(fit?: "vertical" | "horizontal") {
    const current = modelRef.current;
    if (!current) return;
    setBusy(true);
    try {
      commit(await layoutInBackground(current, fit));
      setFitTick((value) => value + 1);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't reorganize the diagram.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  function addShape(shape: ShapeId) {
    const current = modelRef.current;
    if (!current) return;
    const count = Object.keys(current.nodes).length;
    commit(addBlock(current, shape, { x: 80 + (count % 4) * 36, y: 80 + (count % 3) * 28 }));
    setMenu(false);
    setFitTick((value) => value + 1);
  }

  function addNote() {
    const current = modelRef.current;
    if (!current) return;
    commit(addTextBox(current, { x: 120, y: 48 }));
    setFitTick((value) => value + 1);
  }

  function lockSelection() {
    const current = modelRef.current;
    if (!current || !selectedRef.current.nodes.length) return;
    commit(toggleLock(current, selectedRef.current.nodes));
  }

  function removeSelection() {
    const current = modelRef.current;
    const pick = selectedRef.current;
    if (!current || (!pick.nodes.length && !pick.edges.length)) return;
    let next = pick.nodes.length ? removeItems(current, pick.nodes) : current;
    if (pick.edges.length) {
      next = structuredClone(next);
      for (const edgeId of pick.edges) delete next.edges[edgeId];
    }
    commit(next);
    setSelected({ nodes: [], edges: [] });
  }

  async function enterFocus() {
    setMenu(false);
    setFocusExport(false);
    focusRef.current = true;
    setFocus(true);
    const stage = stageRef.current;
    const request = stage?.requestFullscreen?.bind(stage);
    if (!request) return;
    try {
      await request();
    } catch {
      // The fixed stage still covers the editor chrome.
    }
  }

  async function exitFocus() {
    focusRef.current = false;
    setFocus(false);
    setFocusExport(false);
    if (!document.fullscreenElement) return;
    try {
      await document.exitFullscreen();
    } catch {
      // Already left the browser fullscreen.
    }
  }

  function toggleFocus() {
    if (focusRef.current) void exitFocus();
    else void enterFocus();
  }

  useEffect(() => {
    const onChange = () => {
      if (document.fullscreenElement || !focusRef.current) return;
      focusRef.current = false;
      setFocus(false);
      setFocusExport(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    if (!menu && !focusExport) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-diagram-menu]")) return;
      setMenu(false);
      setFocusExport(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu, focusExport]);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startW = textWidthRef.current;
    const move = (ev: PointerEvent) => {
      const next = Math.min(680, Math.max(280, startW + ev.clientX - startX));
      textWidthRef.current = next;
      setTextWidth(next);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  function onSeparatorKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 24 : -24;
    setTextWidth((width) => {
      const next = Math.min(680, Math.max(280, width + delta));
      textWidthRef.current = next;
      return next;
    });
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const undoChord = (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "z";
      const inside = (event.target as HTMLElement | null)?.closest?.("[data-diagram-editor]");
      if (undoChord && inside && !typingTarget(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        const current = textRef.current;
        const source = event.shiftKey ? redoStack.current.pop() : undoStack.current.pop();
        if (source == null) return;
        if (event.shiftKey) undoStack.current.push(current);
        else redoStack.current.push(current);
        restoring.current = true;
        const parsed = parseDiagram(source);
        printed.current = source;
        textRef.current = source;
        setText(source);
        setModel(parsed.model);
        setDiagnostics(parsed.diagnostics);
        setDirty(true);
        restoring.current = false;
        return;
      }
      if (typingTarget(event.target)) return;
      const apple = isApplePlatform();
      const hit = SHORTCUTS.find((binding) => {
        if (binding.scope !== "diagrams" || !binding.mac) return false;
        return eventMatchesChord(event, apple ? binding.mac : binding.other!, apple);
      });
      if (!hit) return;
      if (hit.id === "diagram-focus-exit") {
        if (menuRef.current || focusExportRef.current) {
          event.preventDefault();
          setMenu(false);
          setFocusExport(false);
          return;
        }
        if (!focusRef.current) return;
        event.preventDefault();
        void exitFocus();
        return;
      }
      event.preventDefault();
      if (hit.id === "diagram-format") codeRef.current?.format();
      if (hit.id === "diagram-comment") codeRef.current?.comment();
      if (hit.id === "diagram-reorganize") void reorganize();
      if (hit.id === "diagram-lock") lockSelection();
      if (hit.id === "diagram-text") addNote();
      if (hit.id === "diagram-focus") void toggleFocus();
      if (hit.id === "diagram-delete" || hit.id === "diagram-backspace") removeSelection();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []); // handlers read refs; the listener stays for the life of the editor

  useEffect(() => {
    if (!diagnostics.length) {
      sawProblems.current = false;
      setActiveProblem(null);
      return;
    }
    if (!sawProblems.current) {
      sawProblems.current = true;
      setProblemsOpen(true);
    }
    setActiveProblem((current) => (current != null && diagnostics[current] ? current : null));
  }, [diagnostics]);

  useEffect(() => () => {
    if (parseTimer.current != null) window.clearTimeout(parseTimer.current);
  }, []);

  function jump(index: number) {
    const item = diagnostics[index];
    if (!item) return;
    setActiveProblem(index);
    codeRef.current?.focusLine(item.line, item.from, item.to);
  }

  function applyFix(fix: DiagnosticFix) {
    const view = codeRef.current?.getView();
    if (!view) return;
    const length = view.state.doc.length;
    const from = Math.max(0, Math.min(fix.from, length));
    const to = Math.max(from, Math.min(fix.to, length));
    view.dispatch({ changes: { from, to, insert: fix.insert }, scrollIntoView: true });
    view.focus();
  }

  async function exportAs(kind: DiagramExportKind) {
    if (!model) return;
    setExporting(true);
    try {
      await downloadDiagram(model, kind);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't export the diagram.", { tone: "error" });
    } finally {
      setExporting(false);
    }
  }

  if (roomy === false) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h1 className="text-[22px] font-semibold tracking-tight">Screen too small</h1>
          <p className="mt-2 text-[14px] leading-6 text-muted">
            The diagram editor needs a window at least {MIN_VIEWPORT.width} by {MIN_VIEWPORT.height} pixels. Make this window larger, then come back.
          </p>
          <p className="mt-3 text-[13px] text-faint">
            This window is {typeof window === "undefined" ? "…" : `${window.innerWidth} × ${window.innerHeight}`}.
          </p>
          <Link href="/diagrams" className="btn mt-5">
            Back to diagrams
          </Link>
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div>
          <h1 className="text-[22px] font-semibold">Diagram not available</h1>
          <p className="mt-2 text-[14px] text-muted">{query.error instanceof Error ? query.error.message : "Couldn't open this diagram."}</p>
          <Link href="/diagrams" className="btn mt-5">
            Back to diagrams
          </Link>
        </div>
      </div>
    );
  }

  if (!model || roomy === null) {
    return (
      <div className="p-8">
        <div className="skeleton h-8 w-48" />
        <div className="skeleton mt-4 h-64 w-full" />
      </div>
    );
  }

  const problemCount = diagnostics.length;
  const problemLabel = problemCount === 0 ? "No problems" : problemCount === 1 ? "1 problem" : `${problemCount} problems`;
  const markedId = activeProblem == null ? null : diagnostics[activeProblem]?.target ?? null;
  const exportKinds: DiagramExportKind[] = ["png", "jpg", "pdf", "svg"];
  return (
    <IdeSpace diagram className="flex h-full min-h-0 flex-col">
      {focus ? null : (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
          <input
            value={model.meta.title}
            aria-label="Diagram title"
            placeholder="Untitled diagram"
            className="field min-w-[8rem] flex-1 bg-transparent px-2 py-1 text-[15px] font-semibold"
            onChange={(event) => commit(setTitle(model, event.target.value))}
            readOnly={readOnly}
          />
          <PagePeople kind="diagram" id={id} />
          {readOnly ? <span className="rounded-md border border-line px-1.5 py-0.5 text-2xs text-muted">View only</span> : null}
          {shared ? null : <ShareButton target={{ kind: "diagram", resourceId: id, title: model.meta.title }} />}
          <span className="text-[12px] text-muted">
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Not saved" : "Edits save automatically"}
          </span>
          {readOnly ? null : (
          <>
          <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
          <button type="button" className="btn" disabled={busy} onClick={() => void reorganize()}>
            {busy ? "Reorganizing…" : "Reorganize"}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void reorganize("vertical")}>
            Fit vertically
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void reorganize("horizontal")}>
            Fit horizontally
          </button>
          <button type="button" className="btn" disabled={!selected.nodes.length} onClick={lockSelection}>
            Lock
          </button>
          <button type="button" className="btn" onClick={addNote}>
            Text box
          </button>
          <div className="relative" data-diagram-menu>
            <button type="button" className="btn" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((open) => !open)}>
              Add block
            </button>
            {menu ? (
              <div className="diagram-shape-menu absolute right-0 z-20 mt-1 rounded-xl border border-line-strong bg-panel p-1.5 shadow-pop" role="menu">
                {SHAPES.map((item) => (
                  <button key={item.shape} type="button" role="menuitem" className="diagram-shape-option" onClick={() => addShape(item.shape)}>
                    <ShapeGlyph shape={item.shape} size={26} />
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button type="button" className="btn" title="Alt+Shift+F" onClick={() => void enterFocus()}>
            Canvas only
          </button>
          </>
          )}
          <div className="relative" data-diagram-menu>
            <button type="button" className="btn" aria-expanded={focusExport && !focus} aria-haspopup="menu" disabled={exporting} onClick={() => setFocusExport((open) => !open)}>
              Export
            </button>
            {focusExport && !focus ? (
              <div className="absolute right-0 z-20 mt-1 flex w-28 flex-col rounded-xl border border-line-strong bg-panel p-1 shadow-pop" role="menu">
                {exportKinds.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    className="rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-hover"
                    onClick={() => {
                      setFocusExport(false);
                      void exportAs(kind);
                    }}
                  >
                    {kind.toUpperCase()}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )}
      {focus ? null : <DiagramMore id={id} model={model} onAdopt={adopt} />}
      <div className="flex min-h-0 flex-1">
        {focus ? null : (
          <>
            <div className="flex min-h-0 shrink-0 flex-col border-r border-line" style={{ width: textWidth }}>
              <div className="flex flex-wrap items-center justify-between gap-1 border-b border-line px-2 py-1">
                <span className="px-1 text-[12px] font-medium text-ink">Diagram text</span>
                <ThemeControl />
              </div>
              {codeReady ? (
                <DiagramCode ref={codeRef} value={text} diagnostics={diagnostics} model={model} onChange={(value) => onText(value)} />
              ) : (
                <div className="skeleton min-h-0 flex-1" />
              )}
              {problemsOpen ? (
                <ul id="diagram-problems" className="diagram-problems" aria-label="Problems">
                  {diagnostics.length ? (
                    diagnostics.map((item, index) => (
                      <li key={`${item.line}-${item.from ?? 0}-${index}`} className="flex items-start">
                        <button
                          type="button"
                          className={index === activeProblem ? "diagram-problem is-active" : "diagram-problem"}
                          onClick={() => jump(index)}
                        >
                          <span className={`shrink-0 text-[11px] font-semibold uppercase diagram-problem-${item.severity}`}>
                            {item.severity === "info" ? "Note" : item.severity}
                          </span>
                          <span className="text-[12.5px] leading-5">
                            Line {item.line}. {item.message}
                          </span>
                        </button>
                        {item.fixes?.map((fix) => (
                          <button key={fix.title} type="button" className="diagram-quick-fix" onClick={() => applyFix(fix)}>
                            {fix.title}
                          </button>
                        ))}
                      </li>
                    ))
                  ) : (
                    <li className="px-3 py-2 text-[12.5px] text-muted">No problems in this diagram.</li>
                  )}
                </ul>
              ) : null}
              <button
                type="button"
                className="flex h-6 shrink-0 items-center gap-1 border-t border-line px-2 text-left text-[11.5px] text-muted hover:text-ink"
                aria-expanded={problemsOpen}
                aria-controls="diagram-problems"
                onClick={() => setProblemsOpen((open) => !open)}
              >
                <ChevronRight size={12} className={problemsOpen ? "rotate-90" : ""} />
                {problemLabel}
              </button>
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize text pane"
              aria-valuemin={280}
              aria-valuemax={680}
              aria-valuenow={textWidth}
              tabIndex={0}
              className="diagram-split"
              onPointerDown={startResize}
              onKeyDown={onSeparatorKey}
            />
          </>
        )}
        <div ref={stageRef} className={focus ? "diagram-stage is-focus" : "diagram-stage"}>
          <DiagramCanvas
            ref={canvasRef}
            diagramId={id}
            readOnly={readOnly}
            model={model}
            markedId={markedId}
            fitTick={fitTick}
            onSelection={select}
            onRename={(nodeId, label) => commit(renameItem(model, nodeId, label))}
            onMove={(nodeId, x, y) => commit(moveItem(model, nodeId, x, y))}
            onConnect={(from: { node: string; port: PortName | null }, to: { node: string; port: PortName | null }) => {
              const next = connectBlocks(model, from, to);
              if (next) commit(next);
            }}
          />
          {focus ? (
            <div className="diagram-focus-palette" role="toolbar" aria-label="Blocks">
              {SHAPES.map((item) => (
                <button key={item.shape} type="button" aria-label={`Add ${item.label}`} title={item.label} onClick={() => addShape(item.shape)}>
                  <ShapeGlyph shape={item.shape} size={22} />
                </button>
              ))}
              <button type="button" aria-label="Add text box" title="Text box" onClick={addNote}>
                <Type size={16} />
              </button>
              <button type="button" aria-label="Lock selection" title="Lock" disabled={!selected.nodes.length} onClick={lockSelection}>
                <Lock size={16} />
              </button>
            </div>
          ) : null}
          {focus ? (
            <div className="diagram-focus-bar" role="toolbar" aria-label="Canvas tools">
              <button type="button" className="btn-ghost" aria-label="Zoom out" onClick={() => canvasRef.current?.zoomOut()}>
                −
              </button>
              <button type="button" className="btn-ghost" aria-label="Zoom in" onClick={() => canvasRef.current?.zoomIn()}>
                +
              </button>
              <button type="button" className="btn-ghost" onClick={() => canvasRef.current?.fit()}>
                Fit
              </button>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => void reorganize()}>
                {busy ? "Reorganizing…" : "Reorganize"}
              </button>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => void reorganize("vertical")}>
                Fit vertically
              </button>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => void reorganize("horizontal")}>
                Fit horizontally
              </button>
              <div className="relative" data-diagram-menu>
                <button type="button" className="btn-ghost" aria-expanded={focusExport} aria-haspopup="menu" onClick={() => setFocusExport((open) => !open)}>
                  Export
                </button>
                {focusExport ? (
                  <div className="absolute left-1/2 top-full z-10 mt-2 flex flex-col rounded-xl border border-line-strong bg-panel p-1 shadow-pop" style={{ translate: "-50% 0" }} role="menu">
                    {exportKinds.map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        role="menuitem"
                        className="rounded-lg px-3 py-1.5 text-left text-[13px] hover:bg-hover"
                        disabled={exporting}
                        onClick={() => {
                          setFocusExport(false);
                          void exportAs(kind);
                        }}
                      >
                        {kind.toUpperCase()}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button type="button" className="btn" onClick={() => void exitFocus()}>
                Exit
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </IdeSpace>
  );
}
