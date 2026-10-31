/**
 * Sign-ins and human checks on the computer, version 2 (docs/35 §8.16.1–2), against local sites in a
 * real Chromium: a sign-in seen done by itself, by a change (the sign-in form, then the site with a new
 * session), and not before; a human check that becomes the page after a click, in the node's tab and in
 * the clean browser; the owner signing in from the web in the clean browser, which follows a "Sign in
 * with ID" popup and back, then moves its cookies (session ones too, and the identity provider's) into
 * the node's browser, whose tab then shows the signed-in page; a window on this computer doing the same;
 * a typed login that asks for a one-time code, answered sealed as typed values are; no sign-in seen on a
 * challenge page. Skips without a Chromium.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const scratch = mkdtempSync(join(homedir(), ".ensemble-signin-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(scratch, "computer");
process.env.ENSEMBLE_SECRET_KEY = randomBytes(32).toString("base64");

const { BrowserBroker } = await import("../browser/broker.js");
const { runBrowserTool } = await import("../browser/tools.js");
const { resolveLogin, waitForLogin, openCleanSignIn, cleanSignInOf, raiseLogin, setLoginStateSink, endAllLogins } = await import("./requests.js");
const { cleanSignInOptionsForTests, closeCleanBrowsers } = await import("./clean-signin.js");
const { loginResolution } = await import("./answer.js");
const { signedInCheck } = await import("./fill.js");
const { makeSealKey, saveSealKey } = await import("../credentials/seal-key.js");
const { updateSettings } = await import("../remote/store.js");
const { sealFor } = await import("@ensemble/shared-types");

const SITE_HOST = "ledger.example.test";
const ID_HOST = "id.example.test";
const USER = "mira@example.test";
const PASSWORD = `pw-${randomBytes(6).toString("hex")}`;
const CODE = String(100000 + Math.floor(Math.random() * 899999));
let askForCode: false | "app" | "sms" = false;
const sessions = new Set<string>();
const steps = new Set<string>();
const tokens = new Set<string>();
const idSessions = new Set<string>();

async function form(request: IncomingMessage): Promise<URLSearchParams> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return new URLSearchParams(text);
}
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title><style>body{font:16px sans-serif;margin:24px} input,button{display:block;margin:8px 0;padding:8px;width:280px}</style></head><body>${body}</body></html>`;
const cookie = (request: IncomingMessage, name: string) => new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9]+)`).exec(request.headers.cookie ?? "")?.[1];

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://x");
  const host = (request.headers.host ?? "").split(":")[0];
  response.setHeader("content-type", "text/html");
  if (host === ID_HOST) {
    if (url.pathname === "/authorize" && request.method === "POST") {
      void form(request).then((fields) => {
        if (fields.get("username") !== USER || fields.get("password") !== PASSWORD) return void response.end(page("Sign in - ID", "<p>Wrong.</p>"));
        const id = randomBytes(8).toString("hex");
        idSessions.add(id);
        const token = randomBytes(8).toString("hex");
        tokens.add(token);
        const back = `${fields.get("return")}?token=${token}`;
        response.writeHead(200, { "set-cookie": `idsession=${id}; Path=/; Max-Age=86400; HttpOnly` });
        response.end(page("Signed in - ID", `<p>Going back…</p><script>window.opener.location = ${JSON.stringify(back)}; setTimeout(() => window.close(), 300);</script>`));
      });
      return;
    }
    return void response.end(page("Sign in - ID", `<h1>ID</h1><form method="post" action="/authorize"><input type="hidden" name="return" value="${url.searchParams.get("return") ?? ""}"><input id="u" name="username" autocomplete="username" aria-label="User"><input id="p" name="password" type="password" aria-label="Password"><button>Sign in</button></form>`));
  }
  const signedIn = (() => {
    const value = cookie(request, "session");
    return Boolean(value && sessions.has(value));
  })();
  const startSession = (location: string) => {
    const token = randomBytes(8).toString("hex");
    sessions.add(token);
    response.writeHead(303, { "set-cookie": `session=${token}; Path=/; HttpOnly`, location });
    response.end();
  };
  if (url.pathname === "/login" && request.method === "POST") {
    void form(request).then((fields) => {
      if (fields.get("email") !== USER || fields.get("password") !== PASSWORD) return void response.end(page("Sign in", `<p role="alert">That email and password do not match.</p><form method="post" action="/login"><input name="email" type="email"><input name="password" type="password"><button>Sign in</button></form>`));
      if (!askForCode) return startSession("/dashboard");
      const step = randomBytes(8).toString("hex");
      steps.add(step);
      response.writeHead(303, { "set-cookie": `step=${step}; Path=/; HttpOnly`, location: "/login/code" });
      response.end();
    });
    return;
  }
  if (url.pathname === "/login") {
    return void response.end(
      page(
        "Sign in",
        `<h1>Sign in to Ledger</h1><form method="post" action="/login"><input id="email" name="email" type="email" autocomplete="username" aria-label="Email"><input id="password" name="password" type="password" autocomplete="current-password" aria-label="Password"><button>Sign in</button></form><button id="with-id" onclick="window.open('http://${ID_HOST}:${port()}/authorize?return=' + encodeURIComponent(location.origin + '/callback'), 'signin', 'width=520,height=600')">Sign in with ID</button>`,
      ),
    );
  }
  if (url.pathname === "/login/code" && request.method === "POST") {
    void form(request).then((fields) => {
      const step = cookie(request, "step");
      if (!step || !steps.has(step) || (fields.get("code") ?? fields.get("smsCode")) !== CODE) return void response.end(page("Two-step verification", `<p role="alert">That code is not right.</p><p>Enter the 6-digit code from your authenticator app.</p><form method="post" action="/login/code"><input name="code" autocomplete="one-time-code" inputmode="numeric"><button>Verify</button></form>`));
      steps.delete(step);
      startSession("/dashboard");
    });
    return;
  }
  if (url.pathname === "/login/code" && askForCode === "sms") return void response.end(page("Verify it's you", `<h1>Verify it's you</h1><p>We texted a code to your phone number ending in 42.</p><form method="post" action="/login/code"><input name="smsCode" type="tel"><button>Verify</button></form>`));
  if (url.pathname === "/login/code") return void response.end(page("Two-step verification", `<h1>Two-step verification</h1><p>Enter the 6-digit code from your authenticator app.</p><form method="post" action="/login/code"><input name="code" autocomplete="one-time-code" inputmode="numeric"><button>Verify</button></form>`));
  if (url.pathname === "/callback") {
    const token = url.searchParams.get("token") ?? "";
    if (!tokens.delete(token)) return void response.end(page("Sign in", "<p>That did not work.</p>"));
    return startSession("/dashboard");
  }
  if (url.pathname === "/dashboard") {
    if (!signedIn) {
      response.writeHead(302, { location: "/login" });
      return void response.end();
    }
    return void response.end(page("Ledger", `<h1>Welcome back</h1><p>3 invoices are due this week.</p>`));
  }
  if (url.pathname === "/check" && request.method === "POST") {
    response.writeHead(303, { "set-cookie": "human=ok; Path=/", location: "/check" });
    return void response.end();
  }
  if (url.pathname === "/check") {
    if (cookie(request, "human") === "ok") return void response.end(page("Prices", `<h1>Prices</h1><p>PlayStation 5: $499.</p>`));
    return void response.end(page("Just a moment...", `<h1>Verify you are human</h1><form method="post" action="/check"><button id="human">I am human</button></form>`));
  }
  if (url.pathname === "/robot") return void response.end(page("Robot or human?", `<p>Activate and hold the button to confirm that you're human.</p>`));
  response.statusCode = 404;
  response.end(page("Not found", "<p>Not here.</p>"));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
function port(): number {
  return (server.address() as { port: number }).port;
}
const SITE = `http://${SITE_HOST}:${port()}`;

const ARGS = [`--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1, MAP ${ID_HOST} 127.0.0.1`];
const probe = new BrowserBroker({ dataHome: join(scratch, "probe"), args: ARGS });
const chromium = probe.chromium(false);
const skip = chromium ? false : "no Chromium with a window on this computer (`ensemble capture setup` installs one)";

/** A broker as the runtime has it: the shared profile, no screen unless `display`. */
function newBroker(name: string, display = false): InstanceType<typeof BrowserBroker> {
  return new BrowserBroker({ dataHome: join(scratch, name), args: ARGS, privacy: async () => ({}), env: { ...process.env, DISPLAY: display ? ":99" : "", WAYLAND_DISPLAY: "" } });
}

