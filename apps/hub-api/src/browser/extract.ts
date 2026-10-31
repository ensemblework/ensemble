/**
 * A page as a model reads it best (browser_extract, browser_view's text, browser_shop's fallback):
 * its main content as Markdown (headings, paragraphs, lists, tables as Markdown tables, links), the
 * products it describes in JSON-LD or microdata (`Product`, `Offer`, `AggregateOffer`, `ItemList`),
 * and the prices it shows. Reads HTML only (browser/html.ts), so the same code serves a Playwright tab
 * and a clean browser, where no page script runs. Menus, banners, ads, forms and hidden parts are left
 * out; links lose their tracking parameters.
 */
import { classes, collapse, descendants, hiddenByMarkup, parseHtml, querySelector, querySelectorAll, textOf, type HtmlElement, type HtmlNode } from "./html.js";
import { focusKind, focusWords } from "./focus.js";

export type Product = {
  name: string;
  price: number | null;
  currency: string | null;
  availability: string | null;
  url: string | null;
  brand?: string;
  rating?: number;
  source: "json-ld" | "microdata";
};

export type ShownPrice = { text: string; amount: number; currency: string; context: string };

export type Extracted = {
  title: string;
  markdown: string;
  /** The Markdown before cutting, in characters. */
  chars: number;
  truncated: boolean;
  products: Product[];
  prices: ShownPrice[];
  /** The part of the page the Markdown is of: "main", "article", "focus", "page". */
  part: string;
};

export type ExtractOptions = {
  /** The page's address, to make links absolute. */
  url?: string;
  maxChars?: number;
  /** Words naming the part wanted ("the price table", "specifications"). */
  focus?: string;
  /** Links as `[text](url)` (default), or their text only. */
  links?: boolean;
  /** Read the whole page, not only its main content. */
  whole?: boolean;
};

const DEFAULT_MAX = 12_000;

/** Never content: scripts, styles, frames, forms' controls, media without text. */
const SKIP = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "math",
  "canvas",
  "iframe",
  "object",
  "embed",
  "video",
  "audio",
  "map",
  "button",
  "select",
  "option",
  "optgroup",
  "datalist",
  "input",
  "textarea",
  "progress",
  "meter",
  "dialog",
  "link",
  "meta",
  "base",
]);
/** Page chrome, left out unless it is the part asked for. */
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside", "form"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "dialog", "alertdialog", "menu", "menubar", "toolbar", "tablist"]);
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "aside",
  "nav",
  "figure",
  "figcaption",
  "fieldset",
  "details",
  "summary",
  "address",
  "center",
  "dl",
  "dt",
  "dd",
  "hgroup",
  "body",
  "html",
  "form",
  "legend",
  "caption",
  "#document",
]);
const NOISE = /(?:^|[-_\s])(?:cookie|cookies|consent|gdpr|onetrust|cookiebot|truste|didomi|usercentrics|sp_message|newsletter-popup|modal-backdrop|skip-?link|skip-to|sr-only|visually-hidden|screen-reader|a11y-hidden|offscreen)(?:$|[-_\s])/i;
export const AD_LIKE = /(?:^|[-_\s])(?:ad|ads|adv|advert|adverts|advertisement|advertising|adslot|ad-slot|adunit|ad-unit|adbox|ad-box|adcontainer|ad-container|ad-wrapper|banner-ad|sponsor|sponsored|dfp|gpt-ad|googlead|google-ad|taboola|outbrain|promoted|sda|sdaContainer)(?:$|[-_\s\d])/i;

const TRACKING = /^(?:utm_[a-z_]+|ref|ref_|dib|dib_tag|qid|sr|crid|sprefix|keywords|pd_rd_[a-z]+|pf_rd_[a-z]+|psc|gclid|gclsrc|fbclid|msclkid|mc_cid|mc_eid|_encoding|content-id|sp_csd|spc|xpid|linkcode|tag|ascsubtag|hvadid|hvpos|hvnetw|hvrand|hvpone|hvptwo|hvqmt|hvdev|hvdvcmdl|hvlocint|hvlocphy|hvtargid|_trkparms|_trksid|hash|amdata|itmmeta|athcpid|athpgid|athznid|athieid|athena[a-z]*|cmp|icid|lnk|intcmp|cm_mmc|cm_ven|cm_cat|cm_pla|cm_ite|s_kwcid|ef_id|irclickid|clickid|sxin_[a-z0-9_]+|_ga|_gl|yclid|igshid)$/i;

