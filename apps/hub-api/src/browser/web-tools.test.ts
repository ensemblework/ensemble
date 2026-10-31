/**
 * The web tools' pure parts, without a browser: reading HTML (tags, implied ends, character
 * references, CSS selectors), pages as Markdown with their products and prices, links without
 * tracking, where a place is (states, cities, ZIPs, countries), how focus words pick an element
 * (an ad above a chart never wins), the interactive snapshot, each store recipe on its markup, the
 * generic offers, ranking, and how a tool's files become evidence.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { capturedFiles } from "../evidence/captures.js";
import { cleanLink, extractHtml, priceNumber, shownPrices, structuredProducts } from "./extract.js";
import { describeCandidate, focusKind, focusWords, pickFocus, scoreCandidate, type FocusCandidate } from "./focus.js";
import { decodeEntities, matches, parseHtml, querySelector, querySelectorAll, textOf } from "./html.js";
import { interactiveSnapshot } from "./interactive.js";
import { amazonHostFor, bestBuyUrl, resolveLocation, zipState } from "./location.js";
import { priceCardOffers, rankOffers, recipeOffers, relevance, storeOffers, structuredOffers, type Offer } from "./shop/offers.js";
import { genericRecipe, recipeFor, STORE_RECIPES } from "./shop/recipes.js";
import { storesFor } from "./shop/index.js";
import { fetchedKind, fetchedName, siteHome } from "./web.js";
import { withEvidenceIds } from "../device-tools/capture.js";

test("HTML: implied end tags, void and raw-text elements, character references, attributes without quotes", () => {
  const doc = parseHtml(`<!doctype html><html><head><title>A &amp; B</title><script>if (a < b) { document.write("</div>") }</script></head>
    <body><p>One<p>Two <b>bold</b><ul><li>first<li>second <img src=x.png alt=pic><li>third</ul>
    <table><tr><td>a<td>b<tr><td>c<td>d</table><div id=main class="x  y">&#8220;quoted&#8221; &euro;5 &#x1F600; &notanentity;</div></body></html>`);
  assert.equal(textOf(querySelector(doc, "title")), "A & B");
  assert.equal(querySelectorAll(doc, "p").length, 2, "a new p ends the open one");
  assert.deepEqual(querySelectorAll(doc, "li").map((li) => textOf(li)), ["first", "second", "third"]);
  assert.deepEqual(querySelectorAll(doc, "tr").map((row) => querySelectorAll(row, "td").map((cell) => textOf(cell)).join(",")), ["a,b", "c,d"]);
  assert.equal(querySelector(doc, "img")?.attrs.alt, "pic");
  assert.equal(textOf(querySelector(doc, "#main")), "“quoted” €5 😀 &notanentity;");
  assert.match(textOf(querySelector(doc, "script")), /document\.write/, "a script's text is kept whole, never parsed");
  assert.equal(decodeEntities("&lt;a&gt; &#39;x&#39; &nbsp;"), "<a> 'x' \u00a0");
});

test("CSS selectors: tags, ids, classes, attributes, :not, :first-child and the four combinators", () => {
  const doc = parseHtml(`<div id="r" class="grid main"><section data-testid="Price_1"><span class="a-price"><span class="a-offscreen">$5</span></span></section>
    <section data-testid="Price_2" hidden><span class="a-price a-text-price"><span class="a-offscreen">$9</span></span></section><p>x</p><p>y</p></div>`);
  assert.equal(querySelectorAll(doc, ".a-price:not(.a-text-price) .a-offscreen").map((node) => textOf(node)).join(), "$5");
  assert.equal(querySelectorAll(doc, "[data-testid^='Price_']").length, 2);
  assert.equal(querySelectorAll(doc, "[data-testid$='_2']").length, 1);
  assert.equal(querySelectorAll(doc, "[data-testid*='rice' i]").length, 2);
  assert.equal(querySelectorAll(doc, "div#r.grid > section").length, 2);
  assert.equal(querySelectorAll(doc, "section + p").length, 1);
  assert.equal(querySelectorAll(doc, "section ~ p").length, 2);
  assert.equal(querySelectorAll(doc, "p:first-child").length, 0);
  assert.equal(querySelectorAll(doc, "section:first-child").length, 1);
  assert.ok(matches(querySelector(doc, "div")!, "[class~=main]"));
  assert.throws(() => querySelectorAll(doc, "div:hover"), /Unsupported selector/);
});

test("a page as Markdown: its main content with headings, lists, tables and absolute links; menus, banners and scripts left out", () => {
  const html = `<html><head><title>PS5 review</title></head><body>
    <nav><a href="/">Home</a> <a href="/deals">Deals</a></nav>
    <div id="onetrust-banner-sdk">We use cookies <button>Accept</button></div>
    <main><h1>PlayStation 5 review</h1><p>The <b>PS5</b> is a console by <a href="/sony?utm_source=x&amp;id=7">Sony</a>.</p>
    <h2>Specifications</h2><table><caption>Specs</caption><thead><tr><th>Part</th><th>Value</th></tr></thead>
    <tbody><tr><td>CPU</td><td>8 cores | Zen 2</td></tr><tr><td>Storage</td><td>825 GB</td></tr></tbody></table>
    <h2>Prices</h2><ul><li>Disc: $499.99</li><li>Digital <ul><li>US$ 399</li></ul></li></ul>
    <pre>code\n  block</pre><script>var x = 1;</script><div hidden>secret menu</div></main>
    <footer>© 2026</footer></body></html>`;
  const page = extractHtml(html, { url: "https://example.com/reviews/ps5" });
  assert.equal(page.title, "PS5 review");
  assert.equal(page.part, "main");
  assert.match(page.markdown, /^# PlayStation 5 review/m);
  assert.match(page.markdown, /The PS5 is a console by \[Sony\]\(https:\/\/example\.com\/sony\?id=7\)\./, "absolute, without utm_*");
  assert.match(page.markdown, /\*\*Specs\*\*\n\n\| Part \| Value \|\n\| --- \| --- \|\n\| CPU \| 8 cores \\\| Zen 2 \|\n\| Storage \| 825 GB \|/);
  assert.match(page.markdown, /- Disc: \$499\.99\n- Digital\n {2}- US\$ 399/);
  assert.match(page.markdown, /```\ncode\n {2}block\n```/);
  assert.doesNotMatch(page.markdown, /cookies|Deals|secret menu|var x|© 2026/);
  assert.deepEqual(page.prices.map((price) => [price.amount, price.currency]), [[499.99, "USD"], [399, "USD"]]);
  const focused = extractHtml(html, { url: "https://example.com/", focus: "specifications table" });
  assert.equal(focused.part, "focus");
  assert.match(focused.markdown, /\| CPU \|/);
  assert.doesNotMatch(focused.markdown, /Disc: \$499/);
  // A flat page (Wikipedia's): a heading's section is what follows it up to the next heading of its level.
  const flat = `<main><p>${"Intro text. ".repeat(20)}</p><div class="mw-heading mw-heading2"><h2>Hardware</h2></div><p>The console has a custom chip.</p>
    <div class="mw-heading mw-heading3"><h3>Technical specifications</h3></div><table><tr><th>CPU</th><td>8-core Zen 2</td></tr><tr><th>GPU</th><td>RDNA 2</td></tr></table>
    <div class="mw-heading mw-heading2"><h2>Software</h2></div><p>${"Games and apps. ".repeat(20)}</p></main>`;
  const specs = extractHtml(flat, { focus: "specifications" });
  assert.equal(specs.part, "focus");
  assert.match(specs.markdown, /^### Technical specifications\n\n\| CPU \| 8-core Zen 2 \|/);
  assert.doesNotMatch(specs.markdown, /Games and apps|custom chip/);
  const cut = extractHtml(html.replace("</main>", `<p>${"A long review sentence. ".repeat(60)}</p></main>`), { maxChars: 500, url: "https://example.com/" });
  assert.ok(cut.markdown.length <= 510 && cut.truncated && cut.chars > 1_000, `${cut.markdown.length} ${cut.chars}`);
});

test("products from JSON-LD (Product, AggregateOffer, ItemList, @graph) and microdata; prices as numbers", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"PS5 Slim","url":"/p/1","brand":{"@type":"Brand","name":"Sony"},
      "offers":{"@type":"Offer","price":"499.99","priceCurrency":"USD","availability":"https://schema.org/InStock"},"aggregateRating":{"ratingValue":"4.7"}}]}</script>
    <script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"ListItem","position":1,"item":{"@type":"Product","name":"PS5 Pro","offers":{"@type":"AggregateOffer","lowPrice":699,"highPrice":749,"priceCurrency":"USD"}}}]}</script>
    <script type="application/ld+json">not json</script>
    <div itemscope itemtype="https://schema.org/Product"><span itemprop="name">DualSense</span><a itemprop="url" href="/p/3">x</a>
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="price" content="69.00"><meta itemprop="priceCurrency" content="USD"><link itemprop="availability" href="https://schema.org/OutOfStock"></div></div>`;
  const products = structuredProducts(parseHtml(html), "https://shop.example");
  assert.deepEqual(
    products.map((product) => [product.name, product.price, product.currency, product.availability, product.url]),
    [
      ["PS5 Slim", 499.99, "USD", "in stock", "https://shop.example/p/1"],
      ["PS5 Pro", 699, "USD", null, null],
      ["DualSense", 69, "USD", "out of stock", "https://shop.example/p/3"],
    ],
  );
  assert.equal(products[0]!.brand, "Sony");
  assert.equal(products[0]!.rating, 4.7);
  assert.equal(priceNumber("$1,299.99"), 1299.99);
  assert.equal(priceNumber("1.299,99 €"), 1299.99);
  assert.equal(priceNumber("₹49,990"), 49990);
  assert.equal(priceNumber("free"), null);
  assert.deepEqual(shownPrices("Now $599.99 (was $649.99)\n₹ 54,990 in India\n89,99 €").map((price) => [price.amount, price.currency]), [[599.99, "USD"], [649.99, "USD"], [54990, "INR"], [89.99, "EUR"]]);
});

test("links lose their tracking: Amazon's /dp/ASIN, Walmart's tracked clicks, eBay items, utm_* and ref parameters", () => {
  assert.equal(cleanLink("/PlayStation-5/dp/B0CL61F39H/ref=sr_1_2?dib=abc&keywords=ps5&qid=1&sr=8-2", "https://www.amazon.com/s?k=ps5"), "https://www.amazon.com/dp/B0CL61F39H");
  assert.equal(cleanLink("/sspa/click?ie=UTF8&spc=x&url=%2FSony-Stand%2Fdp%2FB0CLV1YDYS%2Fref%3Dsr_1_3", "https://www.amazon.com/"), "https://www.amazon.com/dp/B0CLV1YDYS");
  assert.equal(cleanLink("https://www.walmart.com/sp/track?bt=1&pos=2&rd=https%3A%2F%2Fwww.walmart.com%2Fip%2FPlayStation-5-Digital%2F17852302051%3FadsRedirect%3Dtrue&adUid=x", undefined), "https://www.walmart.com/ip/17852302051");
  assert.equal(cleanLink("https://www.ebay.com/itm/326512345678?itmmeta=01&hash=item4c&itmprp=enc", undefined), "https://www.ebay.com/itm/326512345678");
  assert.equal(cleanLink("https://shop.example/item?id=5&utm_source=mail&gclid=1", undefined), "https://shop.example/item?id=5");
  assert.equal(cleanLink("javascript:void(0)", "https://x.example"), null);
  assert.equal(cleanLink("#top", "https://x.example"), null);
});

test("places: a state is its capital's ZIP, a city its own, a ZIP its state; two letters are a US state; countries by name", () => {
  const wisconsin = resolveLocation("Wisconsin")!;
  assert.deepEqual([wisconsin.zip, wisconsin.city, wisconsin.state, wisconsin.country, wisconsin.label], ["53703", "Madison", "WI", "US", "Madison, WI 53703"]);
  assert.equal(resolveLocation("WI")!.zip, "53703");
  assert.equal(resolveLocation("in wisconsin, USA")!.zip, "53703");
  assert.equal(resolveLocation("Madison, WI")!.zip, "53703");
  assert.equal(resolveLocation("madison wisconsin")!.zip, "53703");
  assert.equal(resolveLocation("Milwaukee, WI")!.zip, "53202");
  assert.equal(resolveLocation("NYC")!.zip, "10001");
  assert.equal(resolveLocation("Los Angeles")!.state, "CA");
  assert.equal(resolveLocation("Charleston, WV")!.zip, "25301", "the capital when the state says so");
  assert.equal(resolveLocation("Charleston, SC")!.zip, "29401");
  const green = resolveLocation("Fond du Lac, WI")!;
  assert.equal(green.zip, "53703");
  assert.match(green.note!, /No ZIP is known here for Fond Du Lac/);
  const zip = resolveLocation("90210")!;
  assert.deepEqual([zip.kind, zip.zip, zip.state], ["zip", "90210", "CA"]);
  assert.equal(resolveLocation("Austin, TX 78702")!.zip, "78702", "a ZIP given wins");
  assert.equal(zipState("53703"), "WI");
  assert.equal(zipState("00000"), null);
  assert.equal(resolveLocation("CA")!.state, "CA", "California, not Canada");
  assert.equal(resolveLocation("Canada")!.country, "CA");
  assert.equal(resolveLocation("IN")!.state, "IN", "Indiana");
  const india = resolveLocation("India")!;
  assert.deepEqual([india.kind, india.country, india.zip], ["country", "IN", undefined]);
  assert.equal(resolveLocation("UK")!.country, "GB");
  const us = resolveLocation("US")!;
  assert.deepEqual([us.country, us.zip], ["US", "10001"]);
  assert.equal(resolveLocation("Washington DC")!.zip, "20001");
  assert.equal(resolveLocation("Washington")!.zip, "98501", "the state");
  assert.equal(resolveLocation("Narnia"), null);
  assert.equal(amazonHostFor("IN"), "www.amazon.in");
  assert.equal(bestBuyUrl("https://www.bestbuy.com/site/searchpage.jsp?st=ps5"), "https://www.bestbuy.com/site/searchpage.jsp?st=ps5&intl=nosplash");
  assert.equal(siteHome("amazon", india), "https://www.amazon.in/");
  assert.equal(siteHome("Best Buy", wisconsin), "https://www.bestbuy.com/?intl=nosplash");
  assert.equal(siteHome("shop.example.com", wisconsin), "https://shop.example.com/");
});

const candidate = (over: Partial<FocusCandidate>): FocusCandidate => ({
  index: 0,
  tag: "div",
  role: "",
  names: "",
  label: "",
  heading: "",
  text: "",
  x: 0,
  y: 0,
  w: 600,
  h: 300,
  graphic: 0,
  rows: 0,
  repeated: 0,
  currency: 0,
  chrome: false,
  ad: false,
  fixed: false,
  control: false,
  ...over,
});

test("focus scoring: the chart, not the ad above it or a button named chart; the table; the results list; nothing tiny", () => {
  const view = { vw: 1280, vh: 800, docH: 3000 };
  assert.deepEqual(focusWords("Show me the stock charts, please"), ["stock", "chart"]);
  assert.equal(focusKind("the stock chart"), "chart");
  assert.equal(focusKind("price table"), "table");
  assert.equal(focusKind("search results"), "results");
  assert.equal(focusKind("the price"), "price");
  const ad = candidate({ index: 0, tag: "iframe", names: "ad slot leaderboard", w: 728, h: 90, ad: true });
  const banner = candidate({ index: 1, tag: "img", names: "hero", label: "chart your future", w: 1200, h: 250, graphic: 300_000 });
  const chart = candidate({ index: 2, tag: "canvas", label: "goog price chart", w: 800, h: 400, y: 900, graphic: 320_000 });
  const button = candidate({ index: 3, tag: "button", label: "select chart type", w: 98, h: 32, control: true });
  const sparkline = candidate({ index: 4, tag: "svg", w: 100, h: 40, graphic: 4_000 });
  const best = pickFocus([ad, banner, chart, button, sparkline], "the stock chart", view)!;
  assert.equal(best.candidate.index, 2);
  assert.ok(scoreCandidate(ad, ["chart"], "chart", view) < 0);
  assert.equal(scoreCandidate(candidate({ w: 1, h: 1 }), ["chart"], "chart", view), Number.NEGATIVE_INFINITY);
  assert.match(describeCandidate(chart, "chart"), /^chart “goog price chart” \(canvas, 800×400\)$/);
  const table = candidate({ index: 5, tag: "table", heading: "price history", rows: 12, w: 900, h: 500 });
  const list = candidate({ index: 6, tag: "div", names: "s main slot s result list", repeated: 16, w: 1000, h: 4000 });
  assert.equal(pickFocus([chart, table, list], "price table", view)!.candidate.index, 5);
  assert.equal(pickFocus([chart, table, list, candidate({ index: 7, tag: "body", w: 1280, h: 3000 })], "search results", view)!.candidate.index, 6);
  assert.equal(pickFocus([candidate({ index: 8 })], "weather radar", view), null, "nothing fits: no focus");
});

test("the interactive snapshot keeps controls with refs, link targets, headings and short texts, and drops what is hidden", () => {
  const snapshot = [
    "- generic [ref=e1]:",
    "  - navigation \"Primary\" [ref=e2]:",
    "    - link \"Amazon\" [ref=e3] [cursor=pointer]:",
    "      - /url: /ref=nav_logo",
    "    - link \"Skip\" [ref=e4]:",
    "      - /url: \"#main\"",
    "    - generic [aria-hidden] [ref=e5]:",
    "      - button \"Hidden\" [ref=e6]",
    "  - main [ref=e7]:",
    "    - heading \"Results\" [level=2] [ref=e8]",
    "    - searchbox \"Search Amazon\" [ref=e9]: ps5",
    "    - text: $599.99",
    "    - paragraph [ref=e10]: A very long paragraph that goes on and on describing the product in detail, far longer than a hundred characters can be.",
    "    - checkbox \"Prime\" [checked] [ref=e11]",
    "    - button \"Add to cart\" [ref=e12]",
    "    - button \"Add to cart\" [ref=e13]",
  ].join("\n");
  const view = interactiveSnapshot(snapshot);
  assert.match(view.text, /- link "Amazon" \[ref=e3\] → \/ref=nav_logo/);
  assert.match(view.text, /- link "Skip" \[ref=e4\]$/m, "an in-page link has no target to show");
  assert.doesNotMatch(view.text, /Hidden|cursor=pointer|A very long paragraph/);
  assert.match(view.text, /- heading 2 "Results" \[ref=e8\]/);
  assert.match(view.text, /- searchbox "Search Amazon" \[ref=e9\]: ps5/);
  assert.match(view.text, /\$599\.99/);
  assert.match(view.text, /- checkbox "Prime" \[checked\] \[ref=e11\]/);
  assert.equal(view.text.match(/Add to cart/g)?.length, 2, "two buttons, two refs");
  const long = interactiveSnapshot(Array.from({ length: 2_000 }, (_, index) => `- button "Button number ${index}" [ref=e${index}]`).join("\n"));
  assert.ok(long.truncated && long.text.length <= 8_100 && /more lines not shown/.test(long.text));
});

/** One result card per store, in each store's markup as of October 2026. */
const CARDS: Record<string, string> = {
  amazon: `<div class="s-main-slot"><div data-component-type="s-search-result" class="AdHolder"><div data-cy="title-recipe"><a href="/sspa/click?url=%2FStand%2Fdp%2FB0CLV1YDYS"><h2 aria-label="PS5 Stand for Console"><span>PS5 Stand for Console</span></h2></a></div><span class="puis-sponsored-label-text">Sponsored</span><div data-cy="price-recipe"><span class="a-price"><span class="a-offscreen">$33.29</span></span></div></div>
    <div data-component-type="s-search-result"><div data-cy="title-recipe"><a href="/PlayStation-5/dp/B0CL61F39H/ref=sr_1_2?qid=1"><h2 aria-label="PlayStation 5 Disc Edition Console (slim)"><span>PlayStation 5 Disc Edition Console (slim)</span></h2></a></div>
      <div data-cy="price-recipe"><span class="a-price"><span class="a-offscreen">$648.99</span></span><span class="a-price a-text-price"><span class="a-offscreen">$699.99</span></span></div><div data-cy="delivery-recipe">FREE delivery Mon, Nov 2</div></div>
    <div data-component-type="s-search-result"><div data-cy="title-recipe"><a href="/PlayStation-console/dp/B0FRGTYSL5/ref=sr_1_1"><h2 aria-label="PlayStation®5 console – 1TB"><span>PlayStation®5 console – 1TB</span></h2></a></div><div data-cy="price-recipe"><a href="/x"><span>Click to see price</span></a></div></div></div>`,
  walmart: `<div role="group" data-item-id="17852302051"><a link-identifier="17852302051" href="https://www.walmart.com/sp/track?bt=1&amp;rd=https%3A%2F%2Fwww.walmart.com%2Fip%2FPS5%2F17852302051"></a><div data-automation-id="product-price"><div aria-hidden="true">$<span>599</span><span>00</span></div><span class="ld_Ec">current price $599.00</span></div><span><h3 data-automation-id="product-title">PlayStation 5 Digital Console Slim - 825GB</h3></span><div data-automation-id="fulfillment-badge">Free shipping, arrives in 3+ days</div></div>`,
  target: `<div data-test="ListingPageProductListing"><a data-test="content" href="/p/playstation-5-console-slim/-/A-90188801"><div><span>Highly rated</span></div><div data-test="text-quill"><span>$649.99</span></div><h3 data-test="text-quill"><span>PlayStation </span><span>5 Console (Slim)</span></h3><div data-test="text-quill"><span>Shipping </span><span>arrives Wed, Nov 4</span></div><div data-test="text-quill"><span>Sponsored</span></div></a></div>`,
  bestbuy: `<div data-product-id="6646420" class="product-list-item grid-view"><div class="sponsored">Sponsored</div><a class="product-list-item-link" href="https://www.bestbuy.com/product/playstation-5-slim-digital-edition-console-825gb/JXHQ37TYYL/sku/6646420"><h3 class="product-title" title="PlayStation 5 Slim Digital Edition Console– 825GB">PlayStation 5 Slim Digital Edition Console– 825GB</h3></a><div data-testid="price-block-customer-price"><span class="sr-only">$599.99</span><span aria-hidden="true">$</span><span aria-hidden="true">599</span></div><div class="fulfillment">Get it by Tue, Nov 3</div></div>`,
  costco: `<div data-testid="ProductTile_100"><a href="https://www.costco.com/sony-playstation-5.product.100.html"><span data-testid="Text_ProductTile_100_title">Sony PlayStation 5 Bundle</span></a><div data-testid="Text_Price_100">$599.99</div></div>`,
  newegg: `<div class="item-cell"><a class="item-title" href="https://www.newegg.com/p/N82E1">Sony PlayStation 5 Slim</a><ul class="price"><li class="price-current"><span>$</span><strong>479</strong><sup>.99</sup></li><li class="price-ship">Free Shipping</li></ul></div>`,
  ebay: `<ul class="srp-results"><li class="s-card"><a class="s-card__link" href="https://ebay.com/itm/123456?itmmeta=x"><div class="s-card__title"><span>Shop on eBay</span></div></a><span class="s-card__price">$20.00</span></li>
    <li class="s-card"><a class="s-card__link" href="https://www.ebay.com/itm/326512345678?hash=item"><div class="s-card__title"><span>Sony PlayStation 5 PS5 Console Disc</span></div></a><span class="s-card__price">$399.99</span><span class="s-item__shipping">+$25.00 delivery</span></li></ul>`,
  gamestop: `<div class="product-tile" data-cnstrc-item-price="619.99"><a class="product-tile-link" href="/consoles-hardware/playstation-5/products/sony-playstation-5-slim/402677.html"></a><div class="render-tile-name">Sony PlayStation 5 Slim Console Disc Edition</div><div class="product-tile-availability">In stock</div></div>`,
  bhphotovideo: `<div data-selenium="miniProductPage"><a data-selenium="miniProductPageProductNameLink" href="/c/product/1627237-REG/sony_ps5.html"><span data-selenium="miniProductPageProductName">Sony PlayStation 5 Slim</span></a><span data-selenium="uppedDecimalPrice"><span data-selenium="uppedDecimalPriceFirst">$499</span><sup data-selenium="uppedDecimalPriceSecond">99</sup></span><span data-selenium="stockStatus">In Stock</span></div>`,
};