after(async () => {
  setLoginStateSink(null);
  await endAllLogins("done").catch(() => undefined);
  await closeCleanBrowsers().catch(() => undefined);
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function until<T>(check: () => Promise<T | null | false | undefined> | T | null | false | undefined, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function settles<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
  return Promise.race([promise, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms))]);
}

type Login = { loginId: string; tab: string; purpose: string; reasons: string[]; origin: string };

/** Opens a page for the work; returns the tab and the sign-in it raised, if any. */
async function open(broker: InstanceType<typeof BrowserBroker>, operation: string, url: string): Promise<{ tab: string; login?: Login; summary: string }> {
  const opened = await runBrowserTool(broker, "browser_open", { url }, { operation });
  assert.ok(opened.ok, JSON.stringify(opened));
  const result = opened.result as { tab: string; login?: Login };
  return { tab: result.tab, login: result.login, summary: opened.summary };
}

/** A person takes a moment before acting on a page: the clean browser has looked at it once. */
async function firstLook(session: NonNullable<ReturnType<typeof cleanSignInOf>>): Promise<void> {
  await until(() => session.lastJudged, "the clean browser's first look");
}

/** The owner's tap on an element of the clean browser's page shown, as fractions of the page. */
async function tap(session: NonNullable<ReturnType<typeof cleanSignInOf>>, selector: string): Promise<void> {
  const page = session.current!;
  const spot = await until(() => page.find(selector), `${selector} on the clean page`);
  const size = await page.viewport();
  const point = { x: spot.x / size.width, y: spot.y / size.height };
  await session.input({ t: "mouse", type: "down", ...point, button: "left", clicks: 1 });
  await session.input({ t: "mouse", type: "up", ...point, button: "left", clicks: 1 });
}

