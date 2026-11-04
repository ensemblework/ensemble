"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MIN_VIEWPORT,
  addBlock,
  addTextBox,
  alignItems,
  connectBlocks,
  distributeItems,
  edgeBetween,
  errorCount,
  looksLikeMermaid,
  moveItems,
  parseDiagram,
  printDiagram,
  removeItems,
  renameItem,
  resizeItem,
  setColor,
  setEdgeLook,
  setTextStyle,
  setTitle,
  textStyle,
  toggleLock,
  type Diagnostic,
  type DiagnosticFix,
  type DiagramModel,
  type PortName,
  type ShapeId,
} from "@ensemble/block-diagrams";
import { isLocked, layoutOverlaps } from "@ensemble/block-diagrams/layout";
import { SHORTCUTS, eventMatchesChord } from "@ensemble/shared-types";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CloudOff, Download, Eye, LayoutGrid, Lock, LockOpen, Maximize2, Minimize2, MonitorSmartphone, MoveDown, MoveRight, Shapes, Type, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { IdeSpace, ThemeControl } from "@/components/code/ide-theme";
import { useToast } from "@/components/toast";
import { ApiError, api } from "@/lib/api";
import { isApplePlatform } from "@/lib/platform";
import { BrandMorph } from "@/components/motion/brand-morph";
import { DiagramCanvas, ZoomPill, type DiagramCanvasHandle } from "./canvas";
import type { DiagramCodeHandle } from "./diagram-code";
import { DiagramFreshness, DiagramMoreMenu } from "./diagram-more";
import { DiagramExportMenu, EXPORT_KINDS } from "./download-menu";
import { FormatBar, type FormatAction } from "./format-bar";
import { downloadDiagram, type DiagramExportKind } from "./export-image";
import { ShapeGlyph } from "./glyph";
import { layoutInBackground } from "./layout-client";
import { FloatMenu, ToolButton, ToolDivider, shortcutLabel } from "./toolbar";
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
  { shape: "queue", label: "Queue" },
  { shape: "subroutine", label: "Subroutine" },
  { shape: "browser", label: "Web app" },
  { shape: "delay", label: "Delay" },
];

/** One click from the dock. Every shape is in Add block. */
const QUICK_SHAPES: ShapeId[] = ["rectangle", "rounded", "diamond", "circle", "cylinder"];

/** Which floating menu on the canvas is open. One at a time. */
type CanvasMenu = "shapes" | "layout" | "export" | null;

type SaveState = "idle" | "saving" | "saved" | "error";

function SaveStatus({ state }: { state: SaveState }) {
  const text = state === "saving" ? "Saving…" : state === "error" ? "Not saved" : "Saved";
  return (
    <span className="dg-save" data-state={state} role="status" title="Edits save automatically">
      {state === "error" ? <CloudOff size={13} aria-hidden /> : state === "saving" ? <span className="dg-save-dot" aria-hidden /> : <Check size={13} aria-hidden />}
      {text}
    </span>
  );
}