/** A link as a reader wants it: absolute, http(s) or mailto, without tracking parameters; Amazon's products as /dp/ASIN. */
export function cleanLink(href: string | null | undefined, base?: string): string | null {
  if (!href) return null;
  const value = href.trim();
  if (!value || value.startsWith("#") || /^(?:javascript|data|blob|vbscript|about):/i.test(value)) return null;
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "mailto:" || url.protocol === "tel:") return url.toString();
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  const host = url.hostname.toLowerCase();
  // A click-tracking link that names where it goes (Walmart's /sp/track?rd=…): that address.
  for (const key of ["rd", "url", "redirect", "redirectUrl", "dest", "u"]) {
    const inner = url.searchParams.get(key);
    if (inner && /^(?:https?:\/\/|\/)/.test(inner) && /track|click|redirect|sspa|clk|aclk/i.test(url.pathname)) {
      const target = cleanLink(inner, url.origin);
      if (target) return target;
    }
  }
  if (/(^|\.)walmart\.com$/.test(host)) {
    const item = /\/ip\/(?:[^/]+\/)?(\d{5,})(?:[/?]|$)/.exec(url.pathname)?.[1];
    if (item) return `${url.origin}/ip/${item}`;
  }
  if (/(^|\.)ebay\.[a-z.]+$/.test(host)) {
    const item = /\/itm\/(?:[^/]+\/)?(\d{6,})(?:[/?]|$)/.exec(url.pathname)?.[1];
    if (item) return `https://${host.replace(/^ebay/, "www.ebay")}/itm/${item}`;
  }
  if (/(^|\.)amazon\.[a-z.]+$/.test(host)) {
    // Sponsored results go through /sspa/click?…&url=/dp/…
    const inner = url.pathname.startsWith("/sspa/click") ? url.searchParams.get("url") : null;
    const path = inner ? decodeURIComponent(inner) : url.pathname;
    const asin = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/.exec(path)?.[1];
    if (asin) return `${url.origin}/dp/${asin}`;
  }
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  let text = url.toString();
  if (text.endsWith("?")) text = text.slice(0, -1);
  return text;
}

// ── which part of the page ──────────────────────────────────────────────────

function isChrome(node: HtmlElement): boolean {
  if (CHROME_TAGS.has(node.tag)) return true;
  const role = node.attrs.role?.toLowerCase();
  return Boolean(role && CHROME_ROLES.has(role));
}

/** Whether an element sits in the page's navigation, header, footer or a sidebar. */
function inChrome(node: HtmlElement): boolean {
  for (let at: HtmlElement | null = node; at && at.tag !== "#document"; at = at.parent) if (isChrome(at) && at.tag !== "form") return true;
  return false;
}

function isNoise(node: HtmlElement): boolean {
  const id = node.attrs.id ?? "";
  const cls = node.attrs.class ?? "";
  if (NOISE.test(id) || NOISE.test(cls)) return true;
  if (AD_LIKE.test(id) || AD_LIKE.test(cls) || /^(?:google_ads|div-gpt-ad|aswift)/i.test(id)) return true;
  if (node.attrs["aria-modal"] === "true") return true;
  return false;
}

/** Text length of an element's readable content, counted cheaply (no chrome, no noise). */
function contentLength(node: HtmlElement): number {
  let total = 0;
  const stack: HtmlNode[] = [node];
  while (stack.length) {
    const at = stack.pop()!;
    if (at.type === "text") {
      total += at.text.replace(/\s+/g, " ").length;
      continue;
    }
    if (at !== node && (SKIP.has(at.tag) || hiddenByMarkup(at) || isChrome(at) || isNoise(at))) continue;
    for (const child of at.children) stack.push(child);
  }
  return total;
}

const MAIN_IDS = ["#main-content", "#maincontent", "#main", "#content", "#primary", "#mw-content-text", "#search", ".main-content", ".entry-content", ".article-body", ".post-content", ".article-content"];

/** The element holding the page's main content: `main`, the article, a known content box, else the body. */
export function mainContent(doc: HtmlElement): { node: HtmlElement; part: string } {
  const body = querySelector(doc, "body") ?? doc;
  for (const main of querySelectorAll(doc, "main, [role=main]")) {
    if (!hiddenByMarkup(main) && contentLength(main) >= 80) return { node: main, part: "main" };
  }
  const articles = querySelectorAll(doc, "article").filter((node) => !hiddenByMarkup(node));
  if (articles.length) {
    const sized = articles.map((node) => ({ node, size: contentLength(node) })).sort((a, b) => b.size - a.size);
    const total = contentLength(body);
    // One article that holds most of the page is the content; a list of article cards is not.
    if (sized[0]!.size >= 500 && (articles.length === 1 || sized[0]!.size >= total * 0.4)) return { node: sized[0]!.node, part: "article" };
  }
  for (const selector of MAIN_IDS) {
    const node = querySelector(doc, selector);
    if (node && !hiddenByMarkup(node) && contentLength(node) >= 300) return { node, part: "main" };
  }
  return { node: body, part: "page" };
}