const key = async (session: NonNullable<ReturnType<typeof cleanSignInOf>>, name: string) => {
  await session.input({ t: "key", type: "down", key: name });
  await session.input({ t: "key", type: "up", key: name });
};

test("a sign-in is seen done by itself only after a change: the form, then the site with a new session; a page that already looked signed in waits for a check", { skip, timeout: 120_000 }, async () => {
  const broker = newBroker("auto");
  const told: Array<{ loginId: string; status: string; via?: string }> = [];
  setLoginStateSink(async (loginId, state) => void told.push({ loginId, ...state }));
  try {
    // A node's own operation: the web raised its card, so it hears how it ended.
    const OP = "node:auto:own";
    const opened = await open(broker, OP, `${SITE}/dashboard`);
    assert.ok(opened.login, "the sign-in form raised a sign-in");
    assert.equal(opened.login.purpose, "sign_in");
    const outcome = waitForLogin(opened.login.loginId);
    assert.equal(await settles(outcome, 3_000), "pending", "nothing is done while the form shows");

    // The owner signs in at the computer, in the paused tab, and says nothing: it is seen.
    const tab = broker.ownerTab(opened.tab);
    await tab.page.fill("#email", USER);
    await tab.page.fill("#password", PASSWORD);
    await Promise.all([tab.page.waitForURL("**/dashboard"), tab.page.press("#password", "Enter")]);
    const ended = await settles(outcome, 15_000);
    assert.ok(ended !== "pending" && ended.status === "signed_in", JSON.stringify(ended));
    assert.equal(broker.ownerTab(opened.tab).sensitive, false, "the tab is the work's again");
    assert.deepEqual(told.find((row) => row.loginId === opened.login!.loginId), { loginId: opened.login.loginId, status: "signed_in", message: `Signed in to ${SITE}.`, via: "computer" }, "the web hears it");
    const read = await runBrowserTool(broker, "browser_snapshot", { tab: opened.tab }, { operation: OP });
    assert.ok(read.ok && /Welcome back/.test(read.summary));

    // A sign-in asked for on a page that already looks signed in is never "seen" done (no change); the work's check finds it.
    const asked = await runBrowserTool(broker, "browser_login_needed", { tab: opened.tab, reason: "to read the invoices" }, { operation: OP });
    assert.ok(asked.ok);
    const second = (asked.result as { login: Login }).login;
    assert.equal(await settles(waitForLogin(second.loginId), 5_000), "pending", "no change, nothing seen");
    const checked = await runBrowserTool(broker, "browser_login_check", { tab: opened.tab }, { operation: OP });
    assert.ok(checked.ok, JSON.stringify(checked));
    assert.equal((checked.result as { status: string }).status, "signed_in");
    assert.match(checked.summary, /Tab t\d+ is yours again/);
    assert.equal(told.find((row) => row.loginId === second.loginId)?.via, "check", "the web hears the node checked it");
    const again = await runBrowserTool(broker, "browser_login_check", { tab: opened.tab }, { operation: OP });
    assert.ok(again.ok && (again.result as { status: string }).status === "signed_in", "asked again, it says so");

    // A run started on this computer, which the web never heard of: its sign-in stays here.
    const local = await open(broker, "local-run", `${SITE}/dashboard`);
    assert.equal(local.login, undefined, "signed in already, in the same profile");
    const localAsked = await runBrowserTool(broker, "browser_login_needed", { tab: local.tab, reason: "to be sure" }, { operation: "local-run" });
    assert.ok(localAsked.ok);
    const toldBefore = told.length;
    const localChecked = await runBrowserTool(broker, "browser_login_check", { tab: local.tab }, { operation: "local-run" });
    assert.ok(localChecked.ok && (localChecked.result as { status: string }).status === "signed_in");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(told.length, toldBefore, "nothing told for a run the web does not know");
  } finally {
    setLoginStateSink(null);
    await broker.shutdown();
  }
});

