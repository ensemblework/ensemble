const KEY = "ensemble.sidebar.collapsed";

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
