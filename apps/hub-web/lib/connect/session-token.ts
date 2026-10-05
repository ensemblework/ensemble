"use client";

import { useEffect, useState } from "react";

const KEY = "ensemble.bridge.token";

export function readBridgeToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveBridgeToken(token: string): void {
  sessionStorage.setItem(KEY, token);
  window.dispatchEvent(new Event("ensemble:bridge-token"));
}

export function clearBridgeToken(): void {
  sessionStorage.removeItem(KEY);
  window.dispatchEvent(new Event("ensemble:bridge-token"));
}

/** The key is kept for this browser tab only, so a guide can fill it in. It is not written to disk. */
export function useBridgeToken(): string | null {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => setToken(readBridgeToken());
    sync();
    window.addEventListener("ensemble:bridge-token", sync);
    return () => window.removeEventListener("ensemble:bridge-token", sync);
  }, []);
  return token;
}