test("a human check: raised as one whatever the work says, typed logins refused, never seen signed in; passed after the click, in the tab and in the clean browser", { skip, timeout: 150_000 }, async () => {
  const broker = newBroker("human");
  try {
    // "Robot or human?" with no sign-in form: a sign-in asked for there is a human check.
    const robot = await open(broker, "op-human", `${SITE}/robot`);
    assert.match(robot.summary, /browser_login_needed \(purpose: "human_check"\)/);
    const asked = await runBrowserTool(broker, "browser_login_needed", { tab: robot.tab, purpose: "sign_in", reason: "to see the prices" }, { operation: "op-human" });
    assert.ok(asked.ok);
    const robotLogin = (asked.result as { login: Login }).login;
    assert.equal(robotLogin.purpose, "human_check");
    assert.equal(robotLogin.reasons[0], "the page shows \u201cRobot or human?\u201d");
    assert.match(asked.summary, /shows a human check/);
    const typed = await resolveLogin(robotLogin.loginId, "typed", { values: { username: USER, password: PASSWORD }, save: false });
    assert.equal(typed.status, "failed");
    assert.match(typed.message ?? "", /human check/);
    assert.equal((await resolveLogin(robotLogin.loginId, "check")).status, "waiting", "the challenge still shows");
    const page = broker.ownerTab(robot.tab).page;
    const check = await signedInCheck(page, SITE, null);
    assert.deepEqual([check.ok, check.challenge], [false, "\u201cRobot or human?\u201d"], "a challenge page is never signed in");
    assert.equal(await settles(waitForLogin(robotLogin.loginId), 4_000), "pending");
    await resolveLogin(robotLogin.loginId, "decline");

    // In the tab: the owner clicks through; it is seen passed, and the page is left as it is.
    const human = await open(broker, "op-human", `${SITE}/check`);
    const raised = await runBrowserTool(broker, "browser_login_needed", { tab: human.tab, purpose: "human_check" }, { operation: "op-human" });
    assert.ok(raised.ok);
    const humanLogin = (raised.result as { login: Login }).login;
    const outcome = waitForLogin(humanLogin.loginId);
    assert.equal(await settles(outcome, 3_000), "pending");
    await Promise.all([broker.ownerTab(human.tab).page.waitForURL("**/check"), broker.ownerTab(human.tab).page.click("#human")]);
    const passed = await settles(outcome, 15_000);
    assert.ok(passed !== "pending" && passed.status === "passed", JSON.stringify(passed));
    const prices = await runBrowserTool(broker, "browser_snapshot", { tab: human.tab }, { operation: "op-human" });
    assert.ok(prices.ok && /\$499/.test(prices.summary));

    // In the clean browser (a fresh tab, no cookie yet): the owner clicks there; its cookie moves into the tab.
    const fresh = await open(broker, "op-human-2", `${SITE}/check?again=1`);
    await broker.ownerTab(fresh.tab).context.clearCookies();
    await broker.ownerTab(fresh.tab).page.reload();
    const raisedAgain = await runBrowserTool(broker, "browser_login_needed", { tab: fresh.tab }, { operation: "op-human-2" });
    assert.ok(raisedAgain.ok);
    const cleanLogin = (raisedAgain.result as { login: Login }).login;
    assert.equal(cleanLogin.purpose, "human_check", "seen as one from the page");
    const session = await openCleanSignIn(cleanLogin.loginId, "takeover");
    await session.startStreaming();
    await firstLook(session);
    await tap(session, "#human");
    const cleanPassed = await settles(waitForLogin(cleanLogin.loginId), 20_000);
    assert.ok(cleanPassed !== "pending" && cleanPassed.status === "passed", JSON.stringify(cleanPassed));
    assert.ok(session.closed, "its clean browser's pages closed");
    assert.ok((await broker.ownerTab(fresh.tab).context.cookies()).some((item) => item.name === "human" && item.value === "ok"), "the check's cookie moved into the node's browser");
    const after = await runBrowserTool(broker, "browser_snapshot", { tab: fresh.tab }, { operation: "op-human-2" });
    assert.ok(after.ok && /\$499/.test(after.summary), "the node's tab shows the page now");
  } finally {
    await closeCleanBrowsers();
    await broker.shutdown();
  }
});

