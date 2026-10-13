"use client";

import { BaseEdge, EdgeLabelRenderer, useInternalNode, useReactFlow, useStoreApi, type Edge, type EdgeProps, type InternalNode } from "@xyflow/react";
import { LABEL_SIZE, bendFromPoint, edgeEnds, edgeRoute, type DiagramEdge, type LayoutBox, type ShapeId } from "@ensemble/block-diagrams";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { fontCss } from "./nodes";

export type DiagramEdgeData = {
  edge: DiagramEdge;
  fromShape: ShapeId;
  toShape: ShapeId;
  readOnly?: boolean;
  /** The label is being typed. */
  editing?: boolean;
  onEdit: () => void;
  onEditEnd: () => void;
  onLabel: (label: string) => void;
  onBend: (bend: number) => void;
};

/** A node's box as it is now, mid-drag or mid-resize included, so the line follows it live. */
function liveBox(node: InternalNode | undefined): LayoutBox | null {
  if (!node) return null;
  const w = node.measured?.width ?? node.width;
  const h = node.measured?.height ?? node.height;
  if (!w || !h) return null;
  return { x: node.internals.positionAbsolute.x, y: node.internals.positionAbsolute.y, w, h };
}

/**
 * A line between two blocks, drawn from the same route as the SVG export. Its ends follow the
 * blocks as they move. Selected, its middle (the label, or a dot) drags to bend it; double-click
 * the line or its label to type a label.
 */
export function DiagramEdgeView({ id, source, target, selected, data }: EdgeProps<Edge<DiagramEdgeData>>) {
  const from = liveBox(useInternalNode(source));
  const to = liveBox(useInternalNode(target));
  const flow = useReactFlow();
  const store = useStoreApi();
  const [live, setLive] = useState<number | null>(null);
  const [draft, setDraft] = useState(data?.edge.label ?? "");
  const endsRef = useRef<ReturnType<typeof edgeEnds> | null>(null);
  const label = data?.edge.label ?? "";
  useEffect(() => setDraft(label), [label, data?.editing]);
  // Keep the dragged bend on screen until the model has it, so the line does not flash back.
  useEffect(() => {
    if (live !== null && (data?.edge.bend ?? 0) === live) setLive(null);
  }, [data?.edge.bend, live]);
  if (!data || !from || !to) return null;
  const edge = data.edge;
  const ends = edgeEnds({ shape: data.fromShape, box: from, port: edge.from.port }, { shape: data.toShape, box: to, port: edge.to.port });
  endsRef.current = ends;
  const route = edgeRoute({ ...ends, curve: edge.curve, bend: live ?? edge.bend, width: edge.width, head: edge.head, arrows: edge.arrow });
  const color = selected ? "var(--accent)" : "var(--diagram-line)";
  const dash = edge.line === "dashed" ? `${route.width * 3.5} ${route.width * 2.2}` : undefined;
  const canBend = selected && !data.readOnly && route.bendable;

  const commitLabel = () => {
    const next = draft.trim();
    if (next !== label) data.onLabel(next);
    data.onEditEnd();
  };

  const press = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || data.editing) return;
    event.stopPropagation();
    if (!selected) {
      store.getState().addSelectedEdges([id]);
      return;
    }
    if (!canBend) return;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    let value: number | null = null;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      moved = true;
      const point = flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      const current = endsRef.current;
      if (!current) return;
      value = bendFromPoint({ ...current, curve: edge.curve }, point);
      setLive(value);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      if (moved && value !== null && value !== (edge.bend ?? 0)) data.onBend(value);
      else setLive(null);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const showPill = Boolean(label) || data.editing;
  return (
    <>
      <BaseEdge id={id} path={route.d} interactionWidth={18} style={{ stroke: color, strokeWidth: route.width, strokeDasharray: dash, strokeLinecap: "round", strokeLinejoin: "round", fill: "none" }} />
      {route.heads.map((head) => (
        <path key={head} d={head} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />
      ))}
      {showPill || canBend ? (
        <EdgeLabelRenderer>
          <div
            className={[
              "nodrag nopan",
              showPill ? "diagram-edge-label" : "diagram-bend-handle",
              selected ? "is-selected" : "",
              canBend ? "can-bend" : "",
            ].filter(Boolean).join(" ")}
            style={{
              transform: `translate(-50%, -50%) translate(${route.label.x}px, ${route.label.y}px)`,
              ...(showPill ? fontCss(edge.font, LABEL_SIZE.edge, 600) : {}),
            }}
            title={canBend ? "Drag to bend the line. Double-click to edit its label." : undefined}
            onPointerDown={press}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (!data.readOnly) data.onEdit();
            }}
          >
            {data.editing ? (
              <input
                autoFocus
                className="diagram-edge-input"
                value={draft}
                size={Math.max(4, draft.length + 1)}
                aria-label="Line label"
                placeholder="Label"
                style={{ font: "inherit", textDecoration: "inherit" }}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitLabel}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitLabel();
                  }
                  if (event.key === "Escape") {
                    setDraft(label);
                    data.onEditEnd();
                  }
                }}
              />
            ) : (
              label || null
            )}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
