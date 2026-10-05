"use client";

import { useEffect } from "react";
import { openClaimedEnsemble } from "./claim";

/** Ctrl/Cmd+Shift+U opens the surface the pointer was last on. */
export function EnsembleHotkey() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey) return;
      if (event.metaKey && event.ctrlKey) return;
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "u") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      openClaimedEnsemble();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
