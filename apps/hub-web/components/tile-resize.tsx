"use client";

import type { ButtonHTMLAttributes } from "react";

/**
 * The resize corner every tile uses (Today, Context, the weekly recap, the board overview, Plots and the
 * widget view): a small L in the tile's bottom-right corner. Where it sits, when it shows and its cursor
 * are the surface's own class; the glyph and its colours are `.tile-resize` in `app/globals.css`.
 */
export function TileResize({ label, className, title = "Drag to resize", ...button }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={title} {...button} className={`tile-resize${className ? ` ${className}` : ""}`}>
      <svg viewBox="0 0 7 7" aria-hidden>
        <path d="M6.25 0.75V4.75A1.5 1.5 0 0 1 4.75 6.25H0.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );
}