function useRoomy(): { width: number; height: number; ok: boolean } | null {
  const [ok, setOk] = useState<{ width: number; height: number; ok: boolean } | null>(null);
  useEffect(() => {
    const check = () => setOk({ width: window.innerWidth, height: window.innerHeight, ok: window.innerWidth >= MIN_VIEWPORT.width && window.innerHeight >= MIN_VIEWPORT.height });
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
  const roomy = useRoomy();
  const readOnly = roomy?.ok === false || (shared ? shared.role !== "edit" : !access.canEdit);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["diagram", id], queryFn: () => api.diagram(id) });
  const [text, setText] = useState("");
  const [model, setModel] = useState<DiagramModel | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [version, setVersion] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [menu, setMenu] = useState<CanvasMenu>(null);
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
  // A saved layout that has blocks or group frames on top of each other offers a one-click tidy up.
  const [overlapNotice, setOverlapNotice] = useState<"hidden" | "shown" | "dismissed">("hidden");
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
  const menuRef = useRef<CanvasMenu>(null);
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
    if (!missing) {
      if (layoutOverlaps(parsed.model).length) setOverlapNotice("shown");
      return;
    }
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
    setOverlapNotice(layoutOverlaps(parsed.model).length ? "shown" : "hidden");
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
    setMenu(null);
    setFitTick((value) => value + 1);
  }

  function addNote() {
    const current = modelRef.current;
    if (!current) return;
    commit(addTextBox(current, { x: 120, y: 48 }));
    setFitTick((value) => value + 1);
  }

  function format(action: FormatAction) {
    const current = modelRef.current;
    const pick = selectedRef.current;
    if (!current) return;
    if (action.kind === "label") {
      if (pick.edges[0]) canvasRef.current?.editLabel(pick.edges[0]);
      return;
    }
    if (action.kind === "text") commit(setTextStyle(current, pick.nodes, pick.edges, action.patch));
    if (action.kind === "color") commit(setColor(current, pick.nodes, action.color));
    if (action.kind === "line") commit(setEdgeLook(current, pick.edges, action.patch));
    if (action.kind === "align") commit(alignItems(current, pick.nodes, action.mode));
    if (action.kind === "distribute") commit(distributeItems(current, pick.nodes, action.axis));
  }

  /** ⌘B / ⌘I / ⌘U on the canvas: on when any selected text lacks it, off when all have it. */
  function toggleText(key: "bold" | "italic" | "underline") {
    const current = modelRef.current;
    const pick = selectedRef.current;
    if (!current || (!pick.nodes.length && !pick.edges.length)) return;
    const styles = [
      ...pick.nodes.map((nodeId) => current.nodes[nodeId]?.font ?? current.texts[nodeId]?.font),
      ...pick.edges.map((edgeId) => current.edges[edgeId]?.font),
    ].map(textStyle);
    commit(setTextStyle(current, pick.nodes, pick.edges, { [key]: !styles.every((style) => style[key]) }));
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
    setMenu(null);
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
    setMenu(null);
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
      setMenu(null);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-diagram-menu]")) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

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
      // Cmd/Ctrl with + (Shift and =, or the keypad) zooms in, as it does for the page.
      const plus = event.key === "+" && (apple ? event.metaKey : event.ctrlKey) && !event.altKey;
      const hit = SHORTCUTS.find((binding) => {
        if (binding.scope !== "diagrams" || !binding.mac) return false;
        if (binding.id === "diagram-zoom-in" && plus) return true;
        return eventMatchesChord(event, apple ? binding.mac : binding.other!, apple);
      });
      if (!hit) return;
      if (hit.id === "diagram-focus-exit") {
        if (menuRef.current) {
          event.preventDefault();
          const trigger = document.querySelector<HTMLElement>('[data-diagram-menu] [aria-expanded="true"]');
          setMenu(null);
          trigger?.focus({ preventScroll: true });
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
      if (hit.id === "diagram-bold") toggleText("bold");
      if (hit.id === "diagram-italic") toggleText("italic");
      if (hit.id === "diagram-underline") toggleText("underline");
      if (hit.id === "diagram-zoom-in") canvasRef.current?.zoomIn();
      if (hit.id === "diagram-zoom-out") canvasRef.current?.zoomOut();
      if (hit.id === "diagram-zoom-fit") canvasRef.current?.fit();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []); // handlers read refs; the listener stays for the life of the editor

  useEffect(() => {
    if (overlapNotice === "shown" && model && !layoutOverlaps(model).length) setOverlapNotice("hidden");
  }, [model, overlapNotice]);

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

  const title = model.meta.title || "Untitled diagram";
  const zoomOnly = <div className="dg-bottom"><ZoomPill /></div>;

  if (!roomy.ok) {
    return (
      <IdeSpace diagram className="flex h-full min-h-0 flex-col">
        <header className="dg-topbar is-compact">
          <Link href="/diagrams" className="dg-back" aria-label="Back to diagrams">
            <ChevronLeft size={18} aria-hidden />
          </Link>
          <h1 className="dg-topbar-title min-w-0 flex-1 truncate">{title}</h1>
          <button type="button" className="btn-primary dg-primary" disabled={exporting} onClick={() => void exportAs("svg")}>
            <Download size={15} aria-hidden />
            {exporting ? "Downloading…" : "SVG"}
          </button>
        </header>
        <p className="dg-preview-note">
          <MonitorSmartphone size={14} aria-hidden className="shrink-0" />
          <span>
            Preview only. Pan and zoom to look around; editing needs a window of at least {MIN_VIEWPORT.width} × {MIN_VIEWPORT.height} px.
          </span>
        </p>
        <div className="diagram-stage min-h-0 flex-1">
          <DiagramCanvas ref={canvasRef} model={model} readOnly fitTick={fitTick} onSelection={select} onRename={() => undefined} onMove={() => undefined} onConnect={() => undefined} overlay={zoomOnly} />
        </div>
      </IdeSpace>
    );
  }

  const lockShortcut = shortcutLabel("diagram-lock");
  const picked = selected.nodes.filter((nodeId) => model.nodes[nodeId] || model.texts[nodeId] || model.groups[nodeId]);
  const allLocked = picked.length > 0 && picked.every((nodeId) => isLocked(model, nodeId));
  // aria-disabled rather than disabled, so the reason shows on hover and focus.
  const lockLabel = !picked.length ? "Lock in place" : allLocked ? "Unlock the selection" : "Lock the selection";
  const lockHint = picked.length ? lockLabel : "Select blocks, text boxes or groups, then lock them in place";
  const problemCount = diagnostics.length;
  const problemLabel = problemCount === 0 ? "No problems" : problemCount === 1 ? "1 problem" : `${problemCount} problems`;
  const markedId = activeProblem == null ? null : diagnostics[activeProblem]?.target ?? null;
  const toggleMenu = (next: Exclude<CanvasMenu, null>) => setMenu((open) => (open === next ? null : next));

  const dock = readOnly ? null : (
    <div className="dg-float dg-dock" role="toolbar" aria-label="Canvas tools" data-diagram-menu>
      <span className="dg-dock-quick" role="group" aria-label="Shapes">
        {QUICK_SHAPES.map((shape) => {
          const label = SHAPES.find((item) => item.shape === shape)?.label ?? shape;
          return (
            <ToolButton key={shape} label={`Add ${label}`} hint={label} tip="top" onClick={() => addShape(shape)}>
              <ShapeGlyph shape={shape} size={20} />
            </ToolButton>
          );
        })}
      </span>
      <span className="dg-menu-anchor">
        <ToolButton label="Add block" hint="All shapes" tip="top" className="has-chevron" aria-haspopup="menu" aria-expanded={menu === "shapes"} active={menu === "shapes"} onClick={() => toggleMenu("shapes")}>
          <Shapes size={17} aria-hidden />
          <ChevronUp size={12} aria-hidden className="dg-chevron" />
        </ToolButton>
        {menu === "shapes" ? (
          <FloatMenu label="Add block" className="dg-shape-grid">
            {SHAPES.map((item) => (
              <button key={item.shape} type="button" role="menuitem" className="dg-shape-option" onClick={() => addShape(item.shape)}>
                <ShapeGlyph shape={item.shape} size={24} />
                <span>{item.label}</span>
              </button>
            ))}
          </FloatMenu>
        ) : null}
      </span>
      <ToolButton label="Text box" shortcut={shortcutLabel("diagram-text")} tip="top" onClick={addNote}>
        <Type size={17} aria-hidden />
      </ToolButton>
      <ToolDivider />
      <ToolButton
        label={lockLabel}
        hint={lockHint}
        shortcut={lockShortcut}
        tip="top"
        active={allLocked}
        aria-pressed={picked.length ? allLocked : undefined}
        aria-disabled={!picked.length}
        onClick={lockSelection}
      >
        {allLocked ? <Lock size={16} aria-hidden /> : <LockOpen size={16} aria-hidden />}
      </ToolButton>
      <ToolDivider />
      <span className="dg-menu-anchor dg-split">
        <ToolButton label={busy ? "Reorganizing…" : "Reorganize"} hint="Reorganize the layout" shortcut={shortcutLabel("diagram-reorganize")} tip="top" disabled={busy} onClick={() => void reorganize()}>
          {busy ? <BrandMorph size={16} kind="beacon" loader state="loop" /> : <LayoutGrid size={16} aria-hidden />}
        </ToolButton>
        <ToolButton label="Layout direction" tip="top" tipAlign="end" className="is-chevron" disabled={busy} aria-haspopup="menu" aria-expanded={menu === "layout"} active={menu === "layout"} onClick={() => toggleMenu("layout")}>
          <ChevronUp size={13} aria-hidden />
        </ToolButton>
        {menu === "layout" ? (
          <FloatMenu label="Layout" align="end">
            <button type="button" role="menuitem" className="dg-menu-item" onClick={() => { setMenu(null); void reorganize(); }}>
              <LayoutGrid size={15} aria-hidden />
              <span className="dg-menu-text">Reorganize<small>Lay out again; locked blocks stay put</small></span>
              <kbd>{shortcutLabel("diagram-reorganize")}</kbd>
            </button>
            <button type="button" role="menuitem" className="dg-menu-item" onClick={() => { setMenu(null); void reorganize("vertical"); }}>
              <MoveDown size={15} aria-hidden />
              <span className="dg-menu-text">Fit vertically<small>Flow from top to bottom</small></span>
            </button>
            <button type="button" role="menuitem" className="dg-menu-item" onClick={() => { setMenu(null); void reorganize("horizontal"); }}>
              <MoveRight size={15} aria-hidden />
              <span className="dg-menu-text">Fit horizontally<small>Flow from left to right</small></span>
            </button>
          </FloatMenu>
        ) : null}
      </span>
    </div>
  );

  return (
    <IdeSpace diagram className="flex h-full min-h-0 flex-col">
      {focus ? null : (
        <header className="dg-topbar">
          <nav aria-label="Breadcrumb" className="dg-crumbs">
            {shared ? null : (
              <>
                <Link href="/diagrams" className="dg-crumb">Diagrams</Link>
                <ChevronRight size={14} aria-hidden className="dg-crumb-sep" />
              </>
            )}
            <input
              value={model.meta.title}
              aria-label="Diagram title"
              placeholder="Untitled diagram"
              className="dg-title"
              onChange={(event) => commit(setTitle(model, event.target.value))}
              readOnly={readOnly}
            />
          </nav>
          {readOnly ? (
            <span className="dg-badge"><Eye size={13} aria-hidden />View only</span>
          ) : (
            <SaveStatus state={saveState} />
          )}
          <div className="dg-topbar-actions">
            <PagePeople kind="diagram" id={id} />
            {shared ? null : (
              <span className="dg-share">
                <ShareButton target={{ kind: "diagram", resourceId: id, title: model.meta.title }} />
              </span>
            )}
            <ToolButton label="Canvas only" shortcut={shortcutLabel("diagram-focus")} tipAlign="end" onClick={() => void enterFocus()}>
              <Maximize2 size={16} aria-hidden />
            </ToolButton>
            {/* Explain, duplicate and history act on the whole space: not from a shared item or a public link. */}
            {shared ? null : <DiagramMoreMenu id={id} model={model} onAdopt={adopt} />}
            <DiagramExportMenu model={model} exporting={exporting} onExport={(kind) => void exportAs(kind)} />
          </div>
        </header>
      )}
      {focus || shared ? null : <DiagramFreshness id={id} title={title} />}
      <div className="flex min-h-0 flex-1">
        {focus ? null : (
          <>
            <div className="flex min-h-0 shrink-0 flex-col" style={{ width: textWidth }}>
              <div className="dg-pane-head">
                <span className="dg-pane-title">Diagram text</span>
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
                className="dg-problems-toggle"
                data-count={problemCount || undefined}
                aria-expanded={problemsOpen}
                aria-controls="diagram-problems"
                onClick={() => setProblemsOpen((open) => !open)}
              >
                <ChevronRight size={12} aria-hidden className={problemsOpen ? "rotate-90" : ""} />
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
            onMove={(moves) => commit(moveItems(model, moves))}
            onResize={(nodeId, box) => commit(resizeItem(model, nodeId, box))}
            onLabel={(edgeId, label) => commit(setEdgeLook(model, [edgeId], { label }))}
            onBend={(edgeId, bend) => commit(setEdgeLook(model, [edgeId], { bend }))}
            onConnect={(from: { node: string; port: PortName | null }, to: { node: string; port: PortName | null }) => {
              const next = connectBlocks(model, from, to);
              if (next) commit(next);
              else if (edgeBetween(model, from.node, to.node)) toast("These blocks are already connected. Select the line to change it.");
            }}
            overlay={
              <div className="dg-bottom">
                {dock}
                <ZoomPill />
              </div>
            }
          />
          {readOnly ? null : <FormatBar model={model} nodes={selected.nodes} edges={selected.edges} onAction={format} />}
          {overlapNotice === "shown" && !readOnly ? (
            <div className="dg-float dg-overlap" role="status">
              <LayoutGrid size={15} className="shrink-0 text-accent" aria-hidden />
              <span className="min-w-0">Some blocks overlap.</span>
              <button type="button" className="btn-primary dg-overlap-fix" disabled={busy} title="Lay the diagram out again, keeping locked blocks where they are" onClick={() => void reorganize()}>
                {busy ? "Tidying…" : "Tidy up"}
              </button>
              <ToolButton label="Dismiss" tip={false} className="is-small" onClick={() => setOverlapNotice("dismissed")}>
                <X size={14} aria-hidden />
              </ToolButton>
            </div>
          ) : null}
          {focus ? (
            <>
              <div className="dg-float dg-focus-head">
                <span className="dg-focus-name" title={title}>{title}</span>
                {readOnly ? <span className="dg-badge"><Eye size={13} aria-hidden />View only</span> : <SaveStatus state={saveState} />}
              </div>
              <div className="dg-float dg-focus-actions" role="toolbar" aria-label="Canvas only" data-diagram-menu>
                <span className="dg-menu-anchor">
                  <ToolButton label="Export" text tip={false} aria-haspopup="menu" aria-expanded={menu === "export"} active={menu === "export"} disabled={exporting} onClick={() => toggleMenu("export")}>
                    {exporting ? <BrandMorph size={15} kind="beacon" loader state="loop" /> : <Download size={15} aria-hidden />}
                    Export
                    <ChevronDown size={13} aria-hidden className="dg-chevron" />
                  </ToolButton>
                  {menu === "export" ? (
                    <FloatMenu label="Export" side="bottom" align="end">
                      {EXPORT_KINDS.map((kind) => (
                        <button
                          key={kind.id}
                          type="button"
                          role="menuitem"
                          className="dg-menu-item"
                          disabled={exporting}
                          onClick={() => {
                            setMenu(null);
                            void exportAs(kind.id);
                          }}
                        >
                          <kind.icon size={15} aria-hidden />
                          <span className="dg-menu-text">{kind.label}</span>
                        </button>
                      ))}
                    </FloatMenu>
                  ) : null}
                </span>
                <ToolDivider />
                <ToolButton label="Exit canvas only" hint="Leave canvas only" shortcut="Esc" text tipAlign="end" onClick={() => void exitFocus()}>
                  <Minimize2 size={15} aria-hidden />
                  Exit
                </ToolButton>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </IdeSpace>
  );
}
