/** A resizable shell panel whose width lives in a CSS variable on <html> and in localStorage. */
export type PanelWidth = { cssVar: string; storageKey: string; min: number; max: number; fallback: number };

export const PAGES_PANEL_WIDTH: PanelWidth = { cssVar: "--pages-w", storageKey: "ensemble.pages.width", min: 220, max: 520, fallback: 264 };

export function clampPanelWidth(spec: PanelWidth, value: number): number {
  return Math.round(Math.min(spec.max, Math.max(spec.min, value)));
}

export function readPanelWidth(spec: PanelWidth): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(spec.cssVar));
  return Number.isFinite(value) ? value : spec.fallback;
}

/** Live while dragging; `save` keeps it for the next load. `null` forgets the saved width. */
export function setPanelWidth(spec: PanelWidth, value: number | null, save = false): number {
  const root = document.documentElement;
  if (value === null) {
    root.style.removeProperty(spec.cssVar);
    try { window.localStorage.removeItem(spec.storageKey); } catch { /* storage disabled */ }
    return spec.fallback;
  }
  const width = clampPanelWidth(spec, value);
  root.style.setProperty(spec.cssVar, `${width}px`);
  if (save) {
    try {
      window.localStorage.setItem(spec.storageKey, String(width));
    } catch {
      // storage full or disabled
    }
  }
  return width;
}

/** Inline boot script: restores a saved width before the first paint. */
export function panelWidthBoot(spec: PanelWidth): string {
  return `try{var pw=Number(localStorage.getItem(${JSON.stringify(spec.storageKey)}));if(pw>=${spec.min}&&pw<=${spec.max})document.documentElement.style.setProperty(${JSON.stringify(spec.cssVar)},Math.round(pw)+"px");}catch(e){}`;
}
