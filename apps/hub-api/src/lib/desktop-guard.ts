/** DNS rebinding: a public name must not be answered on the loopback API. */
export function desktopHostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const first = hostHeader.split(",")[0]?.trim() ?? "";
  const host = first.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Origins the desktop webview uses. The hosted build does not add these. */
export const DESKTOP_WEBVIEW_ORIGINS = [
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://ensemble.localhost",
  "https://ensemble.localhost",
  "tauri://localhost",
  "ensemble://localhost",
] as const;
