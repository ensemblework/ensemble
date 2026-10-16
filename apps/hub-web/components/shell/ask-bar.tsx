"use client";

import { Search } from "lucide-react";
import { modKey } from "@/lib/platform";

/** One entry point for workspace search, navigation, settings and actions. */
export function AskBar() {
  return <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("ensemble:palette"))}
    className="flex h-8 w-full max-w-[340px] items-center gap-2 rounded-lg border border-line bg-panel px-3 text-left text-[13px] text-muted max-sm:w-9 max-sm:justify-center max-sm:px-0"
    aria-label="Search and jump" title={`Search and jump (${modKey()}K)`}>
    <Search size={15} /><span className="flex-1 max-sm:hidden">Search and jump…</span><kbd className="kbd max-sm:hidden">{modKey()}K</kbd>
  </button>;
}