test("each store recipe reads its result cards: title, price, link without tracking, delivery, sponsored", () => {
  const read = (store: string) => {
    const recipe = recipeFor(store)!;
    return recipeOffers(parseHtml(CARDS[recipe.id]!), recipe, recipe.origin);
  };
  const amazon = read("amazon");
  assert.deepEqual(
    amazon.map((offer) => [offer.title, offer.price, offer.priceText, offer.url, Boolean(offer.sponsored)]),
    [
      ["PS5 Stand for Console", 33.29, "$33.29", "https://www.amazon.com/dp/B0CLV1YDYS", true],
      ["PlayStation 5 Disc Edition Console (slim)", 648.99, "$648.99", "https://www.amazon.com/dp/B0CL61F39H", false],
      ["PlayStation®5 console – 1TB", null, "See price in cart", "https://www.amazon.com/dp/B0FRGTYSL5", false],
    ],
  );
  assert.equal(amazon[1]!.delivery, "FREE delivery Mon, Nov 2");
  const expect: Record<string, [string, number, string]> = {
    walmart: ["PlayStation 5 Digital Console Slim - 825GB", 599, "https://www.walmart.com/ip/17852302051"],
    target: ["PlayStation 5 Console (Slim)", 649.99, "https://www.target.com/p/playstation-5-console-slim/-/A-90188801"],
    bestbuy: ["PlayStation 5 Slim Digital Edition Console– 825GB", 599.99, "https://www.bestbuy.com/product/playstation-5-slim-digital-edition-console-825gb/JXHQ37TYYL/sku/6646420"],
    costco: ["Sony PlayStation 5 Bundle", 599.99, "https://www.costco.com/sony-playstation-5.product.100.html"],
    newegg: ["Sony PlayStation 5 Slim", 479.99, "https://www.newegg.com/p/N82E1"],
    ebay: ["Sony PlayStation 5 PS5 Console Disc", 399.99, "https://www.ebay.com/itm/326512345678"],
    gamestop: ["Sony PlayStation 5 Slim Console Disc Edition", 619.99, "https://www.gamestop.com/consoles-hardware/playstation-5/products/sony-playstation-5-slim/402677.html"],
    bhphotovideo: ["Sony PlayStation 5 Slim", 499.99, "https://www.bhphotovideo.com/c/product/1627237-REG/sony_ps5.html"],
  };
  for (const [store, [title, price, url]] of Object.entries(expect)) {
    const offers = read(store);
    assert.equal(offers.length, 1, store);
    assert.deepEqual([offers[0]!.title, offers[0]!.price, offers[0]!.url], [title, price, url], store);
  }
  const target = read("target")[0]!;
  assert.equal(target.sponsored, true, "Target says Sponsored in its own words");
  assert.equal(target.delivery, "Shipping arrives Wed, Nov 4");
  assert.equal(read("bestbuy")[0]!.sponsored, true);
  assert.equal(read("walmart")[0]!.delivery, "Free shipping, arrives in 3+ days");
  assert.equal(read("bhphotovideo")[0]!.availability, "In Stock");
  const openBox = recipeOffers(parseHtml(`<div class="product-list-item"><a class="product-list-item-link" href="/p/1"><h3 class="product-title">PlayStation 5 Slim</h3></a><span>Open-box as low as $577.99</span><span>$649.99</span></div>`), recipeFor("bestbuy")!, "https://www.bestbuy.com");
  assert.equal(openBox[0]!.price, 649.99, "an open-box price is another offer's");
  assert.equal(STORE_RECIPES.length, 9);
});

