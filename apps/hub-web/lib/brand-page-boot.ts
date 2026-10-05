import { APPEARANCE_KEY } from "@/lib/prefs";

/**
 * Runs before paint on pages that replace the root layout (global-error) and
 * is the same read the static 404 / 500 / offline documents do.
 * Storage is localStorage[`ensemble.appearance`].motion, not ensemble:motion-theme.
 */
export const BRAND_PAGE_BOOT = `try{var raw=JSON.parse(localStorage.getItem(${JSON.stringify(APPEARANCE_KEY)})||"null");var d=document.documentElement;if(raw&&typeof raw==="object"){var m=raw.motion;if(m==="expressive"||m==="minimal-quiet"||m==="minimal-dot")d.setAttribute("data-motion-theme",m);var theme=raw.theme==="system"?(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"):raw.theme==="light"?"light":"dark";d.setAttribute("data-theme",theme);d.setAttribute("data-reduce-motion",String(!!raw.reduceMotion||matchMedia("(prefers-reduced-motion: reduce)").matches));}}catch(e){}`;
