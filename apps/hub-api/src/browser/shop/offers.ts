/**
 * Offers from a store's search page HTML (`browser_shop`): the recipe's cards first (title, price,
 * link, availability, delivery, sponsored), else the page's JSON-LD and microdata products, else prices
 * shown next to product links. Ranked by how well each title matches the words searched, accessories
 * and sponsored results after the product itself.
 */
import { cleanLink, priceNumber, shownPrices, structuredProducts } from "../extract.js";
import { attr, collapse, descendants, querySelector, querySelectorAll, textOf, type HtmlElement, type HtmlNode } from "../html.js";
import type { StoreRecipe } from "./recipes.js";

export type Offer = {
  title: string;
  /** The amount, or null when the store shows none ("see price in cart"). */
  price: number | null;
  /** As the store shows it: "$599.99", "See price in cart". */
  priceText: string;
  currency: string;
  availability?: string;
  delivery?: string;
  url: string | null;
  sponsored?: boolean;
};

const short = (text: string, max = 140) => {
  const value = collapse(text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

function first(card: HtmlElement, selector: string | undefined): HtmlElement | null {
  if (!selector) return null;
  try {
    return querySelector(card, selector);
  } catch {
    return null;
  }
}

function priceOf(card: HtmlElement, recipe: StoreRecipe): { price: number | null; priceText: string; currency: string } {
  if (recipe.priceParts) {
    const whole = first(card, recipe.priceParts.whole);
    const fraction = first(card, recipe.priceParts.fraction);
    if (whole) {
      const text = `${textOf(whole)}${fraction ? `.${textOf(fraction).replace(/\D/g, "").slice(0, 2)}` : ""}`;
      const found = shownPrices(text, 1)[0];
      if (found) return { price: found.amount, priceText: found.text, currency: found.currency };
    }
  }
  const node = first(card, recipe.price);
  const text = node ? textOf(node) : "";
  const found = shownPrices(text, 1)[0];
  if (found) return { price: found.amount, priceText: found.text, currency: found.currency };
  if (recipe.priceAttr) {
    const holder = card.attrs[recipe.priceAttr] !== undefined ? card : descendants(card).find((node) => node.attrs[recipe.priceAttr!] !== undefined);
    const amount = priceNumber(holder?.attrs[recipe.priceAttr] ?? null);
    if (amount !== null && amount > 0) return { price: amount, priceText: `$${amount.toFixed(2)}`, currency: "USD" };
  }
  const anywhere = cardPrice(textOf(card));
  if (anywhere) return { price: anywhere.amount, priceText: anywhere.text, currency: anywhere.currency };
  const hint = /see price in cart|click to see price|see price|price in cart|add to cart to see price/i.exec(textOf(card))?.[0];
  return { price: null, priceText: hint ? "See price in cart" : "", currency: "USD" };
}

/** Words before a price that make it another offer's (open-box, used, the old price). */
const OTHER_PRICE = /(?:open-?box|as low as|options? from|used|pre-?owned|refurbished|renewed|restored|was|reg\.?|regular|list price|save|you save|off|trade-?in|per month|\/mo)\s*:?\s*$/i;

/** The card's own price in its text: the first one not marked as an open-box, used, old or monthly price. */
function cardPrice(text: string): { amount: number; text: string; currency: string } | null {
  let at = 0;
  for (const found of shownPrices(text, 20)) {
    const index = text.indexOf(found.text, at);
    const before = index >= 0 ? text.slice(Math.max(0, index - 30), index) : "";
    if (index >= 0) at = index + found.text.length;
    if (!OTHER_PRICE.test(before)) return found;
  }
  return null;
}

/** Offers from the recipe's result cards. */
export function recipeOffers(doc: HtmlElement, recipe: StoreRecipe, base: string): Offer[] {
  let cards: HtmlElement[];
  try {
    cards = querySelectorAll(doc, recipe.card);
  } catch {
    return [];
  }
  // A card inside another card (Walmart's tiles in tiles) counts once, as the outer one.
  const outer = cards.filter((card) => !cards.some((other) => other !== card && contains(other, card)));
  const offers: Offer[] = [];
  const seen = new Set<string>();
  for (const card of outer.slice(0, 80)) {
    const titleNode = first(card, recipe.title);
    const title = short(titleNode ? (attr(titleNode, "aria-label") || attr(titleNode, "title") || textOf(titleNode)) : "", 200);
    if (title.length < 3 || recipe.skipTitle?.test(title)) continue;
    const linkNode = first(card, recipe.link);
    const url = cleanLink(linkNode ? attr(linkNode, "href") : null, base);
    const key = `${url ?? ""}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { price, priceText, currency } = priceOf(card, recipe);
    const availability = short(textOf(first(card, recipe.availability)), 100);
    const delivery = short(textOf(first(card, recipe.delivery)) || deliveryPhrase(textOf(card)), 140);
    const sponsored = Boolean(recipe.sponsored && first(card, recipe.sponsored)) || /\bAdHolder\b/.test(card.attrs.class ?? "") || saysSponsored(card);
    offers.push({ title, price, priceText, currency, url, ...(availability ? { availability } : {}), ...(delivery ? { delivery } : {}), ...(sponsored ? { sponsored } : {}) });
  }
  return offers;
}

/** How a card says it gets to the buyer, when the recipe has no place for it: "Shipping arrives Wed, Nov 4", "FREE delivery Nov 10". */
function deliveryPhrase(text: string): string {
  const found = /(?:free (?:shipping|delivery)[^.|·]{0,40}|shipping arrives [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}|arrives (?:by )?[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}|delivery (?:by|on) [A-Z][a-z]{2}[^.|·]{0,20}|pickup (?:ready|today)[^.|·]{0,30}|ships? (?:in|within) [^.|·]{0,30})/i.exec(text);
  return found ? found[0] : "";
}

/** A card that marks itself "Sponsored" in its own words. */
function saysSponsored(card: HtmlElement): boolean {
  return descendants(card).some((node) => node.children.length === 1 && node.children[0]!.type === "text" && /^\s*sponsored\s*$/i.test((node.children[0] as { text: string }).text));
}

function contains(outer: HtmlElement, inner: HtmlElement): boolean {
  for (let at = inner.parent; at; at = at.parent) if (at === outer) return true;
  return false;
}

/** Offers from JSON-LD and microdata products. */
export function structuredOffers(doc: HtmlElement, base: string): Offer[] {
  return structuredProducts(doc, base).map((product) => ({
    title: short(product.name, 200),
    price: product.price,
    priceText: product.price !== null ? `${product.currency && product.currency !== "USD" ? `${product.currency} ` : "$"}${product.price.toFixed(2)}` : "",
    currency: product.currency ?? "USD",
    url: product.url,
    ...(product.availability ? { availability: product.availability } : {}),
  }));
}

const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "nav", "header", "footer"]);

/** Prices shown next to a product link: the smallest box around a price that holds one link with a title. */
export function priceCardOffers(doc: HtmlElement, base: string): Offer[] {
  const offers: Offer[] = [];
  const seen = new Set<HtmlElement>();
  const stack: HtmlNode[] = [doc];
  const hits: HtmlElement[] = [];
  while (stack.length && hits.length < 400) {
    const node = stack.pop()!;
    if (node.type === "text") {
      if (node.parent && /(?:[$€£¥₹]|US\$|Rs\.?)\s?\d/.test(node.text)) hits.push(node.parent);
      continue;
    }
    if (SKIP_TAGS.has(node.tag)) continue;
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!);
  }
  for (const hit of hits) {
    let card: HtmlElement | null = null;
    let link: HtmlElement | null = null;
    for (let at: HtmlElement | null = hit, steps = 0; at && at.tag !== "#document" && at.tag !== "body" && steps < 8; at = at.parent, steps += 1) {
      const links = querySelectorAll(at, "a[href]").filter((anchor) => textOf(anchor).length >= 12);
      if (links.length > 3) break;
      if (links.length >= 1) {
        card = at;
        link = links.sort((a, b) => textOf(b).length - textOf(a).length)[0]!;
        break;
      }
    }
    if (!card || !link || seen.has(card)) continue;
    seen.add(card);
    const price = shownPrices(textOf(hit), 1)[0] ?? shownPrices(textOf(card), 1)[0];
    if (!price) continue;
    offers.push({ title: short(textOf(link), 200), price: price.amount, priceText: price.text, currency: price.currency, url: cleanLink(attr(link, "href"), base) });
    if (offers.length >= 40) break;
  }
  return offers;
}

const ACCESSORY = /\b(?:case|cover|covers|skin|stand|charger|charging|cable|controller|headset|earbuds|mount|sticker|decal|protector|bag|strap|adapter|replacement|compatible|fan|cooling|dock|grip|remote|gift card|games?|drive|faceplates?|plates|accessor(?:y|ies))\b/i;
/** The thing itself, even when an accessory comes with it ("console with controller"). */
const WHOLE = /\b(?:console|system|bundle|laptop|notebook|phone|smartphone|television|tv|tablet|camera|monitor)\b/i;

/** Words a store writes in place of the one searched. */
const SAME: Record<string, string[]> = {
  ps5: ["playstation 5", "playstation5", "playstation®5"],
  ps4: ["playstation 4", "playstation4"],
  ps3: ["playstation 3"],
  xsx: ["xbox series x"],
  tv: ["television"],
  laptop: ["notebook"],
};

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2);
}

/** How well a title matches what was searched: its words (or what stores write for them), not an accessory for it, not sponsored. */
export function relevance(offer: Offer, query: string): number {
  const wanted = words(query);
  const title = offer.title.toLowerCase().replace(/[®™©]/g, "");
  const compact = title.replace(/[^\p{L}\p{N}]/gu, "");
  let score = 0;
  for (const word of wanted) {
    const forms = [word, ...(SAME[word] ?? [])];
    if (forms.some((form) => title.includes(form) || compact.includes(form.replace(/[^\p{L}\p{N}]/gu, "")))) score += 1;
  }
  score = wanted.length ? score / wanted.length : 0;
  // "Stand for PS5 Console", "Disc Drive for PlayStation 5": made for the thing, not the thing.
  const forms = wanted.flatMap((word) => [word, ...(SAME[word] ?? [])]).map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const madeFor = new RegExp(`\\bfor\\b.{0,60}(?:${[...forms, "console", "system", "playstation", "xbox", "nintendo", "iphone", "ipad", "macbook", "laptop"].join("|")})`, "i").test(title);
  if (ACCESSORY.test(title) && !ACCESSORY.test(query) && (madeFor || !WHOLE.test(title))) score -= 0.4;
  if (/\b(?:renewed|refurbished|pre-?owned|used|open[- ]box)\b/.test(title) && !/\b(?:renewed|refurbished|pre-?owned|used|open[- ]box)\b/i.test(query)) score -= 0.2;
  if (offer.sponsored) score -= 0.15;
  if (offer.price === null) score -= 0.1;
  return score;
}

/** The best `max` offers for the query, in the store's order among equals. */
export function rankOffers(offers: readonly Offer[], query: string, max: number): Offer[] {
  return offers
    .map((offer, index) => ({ offer, index, score: relevance(offer, query) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .map((row) => row.offer);
}

/** Offers for a store's page: its recipe, else structured data, else prices beside product links. */
export function storeOffers(doc: HtmlElement, recipe: StoreRecipe, base: string): { offers: Offer[]; source: "recipe" | "structured" | "prices" | "none" } {
  const fromRecipe = recipe.generic ? [] : recipeOffers(doc, recipe, base);
  if (fromRecipe.length) return { offers: fromRecipe, source: "recipe" };
  const structured = structuredOffers(doc, base).filter((offer) => offer.price !== null);
  if (structured.length) return { offers: structured, source: "structured" };
  const fromGeneric = recipe.generic ? recipeOffers(doc, recipe, base) : [];
  if (fromGeneric.length) return { offers: fromGeneric, source: "recipe" };
  const prices = priceCardOffers(doc, base);
  return prices.length ? { offers: prices, source: "prices" } : { offers: [], source: "none" };
}