const HEADING = /^h([1-6])$/;

/**
 * A heading's section in a flat page (Wikipedia's `h2` then paragraphs and tables as its siblings): the
 * heading and what follows it up to the next heading of its level or above, as one element.
 */
function headingSection(heading: HtmlElement): HtmlElement | null {
  const level = Number(HEADING.exec(heading.tag)?.[1] ?? 0);
  // A heading wrapped alone in a box (`<div class="mw-heading"><h2>…</h2></div>`) is that box.
  let start: HtmlElement = heading;
  while (start.parent && start.parent.tag !== "#document" && start.parent.tag !== "body" && start.parent.children.filter((child) => child.type === "element").length === 1) start = start.parent;
  const parent = start.parent;
  if (!parent || !level) return null;
  const siblings = parent.children;
  const children: HtmlNode[] = [];
  for (let index = siblings.indexOf(start); index < siblings.length; index += 1) {
    const node = siblings[index]!;
    if (node !== start && node.type === "element") {
      const inner = HEADING.test(node.tag) ? node : querySelector(node, "h1, h2, h3, h4, h5, h6");
      const innerLevel = inner && (inner === node || node.children.filter((child) => child.type === "element").length === 1) ? Number(HEADING.exec(inner.tag)?.[1] ?? 9) : 9;
      if (innerLevel <= level) break;
    }
    children.push(node);
  }
  return children.length > 1 ? { type: "element", tag: "section", attrs: {}, children, parent } : null;
}

/** The element a few words name ("price table", "specifications", "reviews"): by its heading, label, id or class and its kind; null when nothing fits. */
export function focusElement(doc: HtmlElement, focus: string): HtmlElement | null {
  const words = focusWords(focus);
  const kind = focusKind(focus);
  if (!words.length && !kind) return null;
  let best: { node: HtmlElement; score: number } | null = null;
  for (const heading of querySelectorAll(doc, "h1, h2, h3, h4, h5, h6")) {
    const text = textOf(heading).toLowerCase();
    const hits = words.filter((word) => text.includes(word)).length;
    if (!hits || hiddenByMarkup(heading)) continue;
    const section = headingSection(heading);
    if (!section) continue;
    const size = contentLength(section);
    if (size < 40) continue;
    const score = 10 * hits + 4 + (kind === "table" && querySelector(section, "table") ? 12 : 0) - Math.min(8, size / 4000);
    if (!best || score > best.score) best = { node: section, score };
  }
  for (const node of descendants(doc)) {
    if (SKIP.has(node.tag) || hiddenByMarkup(node)) continue;
    if (!/^(?:section|article|div|table|ul|ol|dl|figure|aside|main|details|form)$/.test(node.tag) && !node.attrs.role) continue;
    // Navigation boxes and collapsed parts are no answer, however well they match.
    if (/\b(?:navbox|mw-collapsed|collapsed|sidebar|breadcrumbs?)\b/i.test(node.attrs.class ?? "") || inChrome(node)) continue;
    const label = `${node.attrs["aria-label"] ?? ""} ${node.attrs.title ?? ""}`.toLowerCase();
    const names = `${node.attrs.id ?? ""} ${node.attrs.class ?? ""} ${node.attrs["data-testid"] ?? ""} ${node.attrs["data-test"] ?? ""}`.toLowerCase().replace(/[-_]/g, " ");
    const heading = headingOf(node).toLowerCase();
    let score = 0;
    let hits = 0;
    for (const word of words) {
      if (heading.includes(word)) score += 10;
      if (label.includes(word)) score += 10;
      if (names.includes(word)) score += 6;
      if (heading.includes(word) || label.includes(word) || names.includes(word)) hits += 1;
    }
    const table = node.tag === "table" || node.attrs.role === "table" || node.attrs.role === "grid";
    if (kind === "table" && table) score += 12 + Math.min(5, ownRows(node).length / 3);
    if (kind === "results" && (node.tag === "ul" || node.tag === "ol" || node.attrs.role === "list")) score += 4;
    if (score <= 0) continue;
    const size = contentLength(node);
    if (size < (table ? 10 : 40) || (!hits && size < 150)) continue;
    // Prefer the smallest element that carries the words: a section, not the whole page.
    score -= Math.min(8, size / 4000);
    if (!best || score > best.score) best = { node, score };
  }
  return best && best.score >= 8 ? best.node : null;
}

