/**
 * The web tools against a real headless Chromium and local pages (skipped without Chromium): page
 * hygiene (consent banners, a pop-up, Amazon's toaster, a consent frame; never "Subscribe"), focused
 * screenshots (the chart below an ad, a table, a results list; nothing found says so), browser_view
 * (a geolocation, a site that refuses this browser read in a clean one, a human check keeps its tab),
 * browser_fetch and browser_download of a PDF, browser_extract, the interactive snapshot, and
 * browser_shop over fixture stores: Amazon's ZIP dialog before prices, a store read in a clean browser,
 * a human check, no results, a generic shop's JSON-LD, one screenshot per store.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserBroker } from "./broker.js";
import { findChromium } from "./chromium.js";
import { cleanPage } from "./hygiene.js";
import { decodePng, imageInfo } from "../capture/probe.js";
import { runBrowserTool, type ToolCallResult } from "./tools.js";
import { shopStores } from "./shop/index.js";
import { capturedFiles } from "../evidence/captures.js";

const chromium = findChromium({ headless: true });
const skip = chromium ? false : "no Chromium on this computer (run `ensemble capture setup`)";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const LONG = "This page is about the PlayStation 5 and what it costs in shops across the country. ".repeat(6);

const page = (title: string, body: string, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body style="margin:0;font:16px sans-serif">${body}</body></html>`;

const PAGES: Record<string, string> = {
  "/hygiene": page(
    "Hygiene",
    `<h1>News</h1><p>${LONG}</p>
    <div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#eee">We use cookies to improve your experience.
      <button id="onetrust-accept-btn-handler" onclick="document.getElementById('onetrust-banner-sdk').remove()">Accept All Cookies</button></div>
    <div id="news" role="dialog" aria-modal="true" style="position:fixed;top:100px;left:300px;width:500px;height:200px;background:#fff;border:1px solid #000">Get our newsletter!
      <button onclick="document.title='SUBSCRIBED'">Subscribe</button> <button onclick="document.getElementById('news').remove()">No thanks</button></div>
    <div class="glow-toaster" style="position:absolute;top:10px;left:10px;background:#fff">We're showing you items that ship to India.
      <span class="glow-toaster-button-dismiss"><input type="submit" value="Dismiss" data-action-type="DISMISS" onclick="this.closest('.glow-toaster').remove()"></span></div>
    <iframe id="sp_message_iframe_1" style="position:fixed;top:0;right:0;width:300px;height:150px;border:0" srcdoc="<p>We and our partners use cookies</p><button title='Accept' onclick='parent.postMessage(&quot;accepted&quot;, &quot;*&quot;)'>Accept</button>"></iframe>
    <script>addEventListener("message", (event) => { if (event.data === "accepted") document.getElementById("sp_message_iframe_1").remove(); });</script>`,
  ),
  "/chart": page(
    "GOOG",
    `<header style="position:fixed;top:0;left:0;right:0;height:60px;background:#333;color:#fff;z-index:5">Finance</header>
    <div id="ad-banner" class="ad-slot" style="margin-top:70px;width:970px;height:250px;background:#f0c"><img alt="Chart your future with us" width="970" height="250"></div>
    <p style="height:500px">${LONG}</p>
    <section class="quote"><h2>GOOG price chart</h2><canvas id="price" width="800" height="400" aria-label="GOOG price over five days"></canvas></section>
    <p style="height:1200px">More news.</p>
    <script>const c = document.getElementById("price").getContext("2d"); c.fillStyle = "#fff"; c.fillRect(0, 0, 800, 400); c.strokeStyle = "#c00"; c.lineWidth = 4; c.beginPath(); c.moveTo(0, 300); c.lineTo(400, 100); c.lineTo(800, 250); c.stroke();</script>`,
  ),
  "/table": page(
    "Specs",
    `<p style="height:900px">${LONG}</p><h2>Price table</h2><table border="1" style="width:700px">${Array.from({ length: 8 }, (_, index) => `<tr><td>Store ${index}</td><td>$${499 + index}.99</td></tr>`).join("")}</table><p style="height:900px">End.</p>`,
  ),
  "/results": page(
    "Search",
    `<nav style="height:80px">Menu</nav><div id="results" class="search-results">${Array.from({ length: 10 }, (_, index) => `<div class="result-card" style="height:120px;border:1px solid #ccc;margin:8px"><a href="/p/${index}">PlayStation 5 bundle ${index}</a> <span>$${500 + index}.00</span></div>`).join("")}</div>`,
  ),
  "/plain": page("Plain", `<p>${LONG}</p>`),
  "/article": page(
    "PS5 specs",
    `<nav><a href="/">Home</a></nav><main><h1>PlayStation 5</h1><p>${LONG} See <a href="/sony?utm_source=x">Sony</a>.</p><h2>Specifications</h2>
    <table><tr><th>Part</th><th>Value</th></tr><tr><td>Storage</td><td>825 GB</td></tr></table><p>Now $499.99 at most shops.</p></main>`,
    `<script type="application/ld+json">{"@type":"Product","name":"PlayStation 5","offers":{"price":"499.99","priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script>`,
  ),
  "/robot": page("Robot or human?", "<p>Activate and hold the button to confirm that you're human.</p>"),
  "/geo": page("Where", `<p id="where">${LONG}</p><script>navigator.geolocation.getCurrentPosition((at) => { document.getElementById("where").textContent = "At " + at.coords.latitude.toFixed(4) + "," + at.coords.longitude.toFixed(4) + ". " + document.getElementById("where").textContent; });</script>`),
  "/refused": page("Refused page, read cleanly", `<main><h1>Prices today</h1><p>${LONG}</p></main>`),
};

/** Fixture stores, each in its real store's markup. */
function store(request: IncomingMessage, response: ServerResponse, path: string, url: URL): boolean {
  const cookies = request.headers.cookie ?? "";
  const send = (html: string, status = 200) => {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  };
  if (path.startsWith("/store/amazon/s")) {
    const zip = /(?:^|;\s*)zip=(\d{5})/.exec(cookies)?.[1];
    send(
      page(
        `Amazon.com : ${url.searchParams.get("k")}`,
        `<div id="nav-global-location-popover-link" style="cursor:pointer;padding:8px">Deliver to <span id="glow-ingress-line2">${zip ? `Madison ${zip}` : "India"}</span></div>
        ${zip ? "" : `<div class="glow-toaster" style="position:absolute;top:40px;left:10px;background:#ffe">We're showing you items that ship to India.<span class="glow-toaster-button-dismiss"><input type="submit" value="Dismiss" data-action-type="DISMISS" onclick="this.closest('.glow-toaster').remove()"></span></div>`}
        <div id="glux" style="display:none;position:fixed;top:80px;left:100px;background:#fff;border:1px solid #000;padding:20px">
          <input id="GLUXZipUpdateInput"><span id="GLUXZipUpdate"><input type="submit" value="Apply" onclick="document.cookie = 'zip=' + document.getElementById('GLUXZipUpdateInput').value + '; path=/'; document.querySelector('#glux .a-popover-footer').style.display = 'block'"></span>
          <div class="a-popover-footer" style="display:none"><input id="GLUXConfirmClose" type="submit" value="Continue" onclick="document.getElementById('glux').style.display = 'none'"></div></div>
        <script>document.getElementById("nav-global-location-popover-link").onclick = () => { document.getElementById("glux").style.display = "block"; };</script>
        <div class="s-main-slot">
          <div data-component-type="s-search-result" class="AdHolder"><div data-cy="title-recipe"><a href="/sspa/click?url=%2FStand%2Fdp%2FB0CLV1YDYS"><h2 aria-label="Stand for PS5 Console"><span>Stand for PS5 Console</span></h2></a></div><span class="puis-sponsored-label-text">Sponsored</span>${zip ? `<div data-cy="price-recipe"><span class="a-price"><span class="a-offscreen">$29.99</span></span></div>` : ""}</div>
          <div data-component-type="s-search-result"><div data-cy="title-recipe"><a href="/PlayStation-5/dp/B0CL61F39H/ref=sr_1_1?qid=1"><h2 aria-label="PlayStation 5 Console"><span>PlayStation 5 Console</span></h2></a></div>${zip ? `<div data-cy="price-recipe"><span class="a-price"><span class="a-offscreen">$499.99</span></span></div><div data-cy="delivery-recipe">FREE delivery Mon, Nov 2</div>` : `<div>No featured offers available</div>`}</div>
        </div>`,
      ),
    );
    return true;
  }
  if (path.startsWith("/store/walmart/search")) {
    send(
      page(
        "ps5 - Walmart.com",
        `<div data-testid="item-stack">${["PlayStation 5 Digital Console Slim|17852302051|599.00", "PlayStation 5 Disc Console Slim|17816601985|649.00"]
          .map((row) => row.split("|"))
          .map(([title, id, price]) => `<div role="group" data-item-id="${id}" style="height:200px"><a link-identifier="${id}" href="/sp/track?bt=1&amp;rd=https%3A%2F%2Fwww.walmart.com%2Fip%2FPS5%2F${id}">open</a><div data-automation-id="product-price"><span>current price $${price}</span></div><h3 data-automation-id="product-title">${title}</h3></div>`)
          .join("")}</div>`,
      ),
    );
    return true;
  }
  if (path.startsWith("/store/bestbuy/site/searchpage.jsp")) {
    // This browser's profile carries the "pw" cookie: refused like Best Buy refuses it; the clean browser is not.
    if (/(?:^|;\s*)pw=1/.test(cookies)) {
      request.socket.destroy();
      return true;
    }
    send(
      page(
        "ps5 - Best Buy",
        `<ul class="product-grid-view-container"><li><div class="product-list-item"><a class="product-list-item-link" href="https://www.bestbuy.com/product/ps5-slim/JXHQ/sku/6646419"><h3 class="product-title">PlayStation 5 Slim Console – 1TB</h3></a><div data-testid="price-block-customer-price"><span class="sr-only">$549.99</span></div></div></li></ul>`,
      ),
    );
    return true;
  }
  if (path.startsWith("/store/target/s")) {
    send(page("Robot or human?", "<p>Activate and hold the button to confirm that you're human.</p>"));
    return true;
  }
  if (path.startsWith("/store/costco/s")) {
    send(page("Search | Costco", `<main><h1>We're sorry. We were not able to find a match.</h1><p>Try another search.</p></main>`));
    return true;
  }
  if (path.startsWith("/store/generic/search")) {
    send(
      page(
        "Shop",
        `<main><h1>Results</h1><p>Two products</p></main>`,
        `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"ListItem","item":{"@type":"Product","name":"PS5 Console Slim","url":"/p/ps5","offers":{"price":"479.00","priceCurrency":"USD","availability":"https://schema.org/InStock"}}},{"@type":"ListItem","item":{"@type":"Product","name":"Garden hose","offers":{"price":"19.00","priceCurrency":"USD"}}}]}</script>`,
      ),
    );
    return true;
  }
  return false;
}

let server: Server;
/** The server by its address: this computer's own, where page hygiene stays out of an app under test. */
let base = "";
/** The same server under a public-looking name (the browsers map it to 127.0.0.1), for pages a node browses. */
let site = "";
let root = "";
const HOST = "shop.web.test";

test.before(async () => {
  root = mkdtempSync(join(tmpdir(), "ensemble-web-tools-"));
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    const path = url.pathname;
    if (path === "/paper.pdf") {
      response.writeHead(200, { "content-type": "application/pdf", "content-length": String(PDF.length) });
      response.end(PDF);
      return;
    }
    if (path === "/refused" && /(?:^|;\s*)pw=1/.test(request.headers.cookie ?? "")) {
      request.socket.destroy();
      return;
    }
    if (store(request, response, path, url)) return;
    const html = PAGES[path];
    response.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(html ?? "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  site = `http://${HOST}:${(server.address() as AddressInfo).port}`;
});

test.after(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  if (root) rmSync(root, { recursive: true, force: true });
});

function setup(name: string) {
  const evidenceDir = join(root, "evidence", name);
  mkdirSync(evidenceDir, { recursive: true });
  const broker = new BrowserBroker({ dataHome: join(root, `data-${name}`), args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
  const context = { operation: `job-${name}`, evidenceDir };
  broker.operation(context.operation, { evidenceDir });
  return { broker, context, evidenceDir };
}

/** The result of a call that must have worked. */
function resultOf<T>(call: ToolCallResult): T {
  assert.ok(call.ok, JSON.stringify(call));
  return call.result as T;
}

function summaryOf(call: ToolCallResult): string {
  assert.ok(call.ok, JSON.stringify(call));
  return call.summary;
}

const pngSize = (path: string) => {
  const info = imageInfo(readFileSync(path))!;
  return { width: info.width, height: info.height };
};

test("hygiene closes consent banners, a pop-up, Amazon's toaster and a consent frame, says so, and never subscribes", { skip, timeout: 90_000 }, async () => {
  const { broker, context } = setup("hygiene");
  try {
    const opened = await runBrowserTool(broker, "browser_open", { url: `${site}/hygiene` }, context);
    assert.ok(opened.ok, JSON.stringify(opened));
    const result = opened.result as { tab: string; dismissed?: string[] };
    assert.deepEqual([...(result.dismissed ?? [])].sort(), ["Amazon's delivery location notice", "a pop-up (“No thanks”)", "the cookie banner (OneTrust)", "the cookie banner (Sourcepoint)"].sort());
    assert.match(opened.summary, /Closed the cookie banner \(OneTrust\)/);
    const pageOf = broker.pageFor(context.operation, result.tab);
    assert.equal(await pageOf.title(), "Hygiene", "Subscribe was never clicked");
    assert.equal(await pageOf.locator("#onetrust-banner-sdk, #news, .glow-toaster, #sp_message_iframe_1").count(), 0);
    // Opened with clean: false, the banners stay; a screenshot closes consent banners only (a dialog the work opened stays).
    const kept = await runBrowserTool(broker, "browser_open", { url: `${site}/hygiene`, clean: false }, context);
    const tab = resultOf<{ tab: string }>(kept).tab;
    assert.equal(await broker.pageFor(context.operation, tab).locator("#onetrust-banner-sdk").count(), 1);
    const before = await cleanPage(broker.pageFor(context.operation, tab), { moment: "capture" });
    assert.ok(before.dismissed.includes("the cookie banner (OneTrust)"));
    assert.ok(!before.dismissed.some((what) => what.includes("No thanks")), "a dialog stays open before a screenshot");
    assert.ok(before.ms < 3_000);
    // An app on this computer is under test: its banners and dialogs stay as they are.
    const local = resultOf<{ tab: string; dismissed?: string[] }>(await runBrowserTool(broker, "browser_open", { url: `${base}/hygiene` }, context));
    assert.equal(local.dismissed, undefined);
    assert.equal(await broker.pageFor(context.operation, local.tab).locator("#onetrust-banner-sdk, #news").count(), 2);
  } finally {
    await broker.shutdown();
  }
});

test("focused screenshots: the chart below an ad and a fixed header, the table, the results list; nothing found says so", { skip, timeout: 120_000 }, async () => {
  const { broker, context } = setup("focus");
  try {
    const opened = await runBrowserTool(broker, "browser_open", { url: `${site}/chart` }, context);
    const tab = resultOf<{ tab: string }>(opened).tab;
    const chart = await runBrowserTool(broker, "browser_screenshot", { tab, focus: "the stock chart" }, context);
    assert.ok(chart.ok, JSON.stringify(chart));
    const shot = chart.result as { path: string; focusFound: boolean; focusOn: string };
    assert.equal(shot.focusFound, true);
    assert.match(shot.focusOn, /canvas/);
    const size = pngSize(shot.path);
    assert.ok(size.width >= 800 && size.width <= 900 && size.height >= 400 && size.height <= 560, `the chart with its heading and a margin, not the ad: ${JSON.stringify(size)}`);
    const image = await decodePng(readFileSync(shot.path));
    const pixel = (x: number, y: number) => image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3);
    let red = 0;
    for (let y = 0; y < image.height; y += 4) for (let x = 0; x < image.width; x += 4) if (pixel(x, y)[0]! > 180 && pixel(x, y)[1]! < 60) red += 1;
    assert.ok(red > 20, "the chart's line is in the picture");
    let pink = 0;
    for (let y = 0; y < image.height; y += 8) for (let x = 0; x < image.width; x += 8) if (pixel(x, y)[0]! > 230 && pixel(x, y)[2]! > 180 && pixel(x, y)[1]! < 40) pink += 1;
    assert.equal(pink, 0, "no ad in the picture");
    assert.match(chart.summary, /It shows chart/);

    await runBrowserTool(broker, "browser_open", { url: `${site}/table`, tab }, context);
    const table = resultOf<{ path: string; focusFound: boolean; focusOn: string }>(await runBrowserTool(broker, "browser_screenshot", { tab, focus: "price table" }, context));
    assert.equal(table.focusFound, true);
    assert.match(table.focusOn, /^table/);
    assert.ok(pngSize(table.path).width <= 760);

    await runBrowserTool(broker, "browser_open", { url: `${site}/results`, tab }, context);
    const results = resultOf<{ focusFound: boolean; focusOn: string }>(await runBrowserTool(broker, "browser_screenshot", { tab, focus: "search results" }, context));
    assert.equal(results.focusFound, true);
    assert.match(results.focusOn, /^results/);

    await runBrowserTool(broker, "browser_open", { url: `${site}/plain`, tab }, context);
    const missing = await runBrowserTool(broker, "browser_screenshot", { tab, focus: "the weather radar map" }, context);
    assert.equal(resultOf<{ focusFound: boolean }>(missing).focusFound, false);
    assert.match(summaryOf(missing), /was not found on the page/);
  } finally {
    await broker.shutdown();
  }
});

test("browser_view: screenshot, text and place in one call; a refusing site read in a clean browser; a human check keeps its tab", { skip, timeout: 150_000 }, async () => {
  const { broker, context } = setup("view");
  try {
    // Geolocation needs a secure page: this computer's own address is one.
    const view = await runBrowserTool(broker, "browser_view", { url: `${base}/geo`, location: "Wisconsin" }, context);
    assert.ok(view.ok, JSON.stringify(view));
    const result = view.result as { tab: string; mode: string; text: string; file: { path: string; kind: string }; location: { label: string; zip: string } };
    assert.equal(result.mode, "browser");
    assert.match(result.text, /At 43\.0731,-89\.4012/, "the browser's location is Madison");
    assert.equal(result.location.zip, "53703");
    assert.ok(existsSync(result.file.path));
    assert.deepEqual(capturedFiles(result).map((file) => file.kind), ["screenshot"]);
    assert.match(view.summary, /Text of the page/);

    // This browser is refused (its profile's cookie makes the page drop the connection); a clean browser reads it.
    await (await broker.browserContext(context.operation)).addCookies([{ name: "pw", value: "1", url: site }]);
    const clean = await runBrowserTool(broker, "browser_view", { url: `${site}/refused` }, context);
    assert.ok(clean.ok, JSON.stringify(clean));
    const read = clean.result as { tab?: string; mode: string; text: string; title: string; file: { path: string }; blocked: string };
    assert.equal(read.mode, "clean");
    assert.equal(read.tab, undefined);
    assert.equal(read.title, "Refused page, read cleanly");
    assert.match(read.text, /Prices today/);
    assert.match(read.blocked, /ERR_EMPTY_RESPONSE/);
    assert.ok(existsSync(read.file.path) && pngSize(read.file.path).width === 1280);
    assert.match(clean.summary, /Read-only view/);

    const check = await runBrowserTool(broker, "browser_view", { url: `${site}/robot` }, context);
    const robot = resultOf<{ tab: string; humanCheck: boolean; humanCheckKind: string }>(check);
    assert.equal(robot.humanCheck, true);
    assert.match(robot.humanCheckKind, /Robot or human/);
    assert.ok((await broker.list(context.operation)).some((tab) => tab.tab === robot.tab), "its tab is kept for the owner");
    assert.match(summaryOf(check), /browser_login_needed/);
  } finally {
    await broker.shutdown();
  }
});

test("browser_fetch keeps a PDF as a report and refuses a web page; browser_download fetches the PDF a tab shows", { skip, timeout: 90_000 }, async () => {
  const { broker, context, evidenceDir } = setup("fetch");
  try {
    const fetched = await runBrowserTool(broker, "browser_fetch", { url: `${base}/paper.pdf` }, context);
    assert.ok(fetched.ok, JSON.stringify(fetched));
    const file = fetched.result as { path: string; name: string; mime: string; kind: string; size: number };
    assert.deepEqual([file.name, file.mime, file.kind, file.size], ["paper.pdf", "application/pdf", "report", PDF.length]);
    assert.ok(file.path.startsWith(evidenceDir));
    assert.deepEqual(readFileSync(file.path), PDF);
    assert.deepEqual(capturedFiles(file), [{ path: file.path, kind: "report", held: false }]);
    const named = resultOf<{ name: string }>(await runBrowserTool(broker, "browser_fetch", { url: `${base}/paper.pdf`, name: "BMD-45" }, context));
    assert.equal(named.name, "BMD-45.pdf", "the type's extension is added");
    const html = await runBrowserTool(broker, "browser_fetch", { url: `${base}/article` }, context);
    assert.equal(!html.ok && html.error.code, "bad_input");
    assert.match(!html.ok ? html.error.message : "", /web page, not a file/);
    const missing = await runBrowserTool(broker, "browser_fetch", { url: `${base}/nothing.pdf` }, context);
    assert.match(!missing.ok ? missing.error.message : "", /404/);

    const opened = await runBrowserTool(broker, "browser_open", { url: `${base}/paper.pdf` }, context);
    const tab = resultOf<{ tab: string }>(opened).tab;
    const downloaded = await runBrowserTool(broker, "browser_download", { tab, timeoutMs: 5_000 }, context);
    assert.ok(downloaded.ok, JSON.stringify(downloaded));
    const saved = downloaded.result as { path: string; mime: string };
    assert.equal(saved.mime, "application/pdf");
    assert.deepEqual(readFileSync(saved.path).subarray(0, 5).toString(), "%PDF-");
  } finally {
    await broker.shutdown();
  }
});

test("browser_extract reads a page as Markdown with its products; the interactive snapshot is short and has refs", { skip, timeout: 90_000 }, async () => {
  const { broker, context } = setup("extract");
  try {
    const extracted = await runBrowserTool(broker, "browser_extract", { url: `${site}/article` }, context);
    assert.ok(extracted.ok, JSON.stringify(extracted));
    const page = extracted.result as { tab: string; markdown: string; products: Array<{ name: string; price: number; availability: string }>; prices: Array<{ amount: number }> };
    assert.match(page.markdown, /^# PlayStation 5/m);
    assert.match(page.markdown, /\| Storage \| 825 GB \|/);
    assert.match(page.markdown, /\[Sony\]\(http:\/\/shop\.web\.test:\d+\/sony\)/);
    assert.doesNotMatch(page.markdown, /Home/);
    assert.deepEqual(page.products.map((product) => [product.name, product.price, product.availability]), [["PlayStation 5", 499.99, "in stock"]]);
    assert.ok(page.prices.some((price) => price.amount === 499.99));
    assert.match(extracted.summary, /Products: PlayStation 5/);
    const focused = resultOf<{ markdown: string; part: string }>(await runBrowserTool(broker, "browser_extract", { tab: page.tab, focus: "specifications" }, context));
    assert.equal(focused.part, "focus");
    assert.match(focused.markdown, /Storage/);
    const both = await runBrowserTool(broker, "browser_extract", { tab: page.tab, url: `${site}/article` }, context);
    assert.equal(!both.ok && both.error.code, "bad_input");

    const snapshot = await runBrowserTool(broker, "browser_snapshot", { tab: page.tab, mode: "interactive" }, context);
    assert.ok(snapshot.ok);
    const text = (snapshot.result as { snapshot: string; mode: string }).snapshot;
    assert.equal((snapshot.result as { mode: string }).mode, "interactive");
    assert.match(text, /- link "Sony" \[ref=e\d+\] → .*\/sony/);
    assert.match(text, /- heading 1 "PlayStation 5"/);
    assert.ok(text.length <= 8_000);
  } finally {
    await broker.shutdown();
  }
});

test("browser_shop: Amazon's ZIP before its prices, a refusing store read cleanly, a human check, no results, a generic shop; one screenshot each", { skip, timeout: 240_000 }, async () => {
  const { broker, context } = setup("shop");
  try {
    await (await broker.browserContext(context.operation)).addCookies([{ name: "pw", value: "1", url: site }]);
    const result = await shopStores(
      broker,
      context.operation,
      { query: "PS5 console", location: "Wisconsin", stores: ["amazon", "walmart", "bestbuy", "target", "costco", `${site}/store/generic/search?q={query}`] },
      { bases: { amazon: `${site}/store/amazon`, walmart: `${site}/store/walmart`, bestbuy: `${site}/store/bestbuy`, target: `${site}/store/target`, costco: `${site}/store/costco` } },
    );
    const by = Object.fromEntries(result.stores.map((row) => [row.store, row]));
    assert.deepEqual(result.location, { label: "Madison, WI 53703", zip: "53703", country: "US" });

    const amazon = by.amazon!;
    assert.equal(amazon.status, "ok", JSON.stringify(amazon));
    assert.equal(amazon.shown, "Deliver to Madison 53703");
    assert.deepEqual(amazon.offers.map((offer) => [offer.title, offer.price]), [
      ["PlayStation 5 Console", 499.99],
      ["Stand for PS5 Console", 29.99],
    ]);
    assert.equal(amazon.offers[0]!.url, `${site}/PlayStation-5/dp/B0CL61F39H/ref=sr_1_1`, "without its tracking parameters");
    assert.equal(amazon.offers[0]!.delivery, "FREE delivery Mon, Nov 2");
    assert.equal(amazon.offers[1]!.sponsored, true);

    assert.equal(by.walmart!.status, "ok");
    assert.deepEqual(by.walmart!.offers.map((offer) => [offer.price, offer.url]), [
      [599, "https://www.walmart.com/ip/17852302051"],
      [649, "https://www.walmart.com/ip/17816601985"],
    ]);

    const bestbuy = by.bestbuy!;
    assert.equal(bestbuy.status, "ok", JSON.stringify(bestbuy));
    assert.equal(bestbuy.mode, "clean");
    assert.deepEqual(bestbuy.offers.map((offer) => [offer.title, offer.price]), [["PlayStation 5 Slim Console – 1TB", 549.99]]);

    const target = by.target!;
    assert.equal(target.status, "human_check");
    assert.ok(target.tab && (await broker.list(context.operation)).some((tab) => tab.tab === target.tab), "the human check's tab is kept");

    assert.equal(by.costco!.status, "no_results");
    assert.match(by.costco!.text ?? "", /not able to find a match/);

    const generic = result.stores.find((row) => row.name === HOST)!;
    assert.equal(generic.status, "ok");
    assert.deepEqual(generic.offers.map((offer) => [offer.title, offer.price, offer.availability]), [["PS5 Console Slim", 479, "in stock"]], "the hose is not a PS5");

    assert.equal(result.files.length, 6, "one screenshot per store");
    for (const row of result.stores) {
      assert.ok(row.screenshot, row.store);
      assert.ok(result.files.some((file) => file.path.endsWith(row.screenshot!)), row.store);
    }
    for (const file of result.files) assert.ok(existsSync(file.path));
    assert.equal(capturedFiles(result).length, 6);
    // Only tabs kept for the owner stay open.
    assert.deepEqual((await broker.list(context.operation)).map((tab) => tab.tab), [target.tab]);
  } finally {
    await broker.shutdown();
  }
});
