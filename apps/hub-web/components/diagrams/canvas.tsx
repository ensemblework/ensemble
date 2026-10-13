"use client";

import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import {
  PORTS,
  closestPorts,
  minItemSize,
  nodeSize,
  textSize,
  type DiagramModel,
  type LayoutBox,
  type PortName,
} from "@ensemble/block-diagrams";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import "@xyflow/react/dist/style.css";
import { DiagramEdgeView, type DiagramEdgeData } from "./edge";
import { GroupNode, ShapeNode, TextNode, type GroupNodeData, type ShapeNodeData, type TextNodeData } from "./nodes";
import { SNAP_PX, snapMove, snapResize, type Box, type Guide } from "./snap";
import { LiveCursors, useCursorBroadcast } from "../sharing/live-cursors";

const nodeTypes = { shape: ShapeNode, text: TextNode, frame: GroupNode };
const edgeTypes = { diagram: DiagramEdgeView };

function isPort(value: string | null | undefined): value is PortName {
  return Boolean(value && (PORTS as readonly string[]).includes(value));
}

type Handlers = {
  onRename: (id: string, label: string) => void;
  onLabel: (id: string, label: string) => void;
  onBend: (id: string, bend: number) => void;
  onEdit: (id: string | null) => void;
};

function toFlow(model: DiagramModel, handlers: () => Handlers, markedId: string | null, readOnly = false): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {};
  const cursor = { y: 48 };
  const place = (id: string, size: { w: number; h: number }) => {
    const box = model.layout[id];
    if (box) {
      cursor.y = Math.max(cursor.y, box.y + box.h + 56);
      boxes[id] = box;
      return box;
    }
    const next = { x: 48, y: cursor.y, w: size.w, h: size.h };
    cursor.y += size.h + 56;
    boxes[id] = next;
    return next;
  };
  for (const [id, group] of Object.entries(model.groups)) {
    const box = model.layout[id];
    if (!box) continue;
    nodes.push({
      id,
      type: "frame",
      position: { x: box.x, y: box.y },
      width: box.w,
      height: box.h,
      zIndex: -1,
      selectable: false,
      draggable: false,
      style: { pointerEvents: "none" },
      data: { label: group.label, width: box.w, height: box.h, problem: id === markedId } satisfies GroupNodeData,
    });
  }
  for (const [id, node] of Object.entries(model.nodes)) {
    const size = place(id, nodeSize(node.shape, node.label, node.font));
    nodes.push({
      id,
      type: "shape",
      position: { x: size.x, y: size.y },
      width: size.w,
      height: size.h,
      zIndex: 1,
      draggable: !readOnly && !node.locked,
      data: {
        label: node.label,
        shape: node.shape,
        color: node.color,
        font: node.font,
        locked: node.locked,
        readOnly,
        width: size.w,
        height: size.h,
        min: minItemSize(model, id),
        onRename: (label) => handlers().onRename(id, label),
        problem: id === markedId,
      } satisfies ShapeNodeData,
    });
  }
  for (const [id, text] of Object.entries(model.texts)) {
    const size = place(id, textSize(text.text, text.font));
    nodes.push({
      id,
      type: "text",
      position: { x: size.x, y: size.y },
      width: size.w,
      height: size.h,
      zIndex: 2,
      draggable: !readOnly && !text.locked,
      data: {
        text: text.text,
        font: text.font,
        locked: text.locked,
        readOnly,
        width: size.w,
        height: size.h,
        min: minItemSize(model, id, size.w),
        onRename: (label) => handlers().onRename(id, label),
        problem: id === markedId,
      } satisfies TextNodeData,
    });
  }
  const edges: Edge[] = Object.entries(model.edges).flatMap(([id, edge]) => {
    const from = model.nodes[edge.from.node];
    const to = model.nodes[edge.to.node];
    const fromBox = boxes[edge.from.node];
    const toBox = boxes[edge.to.node];
    if (!from || !to || !fromBox || !toBox) return [];
    const picked = closestPorts({ shape: from.shape, ...fromBox }, { shape: to.shape, ...toBox });
    return [
      {
        id,
        type: "diagram",
        source: edge.from.node,
        target: edge.to.node,
        sourceHandle: edge.from.port ?? picked.from,
        targetHandle: edge.to.port ?? picked.to,
        data: {
          edge,
          fromShape: from.shape,
          toShape: to.shape,
          readOnly,
          onEdit: () => handlers().onEdit(id),
          onEditEnd: () => handlers().onEdit(null),
          onLabel: (label) => handlers().onLabel(id, label),
          onBend: (bend) => handlers().onBend(id, bend),
        } satisfies DiagramEdgeData,
      },
    ];
  });
  return { nodes, edges };
}

