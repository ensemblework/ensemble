"use client";

import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import { LABEL_SIZE, labelMetrics, labelPadding, outlineSize, paintFor, shapeGeometry, textFrame, textStyle, type PortName, type ShapeId, type TextStyle } from "@ensemble/block-diagrams";
import { useEffect, useState, type CSSProperties } from "react";
import { useDiagramTheme } from "./glyph";

export { ShapeGlyph } from "./glyph";

const PORTS: PortName[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

type Sizing = {
  /** The smallest the box may be resized to, so its text still fits. The canvas commits the new box when resizing ends. */
  min: { w: number; h: number };
};

export type ShapeNodeData = Sizing & {
  label: string;
  shape: ShapeId;
  color: string | null;
  font?: TextStyle;
  locked: boolean;
  readOnly?: boolean;
  width: number;
  height: number;
  onRename: (label: string) => void;
  problem?: boolean;
};

export type TextNodeData = Sizing & {
  text: string;
  font?: TextStyle;
  locked: boolean;
  readOnly?: boolean;
  width: number;
  height: number;
  onRename: (label: string) => void;
  problem?: boolean;
};

export type GroupNodeData = {
  label: string;
  width: number;
  height: number;
  problem?: boolean;
};

function side(port: PortName): Position {
  if (port === "e") return Position.Right;
  if (port === "w") return Position.Left;
  if (port === "s" || port === "se" || port === "sw") return Position.Bottom;
  return Position.Top;
}

/** Size, weight, slant and underline of a label, as inline style. */
export function fontCss(font: TextStyle | undefined, base: number, weight: number, lineRatio?: number): CSSProperties {
  const style = textStyle(font);
  const metrics = labelMetrics(font, base);
  return {
    fontSize: metrics.size,
    lineHeight: `${lineRatio ? Math.round(metrics.size * lineRatio * 10) / 10 : metrics.line}px`,
    fontWeight: style.bold ? 700 : weight,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: style.underline ? "underline" : undefined,
  };
}

function Resizer({ data, selected, keepAspectRatio }: { data: Sizing & { locked: boolean; readOnly?: boolean }; selected: boolean; keepAspectRatio?: boolean }) {
  return (
    <NodeResizer
      isVisible={selected && !data.readOnly && !data.locked}
      minWidth={data.min.w}
      minHeight={data.min.h}
      keepAspectRatio={keepAspectRatio}
      lineClassName="diagram-resize-line"
      handleClassName="diagram-resize-handle"
    />
  );
}

export function ShapeNode({ data, selected, width, height }: NodeProps<Node<ShapeNodeData>>) {
  const theme = useDiagramTheme();
  // Live size while the resizer is dragged; the model's size otherwise.
  const w = width || data.width;
  const h = height || data.height;
  const drawn = outlineSize(data.shape, w, h);
  const geometry = shapeGeometry(data.shape, drawn.w, drawn.h);
  const paint = paintFor(data.shape, data.color, theme);
  const metrics = labelMetrics(data.font);
  const lines = Math.max(1, Math.floor(textFrame(data.shape, w, h).h / metrics.line));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.label);
  useEffect(() => setDraft(data.label), [data.label]);
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== data.label) data.onRename(next);
    else setDraft(data.label);
  };
  return (
    <div className={["diagram-shape", selected ? "is-selected" : "", data.problem ? "is-problem" : ""].filter(Boolean).join(" ")} style={{ width: w, height: h }}>
      <Resizer data={data} selected={selected} keepAspectRatio={data.shape === "circle"} />
      <svg width={w} height={h} className="block overflow-visible" aria-hidden>
        <path
          d={geometry.outline}
          fill={geometry.filled ? paint.fill : "none"}
          stroke={selected ? "var(--accent)" : paint.stroke}
          strokeWidth={selected ? 1.75 : 1.35}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {geometry.details ? <path d={geometry.details} fill="none" stroke={paint.stroke} strokeWidth={1.15} strokeLinecap="round" /> : null}
      </svg>
      <div
        className="absolute inset-0 flex items-center justify-center overflow-hidden text-center"
        style={{ padding: labelPadding(data.shape, w, h), color: paint.text, ...fontCss(data.font, LABEL_SIZE.block, 500) }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (!data.readOnly) setEditing(true);
        }}
      >
        {editing ? (
          <input
            autoFocus
            className="nodrag nopan w-full bg-transparent text-center outline-none"
            style={{ font: "inherit", textDecoration: "inherit" }}
            value={draft}
            aria-label="Block label"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
              if (event.key === "Escape") {
                setDraft(data.label);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="diagram-label max-h-full w-full break-words" style={{ WebkitLineClamp: lines }}>
            {data.label}
          </span>
        )}
      </div>
      {data.locked ? <span className="diagram-lock">Locked</span> : null}
      {PORTS.map((port) => {
        const point = geometry.ports[port];
        return (
          <Handle
            key={port}
            id={port}
            type="source"
            position={side(port)}
            className="diagram-port"
            aria-label={`${port} connection`}
            style={{ left: point.x, top: point.y, right: "auto", bottom: "auto", width: 7, height: 7, transform: "translate(-50%, -50%)" }}
          />
        );
      })}
    </div>
  );
}

export function TextNode({ data, selected, width, height }: NodeProps<Node<TextNodeData>>) {
  const w = width || data.width;
  const h = height || data.height;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.text);
  useEffect(() => setDraft(data.text), [data.text]);
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== data.text) data.onRename(next);
    else setDraft(data.text);
  };
  // Text boxes keep the looser 1.6 leading they always had (20 px at 12.5).
  const font = fontCss(data.font, LABEL_SIZE.text, 500, 1.6);
  return (
    <div
      className={["diagram-text", selected ? "is-selected" : "", data.problem ? "is-problem" : ""].filter(Boolean).join(" ")}
      style={{ width: w, height: h }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!data.readOnly) setEditing(true);
      }}
    >
      <Resizer data={data} selected={selected} />
      {editing ? (
        <textarea
          autoFocus
          className="nodrag nopan h-full w-full resize-none bg-transparent text-ink outline-none"
          style={font}
          value={draft}
          aria-label="Text box"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
        />
      ) : (
        <p className="whitespace-pre-wrap break-words text-ink" style={font}>
          {data.text}
        </p>
      )}
      {data.locked ? <span className="diagram-lock">Locked</span> : null}
    </div>
  );
}

export function GroupNode({ data }: NodeProps<Node<GroupNodeData>>) {
  return (
    <div className={data.problem ? "diagram-group is-problem" : "diagram-group"}>
      <span className="diagram-group-label">{data.label}</span>
    </div>
  );
}