/** The heading an element starts with, or the one just before it. */
function headingOf(node: HtmlElement): string {
  const inside = querySelector(node, "h1, h2, h3, h4, h5, h6, caption, legend, [role=heading]");
  if (inside) return textOf(inside).slice(0, 160);
  const parent = node.parent;
  if (!parent) return "";
  const siblings = parent.children.filter((child): child is HtmlElement => child.type === "element");
  for (let index = siblings.indexOf(node) - 1, steps = 0; index >= 0 && steps < 3; index -= 1, steps += 1) {
    const sibling = siblings[index]!;
    if (/^h[1-6]$/.test(sibling.tag)) return textOf(sibling).slice(0, 160);
  }
  return "";
}

// ── Markdown ────────────────────────────────────────────────────────────────

type RenderContext = { base?: string; links: boolean; keepChrome: boolean };

function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]])/g, "\\$1");
}

/** Inline content of an element on one line: text, links as `[text](url)`, code in backticks. */
function inline(node: HtmlNode, ctx: RenderContext): string {
  if (node.type === "text") return escapeInline(node.text.replace(/[\s\u00a0]+/g, " "));
  if (SKIP.has(node.tag) || hiddenByMarkup(node) || (!ctx.keepChrome && isNoise(node))) return " ";
  if (node.tag === "br") return " ";
  if (node.tag === "img") {
    const alt = collapse(node.attrs.alt ?? "");
    return alt && alt.length <= 80 && node.parent?.tag === "a" && !textOf(node.parent) ? escapeInline(alt) : "";
  }
  const inner = node.children.map((child) => inline(child, ctx)).join("");
  if (node.tag === "a") {
    const text = collapse(inner);
    const href = ctx.links ? cleanLink(node.attrs.href, ctx.base) : null;
    if (!text) return "";
    return href && !href.startsWith("mailto:") ? `[${text}](${href})` : text;
  }
  if (node.tag === "code" || node.tag === "kbd" || node.tag === "samp") {
    const text = collapse(textOf(node));
    return text ? `\`${text.replace(/`/g, "'")}\`` : "";
  }
  if (node.tag === "sup") return inner.trim() ? `^${collapse(inner)}` : "";
  if (BLOCK.has(node.tag) || node.tag === "li" || node.tag === "tr" || /^h[1-6]$/.test(node.tag)) return ` ${inner} `;
  return inner;
}

function inlineText(node: HtmlElement, ctx: RenderContext): string {
  return collapse(inline(node, ctx)).replace(/\s+([,.;:!?])/g, "$1");
}

function cellText(node: HtmlElement, ctx: RenderContext): string {
  return inlineText(node, ctx).replace(/\|/g, "\\|").slice(0, 300);
}

function ownRows(table: HtmlElement): HtmlElement[] {
  const rows: HtmlElement[] = [];
  const stack: HtmlNode[] = [...table.children].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type !== "element") continue;
    if (node.tag === "table") continue;
    if (node.tag === "tr") {
      rows.push(node);
      continue;
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!);
  }
  return rows;
}

/** A table as a Markdown table; a layout table (one column, or cells full of blocks) as its blocks. */
function renderTable(table: HtmlElement, ctx: RenderContext): string[] {
  const rows = ownRows(table).filter((row) => !hiddenByMarkup(row));
  const cells = rows.map((row) => row.children.filter((cell): cell is HtmlElement => cell.type === "element" && (cell.tag === "td" || cell.tag === "th")));
  const width = Math.max(0, ...cells.map((row) => row.reduce((sum, cell) => sum + Math.min(10, Math.max(1, Number.parseInt(cell.attrs.colspan ?? "1", 10) || 1)), 0)));
  const nested = querySelectorAll(table, "table").length;
  if (width < 2 || nested > 0) return blocks(table, ctx, true);
  const lines: string[][] = [];
  for (const row of cells.slice(0, 300)) {
    const line: string[] = [];
    for (const cell of row) {
      line.push(cellText(cell, ctx));
      const span = Math.min(10, Math.max(1, Number.parseInt(cell.attrs.colspan ?? "1", 10) || 1));
      for (let extra = 1; extra < span; extra += 1) line.push("");
    }
    if (line.some((value) => value)) lines.push(line);
  }
  if (!lines.length) return [];
  const columns = Math.min(20, Math.max(...lines.map((line) => line.length)));
  const pad = (line: string[]) => {
    const cut = line.slice(0, columns);
    while (cut.length < columns) cut.push("");
    return `| ${cut.join(" | ")} |`;
  };
  const caption = querySelector(table, "caption");
  const out = [pad(lines[0]!), `|${" --- |".repeat(columns)}`, ...lines.slice(1).map(pad)];
  const title = caption ? inlineText(caption, ctx) : "";
  return [title ? `**${title}**\n\n${out.join("\n")}` : out.join("\n")];
}

