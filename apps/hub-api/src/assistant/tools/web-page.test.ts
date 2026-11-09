/**
 * hub_read_web_page: a public page read as the model reads it, through save-file.ts's guards. Pages are
 * accepted only in page mode; private addresses stay refused there, whether given or reached by a redirect.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import "../../runtime/test-env.js";

const { fetchPublicFile, privateAddress, setSaveFileNetworkForTests } = await import("./save-file.js");
const { readFetched, PAGE_TEXT_CHARS, webPageTools } = await import("./web-page.js");
const { makePdf } = await import("../../files/testing.js");

const SITE = "pages.example.test";
const INTRANET = "intranet.example.test";
const PRODUCT = `<!doctype html><html><head><title>Kettle K2 | Shop</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Kettle K2","offers":{"@type":"Offer","price":"2499","priceCurrency":"INR","availability":"https://schema.org/InStock"}}</script>
</head><body><nav>Home · Kitchen · Sale</nav><main><h1>Kettle K2</h1><p>${"A steel kettle that boils a litre in three minutes. ".repeat(12)}</p>
<h2>Specifications</h2><table><tr><th>Capacity</th><td>1.7 litres</td></tr><tr><th>Power</th><td>1500 W</td></tr></table></main></body></html>`;
const LONG = `<!doctype html><html><head><title>Release schedule</title></head><body><main><h1>Releases</h1><p>${"Background text about the project and its history. ".repeat(200)}</p><h2>Release schedule</h2><p>Version 4.0 final ships on 2025-10-07.</p></main></body></html>`;

const site = createServer((request, response) => {
  const send = (status: number, type: string, body: string | Buffer) => {
    response.writeHead(status, { "content-type": type });
    response.end(body);
  };
  if (request.url === "/kettle") return send(200, "text/html; charset=utf-8", PRODUCT);
  if (request.url === "/long") return send(200, "text/html", LONG);
  if (request.url === "/app") return send(200, "text/html", `<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>`);
  if (request.url === "/notes.txt") return send(200, "text/plain", "Plain notes: the meeting is on Tuesday.");
  if (request.url === "/paper.pdf") return send(200, "application/pdf", makePdf(["Attention is all you need"]));
  if (request.url === "/blocked") return send(403, "text/html", "<html><body>Access denied</body></html>");
  if (request.url === "/to-intranet") {
    response.writeHead(302, { location: `http://${INTRANET}/admin` });
    return void response.end();
  }
  send(404, "text/plain", "not here");
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const WEB = `http://${SITE}:${(site.address() as { port: number }).port}`;

// Only the test site's name reaches this computer; every other private address is refused as in production.
setSaveFileNetworkForTests({
  lookup: async (hostname) => (hostname === SITE ? ["127.0.0.1"] : hostname === INTRANET ? ["10.0.0.7"] : []),
  allowAddress: (address, hostname) => (hostname === SITE && address === "127.0.0.1") || !privateAddress(address),
});
after(() => {
  setSaveFileNetworkForTests(null);
  site.close();
});

const tool = webPageTools.find((entry) => entry.name === "hub_read_web_page")!;
const read = (input: Record<string, unknown>) => tool.run({} as never, tool.input.parse(input));

test("a page comes back as its main text and the products it publishes, without the menu", async () => {
  const result = await read({ url: `${WEB}/kettle` });
  const page = result.data as { title: string; text: string; products: Array<{ name: string; price: number; currency: string }> };
  assert.equal(result.summary, "Read “Kettle K2 | Shop”.");
  assert.match(page.text, /# Kettle K2/);
  assert.match(page.text, /\| Capacity \| 1\.7 litres \|/);
  assert.doesNotMatch(page.text, /Home · Kitchen/);
  assert.deepEqual(page.products.map((product) => [product.name, product.price, product.currency]), [["Kettle K2", 2499, "INR"]]);
});

test("a long page is cut with a note, and focus reads the part named", async () => {
  const whole = (await read({ url: `${WEB}/long` })).data as { text: string; truncated: boolean; note: string };
  assert.equal(whole.truncated, true);
  assert.ok(whole.text.length <= PAGE_TEXT_CHARS + 50);
  assert.match(whole.note, /call again with focus/);
  const part = (await read({ url: `${WEB}/long`, focus: "release schedule" })).data as { text: string };
  assert.match(part.text, /2025-10-07/);
});

test("a page built by scripts says it could not be read; plain text and PDFs are read as they are", async () => {
  const app = (await read({ url: `${WEB}/app` })).data as { note: string };
  assert.match(app.note, /built by scripts or behind a sign-in/);
  assert.equal(((await read({ url: `${WEB}/notes.txt` })).data as { text: string }).text, "Plain notes: the meeting is on Tuesday.");
  const pdf = (await read({ url: `${WEB}/paper.pdf` })).data as { text: string; part: string };
  assert.match(pdf.text, /Attention is all you need/);
  assert.match(pdf.part, /^PDF/);
});

test("page mode keeps every guard: private addresses, redirects into them, and refusals the model can act on", async () => {
  await assert.rejects(read({ url: "http://127.0.0.1:9/" }), /private address/);
  await assert.rejects(read({ url: `${WEB}/to-intranet` }), /private address/);
  await assert.rejects(read({ url: "file:///etc/passwd" }), /Only http and https/);
  await assert.rejects(read({ url: `${WEB}/blocked` }), (error: Error & { remedy?: string }) => /That page answered 403/.test(error.message) && /another source/.test(error.remedy ?? ""));
  // Without page mode a web page is still refused, as hub_save_file needs.
  await assert.rejects(fetchPublicFile(`${WEB}/kettle`), /opened a web page, not a file/);
});

test("readFetched reads a page whose server names no type", async () => {
  const page = await readFetched({ bytes: Buffer.from("<html><head><title>T</title></head><body><main><p>Hello there, this is the page.</p></main></body></html>"), url: "https://example.org/", contentType: "" });
  assert.match(page.text, /Hello there/);
});

test("a Hub chat turn has three web searches; the next one says to read a page or answer, without searching", async () => {
  const { graphTools, WEB_SEARCHES_PER_TURN } = await import("./graph.js");
  const search = graphTools.find((entry) => entry.name === "hub_web_search")!;
  const turn = { webSearches: WEB_SEARCHES_PER_TURN };
  const result = await search.run({ turn } as never, search.input.parse({ query: "node lts" }));
  assert.equal(result.summary, "No more searches in this turn.");
  assert.match(String((result.data as { note: string }).note), /hub_read_web_page/);
  assert.equal(turn.webSearches, WEB_SEARCHES_PER_TURN + 1);
});
