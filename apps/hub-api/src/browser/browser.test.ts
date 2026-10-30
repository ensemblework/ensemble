/**
 * The broker's rules without a browser: which sites the owner marked, secret and key detection,
 * snapshot redaction, choosing a Chromium, where profiles live, and the tool set both callers
 * expose (no evaluate, no raw CDP; inputs validated before anything runs).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { BrowserBroker, hasDisplay } from "./broker.js";
import { browserSearchRoots, findChromium, listBrowserBuilds, playwrightCacheDir, playwrightRevisions, type FileProbe, type Host } from "./chromium.js";
import { browserDeniedPaths, browserProfileDir, browserRoot, ensembleDataHome, isProfileName, playwrightBrowsersDir } from "./paths.js";
import { findSecrets, hideSecrets, matchesSite, normalizeSite, redactSnapshot, siteLists, siteRule, valueFieldRefs } from "./privacy.js";
import { humanCheck } from "./human-check.js";
import { browserLook, chromiumVersion, computerLocale, HIDE_WEBDRIVER, IGNORED_DEFAULT_ARGS, LAUNCH_ARGS, userAgentFor } from "./launch.js";
import { BROWSER_TOOLS, browserToolDefinitions, runBrowserTool } from "./tools.js";
import { CAPTURE_TOOLS, captureToolDefinitions } from "../capture/tools.js";

test("site rules: an origin matches exactly; a host covers its subdomains on any scheme or port", () => {
  assert.equal(matchesSite("https://mail.example.com/inbox", "https://mail.example.com"), true);
  assert.equal(matchesSite("http://mail.example.com/inbox", "https://mail.example.com"), false);
  assert.equal(matchesSite("https://mail.example.com:8443/", "https://mail.example.com"), false);
  assert.equal(matchesSite("https://www.mybank.com/login", "mybank.com"), true);
  assert.equal(matchesSite("https://mybank.com/", "*.mybank.com"), true);
  assert.equal(matchesSite("https://notmybank.com/", "mybank.com"), false);
  assert.equal(matchesSite("http://localhost:3000/", "localhost"), true);
  assert.equal(matchesSite("not a url", "example.com"), false);
  assert.equal(siteRule("https://pay.mybank.com/", { neverCapture: ["mybank.com"], previewFirst: ["pay.mybank.com"] }), "never");
  assert.equal(siteRule("https://docs.example.com/", { previewFirst: ["example.com"] }), "preview");
  assert.equal(siteRule("https://example.org/", { neverCapture: ["example.com"] }), null);
});

test("the owner's site lists keep a host or an origin, once each", () => {
  assert.equal(normalizeSite("  Bank.Example "), "bank.example");
  assert.equal(normalizeSite("*.bank.example/login?x=1"), "bank.example");
  assert.equal(normalizeSite("localhost:3000"), "localhost");
  assert.equal(normalizeSite("https://Mail.Example.com/inbox"), "https://mail.example.com");
  assert.equal(normalizeSite("http://127.0.0.1:5173/app"), "http://127.0.0.1:5173");
  for (const bad of ["", "ftp://example.com", "javascript:alert(1)", "two words.com", "-bad-.com", "https://"]) assert.equal(normalizeSite(bad), null, bad);
  assert.deepEqual(siteLists({ never: ["mybank.com", "*.MyBank.com"], preview: ["https://mail.example.com/x"] }), { never: ["mybank.com"], preview: ["https://mail.example.com"] });
  const refused = siteLists({ never: ["fine.com", "not a site"], preview: [] });
  assert.ok("error" in refused && /not a site/.test(refused.error));
});

test("secrets: saved values (six characters or more) and key shapes are found and hidden", () => {
  const rules = { secretValues: ["s3cr3t-value", "abc"] };
  assert.deepEqual(findSecrets("the value is s3cr3t-value here", rules), { savedSecrets: 1, keyLike: 0 });
  assert.deepEqual(findSecrets("abc is too short to count", rules), { savedSecrets: 0, keyLike: 0 });
  assert.deepEqual(findSecrets('token: "ghp_abcdefghijklmnopqrstuvwxyz0123"', {}), { savedSecrets: 0, keyLike: 1 });
  assert.deepEqual(findSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nabc", {}), { savedSecrets: 0, keyLike: 1 });
  assert.deepEqual(findSecrets("an ordinary sentence about passwords", {}), { savedSecrets: 0, keyLike: 0 });
  assert.equal(hideSecrets("a s3cr3t-value and sk-abcdefghijklmnop1234", rules), "a [hidden] and [redacted]");
  assert.equal(hideSecrets('- paragraph: "is S3cr\\"et\\\\w0rd!"', { secretValues: ['S3cr"et\\w0rd!'] }), '- paragraph: "is [hidden]"', "the escaped form inside a quoted snapshot value");
});

test("snapshots: password, code and marked field values are hidden, with multi-line values", () => {
  const snapshot = [
    "- generic [ref=e1]:",
    '  - textbox "Email" [ref=e2]: mira@fieldnote.example',
    '  - textbox "Password" [ref=e3]: hunter2-hunter2',
    '  - textbox "Notes" [active] [ref=e4]: |-',
    "      line one",
    "      line two",
    '  - button "Sign in" [ref=e5]',
    '  - searchbox "Search" [ref=e6]',
  ].join("\n");
  assert.deepEqual(valueFieldRefs(snapshot), ["e2", "e3", "e4"]);
  const withPlaceholder = ['- textbox "Password" [ref=e7]:', "  - /placeholder: Enter your password", "  - text: owner-typed-Pa55word", '- button "Go" [ref=e8]'].join("\n");
  assert.deepEqual(valueFieldRefs(withPlaceholder), ["e7"], "a value under the field's line makes it a candidate");
  assert.equal(redactSnapshot(withPlaceholder, new Set(["e7"]), {}), ['- textbox "Password" [ref=e7]: [hidden]', "  - /placeholder: Enter your password", '- button "Go" [ref=e8]'].join("\n"));
  const redacted = redactSnapshot(snapshot, new Set(["e3", "e4"]), { secretValues: ["fieldnote.example"] });
  assert.equal(
    redacted,
    ["- generic [ref=e1]:", '  - textbox "Email" [ref=e2]: mira@[hidden]', '  - textbox "Password" [ref=e3]: [hidden]', '  - textbox "Notes" [active] [ref=e4]: [hidden]', '  - button "Sign in" [ref=e5]', '  - searchbox "Search" [ref=e6]'].join("\n"),
  );
});

const host = (over: Partial<Host> = {}): Host => ({ platform: "linux", arch: "x64", env: {}, home: "/home/mira", ...over });

function files(paths: string[]): FileProbe {
  const set = new Set(paths);
  return {
    exists: (path) => set.has(path),
    list: (dir) => [...new Set(paths.filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1).split("/")[0]!))],
  };
}

const wanted = playwrightRevisions();
const data = "/home/mira/.local/share/com.ensemblework.desktop";
const ours = `${data}/playwright`;
const cache = "/home/mira/.cache/ms-playwright";
const build = (root: string, dir: string, exe: string) => [`${root}/${dir}/INSTALLATION_COMPLETE`, `${root}/${dir}/${exe}`];

test("Chromium: full Chromium before the headless shell, the matching revision first, Ensemble's own before Playwright's cache, then the newest, then an installed Chrome", () => {
  const shellExe = "chrome-headless-shell-linux64/chrome-headless-shell";
  const fullExe = "chrome-linux64/chrome";
  const mixed = files([
    ...build(cache, `chromium_headless_shell-${wanted.headlessShell}`, shellExe),
    ...build(ours, `chromium_headless_shell-${wanted.headlessShell}`, shellExe),
    ...build(cache, "chromium_headless_shell-9999", shellExe),
    ...build(cache, `chromium-${wanted.chromium}`, fullExe),
    `${cache}/chromium_headless_shell-1/${shellExe}`,
  ]);
  const headless = findChromium({ headless: true, host: host(), dataHome: data, files: mixed });
  assert.deepEqual(headless, { executablePath: `${cache}/chromium-${wanted.chromium}/${fullExe}`, kind: "chromium", revision: wanted.chromium, matches: true, source: "playwright" }, "headless runs full Chromium when it is installed: sites block the headless shell");
  const shellOnly = findChromium({ headless: true, host: host(), dataHome: data, files: files([...build(cache, `chromium_headless_shell-${wanted.headlessShell}`, shellExe), ...build(ours, `chromium_headless_shell-${wanted.headlessShell}`, shellExe)]) });
  assert.deepEqual(shellOnly, { executablePath: `${ours}/chromium_headless_shell-${wanted.headlessShell}/${shellExe}`, kind: "headless-shell", revision: wanted.headlessShell, matches: true, source: "ensemble" });
  const headed = findChromium({ headless: false, host: host(), dataHome: data, files: mixed });
  assert.equal(headed?.kind, "chromium", "a window needs full Chromium");
  assert.equal(headed?.source, "playwright");
  const other = findChromium({ headless: true, host: host(), dataHome: data, files: files([...build(cache, "chromium_headless_shell-9999", shellExe), ...build(cache, "chromium_headless_shell-1000", shellExe)]) });
  assert.deepEqual([other?.revision, other?.matches], [9999, false]);
  assert.deepEqual(listBrowserBuilds([cache], host(), files([`${cache}/chromium-5/${fullExe}`])), [], "a download without its completion marker is skipped");
  const system = findChromium({ headless: true, host: host(), dataHome: data, files: files(["/usr/bin/chromium"]) });
  assert.deepEqual(system, { executablePath: "/usr/bin/chromium", kind: "system", revision: null, matches: false, source: "system" });
  assert.equal(findChromium({ headless: true, host: host(), dataHome: data, files: files([]) }), null);
  const explicit = findChromium({ headless: true, host: host({ env: { ENSEMBLE_CHROMIUM: "/opt/chrome/chrome" } }), dataHome: data, files: files(["/opt/chrome/chrome"]) });
  assert.equal(explicit?.source, "explicit");
});

test("Chromium on macOS and Windows: their layouts and cache folders", () => {
  const mac = host({ platform: "darwin", arch: "arm64" });
  assert.equal(playwrightCacheDir(mac), "/home/mira/Library/Caches/ms-playwright");
  const macRoot = playwrightCacheDir(mac);
  const found = findChromium({ headless: false, host: mac, dataHome: data, files: files(build(macRoot, `chromium-${wanted.chromium}`, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")) });
  assert.equal(found?.matches, true);
  const win = host({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\mira\\AppData\\Local" } });
  assert.equal(playwrightCacheDir(win), join("C:\\Users\\mira\\AppData\\Local", "ms-playwright"));
  assert.deepEqual(browserSearchRoots(host({ env: { PLAYWRIGHT_BROWSERS_PATH: "/shared/pw" } }), data), [ours, "/shared/pw", cache]);
  assert.deepEqual(browserSearchRoots(host({ env: { PLAYWRIGHT_BROWSERS_PATH: "0" } }), data), [ours, cache]);
});

test("paths: profiles, Playwright's downloads and capture state live in the data folder, and are denied to runs", () => {
  assert.equal(ensembleDataHome({ ENSEMBLE_REMOTE_STATE_DIR: "/srv/ens" }, "linux", "/home/mira"), "/srv/ens");
  assert.equal(ensembleDataHome({ ENSEMBLE_DATA_DIR: "/srv/ens/pglite" }, "linux", "/home/mira"), "/srv/ens");
  assert.equal(ensembleDataHome({}, "linux", "/home/mira"), data);
  assert.equal(ensembleDataHome({}, "darwin", "/Users/mira"), "/Users/mira/Library/Application Support/com.ensemblework.desktop");
  assert.equal(browserRoot("/d"), "/d/browser");
  assert.equal(browserProfileDir("default", "/d"), "/d/browser/default");
  assert.equal(playwrightBrowsersDir("/d"), "/d/playwright");
  assert.deepEqual(browserDeniedPaths("/d"), ["/d/browser", "/d/capture"]);
  assert.throws(() => browserProfileDir("../escape", "/d"), /not a browser profile name/);
  assert.equal(isProfileName("work-2"), true);
  assert.equal(isProfileName(".hidden"), false);
});

test("a display for a window: always on macOS and Windows, on Linux only with X11 or Wayland", () => {
  assert.equal(hasDisplay({}, "darwin"), true);
  assert.equal(hasDisplay({}, "linux"), false);
  assert.equal(hasDisplay({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
  assert.equal(hasDisplay({ DISPLAY: ":0" }, "linux"), true);
});

test("the tool sets: typed inputs as JSON Schema, and no evaluate or raw CDP tool", () => {
  const browser = browserToolDefinitions();
  assert.deepEqual(
    browser.map((tool) => tool.name),
    ["browser_open", "browser_tabs", "browser_close", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_wait", "browser_screenshot", "browser_console", "browser_network_errors", "browser_record", "browser_upload", "browser_login_needed", "browser_download"],
  );
  const capture = captureToolDefinitions();
  assert.deepEqual(capture.map((tool) => tool.name), ["capture_screenshot", "capture_video", "capture_app_start", "capture_app_stop", "capture_apps", "capture_check", "capture_status"]);
  for (const tool of [...browser, ...capture]) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.ok(!("$schema" in tool.inputSchema));
    assert.ok(tool.description.length > 20);
    assert.doesNotMatch(tool.name, /eval|script|cdp|devtools/i);
  }
  assert.deepEqual((browser.find((tool) => tool.name === "browser_click")!.inputSchema.required as string[]).sort(), ["ref", "tab"]);
  assert.equal(BROWSER_TOOLS.length + CAPTURE_TOOLS.length, 22);
});

test("tool calls are validated before anything runs, and fail as results, not exceptions", async () => {
  const broker = new BrowserBroker({ dataHome: "/nonexistent/ensemble-test" });
  const context = { operation: "job-validate" };
  assert.deepEqual(await runBrowserTool(broker, "browser_evaluate", { script: "1" }, context), { ok: false, error: { code: "bad_input", message: "Unknown browser tool browser_evaluate." } });
  const badTab = await runBrowserTool(broker, "browser_click", { tab: "../t1", ref: "e1" }, context);
  assert.equal(badTab.ok, false);
  assert.equal(!badTab.ok && badTab.error.code, "bad_input");
  const extra = await runBrowserTool(broker, "browser_tabs", { evaluate: "document.cookie" }, context);
  assert.equal(!extra.ok && extra.error.code, "bad_input", "unknown fields are refused");
  const file = await runBrowserTool(broker, "browser_open", { url: "file:///etc/passwd" }, context);
  assert.deepEqual(file, { ok: false, error: { code: "refused", message: "The browser opens http and https pages only, not file: addresses." } });
  const missing = await runBrowserTool(broker, "browser_snapshot", { tab: "t42" }, context);
  assert.equal(!missing.ok && missing.error.code, "not_found");
  const tabs = await runBrowserTool(broker, "browser_tabs", {}, context);
  assert.deepEqual(tabs, { ok: true, summary: "No tabs open.", result: { tabs: [] } });
  await broker.shutdown();
});

test("the browser looks like this computer's Chrome: no automation switches, no HeadlessChrome, its language and time zone", () => {
  assert.deepEqual(LAUNCH_ARGS, ["--disable-blink-features=AutomationControlled"]);
  assert.deepEqual(IGNORED_DEFAULT_ARGS, ["--enable-automation"]);
  assert.match(HIDE_WEBDRIVER, /webdriver/);
  assert.equal(userAgentFor("131.0.6778.33", "linux"), "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
  assert.equal(userAgentFor("140.0.7339.16", "darwin"), "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
  assert.match(userAgentFor("140.0.7339.16", "win32")!, /Windows NT 10\.0; Win64; x64.*Chrome\/140\.0\.0\.0/);
  assert.equal(userAgentFor(null, "linux"), null);
  assert.deepEqual(computerLocale({ locale: "en-IN", timeZone: "Asia/Kolkata" }), { locale: "en-IN", timezoneId: "Asia/Kolkata", acceptLanguage: "en-IN,en;q=0.9" });
  assert.deepEqual(computerLocale({ locale: "de", timeZone: "Europe/Berlin" }), { locale: "de", timezoneId: "Europe/Berlin", acceptLanguage: "de" });
  assert.equal(computerLocale({ locale: "x_bad", timeZone: undefined }).locale, "en-US");
  const look = browserLook({ platform: "linux", version: "131.0.6778.33", resolved: { locale: "en-GB", timeZone: "Europe/London" } });
  assert.deepEqual(look, { userAgent: userAgentFor("131.0.6778.33", "linux"), locale: "en-GB", timezoneId: "Europe/London", extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" } });
  assert.doesNotMatch(JSON.stringify(look), /Headless/);
  assert.equal(chromiumVersion("/fake/chrome-a", () => "Chromium 131.0.6778.33 snap\n"), "131.0.6778.33");
  assert.equal(chromiumVersion("/fake/chrome-b", () => ""), null, "Windows prints none");
  assert.equal(browserLook({ platform: "linux", executablePath: "/fake/chrome-a", resolved: {} }).userAgent, userAgentFor("131.0.6778.33", "linux"));
});

test("human checks and pages that block automated browsing are told apart from ordinary pages", () => {
  const page = (over: Partial<Parameters<typeof humanCheck>[0]>) => humanCheck({ title: "", text: "", frames: [], status: 200, ...over });
  assert.equal(page({ title: "Robot or human?", text: "Activate and hold the button to confirm that you're human. Thank You!" }), "\u201cRobot or human?\u201d");
  assert.equal(page({ title: "Just a moment...", text: "Checking if the site connection is secure" }), "Cloudflare's check");
  assert.equal(page({ title: "Amazon.com", text: "Enter the characters you see below\nSorry, we just need to make sure you're not a robot." }), "a robot check");
  assert.equal(page({ title: "Sorry! Something went wrong!", text: "Sorry! Something went wrong on our end.", status: 503 }), "Amazon's block (503)");
  assert.equal(page({ title: "https://www.google.com/search?q=x", text: "Our systems have detected unusual traffic from your computer network." }), "an unusual-traffic block");
  assert.equal(page({ title: "Access Denied", text: "You don't have permission to access \"http://www.bestbuy.com/\" on this server. Reference #18.5f2" }), "an Akamai block");
  assert.equal(page({ title: "Sign in", text: "Email\nPassword", frames: ["https://www.google.com/recaptcha/api2/anchor?ar=1&k=abc&size=normal"] }), "a reCAPTCHA");
  assert.equal(page({ title: "Log in", frames: ["https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox"] }), "an hCaptcha");
  assert.equal(page({ title: "Checkout", frames: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/ov2"] }), "Cloudflare's check");
  assert.equal(page({ title: "Forbidden", text: "Blocked: automated traffic is not allowed.", status: 403 }), "a block of automated browsing");
  // Ordinary pages: an invisible reCAPTCHA, a long article that mentions robots, a 503 that is not Amazon's, an access-denied page of an app.
  assert.equal(page({ title: "Contact us", text: "Write to us", frames: ["https://www.google.com/recaptcha/api2/anchor?ar=1&k=abc&size=invisible"] }), null);
  assert.equal(page({ title: "How captchas work", text: `${"Some sites ask: are you a robot? ".repeat(5)}${"x".repeat(5000)}` }), null);
  assert.equal(page({ title: "Maintenance", text: "We will be back soon.", status: 503 }), null);
  assert.equal(page({ title: "Access denied", text: "Ask your admin for access to this project." }), null);
  assert.equal(page({ title: "Laptop support", text: "Press and hold the power button for 10 seconds." }), null);
});
