import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { cleanArgs, CleanBrowser, cookieForHost, fromCdpCookie, type CleanPage } from "./clean.js";
import { findChromium } from "./chromium.js";

test("a clean browser's switches: the DevTools pipe, no automation switches, headless with a real user agent", () => {
  const args = cleanArgs({ executablePath: "/x/chrome", userDataDir: "/tmp/p", headless: true, userAgent: "Mozilla/5.0 X", locale: "en-US", platform: "linux" });
  assert.ok(args.includes("--remote-debugging-pipe"));
  assert.ok(!args.some((arg) => arg.startsWith("--remote-debugging-port")), "no port another program could reach");
  assert.ok(!args.includes("--enable-automation"));
  assert.ok(args.includes("--disable-blink-features=AutomationControlled"));
  assert.ok(args.includes("--headless=new") && args.includes("--user-agent=Mozilla/5.0 X") && args.includes("--lang=en-US"));
  assert.ok(args.includes("--no-sandbox"), "Linux: as Playwright does");
  assert.ok(!cleanArgs({ executablePath: "/x", userDataDir: "/p", headless: false, platform: "darwin" }).includes("--no-sandbox"));
  assert.equal(args.at(-1), "about:blank");
});

test("cookies: session and persistent, Playwright's shape; which belong to a site", () => {
  assert.deepEqual(fromCdpCookie({ name: "SID", value: "v", domain: ".google.com", path: "/", expires: 1893456000.5, httpOnly: true, secure: true, session: false, sameSite: "Lax" }), { name: "SID", value: "v", domain: ".google.com", path: "/", expires: 1893456000, httpOnly: true, secure: true, sameSite: "Lax" });
  assert.equal(fromCdpCookie({ name: "s", value: "v", domain: "a.com", expires: -1, session: true })!.expires, -1);
  assert.equal(fromCdpCookie({ name: 1, value: "v", domain: "a.com" } as never), null);
  assert.ok(cookieForHost({ domain: ".walmart.com" }, "www.walmart.com"));
  assert.ok(cookieForHost({ domain: "portal.azure.com" }, "portal.azure.com"));
  assert.ok(!cookieForHost({ domain: ".evil.com" }, "walmart.com"));
});

const chromium = findChromium({ headless: true });
let server: Server;
let base = "";
before(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/login") && req.method === "POST") {
      res.writeHead(302, { "set-cookie": ["session=ok; Path=/; HttpOnly", "keep=1; Path=/; Max-Age=3600"], location: "/home" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url?.startsWith("/home")) return res.end(`<title>Home</title><h1 id="marker">Signed in home</h1>`);
    if (req.url?.startsWith("/popup")) return res.end(`<title>Popup</title><p>popup page</p>`);
    res.end(`<title>Sign in</title><body style="margin:0"><form method="post" action="/login"><input id="u" name="u" style="position:absolute;left:0;top:0;width:400px;height:60px"></form><a id="open" href="#" style="position:absolute;left:0;top:200px;width:400px;height:60px;display:block" onclick="window.open('/popup','_blank','width=400,height=400');return false">open</a></body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("a clean browser navigates, types with real input, follows a popup and reads cookies, with no page script", { skip: chromium ? false : "no Chromium on this computer", timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "clean-browser-"));
  const browser = await CleanBrowser.launch({ executablePath: chromium!.executablePath, userDataDir: dir, headless: true, userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" });
  try {
    const page = browser.pages()[0] ?? (await browser.newPage());
    await page.goto(`${base}/`);
    assert.equal((await page.refresh()).title, "Sign in");
    const shot = await page.screenshot();
    assert.ok(shot.subarray(1, 4).toString() === "PNG" && shot.length > 500, "a PNG of the page");

    // A popup opened by the page becomes a tab of the browser, with its opener.
    const popup = new Promise<CleanPage>((resolve) => browser.once("page", resolve));
    await page.mouse("mousePressed", 50, 230);
    await page.mouse("mouseReleased", 50, 230);
    const opened = await Promise.race([popup, new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000))]);
    assert.ok(opened, "the popup became a tab");
    assert.equal(opened.openerId, page.targetId);
    await opened.close();

    // Typed text through Input.insertText, then Enter submits the form: the server's cookies land.
    await page.goto(`${base}/`);
    await page.mouse("mousePressed", 50, 30);
    await page.mouse("mouseReleased", 50, 30);
    await page.insertText("akash");
    const loaded = page.waitFor("load", 10_000);
    // As Puppeteer types Enter: a keyDown with its text, which submits the form.
    await page.key("keyDown", { key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
    await page.key("keyUp", { key: "Enter", code: "Enter", keyCode: 13 });
    await loaded;
    assert.equal((await page.refresh()).url, `${base}/home`);
    assert.match(await page.html(), /Signed in home/);
    const cookies = await browser.cookies();
    const session = cookies.find((cookie) => cookie.name === "session");
    assert.ok(session && session.expires === -1 && session.httpOnly, "the session cookie, as Playwright would take it");
    assert.ok(cookies.find((cookie) => cookie.name === "keep" && cookie.expires > 0));
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