test("signing in from the web in the clean browser: it follows the \u201cSign in with ID\u201d popup and back, then the session (cookies of the site and the identity provider, session ones too) moves into the node's tab", { skip, timeout: 180_000 }, async () => {
  const broker = newBroker("popup");
  try {
    const opened = await open(broker, "op-popup", `${SITE}/dashboard`);
    const login = opened.login!;
    const session = await openCleanSignIn(login.loginId, "takeover");
    const frames: Array<{ url: string; site: string; popup: boolean; size: number }> = [];
    session.on("frame", (frame: { url: string; site: string; popup: boolean; jpeg: Buffer }) => frames.push({ url: frame.url, site: frame.site, popup: frame.popup, size: frame.jpeg.length }));
    const size = await session.startStreaming();
    assert.ok(size.width > 300 && size.height > 300, JSON.stringify(size));
    await until(() => frames.find((frame) => /\/login$/.test(frame.url) && frame.site === SITE_HOST && !frame.popup), "a frame of the sign-in page");
    await firstLook(session);

    await tap(session, "#with-id");
    await until(() => frames.find((frame) => frame.popup && frame.site === ID_HOST), "the popup shown");
    assert.equal(session.pages.length, 2);
    assert.equal(session.current, session.pages[1], "input goes to the popup");
    await tap(session, "#u");
    await session.input({ t: "text", text: USER });
    await key(session, "Tab");
    // Typed key by key, as a phone's keyboard sends it: printable keys are keyDown with their text.
    for (const char of PASSWORD) await key(session, char);
    const outcome = waitForLogin(login.loginId);
    await key(session, "Enter");

    const done = await settles(outcome, 30_000);
    assert.ok(done !== "pending" && done.status === "signed_in", JSON.stringify(done));
    const popupAt = frames.findIndex((frame) => frame.popup);
    assert.ok(frames.slice(popupAt).some((frame) => !frame.popup), "back to the sign-in's own page when the popup closed");
    assert.ok(frames.every((frame) => frame.size > 500), "JPEG frames");
    assert.ok(session.closed);
    assert.ok(session.visited.has(ID_HOST) && session.visited.has(SITE_HOST), "the hosts it went to");

    const cookies = await broker.ownerTab(opened.tab).context.cookies();
    const site = cookies.find((item) => item.name === "session" && item.domain === SITE_HOST);
    assert.ok(site, "the site's session cookie moved");
    assert.equal(site.expires, -1, "as a session cookie");
    assert.ok(site.httpOnly);
    assert.ok(cookies.some((item) => item.name === "idsession" && item.domain === ID_HOST && item.expires > 0), "the identity provider's cookie moved too");
    assert.match(broker.ownerTab(opened.tab).page.url(), /\/dashboard$/, "the node's tab is on the signed-in page");
    const read = await runBrowserTool(broker, "browser_snapshot", { tab: opened.tab }, { operation: "op-popup" });
    assert.ok(read.ok && /Welcome back/.test(read.summary), "and reads it");
  } finally {
    await closeCleanBrowsers();
    await broker.shutdown();
  }
});

