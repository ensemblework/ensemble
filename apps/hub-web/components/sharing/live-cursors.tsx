"use client";

import { ViewportPortal, useReactFlow, useStore, useViewport } from "@xyflow/react";
import { useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { useFollowing } from "@/lib/follow";
import { onResource, tabId, usePresence } from "@/lib/presence";

const SEND_EVERY_MS = 60;

/** A small, friendly pointer in the person's colour, with their name beside it. */
function Pointer({ color, name, zoom, emoji }: { color: string; name: string; zoom: number; emoji?: string | null }) {
  return (
    <div style={{ transform: `scale(${1 / zoom})`, transformOrigin: "0 0" }} className="pointer-events-none">
      <svg width="18" height="20" viewBox="0 0 18 20" aria-hidden className="drop-shadow-sm">
        <path d="M2 1.5 L15.5 9.2 L9.4 10.6 L6.4 17.6 Z" fill={color} stroke="white" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
      <span className="ml-3 -mt-1 inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 text-white shadow-sm" style={{ background: color }}>
        {emoji ? `${emoji} ${name}` : name.split(" ")[0]}
      </span>
    </div>
  );
}

/**
 * Everyone else's cursor on this diagram, live. Positions are in diagram coordinates, so a
 * cursor sits on the same block for everyone whatever their zoom. Must render inside ReactFlow.
 */
export function LiveCursors({ diagramId }: { diagramId: string }) {
  const here = onResource(usePresence(), "diagram", diagramId);
  const { zoom } = useViewport();
  const flow = useReactFlow();
  const following = useFollowing();
  const followed = following ? here.find((entry) => entry.accountId === following.accountId) : undefined;

  // Following someone: your view centres where theirs does (sizes differ between screens).
  useEffect(() => {
    if (!followed?.viewport) return;
    void flow.setCenter(followed.viewport.x, followed.viewport.y, { zoom: followed.viewport.zoom, duration: 160 });
  }, [flow, followed?.viewport?.x, followed?.viewport?.y, followed?.viewport?.zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ViewportPortal>
      {here
        .filter((entry) => entry.cursor)
        .map((entry) => (
          <div
            key={entry.accountId}
            className="absolute left-0 top-0 z-[5]"
            style={{ transform: `translate(${entry.cursor!.x}px, ${entry.cursor!.y}px)`, transition: "transform 90ms linear" }}
          >
            <Pointer color={entry.color} name={entry.name} zoom={zoom} emoji={entry.emoji} />
          </div>
        ))}
    </ViewportPortal>
  );
}

/**
 * Sends your cursor (and, after a pan or zoom, your view) while someone else is on the
 * diagram. Returns handlers for the ReactFlow wrapper.
 */
export function useCursorBroadcast(diagramId: string) {
  const flow = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const others = onResource(usePresence(), "diagram", diagramId).length > 0;
  const live = useRef(others);
  live.current = others;
  const last = useRef(0);
  const queued = useRef<number | undefined>(undefined);
  const point = useRef<{ x: number; y: number } | null>(null);

  const flush = useCallback(() => {
    queued.current = undefined;
    last.current = Date.now();
    void api.sendPresence({ tabId: tabId(), cursor: point.current }).catch(() => undefined);
  }, []);

  const onMouseMove = useCallback(
    (event: React.MouseEvent) => {
      if (!live.current) return;
      const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      point.current = { x: Math.round(at.x), y: Math.round(at.y) };
      const wait = SEND_EVERY_MS - (Date.now() - last.current);
      if (wait <= 0) flush();
      else if (queued.current === undefined) queued.current = window.setTimeout(flush, wait);
    },
    [flow, flush],
  );

  const onMouseLeave = useCallback(() => {
    if (!live.current) return;
    point.current = null;
    window.clearTimeout(queued.current);
    flush();
  }, [flush]);

  const onMoveEnd = useCallback(() => {
    if (!live.current) return;
    const viewport = flow.getViewport();
    // The centre of what you see, in diagram coordinates.
    const x = (width / 2 - viewport.x) / viewport.zoom;
    const y = (height / 2 - viewport.y) / viewport.zoom;
    void api.sendPresence({ tabId: tabId(), viewport: { x: Math.round(x), y: Math.round(y), zoom: Number(viewport.zoom.toFixed(3)) } }).catch(() => undefined);
  }, [flow, width, height]);

  useEffect(() => () => window.clearTimeout(queued.current), []);
  return { onMouseMove, onMouseLeave, onMoveEnd };
}
