/**
 * Screenshots of what was asked for ("the stock chart", "the price table", "the search results"),
 * not of whatever is at the top of the page (an ad, a banner): `browser_screenshot.focus` and
 * `browser_view.focus`. The page's candidate elements (charts drawn on a canvas or in SVG, tables,
 * lists of repeated cards, figures, sections, anything whose label, id, class or heading carries the
 * words) are collected by one fixed function in the page; `scoreCandidate` ranks them here, by the
 * words, the kind the words name, their size and what they are not (ads, page chrome, fixed bars, a
 * 1×1 pixel, the whole page). The winner grows to its card (a chart with its toolbar and range
 * buttons), is scrolled into view below any fixed header, and is captured with a margin: the viewport
 * clipped to it, a full-page clip when it is up to two viewports tall, else the viewport at its top.
 *
 * Functions passed to `evaluate` are serialised into the page: they must not define named inner
 * functions or assign functions to variables (tsx adds a `__name` helper the page does not have).
 */
import type { ElementHandle, JSHandle, Page } from "playwright-core";

export type FocusKind = "chart" | "table" | "results" | "price" | "image" | "video" | "map" | "form" | null;

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "on",
  "in",
  "at",
  "to",
  "and",
  "or",
  "with",
  "this",
  "that",
  "these",
  "page",
  "screenshot",
  "screen",
  "shot",
  "show",
  "me",
  "my",
  "its",
  "it",
  "part",
  "area",
  "section",
  "block",
  "box",
  "panel",
  "view",
  "please",
  "just",
  "only",
  "whole",
  "entire",
  "full",
  "main",
  "top",
  "current",
  "today",
  "todays",
  "latest",
]);

/** The words of a focus that can match a label, id, class or heading: lower case, without filler, plurals as stems. */
export function focusWords(focus: string): string[] {
  const words = focus
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word))
    .map((word) => (word.length > 4 && /[^s]s$/.test(word) ? word.slice(0, -1) : word));
  return [...new Set(words)].slice(0, 8);
}

/** What kind of thing the words ask for. */
export function focusKind(focus: string): FocusKind {
  const text = focus.toLowerCase();
  if (/\b(?:charts?|graphs?|plots?|candles?|candlesticks?|sparklines?|trend|price history|performance)\b/.test(text)) return "chart";
  if (/\b(?:tables?|grid|spreadsheet|specs?|specifications|comparison|schedule|standings|leaderboard|timetable)\b/.test(text)) return "table";
  if (/\b(?:results?|listings?|products|items|offers|search|cards|feed|list)\b/.test(text)) return "results";
  if (/\b(?:prices?|cost|pricing|buy box|deal)\b/.test(text)) return "price";
  if (/\b(?:images?|photos?|pictures?|gallery|logo)\b/.test(text)) return "image";
  if (/\b(?:video|player)\b/.test(text)) return "video";
  if (/\bmaps?\b/.test(text)) return "map";
  if (/\bforms?\b/.test(text)) return "form";
  return null;
}

/** One candidate as the page describes it. Text fields are lower case; geometry is in CSS pixels of the document. */
export type FocusCandidate = {
  index: number;
  tag: string;
  role: string;
  /** id, class and test ids, with `-` and `_` as spaces. */
  names: string;
  /** aria-label, title, alt and aria-labelledby text. */
  label: string;
  /** The heading it starts with, or the one just before it. */
  heading: string;
  /** Its first text. */
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The largest canvas, SVG, image or video it is or holds, in square pixels. */
  graphic: number;
  rows: number;
  /** How many of its children look alike (a list of result cards). */
  repeated: number;
  /** Prices in its first text. */
  currency: number;
  /** Inside the page's header, navigation or footer. */
  chrome: boolean;
  ad: boolean;
  fixed: boolean;
  /** A control (a button, a link, a tab, a field): never the thing to show. */
  control: boolean;
};

export type FocusView = { vw: number; vh: number; docH: number };