test("stores by any name; Amazon of the place's country; an unknown shop is read generically; a name that is no site is refused", () => {
  assert.equal(recipeFor("Best Buy")!.id, "bestbuy");
  assert.equal(recipeFor("bestbuy.com")!.id, "bestbuy");
  assert.equal(recipeFor("B&H")!.id, "bhphotovideo");
  assert.equal(recipeFor("https://www.walmart.com/")!.id, "walmart");
  assert.equal(recipeFor("amazon.in")!.origin, "https://www.amazon.in");
  assert.equal(recipeFor("example.com"), null);
  const generic = genericRecipe("shop.example.com")!;
  assert.equal(`${generic.origin}${generic.search("ps5 slim")}`, "https://shop.example.com/search?q=ps5%20slim");
  const template = genericRecipe("https://shop.example.com/find?term={query}&x=1")!;
  assert.equal(`${template.origin}${template.search("ps5")}`, "https://shop.example.com/find?term=ps5&x=1");
  assert.deepEqual(storesFor(undefined, null).map((store) => store.recipe.id), ["amazon", "walmart", "target", "bestbuy", "costco"]);
  assert.deepEqual(storesFor(["amazon", "Amazon.com", "newegg"], null).map((store) => store.recipe.id), ["amazon", "newegg"]);
  assert.equal(storesFor(["amazon"], resolveLocation("India"))[0]!.recipe.origin, "https://www.amazon.in");
  assert.throws(() => storesFor(["not a store!"], null), /is not a store/);
});

