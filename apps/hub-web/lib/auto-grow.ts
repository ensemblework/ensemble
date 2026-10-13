"use client";

import { useLayoutEffect, type RefObject } from "react";

/** The height a box needs for its text, kept between one line and `max`, after which it scrolls. */
export function grownHeight(scrollHeight: number, min: number, max: number): { height: number; scrolls: boolean } {
  return { height: Math.max(min, Math.min(scrollHeight, max)), scrolls: scrollHeight > max };
}

/**
 * A textarea that grows with what is typed, like a chat composer: one line when empty,
 * up to `maxLines`, then it scrolls. It measures again when its width changes.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxLines = 8): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const fit = () => {
      const line = Number.parseFloat(getComputedStyle(node).lineHeight) || 24;
      node.style.height = "auto";
      const { height, scrolls } = grownHeight(node.scrollHeight, line, line * maxLines);
      node.style.height = `${height}px`;
      node.style.overflowY = scrolls ? "auto" : "hidden";
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      fit();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, value, maxLines]);
}
