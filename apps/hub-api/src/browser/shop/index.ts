/**
 * `browser_shop` (C1): one call for "what does X cost at these stores". Each store's search page opens
 * in the operation's own tab (up to three at once), is cleaned, gets the delivery place where the
 * store takes one (Amazon's ZIP), and is read: its offers (recipe, else structured data, else prices
 * next to product links), a screenshot of its results area, and its status: `ok`, `human_check` (the
 * tab is kept for the owner to pass it), `blocked` (after a read-only try in a clean browser),
 * `no_results` (with the page's text) or `error`. A place is always set for US stores: without one,
 * amazon.com shows "Deliver to India" and no prices to a computer abroad.
 */
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import type { MediaFile } from "../../capture/media.js";
import { BrowserError, isLoopbackUrl, type BrowserBroker } from "../broker.js";
import { extractHtml } from "../extract.js";
import { humanCheck } from "../human-check.js";
import { cleanPage } from "../hygiene.js";
import { parseHtml, querySelector, querySelectorAll, textOf, type HtmlElement } from "../html.js";
import { amazonHostFor, resolveLocation, setAmazonLocation, setGeolocation, type Place } from "../location.js";
import { hideSecrets, siteRule } from "../privacy.js";
import { placeFor, REFUSED_LOAD, refusedPage, saveCleanShot } from "../web.js";
import { rankOffers, storeOffers, type Offer } from "./offers.js";
import { DEFAULT_STORES, genericRecipe, recipeFor, type StoreRecipe } from "./recipes.js";

export type ShopInput = { query: string; stores?: string[]; location?: string; max?: number; profile?: string };

export type StoreStatus = "ok" | "human_check" | "blocked" | "no_results" | "error";

export type StoreResult = {
  store: string;
  name: string;
  status: StoreStatus;
  note?: string;
  url: string;
  offers: Offer[];
  /** The screenshot's file name (its evidence id once kept). */
  screenshot?: string;
  /** The page's text, when no offer could be read (at most 3,000 characters). */
  text?: string;
  mode?: "browser" | "clean";
  /** A tab kept for the owner (a human check). */
  tab?: string;
  /** Where the store says it delivers ("Madison 53703"). */
  shown?: string;
};

export type ShopResult = {
  query: string;
  location: { label: string; zip?: string; country: string; note?: string } | null;
  stores: StoreResult[];
  /** One screenshot per store, for the work's evidence. */
  files: MediaFile[];
};

export type ShopOptions = {
  /** Tests: a store's origin replaced (`{amazon: "http://127.0.0.1:4000/amazon"}`). */
  bases?: Record<string, string>;
  concurrency?: number;
  /** The whole call's time (default 150 s). */
  deadlineMs?: number;
};

const TEXT_CHARS = 3_000;

type Store = { asked: string; recipe: StoreRecipe; base: string };

/** The stores asked for, as recipes (unknown ones read generically); refuses a name that is no store. */
export function storesFor(stores: readonly string[] | undefined, place: Place | null): Store[] {
  const asked = stores?.length ? stores : [...DEFAULT_STORES];
  const out: Store[] = [];
  for (const name of asked.slice(0, 9)) {
    let recipe = recipeFor(name) ?? genericRecipe(name);
    if (!recipe) throw new BrowserError("bad_input", `“${name.slice(0, 60)}” is not a store: give a name such as amazon, walmart, target, bestbuy, costco, newegg, ebay, gamestop, bhphotovideo, or a site such as example.com.`);
    // Amazon for the place's country (amazon.in for India), unless amazon.com was named.
    if (recipe.id === "amazon" && place && place.country !== "US" && !/amazon\.com\b/i.test(name)) {
      const host = amazonHostFor(place.country);
      if (host) recipe = recipeFor(host) ?? recipe;
    }
    if (!out.some((store) => store.recipe.id === recipe!.id)) out.push({ asked: name, recipe, base: recipe.origin });
  }
  return out;
}

