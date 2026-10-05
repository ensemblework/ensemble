/**
 * Signup, a template, Today widgets, a resize that survives reload, Context, and a 390px reflow.
 * Run: node apps/hub-web/e2e/widgets.mjs
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const SHOTS = "/opt/cursor/artifacts/widgets-r3";
const stamp = Date.now().toString(36);

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

async function signup(label, email) {
  const response = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "widget-pass-1", name: label }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`signup ${response.status}: ${text}`);
  const session = cookieHeader(typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : response.headers.get("set-cookie"));
  return session;
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const email = `widgets-${stamp}@ensemble.test`;
  const session = await signup("Widget", email);
  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);

  await page.goto(`${WEB}/start`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/role-picker.png` });
  await page.locator("[data-role=student]").click();
  await page.locator("[data-template=semester-desk]").waitFor();
  const previewSrc = await page.locator("[data-template] img").evaluateAll((imgs) => imgs.map((img) => img.getAttribute("src")));
  assert.equal(new Set(previewSrc).size, previewSrc.length);
  assert.ok(previewSrc.length >= 5);
  const previewBodies = [];
  for (const src of previewSrc) {
    const response = await page.request.get(src.startsWith("http") ? src : `${WEB}${src}`);
    previewBodies.push(await response.text());
  }
  assert.equal(new Set(previewBodies).size, previewBodies.length);
  const semester = previewBodies.find((body) => body.includes("Semester desk"));
  assert.ok(semester);
  assert.match(semester, /Focus/);
  assert.match(semester, /font-size="(?:1[6-9]|[2-9]\d)/);
  const xs = [...semester.matchAll(/<rect x="([\d.]+)"/g)].map((match) => Number(match[1]));
  assert.ok(xs.length > 1 && Math.min(...xs) < 40, `preview tiles start at ${Math.min(...xs)}`);
  const reading = await (await page.request.get(`${WEB}/templates/reading-pile.svg`)).text();
  const shipping = await (await page.request.get(`${WEB}/templates/learn-by-shipping.svg`)).text();
  const partner = await (await page.request.get(`${WEB}/templates/partner-work.svg`)).text();
  const client = await (await page.request.get(`${WEB}/templates/client-morning.svg`)).text();
  assert.notEqual(reading, shipping);
  assert.notEqual(partner, client);
  const hiddenOnDayOne = ["exam-week", "group-project", "partner-work", "client-morning", "deadline-wall", "on-call-morning", "office-hours"];
  for (const id of hiddenOnDayOne) {
    const body = await (await page.request.get(`${WEB}/templates/${id}.svg`)).text();
    assert.doesNotMatch(body, /Still relevant|Meetings/, `${id} preview shows a tile a new user will not see`);
  }
  const exam = await (await page.request.get(`${WEB}/templates/exam-week.svg`)).text();
  assert.match(exam, /Focus/);
  assert.match(exam, /Reminders/);
  for (const id of ["reading-pile", "two-drafts", "keep-it-small"]) {
    const body = await (await page.request.get(`${WEB}/templates/${id}.svg`)).text();
    const font = body.match(/font-size="([\d.]+)"[^>]*>\s*<title>Deliverables<\/title>/);
    assert.ok(font && Number(font[1]) >= 24, `${id} Deliverables is ${font?.[1] ?? "missing"}px`);
  }
  await page.screenshot({ path: `${SHOTS}/template-picker.png` });
  await page.locator("[data-template=semester-desk]").click();
  await page.getByRole("button", { name: "Use this template" }).click();
  await page.waitForURL(/\/today/, { timeout: 20_000 });
  await page.locator("[data-desk=semester] >> visible=true").waitFor();
  await page.getByRole("button", { name: "Try with sample data" }).waitFor();
  await page.locator(".ghost").first().waitFor();
  await page.goto(`${WEB}/today?view=widgets`, { waitUntil: "networkidle" });
  await page.locator("[data-widget=focus]").waitFor();
  assert.equal(await page.locator("[data-widget=focus]").getAttribute("data-size"), "l");
  await page.screenshot({ path: `${SHOTS}/today-1440.png` });
  for (let i = 0; i < 6; i += 1) {
    await authed(session, "/api/reminders", {
      method: "POST",
      body: JSON.stringify({ title: `Remember ${i} the long note`, dueDate: "2026-10-02" }),
    });
  }
  await page.reload({ waitUntil: "networkidle" });
  const reminderTile = page.locator("[data-widget=reminders]");
  const moreLine = reminderTile.getByText(/\d+ more/);
  await moreLine.waitFor();
  const tileBox = await reminderTile.boundingBox();
  const moreBox = await moreLine.boundingBox();
  assert.ok(tileBox && moreBox);
  assert.ok(moreBox.y >= tileBox.y - 1 && moreBox.y + moreBox.height <= tileBox.y + tileBox.height + 1, `more line clipped ${moreBox.y}..${moreBox.y + moreBox.height} tile ${tileBox.y}..${tileBox.y + tileBox.height}`);

  await page.getByRole("button", { name: "Edit layout" }).click();
  await page.locator("[data-layout-editing]").waitFor();
  const orderOf = () => page.locator("[data-layout-editing] [data-widget]").evaluateAll((els) => els.map((el) => el.getAttribute("data-widget")));
  const before = await orderOf();
  async function dragOnto(type, targetType) {
    const handle = page.locator(`[data-drag-handle=${type}]`);
    const tile = page.locator(`[data-layout-editing] [data-widget=${targetType}]`);
    const handleBox = await handle.boundingBox();
    const target = await tile.boundingBox();
    assert.ok(handleBox && target, `${type} onto ${targetType}`);
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 18 });
    await page.locator(`.widget-drag-overlay`).waitFor();
    await page.locator(`[data-drop-target=${targetType}]`).waitFor();
    const viewport = page.viewportSize();
    await page.mouse.move(viewport.width - 2, Math.min(Math.max(target.y + 24, 40), viewport.height - 24), { steps: 10 });
    const overlay = await page.locator(".widget-drag-overlay").boundingBox();
    assert.ok(overlay, "drag overlay missing at the right edge");
    assert.ok(overlay.x >= -1 && overlay.y >= -1, `overlay origin ${overlay.x},${overlay.y}`);
    assert.ok(overlay.x + overlay.width <= viewport.width + 1, `overlay past the right edge ${overlay.x + overlay.width} > ${viewport.width}`);
    assert.ok(overlay.y + overlay.height <= viewport.height + 1, `overlay past the bottom ${overlay.y + overlay.height}`);
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
    await page.locator(`[data-drop-target=${targetType}]`).waitFor();
    return { handleBox, target };
  }
  await dragOnto("focus", "reminders");
  await page.screenshot({ path: `${SHOTS}/edit-drag.png` });
  await page.mouse.up();
  await page.locator(".widget-drag-overlay").waitFor({ state: "detached" });
  const droppedOnReminders = await orderOf();
  assert.equal(droppedOnReminders.indexOf("focus") + 1, droppedOnReminders.indexOf("reminders"), droppedOnReminders.join(","));
  assert.notEqual(droppedOnReminders.at(-1), "focus");
  await page.locator("[data-layout-editing] [data-widget=focus]").press("Escape");
  await page.locator("[data-layout-editing]").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Edit layout" }).click();
  await page.locator("[data-layout-editing]").waitFor();
  const neighbourBefore = await orderOf();
  const focusAt = neighbourBefore.indexOf("focus");
  const neighbour = neighbourBefore[focusAt + 1];
  assert.ok(neighbour);
  const neighbourSize = await page.locator(`[data-layout-editing] [data-widget=${neighbour}]`).getAttribute("data-size");
  const focusSize = await page.locator(`[data-layout-editing] [data-widget=focus]`).getAttribute("data-size");
  assert.ok(focusSize === "l" || focusSize === "xl");
  assert.ok(neighbourSize === "l" || neighbourSize === "xl" || neighbourSize === "m");
  await dragOnto("focus", neighbour);
  await page.mouse.up();
  await page.locator(".widget-drag-overlay").waitFor({ state: "detached" });
  await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  const swapped = await orderOf();
  assert.equal(swapped.indexOf(neighbour) + 1, swapped.indexOf("focus"), swapped.join(","));
  assert.notDeepEqual(swapped, neighbourBefore);
  await page.screenshot({ path: `${SHOTS}/today-edit-1440.png` });
  const focus = page.locator("[data-layout-editing] [data-widget=focus]");
  await focus.getByRole("button", { name: "m", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.locator("[data-layout-editing]").waitFor({ state: "detached" });
  assert.equal(await page.locator("[data-widget=focus]").getAttribute("data-size"), "m");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("[data-widget=focus]").waitFor();
  assert.equal(await page.locator("[data-widget=focus]").getAttribute("data-size"), "m");
  const after = await page.locator("[data-widget-grid=today] [data-widget]").evaluateAll((els) => els.map((el) => el.getAttribute("data-widget")));
  assert.notDeepEqual(after, before);

  await page.getByRole("button", { name: "Edit layout" }).click();
  await page.locator("[data-layout-editing]").waitFor();
  await page.locator("[data-layout-editing] [data-widget=reminders]").getByRole("button", { name: "xl", exact: true }).click();
  const focusXl = page.locator("[data-layout-editing] [data-widget=focus]").getByRole("button", { name: "xl", exact: true });
  assert.equal(await focusXl.isDisabled(), true);
  assert.match((await focusXl.getAttribute("title")) ?? "", /one extra-large/i);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.locator("[data-layout-editing]").waitFor({ state: "detached" });
  assert.equal(await page.locator("[data-widget=reminders]").getAttribute("data-size"), "xl");
  assert.notEqual(await page.locator("[data-widget=focus]").getAttribute("data-size"), "xl");

  const narrow = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  await narrow.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
  const phone = await narrow.newPage();
  await phone.goto(`${WEB}/today?view=widgets`, { waitUntil: "networkidle" });
  await phone.locator("[data-widget-grid=today]").waitFor();
  assert.equal(await phone.locator("[data-widget-grid=today]").getAttribute("data-columns"), "4");
  assert.equal(await phone.locator("[data-widget-grid=today]").getAttribute("data-phone"), "1");
  await phone.screenshot({ path: `${SHOTS}/today-390.png` });
  const reminder = phone.locator("[data-widget=reminders]");
  const add = reminder.getByRole("button", { name: "Add reminder" });
  const reminderBox = await reminder.boundingBox();
  const addBox = await add.boundingBox();
  assert.ok(reminderBox && addBox);
  assert.ok(addBox.x + addBox.width <= reminderBox.x + reminderBox.width + 1);
  await phone.getByRole("button", { name: "Edit layout" }).click();
  await phone.locator("[data-layout-editing]").waitFor();
  await phone.screenshot({ path: `${SHOTS}/today-edit-390.png` });
  const phoneHandle = phone.locator("[data-drag-handle=focus]");
  await phoneHandle.scrollIntoViewIfNeeded();
  const phoneBox = await phoneHandle.boundingBox();
  assert.ok(phoneBox);
  await phone.mouse.move(phoneBox.x + phoneBox.width / 2, phoneBox.y + phoneBox.height / 2);
  await phone.mouse.down();
  await phone.mouse.move(384, phoneBox.y + phoneBox.height / 2, { steps: 16 });
  await phone.locator(".widget-drag-overlay").waitFor();
  const phoneOverlay = await phone.locator(".widget-drag-overlay").boundingBox();
  assert.ok(phoneOverlay, "390 drag overlay missing");
  assert.ok(phoneOverlay.x >= -1 && phoneOverlay.x + phoneOverlay.width <= 391, `390 overlay x ${phoneOverlay.x}..${phoneOverlay.x + phoneOverlay.width}`);
  assert.ok(phoneOverlay.y >= -1 && phoneOverlay.y + phoneOverlay.height <= 845, `390 overlay y ${phoneOverlay.y}..${phoneOverlay.y + phoneOverlay.height}`);
  await phone.mouse.up();
  await phone.locator(".widget-drag-overlay").waitFor({ state: "detached" });
  await phone.locator("[data-layout-editing] [data-widget=focus]").press("Escape");
  await narrow.close();

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
  await clsPage.goto(`${WEB}/context?view=widgets`, { waitUntil: "networkidle" });
  await clsPage.locator("[data-widget=people]").waitFor();
  await clsPage.waitForTimeout(600);
  const cls = await clsPage.evaluate(() => window.__cls);
  assert.ok(cls < 0.05, `context CLS ${cls}`);
  const tabBox = await clsPage.getByRole("tab", { name: "People" }).boundingBox();
  assert.ok(tabBox && tabBox.y < 280, `tabs should sit near the top, y=${tabBox?.y}`);
  await clsPage.screenshot({ path: `${SHOTS}/context-landing.png` });
  await clsPage.getByRole("tab", { name: "People" }).click();
  await clsPage.waitForURL(/tab=people/);
  await clsContext.close();

  await page.goto(`${WEB}/context?view=widgets`, { waitUntil: "networkidle" });
  await page.locator("[data-widget=people]").waitFor();
  await page.getByRole("tab", { name: "People" }).click();
  await page.waitForURL(/tab=people/);
  assert.match(page.url(), /tab=people/);

  const roles = [
    ["student", "reading-pile", "student"],
    ["teacher", "check-ins", "teacher"],
    ["lawyer", "matter-desk", "lawyer"],
    ["engineer", "branch-desk", "engineer"],
    ["vibe", "one-idea", "vibe"],
    ["manager", "staff-week", "manager"],
  ];
  for (const [role, template, file] of roles) {
    const who = await signup(role, `${role}-${stamp}@ensemble.test`);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    await context.addCookies([{ name: "ensemble_session", value: who, url: WEB }]);
    const tab = await context.newPage();
    await tab.goto(`${WEB}/start`, { waitUntil: "networkidle" });
    await tab.locator(`[data-role=${role}]`).click();
    await tab.locator(`[data-template=${template}]`).click();
    await tab.getByRole("button", { name: "Use this template" }).click();
    await tab.waitForURL(/\/today/, { timeout: 20_000 });
    await tab.locator("[data-desk] >> visible=true").waitFor();
    await tab.locator("[data-desk-tile] >> visible=true").first().waitFor();
    const freshTiles = await tab.locator("[data-desk-tile] >> visible=true").evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height),
    );
    assert.ok(freshTiles.length >= 4, `${role} tiles ${freshTiles.length}`);
    assert.ok(freshTiles.every((height) => height >= 48), `${role} tile heights ${freshTiles.join(",")}`);
    await tab.screenshot({ path: `${SHOTS}/template-${file}.png` });
    if (role === "engineer") {
      await tab.goto(`${WEB}/board`, { waitUntil: "networkidle" });
      const strip = tab.locator("[data-board-strip]");
      await strip.waitFor();
      const stripBox = await strip.boundingBox();
      assert.ok(stripBox && stripBox.height < 120, `strip height ${stripBox?.height}`);
      const tops = await strip.locator("[data-widget]").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
      assert.ok(Math.max(...tops) - Math.min(...tops) < 8);
      await tab.screenshot({ path: `${SHOTS}/board-strip.png` });
      const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
      await phoneContext.addCookies([{ name: "ensemble_session", value: who, url: WEB }]);
      const boardPhone = await phoneContext.newPage();
      await boardPhone.goto(`${WEB}/board`, { waitUntil: "networkidle" });
      const phoneStrip = boardPhone.locator("[data-board-strip]");
      await phoneStrip.waitFor();
      const edit = boardPhone.getByRole("button", { name: "Edit layout" });
      const task = boardPhone.getByRole("button", { name: "New task", exact: true }).first();
      const editBox = await edit.boundingBox();
      const taskBox = await task.boundingBox();
      assert.ok(editBox && editBox.x >= 0 && editBox.x + editBox.width <= 394, `edit layout off screen ${JSON.stringify(editBox)}`);
      assert.ok(taskBox && taskBox.x >= 0 && taskBox.x + taskBox.width <= 394, `new task off screen ${JSON.stringify(taskBox)}`);
      assert.ok(editBox && taskBox && Math.abs(editBox.y - taskBox.y) < 8, `header actions split ${JSON.stringify({ edit: editBox, task: taskBox })}`);
      const fadeWidth = await boardPhone.locator(".board-scroll").evaluate((el) => getComputedStyle(el, "::after").width);
      assert.ok(parseFloat(fadeWidth) > 8, `board fade ${fadeWidth}`);
      await boardPhone.screenshot({ path: `${SHOTS}/board-strip-390.png` });
      await phoneContext.close();
    }
    await context.close();
  }

  const nudgeSession = await signup("Nudges", `nudges-${stamp}@ensemble.test`);
  await authed(nudgeSession, "/api/onboarding", {
    method: "POST",
    body: JSON.stringify({ role: "student", templateId: "exam-week" }),
  });
  await authed(nudgeSession, "/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "Still relevant sample", status: "todo", due: new Date(Date.now() - 36 * 3600 * 1000).toISOString() }),
  });
  const firstHtml = await (await fetch(`${WEB}/today?view=widgets`, { headers: { cookie: `ensemble_session=${nudgeSession}` } })).text();
  assert.match(firstHtml, /data-widget=\\"stale-nudges\\"|data-widget="stale-nudges"/);
  const nudgeContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await nudgeContext.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await nudgeContext.addCookies([{ name: "ensemble_session", value: nudgeSession, url: WEB }]);
  const nudgePage = await nudgeContext.newPage();
  await nudgePage.goto(`${WEB}/today?view=widgets`, { waitUntil: "networkidle" });
  await nudgePage.locator("[data-widget=stale-nudges]").waitFor();
  const focusTop = () => nudgePage.locator("[data-widget=focus]").evaluate((el) => el.getBoundingClientRect().top);
  const focusBefore = await focusTop();
  await nudgePage.waitForTimeout(800);
  const focusAfter = await focusTop();
  assert.ok(Math.abs(focusAfter - focusBefore) < 2, `focus shifted ${focusAfter - focusBefore}`);
  const todayCls = await nudgePage.evaluate(() => window.__cls);
  assert.ok(todayCls < 0.05, `today CLS ${todayCls}`);
  await nudgePage.screenshot({ path: `${SHOTS}/today-nudges-1440.png` });
  await nudgeContext.close();

  const graphSession = await signup("Graph", `graph-${stamp}@ensemble.test`);
  await authed(graphSession, "/api/onboarding", {
    method: "POST",
    body: JSON.stringify({ role: "student", templateId: "reading-pile" }),
  });
  for (let i = 0; i < 130; i += 1) {
    await authed(graphSession, "/api/tasks", { method: "POST", body: JSON.stringify({ title: `Graph node ${i}`, status: "todo" }) });
  }
  const graphContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await graphContext.addCookies([{ name: "ensemble_session", value: graphSession, url: WEB }]);
  const graphPage = await graphContext.newPage();
  await graphPage.goto(`${WEB}/context?view=widgets`, { waitUntil: "networkidle" });
  const graphTile = graphPage.locator("[data-widget=graph]");
  await graphTile.waitFor();
  await graphTile.getByText(/\+\d+ more/).waitFor({ timeout: 20_000 });
  await graphPage.waitForTimeout(400);
  const graphFill = await graphTile.locator("canvas").evaluate((canvas) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return { span: 0, height: 0 };
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minY = height;
    let maxY = 0;
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 8) {
        if (data[(y * width + x) * 4 + 3] > 24) {
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return { span: maxY - minY, height };
  });
  assert.ok(graphFill.height > 0 && graphFill.span / graphFill.height > 0.55, `graph uses ${graphFill.span} of ${graphFill.height}`);
  await graphTile.screenshot({ path: `${SHOTS}/context-graph-large.png` });
  await graphContext.close();

  await browser.close();
  console.log("widgets e2e ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
