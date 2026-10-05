"use client";

import { useEffect, useRef } from "react";
import type { GlyphHandle } from "./glyph-engine";

/** Lazy expressive glyph. Minimal suites never import this module. */
export function ExpressiveGlyph({ state, size = 22 }: { state: string; size?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const handle = useRef<GlyphHandle | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    void import("./glyph-engine").then((mod) => {
      if (!live || !ref.current) return;
      handle.current = mod.mountGlyph(ref.current, { state, size });
    });
    return () => {
      live = false;
      handle.current?.stop();
      handle.current = null;
    };
    // state updates go through the second effect so the engine is not remounted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  useEffect(() => {
    handle.current?.set(state);
  }, [state]);

  return <span ref={ref} className="u-glyph" aria-hidden />;
}
