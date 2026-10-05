/**
 * Dev-server sweep. Every sidebar page, plus marketplace, settings, a task
 * page and its detail, must load without console.error, a React/Next hydration
 * warning, a pageerror, or the Next.js dev overlay issue badge.
 * Runs in Chromium and WebKit.
 *
 * Run against `next dev` (production builds hide hydration warnings):
 *   HUB_WEB=http://127.0.0.1:3000 node apps/hub-web/e2e/console-sweep.mjs
 */
import assert from "node:assert/strict";
import { markTester } from "./sql-change.mjs";
import { existsSync } from "node:fs";
import { chromium, webkit } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME = process.env.CHROME ?? (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");

const PAGES = [
  "/today",
  "/board",
  "/needs-me",
  "/context",
  "/meetings",
  "/code",
  "/workspace",
  "/runs",
  "/skills",
  "/metrics",
  "/diagrams",
  "/plots",
  "/recap",
  "/settings",
  "/marketplace",
];

/** Empty on purpose. Add a line only with a reason that is not a product bug. */
const ALLOW = [];

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function authed(session, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { cookie: `ensemble_session=${session}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function allowed(line) {
  return ALLOW.some((pattern) => pattern.test(line));
}

async function overlay(page) {
  return page.evaluate(() => {
    const hits = [];
    const seen = new Set();
    const push = (text) => {
      const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 300);
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      hits.push(clean);
    };
    const portal = document.querySelector("nextjs-portal");
    const roots = [portal?.shadowRoot, document].filter(Boolean);
    for (const root of roots) {
      const dialog = root.querySelector("[data-nextjs-dialog]");
      if (dialog) push(dialog.textContent || "overlay");
      const button = root.querySelector("[data-nextjs-dev-tools-button]");
      const label = `${button?.getAttribute("aria-label") || ""} ${button?.innerText || button?.textContent || ""}`.replace(/\s+/g, " ").trim();
      if (/[1-9]\d*\s+Issues?/i.test(label)) push(label);
      for (const badge of root.querySelectorAll("[data-next-badge], #devtools-indicator")) {
        const text = (badge.textContent || "").replace(/\s+/g, " ").trim();
        if (badge.getAttribute("data-error") === "true") push(text || "Next.js issue");
      }
    }
    return hits;
  });
}

async function main() {
  const email = `console-sweep-${Date.now().toString(36)}@ensemble.test`;
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "sweep-pass-1", name: "Sweep" }),
  });
  if (!signup.ok) throw new Error(`signup ${signup.status} ${await signup.text()}`);
  const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
  await authed(session, "/api/onboarding", { method: "POST", body: JSON.stringify({ role: "lawyer", templateId: "matter-desk" }) });
  const psql = process.env.DATABASE_URL;
  if (!psql) throw new Error("DATABASE_URL is required");
  markTester(psql, email);
  const created = await authed(session, "/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "Sweep task", status: "todo" }),
  });
  await authed(session, `/api/tasks/${created.task.id}/page`, {
    method: "PUT",
    body: JSON.stringify({
      revision: 0,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Sweep page body." }] }] },
    }),
  });
  await authed(session, "/api/settings/modules", { method: "PUT", body: JSON.stringify({ id: "plots", on: true }) });

  const routes = [...PAGES, `/tasks/${created.task.id}`];
  const run = async (browser, label) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    await page.addInitScript(() => {
      localStorage.setItem("ensemble.appearance", JSON.stringify({ theme: "dark", accent: "indigo" }));
    });
    const problems = [];
    page.on("pageerror", (error) => problems.push(`pageerror ${error.message}`));
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "error") problems.push(`console.error ${text}`);
      if (/hydrat|did not match|cannot be a descendant|validatedDOMNesting/i.test(text)) problems.push(`hydration ${text}`);
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      problems.push(`http ${response.status()} ${response.url()}`);
    });
    await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
    try {
      for (const route of routes) {
        const visit = async () => {
          const before = problems.length;
          await page.goto(`${WEB}${route}`, { waitUntil: "domcontentloaded" });
          await page.locator("main, body").first().waitFor();
          // WebKit reports a cancelled in-flight fetch as a page error when the
          // next full navigation starts. Let this page finish its requests first.
          await page.waitForLoadState("networkidle", { timeout: 10_000 });
          await page.waitForTimeout(200);
          const badge = await overlay(page);
          for (const hit of badge) problems.push(`overlay ${route} ${hit}`);
          return problems.slice(before).filter((line) => !allowed(line));
        };
        let fresh = await visit();
        // Next dev can 404 a chunk while it compiles. WebKit reports that as a
        // ChunkLoadError plus an access-control failure on the dev overlay.
        // One reload must come back clean.
        const compiling = fresh.length > 0 && fresh.every((line) => /Failed to load resource|http 404 |ChunkLoadError|__nextjs_original-stack-frames/.test(line));
        if (compiling) fresh = await visit();
        if (fresh.length) throw new Error(`${label} ${route}\n${fresh.join("\n")}`);
        console.log(`clean ${label} ${route}`);
      }
    } finally {
      await page.context().close();
    }
  };

  const chrome = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    await run(chrome, "chromium");
  } finally {
    await chrome.close();
  }
  const kit = await webkit.launch({ headless: true });
  try {
    await run(kit, "webkit");
  } finally {
    await kit.close();
  }
  console.log("console sweep ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
