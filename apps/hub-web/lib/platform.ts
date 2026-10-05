"use client";

import { useEffect, useState } from "react";

/**
 * True on macOS and iOS, where the shortcut modifier is Command.
 * Read the webview's own platform string. A native shell must not pretend every
 * machine is a Mac, and this file must not shell out to a platform tool.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || navigator.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Shortcut label for the primary modifier. Ctrl on Linux and Windows. */
export function modKey(): string {
  return isApplePlatform() ? "⌘" : "Ctrl";
}

/** Ctrl on the server and the first paint, then the real modifier. Avoids a hydration mismatch. */
export function useModKey(): string {
  const [mod, setMod] = useState("Ctrl");
  useEffect(() => setMod(modKey()), []);
  return mod;
}
