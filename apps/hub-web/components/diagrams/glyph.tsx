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

/** Toolbar glyph. Kept out of the xyflow module so the palette does not load the canvas. */
export function ShapeGlyph({ shape, size = 28 }: { shape: ShapeId; size?: number }) {
  const theme = useDiagramTheme();
  const geometry = shapeGeometry(shape, size, Math.round(size * 0.72));
  const paint = paintFor(shape, null, theme);
  return (
    <svg width={size} height={Math.round(size * 0.72)} aria-hidden className="shrink-0">
      <path d={geometry.outline} fill={geometry.filled ? paint.fill : "none"} stroke={paint.stroke} strokeWidth={1.25} strokeLinejoin="round" />
    </svg>
  );
}