test("generic offers: JSON-LD first, else prices beside product links; ranked by the words, accessories and refurbished after", () => {
  const generic = genericRecipe("shop.example")!;
  const jsonLd = `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"ListItem","item":{"@type":"Product","name":"PS5 Slim Console","url":"https://shop.example/ps5","offers":{"price":"479.00","priceCurrency":"USD","availability":"InStock"}}}]}</script>`;
  const fromLd = storeOffers(parseHtml(jsonLd), generic, "https://shop.example/search?q=ps5");
  assert.equal(fromLd.source, "structured");
  assert.deepEqual([fromLd.offers[0]!.title, fromLd.offers[0]!.price, fromLd.offers[0]!.availability], ["PS5 Slim Console", 479, "in stock"]);
  const cards = `<main><div class="tile"><a href="/p/ps5">Sony PlayStation 5 Slim Console</a><div class="cost">$449.00</div></div>
    <div class="tile"><a href="/p/pad">DualSense Controller for PS5</a><div class="cost">$69.00</div></div></main>`;
  const prices = priceCardOffers(parseHtml(cards), "https://shop.example/");
  assert.deepEqual(prices.map((offer) => [offer.title, offer.price, offer.url]), [
    ["Sony PlayStation 5 Slim Console", 449, "https://shop.example/p/ps5"],
    ["DualSense Controller for PS5", 69, "https://shop.example/p/pad"],
  ]);
  const offer = (title: string, extra: Partial<Offer> = {}): Offer => ({ title, price: 1, priceText: "$1", currency: "USD", url: null, ...extra });
  const ranked = rankOffers([offer("PS5 Stand for Disc & Digital Console"), offer("Renewed PlayStation 5 Console"), offer("Garden hose"), offer("PlayStation®5 console – 1TB"), offer("PS5 Console", { sponsored: true })], "PS5 console", 3);
  assert.deepEqual(ranked.map((row) => row.title), ["PlayStation®5 console – 1TB", "PS5 Console", "Renewed PlayStation 5 Console"]);
  assert.ok(relevance(offer("Garden hose"), "PS5 console") <= 0);
  assert.equal(structuredOffers(parseHtml("<p>nothing</p>"), "https://x.example").length, 0);
});

