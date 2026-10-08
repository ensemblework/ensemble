/** One page width for every peek. Local copy paints first; the account copy is the one that survives a new browser. */

export const PAGE_WIDTH_KEY = "ensemble.page.width";
export const PAGE_WIDTH_MIN = 28;
export const PAGE_WIDTH_MAX = 80;
export const PAGE_WIDTH_DEFAULT = 50;

const SIDEBAR_KEY = "ensemble.sidebar.collapsed";

export function clampPageWidth(value: number): number {
  if (!Number.isFinite(value)) return PAGE_WIDTH_DEFAULT;
  return Math.min(PAGE_WIDTH_MAX, Math.max(PAGE_WIDTH_MIN, Math.round(value)));
}

export function readPageWidth(): number {
  if (typeof window === "undefined") return PAGE_WIDTH_DEFAULT;
  try {
    const raw = window.localStorage.getItem(PAGE_WIDTH_KEY);
    if (raw == null) return PAGE_WIDTH_DEFAULT;
    return clampPageWidth(Number(JSON.parse(raw)));
  } catch {
    return PAGE_WIDTH_DEFAULT;
  }
}

export function writePageWidth(value: number): number {
  const next = clampPageWidth(value);
  try {
    window.localStorage.setItem(PAGE_WIDTH_KEY, JSON.stringify(next));
  } catch {
    // storage full or disabled
  }
  document.documentElement.style.setProperty("--page-width", `${next}%`);
  document.documentElement.dataset.pageWidth = String(next);
  return next;
}

let freshUntil = 0;

export function markPageWidthWrite(): void {
  freshUntil = Date.now() + 2500;
}

export function pageWidthWriteIsFresh(): boolean {
  return Date.now() < freshUntil;
}

/** Inlined before paint, next to the appearance boot script. */
export const PAGE_BOOT = `try{var raw=localStorage.getItem(${JSON.stringify(PAGE_WIDTH_KEY)});var n=raw==null?${PAGE_WIDTH_DEFAULT}:Number(JSON.parse(raw));if(!(n>=${PAGE_WIDTH_MIN}&&n<=${PAGE_WIDTH_MAX}))n=${PAGE_WIDTH_DEFAULT};n=Math.round(n);document.documentElement.style.setProperty("--page-width",n+"%");document.documentElement.dataset.pageWidth=String(n);}catch(e){}try{if(JSON.parse(localStorage.getItem(${JSON.stringify(SIDEBAR_KEY)})||"false")===true)document.documentElement.dataset.sidebar="rail";}catch(e){}try{var w=Number(localStorage.getItem("ensemble.sidebar.width"));if(w>=184&&w<=360)document.documentElement.style.setProperty("--sidebar-w",Math.round(w)+"px");}catch(e){}`;