test("the window on this computer: the same clean browser, seen done, its session moved, and it closes", { skip, timeout: 150_000 }, async () => {
  cleanSignInOptionsForTests({ windowHeadless: true });
  const broker = newBroker("window", true);
  try {
    const opened = await open(broker, "op-window", `${SITE}/dashboard`);
    const login = opened.login!;
    assert.equal((await resolveLogin(login.loginId, "local")).status, "shown");
    const session = cleanSignInOf(login.loginId)!;
    assert.ok(session, "a clean browser is open for it");
    await until(async () => (await session.current!.find("#email")) !== null, "the sign-in page");
    await firstLook(session);
    const outcome = waitForLogin(login.loginId);
    await tap(session, "#email");
    await session.input({ t: "text", text: USER });
    await tap(session, "#password");
    await session.input({ t: "text", text: PASSWORD });
    await key(session, "Enter");
    const done = await settles(outcome, 30_000);
    assert.ok(done !== "pending" && done.status === "signed_in", JSON.stringify(done));
    assert.ok(session.closed);
    const read = await runBrowserTool(broker, "browser_snapshot", { tab: opened.tab }, { operation: "op-window" });
    assert.ok(read.ok && /Welcome back/.test(read.summary));
    // No screen: no window.
    const plain = newBroker("no-screen");
    try {
      const other = await open(plain, "op-noscreen", `${SITE}/login?x=1`);
      assert.equal((await resolveLogin(other.login!.loginId, "local")).status, "no_window");
    } finally {
      await plain.shutdown();
    }
  } finally {
    cleanSignInOptionsForTests({ windowHeadless: false });
    await closeCleanBrowsers();
    await broker.shutdown();
  }
});

