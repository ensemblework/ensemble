/**
 * Client-side navigation fetches runs, skills, and workspace once.
 * React StrictMode double-invokes effects in dev, so this runs against
 * `next start`, not `next dev`.
 *
 *   NEXT_PUBLIC_HUB_API=http://127.0.0.1:4000 NEXT_DIST_DIR=.next-prod pnpm --filter @ensemble/hub-web build
 *   NEXT_PUBLIC_HUB_API=http://127.0.0.1:4000 NEXT_DIST_DIR=.next-prod pnpm --filter @ensemble/hub-web exec next start -p 3100
 *   HUB_WEB=http://127.0.0.1:3100 node apps/hub-web/e2e/nav-fetch-once.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3100";
const CHROME =
  process.env.CHROME_PATH ??
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");

const HOPS = [
  { href: "/runs", path: "/api/runs" },
  { href: "/skills", path: "/api/skills" },
  { href: "/workspace", path: "/api/workspace" },
];

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

function isDataGet(url, path) {
  const parsed = new URL(url);
  return parsed.origin === new URL(WEB).origin && parsed.pathname === path;
}

async function main() {
  const email = `nav-once-${Date.now().toString(36)}@ensemble.test`;
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "nav-once-pass-1", name: "Nav" }),
  });
  if (!signup.ok) throw new Error(`signup ${signup.status} ${await signup.text()}`);
  const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
  const onboard = await fetch(`${API}/api/onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
    body: JSON.stringify({ role: "lawyer", templateId: "matter-desk" }),
  });
  if (!onboard.ok) throw new Error(`onboarding ${onboard.status} ${await onboard.text()}`);
  for (const id of ["runs", "skills", "workspace"]) {
    const modules = await fetch(`${API}/api/settings/modules`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
      body: JSON.stringify({ id, on: true }),
    });
    if (!modules.ok) throw new Error(`modules ${id} ${modules.status} ${await modules.text()}`);
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
    await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
    await page.locator('aside.app-sidebar nav a[href="/runs"]').waitFor();

    for (const hop of HOPS) {
      const hits = [];
      const onRequest = (request) => {
        if (request.method() !== "GET") return;
        if (isDataGet(request.url(), hop.path)) hits.push(request.url());
      };
      page.on("request", onRequest);
      await page.locator(`aside.app-sidebar nav a[href="${hop.href}"]`).click();
      await page.waitForURL((url) => url.pathname === hop.href, { timeout: 15000 });
      await page.locator("main h1").first().waitFor({ timeout: 15000 });
      // Long enough for a duplicate mount fetch, short of the workspace poll.
      await page.waitForTimeout(600);
      page.off("request", onRequest);
      assert.equal(hits.length, 1, `${hop.href} requested ${hop.path} ${hits.length} times:\n${hits.join("\n")}`);
      console.log(`${hop.href} ${hop.path} once`);
    }
  } finally {
    await browser.close();
  }
  console.log("nav fetch once ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