test("fetched files: a name from Content-Disposition or the address; documents are reports; the tool's files become evidence", () => {
  assert.equal(fetchedName('attachment; filename="Sharma BMD-45.pdf"', "https://x.example/a"), "Sharma BMD-45.pdf");
  assert.equal(fetchedName("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", "https://x.example/a"), "résumé.pdf");
  assert.equal(fetchedName(undefined, "https://openaccess.thecvf.com/content/papers/Sharma_BMD-45_paper.pdf?download=1"), "Sharma_BMD-45_paper.pdf");
  assert.equal(fetchedName(undefined, "https://x.example/"), "download");
  assert.equal(fetchedKind("application/pdf"), "report");
  assert.equal(fetchedKind("text/csv"), "report");
  assert.equal(fetchedKind("image/png"), "image");
  assert.equal(fetchedKind("image/svg+xml"), "file");
  assert.equal(fetchedKind("application/zip"), "file");
  assert.deepEqual(capturedFiles({ path: "/e/paper.pdf", name: "paper.pdf", mime: "application/pdf", size: 10, kind: "report" }), [{ path: "/e/paper.pdf", kind: "report", held: false }]);
  const shot = (name: string) => ({ path: `/e/${name}`, kind: "image" as const, mime: "image/png", size: 1, held: false });
  const shop = { query: "ps5", stores: [{ store: "amazon", screenshot: "amazon-ps5.png", text: "long" }, { store: "costco", status: "blocked" }], files: [shot("amazon-ps5.png"), shot("costco-ps5.png")] };
  assert.deepEqual(capturedFiles(shop).map((file) => [file.path, file.kind]), [["/e/amazon-ps5.png", "screenshot"], ["/e/costco-ps5.png", "screenshot"]]);
  assert.deepEqual(capturedFiles({ url: "https://x.example", file: shot("view.png") }).map((file) => file.path), ["/e/view.png"]);
  const id = "11111111-2222-4333-8444-555555555555";
  const linked = withEvidenceIds(shop, [{ id, name: "amazon-ps5.png", kind: "screenshot", held: false, local: false }]) as { stores: Array<Record<string, unknown>>; files?: unknown };
  assert.equal(linked.files, undefined, "local paths stay on the computer");
  assert.deepEqual(linked.stores.map((store) => store.screenshot), [id, undefined]);
  assert.deepEqual(withEvidenceIds({ tab: "t1" }, []), { tab: "t1" }, "other results unchanged");
});
