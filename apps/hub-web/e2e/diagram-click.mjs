/**
 * Click through canvas undo and a diagram node on the Context graph.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const API = "http://127.0.0.1:4000";
const WEB = "http://127.0.0.1:3000";
const CHROME = process.env.CHROME_PATH ?? "/usr/local/bin/google-chrome";

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function api(session, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      cookie: `ensemble_session=${session}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text };
}

const email = `diagram-${Date.now().toString(36)}@ensemble.test`;
const signup = await fetch(`${API}/api/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "widget-pass-1", name: "Counsel" }),
});
if (!signup.ok) throw new Error(await signup.text());
const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
const onboard = await api(session, "/api/onboarding", {
  method: "POST",
  body: JSON.stringify({ role: "lawyer", templateId: "matter-desk" }),
});
assert.equal(onboard.status, 200, onboard.text);
const diagram = await api(session, "/api/diagrams", {
  method: "POST",
  body: JSON.stringify({ title: "Checkout" }),
});
assert.equal(diagram.status, 201, diagram.text);
const id = diagram.body.diagram.id;
const task = await api(session, "/api/tasks", {
  method: "POST",
  body: JSON.stringify({ title: "Review the checkout", status: "todo" }),
});
assert.equal(task.status, 201, task.text);
const link = await api(session, "/api/diagrams/links", {
  method: "PUT",
  body: JSON.stringify({ targetKind: "task", targetId: task.body.task.id, diagramIds: [id] }),
});
assert.equal(link.status, 200, link.text);

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
await page.goto(`${WEB}/diagrams/${id}`, { waitUntil: "networkidle" });
await page.locator("[data-diagram-editor]").waitFor();
const before = await page.locator(".react-flow__node").count();
await page.getByRole("button", { name: "Add block" }).click();
await page.getByRole("menuitem", { name: "Rectangle" }).click();
await page.waitForFunction((start) => document.querySelectorAll(".react-flow__node").length > start, before);
const added = await page.locator(".react-flow__node").count();
assert.ok(added > before, `nodes ${before} -> ${added}`);
await page.locator(".react-flow__pane").click({ position: { x: 40, y: 40 } });
await page.keyboard.press("Control+z");
await page.waitForFunction((start) => document.querySelectorAll(".react-flow__node").length < start, added, { timeout: 5000 });
const undone = await page.locator(".react-flow__node").count();
assert.equal(undone, before, `undo left ${undone}, started at ${before}`);
console.log("canvas undo ok", { before, added, undone });
await page.screenshot({ path: "/opt/cursor/artifacts/desk/step2/diagram-undo.png" });

await page.goto(`${WEB}/context?view=graph`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Diagrams" }).waitFor();
const canvas = page.getByRole("img", { name: "Context graph" }).or(page.locator('canvas[aria-label="Context graph"]'));
await canvas.waitFor();
const drawn = await canvas.evaluate((el) => {
  const ctx = el.getContext("2d");
  const { width, height } = el;
  if (!width || !height) return 0;
  const data = ctx.getImageData(0, 0, width, height).data;
  let ink = 0;
  for (let i = 0; i < data.length; i += 16) if (data[i + 3] > 20) ink += 1;
  return ink;
});
assert.ok(drawn > 40, `graph canvas ink ${drawn}`);
await page.screenshot({ path: "/opt/cursor/artifacts/desk/step2/context-graph.png" });
const names = await page.locator("ul.sr-only button").allTextContents();
if (!names.some((name) => name.includes("diagram"))) {
  throw new Error(`graph nodes: ${names.join(" | ") || "(none)"}`);
}
const node = page.locator("ul.sr-only button", { hasText: "diagram" }).first();
await node.waitFor({ state: "attached" });
await node.evaluate((button) => button.click());
await page.waitForURL(new RegExp(`/diagrams/${id}`), { waitUntil: "commit" });
console.log("graph opens the diagram", page.url());
await page.screenshot({ path: "/opt/cursor/artifacts/desk/step2/diagram-from-graph.png" });
await browser.close();
console.log("diagram click-through ok");
