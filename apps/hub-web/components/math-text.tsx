"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useEffect, useRef } from "react";
import { drawMath } from "@/lib/math";

/** A TeX equation inside Markdown text (`MarkdownText`). Display math sits centred on a line of its own. */
export function MathText({ latex, display = false }: { latex: string; display?: boolean }) {
  const inline = useRef<HTMLSpanElement>(null);
  const block = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = display ? block.current : inline.current;
    if (target) drawMath(target, latex, display);
  }, [latex, display]);
  return display ? <div ref={block} className="page-math-shown md-math-block" /> : <span ref={inline} className="page-math-shown md-math-inline" />;
}
