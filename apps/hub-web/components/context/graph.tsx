"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Maximize2, Minimize2, Minus, Plus, RefreshCw, RotateCcw, Scan } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GraphEdge, type GraphNode } from "@/lib/api";
import { placeAnchoredPanel } from "@/lib/place-layer";
import { plural } from "@/lib/format";
import { layoutGraph, partitionGraph } from "@/lib/graph-layout";
import {
  directNeighbourIds,
  eligibleLabelIds,
  filterByNodeType,
  fitGraphView,
  footprintFor,
  labelPriority,
  measureLabelBox,
  nodeDegree,
  shapeFor,
  truncateLabel,
  visibleLabelIds,
  type Box,
  type GraphDebug,
  type NodeShape,
} from "@/lib/graph-readability";
import { usePersistentState } from "@/lib/prefs";
import { usePeek } from "../shell/peek";
import { AskEnsemble } from "../ensemble/ask-button";
import { useModuleOn } from "@/lib/use-module";
import { Held } from "@/components/motion/held";
import { GraphSkeleton } from "@/components/motion/skeletons";
import { Empty, cx } from "../ui";

const KINDS: Array<{ kind: string; label: string }> = [
  { kind: "people", label: "People" },
  { kind: "project", label: "Projects" },
  { kind: "repo", label: "Repos" },
  { kind: "task", label: "Tasks" },
  { kind: "deliverable", label: "Deliverables" },
  { kind: "skill", label: "Skills" },
  { kind: "note", label: "Notes" },
  { kind: "diagram", label: "Diagrams" },
  { kind: "plot", label: "Plots" },
  { kind: "artifact", label: "Artifacts" },
];

type Pin = { x: number; y: number };
type View = { x: number; y: number; zoom: number };

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

const COMPACT_CAP = 36;
// The camera fit and every manual zoom share this floor, so zooming out never jumps inward.
const MIN_ZOOM = 0.04;
const EMPTY_NODES: GraphNode[] = [];
const EMPTY_EDGES: GraphEdge[] = [];

/** Highest-degree node, then its neighbours, filled out to `cap`. The rest is "+N more". */
function hubNeighbourhood(nodes: GraphNode[], edges: GraphEdge[], cap: number): { ids: Set<string>; more: number } {
  if (nodes.length <= cap) return { ids: new Set(nodes.map((node) => node.id)), more: 0 };
  const degree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const known = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    const forward = adj.get(edge.source) ?? [];
    forward.push(edge.target);
    adj.set(edge.source, forward);
    const back = adj.get(edge.target) ?? [];
    back.push(edge.source);
    adj.set(edge.target, back);
  }
  const ranked = [...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.label.localeCompare(b.label));
  const keep = new Set<string>();
  const queue: string[] = [];
  const seed = ranked[0];
  if (seed) {
    keep.add(seed.id);
    queue.push(seed.id);
  }
  while (queue.length && keep.size < cap) {
    const id = queue.shift();
    if (!id) break;
    const next = [...(adj.get(id) ?? [])].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0));
    for (const other of next) {
      if (keep.has(other)) continue;
      keep.add(other);
      queue.push(other);
      if (keep.size >= cap) break;
    }
  }
  for (const node of ranked) {
    if (keep.size >= cap) break;
    keep.add(node.id);
  }
  return { ids: keep, more: nodes.length - keep.size };
}