/** Whether a page already shows a priced result that is not an ad (a grid that loads after its carousel). */
function hasPricedResults(html: string, recipe: StoreRecipe, url: string): boolean {
  try {
    return storeOffers(parseHtml(html), recipe, url).offers.some((offer) => offer.price !== null && !offer.sponsored);
  } catch {
    return false;
  }
}

function pageText(doc: HtmlElement, url: string): string {
  return extractHtml(doc, { url, maxChars: TEXT_CHARS, links: false }).markdown;
}

/** One line for the work's answer: what was found where. */
export function shopSummary(result: ShopResult): string {
  const lines = [`Searched ${result.stores.length} store${result.stores.length === 1 ? "" : "s"} for “${result.query}”${result.location ? ` (${result.location.label})` : ""}.${result.location?.note ? ` ${result.location.note}` : ""}`];
  for (const store of result.stores) {
    const head = `${store.name}: ${store.status === "ok" ? "" : `${store.status.replace("_", " ")}. `}${store.shown ? `[${store.shown}] ` : ""}${store.mode === "clean" ? "[read-only view] " : ""}`;
    if (store.offers.length) {
      lines.push(`- ${head}${store.offers.map((offer) => `${offer.title} — ${offer.priceText || "price not shown"}${offer.availability ? ` (${offer.availability})` : ""}${offer.delivery ? ` [${offer.delivery}]` : ""}${offer.sponsored ? " [sponsored]" : ""}${offer.url ? ` ${offer.url}` : ""}`).join("; ")}`);
    } else {
      lines.push(`- ${head}${store.note ?? "no offers read"}${store.text ? `\n  Its page says: ${store.text.replace(/\s+/g, " ").slice(0, 1_500)}` : ""}`);
    }
  }
  const shots = result.stores.filter((store) => store.screenshot).length;
  if (shots) lines.push(`${shots} screenshot${shots === 1 ? "" : "s"} of the results (one per store).`);
  if (result.stores.some((store) => store.status === "human_check")) lines.push("A store showed a human check: offer to open it for your owner (browser_login_needed with its tab, purpose human_check) only if they want that store.");
  return lines.join("\n");
}

/** Where a store's page says it delivers ("Deliver to Madison 53703", "Ship to 53703"), from its text. */
export function shownPlace(text: string): string | null {
  // Up to the ZIP: what follows it on a page's text is the next menu item, not the city.
  const match = /\b(Deliver(?:ing)? to|Ship(?:ping)? to|Pickup at|Delivery to|Pickup or delivery\?)\s*:?\s*((?:[A-Z][\w.'-]*(?:\s[A-Z][\w.'-]*)?,?\s*)?\d{5})\b/.exec(text);
  return match ? `${match[1]!.replace(/\?$/, "")} ${match[2]!.trim()}` : null;
}

/** Target's guest location: the cookie its "Ship to" ZIP is kept in (`ZIP|lat|lon|state|country`). */
export function targetLocationCookie(place: Place): { name: string; value: string; domain: string; path: string; secure: boolean; sameSite: "Lax" } | null {
  if (place.country !== "US" || !place.zip) return null;
  return { name: "GuestLocation", value: [place.zip, place.lat.toFixed(3), place.lon.toFixed(3), place.state ?? "", "US"].join("|"), domain: ".target.com", path: "/", secure: true, sameSite: "Lax" };
}

