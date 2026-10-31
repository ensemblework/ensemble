/**
 * The runtime's web tools for small models (C1): `browser_view` (open, clean, set the place, screenshot
 * what was asked for, a text excerpt, in one call), `browser_fetch` (a file with the browser's cookies,
 * into evidence), `browser_extract` (a page as Markdown with its products and prices) and
 * `browser_set_location`. Each works for one operation through the broker, under its rules: the
 * operation's own tabs, its evidence folder, the owner's privacy rules, and the internet off when the
 * work has it off. A site that refuses the work's browser (HTTP/2 or connection errors, Access Denied,
 * an empty page) is read once more in a clean browser, read-only (browser/clean-view.ts).
 */
import { writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Page } from "playwright-core";
import { reserveFile, slugName, stillFile, type MediaFile } from "../capture/media.js";
import { sniffMime } from "../evidence/limits.js";
import type { EvidenceKind } from "../remote/contract.js";
import { BrowserError, checkUrl, isLoopbackUrl, type BrowserBroker } from "./broker.js";
import { cleanPage } from "./hygiene.js";
import { extractHtml, type Extracted } from "./extract.js";
import { humanCheck } from "./human-check.js";
import { parseHtml, querySelectorAll, textOf } from "./html.js";
import { bestBuyUrl, isAmazon, isBestBuy, resolveLocation, setAmazonLocation, setGeolocation, setSiteLocation, amazonHostFor, type LocationSet, type Place } from "./location.js";
import { findSecrets, hideSecrets, holdReason, siteRule } from "./privacy.js";

const MB = 1024 * 1024;
const VIEW_TEXT = 6_000;

/** Errors of a site that refuses the work's browser, not of an address that does not exist. */
export const REFUSED_LOAD = /ERR_HTTP2_PROTOCOL_ERROR|ERR_QUIC_PROTOCOL_ERROR|ERR_CONNECTION_(?:RESET|CLOSED|ABORTED)|ERR_EMPTY_RESPONSE|ERR_SSL_PROTOCOL_ERROR|ERR_TIMED_OUT|ERR_BLOCKED_BY_RESPONSE|ERR_INVALID_RESPONSE|Timeout \d+ms exceeded/i;

/** Why a loaded page is not the site (it refused automated browsing, or stayed empty), or null. */
export async function refusedPage(page: Page, status: number | null): Promise<string | null> {
  const title = (await page.title().catch(() => "")).trim();
  const text = (await page.locator("body").innerText({ timeout: 2_500 }).catch(() => "")).trim();
  const both = `${title}\n${text}`;
  // A short 403 or 429 page is a refusal whatever it says ("Sorry, something went wrong" on eBay).
  if (status !== null && (status === 403 || status === 429) && text.length < 1_500) return `the site refused automated browsing (HTTP ${status})`;
  if (status !== null && [401, 403, 406, 429].includes(status) && text.length < 4_000 && /access denied|forbidden|not authori[sz]ed|blocked|request unsuccessful|edgesuite|reference #|incident id|unusual activity|too many requests|\bbot\b/i.test(both)) {
    return `the site refused automated browsing (HTTP ${status})`;
  }
  if (/^access denied$/i.test(title) || (/^access denied\b/i.test(text) && text.length < 1_000)) return "the site refused automated browsing (Access Denied)";
  const empty = async () => (await page.locator("body").innerText({ timeout: 2_500 }).catch(() => "")).replace(/\s+/g, "").length < 40 && !(await page.locator("img, canvas, svg, video, iframe").count().catch(() => 0));
  // A page that draws itself late gets two more seconds.
  if ((await empty()) && (await page.waitForTimeout(2_000).then(empty, () => true))) return "the page stayed empty";
  return null;
}

// ── evidence written here ───────────────────────────────────────────────────