function neighbourhood(focus: string, edges: GraphEdge[], depth = 2): Set<string> {
  const keep = new Set([focus]);
  let frontier = [focus];
  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const edge of edges) {
      for (const [from, to] of [
        [edge.source, edge.target],
        [edge.target, edge.source],
      ] as const) {
        if (frontier.includes(from) && !keep.has(to)) {
          keep.add(to);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return keep;
}

function markerRadius(kind: string, compact: boolean): number {
  if (compact) return 6;
  return kind === "people" || kind === "project" ? 11 : 7;
}

function layout(nodes: GraphNode[], edges: GraphEdge[], pins: Record<string, Pin>, compact = false): Map<string, Pin> {
  const radii = new Map(nodes.map((node) => [node.id, markerRadius(node.kind, compact)]));
  return layoutGraph(nodes, edges, pins, {
    fontSize: compact ? 11 : 12,
    maxLabelChars: compact ? 16 : 22,
    radii,
  });
}

function worldBoxes(nodes: GraphNode[], pos: Map<string, Pin>, compact: boolean): Box[] {
  const fontSize = compact ? 11 : 12;
  const maxChars = compact ? 16 : 22;
  const boxes: Box[] = [];
  for (const node of nodes) {
    const point = pos.get(node.id);
    if (!point) continue;
    const foot = footprintFor(measureLabelBox(node.label, { fontSize, maxChars }), markerRadius(node.kind, compact), 8);
    boxes.push({
      x: point.x - foot.left,
      y: point.y - foot.top,
      width: foot.left + foot.right,
      height: foot.top + foot.bottom,
    });
  }
  return boxes;
}

function fit(nodes: GraphNode[], pos: Map<string, Pin>, width: number, height: number, compact = false): View {
  return fitGraphView(worldBoxes(nodes, pos, compact), { width, height }, {
    maxZoom: compact ? 1.05 : 1.15,
    minZoom: MIN_ZOOM,
    pad: compact ? 12 : 28,
  });
}

function traceShape(ctx: CanvasRenderingContext2D, shape: NodeShape, x: number, y: number, radius: number) {
  ctx.beginPath();
  if (shape === "square" || shape === "round") {
    const r = shape === "round" ? radius * 0.45 : radius * 0.2;
    ctx.roundRect(x - radius, y - radius, radius * 2, radius * 2, r);
    return;
  }
  if (shape === "diamond") {
    ctx.moveTo(x, y - radius);
    ctx.lineTo(x + radius, y);
    ctx.lineTo(x, y + radius);
    ctx.lineTo(x - radius, y);
    ctx.closePath();
    return;
  }
  if (shape === "triangle") {
    ctx.moveTo(x, y - radius);
    ctx.lineTo(x + radius, y + radius * 0.85);
    ctx.lineTo(x - radius, y + radius * 0.85);
    ctx.closePath();
    return;
  }
  if (shape === "hex") {
    for (let step = 0; step < 6; step += 1) {
      const angle = Math.PI / 6 + (step * Math.PI) / 3;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (step === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    return;
  }
  ctx.arc(x, y, radius, 0, Math.PI * 2);
}

function publishDebug(value: GraphDebug) {
  if (process.env.NODE_ENV === "production") return;
  window.__ensembleGraphDebug = value;
}

export function GraphTab({ compact = false }: { compact?: boolean }) {
  const diagramsOn = useModuleOn("diagrams");
  const plotsOn = useModuleOn("plots");
  const kinds = KINDS.filter((column) => (column.kind !== "diagram" || diagramsOn) && (column.kind !== "plot" || plotsOn));
  const client = useQueryClient();
  const router = useRouter();
  const peek = usePeek();
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const graph = useQuery({ queryKey: ["graph", includeCompleted], queryFn: () => api.graph(includeCompleted) });
  const [hidden, setHidden] = usePersistentState<string[]>("ensemble.graph.hidden", []);
  const [pins, setPins] = usePersistentState<Record<string, Pin>>("ensemble.graph.pins", {});
  const [focusKind, setFocusKind] = useState<"project" | "people">("project");
  const [focus, setFocus] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [tools, setTools] = useState(false);
  const [toolsBox, setToolsBox] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const toolsRef = useRef<HTMLButtonElement>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [cited, setCited] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const citedRef = useRef<Set<string>>(new Set());
  citedRef.current = new Set(cited);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const [view, setView] = useState<View>({ x: 20, y: 20, zoom: 1 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelListRef = useRef<HTMLUListElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const hover = useRef<string | null>(null);
  const drag = useRef<{ mode: "node" | "pan"; id?: string; x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const live = useRef<Pin | null>(null);
  const moveRaf = useRef(0);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const labelById = useRef(new Map<string, string>());
  const settledRef = useRef(false);
  const labelPick = useRef<{ key: string; ids: Set<string>; at: number } | null>(null);
  const lastClick = useRef<{ id: string; at: number } | null>(null);
  const [devGraph, setDevGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);

  const apiNodes = graph.data?.nodes ?? EMPTY_NODES;
  const apiEdges = graph.data?.edges ?? EMPTY_EDGES;
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    let liveQuery = true;
    void import("@/lib/graph-fixture").then((mod) => {
      if (!liveQuery) return;
      const query = mod.readGraphDevQuery(window.location.search);
      if (query.scale <= 1 && !query.forceSeed) {
        setDevGraph(null);
        return;
      }
      if (graph.isLoading && !query.forceSeed) return;
      setDevGraph(mod.presentDevGraph(apiNodes, apiEdges, query.scale, query.forceSeed));
    });
    return () => {
      liveQuery = false;
    };
  }, [graph.isLoading, graph.data, apiNodes, apiEdges]);

  const nodes = devGraph?.nodes ?? apiNodes;
  const edges = devGraph?.edges ?? apiEdges;
  const scoped = useMemo(() => {
    const kept = focus ? neighbourhood(focus, edges) : null;
    return filterByNodeType(nodes, hidden).filter((node) => !kept || kept.has(node.id));
  }, [nodes, edges, hidden, focus]);
  const parts = useMemo(() => partitionGraph(scoped, edges), [scoped, edges]);
  const unlinked = focus || parts.linked.length === 0 ? 0 : parts.isolated.length;
  const linked = useMemo(() => (focus || parts.linked.length === 0 ? scoped : parts.linked), [focus, parts, scoped]);
  const compactPick = useMemo(() => (compact && !focus ? hubNeighbourhood(linked, edges, COMPACT_CAP) : null), [compact, focus, linked, edges]);
  const visible = useMemo(() => (compactPick ? linked.filter((node) => compactPick.ids.has(node.id)) : linked), [linked, compactPick]);
  labelById.current = new Map(visible.map((node) => [node.id, node.label]));
  const moreNodes = compactPick?.more ?? 0;
  const positions = useMemo(() => layout(visible, edges, pins, compact), [visible, edges, pins, compact]);
  const idsKey = visible.map((node) => node.id).join("\0");

  useEffect(() => {
    if (selected && !visible.some((node) => node.id === selected)) setSelected(null);
  }, [selected, visible]);

  const open = (node: GraphNode) => {
    if (node.kind === "task") peek.open(node.id, "task");
    else if (node.kind === "project") peek.open(node.id, "project");
    else if (node.kind === "people") router.push(`/context?tab=people&search=${encodeURIComponent(node.label)}`);
    else if (node.kind === "repo") router.push("/context?tab=repos");
    else if (node.kind === "skill") router.push(`/skills?skill=${node.id}`);
    else if (node.kind === "deliverable") peek.open(node.id, "deliverable");
    else if (node.kind === "diagram") router.push(`/diagrams/${node.id}`);
    else if (node.kind === "plot") router.push(`/plots/${node.id}`);
  };

  const draw = () => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.max(1, Math.floor(width * dpr));
    const bh = Math.max(1, Math.floor(height * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const styles = getComputedStyle(document.documentElement);
    const ink = styles.getPropertyValue("--ink").trim() || "#f3eee6";
    const muted = styles.getPropertyValue("--muted").trim() || "#b7ae9f";
    const accent = styles.getPropertyValue("--accent").trim() || styles.getPropertyValue("--muted").trim() || "#8a8276";
    const edgeColor = styles.getPropertyValue("--edge").trim() || "rgba(243,238,230,0.35)";
    const font = getComputedStyle(document.body).fontFamily;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const v = viewRef.current;
    const pos = new Map(positions);
    if (drag.current?.mode === "node" && drag.current.id && live.current) pos.set(drag.current.id, live.current);
    const hov = hover.current;
    const focusId = selectedRef.current;
    const related = focusId ? directNeighbourIds(focusId, edges) : hov ? directNeighbourIds(hov, edges) : null;
    const dragging = Boolean(drag.current);
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.scale(v.zoom, v.zoom);
    for (const edge of edges) {
      const a = pos.get(edge.source);
      const b = pos.get(edge.target);
      if (!a || !b) continue;
      const citedNow = citedRef.current;
      const inFocus = Boolean(related && related.has(edge.source) && related.has(edge.target));
      const lit = inFocus || (citedNow.has(edge.source) && citedNow.has(edge.target));
      const dim = Boolean(related && !inFocus);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const trim = compact ? 8 : 16;
      const ax = a.x + (dx / len) * trim;
      const ay = a.y + (dy / len) * trim;
      const bx = b.x - (dx / len) * trim;
      const by = b.y - (dy / len) * trim;
      const bend = (hash(edge.source + edge.target) % 2 === 0 ? 1 : -1) * 10;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo((ax + bx) / 2 + (-dy / len) * bend, (ay + by) / 2 + (dx / len) * bend, bx, by);
      ctx.strokeStyle = lit ? accent : edgeColor;
      ctx.globalAlpha = dim ? 0.12 : lit ? 1 : 0.42;
      ctx.lineWidth = lit ? 2.2 : 1.15;
      ctx.setLineDash(edge.kind === "mention" ? [3, 4] : []);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const nodeScreen: GraphDebug["nodes"] = [];
    const origin = canvas.getBoundingClientRect();
    for (const node of visible) {
      const p = pos.get(node.id);
      if (!p) continue;
      const lit = !related || related.has(node.id);
      const keyNode = !compact && (node.kind === "people" || node.kind === "project");
      const hot = node.id === hov || node.id === focusId;
      const color = styles.getPropertyValue(`--kind-${node.kind}`).trim() || accent;
      const radius = compact ? (hot ? 7.5 : 5.5) : keyNode ? (hot ? 13 : 11) : hot ? 9 : 7;
      const halo = compact ? 20 : keyNode ? 28 : 18;
      ctx.globalAlpha = lit ? (keyNode ? 0.34 : 0.22) : 0.08;
      ctx.beginPath();
      ctx.arc(p.x, p.y, halo, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = lit ? 1 : 0.22;
      traceShape(ctx, shapeFor(node.kind), p.x, p.y, radius);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = keyNode ? 2.5 : 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      if (hot || citedRef.current.has(node.id)) {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + 5, 0, Math.PI * 2);
        ctx.strokeStyle = accent;
        ctx.lineWidth = node.id === focusId ? 2.6 : 2;
        ctx.stroke();
      }
      const sx = p.x * v.zoom + v.x;
      const sy = p.y * v.zoom + v.y;
      const screenR = radius * v.zoom;
      nodeScreen.push({
        id: node.id,
        x: origin.left + sx - screenR,
        y: origin.top + sy - screenR,
        width: screenR * 2,
        height: screenR * 2,
      });
    }
    ctx.restore();
    const chip = styles.getPropertyValue("--bg").trim() || "#141210";
    const size = Math.max(11, Math.min(13, 12 * v.zoom));
    ctx.font = `500 ${size}px ${font}`;
    ctx.textBaseline = "middle";
    const degree = nodeDegree(visible.map((node) => node.id), edges);
    const hoverSet = hov ? directNeighbourIds(hov, edges) : null;
    const focusSet = focusId ? directNeighbourIds(focusId, edges) : null;
    const candidates = visible.map((node) => ({
      id: node.id,
      kind: node.kind,
      degree: degree.get(node.id) ?? 0,
      selected: node.id === focusId,
      hovered: node.id === hov,
      neighbor: Boolean((focusSet?.has(node.id) && node.id !== focusId) || (hoverSet?.has(node.id) && node.id !== hov && node.id !== focusId)),
    }));
    const zoomBucket = Math.round(v.zoom * 20) / 20;
    let layoutSig = 0;
    for (const node of visible) {
      const point = pos.get(node.id);
      if (!point) continue;
      layoutSig = (Math.imul(layoutSig, 33) + Math.round(point.x) + Math.imul(Math.round(point.y), 17)) | 0;
    }
    const panBucket = `${Math.round(v.x / 96)}:${Math.round(v.y / 96)}`;
    const stableKey = `${zoomBucket}|${panBucket}|${focusId ?? ""}|${hov ?? ""}|${idsKey}`;
    const pickKey = `${stableKey}|${layoutSig}`;
    const now = performance.now();
    const cachedPick = labelPick.current;
    let showIds: Set<string> | null = null;
    if (cachedPick && cachedPick.key === pickKey) showIds = cachedPick.ids;
    else if (cachedPick && now - cachedPick.at < 48 && cachedPick.key.startsWith(`${stableKey}|`)) showIds = cachedPick.ids;
    const limitFor = (id: string) => (id === hov || id === focusId ? 72 : compact ? 16 : 22);
    const chipFor = (node: GraphNode) => {
      const p = pos.get(node.id);
      if (!p) return null;
      const text = truncateLabel(node.label, limitFor(node.id));
      const tw = ctx.measureText(text).width;
      const sx = p.x * v.zoom + v.x;
      const sy = p.y * v.zoom + v.y;
      const box = { x: sx + 14, y: sy - size * 0.72, w: tw + 10, h: size + 6 };
      if (box.x + box.w > width - 4) box.x = Math.max(4, sx - box.w - 12);
      return { text, box };
    };
    if (!showIds) {
      const allowed = eligibleLabelIds(candidates, v.zoom);
      const measured = new Map<string, Box>();
      for (const id of allowed) {
        const node = visible.find((row) => row.id === id);
        if (!node) continue;
        const chipBox = chipFor(node);
        if (!chipBox) continue;
        if (compact && (chipBox.box.x < 2 || chipBox.box.y < 2 || chipBox.box.x + chipBox.box.w > width - 2 || chipBox.box.y + chipBox.box.h > height - 2)) continue;
        measured.set(id, { x: chipBox.box.x, y: chipBox.box.y, width: chipBox.box.w, height: chipBox.box.h });
      }
      showIds = visibleLabelIds(allowed, measured, 3);
      labelPick.current = { key: pickKey, ids: showIds, at: now };
    }
    const labelDebug: GraphDebug["labels"] = [];
    const ordered = [...candidates].sort((a, b) => labelPriority(a) - labelPriority(b) || a.id.localeCompare(b.id));
    for (const candidate of ordered) {
      const node = visible.find((row) => row.id === candidate.id);
      if (!node) continue;
      const chipBox = chipFor(node);
      if (!chipBox) continue;
      const visibleLabel = Boolean(showIds?.has(node.id));
      labelDebug.push({
        id: node.id,
        text: node.label,
        x: origin.left + chipBox.box.x,
        y: origin.top + chipBox.box.y,
        width: chipBox.box.w,
        height: chipBox.box.h,
        visible: visibleLabel,
      });
      if (!visibleLabel) continue;
      const dim = Boolean(related && !related.has(node.id));
      ctx.globalAlpha = dim ? 0.82 : 1;
      ctx.fillStyle = chip;
      ctx.beginPath();
      ctx.roundRect(chipBox.box.x, chipBox.box.y, chipBox.box.w, chipBox.box.h, 5);
      ctx.fill();
      ctx.globalAlpha = dim ? 0.55 : 1;
      ctx.fillStyle = node.id === hov || node.id === focusId ? ink : muted;
      ctx.fillText(chipBox.text, chipBox.box.x + 5, chipBox.box.y + chipBox.box.h / 2);
    }
    publishDebug({ nodes: nodeScreen, labels: labelDebug, settled: settledRef.current && !dragging });
    if (process.env.NODE_ENV !== "production" && labelListRef.current) {
      const shown = labelDebug.filter((label) => label.visible);
      const marker = shown.map((label) => label.id).join("\0");
      if (labelListRef.current.dataset.marker !== marker) {
        labelListRef.current.dataset.marker = marker;
        labelListRef.current.replaceChildren(
          ...shown.map((label) => {
            const item = document.createElement("li");
            item.dataset.graphLabelId = label.id;
            item.textContent = label.text;
            return item;
          }),
        );
      }
    }
    let sample: { x: number; y: number } | null = null;
    let sampleD = Infinity;
    for (const p of pos.values()) {
      const sx = p.x * v.zoom + v.x;
      const sy = p.y * v.zoom + v.y;
      if (sx < 24 || sy < 24 || sx > width - 24 || sy > height - 24) continue;
      const d = (sx - width / 2) ** 2 + (sy - height / 2) ** 2;
      if (d < sampleD) {
        sampleD = d;
        sample = { x: sx, y: sy };
      }
    }
    if (sample) canvas.dataset.sample = `${Math.round(sample.x)},${Math.round(sample.y)}`;
    canvas.dataset.cited = [...citedRef.current].join(",");
  };
  const drawRef = useRef(draw);
  drawRef.current = draw;

  const fitNow = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    settledRef.current = true;
    setView(fit(visible, positions, wrap.clientWidth, wrap.clientHeight, compact));
  };
  const fitRef = useRef(fitNow);
  fitRef.current = fitNow;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !positions.size) {
      settledRef.current = true;
      publishDebug({ nodes: [], labels: [], settled: true });
      return;
    }
    settledRef.current = true;
    setView(fit(visible, positions, wrap.clientWidth, wrap.clientHeight, compact));
    // Fit when the visible set changes. Pins keep the camera where the person left it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, fullscreen, compact]);

  useEffect(() => {
    drawRef.current();
  }, [positions, view, fullscreen, cited, selected, hidden]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let lastW = wrap.clientWidth;
    let lastH = wrap.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextW = wrap.clientWidth;
      const nextH = wrap.clientHeight;
      if (Math.abs(nextW - lastW) < 8 && Math.abs(nextH - lastH) < 8) {
        drawRef.current();
        return;
      }
      lastW = nextW;
      lastH = nextH;
      fitRef.current();
    });
    observer.observe(wrap);
    if (compact) return () => observer.disconnect();
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const current = viewRef.current;
      const zoom = Math.min(2.2, Math.max(MIN_ZOOM, current.zoom * (event.deltaY < 0 ? 1.08 : 0.92)));
      const wx = (mx - current.x) / current.zoom;
      const wy = (my - current.y) / current.zoom;
      setView({ zoom, x: mx - wx * zoom, y: my - wy * zoom });
    };
    const pinch = { current: null as { dist: number; zoom: number } | null };
    const touchDist = (event: TouchEvent) => {
      const a = event.touches[0];
      const b = event.touches[1];
      if (!a || !b) return 0;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      pinch.current = { dist: Math.max(1, touchDist(event)), zoom: viewRef.current.zoom };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !pinch.current) return;
      event.preventDefault();
      const a = event.touches[0];
      const b = event.touches[1];
      if (!a || !b) return;
      const rect = wrap.getBoundingClientRect();
      const mx = (a.clientX + b.clientX) / 2 - rect.left;
      const my = (a.clientY + b.clientY) / 2 - rect.top;
      const current = viewRef.current;
      const zoom = Math.min(2.2, Math.max(MIN_ZOOM, pinch.current.zoom * (touchDist(event) / pinch.current.dist)));
      const wx = (mx - current.x) / current.zoom;
      const wy = (my - current.y) / current.zoom;
      setView({ zoom, x: mx - wx * zoom, y: my - wy * zoom });
    };
    const onTouchEnd = () => {
      pinch.current = null;
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    wrap.addEventListener("touchstart", onTouchStart, { passive: true });
    wrap.addEventListener("touchmove", onTouchMove, { passive: false });
    wrap.addEventListener("touchend", onTouchEnd);
    wrap.addEventListener("touchcancel", onTouchEnd);
    return () => {
      observer.disconnect();
      wrap.removeEventListener("wheel", onWheel);
      wrap.removeEventListener("touchstart", onTouchStart);
      wrap.removeEventListener("touchmove", onTouchMove);
      wrap.removeEventListener("touchend", onTouchEnd);
      wrap.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [fullscreen, graph.isLoading, compact]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (selectedRef.current) {
        setSelected(null);
        return;
      }
      if (fullscreen) setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const worldAt = (event: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (event.clientX - rect.left - v.x) / v.zoom, y: (event.clientY - rect.top - v.y) / v.zoom };
  };
  const hit = (point: Pin) => {
    let best: string | null = null;
    let bestD = compact ? 16 : 22;
    for (const [id, p] of positions) {
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d < bestD) {
        best = id;
        bestD = d;
      }
    }
    return best;
  };

  const onPointerDown = (event: React.PointerEvent) => {
    const point = worldAt(event);
    const id = hit(point);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    if (id) {
      const p = positions.get(id)!;
      drag.current = { mode: "node", id, x: event.clientX, y: event.clientY, ox: p.x, oy: p.y, moved: false };
      live.current = p;
    } else {
      drag.current = { mode: "pan", x: event.clientX, y: event.clientY, ox: viewRef.current.x, oy: viewRef.current.y, moved: false };
    }
  };
  const flushMove = () => {
    moveRaf.current = 0;
    const point = pendingMove.current;
    const canvas = canvasRef.current;
    if (!point || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const v = viewRef.current;
    const world = { x: (point.x - rect.left - v.x) / v.zoom, y: (point.y - rect.top - v.y) / v.zoom };
    const id = hit(world);
    if (id !== hover.current) {
      hover.current = id;
      canvas.style.cursor = id ? "pointer" : "grab";
      const text = id ? (labelById.current.get(id) ?? "") : "";
      canvas.title = text;
      setTip(text ? { x: point.x - rect.left + 14, y: point.y - rect.top + 18, text } : null);
      drawRef.current();
    }
    const current = drag.current;
    if (!current) return;
    const dx = point.x - current.x;
    const dy = point.y - current.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) current.moved = true;
    if (current.mode === "pan") {
      setView({ ...viewRef.current, x: current.ox + dx, y: current.oy + dy });
    } else if (current.id) {
      live.current = { x: current.ox + dx / viewRef.current.zoom, y: current.oy + dy / viewRef.current.zoom };
      drawRef.current();
    }
  };
  const flushRef = useRef(flushMove);
  flushRef.current = flushMove;
  const onPointerMove = (event: React.PointerEvent) => {
    pendingMove.current = { x: event.clientX, y: event.clientY };
    if (moveRaf.current) return;
    moveRaf.current = requestAnimationFrame(() => flushRef.current());
  };
  const onCanvasKey = (event: React.KeyboardEvent) => {
    const v = viewRef.current;
    if (event.key === "ArrowLeft") setView({ ...v, x: v.x + 48 });
    else if (event.key === "ArrowRight") setView({ ...v, x: v.x - 48 });
    else if (event.key === "ArrowUp") setView({ ...v, y: v.y + 48 });
    else if (event.key === "ArrowDown") setView({ ...v, y: v.y - 48 });
    else if (event.key === "+" || event.key === "=") setView({ ...v, zoom: Math.min(2.2, v.zoom + 0.1) });
    else if (event.key === "-" || event.key === "_") setView({ ...v, zoom: Math.max(MIN_ZOOM, v.zoom - 0.1) });
    else if (event.key === "Escape") {
      if (selectedRef.current) setSelected(null);
      else if (fullscreen) setFullscreen(false);
    }
    else return;
    event.preventDefault();
  };
  const onPointerUp = (event: React.PointerEvent) => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    if (current.mode === "node" && current.id) {
      if (current.moved && live.current) setPins({ ...pins, [current.id]: live.current });
      else if (event.shiftKey) {
        const id = current.id;
        setPicked((rows) => (rows.includes(id) ? rows.filter((row) => row !== id) : [...rows, id]));
      } else {
        const node = visible.find((row) => row.id === current.id);
        const now = performance.now();
        if (node && lastClick.current && lastClick.current.id === node.id && now - lastClick.current.at < 350) {
          lastClick.current = null;
          open(node);
        } else if (node) {
          setSelected(node.id);
          lastClick.current = { id: node.id, at: now };
        }
      }
    } else if (!current.moved) {
      setSelected(null);
    }
    settledRef.current = true;
    live.current = null;
    drawRef.current();
  };

  const focusOptions = nodes.filter((node) => node.kind === focusKind);
  const linkCount = edges.filter((edge) => positions.has(edge.source) && positions.has(edge.target)).length;

  return (
    <div className={cx("flex h-full min-h-0 min-w-0 flex-col", fullscreen && "fixed inset-0 z-[60] bg-bg p-4")}>
      {compact ? (
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {kinds.slice(0, 4).map((column) => (
              <span key={column.kind} className="kind-dot" data-shape={shapeFor(column.kind)} title={column.label} style={{ ["--kind" as string]: `var(--kind-${column.kind})` }} />
            ))}
            <span className="truncate text-[11.5px] text-muted" data-graph-more={moreNodes}>
              {plural(visible.length, "node")}
              {moreNodes > 0 ? ` · +${moreNodes} more` : ""}
            </span>
          </div>
          <Link href="/context?tab=graph" className="shrink-0 text-[12px] font-medium text-accent hover:underline">
            Open graph
          </Link>
        </div>
      ) : null}
      {compact ? null : (
      <>
      <div className="graph-toolbar relative mb-2 flex min-w-0 flex-wrap items-center gap-1.5 text-[13px]" aria-label="Graph legend">
        <div className="flex min-w-0 flex-wrap items-center gap-0.5">
          {kinds.map((column) => {
            const on = !hidden.includes(column.kind);
            return (
              <button
                key={column.kind}
                type="button"
                onClick={() => setHidden(on ? [...hidden, column.kind] : hidden.filter((kind) => kind !== column.kind))}
                aria-pressed={on}
                aria-label={column.label}
                className={cx("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-1.5", on ? "text-ink" : "text-faint opacity-50")}
              >
                <span className="kind-dot" data-shape={shapeFor(column.kind)} style={{ ["--kind" as string]: `var(--kind-${column.kind})` }} />
                <span className="graph-kind-label">{column.label}</span>
              </button>
            );
          })}
        </div>
        <span
          className="shrink-0 whitespace-nowrap text-[12px] text-muted"
          title={`${plural(visible.length, "node")}, ${plural(linkCount, "link")}${unlinked ? `, ${unlinked} unlinked hidden` : ""}`}
          aria-label={`${plural(visible.length, "node")}, ${plural(linkCount, "link")}${unlinked ? `, ${unlinked} unlinked hidden` : ""}`}
          data-graph-unlinked={unlinked}
        >
          <span className="graph-count-full">
            {plural(visible.length, "node")} · {plural(linkCount, "link")}
            {unlinked ? ` · ${unlinked} unlinked` : ""}
          </span>
          <span className="graph-count-short">
            {visible.length} · {linkCount}
          </span>
        </span>
        <div className="graph-zoom ml-auto shrink-0 items-center gap-1">
          <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => setView({ ...view, zoom: Math.max(MIN_ZOOM, view.zoom - 0.1) })}>
            <Minus size={13} />
          </button>
          <span className="w-10 text-center text-[12px] text-muted">{Math.round(view.zoom * 100)}%</span>
          <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => setView({ ...view, zoom: Math.min(2.2, view.zoom + 0.1) })}>
            <Plus size={13} />
          </button>
          <button type="button" className="icon-btn" aria-label="Fit graph" onClick={fitNow}>
            <Scan size={13} />
          </button>
        </div>
        <div className="relative ml-auto shrink-0">
          <button
            ref={toolsRef}
            type="button"
            className="btn"
            aria-expanded={tools}
            aria-label="Graph tools"
            onClick={() => {
              if (tools) {
                setTools(false);
                return;
              }
              const rect = toolsRef.current?.getBoundingClientRect();
              const next = rect
                ? placeAnchoredPanel({
                    anchor: rect,
                    panelWidth: 240,
                    panelHeight: 240,
                    viewport: { width: window.innerWidth, height: window.innerHeight },
                    align: "right",
                    gap: 6,
                  })
                : { left: 8, top: 48, maxHeight: 240 };
              setToolsBox({ left: next.left, top: next.top, maxHeight: next.maxHeight });
              setTools(true);
            }}
          >
            More
          </button>
          {tools && toolsBox ? (
            <div
              className="menu-pop menu-fixed overflow-y-auto"
              data-graph-tools
              role="menu"
              style={{ left: toolsBox.left, top: toolsBox.top, maxHeight: toolsBox.maxHeight }}
            >
              {kinds.map((column) => {
                const on = !hidden.includes(column.kind);
                return (
                  <button
                    key={column.kind}
                    type="button"
                    className="menu-item flex items-center gap-2 text-left"
                    aria-pressed={on}
                    onClick={() => setHidden(on ? [...hidden, column.kind] : hidden.filter((kind) => kind !== column.kind))}
                  >
                    <span className="kind-dot" data-shape={shapeFor(column.kind)} style={{ ["--kind" as string]: `var(--kind-${column.kind})` }} />
                    {column.label}
                  </button>
                );
              })}
              <div className="mt-1 flex items-center justify-between gap-2 px-1.5 py-1">
                <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => setView({ ...view, zoom: Math.max(MIN_ZOOM, view.zoom - 0.1) })}>
                  <Minus size={13} />
                </button>
                <button type="button" className="icon-btn" aria-label="Fit graph" onClick={fitNow}>
                  <Scan size={13} />
                </button>
                <span className="text-[12px] text-muted">{Math.round(view.zoom * 100)}%</span>
                <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => setView({ ...view, zoom: Math.min(2.2, view.zoom + 0.1) })}>
                  <Plus size={13} />
                </button>
              </div>
              <label className="menu-item flex items-center gap-2">
                Focus
                <select
                  value={focusKind}
                  onChange={(event) => {
                    setFocusKind(event.target.value as "project" | "people");
                    setFocus("");
                  }}
                  className="field min-w-0 flex-1 py-1"
                  aria-label="Focus kind"
                >
                  <option value="project">Projects</option>
                  <option value="people">People</option>
                </select>
              </label>
              <select value={focus} onChange={(event) => setFocus(event.target.value)} className="field mx-1 mb-1 w-[calc(100%-8px)] py-1" aria-label="Focus">
                <option value="">Whole overview</option>
                {focusOptions.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.label}
                  </option>
                ))}
              </select>
              <label className="menu-item flex items-center gap-2 text-muted">
                <input type="checkbox" checked={includeCompleted} onChange={(event) => setIncludeCompleted(event.target.checked)} />
                All completed
              </label>
              <button
                type="button"
                className="menu-item flex items-center gap-2 text-left"
                onClick={() => {
                  setPins({});
                  const wrap = wrapRef.current;
                  if (wrap) setView(fit(visible, layout(visible, edges, {}, compact), wrap.clientWidth, wrap.clientHeight, compact));
                }}
              >
                <RotateCcw size={12} /> Reset
              </button>
              <div className="px-1 py-1">
                <AskEnsemble
                  surface="graph"
                  anchorKey={picked.length ? `graph:${[...picked].sort().join(",")}` : "graph"}
                  label="Ask Ensemble about the graph"
                  entityIds={picked.length ? picked : undefined}
                  contextLabel={picked.length ? `${picked.length} selected` : "Whole graph"}
                  onCitations={setCited}
                />
              </div>
              <button type="button" className="menu-item flex items-center gap-2 text-left" onClick={() => void client.invalidateQueries({ queryKey: ["graph"] })}>
                <RefreshCw size={12} /> Refresh
              </button>
              <button type="button" className="menu-item flex items-center gap-2 text-left" onClick={() => setFullscreen(!fullscreen)}>
                {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />} {fullscreen ? "Exit" : "Full screen"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
      </>
      )}

      <Held pending={graph.isLoading} fallback={<GraphSkeleton tall={!compact} />}>
        {nodes.length === 0 ? (
        <Empty>The graph fills in as you add people, projects, tasks, and artifacts, or as sources sync.</Empty>
      ) : (
        <div
          ref={wrapRef}
          className={cx("graph-stage tile relative min-h-0 flex-1 overflow-hidden rounded-xl", compact ? "min-h-[96px]" : "min-h-[420px]")}
          style={compact ? undefined : { height: fullscreen ? "calc(100vh - 120px)" : 520 }}
        >
          <canvas
            ref={canvasRef}
            tabIndex={0}
            aria-label="Context graph"
            className="h-full w-full cursor-grab touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onKeyDown={onCanvasKey}
            onPointerUp={onPointerUp}
            onPointerLeave={() => {
              hover.current = null;
              setTip(null);
              drawRef.current();
            }}
          />
          {visible.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-[13px] text-muted">
              Nothing in this view. Turn a type back on in the legend.
            </div>
          ) : null}
          {tip ? (
            <div
              role="tooltip"
              className="pointer-events-none absolute z-10 max-w-[280px] rounded-md border border-line bg-bg px-2 py-1 text-[12px] leading-snug text-ink shadow-md"
              style={{ left: tip.x, top: tip.y }}
            >
              {tip.text}
            </div>
          ) : null}
          <ul className="sr-only">
            {visible.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  data-graph-node-id={node.id}
                  onFocus={() => {
                    hover.current = node.id;
                    drawRef.current();
                  }}
                  onClick={() => open(node)}
                >
                  {node.label}, {node.kind}
                </button>
              </li>
            ))}
          </ul>
          {process.env.NODE_ENV !== "production" ? <ul ref={labelListRef} className="sr-only" data-graph-labels /> : null}
        </div>
      )}
      </Held>
      {compact ? null : (
      <p className="mt-2 text-[12px] text-muted">
        Threads are saved relationships. Dashed threads are @mentions. Click a node to highlight it and its neighbours; double-click to open it. Drag a node to pin it, drag the background to pan, scroll or pinch to zoom, and use Fit to frame the graph. Arrow keys pan, plus and minus zoom. Escape clears the highlight, then leaves full screen.
      </p>
      )}
    </div>
  );
}