function renderList(list: HtmlElement, ctx: RenderContext, depth: number): string {
  const ordered = list.tag === "ol";
  const lines: string[] = [];
  let number = Number.parseInt(list.attrs.start ?? "1", 10) || 1;
  const indent = "  ".repeat(depth);
  for (const item of list.children) {
    if (item.type !== "element" || item.tag !== "li" || hiddenByMarkup(item) || (!ctx.keepChrome && isNoise(item))) continue;
    const own: HtmlNode[] = [];
    const nested: HtmlElement[] = [];
    for (const child of item.children) {
      if (child.type === "element" && (child.tag === "ul" || child.tag === "ol")) nested.push(child);
      else own.push(child);
    }
    const holder: HtmlElement = { type: "element", tag: "span", attrs: {}, children: own, parent: item };
    const text = inlineText(holder, ctx);
    const marker = ordered ? `${number}.` : "-";
    number += 1;
    if (text) lines.push(`${indent}${marker} ${text}`);
    for (const sub of nested) {
      const rendered = renderList(sub, ctx, text ? depth + 1 : depth);
      if (rendered) lines.push(rendered);
    }
  }
  return lines.join("\n");
}

/** An element's content as Markdown blocks. */
function blocks(root: HtmlElement, ctx: RenderContext, inner = false): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    const text = collapse(run.join("")).replace(/\s+([,.;:!?])/g, "$1");
    if (text) out.push(text);
    run = [];
  };
  const visit = (node: HtmlNode) => {
    if (node.type === "text") {
      run.push(escapeInline(node.text.replace(/[\s\u00a0]+/g, " ")));
      return;
    }
    if (SKIP.has(node.tag) || hiddenByMarkup(node)) return;
    if (!ctx.keepChrome && (isChrome(node) || isNoise(node))) return;
    const tag = node.tag;
    if (/^h[1-6]$/.test(tag) || node.attrs.role === "heading") {
      flush();
      const text = inlineText(node, ctx);
      const level = /^h([1-6])$/.exec(tag)?.[1] ?? node.attrs["aria-level"] ?? "3";
      if (text) out.push(`${"#".repeat(Math.min(6, Math.max(1, Number(level) || 3)))} ${text}`);
      return;
    }
    if (tag === "ul" || tag === "ol") {
      flush();
      const list = renderList(node, ctx, 0);
      if (list) out.push(list);
      return;
    }
    if (tag === "table") {
      flush();
      out.push(...renderTable(node, ctx));
      return;
    }
    if (tag === "pre") {
      flush();
      const text = textOfPre(node);
      if (text.trim()) out.push(`\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\``);
      return;
    }
    if (tag === "blockquote") {
      flush();
      const quoted = blocks(node, ctx, true).join("\n\n");
      if (quoted) out.push(quoted.split("\n").map((line) => `> ${line}`).join("\n"));
      return;
    }
    if (tag === "hr") {
      flush();
      out.push("---");
      return;
    }
    if (tag === "br") {
      flush();
      return;
    }
    if (tag === "a" || tag === "code" || tag === "kbd" || tag === "img" || tag === "sup") {
      run.push(inline(node, ctx));
      return;
    }
    if (tag === "dt") {
      flush();
      const text = inlineText(node, ctx);
      if (text) out.push(`**${text}**`);
      return;
    }
    if (BLOCK.has(tag) || tag === "li" || tag === "tr" || tag === "td" || tag === "th") {
      flush();
      for (const child of node.children) visit(child);
      flush();
      return;
    }
    for (const child of node.children) visit(child);
  };
  if (inner) for (const child of root.children) visit(child);
  else visit(root);
  flush();
  return out;
}

function textOfPre(node: HtmlElement): string {
  const parts: string[] = [];
  const stack: HtmlNode[] = [node];
  while (stack.length) {
    const at = stack.pop()!;
    if (at.type === "text") parts.push(at.text);
    else if (at.tag === "br") parts.push("\n");
    else for (let index = at.children.length - 1; index >= 0; index -= 1) stack.push(at.children[index]!);
  }
  return parts.join("").replace(/^\n+|\s+$/g, "");
}

