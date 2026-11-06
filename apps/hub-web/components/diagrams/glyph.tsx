"use client";

import { paintFor, shapeGeometry, type DiagramTheme, type ShapeId } from "@ensemble/block-diagrams";
import { useEffect, useState } from "react";

export function useDiagramTheme(): DiagramTheme {
  const [theme, setTheme] = useState<DiagramTheme>("dark");
  useEffect(() => {
    const read = () => setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** The size a glyph's shape is drawn at before it is scaled down: shapes keep their proportions (a cylinder's rims) at any glyph size. */
const GLYPH_W = 60;
const GLYPH_H = Math.round(GLYPH_W * 0.72);

/** Toolbar glyph. Kept out of the xyflow module so the palette does not load the canvas. */
export function ShapeGlyph({ shape, size = 28 }: { shape: ShapeId; size?: number }) {
  const theme = useDiagramTheme();
  const geometry = shapeGeometry(shape, GLYPH_W, GLYPH_H);
  const paint = paintFor(shape, null, theme);
  // Room around the shape for its stroke, so no edge is cut off.
  const pad = 2;
  return (
    <svg width={size} height={Math.round(size * 0.72)} viewBox={`${-pad} ${-pad} ${GLYPH_W + pad * 2} ${GLYPH_H + pad * 2}`} aria-hidden className="shrink-0">
      <path d={geometry.outline} fill={geometry.filled ? paint.fill : "none"} stroke={paint.stroke} strokeWidth={1.25} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
