"use client";

import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ConnectionMode,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import {
  PORTS,
  closestPorts,
  nodeSize,
  textSize,
  type DiagramModel,
  type PortName,
} from "@ensemble/block-diagrams";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import "@xyflow/react/dist/style.css";
import { GroupNode, ShapeNode, TextNode, type GroupNodeData, type ShapeNodeData, type TextNodeData } from "./nodes";

const nodeTypes = { shape: ShapeNode, text: TextNode, frame: GroupNode };

function isPort(value: string | null | undefined): value is PortName {
  return Boolean(value && (PORTS as readonly string[]).includes(value));
}

function toFlow(model: DiagramModel, onRename: (id: string, label: string) => void, markedId: string | null): { nodes: Node[]; edges: Edge[] } {
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
      style: { width: box.w, height: box.h, pointerEvents: "none" },
      data: { label: group.label, width: box.w, height: box.h, problem: id === markedId } satisfies GroupNodeData,
    });
  }
  for (const [id, node] of Object.entries(model.nodes)) {
    const size = place(id, nodeSize(node.shape, node.label));
    nodes.push({
      id,
      type: "shape",
      position: { x: size.x, y: size.y },
      width: size.w,
      height: size.h,
      zIndex: 1,
      draggable: !node.locked,
      style: { width: size.w, height: size.h },
      data: {
        label: node.label,
        shape: node.shape,
        color: node.color,
        locked: node.locked,
        width: size.w,
        height: size.h,
        onRename: (label) => onRename(id, label),
        problem: id === markedId,
      } satisfies ShapeNodeData,
    });
  }
  for (const [id, text] of Object.entries(model.texts)) {
    const size = place(id, textSize(text.text));
    nodes.push({
      id,
      type: "text",
      position: { x: size.x, y: size.y },
      width: size.w,
      height: size.h,
      zIndex: 2,
      draggable: !text.locked,
      style: { width: size.w, height: size.h },
      data: {
        text: text.text,
        locked: text.locked,
        width: size.w,
        height: size.h,
        onRename: (label) => onRename(id, label),
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
    const picked = closestPorts(
      { shape: from.shape, x: fromBox.x, y: fromBox.y, w: fromBox.w, h: fromBox.h },
      { shape: to.shape, x: toBox.x, y: toBox.y, w: toBox.w, h: toBox.h },
    );
    return [
      {
        id,
        source: edge.from.node,
        target: edge.to.node,
        sourceHandle: edge.from.port ?? picked.from,
        targetHandle: edge.to.port ?? picked.to,
        type: edge.curve === "curved" ? "default" : edge.curve === "elbow" ? "smoothstep" : "straight",
        pathOptions: edge.curve === "elbow" ? { borderRadius: 8 } : undefined,
        label: edge.label || undefined,
        markerEnd: edge.arrow.end === "arrow" ? { type: MarkerType.ArrowClosed, color: "var(--diagram-line)", width: 16, height: 16, markerUnits: "userSpaceOnUse", strokeWidth: 0 } : undefined,
        markerStart: edge.arrow.start === "arrow" ? { type: MarkerType.ArrowClosed, color: "var(--diagram-line)", width: 16, height: 16, markerUnits: "userSpaceOnUse", strokeWidth: 0 } : undefined,
        style: { stroke: "var(--diagram-line)", strokeWidth: 1.35, strokeDasharray: edge.line === "dashed" ? "5 3" : undefined },
        labelStyle: { fill: "var(--diagram-line)", fontSize: 10, fontWeight: 600 },
        labelBgStyle: { fill: "var(--diagram-paper)", fillOpacity: 0.96 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 8,
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

function Surface({
  model,
  fitTick,
  onMove,
  onConnect,
  onRename,
  onSelection,
  markedId,
}: {
  model: DiagramModel;
  fitTick: number;
  markedId: string | null;
  onMove: (id: string, x: number, y: number) => void;
  onConnect: (connection: Connection) => void;
  onRename: (id: string, label: string) => void;
  onSelection: (selection: { nodes: string[]; edges: string[] }) => void;
}) {
  const renameRef = useRef(onRename);
  renameRef.current = onRename;
  const built = useMemo(
    () => toFlow(model, (id, label) => renameRef.current(id, label), markedId),
    [model, markedId],
  );
  const [nodes, setNodes] = useState<Node[]>(built.nodes);
  const [edges, setEdges] = useState<Edge[]>(built.edges);
  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
  }, [built]);
  const selectionRef = useRef(onSelection);
  selectionRef.current = onSelection;
  const handleSelection = useCallback((params: OnSelectionChangeParams) => {
    selectionRef.current({
      nodes: params.nodes.map((node) => node.id),
      edges: params.edges.map((edge) => edge.id),
    });
  }, []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={(changes: NodeChange[]) => setNodes((current) => applyNodeChanges(changes, current))}
      onNodeDragStop={(_event, node) => {
        onMove(node.id, node.position.x, node.position.y);
      }}
      onConnect={onConnect}
      onSelectionChange={handleSelection}
      isValidConnection={(connection) => connection.source !== connection.target}
      connectionMode={ConnectionMode.Loose}
      connectionLineType={ConnectionLineType.Straight}
      connectionLineStyle={{ stroke: "var(--diagram-line)", strokeWidth: 1.35 }}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1.4 }}
      minZoom={0.25}
      maxZoom={2}
      proOptions={{ hideAttribution: false }}
      deleteKeyCode={null}
      className="diagram-flow"
      tabIndex={0}
    >
      <Fit tick={fitTick} />
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.15} color="var(--diagram-dot)" />
    </ReactFlow>
  );
}

export type DiagramCanvasHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
};

function ZoomApi({ apiRef }: { apiRef: Ref<DiagramCanvasHandle> }) {
  const flow = useReactFlow();
  useImperativeHandle(apiRef, () => ({
    zoomIn: () => void flow.zoomIn({ duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 140 }),
    zoomOut: () => void flow.zoomOut({ duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 140 }),
    fit: () => void flow.fitView({ padding: 0.25, maxZoom: 1.4, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180 }),
  }), [flow]);
  return null;
}

export const DiagramCanvas = forwardRef<DiagramCanvasHandle, {
  model: DiagramModel;
  fitTick: number;
  onMove: (id: string, x: number, y: number) => void;
  onConnect: (from: { node: string; port: PortName | null }, to: { node: string; port: PortName | null }) => void;
  onRename: (id: string, label: string) => void;
  onSelection: (selection: { nodes: string[]; edges: string[] }) => void;
  markedId?: string | null;
}>(function DiagramCanvas(props, ref) {
  return (
    <ReactFlowProvider>
      <ZoomApi apiRef={ref} />
      <Surface
        model={props.model}
        fitTick={props.fitTick}
        onRename={props.onRename}
        onSelection={props.onSelection}
        markedId={props.markedId ?? null}
        onMove={props.onMove}
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
