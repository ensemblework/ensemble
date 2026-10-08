const KEY = "ensemble.sidebar.collapsed";
export const SIDEBAR_WIDTH_KEY = "ensemble.sidebar.width";
export const SIDEBAR_WIDTH_MIN = 184;
export const SIDEBAR_WIDTH_MAX = 360;
export const SIDEBAR_WIDTH_DEFAULT = 192;

export function clampSidebarWidth(value: number): number {
  return Math.round(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, value)));
}

/** Live while dragging; `save` keeps it for the next load. */
export function setSidebarWidth(value: number, save = false): number {
  const width = clampSidebarWidth(value);
  document.documentElement.style.setProperty("--sidebar-w", `${width}px`);
  if (save) {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    } catch {
      // storage full or disabled
    }
  }
  return width;
}

export function sidebarIsRail(): boolean {
  return document.documentElement.dataset.sidebar === "rail";
}

/** CSS owns the width. React state stays out of the page tree so the toggle does not reconcile it. */
export function setSidebarRail(rail: boolean): void {
  if (rail) document.documentElement.dataset.sidebar = "rail";
  else delete document.documentElement.dataset.sidebar;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(rail));
  } catch {
    // storage full or disabled
  }
  window.dispatchEvent(new CustomEvent("ensemble:pref", { detail: KEY }));
}

export function toggleSidebarRail(): void {
  setSidebarRail(!sidebarIsRail());
}
