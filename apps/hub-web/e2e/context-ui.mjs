/**
 * Context board: lanes, reorder, remembered view, peek, deep links, 390.
 * Run: node apps/hub-web/e2e/context-ui.mjs
 */
import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const SHOTS = "/opt/cursor/artifacts/context-ui-r5";

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function authed(session, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      cookie: `ensemble_session=${session}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} ${response.status}: ${await response.text()}`);
  return response;
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  await copyFile("/workspace/ensemble/screenshots/feature-2-r3/context-prajwal-1440.png", `${SHOTS}/before-context-1440.png`).catch(() => undefined);
  await copyFile("/workspace/ensemble/screenshots/feature-2-r3/context-prajwal-390.png", `${SHOTS}/before-context-390.png`).catch(() => undefined);

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const stamp = Date.now().toString(36);
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `context-${stamp}@ensemble.test`, password: "widget-pass-1", name: "Context" }),
  });
  if (!signup.ok) throw new Error(await signup.text());
  const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
  await authed(session, "/api/onboarding", { method: "POST", body: JSON.stringify({ role: "student", templateId: "semester-desk" }) });
  await authed(session, "/api/people", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace" }) });
  await authed(session, "/api/repos", { method: "POST", body: JSON.stringify({ fullName: "ada/analytical-engine" }) });
  const meeting = await authed(session, "/api/meetings/sessions", { method: "POST", body: JSON.stringify({ title: "Design review" }) });
  const meetingId = (await meeting.json()).session?.id;
  if (!meetingId) throw new Error("meeting session missing");
  await authed(session, `/api/meetings/sessions/${meetingId}`, { method: "PATCH", body: JSON.stringify({ notes: "Walk the board." }) });
  await authed(session, `/api/meetings/sessions/${meetingId}/end`, { method: "POST" });
  const projects = await authed(session, "/api/projects");
  const projectId = (await projects.json()).projects?.[0]?.id;
  if (!projectId) throw new Error("project missing");
  await authed(session, "/api/deliverables", { method: "POST", body: JSON.stringify({ title: "Latency note", projectId }) });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  await page.goto(`${WEB}/context?view=board`, { waitUntil: "networkidle" });
  await page.locator("[data-lane=people]").waitFor();
  await page.locator("[data-lane=projects]").waitFor();
  await page.locator("[data-lane=repos]").waitFor();
  await page.locator("[data-lane=meetings]").waitFor();
  await page.locator("[data-lane=artifacts]").waitFor();
  assert.equal(await page.locator("[data-context-view]").getAttribute("data-context-view"), "board");
  const laneBoxes = await page.locator(".context-lane").evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect();
      return { id: el.getAttribute("data-lane"), width: box.width, right: box.right };
    }),
  );
  assert.equal(laneBoxes.length, 5, JSON.stringify(laneBoxes));
  for (const box of laneBoxes) {
    assert.ok(box.width <= 300.5, `${box.id} width ${box.width}`);
    assert.ok(box.right <= 1440, `${box.id} overflows ${box.right}`);
  }
  await page.screenshot({ path: `${SHOTS}/context-board-1440.png` });

  const personCard = page.locator("[data-lane=people] [data-card]", { hasText: "Ada Lovelace" });
  const projectCard = page.locator("[data-lane=projects] [data-card]").first();
  const personBox = await personCard.boundingBox();
  const projectBox = await projectCard.boundingBox();
  assert.ok(personBox && projectBox);
  await page.mouse.move(personBox.x + 30, personBox.y + 24);
  await page.mouse.down();
  await page.mouse.move(projectBox.x + projectBox.width / 2, projectBox.y + 28, { steps: 18 });
  await page.locator("[data-link-target]").waitFor();
  await page.locator(".context-drag", { hasText: "Link Ada Lovelace" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/context-drag-link.png` });
  await page.keyboard.press("Escape");
  await page.locator(".context-drag").waitFor({ state: "hidden" });
  await page.mouse.up();

  const lane = page.locator("[data-lane=people]");
  const titles = () => lane.locator("[data-card]").evaluateAll((els) => els.map((el) => el.textContent ?? ""));
  const before = await titles();
  assert.ok(before.length >= 2, before.join("|"));
  const handle = lane.locator("[data-drag-handle]").first();
  const target = lane.locator("[data-card]").nth(1);
  const handleBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  assert.ok(handleBox && targetBox);
  await page.mouse.move(handleBox.x + 6, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 16 });
  await page.locator(".context-drag").waitFor();
  await page.screenshot({ path: `${SHOTS}/context-drag.png` });
  const dragBox = await page.locator(".context-drag").boundingBox();
  assert.ok(dragBox);
  assert.ok(dragBox.x >= -1 && dragBox.x + dragBox.width <= 1441, `drag chip ${dragBox.x}`);
  const saved = page.waitForResponse((response) => response.url().includes("/api/context/order") && response.request().method() === "PUT");
  await page.mouse.up();
  await saved;
  const dropped = await titles();
  assert.notEqual(dropped[0], before[0], dropped.join(" | "));
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("[data-lane=people] [data-card]").first().waitFor();
  const reloaded = await titles();
  assert.equal(reloaded[0], dropped[0], reloaded.join(" | "));

  const remembered = page.waitForResponse((response) => response.url().includes("/api/context/order") && response.request().method() === "PUT" && response.ok());
  await page.getByRole("tab", { name: "Grid" }).click();
  await remembered;
  await page.waitForURL(/view=grid/);
  await page.locator("[data-context-view=grid]").waitFor();
  await page.screenshot({ path: `${SHOTS}/context-grid-1440.png` });
  await page.goto(`${WEB}/context?view=desk`, { waitUntil: "networkidle" });
  await page.locator("[data-context-view=grid]").waitFor();

  await page.getByRole("tab", { name: "List" }).click();
  await page.locator("[data-context-view=list]").waitFor();
  await page.screenshot({ path: `${SHOTS}/context-list-1440.png` });
  await page.getByRole("tab", { name: "Coursework" }).click();
  await page.locator("[data-context-view=board]").waitFor();
  await page.locator("[data-lane=people] [data-card]", { hasText: "Ada Lovelace" }).locator("button").nth(1).click();
  await page.locator("[data-peek]").waitFor();
  assert.match(await page.locator("[data-peek]").innerText(), /Ada Lovelace/);
  await page.screenshot({ path: `${SHOTS}/context-peek-1440.png` });
  await page.locator("[data-peek]").getByLabel("Name").fill("Ada Renamed");
  const renamed = page.waitForResponse((response) => response.url().includes("/api/context/board") && response.request().method() === "GET" && response.ok());
  await page.locator("[data-peek]").getByRole("button", { name: "Save" }).click();
  await renamed;
  await page.locator("[data-peek] h2", { hasText: "Ada Renamed" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/context-peek-renamed.png` });
  const restored = page.waitForResponse((response) => response.url().includes("/api/context/board") && response.request().method() === "GET" && response.ok());
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await restored;
  await page.locator("[data-peek] h2", { hasText: "Ada Lovelace" }).waitFor();
  assert.equal(await page.locator("[data-peek]").getByLabel("Name").inputValue(), "Ada Lovelace");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Remove" }).click();
  const danger = await page.locator(".btn-danger").boundingBox();
  assert.ok(danger && danger.x >= 0 && danger.x + danger.width <= 1440, `remove menu ${danger?.x}`);
  await page.keyboard.press("Escape");
  await page.locator("[data-peek-menu]").waitFor({ state: "hidden" });
  await page.locator("[data-peek]").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("[data-peek]").waitFor({ state: "hidden" });
  await page.locator("[data-lane=artifacts] [data-card]", { hasText: "Latency note" }).locator("button").nth(1).click();
  await page.locator("[data-peek]").waitFor();
  assert.equal(await page.locator("[data-peek]").getByRole("button", { name: "Unlink" }).count(), 0);
  const openHref = await page.locator("[data-peek]").getByRole("link", { name: "Open" }).getAttribute("href");
  assert.ok(openHref && openHref.includes("deliverable=") && !openHref.includes("/projects/"), openHref ?? "");
  await page.keyboard.press("Escape");
  await page.locator("[data-peek]").waitFor({ state: "hidden" });

  await page.locator("[data-context-search]").fill("zzzz-no-match");
  await page.getByText(/Nothing matches/).first().waitFor();
  assert.equal(await page.getByText(/Nothing matches/).count(), 1);
  await page.getByRole("button", { name: "Clear filter" }).first().click();
  await page.locator("[data-lane=people] [data-card]").first().waitFor();

  await page.goto(`${WEB}/context?tab=people`, { waitUntil: "networkidle" });
  const kept = page.waitForResponse((response) => response.url().includes("/api/context/order") && response.request().method() === "PUT" && response.ok());
  await page.getByRole("tab", { name: "List" }).click();
  await kept;
  await page.waitForURL(/tab=people/);
  assert.equal(await page.locator("[data-context-filter]").getAttribute("data-context-filter"), "people");
  await page.getByRole("tab", { name: "Coursework" }).click();
  await page.locator("[data-context-view=board]").waitFor();

  const grip = page.locator("[data-lane=people] [data-drag-handle]").first();
  const gripBox = await grip.boundingBox();
  assert.ok(gripBox);
  await page.mouse.move(gripBox.x + 4, gripBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + 80, gripBox.y + 40, { steps: 8 });
  await page.locator(".context-drag").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".context-drag").waitFor({ state: "hidden" });
  await page.mouse.up();

  await page.mouse.move(gripBox.x + 4, gripBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + 70, gripBox.y + 36, { steps: 8 });
  await page.locator(".context-drag").waitFor();
  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true })));
  await page.locator(".context-drag").waitFor({ state: "hidden" });
  await page.mouse.up();

  await page.goto(`${WEB}/context?tab=people`, { waitUntil: "networkidle" });
  assert.equal(await page.locator("[data-context-filter]").getAttribute("data-context-filter"), "people");
  assert.equal(await page.locator("[data-lane=projects]").count(), 0);
  await page.goto(`${WEB}/context?tab=graph`, { waitUntil: "networkidle" });
  await page.locator("[data-context-view=graph]").waitFor();
  await page.locator("canvas").waitFor();
  const toolbar = await page.locator(".graph-toolbar").evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, right: rect.right, height: rect.height };
  });
  assert.ok(toolbar.scrollWidth <= toolbar.clientWidth + 2, `toolbar scroll ${toolbar.scrollWidth} vs ${toolbar.clientWidth}`);
  assert.ok(toolbar.right <= 1440, `toolbar right ${toolbar.right}`);
  assert.ok(toolbar.height < 80, `toolbar height ${toolbar.height}`);
  await page.locator(".graph-toolbar").getByRole("button", { name: "People" }).waitFor();
  assert.match(await page.locator(".graph-toolbar").innerText(), /nodes/);
  await page.screenshot({ path: `${SHOTS}/context-graph-1440.png` });

  await page.goto(`${WEB}/today`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/today-1440.png` });
  await page.goto(`${WEB}/board`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/board-1440.png` });
  await page.goto(`${WEB}/settings`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/settings-1440.png` });
  await page.goto(`${WEB}/meetings`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/meetings-1440.png` });
  await page.goto(`${WEB}/needs-me`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/needs-me-1440.png` });
  await page.goto(`${WEB}/recap`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/recap-1440.png` });
  await page.goto(`${WEB}/completed`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/completed-1440.png` });
  await page.goto(`${WEB}/start`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/start-1440.png` });
  await page.goto(`${WEB}/trash`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/trash-1440.png` });
  await page.goto(`${WEB}/context`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/sidebar-1440.png` });

  const clsContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await clsContext.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await clsContext.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  const clsPage = await clsContext.newPage();
  await clsPage.goto(`${WEB}/context?view=board`, { waitUntil: "networkidle" });
  await clsPage.locator("[data-lane=people]").waitFor();
  await clsPage.waitForTimeout(500);
  const cls = await clsPage.evaluate(() => window.__cls);
  assert.ok(cls < 0.05, `context CLS ${cls}`);
  await clsContext.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  await phone.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  const phonePage = await phone.newPage();
  await phonePage.goto(`${WEB}/context?view=board`, { waitUntil: "networkidle" });
  const phoneLane = phonePage.locator("[data-lane=people]");
  await phoneLane.waitFor();
  const box = await phoneLane.boundingBox();
  assert.ok(box && box.width >= 240 && box.width <= 390, `lane width ${box?.width}`);
  const add = phoneLane.getByRole("button", { name: "Add" });
  const addBox = await add.boundingBox();
  assert.ok(addBox && addBox.height >= 24, `tap target ${addBox?.height}`);
  assert.ok(addBox.x + addBox.width <= 390, `add off screen ${addBox.x + addBox.width}`);
  const touchLane = phonePage.locator("[data-lane=people]");
  const touchBefore = await touchLane.locator("[data-card]").evaluateAll((els) => els.map((el) => el.getAttribute("data-card")));
  assert.ok(touchBefore.length >= 2, touchBefore.join(","));
  const from = await touchLane.locator("[data-drag-handle]").nth(1).boundingBox();
  const onto = await touchLane.locator("[data-card]").first().boundingBox();
  assert.ok(from && onto);
  const client = await phone.newCDPSession(phonePage);
  const point = (x, y) => ({ x: Math.round(x), y: Math.round(y), id: 0 });
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(from.x + from.width / 2, from.y + from.height / 2)] });
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) {
    const x = from.x + ((onto.x + onto.width / 2 - from.x) * i) / steps;
    const y = from.y + 8 + ((onto.y + 24 - from.y) * i) / steps;
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(x, y)] });
    await phonePage.waitForTimeout(20);
  }
  await phonePage.locator(".context-drag").waitFor();
  await phonePage.screenshot({ path: `${SHOTS}/context-touch-drag.png` });
  const touchSaved = phonePage.waitForResponse((response) => response.url().includes("/api/context/order") && response.request().method() === "PUT" && response.ok());
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await touchSaved;
  await client.detach();
  const touchAfter = await touchLane.locator("[data-card]").evaluateAll((els) => els.map((el) => el.getAttribute("data-card")));
  assert.notEqual(touchAfter[0], touchBefore[0], touchAfter.join(","));
  await phonePage.reload({ waitUntil: "networkidle" });
  await phonePage.locator("[data-lane=people] [data-card]").first().waitFor();
  const touchReloaded = await phonePage.locator("[data-lane=people] [data-card]").evaluateAll((els) => els.map((el) => el.getAttribute("data-card")));
  assert.equal(touchReloaded[0], touchAfter[0], touchReloaded.join(","));
  const swipeClient = await phone.newCDPSession(phonePage);
  const swipeLane = phonePage.locator("[data-lane=people]");
  const orderBefore = await swipeLane.locator("[data-card]").evaluateAll((els) => els.map((el) => el.getAttribute("data-card")));
  const scrollBefore = await phonePage.locator(".context-lanes").evaluate((el) => el.scrollLeft);
  const body = await swipeLane.locator("[data-card]").first().locator("button").nth(1).boundingBox();
  assert.ok(body);
  const startX = body.x + Math.min(body.width - 12, 180);
  const endX = Math.max(8, startX - 200);
  const swipeY = body.y + body.height / 2;
  await swipeClient.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(startX, swipeY)] });
  for (let i = 1; i <= 10; i += 1) {
    const x = startX + ((endX - startX) * i) / 10;
    await swipeClient.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(x, swipeY)] });
    await phonePage.waitForTimeout(16);
  }
  await phonePage.waitForTimeout(50);
  await swipeClient.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await phonePage.waitForTimeout(400);
  const scrollAfter = await phonePage.locator(".context-lanes").evaluate((el) => el.scrollLeft);
  assert.ok(scrollAfter > scrollBefore + 20, `swipe scroll ${scrollBefore} -> ${scrollAfter}`);
  const orderAfter = await swipeLane.locator("[data-card]").evaluateAll((els) => els.map((el) => el.getAttribute("data-card")));
  assert.deepEqual(orderAfter, orderBefore);
  assert.equal(await phonePage.locator(".context-drag").count(), 0);
  await phonePage.screenshot({ path: `${SHOTS}/context-swipe-390.png` });
  await swipeClient.detach();
  await phonePage.locator(".context-lanes").evaluate((el) => {
    el.scrollLeft = 0;
  });
  const pressClient = await phone.newCDPSession(phonePage);
  const pressLane = phonePage.locator("[data-lane=people]");
  const pressBefore = await pressLane.locator("[data-card]").evaluateAll((els) => els.map((el) => el.getAttribute("data-card")));
  assert.ok(pressBefore.length >= 2, pressBefore.join(","));
  const pressBody = await pressLane.locator("[data-card]").nth(1).locator("button").nth(1).boundingBox();
  const pressOnto = await pressLane.locator("[data-card]").first().boundingBox();
  assert.ok(pressBody && pressOnto);
  const pressX = pressBody.x + pressBody.width / 2;
  const pressY = pressBody.y + pressBody.height / 2;
  await pressClient.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(pressX, pressY)] });
  await phonePage.waitForTimeout(520);
  await phonePage.locator(".context-drag").waitFor();
  const landX = pressOnto.x + pressOnto.width / 2;
  const landY = pressOnto.y + Math.min(24, pressOnto.height / 2);
  for (let i = 1; i <= 8; i += 1) {
    await pressClient.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [point(pressX + ((landX - pressX) * i) / 8, pressY + ((landY - pressY) * i) / 8)],
    });
    await phonePage.waitForTimeout(40);
  }
  await phonePage.locator(".context-drag").waitFor();
  await phonePage.screenshot({ path: `${SHOTS}/context-longpress-390.png` });
  const pressSaved = phonePage.waitForResponse((response) => response.url().includes("/api/context/order") && response.request().method() === "PUT" && response.ok());
  await pressClient.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await pressSaved;
  await pressClient.detach();
  const pressAfter = await pressLane.locator("[data-card]").evaluateAll((els) => els.map((el) => el.getAttribute("data-card")));
  assert.notEqual(pressAfter[0], pressBefore[0], pressAfter.join(","));
  await phonePage.reload({ waitUntil: "networkidle" });
  await phonePage.locator("[data-lane=people] [data-card]").first().waitFor();
  const pressReloaded = await phonePage.locator("[data-lane=people] [data-card]").evaluateAll((els) => els.map((el) => el.getAttribute("data-card")));
  assert.equal(pressReloaded[0], pressAfter[0], pressReloaded.join(","));
  const edgeClient = await phone.newCDPSession(phonePage);
  await phonePage.locator(".context-lanes").evaluate((el) => {
    el.scrollLeft = 0;
  });
  const edgeBefore = await phonePage.locator(".context-lanes").evaluate((el) => el.scrollLeft);
  const edgeGrip = await phonePage.locator("[data-lane=people] [data-drag-handle]").first().boundingBox();
  const edgeBox = await phonePage.locator(".context-lanes").boundingBox();
  assert.ok(edgeGrip && edgeBox);
  await edgeClient.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(edgeGrip.x + edgeGrip.width / 2, edgeGrip.y + edgeGrip.height / 2)] });
  const edgeX = edgeBox.x + edgeBox.width - 8;
  const edgeY = edgeGrip.y + edgeGrip.height / 2;
  for (let i = 1; i <= 8; i += 1) {
    const x = edgeGrip.x + ((edgeX - edgeGrip.x) * i) / 8;
    await edgeClient.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(x, edgeY)] });
    await phonePage.waitForTimeout(20);
  }
  await phonePage.locator(".context-drag").waitFor();
  await phonePage.waitForTimeout(500);
  const edgeAfter = await phonePage.locator(".context-lanes").evaluate((el) => el.scrollLeft);
  assert.ok(edgeAfter > edgeBefore + 20, `touch edge scroll ${edgeBefore} -> ${edgeAfter}`);
  await phonePage.screenshot({ path: `${SHOTS}/context-edge-390.png` });
  await phonePage.keyboard.press("Escape");
  await edgeClient.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await edgeClient.detach();
  await phonePage.screenshot({ path: `${SHOTS}/context-390.png` });
  await phonePage.goto(`${WEB}/context?view=graph`, { waitUntil: "networkidle" });
  await phonePage.locator(".graph-toolbar").waitFor();
  await phonePage.locator("canvas").waitFor();
  const narrow = await phonePage.locator(".graph-toolbar").evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, right: rect.right, height: rect.height };
  });
  assert.ok(narrow.scrollWidth <= narrow.clientWidth + 2, `graph toolbar ${narrow.scrollWidth} vs ${narrow.clientWidth}`);
  assert.ok(narrow.right <= 391, `graph toolbar right ${narrow.right}`);
  assert.ok(narrow.height < 140, `graph toolbar height ${narrow.height}`);
  await phonePage.locator(".graph-toolbar").getByRole("button", { name: "People" }).waitFor();
  const countTitle = await phonePage.locator(".graph-toolbar [title]").first().getAttribute("title");
  assert.match(countTitle ?? "", /nodes/);
  await phonePage.screenshot({ path: `${SHOTS}/context-graph-390.png` });
  await phonePage.getByRole("button", { name: "Graph tools" }).click();
  const menu = await phonePage.locator("[data-graph-tools]").boundingBox();
  assert.ok(menu && menu.y >= -1 && menu.y + menu.height <= 845, `graph menu ${JSON.stringify(menu)}`);
  await phonePage.screenshot({ path: `${SHOTS}/context-graph-menu-390.png` });
  await phone.close();

  for (const width of [1024, 768]) {
    const mid = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "dark" });
    await mid.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
    const midPage = await mid.newPage();
    await midPage.goto(`${WEB}/context?view=board`, { waitUntil: "networkidle" });
    await midPage.locator("[data-lane=people]").waitFor();
    const overflow = await midPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow < 2, `page overflow at ${width}: ${overflow}`);
    if (width === 1024) {
      const scroller = midPage.locator(".context-lanes");
      const beforeScroll = await scroller.evaluate((el) => el.scrollLeft);
      const grip = midPage.locator("[data-lane=people] [data-drag-handle]").first();
      const gripBox = await grip.boundingBox();
      const scrollerBox = await scroller.boundingBox();
      assert.ok(gripBox && scrollerBox);
      await midPage.mouse.move(gripBox.x + 6, gripBox.y + gripBox.height / 2);
      await midPage.mouse.down();
      await midPage.mouse.move(scrollerBox.x + scrollerBox.width - 6, gripBox.y + gripBox.height / 2, { steps: 12 });
      await midPage.locator(".context-drag").waitFor();
      await midPage.waitForTimeout(500);
      const afterScroll = await scroller.evaluate((el) => el.scrollLeft);
      assert.ok(afterScroll > beforeScroll + 20, `mouse edge scroll ${beforeScroll} -> ${afterScroll}`);
      await midPage.screenshot({ path: `${SHOTS}/context-edge-1024.png` });
      await midPage.keyboard.press("Escape");
      await midPage.mouse.up();
    }
    await midPage.screenshot({ path: `${SHOTS}/context-board-${width}.png` });
    await mid.close();
  }

  const light = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  await light.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  const lightPage = await light.newPage();
  await lightPage.goto(`${WEB}/context?view=board`, { waitUntil: "networkidle" });
  await lightPage.locator("[data-lane=people]").waitFor();
  await lightPage.getByTitle("Switch to light").click();
  await lightPage.locator("html[data-theme=light]").waitFor();
  await lightPage.screenshot({ path: `${SHOTS}/context-board-light.png` });
  await light.close();

  const emptySignup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `empty-${stamp}@ensemble.test`, password: "widget-pass-1", name: "New" }),
  });
  if (!emptySignup.ok) throw new Error(await emptySignup.text());
  const emptySession = cookieHeader(typeof emptySignup.headers.getSetCookie === "function" ? emptySignup.headers.getSetCookie() : emptySignup.headers.get("set-cookie"));
  await authed(emptySession, "/api/onboarding", { method: "POST", body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }) });
  const empty = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await empty.addCookies([{ name: "ensemble_session", value: emptySession, url: WEB }]);
  const emptyPage = await empty.newPage();
  await emptyPage.goto(`${WEB}/context?view=board`, { waitUntil: "networkidle" });
  await emptyPage.locator("[data-lane=projects]").waitFor();
  const projectWidth = (await emptyPage.locator("[data-lane=projects]").boundingBox())?.width ?? 0;
  assert.ok(projectWidth <= 300.5 && projectWidth >= 240, `empty project lane ${projectWidth}`);
  assert.equal(await emptyPage.locator(".lane-slim").count(), 4);
  await emptyPage.screenshot({ path: `${SHOTS}/context-empty-1440.png` });
  await empty.close();

  await browser.close();
  console.log("context ui e2e ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
