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

export type ClientPlatform = { os: "mac" | "windows" | "linux" | "android" | "ios" | "unknown"; mobile: boolean; native: boolean };

/** Read browser/webview hints only; keep the first render independent of browser globals. */
export function clientPlatform(): ClientPlatform {
  if (typeof navigator === "undefined") return { os: "unknown", mobile: false, native: false };
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } };
  const text = `${nav.userAgentData?.platform ?? nav.platform} ${nav.userAgent}`;
  const os = /android/i.test(text) ? "android" : /iphone|ipad|ipod/i.test(text) || (/mac/i.test(text) && nav.maxTouchPoints > 1) ? "ios" : /mac/i.test(text) ? "mac" : /win/i.test(text) ? "windows" : /linux/i.test(text) ? "linux" : "unknown";
  const native = typeof window !== "undefined" && Boolean((window as Window & { __ENSEMBLE_DESKTOP__?: unknown; __TAURI_INTERNALS__?: unknown }).__ENSEMBLE_DESKTOP__ || (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  return { os, mobile: os === "android" || os === "ios" || nav.userAgentData?.mobile === true, native };
}

export function useClientPlatform(): ClientPlatform {
  const [platform, setPlatform] = useState<ClientPlatform>({ os: "unknown", mobile: false, native: false });
  useEffect(() => setPlatform(clientPlatform()), []);
  return platform;
}