/** An element as Markdown. */
export function toMarkdown(node: HtmlElement, options: { url?: string; links?: boolean; keepChrome?: boolean } = {}): string {
  const ctx: RenderContext = { base: options.url, links: options.links !== false, keepChrome: Boolean(options.keepChrome) };
  const parts = blocks(node, ctx, node.tag === "#document" || node.tag === "body");
  // Repeated blocks (a menu printed twice, "Add to cart" on every card) say nothing new.
  const seen = new Map<string, number>();
  const kept: string[] = [];
  for (const part of parts) {
    const count = (seen.get(part) ?? 0) + 1;
    seen.set(part, count);
    if (part.length < 60 && count > 2) continue;
    kept.push(part);
  }
  return kept.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Markdown cut at a block or line boundary near `max`. */
export function cutMarkdown(markdown: string, max: number): { text: string; truncated: boolean } {
  if (markdown.length <= max) return { text: markdown, truncated: false };
  const paragraph = markdown.lastIndexOf("\n\n", max);
  const line = markdown.lastIndexOf("\n", max);
  const cut = paragraph > max * 0.7 ? paragraph : line > max * 0.7 ? line : max;
  return { text: `${markdown.slice(0, cut).trimEnd()}\n\n…`, truncated: true };
}

// ── products and prices ─────────────────────────────────────────────────────

const AVAILABILITY: Record<string, string> = {
  instock: "in stock",
  outofstock: "out of stock",
  preorder: "pre-order",
  presale: "pre-sale",
  backorder: "back-order",
  soldout: "sold out",
  discontinued: "discontinued",
  limitedavailability: "limited availability",
  onlineonly: "online only",
  instoreonly: "in store only",
  madetoorder: "made to order",
  reserved: "reserved",
};

/** schema.org availability (`https://schema.org/InStock`, `InStock`) in plain words. */
export function availabilityText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const key = value.trim().replace(/^https?:\/\/schema\.org\//i, "").replace(/[^a-z]/gi, "").toLowerCase();
  return AVAILABILITY[key] ?? (value.length <= 60 ? value.trim() : null);
}

/** A price as a number: 1299.99 from "1,299.99", "$1,299.99", "1.299,99 €", 1299.99. */
export function priceNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const digits = value.replace(/[^\d.,]/g, "");
  if (!/\d/.test(digits)) return null;
  let normal = digits;
  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  if (lastComma > lastDot) {
    // "1.299,99" or "1299,99": the comma is the decimal mark when two digits follow it.
    normal = /,\d{1,2}$/.test(digits) ? digits.replace(/\./g, "").replace(",", ".") : digits.replace(/,/g, "");
  } else {
    normal = digits.replace(/,/g, "");
    // "1.299" with no decimals is a thousands mark only when three digits follow and there is another dot.
    if ((normal.match(/\./g) ?? []).length > 1) normal = normal.replace(/\.(?=.*\.)/g, "");
  }
  const number = Number.parseFloat(normal);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function types(value: Record<string, unknown>): string[] {
  return asArray(value["@type"]).filter((item): item is string => typeof item === "string").map((item) => item.replace(/^https?:\/\/schema\.org\//i, ""));
}

function stringOf(value: unknown): string | null {
  if (typeof value === "string") return collapse(value) || null;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return stringOf(record.name ?? record["@value"] ?? null);
  }
  return null;
}

function offerOf(value: unknown): { price: number | null; currency: string | null; availability: string | null; url: string | null } {
  let best: { price: number | null; currency: string | null; availability: string | null; url: string | null } = { price: null, currency: null, availability: null, url: null };
  for (const raw of asArray(value)) {
    if (!raw || typeof raw !== "object") continue;
    const offer = raw as Record<string, unknown>;
    const spec = asArray(offer.priceSpecification)[0] as Record<string, unknown> | undefined;
    const price = priceNumber(offer.price ?? offer.lowPrice ?? spec?.price ?? null);
    const currency = stringOf(offer.priceCurrency ?? spec?.priceCurrency ?? null);
    const next = { price, currency: currency ? currency.toUpperCase().slice(0, 8) : null, availability: availabilityText(offer.availability), url: typeof offer.url === "string" ? offer.url : null };
    if (best.price === null || (next.price !== null && next.price < best.price)) best = next;
    // An AggregateOffer may list its offers.
    if (best.price === null && offer.offers) best = offerOf(offer.offers);
  }
  return best;
}

function productOf(value: Record<string, unknown>, base: string | undefined): Product | null {
  const name = stringOf(value.name);
  if (!name) return null;
  const offer = offerOf(value.offers);
  const rating = value.aggregateRating && typeof value.aggregateRating === "object" ? Number((value.aggregateRating as Record<string, unknown>).ratingValue) : Number.NaN;
  const url = cleanLink(typeof value.url === "string" ? value.url : typeof value["@id"] === "string" && /^https?:/.test(value["@id"] as string) ? (value["@id"] as string) : offer.url, base);
  const brand = stringOf(value.brand);
  return {
    name: name.slice(0, 300),
    price: offer.price,
    currency: offer.currency,
    availability: offer.availability,
    url,
    ...(brand ? { brand: brand.slice(0, 80) } : {}),
    ...(Number.isFinite(rating) ? { rating } : {}),
    source: "json-ld",
  };
}

/** Parses one JSON-LD script, forgiving what pages often get wrong (comments, CDATA, a trailing semicolon). */
function parseJsonLd(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^<!--|-->$/g, "")
    .replace(/^\/\*<!\[CDATA\[\*\/|\/\*\]\]>\*\/$/g, "")
    .replace(/;\s*$/, "")
    .trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      // Raw line breaks inside strings.
      return JSON.parse(trimmed.replace(/[\r\n\t]+/g, " "));
    } catch {
      return null;
    }
  }
}