test("a typed login the site follows with a one-time code: needs_code with what it asks, then the code (sealed like typed values) signs in", { skip, timeout: 150_000 }, async () => {
  askForCode = "app";
  const broker = newBroker("code");
  const deviceId = "6f0f7d2e-58c4-4f5e-9b1d-2a8c3e4f5a6b";
  const sealKey = saveSealKey(makeSealKey(), deviceId);
  updateSettings({ deviceId, apiBase: "https://api.ensemblework.com", pairedAt: new Date().toISOString() });
  const NODE_SITE = "https://node.ensemblework.com";
  try {
    const opened = await open(broker, "op-code", `${SITE}/dashboard`);
    const login = opened.login!;
    const decisionId = "card-1";
    const box = (payload: Record<string, unknown>) => sealFor(sealKey.info, { purpose: "login", deviceId, decisionId, name: login.loginId, origin: NODE_SITE }, payload);
    const typed = await loginResolution({ id: "r1", loginId: login.loginId, decisionId, action: "typed", sealed: (await box({ origin: SITE, username: USER, password: PASSWORD })).sealed, v: 2 });
    assert.equal(typed.status, "needs_code", JSON.stringify(typed));
    assert.equal(typed.message, "Enter the 6-digit code from your authenticator app.");
    assert.equal(await settles(waitForLogin(login.loginId), 3_000), "pending", "the code page is not signed in");

    const wrong = await loginResolution({ id: "r2", loginId: login.loginId, decisionId, action: "code", sealed: (await box({ origin: SITE, code: "000000" })).sealed, v: 2 });
    assert.equal(wrong.status, "needs_code");
    assert.match(wrong.message ?? "", /did not take that code/);
    const empty = await loginResolution({ id: "r3", loginId: login.loginId, decisionId, action: "code", sealed: (await box({ origin: SITE, username: USER })).sealed, v: 2 });
    assert.equal(empty.code, "seal_shape", "a code box must hold a code");

    const right = await loginResolution({ id: "r4", loginId: login.loginId, decisionId, action: "code", sealed: (await box({ origin: SITE, code: CODE })).sealed, v: 2 });
    assert.equal(right.status, "signed_in", JSON.stringify(right));
    const read = await runBrowserTool(broker, "browser_snapshot", { tab: opened.tab }, { operation: "op-code" });
    assert.ok(read.ok && /Welcome back/.test(read.summary));

    // A code field the site names its own way gets the code too; a login asked to be saved is tried once the code signs in.
    askForCode = "sms";
    await broker.ownerTab(opened.tab).context.clearCookies();
    const second = await open(broker, "op-code-2", `${SITE}/dashboard`);
    const typedAgain = await resolveLogin(second.login!.loginId, "typed", { values: { username: USER, password: PASSWORD }, save: true });
    assert.deepEqual(typedAgain, { status: "needs_code", message: "Enter the code the site sent to your phone." });
    const coded = await resolveLogin(second.login!.loginId, "code", { values: { code: () => CODE }, save: false });
    assert.equal(coded.status, "signed_in", JSON.stringify(coded));
    assert.equal(coded.savedNow, false, "tried: a plain-http site's login is not kept");
  } finally {
    askForCode = false;
    await broker.shutdown();
  }
});

test("a sign-in raised on a page with no sign-in form fills nothing and is never signed in", { skip, timeout: 90_000 }, async () => {
  const broker = newBroker("nothing");
  try {
    const opened = await open(broker, "op-nothing", `${SITE}/check`);
    const login = await raiseLogin(broker, { operation: "op-nothing", tab: opened.tab, origin: SITE, reasons: ["test"], purpose: "sign_in" });
    const typed = await resolveLogin(login.loginId, "typed", { values: { username: USER, password: PASSWORD }, save: false });
    assert.equal(typed.status, "failed");
    assert.match(typed.message ?? "", /no sign-in form/);
    assert.equal((await resolveLogin(login.loginId, "done")).status, "waiting", "a challenge page is not signed in");
  } finally {
    await broker.shutdown();
  }
});
