"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { labelPadding, outlineSize, paintFor, shapeGeometry, type PortName, type ShapeId } from "@ensemble/block-diagrams";
import { useEffect, useState } from "react";
import { useDiagramTheme } from "./glyph";

export { ShapeGlyph } from "./glyph";

const PORTS: PortName[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

export type ShapeNodeData = {
  label: string;
  shape: ShapeId;
  color: string | null;
  locked: boolean;
  readOnly?: boolean;
  width: number;
  height: number;
  onRename: (label: string) => void;
  problem?: boolean;
};

export type TextNodeData = {
  text: string;
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

export function ShapeNode({ data, selected }: NodeProps<Node<ShapeNodeData>>) {
  const theme = useDiagramTheme();
  const drawn = outlineSize(data.shape, data.width, data.height);
  const geometry = shapeGeometry(data.shape, drawn.w, drawn.h);
  const paint = paintFor(data.shape, data.color, theme);
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
    <div className={["diagram-shape", selected ? "is-selected" : "", data.problem ? "is-problem" : ""].filter(Boolean).join(" ")} style={{ width: data.width, height: data.height }}>
      <svg width={data.width} height={data.height} className="block overflow-visible" aria-hidden>
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
        className="absolute inset-0 flex items-center justify-center overflow-hidden text-center text-[13px] font-medium leading-4"
        style={{ padding: labelPadding(data.shape, data.width, data.height), color: paint.text }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (!data.readOnly) setEditing(true);
        }}
      >
        {editing ? (
          <input
            autoFocus
            className="nodrag nopan w-full bg-transparent text-center outline-none"
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
          <span className="line-clamp-2 max-h-full w-full">{data.label}</span>
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

export function TextNode({ data, selected }: NodeProps<Node<TextNodeData>>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.text);
  useEffect(() => setDraft(data.text), [data.text]);
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== data.text) data.onRename(next);
    else setDraft(data.text);
  };
  return (
    <div
      className={["diagram-text", selected ? "is-selected" : "", data.problem ? "is-problem" : ""].filter(Boolean).join(" ")}
      style={{ width: data.width, height: data.height }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!data.readOnly) setEditing(true);
      }}
    >
      {editing ? (
        <textarea
          autoFocus
          className="nodrag nopan h-full w-full resize-none bg-transparent text-[13px] leading-5 text-ink outline-none"
          value={draft}
          aria-label="Text box"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
        />
      ) : (
        <p className="whitespace-pre-wrap text-[12.5px] font-medium leading-5 text-ink">{data.text}</p>
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
