"use client";

import { Search } from "lucide-react";
import { useModKey } from "@/lib/platform";

/** One entry point for workspace search, navigation, settings and actions. */
export function AskBar() {
  // Ctrl on the server and first paint, then ⌘ on Apple devices: reading the platform while rendering broke hydration there.
  const mod = useModKey();
  return <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("ensemble:palette"))}
    className="flex h-8 w-full max-w-[340px] items-center gap-2 rounded-lg border border-line bg-panel px-3 text-left text-[13px] text-muted transition-colors duration-150 hover:border-line-strong hover:text-ink max-sm:w-9 max-sm:justify-center max-sm:px-0"
    aria-label="Search and jump" title={`Search and jump (${mod}K)`}>
    <Search size={15} className="shrink-0" /><span className="flex-1 truncate max-sm:hidden">Search and jump…</span><kbd className="kbd max-sm:hidden">{mod}K</kbd>
  </button>;
}