/** How well a candidate fits the focus; -Infinity for what is never a focus (tiny, hidden). */
export function scoreCandidate(candidate: FocusCandidate, words: readonly string[], kind: FocusKind, view: FocusView): number {
  const { w, h } = candidate;
  if (w < 40 || h < 30) return Number.NEGATIVE_INFINITY;
  const area = w * h;
  const viewArea = Math.max(1, view.vw * view.vh);
  let score = 0;
  let matched = 0;
  for (const word of words) {
    let hit = false;
    if (candidate.label.includes(word)) {
      score += 14;
      hit = true;
    }
    if (candidate.heading.includes(word)) {
      score += 10;
      hit = true;
    }
    if (candidate.names.includes(word)) {
      score += 8;
      hit = true;
    }
    if (candidate.text.includes(word)) {
      score += 3;
      hit = true;
    }
    if (hit) matched += 1;
  }
  if (words.length > 1 && matched === words.length) score += 6;
  const graphicTag = candidate.tag === "canvas" || candidate.tag === "svg";
  const named = `${candidate.names} ${candidate.label}`;
  switch (kind) {
    case "chart":
      if (graphicTag) score += area >= 40_000 ? 30 : area >= 15_000 ? 12 : -20;
      else if (candidate.graphic >= 40_000 && candidate.graphic >= area * 0.25 && !/^(?:img|picture|video|iframe)$/.test(candidate.tag)) score += 22;
      if (/\b(?:chart|graph|plot|highcharts|recharts|echarts|apexcharts|tradingview|stx)\b/.test(named)) score += 18;
      if (candidate.tag === "img" && area >= 60_000 && /chart|graph|plot/.test(named)) score += 15;
      break;
    case "table":
      if (candidate.tag === "table" || candidate.role === "table" || candidate.role === "grid") score += 30 + Math.min(candidate.rows, 20);
      break;
    case "results":
      if (candidate.repeated >= 3) score += 20 + Math.min(candidate.repeated, 20);
      if (/\b(?:results?|search|list|grid|products?|items?|listings?)\b/.test(candidate.names)) score += 10;
      break;
    case "price":
      if (candidate.currency > 0) score += 15 + Math.min(candidate.currency, 5) * 2;
      break;
    case "image":
      if ((candidate.tag === "img" || candidate.tag === "picture" || candidate.tag === "figure" || candidate.role === "img") && area >= 40_000) score += 25;
      break;
    case "video":
      if (candidate.tag === "video" || /\b(?:video|player)\b/.test(named)) score += 25;
      break;
    case "map":
      if (/\bmaps?\b/.test(named)) score += 25;
      break;
    case "form":
      if (candidate.tag === "form") score += 25;
      break;
  }
  // A chart, table, list or picture worth showing has some size.
  if (kind && kind !== "price" && kind !== "form" && (w < 150 || h < 80)) score -= 30;
  if (candidate.control) score -= 45;
  score += Math.min(10, (area / viewArea) * 12);
  // A wrapper of the whole page is no focus.
  if (area > viewArea * 3 || h > Math.max(view.docH, view.vh) * 0.8) score -= 25;
  if (candidate.ad) score -= 80;
  if (candidate.chrome && kind !== null) score -= 15;
  if (candidate.fixed) score -= 10;
  return score;
}

/** A score from which a candidate counts as what was asked for. */
export const FOCUS_THRESHOLD = 22;

/** The best candidate, if one fits well enough. */
export function pickFocus(candidates: readonly FocusCandidate[], focus: string, view: FocusView): { candidate: FocusCandidate; score: number } | null {
  const words = focusWords(focus);
  const kind = focusKind(focus);
  let best: { candidate: FocusCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, words, kind, view);
    if (score === Number.NEGATIVE_INFINITY) continue;
    if (!best || score > best.score || (score === best.score && candidate.y < best.candidate.y)) best = { candidate, score };
  }
  return best && best.score >= FOCUS_THRESHOLD ? best : null;
}

/** A short description of the element for the work's answer: `chart (svg)`, `table "Prices"`. */
export function describeCandidate(candidate: FocusCandidate, kind: FocusKind): string {
  const name = (candidate.label || candidate.heading).trim().slice(0, 60);
  const what = kind === "chart" ? "chart" : kind === "table" ? "table" : kind === "results" ? "results" : candidate.tag;
  return `${what}${name ? ` “${name}”` : ""} (${candidate.tag}, ${Math.round(candidate.w)}×${Math.round(candidate.h)})`;
}

// ── in the page ─────────────────────────────────────────────────────────────

