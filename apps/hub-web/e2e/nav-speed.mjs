/**
 * Production nav speed for Today, Board, Context, and Marketplace.
 *
 * Context must paint its lens with the Suspense fallback never committed when
 * data is already fast. A click on each route must show that route's content
 * or its loading skeleton within 100ms, and main must not go blank. The
 * sidebar shell stays mounted. Reduced motion keeps a shown skeleton still.
 *
 *   HUB_WEB=http://127.0.0.1:3000 node apps/hub-web/e2e/nav-speed.mjs
 *
 * NAV_SPEED_TIMING_ONLY=1 prints medians and skips the assertions. Used to
 * record the build from before this change.
 */
import assert from "node:assert/strict";
import { markTester } from "./sql-change.mjs";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME = process.env.CHROME ?? (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");
const TIMING_ONLY = process.env.NAV_SPEED_TIMING_ONLY === "1";
const RUNS = Number(process.env.NAV_SPEED_RUNS ?? 3);
const START = "/needs-me";

const ROUTES = [
  { path: "/today", id: "today", content: "[data-desk]" },
  { path: "/board", id: "board", content: "main h1" },
  { path: "/context", id: "context", content: "[data-context-lens], [data-context-view]" },
  { path: "/marketplace", id: "marketplace", content: "[data-market-card]" },
];

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const PAGE_HOOK = `(() => {
  const known = { "/today": "today", "/board": "board", "/context": "context", "/marketplace": "marketplace" };
  function hasContent(main, path) {
    if (!main || !known[path]) return false;
    const hit = (selector) => [...main.querySelectorAll(selector)].some((node) => !node.closest("[data-route-loading]"));
    if (path === "/today") return hit("[data-desk]");
    if (path === "/board") return hit("[data-column], h1");
    if (path === "/context") return hit("[data-context-lens], [data-context-view]");
    if (path === "/marketplace") return hit("[data-market-card]");
    return false;
  }
  window.__navSpeed = { hasContent, known };
  const state = { contentAt: 0, suspense: false, blank: false };
  window.__loadMark = state;
  const watch = () => {
    const path = location.pathname;
    const main = document.querySelector("main");
    const suspense = Boolean(document.querySelector("[data-context-suspense]"));
    if (suspense) {
      state.suspense = true;
      state.contentAt = 0;
    }
    if (hasContent(main, path) && !suspense && !state.contentAt) state.contentAt = performance.now();
    if (main && path !== "/" && main.childElementCount === 0 && !((main.innerText || "").trim())) state.blank = true;
  };
  const boot = () => {
    if (!document.documentElement || document.documentElement.dataset.navWatch === "1") return;
    document.documentElement.dataset.navWatch = "1";
    new MutationObserver(watch).observe(document.documentElement, { childList: true, subtree: true });
    watch();
  };
  boot();
  document.addEventListener("DOMContentLoaded", boot);
})();`;

async function signUp() {
  const email = `nav-speed-${Date.now().toString(36)}@ensemble.test`;
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "nav-speed-pass-1", name: "Nav Speed" }),
  });
  if (!signup.ok) throw new Error(`signup ${signup.status} ${await signup.text()}`);
  const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
  const onboard = await fetch(`${API}/api/onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
    body: JSON.stringify({ role: "lawyer", templateId: "matter-desk" }),
  });
  if (!onboard.ok) throw new Error(`onboarding ${onboard.status} ${await onboard.text()}`);
  const psql = process.env.DATABASE_URL ?? "postgresql://ensemble:ensemble@127.0.0.1:5432/ensemble";
  markTester(psql, email);
  return session;
}

function watch(page, problems) {
  page.on("pageerror", (error) => problems.push(`pageerror ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console.error ${message.text()}`);
  });
}

function trackPrefetch(page) {
  const hits = new Map();
  const waiters = new Map();
  const mark = (path) => {
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const pending = waiters.get(path);
    if (!pending) return;
    waiters.delete(path);
    for (const resolve of pending) resolve();
  };
  // Header arrival is too early: the flight body can still be streaming, and
  // a click then commits loading.tsx. Give the body a short head start, and
  // skip the wait when the request has already finished.
  page.on("response", (response) => {
    if (!response.ok()) return;
    const headers = response.request().headers();
    if (headers.rsc !== "1" || headers["next-router-prefetch"] === "1") return;
    let path = "";
    try {
      path = new URL(response.url()).pathname;
    } catch {
      return;
    }
    if (!ROUTES.some((route) => route.path === path)) return;
    const timer = setTimeout(() => mark(path), 300);
    void response.finished().then(
      () => {
        clearTimeout(timer);
        mark(path);
      },
      () => {},
    );
  });
  return {
    wait(path, timeoutMs = 8_000) {
      if ((hits.get(path) ?? 0) > 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`prefetch timeout ${path}`)), timeoutMs);
        const pending = waiters.get(path) ?? [];
        pending.push(() => {
          clearTimeout(timer);
          resolve();
        });
        waiters.set(path, pending);
      });
    },
  };
}

async function openStart(browser, session) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const problems = [];
  watch(page, problems);
  const prefetch = trackPrefetch(page);
  await page.addInitScript(PAGE_HOOK);
  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  const shell = page.waitForResponse((response) => response.url().includes("/api/shell") && response.ok());
  await page.goto(`${WEB}${START}`, { waitUntil: "domcontentloaded" });
  await shell;
  await page.locator(`aside.app-sidebar nav a[href="/board"]`).waitFor();
  return { page, problems, prefetch };
}

async function clickRoute(page, path, prefetch) {
  await prefetch.wait(path);
  if (process.env.NAV_SPEED_DEBUG === "1") console.log(`click ${path}`);
  await page.evaluate((target) => {
    const sidebar = document.querySelector("aside.app-sidebar");
    if (sidebar) sidebar.dataset.speedMark = "stay";
    const nav = { path: target, click: 0, marks: [], suspense: false, blank: false, feedbackAt: 0, contentAt: 0 };
    window.__nav = nav;
    const note = () => {
      if (!nav.click) return;
      const main = document.querySelector("main");
      const id = window.__navSpeed.known[target];
      const loading = Boolean(main?.querySelector(`[data-route-loading="${id}"]`));
      const onPath = location.pathname === target;
      const content = onPath && window.__navSpeed.hasContent(main, target);
      const suspense = Boolean(document.querySelector("[data-context-suspense]"));
      if (suspense) nav.suspense = true;
      const text = ((main?.innerText) || "").replace(/\s+/g, "");
      const filled = Boolean(main && (loading || content || text.length > 0 || main.querySelector("[data-route-loading], [data-motion-slot='content.skeleton']")));
      if (!filled) nav.blank = true;
      const t = performance.now();
      if ((loading || content) && !nav.feedbackAt) nav.feedbackAt = t;
      if (content && !suspense) {
        if (!nav.contentAt) nav.contentAt = t;
      } else if (suspense) {
        nav.contentAt = 0;
      }
      if (t - nav.click <= 130) nav.marks.push({ dt: Math.round(t - nav.click), loading, content, filled, path: location.pathname, suspense, nodes: main ? main.childElementCount : 0 });
    };
    document.addEventListener(
      "click",
      (event) => {
        const anchor = event.target instanceof Element ? event.target.closest("a") : null;
        if (!anchor || anchor.getAttribute("href") !== target) return;
        nav.click = performance.now();
        requestAnimationFrame(function loop() {
          note();
          if (performance.now() - nav.click < 160) requestAnimationFrame(loop);
        });
      },
      true,
    );
    new MutationObserver(note).observe(document.documentElement, { childList: true, subtree: true });
  }, path);
  await page.locator(`aside.app-sidebar nav a[href="${path}"]`).click();
  const route = ROUTES.find((item) => item.path === path);
  await page.locator(route.content).first().waitFor({ timeout: 15_000 });
  await page.waitForFunction(
    (target) => {
      const nav = window.__nav;
      return Boolean(nav && nav.path === target && nav.contentAt && !document.querySelector("[data-context-suspense]"));
    },
    path,
    { timeout: 15_000 },
  );
  return page.evaluate(() => {
    const nav = window.__nav;
    const within = nav.marks.filter((row) => row.dt <= 100);
    return {
      navMs: Math.round(nav.contentAt - nav.click),
      feedbackMs: nav.feedbackAt ? Math.round(nav.feedbackAt - nav.click) : null,
      sawFeedback: within.some((row) => row.loading || row.content),
      blank: nav.blank,
      suspense: nav.suspense,
      sidebarSame: document.querySelector("aside.app-sidebar")?.dataset.speedMark === "stay",
      marks: nav.marks.slice(0, 10),
    };
  });
}

async function reloadRoute(page, path) {
  const route = ROUTES.find((item) => item.path === path);
  await page.goto(`${WEB}${path}`, { waitUntil: "commit" });
  await page.locator(route.content).first().waitFor({ timeout: 15_000 });
  await page.waitForFunction(
    (target) => {
      const mark = window.__loadMark;
      return location.pathname === target && mark && mark.contentAt > 0 && !document.querySelector("[data-context-suspense]");
    },
    path,
    { timeout: 15_000 },
  );
  return page.evaluate(() => Math.round(window.__loadMark.contentAt));
}

async function assertReducedMotion(browser, session) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  const problems = [];
  watch(page, problems);
  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  // The first full /board prefetch is turned into a loading-boundary response
  // so the click commits loading.tsx. The follow-up fetch is held long enough
  // for the delayed skeleton to become visible.
  let boardFull = 0;
  await page.route("**/*", async (route) => {
    const request = route.request();
    let pathname = "";
    try {
      pathname = new URL(request.url()).pathname;
    } catch {
      pathname = "";
    }
    const headers = request.headers();
    const boardRsc = headers.rsc === "1" && pathname === "/board";
    if (boardRsc && headers["next-router-prefetch"] !== "1") {
      boardFull += 1;
      if (boardFull === 1) {
        try {
          await route.continue({ headers: { ...headers, "next-router-prefetch": "1" } });
        } catch {
          // Already settled.
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    try {
      await route.continue();
    } catch {
      // The click already finished this request, or the page closed.
    }
  });
  const shell = page.waitForResponse((response) => response.url().includes("/api/shell") && response.ok());
  await page.goto(`${WEB}${START}`, { waitUntil: "domcontentloaded" });
  await shell;
  await page.locator(`aside.app-sidebar nav a[href="/board"]`).waitFor();
  await page.locator("aside.app-sidebar").evaluate((node) => {
    node.dataset.speedMark = "stay";
  });
  await page.locator(`aside.app-sidebar nav a[href="/board"]`).click();
  const skeleton = page.locator('main [data-route-loading="board"] [data-motion-slot="content.skeleton"][data-visible="1"]').first();
  await skeleton.waitFor({ timeout: 8_000 });
  const motion = await skeleton.evaluate((node) => {
    const after = getComputedStyle(node, "::after");
    return {
      animationName: after.animationName,
      media: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
  });
  assert.equal(motion.media, true, JSON.stringify(motion));
  assert.equal(motion.animationName, "none", JSON.stringify(motion));
  assert.equal(await page.locator("aside.app-sidebar").getAttribute("data-speed-mark"), "stay");
  await page.locator("main h1").first().waitFor({ timeout: 15_000 });
  const fresh = problems.filter((line) => !/favicon|ERR_ABORTED|ERR_FAILED|Failed to load resource|net::ERR/i.test(line));
  assert.deepEqual(fresh, [], fresh.join("\n"));
  await page.context().close();
}

async function main() {
  const session = await signUp();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const nav = Object.fromEntries(ROUTES.map((route) => [route.path, []]));
  const reload = Object.fromEntries(ROUTES.map((route) => [route.path, []]));
  const feedback = Object.fromEntries(ROUTES.map((route) => [route.path, []]));
  try {
    for (let run = 0; run < RUNS; run += 1) {
      for (const route of ROUTES) {
        const { page, problems, prefetch } = await openStart(browser, session);
        try {
          const result = await clickRoute(page, route.path, prefetch);
          nav[route.path].push(result.navMs);
          if (result.feedbackMs != null) feedback[route.path].push(result.feedbackMs);
          console.log(`run ${run + 1} nav ${route.path} content ${result.navMs}ms feedback ${result.feedbackMs}ms blank ${result.blank} suspense ${result.suspense}`);
          if (!TIMING_ONLY) {
            assert.equal(result.sawFeedback, true, `${route.path} no content or skeleton within 100ms ${JSON.stringify(result.marks)}`);
            assert.ok(result.feedbackMs != null && result.feedbackMs <= 100, `${route.path} feedback ${result.feedbackMs}ms`);
            assert.equal(result.blank, false, `${route.path} blank main ${JSON.stringify(result.marks)}`);
            assert.equal(result.suspense, false, `${route.path} suspense fallback committed`);
            assert.equal(result.sidebarSame, true, `${route.path} sidebar remounted`);
          }
          const reloadMs = await reloadRoute(page, route.path);
          reload[route.path].push(reloadMs);
          const reloadSuspense = await page.locator("[data-context-suspense]").count();
          console.log(`run ${run + 1} reload ${route.path} content ${reloadMs}ms`);
          if (!TIMING_ONLY && route.path === "/context") {
            assert.equal(reloadSuspense, 0, "context suspense fallback committed on reload");
            assert.equal(await page.locator("[data-context-lens]").count(), 1, "context lens missing");
          }
          const fresh = problems.filter((line) => !/favicon/i.test(line));
          if (!TIMING_ONLY) assert.deepEqual(fresh, [], `${route.path}\n${fresh.join("\n")}`);
          else if (fresh.length) console.log(`problems ${route.path}\n${fresh.join("\n")}`);
        } finally {
          await page.context().close();
        }
      }
    }
    if (!TIMING_ONLY) await assertReducedMotion(browser, session);
  } finally {
    await browser.close();
  }

  const summary = ROUTES.map((route) => ({
    path: route.path,
    navCold: nav[route.path],
    navColdMedian: median(nav[route.path]),
    reload: reload[route.path],
    reloadMedian: median(reload[route.path]),
    feedback: feedback[route.path],
    feedbackMedian: feedback[route.path].length ? median(feedback[route.path]) : null,
  }));
  console.log("NAV_SPEED_SUMMARY");
  console.log(JSON.stringify(summary, null, 2));
  console.log("nav speed ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