function Fit({ tick }: { tick: number }) {
  const { fitView } = useReactFlow();
  const fitRef = useRef(fitView);
  fitRef.current = fitView;
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = requestAnimationFrame(() => {
      void fitRef.current({ padding: 0.25, maxZoom: 1.4, duration: reduce ? 0 : 180 });
    });
    return () => cancelAnimationFrame(frame);
  }, [tick]);
  return null;
}

const boxOf = (node: Node): Box => ({ x: node.position.x, y: node.position.y, w: node.width ?? node.measured?.width ?? 0, h: node.height ?? node.measured?.height ?? 0 });

/** Alignment guides and size marks, drawn in flow coordinates one screen pixel thick. */
function Guides({ guides }: { guides: Guide[] }) {
  const zoom = useStore((state) => state.transform[2]);
  if (!guides.length) return null;
  const px = 1 / zoom;
  const reach = 10 * px;
  return (
    <ViewportPortal>
      {guides.flatMap((guide, index) => {
        if (guide.kind === "x") {
          return [<div key={index} className="diagram-guide" style={{ left: guide.at - px / 2, top: guide.from - reach, width: px, height: guide.to - guide.from + reach * 2 }} />];
        }
        if (guide.kind === "y") {
          return [<div key={index} className="diagram-guide" style={{ top: guide.at - px / 2, left: guide.from - reach, height: px, width: guide.to - guide.from + reach * 2 }} />];
        }
        return guide.boxes.map((box, at) =>
          guide.kind === "width" ? (
            <div key={`${index}-${at}`} className="diagram-guide-size" style={{ left: box.x, top: box.y - 7 * px, width: box.w, height: 5 * px, borderWidth: px }} />
          ) : (
            <div key={`${index}-${at}`} className="diagram-guide-size" style={{ left: box.x - 7 * px, top: box.y, width: 5 * px, height: box.h, borderWidth: px }} />
          ),
        );
      })}
    </ViewportPortal>
  );
}

type SurfaceProps = {
  /** Lets the format bar open a line's label editor. */
  editRef: { current: (id: string) => void };
  model: DiagramModel;
  fitTick: number;
  markedId: string | null;
  diagramId?: string;
  readOnly?: boolean;
  onMove: (moves: Array<{ id: string; x: number; y: number }>) => void;
  onResize: (id: string, box: LayoutBox) => void;
  onConnect: (connection: Connection) => void;
  onRename: (id: string, label: string) => void;
  onLabel: (id: string, label: string) => void;
  onBend: (id: string, bend: number) => void;
  onSelection: (selection: { nodes: string[]; edges: string[] }) => void;
};