type CollectArgs = { words: string; ad: string; max: number };

/** Runs in the page: candidate elements and their descriptions. */
function collectCandidates(args: CollectArgs): { els: unknown[]; info: FocusCandidate[]; view: FocusView } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = globalThis as any;
  const d = w.document;
  const vw = w.innerWidth;
  const vh = w.innerHeight;
  const docH = Math.max(d.documentElement ? d.documentElement.scrollHeight : 0, d.body ? d.body.scrollHeight : 0);
  const sx = w.scrollX;
  const sy = w.scrollY;
  const wordRe = args.words ? new RegExp(args.words, "i") : null;
  const adRe = new RegExp(args.ad, "i");
  const kindTags = /^(?:canvas|svg|img|picture|video|figure|table|iframe|section|article|main|aside|form|ul|ol|dl)$/;
  const roles = /^(?:img|figure|table|grid|region|list|feed|main|article|complementary|tabpanel|group|heading)$/;
  const els: unknown[] = [];
  const info: FocusCandidate[] = [];
  const all = d.body ? d.body.querySelectorAll("*") : [];
  const limit = Math.min(all.length, 20000);
  for (let n = 0; n < limit && els.length < args.max; n += 1) {
    const el = all[n];
    const tag = String(el.tagName).toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template" || tag === "br" || tag === "head") continue;
    if (el.ownerSVGElement) continue;
    const cls = typeof el.className === "string" ? el.className : el.className && typeof el.className.baseVal === "string" ? el.className.baseVal : "";
    const testid = `${el.getAttribute("data-testid") || ""} ${el.getAttribute("data-test") || ""} ${el.getAttribute("data-component-type") || ""}`;
    let label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.getAttribute("alt") || ""}`;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ids = String(labelledBy).split(/\s+/).slice(0, 3);
      for (let k = 0; k < ids.length; k += 1) {
        const ref = d.getElementById(ids[k]);
        if (ref) label += ` ${String(ref.textContent || "").slice(0, 100)}`;
      }
    }
    const role = String(el.getAttribute("role") || "").toLowerCase();
    const names = `${el.id || ""} ${cls} ${testid}`.toLowerCase().replace(/[-_]+/g, " ");
    let repeated = 0;
    if (el.childElementCount >= 3) {
      const counts: Record<string, number> = {};
      const kids = el.children;
      for (let k = 0; k < kids.length && k < 400; k += 1) {
        const kid = kids[k];
        const kidCls = typeof kid.className === "string" ? kid.className.trim().split(/\s+/)[0] || "" : "";
        const key = `${kid.tagName}|${kid.getAttribute("data-component-type") || kid.getAttribute("data-testid") || kidCls}`;
        counts[key] = (counts[key] || 0) + 1;
        if (counts[key] > repeated) repeated = counts[key];
      }
      if (repeated < 3) repeated = 0;
    }
    const interesting = kindTags.test(tag) || roles.test(role) || repeated >= 3 || (wordRe !== null && (wordRe.test(names) || wordRe.test(label)));
    if (!interesting) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 30) continue;
    const style = w.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
    // Its heading: one it starts with, else a heading just before it.
    let heading = "";
    const inside = el.querySelector ? el.querySelector("h1, h2, h3, h4, h5, h6, [role=heading], caption, figcaption, legend") : null;
    if (inside) heading = String(inside.textContent || "");
    else {
      let previous = el.previousElementSibling;
      for (let k = 0; previous && k < 3 && !heading; k += 1) {
        if (/^H[1-6]$/.test(previous.tagName) || previous.getAttribute("role") === "heading") heading = String(previous.textContent || "");
        else {
          const last = previous.querySelectorAll ? previous.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]") : [];
          if (last.length) heading = String(last[last.length - 1].textContent || "");
        }
        previous = previous.previousElementSibling;
      }
    }
    const text = String(el.textContent || "").slice(0, 2000);
    const currency = (text.match(/(?:[$€£¥₹]|US\$|Rs\.?)\s?\d/g) || []).length;
    let graphic = 0;
    const area = r.width * r.height;
    if (tag === "canvas" || tag === "svg" || tag === "img" || tag === "video") graphic = area;
    else if (area <= vw * vh * 3 && el.querySelectorAll) {
      const media = el.querySelectorAll("canvas, svg, img, video");
      for (let k = 0; k < media.length && k < 40; k += 1) {
        if (media[k].ownerSVGElement) continue;
        const mr = media[k].getBoundingClientRect();
        if (mr.width * mr.height > graphic) graphic = mr.width * mr.height;
      }
    }
    let rows = 0;
    if (tag === "table" || role === "table" || role === "grid") rows = el.querySelectorAll("tr, [role=row]").length;
    const chrome = Boolean(el.closest && el.closest("header, nav, footer, [role=banner], [role=navigation], [role=contentinfo]"));
    let ad = adRe.test(names) || /^(?:google_ads|div-gpt-ad|aswift)/i.test(String(el.id || ""));
    if (!ad && el.closest) ad = Boolean(el.closest("[id^='google_ads'], [id^='div-gpt-ad'], ins.adsbygoogle, [data-ad-slot], [data-google-query-id], [data-ad], [data-ad-unit]"));
    if (!ad && tag === "iframe") ad = /doubleclick|googlesyndication|adservice|amazon-adsystem|adnxs|criteo|taboola|outbrain|adsafeprotected|moatads/.test(String(el.src || ""));
    const position = style.position;
    const control = /^(?:button|a|input|select|textarea|label|summary|option)$/.test(tag) || /^(?:button|link|tab|menuitem|option|checkbox|radio|switch|combobox|slider|spinbutton|searchbox|textbox)$/.test(role);
    els.push(el);
    info.push({
      index: els.length - 1,
      tag,
      role,
      names,
      label: label.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200),
      heading: heading.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160),
      text: text.slice(0, 300).toLowerCase().replace(/\s+/g, " ").trim(),
      x: r.left + sx,
      y: r.top + sy,
      w: r.width,
      h: r.height,
      graphic,
      rows,
      repeated,
      currency,
      chrome,
      ad,
      fixed: position === "fixed" || position === "sticky",
      control,
    });
  }
  return { els, info, view: { vw, vh, docH } };
}

/** Runs in the page: the element grown to its card (a chart with its toolbar and range buttons), within `ratio` of its area. */
function growToCard(el: unknown, args: { ratio: number; ad: string }): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = globalThis as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const start = el as any;
  const adRe = new RegExp(args.ad, "i");
  const r0 = start.getBoundingClientRect();
  const area0 = Math.max(1, r0.width * r0.height);
  let best = start;
  let parent = start.parentElement;
  for (let steps = 0; parent && parent !== w.document.body && steps < 6; steps += 1) {
    const r = parent.getBoundingClientRect();
    // Grow to take in a heading, a toolbar or range buttons, not the empty width of the page.
    if (r.width * r.height > area0 * args.ratio || r.height > w.innerHeight * 1.6 || r.width > r0.width * 1.3 + 40) break;
    const cls = typeof parent.className === "string" ? parent.className : "";
    if (adRe.test(`${parent.id || ""} ${cls}`.replace(/[-_]+/g, " "))) break;
    best = parent;
    parent = parent.parentElement;
  }
  return best;
}

/** Runs in the page: the element whose text best matches, grown to its section. */
function textMatch(args: { phrase: string; words: string[] }): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = globalThis as any;
  const d = w.document;
  if (!d.body) return null;
  const walker = d.createTreeWalker(d.body, 4);
  let found = null;
  let fallback = null;
  let count = 0;
  for (let node = walker.nextNode(); node && count < 30000; node = walker.nextNode()) {
    count += 1;
    const text = String(node.nodeValue || "").toLowerCase();
    if (text.trim().length < 2) continue;
    const parent = node.parentElement;
    if (!parent || /^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION)$/.test(parent.tagName)) continue;
    const r = parent.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const style = w.getComputedStyle(parent);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (args.phrase && text.includes(args.phrase)) {
      found = parent;
      break;
    }
    if (!fallback && args.words.length > 1) {
      let hits = 0;
      for (let k = 0; k < args.words.length; k += 1) if (text.includes(args.words[k])) hits += 1;
      if (hits >= Math.ceil(args.words.length / 2) + (args.words.length > 2 ? 1 : 0)) fallback = parent;
    }
  }
  const hit = found || fallback;
  if (!hit) return null;
  let section = hit;
  for (let p = hit.parentElement, steps = 0; p && p !== d.body && steps < 8; p = p.parentElement, steps += 1) {
    const r = p.getBoundingClientRect();
    if (r.height > w.innerHeight * 1.5) break;
    section = p;
    if (/^(?:SECTION|ARTICLE|FIGURE|TABLE|ASIDE|FORM)$/.test(p.tagName) || p.getAttribute("role") === "region") {
      if (r.width >= 300 && r.height >= 150) break;
    }
  }
  const rect = section.getBoundingClientRect();
  return rect.width >= 100 && rect.height >= 40 ? section : null;
}

export type FocusPlace = { x: number; y: number; w: number; h: number; vw: number; vh: number; docW: number; docH: number; scrollY: number; top: number };

/** Runs in the page: where the element is, and how much of the viewport's top a fixed bar covers. */
function placeOf(el: unknown): FocusPlace {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = globalThis as any;
  const d = w.document;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const target = el as any;
  const r = target.getBoundingClientRect();
  let top = 0;
  const xs = [w.innerWidth * 0.25, w.innerWidth * 0.5, w.innerWidth * 0.75];
  for (let k = 0; k < xs.length; k += 1) {
    for (let y = 2; y < w.innerHeight * 0.3; y += 24) {
      const stack = d.elementsFromPoint(xs[k], y);
      let bar = 0;
      for (let s = 0; s < stack.length && s < 6; s += 1) {
        if (stack[s] === target || (target.contains && target.contains(stack[s]))) break;
        for (let p = stack[s]; p && p !== d.body && p !== d.documentElement; p = p.parentElement) {
          const position = w.getComputedStyle(p).position;
          if (position === "fixed" || position === "sticky") {
            const pr = p.getBoundingClientRect();
            if (pr.top <= 4 && pr.height < w.innerHeight * 0.3 && pr.width >= w.innerWidth * 0.5) bar = Math.max(bar, pr.bottom);
            break;
          }
        }
      }
      if (bar > top) top = bar;
    }
  }
  return {
    x: r.left + w.scrollX,
    y: r.top + w.scrollY,
    w: r.width,
    h: r.height,
    vw: w.innerWidth,
    vh: w.innerHeight,
    docW: Math.max(d.documentElement.scrollWidth, w.innerWidth),
    docH: Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0, w.innerHeight),
    scrollY: w.scrollY,
    top: Math.min(Math.round(top), Math.round(w.innerHeight * 0.3)),
  };
}

/** Runs in the page. */
function scrollToY(y: number): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = globalThis as any;
  w.scrollTo({ top: y, left: 0, behavior: "instant" });
  return w.scrollY;
}

const AD_SOURCE = String.raw`(?:^|\s)(?:ad|ads|adv|advert|adverts|advertisement|advertising|adslot|adunit|adbox|adcontainer|ad container|ad wrapper|ad slot|ad unit|banner ad|sponsor|sponsored|dfp|gpt ad|googlead|google ad|taboola|outbrain|promoted|sda|sdacontainer)(?:\s|\d|$)`;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type FocusFound = { element: ElementHandle; description: string; score: number; kind: FocusKind };

/**
 * The page's element that best fits the focus, grown to its card, or null. A page still drawing (a
 * chart that comes after the load event) gets a second look before the words are looked for in its text.
 */
export async function findFocus(page: Page, focus: string, options: { retryMs?: number } = {}): Promise<FocusFound | null> {
  const first = await findCandidate(page, focus);
  if (first) return first;
  await page.waitForTimeout(options.retryMs ?? 1_500);
  return (await findCandidate(page, focus)) ?? findByText(page, focus);
}

async function findCandidate(page: Page, focus: string): Promise<FocusFound | null> {
  const words = focusWords(focus);
  const kind = focusKind(focus);
  const handle: JSHandle = await page.evaluateHandle(collectCandidates, { words: words.map(escapeRegExp).join("|"), ad: AD_SOURCE, max: 1500 });
  try {
    const { info, view } = (await handle.evaluate((value: { info: FocusCandidate[]; view: FocusView }) => ({ info: value.info, view: value.view }))) as { info: FocusCandidate[]; view: FocusView };
    const best = pickFocus(info, focus, view);
    if (best) {
      const element = (await handle.evaluateHandle((value: { els: unknown[] }, index: number) => value.els[index], best.candidate.index)).asElement();
      if (element) {
        const grown = (await element.evaluateHandle(growToCard, { ratio: kind === "chart" || kind === "image" || kind === "video" || kind === "map" ? 2.2 : 1.5, ad: AD_SOURCE })).asElement() ?? element;
        return { element: grown as ElementHandle, description: describeCandidate(best.candidate, kind), score: best.score, kind };
      }
    }
  } finally {
    await handle.dispose().catch(() => undefined);
  }
  return null;
}

async function findByText(page: Page, focus: string): Promise<FocusFound | null> {
  const words = focusWords(focus);
  const kind = focusKind(focus);
  const phrase = focus.toLowerCase().replace(/\s+/g, " ").trim();
  const matched = (await page.evaluateHandle(textMatch, { phrase: phrase.length >= 3 ? phrase : "", words })).asElement();
  if (!matched) return null;
  return { element: matched as ElementHandle, description: "the part of the page that mentions it", score: FOCUS_THRESHOLD, kind };
}

export type FocusShot = { clip: { x: number; y: number; width: number; height: number }; fullPage: boolean };

/**
 * In the page: whether a chart has drawn (a long SVG path, or a canvas that is not blank). A chart drawn
 * after it scrolled into view would otherwise be pictured as an empty frame. A tainted canvas counts as
 * drawn; an element with no graphic has nothing to wait for.
 */
export function chartDrawn(el: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const target = el as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paths: any[] = [...target.querySelectorAll("svg path, svg polyline")];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (paths.some((path: any) => (path.getAttribute("d") ?? path.getAttribute("points") ?? "").length > 200)) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canvases: any[] = target.tagName === "CANVAS" ? [target] : [...target.querySelectorAll("canvas")];
  for (const canvas of canvases) {
    if (canvas.width < 50 || canvas.height < 30) continue;
    try {
      if (canvas.toDataURL("image/png").length > 6_000) return true;
    } catch {
      return true;
    }
  }
  return paths.length === 0 && !canvases.some((canvas) => canvas.width >= 50 && canvas.height >= 30);
}

const MARGIN = 16;

/**
 * Scrolls the element into view (below a fixed header) and says what to capture: the viewport clipped
 * to it with a margin, a full-page clip when it is up to two viewports tall, else the viewport at its top.
 */
export async function placeForShot(page: Page, element: ElementHandle, settleMs = 700, minHeight = 0): Promise<FocusShot> {
  let place = await element.evaluate(placeOf);
  const room = place.vh - place.top;
  const tall = place.h + MARGIN * 2 > room;
  const maxScroll = Math.max(0, place.docH - place.vh);
  const target = tall ? place.y - place.top - MARGIN : place.y + place.h / 2 - (place.top + room / 2);
  await page.evaluate(scrollToY, Math.max(0, Math.min(maxScroll, Math.round(target))));
  // Charts and lazy images draw once they are on screen.
  await page.waitForTimeout(settleMs);
  place = await element.evaluate(placeOf);
  const x = Math.max(0, place.x - MARGIN);
  const width = Math.max(1, Math.min(place.x + place.w + MARGIN, place.vw) - x);
  if (!tall) {
    // In viewport coordinates.
    let top = Math.max(place.top, place.y - place.scrollY - MARGIN);
    let bottom = Math.min(place.vh, place.y - place.scrollY + place.h + MARGIN);
    // A strip too thin to show anything (a grid that has not filled): more of the page above it, then below.
    if (bottom - top < minHeight) {
      top = Math.max(place.top, bottom - minHeight);
      bottom = Math.min(place.vh, top + minHeight);
    }
    if (bottom - top >= 20) return { clip: { x, y: top, width, height: bottom - top }, fullPage: false };
  }
  if (place.h <= place.vh * 2) {
    // A full-page clip in document coordinates: the fixed header stays above it.
    const y = Math.max(0, place.y - MARGIN);
    return { clip: { x, y, width, height: Math.min(place.docH, place.y + place.h + MARGIN) - y }, fullPage: true };
  }
  return { clip: { x, y: place.top, width, height: place.vh - place.top }, fullPage: false };
}