/** Products in the page's JSON-LD (Product, ProductGroup, an ItemList of them) and microdata. */
export function structuredProducts(doc: HtmlElement, base?: string): Product[] {
  const found: Product[] = [];
  const seen = new Set<string>();
  const add = (product: Product | null) => {
    if (!product) return;
    const key = `${product.name.toLowerCase()}|${product.price ?? ""}|${product.url ?? ""}`;
    if (seen.has(key) || found.length >= 60) return;
    seen.add(key);
    found.push(product);
  };
  const walk = (value: unknown, depth: number) => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) walk(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const kinds = types(record);
    if (kinds.some((kind) => /^(?:Product|ProductGroup|IndividualProduct|ProductModel|Vehicle|Book|SoftwareApplication|VideoGame)$/.test(kind))) {
      add(productOf(record, base));
      if (kinds.includes("ProductGroup")) walk(record.hasVariant, depth + 1);
      return;
    }
    if (kinds.includes("ItemList") || record.itemListElement) {
      for (const item of asArray(record.itemListElement).slice(0, 100)) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Record<string, unknown>;
        if (entry.item && typeof entry.item === "object") walk(entry.item, depth + 1);
        else if (types(entry).some((kind) => kind !== "ListItem")) walk(entry, depth + 1);
      }
      return;
    }
    for (const key of ["@graph", "mainEntity", "itemOffered", "about", "offers"]) if (record[key] && key !== "offers") walk(record[key], depth + 1);
  };
  for (const script of querySelectorAll(doc, "script")) {
    if (!/ld\+json/i.test(script.attrs.type ?? "")) continue;
    const text = script.children.map((child) => (child.type === "text" ? child.text : "")).join("");
    if (text.length > 2_000_000) continue;
    walk(parseJsonLd(text), 0);
  }
  for (const scope of querySelectorAll(doc, "[itemtype]")) {
    if (!/schema\.org\/(?:Product|IndividualProduct)\b/i.test(scope.attrs.itemtype ?? "")) continue;
    const prop = (name: string): HtmlElement | null => querySelectorAll(scope, `[itemprop~="${name}"]`).find((node) => nearestScope(node) === scope) ?? null;
    const value = (node: HtmlElement | null) => (node ? (node.attrs.content ?? node.attrs.href ?? node.attrs.src ?? textOf(node)) : null);
    const name = collapse(value(prop("name")) ?? "");
    if (!name) continue;
    const offerScope = prop("offers");
    const inOffer = (field: string) => {
      const node = offerScope ? (querySelectorAll(offerScope, `[itemprop~="${field}"]`)[0] ?? null) : prop(field);
      return value(node);
    };
    add({
      name: name.slice(0, 300),
      price: priceNumber(inOffer("price") ?? inOffer("lowPrice")),
      currency: (inOffer("priceCurrency") ?? "").toUpperCase().slice(0, 8) || null,
      availability: availabilityText(inOffer("availability")),
      url: cleanLink(value(prop("url")), base),
      source: "microdata",
    });
  }
  return found;
}