/** A PNG from the clean browser as a capture, held when its page shows a secret or the owner previews the site. */
export async function saveCleanShot(broker: BrowserBroker, operation: string, png: Buffer, input: { name?: string; url: string; title: string; text: string }): Promise<MediaFile> {
  const rules = await broker.privacyRules();
  const path = await reserveFile(broker.evidenceFolder(operation), slugName(input.name, "view"), "png");
  await writeFile(path, png, { mode: 0o600 });
  const still = await stillFile(path);
  const reason = siteRule(input.url, rules) === "preview" ? "The owner asked to see captures of this site before they are sent." : holdReason(findSecrets(`${input.title}\n${input.text}`, rules));
  return { ...still, kind: "image", held: Boolean(reason), ...(reason ? { reason } : {}), masked: 0, url: await broker.readableUrl(input.url), title: hideSecrets(input.title, rules) };
}

// ── browser_view ────────────────────────────────────────────────────────────

export type ViewInput = { url: string; focus?: string; fullPage?: boolean; location?: string; name?: string; profile?: string };

export type ViewResult = {
  tab?: string;
  url: string;
  title: string;
  mode: "browser" | "clean";
  text: string;
  textTruncated: boolean;
  humanCheck?: boolean;
  humanCheckKind?: string;
  focus?: string;
  focusFound?: boolean;
  focusOn?: string;
  dismissed?: string[];
  location?: { label: string; zip?: string; country: string; shown: string; note?: string };
  status?: number | null;
  /** Why the work's browser could not show it (the clean browser did). */
  blocked?: string;
  note?: string;
  file: MediaFile | null;
};

/** The place for a location the owner named, or a clear refusal. */
export function placeFor(location: string): Place {
  const place = resolveLocation(location);
  if (!place) throw new BrowserError("bad_input", `“${location.slice(0, 80)}” is not a place Ensemble knows: give a US state, city or ZIP (“Wisconsin”, “Madison, WI”, “53703”) or a country (“India”).`);
  return place;
}

function textExcerpt(html: string, url: string, focus: string | undefined, max: number, rules: Parameters<typeof hideSecrets>[1]): { text: string; truncated: boolean; extracted: Extracted } {
  let extracted = extractHtml(html, { url, maxChars: max, links: false, ...(focus ? { focus } : {}) });
  if (focus && extracted.markdown.length < 300) extracted = extractHtml(html, { url, maxChars: max, links: false });
  return { text: hideSecrets(extracted.markdown, rules), truncated: extracted.truncated, extracted };
}

/** browser_view in a clean browser: read-only, no tab. */
async function viewClean(broker: BrowserBroker, operation: string, input: ViewInput, url: string, blocked: string): Promise<ViewResult> {
  const read = await broker.cleanReader().read(input.profile ?? "default", url, { screenshot: true, fullPage: input.fullPage });
  if (read.error && !read.html) throw new BrowserError("failed", `The site refused the browser (${blocked}), and a clean browser could not open it either: ${read.error}`);
  const rules = await broker.privacyRules();
  if (siteRule(read.url, rules) === "never") throw new BrowserError("refused", "The owner marked this site as never captured.");
  const doc = parseHtml(read.html);
  const excerpt = textExcerpt(read.html, read.url, input.focus, VIEW_TEXT, rules);
  const frames = querySelectorAll(doc, "iframe[src]").map((frame) => frame.attrs.src ?? "");
  const check = humanCheck({ title: read.title, text: textOf(doc).slice(0, 6_000), frames, status: null });
  const file = read.png ? await saveCleanShot(broker, operation, read.png, { name: input.name ?? input.focus, url: read.url, title: read.title, text: excerpt.text }) : null;
  return {
    url: await broker.readableUrl(read.url),
    title: hideSecrets(read.title, rules),
    mode: "clean",
    text: excerpt.text,
    textTruncated: excerpt.truncated,
    ...(check ? { humanCheck: true, humanCheckKind: check } : {}),
    ...(input.focus ? { focus: input.focus, focusFound: false } : {}),
    blocked,
    note: "A read-only view in a clean browser: the site refused the work's browser. There is no tab to act in.",
    file,
  };
}

