/**
 * Store recipes for `browser_shop` (C1): how each store's search page is reached and read. Selectors
 * are for the stores' result cards as they were in October 2026; when a store changes its markup the
 * generic reading (shop/offers.ts: JSON-LD, then prices next to product links) still finds offers, and
 * the store's text comes back when nothing does.
 */

export type StoreRecipe = {
  id: string;
  name: string;
  /** The store's own site, for its search URL and its links. */
  origin: string;
  /** The search page for a query (a path and query on `origin`). */
  search: (query: string) => string;
  /** The results area, for its screenshot. */
  results: string;
  /** One result card. */
  card: string;
  title: string;
  /** Where a card's price is; the first price in its text counts. */
  price: string;
  /** A price split in two (B&H's "$349" and "99"). */
  priceParts?: { whole: string; fraction: string };
  /** A card attribute that holds the price (GameStop's `data-cnstrc-item-price`). */
  priceAttr?: string;
  link: string;
  availability?: string;
  delivery?: string;
  sponsored?: string;
  /** How the store takes a delivery place: Amazon's ZIP dialog, Best Buy's US site. */
  location?: "amazon" | "bestbuy";
  /** Titles that are not products ("Shop on eBay"). */
  skipTitle?: RegExp;
  /** Words a page with no results says. */
  noResults?: RegExp;
  /** A store the recipes do not know: read generically. */
  generic?: boolean;
  /** Its screenshot is the top of the page (Amazon: the delivery place in its header, then the first results). */
  shotTop?: boolean;
};

const q = (query: string) => encodeURIComponent(query.trim());

export const STORE_RECIPES: readonly StoreRecipe[] = [
  {
    id: "amazon",
    name: "Amazon",
    origin: "https://www.amazon.com",
    search: (query) => `/s?k=${q(query)}`,
    results: ".s-main-slot, [data-component-type='s-search-results'], #search",
    card: "div[data-component-type='s-search-result']",
    title: "[data-cy='title-recipe'] h2, h2",
    price: "[data-cy='price-recipe'] .a-price:not(.a-text-price) .a-offscreen, .a-price:not(.a-text-price) .a-offscreen, [data-cy='price-recipe'] .a-color-base",
    link: "[data-cy='title-recipe'] a[href], h2 a[href], a.a-link-normal.s-no-outline[href]",
    delivery: "[data-cy='delivery-recipe']",
    availability: "[data-cy='availability-recipe']",
    sponsored: ".puis-sponsored-label-text, .s-sponsored-label-text, [aria-label*='Sponsored']",
    location: "amazon",
    shotTop: true,
    noResults: /no results for|did not match any products/i,
  },
  {
    id: "walmart",
    name: "Walmart",
    origin: "https://www.walmart.com",
    search: (query) => `/search?q=${q(query)}`,
    results: "[data-testid='item-stack'], #results-container, main",
    card: "div[role='group'][data-item-id], div[data-item-id]",
    title: "[data-automation-id='product-title']",
    price: "[data-automation-id='product-price']",
    link: "a[link-identifier][href], a[href*='/ip/']",
    delivery: "[data-automation-id='fulfillment-badge'], [data-testid='fulfillment-badge']",
    availability: "[data-automation-id='inventory-status'], [data-testid='inventory-status']",
    sponsored: "[data-testid='sponsored-flag'], .sponsored-flag",
    noResults: /no results for|there were no search results/i,
  },
  {
    id: "target",
    name: "Target",
    origin: "https://www.target.com",
    search: (query) => `/s?searchTerm=${q(query)}`,
    results: "[data-test='ListingPageProductGrid'], [data-test='product-grid'], main",
    card: "[data-test='ListingPageProductListing'], [data-test='@web/site-top-of-funnel/ProductCardWrapper']",
    title: "a[data-test='content'] h3, a[data-test='product-title'], [data-test='product-title']",
    price: "[data-test='current-price'], a[data-test='content']",
    link: "a[data-test='content'][href], a[data-test='product-title'][href], a[href*='/p/']",
    delivery: "[data-test='fulfillment-cell']",
    sponsored: "[data-test='sponsoredText']",
    noResults: /couldn.t find a match|no results found/i,
  },
  {
    id: "bestbuy",
    name: "Best Buy",
    origin: "https://www.bestbuy.com",
    search: (query) => `/site/searchpage.jsp?st=${q(query)}&intl=nosplash`,
    results: ".product-grid-view-container, ul.sku-item-list, .sku-item-list, main",
    card: "div.product-list-item, li.sku-item",
    title: "h3.product-title, .product-title, h4.sku-title, .sku-title",
    price: "[data-testid='price-block-customer-price'] .sr-only, [data-testid='price-block-customer-price'], [data-testid='customer-price'] span, .priceView-customer-price span",
    link: "a.product-list-item-link[href], .sku-title a[href], a[href*='/product/'], a[href*='/site/']",
    delivery: ".fulfillment, .fulfillment-fulfillment-summary",
    sponsored: ".sponsored",
    location: "bestbuy",
    noResults: /\b0 results|no results|we couldn.t find/i,
  },
  {
    id: "costco",
    name: "Costco",
    origin: "https://www.costco.com",
    search: (query) => `/s?keyword=${q(query)}`,
    results: "[data-testid='Grid'], .product-list, main",
    card: "[data-testid^='ProductTile_'], div.product-tile-set, div.product",
    title: "[data-testid$='_title'], [data-testid^='Text_ProductTile_'], .description a, a.product-title",
    price: "[data-testid$='_price'], [data-testid^='Text_Price_'], .price",
    link: "a[href*='.product.'], a[href*='/p/'], .description a[href]",
    delivery: "[data-testid$='_delivery'], .delivery",
    noResults: /we were not able to find a match|no results/i,
  },
  {
    id: "newegg",
    name: "Newegg",
    origin: "https://www.newegg.com",
    search: (query) => `/p/pl?d=${q(query)}`,
    results: ".item-cells-wrap, .list-wrap, main",
    card: "div.item-cell, div.item-container",
    title: "a.item-title",
    price: "li.price-current",
    link: "a.item-title[href]",
    delivery: "li.price-ship",
    availability: ".item-promo, .btn-message",
    sponsored: ".item-sponsored-box, .txt-ads-link",
    noResults: /we have found 0 items|no results/i,
  },
  {
    id: "ebay",
    name: "eBay",
    origin: "https://www.ebay.com",
    search: (query) => `/sch/i.html?_nkw=${q(query)}`,
    results: "ul.srp-results, .srp-river-results, #srp-river-results",
    card: "li.s-card, li.s-item",
    title: ".s-card__title, .s-item__title",
    price: ".s-card__price, .s-item__price",
    link: "a.s-card__link[href*='/itm/'], a.s-item__link[href], a[href*='/itm/']",
    delivery: ".s-item__shipping, .s-item__logisticsCost",
    skipTitle: /^shop on ebay$/i,
    noResults: /no exact matches found|\b0 results/i,
  },
  {
    id: "gamestop",
    name: "GameStop",
    origin: "https://www.gamestop.com",
    search: (query) => `/search/?q=${q(query)}`,
    results: ".product-grid, .search-results, main",
    card: "div.product-tile",
    title: ".render-tile-name, .pd-name, .product-tile-header",
    price: ".render-sale-price, .render-base-price, .actual-price, .price",
    priceAttr: "data-cnstrc-item-price",
    link: "a.product-tile-link[href], a[href*='/products/']",
    availability: ".product-tile-availability",
    sponsored: ".tile-badge-sponsored:not(.d-none)",
    noResults: /no results|\b0 results|we couldn.t find/i,
  },
  {
    id: "bhphotovideo",
    name: "B&H Photo",
    origin: "https://www.bhphotovideo.com",
    search: (query) => `/c/search?q=${q(query)}`,
    results: "[data-selenium='listingSection'], [data-selenium='listingSectionWrapper'], main",
    card: "[data-selenium='miniProductPage']",
    title: "[data-selenium='miniProductPageProductName']",
    price: "[data-selenium='uppedDecimalPrice'], [data-selenium='pricingPrice']",
    priceParts: { whole: "[data-selenium='uppedDecimalPriceFirst']", fraction: "[data-selenium='uppedDecimalPriceSecond']" },
    link: "a[data-selenium='miniProductPageProductNameLink'][href]",
    availability: "[data-selenium='stockStatus']",
    delivery: "[data-selenium='shipMessage']",
    noResults: /no results|\b0 results|we couldn.t find/i,
  },
];