/** In the page: scrolls the first product card to just below any header that stays on screen (fixed or sticky). */
function scrollToCard(card: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = globalThis as any;
  let cover = 0;
  for (const node of w.document.elementsFromPoint(w.innerWidth / 2, 2)) {
    const position = w.getComputedStyle(node).position;
    if (position === "fixed" || position === "sticky") cover = Math.max(cover, node.getBoundingClientRect().bottom);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const top = (card as any).getBoundingClientRect().top + w.scrollY;
  w.scrollTo({ top: Math.max(0, top - Math.min(cover, 240) - 16), left: 0, behavior: "instant" });
}

/** In the page: the product pictures on screen have loaded (at least one). */
function picturesShown(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = globalThis as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shown = [...w.document.images].filter((image: any) => {
    const box = image.getBoundingClientRect();
    return box.width > 60 && box.height > 60 && box.bottom > 0 && box.top < w.innerHeight;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return shown.length > 0 && shown.every((image: any) => image.complete && image.naturalWidth > 0);
}

/** Words a store's page uses to say why it shows no products: a picture of it tells the owner. */
export function pageExplains(text: string): boolean {
  return /access denied|forbidden|you have been blocked|went wrong|try again|not available|unavailable|sorry|no results|not able to find|couldn.t find|robot|human/i.test(text);
}

/** A results area that never filled in (grey placeholders, no words): its picture shows nothing. */
export function emptyArea(text: string): boolean {
  return text.replace(/\s+/g, " ").trim().length < 60;
}

/** Why the store's own requests (its search API) were refused in this tab (`HTTP 429`, `net::ERR_HTTP2_PROTOCOL_ERROR`), or null. */
function blockedSearch(broker: BrowserBroker, operation: string, tab: string, pageUrl: string): string | null {
  const site = (address: string) => {
    try {
      return new URL(address).hostname.split(".").slice(-2).join(".");
    } catch {
      return "";
    }
  };
  const refusal = broker
    .networkErrors(operation, tab)
    .errors.find((entry) => (entry.resourceType === "xhr" || entry.resourceType === "fetch") && site(entry.url) === site(pageUrl) && (entry.status === 403 || entry.status === 429 || /ERR_HTTP2_PROTOCOL_ERROR|ERR_QUIC_PROTOCOL_ERROR|ERR_CONNECTION_(?:RESET|CLOSED)|ERR_EMPTY_RESPONSE/.test(entry.failure ?? "")));
  return refusal ? (refusal.status ? `HTTP ${refusal.status}` : (refusal.failure ?? "refused")) : null;
}

/** browser_shop for one operation. */
export async function shopStores(broker: BrowserBroker, operation: string, input: ShopInput, options: ShopOptions = {}): Promise<ShopResult> {
  const query = input.query.trim();
  if (!query) throw new BrowserError("bad_input", "Say what to look for.");
  const given = input.location?.trim() ? placeFor(input.location) : null;
  const place = given ?? resolveLocation("US");
  const stores = storesFor(input.stores, given);
  const max = Math.min(Math.max(1, input.max ?? 3), 10);
  const profile = input.profile ?? "default";
  const deadline = Date.now() + (options.deadlineMs ?? 150_000);
  const left = () => deadline - Date.now();
  const urls = stores.map((store) => `${options.bases?.[store.recipe.id] ?? store.base}${store.recipe.search(query)}`);
  if (broker.loopbackOnly(operation) && urls.some((url) => !isLoopbackUrl(url))) throw new BrowserError("refused", "This work has the internet off: the browser opens only this computer's own addresses (localhost).");
  const rules = await broker.privacyRules();
  // The clean browser does not keep a page to this computer's own addresses: never for work with the internet off.
  const cleanAllowed = !broker.loopbackOnly(operation);
  if (place) await setGeolocation(await broker.browserContext(operation, { profile }), place);
  const location = place ? { label: place.label, ...(place.zip ? { zip: place.zip } : {}), country: place.country, ...(given ? (place.note ? { note: place.note } : {}) : { note: `No place was given: ${place.label} is used (say a state, city or ZIP for another).` }) } : null;

  type Done = { result: StoreResult; file?: MediaFile };
  /** A store that showed only its ads: blocked when none of them has a price either. */
  const adsOnly = (done: Done, note: string): Done => ({ ...done, result: { ...done.result, status: done.result.offers.some((offer) => offer.price !== null) ? "ok" : "blocked", note } });
  const drop = async (file: MediaFile | null | undefined) => {
    if (file) await rm(file.path, { force: true }).catch(() => undefined);
  };

  const readClean = async (store: Store, url: string, why: string): Promise<Done> => {
    const base: StoreResult = { store: store.recipe.id, name: store.recipe.name, status: "blocked", url, offers: [], mode: "clean" };
    if (left() < 12_000) return { result: { ...base, note: `${why}; no time was left to try a clean browser.` } };
    const read = await broker.cleanReader().read(profile, url, { screenshot: true, settleMs: Math.min(12_000, left() - 8_000), until: (html) => hasPricedResults(html, store.recipe, url), scroll: true });
    if (read.error && !read.html) return { result: { ...base, note: `${why}; a clean browser could not open it either (${read.error}).` } };
    if (siteRule(read.url, rules) === "never") return { result: { ...base, status: "error", note: "The owner marked this site as never captured." } };
    const doc = parseHtml(read.html);
    const check = humanCheck({ title: read.title, text: textOf(querySelector(doc, "body") ?? doc).slice(0, 6_000), frames: querySelectorAll(doc, "iframe[src]").map((frame) => frame.attrs.src ?? ""), status: null });
    const found = check ? { offers: [] as Offer[] } : storeOffers(doc, store.recipe, read.url);
    const offers = rankOffers(found.offers, query, max).map((offer) => ({ ...offer, title: hideSecrets(offer.title, rules) }));
    const file = read.png ? await saveCleanShot(broker, operation, read.png, { name: `${store.recipe.id}-${query}`, url: read.url, title: read.title, text: textOf(doc).slice(0, 20_000) }).catch(() => null) : null;
    const screenshot = file ? { screenshot: basename(file.path) } : {};
    const kept = file ?? undefined;
    if (check) return { result: { ...base, status: "human_check", note: `${why}; a clean browser got ${check}.`, ...screenshot }, file: kept };
    if (offers.length) return { result: { ...base, status: "ok", offers, note: `A read-only view from a clean browser: ${why}.`, ...screenshot }, file: kept };
    return { result: { ...base, status: "blocked", note: `${why}; a clean browser showed no offers either.`, ...screenshot }, file: kept };
  };

  const one = async (store: Store, url: string): Promise<Done> => {
    const recipe = store.recipe;
    const base: StoreResult = { store: recipe.id, name: recipe.name, status: "error", url, offers: [] };
    if (left() < 15_000) return { result: { ...base, note: "Not searched: the call ran out of time." } };
    let tab: string | null = null;
    let keep = false;
    try {
      // Target keeps its delivery ZIP in a cookie: set before its search page loads.
      const targetCookie = recipe.location === "target" && place ? targetLocationCookie(place) : null;
      if (targetCookie) await (await broker.browserContext(operation, { profile })).addCookies([targetCookie]).catch(() => undefined);
      const opened = await broker.open(operation, url, { profile, clean: true });
      tab = opened.tab;
      if (opened.error) {
        if (REFUSED_LOAD.test(opened.error) && cleanAllowed) {
          await broker.close(operation, opened.tab).catch(() => undefined);
          tab = null;
          return await readClean(store, url, `the site refused this browser (${opened.error})`);
        }
        return { result: { ...base, note: `The page did not load: ${opened.error}` } };
      }
      const page = broker.pageFor(operation, opened.tab);
      let shown: string | undefined;
      let placeNote: string | undefined;
      if (recipe.location === "amazon" && place?.zip) {
        const set = await setAmazonLocation(broker.actPage(operation, opened.tab), place, { timeoutMs: Math.min(30_000, left() - 15_000) });
        shown = set.shown ? `Deliver to ${set.shown}` : undefined;
        if (!set.ok) placeNote = set.note;
        if (set.how !== "already") await cleanPage(page, { moment: "load", budgetMs: 1_500 });
      }
      await page.locator(recipe.card).first().waitFor({ state: "attached", timeout: Math.max(1_000, Math.min(10_000, left() - 12_000)) }).catch(() => undefined);
      const check = await broker.humanCheck(operation, opened.tab, { status: opened.status }).catch(() => null);
      if (check) {
        const shot = await broker.screenshot(operation, opened.tab, { name: `${recipe.id}-${query}` }).catch(() => null);
        keep = true;
        return { result: { ...base, status: "human_check", note: `${recipe.name} showed ${check}. Tab ${opened.tab} is kept: the owner can pass it with browser_login_needed (purpose human_check) if they want this store.`, tab: opened.tab, ...(shot ? { screenshot: basename(shot.path) } : {}) }, file: shot ?? undefined };
      }
      // The store's own results (not its ads) and their prices come a moment after the first card; a lazy grid fills as it is scrolled to.
      let html = await page.content().catch(() => "");
      const waitUntil = Date.now() + Math.max(800, Math.min(8_000, left() - 15_000));
      for (let scrolled = false; Date.now() < waitUntil && !hasPricedResults(html, recipe, page.url()); ) {
        if (!scrolled) {
          await page.mouse.wheel(0, 900).catch(() => undefined);
          scrolled = true;
        }
        await page.waitForTimeout(700);
        html = await page.content().catch(() => html);
      }
      await page.mouse.wheel(0, -10_000).catch(() => undefined);
      const refused = await refusedPage(page, opened.status);
      if (refused && cleanAllowed) {
        await broker.close(operation, opened.tab).catch(() => undefined);
        tab = null;
        return await readClean(store, url, refused);
      }
      const doc = parseHtml(html || (await page.content()));
      const bodyText = textOf(querySelector(doc, "body") ?? doc).slice(0, 20_000);
      // Where the page says it delivers, for every store: the place set (or the store's own default) is said, never guessed.
      shown ??= shownPlace(bodyText) ?? undefined;
      if (place?.zip && given && !recipe.location && !placeNote) placeNote = `The place cannot be set on ${recipe.name} from here: it shows ${shown ? `“${shown}”` : "its own default place"}, and these are its online prices.`;
      else if (place?.zip && given && recipe.location === "target" && shown && !shown.includes(place.zip)) placeNote = `Target shows “${shown}”, not ${place.zip}.`;
      const found = storeOffers(doc, recipe, page.url());
      const offers = rankOffers(found.offers, query, max).map((offer) => ({ ...offer, title: hideSecrets(offer.title, rules) }));
      let blocked: string | null = null;
      // A check that came after the page (PerimeterX's "Press & hold" once its search is refused) is a human check, not a failed search.
      const late = offers.length ? null : await broker.humanCheck(operation, opened.tab, { status: opened.status }).catch(() => null);
      if (late) {
        const shot = await broker.screenshot(operation, opened.tab, { name: `${recipe.id}-${query}` }).catch(() => null);
        keep = true;
        return { result: { ...base, status: "human_check", note: `${recipe.name} showed ${late}. Tab ${opened.tab} is kept: the owner can pass it with browser_login_needed (purpose human_check) if they want this store.`, tab: opened.tab, ...(shot ? { screenshot: basename(shot.path) } : {}) }, file: shot ?? undefined };
      }
      if (!offers.length) {
        const refusal = blockedSearch(broker, operation, opened.tab, page.url());
        if (refusal) blocked = `its search service refused automated browsing (${refusal})`;
        else if (/something went wrong|try again later|temporarily unavailable/i.test(textOf(querySelector(doc, "main") ?? querySelector(doc, "body") ?? doc).slice(0, 20_000))) blocked = "its search failed for this computer (it may serve only visitors in its country, or refuse automated browsing)";
      }
      let shotError = "";
      // A grid's picture starts at its first product, below the store's header and filters, so its prices show.
      if (!recipe.shotTop && offers.length) {
        await page
          .locator(recipe.card)
          .filter({ visible: true })
          .first()
          .evaluate(scrollToCard, undefined, { timeout: 2_000 })
          .catch(() => undefined);
        await page.waitForTimeout(400);
        // Lazy product pictures paint once they are on screen.
        await page.waitForFunction(picturesShown, undefined, { timeout: 2_500 }).catch(() => undefined);
      }
      // No offers and no cards: the picture is worth sending only when the page says why (denied, no results, an error).
      const area = querySelector(doc, recipe.results);
      const areaText = area ? textOf(area) : bodyText;
      const unfilled = !offers.length && !pageExplains(areaText) && !(recipe.noResults?.test(bodyText) ?? false) && (emptyArea(areaText) || !querySelector(doc, recipe.card));
      const shot = unfilled
        ? null
        : await broker
        .screenshot(operation, opened.tab, recipe.shotTop || offers.length ? { name: `${recipe.id}-${query}` } : { focusSelector: recipe.results, focus: "search results", name: `${recipe.id}-${query}` })
        .catch((error: unknown) => {
          shotError = ` No screenshot: ${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 160) : String(error)}`;
          return null;
        });
      const screenshot = shot ? { screenshot: basename(shot.path) } : {};
      // Only sponsored cards without prices (the results themselves never loaded): read like a refused search.
      if (offers.length && offers.every((offer) => offer.price === null || offer.sponsored)) {
        const refusal = blockedSearch(broker, operation, opened.tab, page.url());
        if (refusal) blocked = `its search service refused automated browsing (${refusal})`;
      }
      const ok = { result: { ...base, status: "ok" as const, offers, mode: "browser" as const, ...(shown ? { shown } : {}), ...(placeNote || shotError ? { note: `${placeNote ?? ""}${shotError}`.trim() } : {}), ...screenshot }, file: shot ?? undefined };
      // Only ads came (the results themselves did not load): a clean browser may show them.
      const onlyAds = offers.length > 0 && offers.every((offer) => offer.sponsored);
      if (offers.length && !blocked && !onlyAds) return ok;
      // A known store whose cards never came (or whose search refused this browser): once more in a clean browser.
      const noResults = recipe.noResults?.test(textOf(querySelector(doc, "body") ?? doc).slice(0, 20_000)) ?? false;
      const noCards = !recipe.generic && !querySelector(doc, recipe.card) && !noResults;
      if ((blocked || noCards || onlyAds) && cleanAllowed && left() > 20_000) {
        const clean = await readClean(store, url, blocked ?? (onlyAds ? "only sponsored results loaded in this browser" : "its results did not load in this browser"));
        const cleanAds = clean.result.offers.length > 0 && clean.result.offers.every((offer) => offer.sponsored);
        if ((clean.result.status === "ok" && !(onlyAds && cleanAds)) || (clean.result.status === "human_check" && !onlyAds)) {
          await drop(shot);
          return cleanAds ? { ...clean, result: { ...clean.result, note: `Only sponsored results loaded: ${recipe.name}'s own results did not (${blocked ?? "they never came in this browser"}).` } } : clean;
        }
        await drop(clean.file);
        if (onlyAds) return adsOnly(ok, `Only sponsored results loaded: ${recipe.name}'s own results did not, here or in a clean browser.`);
        if (blocked) return { result: { ...base, status: "blocked", note: `${recipe.name}: ${clean.result.note ?? blocked}`, mode: "browser", ...screenshot }, file: shot ?? undefined };
      } else if (onlyAds) {
        return adsOnly(ok, `Only sponsored results loaded: ${recipe.name}'s own results did not.`);
      } else if (blocked) {
        return { result: { ...base, status: "blocked", note: `${recipe.name}: ${blocked}.`, mode: "browser", ...screenshot }, file: shot ?? undefined };
      }
      // Its results never came, here or in a clean browser: a store that refuses this computer, not one without the product.
      if (noCards) return { result: { ...base, status: "blocked", note: `${recipe.name}'s results did not load, in this browser or a clean one: it may refuse automated browsing or visitors from this computer's country.`, mode: "browser", ...screenshot }, file: shot ?? undefined };
      return {
        result: { ...base, status: "no_results", note: noResults ? `${recipe.name} found no results for “${query}”.` : `No offers could be read from ${recipe.name}'s page; its text is below.`, mode: "browser", ...(shown ? { shown } : {}), text: hideSecrets(pageText(doc, page.url()), rules), ...screenshot },
        file: shot ?? undefined,
      };
    } catch (error) {
      return { result: { ...base, note: error instanceof Error ? error.message.split("\n")[0]!.slice(0, 300) : String(error) } };
    } finally {
      if (tab && !keep) await broker.close(operation, tab).catch(() => undefined);
    }
  };

  const done: Done[] = new Array(stores.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(options.concurrency ?? 3, stores.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= stores.length) return;
      done[index] = await one(stores[index]!, urls[index]!);
    }
  });
  await Promise.all(workers);
  return { query, location, stores: done.map((row) => row.result), files: done.flatMap((row) => (row.file ? [row.file] : [])) };
}
