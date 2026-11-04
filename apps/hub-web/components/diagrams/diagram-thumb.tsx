"use client";

import { useQuery } from "@tanstack/react-query";
import { renderDiagramSvg, type DiagramModel } from "@ensemble/block-diagrams";
import { Shapes } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useDiagramTheme } from "./glyph";

/**
 * A diagram's drawing on its list card. Fetched once it scrolls near the screen, keyed on the
 * list's updatedAt, so an edit shows the next time the list loads. The drawing is an <img>:
 * it scales to the card and never runs anything inside the SVG.
 */
export function DiagramThumb({ id, updatedAt }: { id: string; updatedAt: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const theme = useDiagramTheme();
  useEffect(() => {
    const node = ref.current;
    if (!node || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNear(true);
        observer.disconnect();
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  const query = useQuery({
    queryKey: ["diagram-thumb", id, updatedAt],
    queryFn: () => api.diagram(id),
    enabled: near,
    staleTime: Infinity,
    retry: false,
  });
  const src = useMemo(() => {
    const model = query.data?.diagram.model as DiagramModel | undefined;
    if (!model?.meta) return null;
    try {
      // The card shows the title, and its own paper: drop the drawing's title and background.
      const svg = renderDiagramSvg({ ...model, meta: { ...model.meta, title: "" } }, { theme })
        .replace(/^<\?xml[^>]*>\s*/, "")
        .replace(/(<\/defs>)<rect[^>]*\/><rect[^>]*\/>/, "$1");
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } catch {
      return null;
    }
  }, [query.data, theme]);
  const empty = query.data && !src;
  return (
    <div ref={ref} className="dg-thumb" data-state={src ? "ready" : query.isError || empty ? "empty" : "loading"}>
      {src ? (
        <img src={src} alt="" decoding="async" draggable={false} />
      ) : query.isError || empty ? (
        <Shapes size={22} aria-hidden className="dg-thumb-icon" />
      ) : null}
    </div>
  );
}