/** The stores searched when none are named. */
export const DEFAULT_STORES = ["amazon", "walmart", "target", "bestbuy", "costco"] as const;

const ALIASES: Record<string, string> = {
  amazoncom: "amazon",
  amzn: "amazon",
  walmartcom: "walmart",
  targetcom: "target",
  bestbuycom: "bestbuy",
  bby: "bestbuy",
  costcocom: "costco",
  neweggcom: "newegg",
  ebaycom: "ebay",
  gamestopcom: "gamestop",
  bh: "bhphotovideo",
  bhphoto: "bhphotovideo",
  bandh: "bhphotovideo",
  bandhphoto: "bhphotovideo",
  bhphotovideocom: "bhphotovideo",
};

/** A store's recipe from what the work wrote ("Best Buy", "bestbuy.com", "B&H"); null for any other store. */
export function recipeFor(store: string): StoreRecipe | null {
  const key = store
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/[^a-z0-9]/g, "");
  const id = ALIASES[key] ?? key;
  const found = STORE_RECIPES.find((recipe) => recipe.id === id);
  if (found) return found;
  // Amazon's other countries' sites read the same; only amazon.com takes a US ZIP.
  const host = store.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (/^amazon\.(?:in|ca|co\.uk|de|fr|it|es|co\.jp|com\.mx|com\.br|com\.au|nl|se|pl|sg|ae|sa|com\.tr|eg|com\.be|ie)$/.test(host)) {
    const amazon = STORE_RECIPES[0]!;
    return { ...amazon, id: host, name: `Amazon (${host})`, origin: `https://www.${host}`, location: undefined };
  }
  return null;
}

/**
 * A store the recipes do not know, read generically: a domain ("example.com" searches
 * `/search?q=`), or an address with `{query}` where the words go. Null when it names no site.
 */
export function genericRecipe(store: string): StoreRecipe | null {
  const value = store.trim();
  const template = /\{query\}|%s/.test(value);
  const filled = value.replace(/\{query\}|%s/g, "QUERYWORDS");
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(filled) ? filled : `https://${filled}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!/^[a-z0-9.-]+$/i.test(url.hostname) || (!url.hostname.includes(".") && url.hostname !== "localhost")) return null;
  const pathAndQuery = `${url.pathname}${url.search}`;
  const name = url.hostname.replace(/^www\./, "");
  return {
    id: name,
    name,
    origin: url.origin,
    search: template ? (query) => pathAndQuery.replace(/QUERYWORDS/g, q(query)) : (query) => `/search?q=${q(query)}`,
    results: "main, [role=main], #content, #main",
    card: "[itemtype*='schema.org/Product']",
    title: "[itemprop='name']",
    price: "[itemprop='price']",
    link: "a[href]",
    generic: true,
  };
}
