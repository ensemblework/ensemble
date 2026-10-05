/** True only for the packaged desktop static export. Web dev and `next build` leave this unset. */
export function desktopExport(): boolean {
  return process.env.ENSEMBLE_DESKTOP_EXPORT === "1";
}

/** One placeholder path so `output: "export"` has a file to emit. The web build returns nothing and keeps serving ids on demand. */
export function desktopPlaceholder<T extends Record<string, string | string[]>>(row: T): T[] {
  return desktopExport() ? [row] : [];
}