/** browser_view: one call for "show me this page". */
export async function viewPage(broker: BrowserBroker, operation: string, input: ViewInput): Promise<ViewResult> {
  let url = checkUrl(input.url);
  if (broker.loopbackOnly(operation) && !isLoopbackUrl(url)) throw new BrowserError("refused", "This work has the internet off: the browser opens only this computer's own addresses (localhost).");
  const place = input.location ? placeFor(input.location) : null;
  if (place && isBestBuy(url) && place.country === "US") url = bestBuyUrl(url);
  if (place) await setGeolocation(await broker.browserContext(operation, { profile: input.profile }), place, new URL(url).origin);
  const opened = await broker.open(operation, url, { profile: input.profile, clean: true });
  const page = broker.pageFor(operation, opened.tab);
  if (opened.error && REFUSED_LOAD.test(opened.error) && !broker.loopbackOnly(operation)) {
    await broker.close(operation, opened.tab).catch(() => undefined);
    return viewClean(broker, operation, input, url, opened.error);
  }
  if (opened.error) throw new BrowserError("failed", `The page did not load: ${opened.error}`);
  await page.waitForLoadState("load", { timeout: 4_000 }).catch(() => undefined);
  let location: ViewResult["location"];
  if (place) {
    const set: LocationSet = isAmazon(page.url()) ? await setAmazonLocation(broker.actPage(operation, opened.tab), place) : { ok: true, shown: "", how: "geolocation", note: "Only the browser's location is set: this site's prices are its national online prices." };
    location = { label: place.label, ...(place.zip ? { zip: place.zip } : {}), country: place.country, shown: set.shown, ...(set.note ? { note: set.note } : {}) };
    if (set.how !== "already" && set.how !== "geolocation") await cleanPage(page, { moment: "load", budgetMs: 1_500 });
  }
  const check = await broker.humanCheck(operation, opened.tab, { status: opened.status }).catch(() => null);
  const refused = check ? null : await refusedPage(page, opened.status);
  if ((check || refused) && !broker.loopbackOnly(operation)) {
    const clean = await viewClean(broker, operation, input, url, check ?? refused!).catch(() => null);
    if (clean && !clean.humanCheck && clean.text.length >= 200) {
      // The clean browser got through: its view, and the tab kept for the owner if the work must act there.
      return { ...clean, ...(check ? { tab: opened.tab, note: `The work's browser got ${check} (tab ${opened.tab} kept for browser_login_needed if you must act on the site); this view is read-only from a clean browser.` } : {}) };
    }
    if (refused && !check) await broker.close(operation, opened.tab).catch(() => undefined);
    if (refused && !check) throw new BrowserError("failed", `The site refused the browser (${refused}), and a clean browser could not get through either.`);
  }
  const file = await broker.screenshot(operation, opened.tab, { focus: input.focus, fullPage: input.fullPage, name: input.name ?? input.focus, clean: false });
  const rules = await broker.privacyRules();
  const html = await page.content().catch(() => "");
  const excerpt = textExcerpt(html, page.url(), input.focus, VIEW_TEXT, rules);
  return {
    tab: opened.tab,
    url: file.url ?? opened.url,
    title: file.title ?? opened.title,
    mode: "browser",
    text: excerpt.text,
    textTruncated: excerpt.truncated,
    ...(check ? { humanCheck: true, humanCheckKind: check } : {}),
    ...(file.focus !== undefined ? { focus: file.focus, focusFound: file.focusFound, ...(file.focusOn ? { focusOn: file.focusOn } : {}) } : {}),
    ...(opened.dismissed?.length ? { dismissed: opened.dismissed } : {}),
    ...(location ? { location } : {}),
    status: opened.status,
    file,
  };
}

// ── browser_fetch ───────────────────────────────────────────────────────────

export type FetchResult = { path: string; name: string; mime: string; size: number; bytes: number; kind: EvidenceKind; url: string; status: number };

const EXTENSION: Record<string, string> = {
  "application/pdf": "pdf",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "application/zip": "zip",
  "application/gzip": "gz",
};