function Surface(props: SurfaceProps) {
  const { model, fitTick, markedId, diagramId, readOnly = false } = props;
  const [editingEdge, setEditingEdge] = useState<string | null>(null);
  props.editRef.current = setEditingEdge;
  const propsRef = useRef(props);
  propsRef.current = props;
  const handlers = useCallback(
    (): Handlers => ({
      onRename: (id, label) => propsRef.current.onRename(id, label),
      onLabel: (id, label) => propsRef.current.onLabel(id, label),
      onBend: (id, bend) => propsRef.current.onBend(id, bend),
      onEdit: (id) => setEditingEdge(id),
    }),
    [],
  );
  const built = useMemo(() => toFlow(model, handlers, markedId, readOnly), [model, markedId, readOnly, handlers]);
  const [nodes, setNodes] = useState<Node[]>(built.nodes);
  const [edges, setEdges] = useState<Edge[]>(built.edges);
  const [guides, setGuides] = useState<Guide[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const resizing = useRef<Map<string, Box>>(new Map());
  const free = useRef(false);
  const flow = useReactFlow();
  useEffect(() => {
    // Keep what is selected when the model comes back from an edit.
    setNodes((current) => {
      const picked = new Set(current.filter((node) => node.selected).map((node) => node.id));
      return built.nodes.map((node) => (picked.has(node.id) ? { ...node, selected: true } : node));
    });
    setEdges((current) => {
      const picked = new Set(current.filter((edge) => edge.selected).map((edge) => edge.id));
      return built.edges.map((edge) => (picked.has(edge.id) ? { ...edge, selected: true } : edge));
    });
  }, [built]);
  useEffect(() => {
    // Alt held: move and resize freely, without snapping.
    const set = (event: KeyboardEvent) => {
      free.current = event.altKey;
    };
    window.addEventListener("keydown", set);
    window.addEventListener("keyup", set);
    return () => {
      window.removeEventListener("keydown", set);
      window.removeEventListener("keyup", set);
    };
  }, []);
  const selectionRef = useRef(props.onSelection);
  selectionRef.current = props.onSelection;
  const handleSelection = useCallback((params: OnSelectionChangeParams) => {
    selectionRef.current({
      nodes: params.nodes.filter((node) => node.type !== "frame").map((node) => node.id),
      edges: params.edges.map((edge) => edge.id),
    });
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const current = nodesRef.current;
      const byId = new Map(current.map((node) => [node.id, node]));
      const threshold = SNAP_PX / Math.max(0.1, flow.getZoom());
      const snapping = !free.current;
      const others = (skip: Set<string>) =>
        current.filter((node) => node.type !== "frame" && !skip.has(node.id) && !node.hidden).map(boxOf).filter((box) => box.w > 0 && box.h > 0);
      let next = changes;
      let shown: Guide[] | null = null;
      const finished: string[] = [];

      const drags = changes.filter((change): change is Extract<NodeChange, { type: "position" }> => change.type === "position" && Boolean(change.dragging) && Boolean(change.position));
      if (drags.length === 1 && snapping) {
        const change = drags[0]!;
        const node = byId.get(change.id);
        if (node) {
          const box = { ...boxOf(node), x: change.position!.x, y: change.position!.y };
          const snapped = snapMove(box, others(new Set([change.id])), threshold);
          next = next.map((item) => (item === change ? { ...change, position: { x: snapped.x, y: snapped.y } } : item));
          shown = snapped.guides;
        }
      } else if (drags.length) shown = [];
      if (changes.some((change) => change.type === "position" && change.dragging === false)) shown = [];

      for (const change of changes) {
        if (change.type !== "dimensions" || !change.dimensions) continue;
        const node = byId.get(change.id);
        if (!node) continue;
        if (change.resizing) {
          const before = resizing.current.get(change.id) ?? boxOf(node);
          if (!resizing.current.has(change.id)) resizing.current.set(change.id, before);
          const moved = changes.find((item): item is Extract<NodeChange, { type: "position" }> => item.type === "position" && item.id === change.id && Boolean(item.position));
          const box = { x: moved?.position?.x ?? node.position.x, y: moved?.position?.y ?? node.position.y, w: change.dimensions.width, h: change.dimensions.height };
          if (!snapping) {
            shown = [];
            continue;
          }
          const min = (node.data as { min?: { w: number; h: number } }).min ?? { w: 24, h: 24 };
          const snapped = snapResize(before, box, others(new Set([change.id])), threshold, min);
          shown = snapped.guides;
          next = next.map((item) => {
            if (item === change) return { ...change, dimensions: { width: snapped.box.w, height: snapped.box.h } };
            if (item === moved) return { ...moved, position: { x: snapped.box.x, y: snapped.box.y } };
            return item;
          });
        } else if (change.resizing === false && resizing.current.has(change.id)) {
          // The resizer reports its own last size; keep the snapped one the node already has.
          resizing.current.delete(change.id);
          next = next.map((item) => (item === change ? { ...change, dimensions: { width: node.width ?? change.dimensions!.width, height: node.height ?? change.dimensions!.height } } : item));
          finished.push(change.id);
          shown = [];
        }
      }
      if (shown) setGuides(shown);
      const applied = applyNodeChanges(next, current);
      nodesRef.current = applied;
      setNodes(applied);
      for (const id of finished) {
        const node = applied.find((item) => item.id === id);
        if (node) propsRef.current.onResize(id, boxOf(node));
      }
    },
    [flow],
  );

  const cursors = useCursorBroadcast(diagramId ?? "");
  const shownEdges = useMemo(
    () => edges.map((edge) => (edge.id === editingEdge ? { ...edge, data: { ...(edge.data as DiagramEdgeData), editing: true } } : edge)),
    [edges, editingEdge],
  );
  return (
    <ReactFlow
      onMouseMove={diagramId ? cursors.onMouseMove : undefined}
      onMouseLeave={diagramId ? cursors.onMouseLeave : undefined}
      onMoveEnd={diagramId ? cursors.onMoveEnd : undefined}
      nodes={nodes}
      edges={shownEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      onNodesChange={onNodesChange}
      onEdgesChange={(changes: EdgeChange[]) => setEdges((current) => applyEdgeChanges(changes, current))}
      onNodeDragStop={(_event, _node, dragged) => {
        setGuides([]);
        if (readOnly) return;
        const byId = new Map(nodesRef.current.map((node) => [node.id, node]));
        props.onMove(dragged.map((item) => {
          const node = byId.get(item.id) ?? item;
          return { id: item.id, x: Math.round(node.position.x), y: Math.round(node.position.y) };
        }));
      }}
      onEdgeDoubleClick={(_event, edge) => {
        if (!readOnly) setEditingEdge(edge.id);
      }}
      onConnect={readOnly ? undefined : props.onConnect}
      onSelectionChange={handleSelection}
      isValidConnection={(connection) => connection.source !== connection.target}
      connectionMode={ConnectionMode.Loose}
      connectionLineType={ConnectionLineType.Straight}
      connectionLineStyle={{ stroke: "var(--diagram-line)", strokeWidth: 1.5 }}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1.4 }}
      minZoom={0.25}
      maxZoom={2}
      // Double-click edits a label; it does not zoom.
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: false }}
      deleteKeyCode={null}
      className="diagram-flow"
      tabIndex={0}
    >
      <Fit tick={fitTick} />
      <Guides guides={guides} />
      {diagramId ? <LiveCursors diagramId={diagramId} /> : null}
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.15} color="var(--diagram-dot)" />
    </ReactFlow>
  );
}

