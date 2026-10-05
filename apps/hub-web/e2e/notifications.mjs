/**
 * The bell opens a real list, Open follows the source link and clears the dot.
 * Run: node apps/hub-web/e2e/notifications.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function signup() {
  const email = `notes-${Date.now().toString(36)}@ensemble.test`;
  const response = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "notes-pass-1", name: "Notes" }),
  });
  if (!response.ok) throw new Error(`signup ${response.status} ${await response.text()}`);
  const session = cookieHeader(typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : response.headers.get("set-cookie"));
  const onboard = await fetch(`${API}/api/onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
    body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
  });
  if (!onboard.ok) throw new Error(`onboard ${onboard.status}`);
  return session;
}

async function authed(session, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      cookie: `ensemble_session=${session}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const emptySession = await signup();
  const emptyPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await emptyPage.context().addCookies([{ name: "ensemble_session", value: emptySession, url: WEB }]);
  await emptyPage.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
  await emptyPage.getByRole("button", { name: "Notifications" }).click();
  await emptyPage.getByRole("dialog", { name: "Notifications" }).waitFor();
  await emptyPage.getByText("No notes yet. The morning brief lands here.").waitFor();
  await emptyPage.keyboard.press("Escape");
  await emptyPage.getByRole("dialog", { name: "Notifications" }).waitFor({ state: "hidden" });

  const session = await signup();
  const asked = await authed(session, "/api/decisions", {
    method: "POST",
    body: JSON.stringify({
      source: "cursor",
      event: "beforeShellExecution",
      payload: { command: "echo ensemble-note", cwd: "/tmp/ensemble" },
      waitSeconds: 30,
    }),
  });
  assert.equal(asked.status, 202, asked.text);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
  const bell = page.getByRole("button", { name: /Notifications, 1 unread/ });
  await bell.waitFor();
  await bell.click();
  const dialog = page.getByRole("dialog", { name: "Notifications" });
  await dialog.waitFor();
  await dialog.getByText(/waiting/i).first().waitFor();
  await dialog.getByRole("link", { name: "Open" }).click();
  await page.waitForURL((url) => url.pathname === "/needs-me");
  await page.getByRole("button", { name: "Notifications" }).click();
  await page.getByText("No notes yet.").waitFor({ state: "hidden" });
  const stillUnread = await page.getByRole("button", { name: /unread/ }).count();
  assert.equal(stillUnread, 0);
  console.log("notifications ok");
} finally {
  await browser.close();
}