/** The evidence kind for a fetched file: documents are reports, then images, videos, anything else a file. */
export function fetchedKind(mime: string): EvidenceKind {
  if (mime === "application/pdf" || mime === "text/markdown" || mime === "text/plain" || mime === "text/csv" || mime === "application/json") return "report";
  if (mime.startsWith("image/") && mime !== "image/svg+xml") return "image";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

/** A file name from Content-Disposition (`filename*=UTF-8''…` or `filename="…"`), else from the address. */
export function fetchedName(disposition: string | undefined, url: string): string {
  const star = disposition ? /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/i.exec(disposition)?.[1] : undefined;
  const plain = disposition ? /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)?.[1] : undefined;
  let name = "";
  try {
    name = star ? decodeURIComponent(star.trim()) : plain ? plain.trim() : decodeURIComponent(basename(new URL(url).pathname));
  } catch {
    name = plain?.trim() ?? "";
  }
  return basename(name.replace(/[\\/]/g, "_")).replace(/[\x00-\x1f"<>|*?:]/g, "").slice(0, 150) || "download";
}

/** browser_fetch: downloads a URL with the browser's cookies into the operation's evidence folder. */
export async function fetchUrl(broker: BrowserBroker, operation: string, input: { url: string; name?: string; tab?: string; profile?: string }): Promise<FetchResult> {
  const url = checkUrl(input.url);
  if (url === "about:blank") throw new BrowserError("bad_input", "Give the file's address.");
  if (broker.loopbackOnly(operation) && !isLoopbackUrl(url)) throw new BrowserError("refused", "This work has the internet off: only this computer's own addresses (localhost).");
  const rules = await broker.privacyRules();
  if (siteRule(url, rules) === "never") throw new BrowserError("refused", "The owner marked this site as never captured.");
  const context = await broker.browserContext(operation, { tab: input.tab, profile: input.profile });
  let response;
  try {
    response = await context.request.get(url, { timeout: 90_000, maxRedirects: 10, failOnStatusCode: false, headers: { Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8" } });
  } catch (error) {
    throw new BrowserError("failed", `Could not download it: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]!.replace(/^apiRequestContext\.get: /, "")}`);
  }
  try {
    const status = response.status();
    if (status >= 400) throw new BrowserError("failed", `The address answered ${status} ${response.statusText()}`.trim() + (status === 401 || status === 403 ? ": it may need a sign-in (open it with browser_open first) or block downloads." : "."));
    const headers = response.headers();
    const declared = (headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const length = Number(headers["content-length"] ?? "0");
    const limit = declared.startsWith("video/") ? 100 * MB : 20 * MB;
    if (length > limit) throw new BrowserError("refused", `That file is ${(length / MB).toFixed(1)} MB; files up to ${limit / MB} MB are kept.`);
    const body = await response.body();
    const final = response.url();
    let name = input.name?.trim() ? basename(input.name.trim().replace(/[\\/]/g, "_")).slice(0, 150) : fetchedName(headers["content-disposition"], final);
    const mime = sniffMime(body, name);
    if (mime === "text/html" || mime === "application/xhtml+xml") {
      throw new BrowserError("bad_input", "That address answered with a web page, not a file (it may need a sign-in, or the file's own link is on that page). Look at it with browser_view, or read it with browser_extract, and fetch the file's direct link.");
    }
    const sizeLimit = mime.startsWith("video/") ? 100 * MB : 20 * MB;
    if (body.length > sizeLimit) throw new BrowserError("refused", `That file is ${(body.length / MB).toFixed(1)} MB; files up to ${sizeLimit / MB} MB are kept.`);
    const wanted = EXTENSION[mime];
    if (wanted && extname(name).slice(1).toLowerCase() !== wanted && !(wanted === "jpg" && /^jpe?g$/i.test(extname(name).slice(1)))) name = `${name.replace(/\.[a-z0-9]{1,5}$/i, "")}.${wanted}`;
    const extension = extname(name).slice(1).replace(/[^\w]/g, "").slice(0, 10) || "bin";
    const path = await reserveFile(broker.evidenceFolder(operation), slugName(basename(name, extname(name)), "download"), extension);
    await writeFile(path, body, { mode: 0o600 });
    return { path, name, mime, size: body.length, bytes: body.length, kind: fetchedKind(mime), url: await broker.readableUrl(final), status };
  } finally {
    await response.dispose().catch(() => undefined);
  }
}

const FILE_PATH = /\.(?:pdf|csv|tsv|zip|gz|json|txt|md|docx?|xlsx?|pptx?|odt|ods|png|jpe?g|gif|webp|mp4|webm|mov|mp3|wav|epub)$/i;

/** The address of the file a tab shows (Chromium's PDF viewer, a file address) when no download is pending, else null. */
export async function fileOnTab(broker: BrowserBroker, operation: string, tab: string): Promise<string | null> {
  const page = broker.pageFor(operation, tab);
  const url = page.url();
  let path = "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    path = parsed.pathname;
  } catch {
    return null;
  }
  const type = await page.evaluate(() => (globalThis as unknown as { document: { contentType?: string } }).document.contentType ?? "").catch(() => "");
  if (type && type !== "text/html" && type !== "application/xhtml+xml") return url;
  if (await page.locator("embed[type='application/pdf'], embed[type='application/x-google-chrome-pdf']").count().catch(() => 0)) return url;
  return FILE_PATH.test(path) && type !== "text/html" ? url : null;
}

// ── browser_extract ─────────────────────────────────────────────────────────

export type ExtractResult = {
  tab?: string;
  url: string;
  title: string;
  mode: "browser" | "clean";
  markdown: string;
  truncated: boolean;
  chars: number;
  part: string;
  products: Extracted["products"];
  prices: Extracted["prices"];
  humanCheck?: boolean;
  humanCheckKind?: string;
  dismissed?: string[];
};

function sealed(extracted: Extracted, rules: Parameters<typeof hideSecrets>[1]): Pick<ExtractResult, "markdown" | "products" | "prices" | "title" | "truncated" | "chars" | "part"> {
  return {
    title: hideSecrets(extracted.title, rules),
    markdown: hideSecrets(extracted.markdown, rules),
    truncated: extracted.truncated,
    chars: extracted.chars,
    part: extracted.part,
    products: extracted.products.map((product) => ({ ...product, name: hideSecrets(product.name, rules) })),
    prices: extracted.prices.map((price) => ({ ...price, context: hideSecrets(price.context, rules) })),
  };
}

/** browser_extract: a page (a tab, or an address opened first) as Markdown with its products and prices. */
export async function extractPage(broker: BrowserBroker, operation: string, input: { tab?: string; url?: string; focus?: string; maxChars?: number; profile?: string }): Promise<ExtractResult> {
  if (!input.tab && !input.url) throw new BrowserError("bad_input", "Give a tab, or a url to open first.");
  const rules = await broker.privacyRules();
  const options = { maxChars: input.maxChars ?? 12_000, ...(input.focus ? { focus: input.focus } : {}) };
  let tab = input.tab;
  let dismissed: string[] | undefined;
  let status: number | null = null;
  if (!tab) {
    const url = checkUrl(input.url!);
    if (broker.loopbackOnly(operation) && !isLoopbackUrl(url)) throw new BrowserError("refused", "This work has the internet off: the browser opens only this computer's own addresses (localhost).");
    const opened = await broker.open(operation, url, { profile: input.profile, clean: true });
    const blockedLoad = opened.error && REFUSED_LOAD.test(opened.error) && !broker.loopbackOnly(operation) ? opened.error : null;
    if (opened.error && !blockedLoad) throw new BrowserError("failed", `The page did not load: ${opened.error}`);
    let refused = blockedLoad;
    if (!refused) {
      await broker.pageFor(operation, opened.tab).waitForLoadState("load", { timeout: 4_000 }).catch(() => undefined);
      refused = await refusedPage(broker.pageFor(operation, opened.tab), opened.status);
    }
    if (refused && !broker.loopbackOnly(operation)) {
      await broker.close(operation, opened.tab).catch(() => undefined);
      const read = await broker.cleanReader().read(input.profile ?? "default", url, { screenshot: false });
      if (read.error && !read.html) throw new BrowserError("failed", `The site refused the browser (${refused}), and a clean browser could not open it either: ${read.error}`);
      if (siteRule(read.url, rules) === "never") throw new BrowserError("refused", "The owner marked this site as never captured, so it cannot be read either.");
      const doc = parseHtml(read.html);
      const check = humanCheck({ title: read.title, text: textOf(doc).slice(0, 6_000), frames: querySelectorAll(doc, "iframe[src]").map((frame) => frame.attrs.src ?? ""), status: null });
      return { url: await broker.readableUrl(read.url), mode: "clean", ...sealed(extractHtml(doc, { url: read.url, ...options }), rules), ...(check ? { humanCheck: true, humanCheckKind: check } : {}) };
    }
    tab = opened.tab;
    dismissed = opened.dismissed;
    status = opened.status;
  }
  const page = broker.pageFor(operation, tab);
  if (siteRule(page.url(), rules) === "never") throw new BrowserError("refused", "The owner marked this site as never captured, so it cannot be read either.");
  const check = await broker.humanCheck(operation, tab, { status }).catch(() => null);
  const html = await page.content().catch((error: unknown) => {
    throw new BrowserError("failed", `Could not read the page: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  });
  return {
    tab,
    url: await broker.readableUrl(page.url()),
    mode: "browser",
    ...sealed(extractHtml(html, { url: page.url(), ...options }), rules),
    ...(check ? { humanCheck: true, humanCheckKind: check } : {}),
    ...(dismissed?.length ? { dismissed } : {}),
  };
}

// ── browser_set_location ────────────────────────────────────────────────────

const SITE_HOMES: Record<string, string> = {
  amazon: "https://www.amazon.com/",
  bestbuy: "https://www.bestbuy.com/?intl=nosplash",
  walmart: "https://www.walmart.com/",
  target: "https://www.target.com/",
  costco: "https://www.costco.com/",
  ebay: "https://www.ebay.com/",
  newegg: "https://www.newegg.com/",
  gamestop: "https://www.gamestop.com/",
  bhphotovideo: "https://www.bhphotovideo.com/",
};

/** A site's home page from its name ("amazon", "bestbuy.com", "https://…"); Amazon's for the place's country. */
export function siteHome(site: string, place: Place): string {
  const key = site.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\.com\/?$/, "").replace(/[\s&-]+/g, "");
  if (key === "amazon" || key === "amazoncom") {
    const host = place.country === "US" ? "www.amazon.com" : (amazonHostFor(place.country) ?? "www.amazon.com");
    return `https://${host}/`;
  }
  const known = SITE_HOMES[key === "bh" || key === "bhphoto" || key === "b&h" ? "bhphotovideo" : key];
  if (known) return known;
  return checkUrl(/^https?:\/\//i.test(site.trim()) ? site.trim() : `https://${site.trim()}`);
}

export type SetLocationResult = { location: string; zip?: string; city?: string; state?: string; country: string; shown: string; site?: string; tab?: string; how: string; ok: boolean; note?: string };

/** browser_set_location: the place for a tab's site, a named site (opened first), or the browser's location only. */
export async function setLocation(broker: BrowserBroker, operation: string, input: { tab?: string; location: string; site?: string; profile?: string }): Promise<SetLocationResult> {
  const place = placeFor(input.location);
  const base = { location: place.label, ...(place.zip ? { zip: place.zip } : {}), ...(place.city ? { city: place.city } : {}), ...(place.state ? { state: place.state } : {}), country: place.country };
  let tab = input.tab;
  if (!tab && input.site) {
    const home = siteHome(input.site, place);
    if (broker.loopbackOnly(operation) && !isLoopbackUrl(home)) throw new BrowserError("refused", "This work has the internet off: the browser opens only this computer's own addresses (localhost).");
    const opened = await broker.open(operation, home, { profile: input.profile, clean: true });
    if (opened.error) throw new BrowserError("failed", `${home} did not load: ${opened.error}`);
    tab = opened.tab;
  }
  if (!tab) {
    await setGeolocation(await broker.browserContext(operation, { profile: input.profile }), place);
    return { ...base, shown: "", how: "geolocation", ok: true, note: `The browser's location is now ${place.label}. Sites use it only when they ask; Amazon needs site "amazon" (or its tab) for its delivery ZIP.${place.note ? ` ${place.note}` : ""}` };
  }
  const set = await setSiteLocation(broker.actPage(operation, tab), place);
  return { ...base, shown: set.shown, site: set.site, tab, how: set.how, ok: set.ok, ...(set.note || place.note ? { note: [set.note, place.note].filter(Boolean).join(" ") } : {}) };
}