export type DiagramCanvasHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  /** Open the label editor on a line. */
  editLabel: (edgeId: string) => void;
};

function ZoomApi({ apiRef, editRef }: { apiRef: Ref<DiagramCanvasHandle>; editRef: { current: (id: string) => void } }) {
  const flow = useReactFlow();
  useImperativeHandle(apiRef, () => ({
    editLabel: (edgeId: string) => editRef.current(edgeId),
    zoomIn: () => void flow.zoomIn({ duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 140 }),
    zoomOut: () => void flow.zoomOut({ duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 140 }),
    fit: () => void flow.fitView({ padding: 0.25, maxZoom: 1.4, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180 }),
  }), [flow, editRef]);
  return null;
}

const ignore = () => undefined;

export const DiagramCanvas = forwardRef<DiagramCanvasHandle, {
  model: DiagramModel;
  fitTick: number;
  onMove: (moves: Array<{ id: string; x: number; y: number }>) => void;
  onConnect: (from: { node: string; port: PortName | null }, to: { node: string; port: PortName | null }) => void;
  onRename: (id: string, label: string) => void;
  onSelection: (selection: { nodes: string[]; edges: string[] }) => void;
  onResize?: (id: string, box: LayoutBox) => void;
  onLabel?: (id: string, label: string) => void;
  onBend?: (id: string, bend: number) => void;
  markedId?: string | null;
  /** Set on a saved diagram: live cursors of others on it. */
  diagramId?: string;
  readOnly?: boolean;
}>(function DiagramCanvas(props, ref) {
  const editRef = useRef<(id: string) => void>(ignore);
  return (
    <ReactFlowProvider>
      <ZoomApi apiRef={ref} editRef={editRef} />
      <Surface
        editRef={editRef}
        model={props.model}
        fitTick={props.fitTick}
        onRename={props.onRename}
        onSelection={props.onSelection}
        markedId={props.markedId ?? null}
        diagramId={props.diagramId}
        readOnly={props.readOnly}
        onMove={props.onMove}
        onResize={props.onResize ?? ignore}
        onLabel={props.onLabel ?? ignore}
        onBend={props.onBend ?? ignore}
        onConnect={(connection) => {
          if (!connection.source || !connection.target || connection.source === connection.target) return;
          props.onConnect(
            { node: connection.source, port: isPort(connection.sourceHandle) ? connection.sourceHandle : null },
            { node: connection.target, port: isPort(connection.targetHandle) ? connection.targetHandle : null },
          );
        }}
      />
    </ReactFlowProvider>
  );
});