function nearestScope(node: HtmlElement): HtmlElement | null {
  for (let at = node.parent; at; at = at.parent) if ("itemscope" in at.attrs || at.attrs.itemtype) return at;
  return null;
}

const CURRENCY_CODES: Array<[RegExp, string]> = [
  [/^(?:US\s?\$|USD)/i, "USD"],
  [/^(?:CA\$|C\$|CAD)/i, "CAD"],
  [/^(?:AU\$|A\$|AUD)/i, "AUD"],
  [/^(?:NZ\$|NZD)/i, "NZD"],
  [/^(?:HK\$|HKD)/i, "HKD"],
  [/^(?:S\$|SGD)/i, "SGD"],
  [/^(?:R\$|BRL)/i, "BRL"],
  [/^(?:MX\$|MXN)/i, "MXN"],
  [/^(?:€|EUR)/i, "EUR"],
  [/^(?:£|GBP)/i, "GBP"],
  [/^(?:₹|Rs\.?|INR)/i, "INR"],
  [/^(?:¥|JPY)/i, "JPY"],
  [/^(?:CHF)/i, "CHF"],
  [/^\$/, "USD"],
];

/** Amounts with a currency, as pages show them: "$499.99", "US $1,299", "₹49,990", "€ 89,99", "89,99 €". */
const PRICE = /(?:US\s?\$|CA\$|C\$|AU\$|A\$|NZ\$|HK\$|S\$|R\$|MX\$|\$|€|£|¥|₹|Rs\.?\s?|(?:USD|EUR|GBP|INR|CAD|AUD|JPY|CHF)\s?)\s?\d{1,3}(?:[,.\u00a0\u202f ]\d{3})*(?:[.,]\d{1,2})?(?!\d)|\d{1,3}(?:[.\u00a0\u202f ]\d{3})*(?:,\d{2})\s?€/g;

/** Prices a text shows, each with its line for context (at most `limit`). */
export function shownPrices(text: string, limit = 30): ShownPrice[] {
  const out: ShownPrice[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (out.length >= limit) break;
    for (const match of line.matchAll(PRICE)) {
      const raw = match[0].trim();
      const suffixEuro = /€$/.test(raw);
      const currency = suffixEuro ? "EUR" : (CURRENCY_CODES.find(([pattern]) => pattern.test(raw))?.[1] ?? "USD");
      const amount = priceNumber(raw);
      if (amount === null || amount <= 0) continue;
      const context = collapse(line.replace(/\]\([^)]*\)/g, "]").replace(/[[\]]/g, "")).slice(0, 160);
      const key = `${raw}|${context}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: raw.replace(/\s+/g, " "), amount, currency, context });
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ── the whole page ──────────────────────────────────────────────────────────

/** The page's title: `<title>`, else its first `h1`. */
export function pageTitle(doc: HtmlElement): string {
  const title = querySelector(doc, "title");
  const text = title ? textOf(title) : "";
  return (text || textOf(querySelector(doc, "h1"))).slice(0, 300);
}

/** A page's readable content, products and prices, from its HTML. */
export function extractHtml(html: string | HtmlElement, options: ExtractOptions = {}): Extracted {
  const doc = typeof html === "string" ? parseHtml(html) : html;
  const max = Math.min(Math.max(500, options.maxChars ?? DEFAULT_MAX), 100_000);
  let target: { node: HtmlElement; part: string } | null = null;
  if (options.focus) {
    const node = focusElement(doc, options.focus);
    if (node) target = { node, part: "focus" };
  }
  target ??= options.whole ? { node: querySelector(doc, "body") ?? doc, part: "page" } : mainContent(doc);
  let markdown = toMarkdown(target.node, { url: options.url, links: options.links, keepChrome: target.part === "focus" });
  // A main element that says little (a shell the page fills elsewhere): read the whole page.
  if (markdown.length < 200 && (target.part === "main" || target.part === "article")) {
    const whole = toMarkdown(querySelector(doc, "body") ?? doc, { url: options.url, links: options.links });
    if (whole.length > Math.max(markdown.length * 3, 200)) {
      markdown = whole;
      target = { node: target.node, part: "page" };
    }
  }
  const cut = cutMarkdown(markdown, max);
  return { title: pageTitle(doc), markdown: cut.text, chars: markdown.length, truncated: cut.truncated, products: structuredProducts(doc, options.url), prices: shownPrices(markdown), part: target.part };
}

/** Whether an element's markup puts it in an ad. */
export function adLike(node: HtmlElement): boolean {
  return AD_LIKE.test(node.attrs.id ?? "") || classes(node).some((name) => AD_LIKE.test(name));
}

