/** Run against an isolated local API and a production Hub build: HUB_API=… HUB_WEB=… node apps/hub-web/e2e/onboarding-tour.mjs. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4117";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3117";
for (const url of [API, WEB]) assert.ok(["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Use isolated local services; this check creates fictional accounts.");
const chrome = process.env.CHROME_PATH ?? (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const shots = process.env.TOUR_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: chrome, headless: true });

async function account(role, theme, reduce, textScale = 100) {
  const response = await fetch(`${API}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Mira Chen", email: `tour-${role}-${Date.now()}@fieldnote.example`, password: "tour-check-123456" }) });
  assert.equal(response.status, 200, await response.clone().text());
  const session = /ensemble_session=([^;]+)/.exec(response.headers.get("set-cookie"))?.[1];
  assert.ok(session);
  const request = async (path, method = "GET", body) => {
    const result = await fetch(`${API}${path}`, { method, headers: { cookie: `ensemble_session=${session}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(result.ok, `${path}: ${result.status} ${await result.clone().text()}`);
    return result.json();
  };
  const appearance = { theme, motion: "expressive", reduceMotion: reduce, accent: "indigo", accentCustom: null, font: "system", textScale };
  await request("/api/settings", "PATCH", { appearance });
  return { session, request, appearance };
}

async function verifyPageStory(request) {
  const { person } = await request("/api/people", "POST", { name: "Daniel Park", role: "Reviewer" });
  const { project } = await request("/api/projects", "POST", { name: "Fieldnote release" });
  const { page } = await request("/api/pages", "POST", {});
  await request(`/api/pages/${page.id}`, "PATCH", { title: "Release review plan" });
  const opened = await request(`/api/pages/${page.id}`);
  const content = { type: "doc", content: [{ type: "paragraph", content: [
    { type: "mention", attrs: { kind: "people", id: person.id, label: person.name } },
    { type: "text", text: " asked me to review the release checklist for " },
    { type: "mention", attrs: { kind: "project", id: project.id, label: project.name } },
    { type: "text", text: " by " },
    { type: "mention", attrs: { kind: "date", id: "2026-10-14", label: "Tomorrow" } },
  ] }] };
  const saved = await request(`/api/pages/${page.id}`, "PUT", { revision: opened.revision, content });
  const converted = await request(`/api/pages/page/${page.id}/convert`, "POST", { revision: saved.revision });
  const before = await request(`/api/tasks/${converted.id}`);
  assert.equal(before.task.due, null, "a date mention does not set a task deadline");
  await request(`/api/tasks/${converted.id}`, "PATCH", { due: "2026-10-14T17:00:00.000Z" });
  const graph = await request("/api/context/graph");
  assert.ok(graph.nodes.some((node) => node.id === converted.id && node.label === "Release review plan"));
  for (const target of [person.id, project.id]) assert.ok(graph.edges.some((edge) => edge.source === converted.id && edge.target === target && edge.kind === "mention"), "saved page mention appears in the real Context graph");
  console.log("Page → Add to board → explicit due date → Context mention edges verified against the real local API");
}

async function bounds(page) {
  const result = await page.locator(".walkthrough").evaluate((card) => {
    const rect = card.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: window.innerWidth, height: window.innerHeight, scroll: document.documentElement.scrollWidth };
  });
  assert.ok(result.left >= 0 && result.top >= 0 && result.right <= result.width + 1 && result.bottom <= result.height + 1, JSON.stringify(result));
  assert.ok(result.scroll <= result.width, "no horizontal page overflow");
}

try {
  for (const scenario of [
    { role: "engineer", theme: "dark", viewport: { width: 1440, height: 900 }, reduce: false, stop: "code" },
    { role: "engineer", theme: "dark", viewport: { width: 1152, height: 720 }, reduce: true, stop: "code", name: "zoom-125", textScale: 125 },
    { role: "vibe", theme: "dark", viewport: { width: 960, height: 600 }, reduce: true, stop: "files", name: "zoom-150" },
    { role: "lawyer", theme: "light", viewport: { width: 720, height: 450 }, reduce: true, stop: "files", name: "zoom-200" },
    { role: "teacher", theme: "light", viewport: { width: 1280, height: 650 }, reduce: true, stop: "files", name: "short-desktop" },
    { role: "student", theme: "light", viewport: { width: 390, height: 844 }, reduce: true, stop: "files" },
    { role: "manager", theme: "light", viewport: { width: 844, height: 390 }, reduce: true, stop: "meetings" },
  ]) {
    const fixture = await account(scenario.role, scenario.theme, scenario.reduce, scenario.textScale);
    const context = await browser.newContext({ viewport: scenario.viewport, reducedMotion: scenario.reduce ? "reduce" : "no-preference" });
    await context.addCookies([{ name: "ensemble_session", value: fixture.session, url: WEB }]);
    await context.addInitScript((appearance) => localStorage.setItem("ensemble.appearance", JSON.stringify(appearance)), fixture.appearance);
    const page = await context.newPage();
    const crashes = [];
    page.on("pageerror", (error) => crashes.push(error.message));
    await page.goto(`${WEB}/start`, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-role="${scenario.role}"]`).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.locator("[data-start-template]").click();
    await page.locator('[data-onboarding-tour="welcome"]').waitFor({ timeout: 30000 });
    assert.equal(await page.locator("html").getAttribute("data-theme"), scenario.theme);
    assert.match(await page.locator("#tour-title").innerText(), /Mira/);
    await page.locator(".walkthrough").evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {}))));
    if (shots) await page.screenshot({ path: `${shots}/${scenario.name ?? scenario.role}-welcome.png` });
    const before = await fixture.request("/api/tasks");
    const appUrl = page.url();
    const originalFrame = await page.locator(".walkthrough").boundingBox();
    const originalButton = await page.locator("[data-tour-next]").boundingBox();
    assert.equal(await page.locator(".film-app").getAttribute("inert"), "");
    assert.equal(await page.locator(".film-app button, .film-app a, .film-app input").count(), 0);
    const visited = [];
    let resumed = false;
    while (true) {
      const step = await page.locator("[data-onboarding-tour]").getAttribute("data-onboarding-tour");
      visited.push(step);
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await Promise.all(document.querySelector(".guided-tour").getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
      });
      if (!scenario.reduce && ["arrange", "pages", "context", "approvals"].includes(step)) {
        const duration = Number(await page.locator('[aria-label="Scene playback"]').getAttribute('aria-valuemax')) * 1000;
        await page.waitForFunction((duration) => Number(document.querySelector('.walkthrough-stage').dataset.playbackMs) >= duration, duration, { timeout: 15000 });
      }
      await bounds(page);
      const fit = await page.locator(".film-viewport").evaluate((viewport) => {
        const v = viewport.getBoundingClientRect();
        const c = viewport.querySelector(".film-canvas").getBoundingClientRect();
        const scene = viewport.querySelector('.film-layer:not([data-phase="out"]) .film-scene');
        const box = scene.getBoundingClientRect();
        const targets = [...scene.querySelectorAll('.film-intro, .film-gallery, .film-document, .film-context-record, .film-real-request, .film-source-details, .film-code, .film-paper, .film-notes, .film-chat')].map((node) => ({ name: node.className, rect: node.getBoundingClientRect().toJSON() }));
        return { v: v.toJSON(), c: c.toJSON(), box: box.toJSON(), targets };
      });
      assert.ok(fit.c.left >= fit.v.left - 1 && fit.c.right <= fit.v.right + 1 && fit.c.top >= fit.v.top - 1 && fit.c.bottom <= fit.v.bottom + 1, `entire canvas fits ${step}: ${JSON.stringify(fit)}`);
      for (const { name, rect } of fit.targets) assert.ok(rect.top >= fit.box.top - 1 && rect.bottom <= fit.box.bottom + 1, `${name} fits vertically on ${step}: ${JSON.stringify(fit)}`);
      if (step === "arrange") {
        const tile = await page.locator('.film-gallery-preview .tb').evaluate((node) => ({ content: node.scrollHeight, available: node.clientHeight }));
        assert.ok(tile.content <= tile.available + 1, `tile preview fits: ${JSON.stringify(tile)}`);
      }
      if (step === "pages" && scenario.reduce) assert.match(await page.locator('.film-document').innerText(), /On the board · due Tomorrow/);
      if (step === "context") assert.equal(visited.at(-2), "pages", "Context immediately follows the page story");
      if (step === "approvals") assert.equal(await page.locator('.film-review-overview > div').count(), 3, "real Needs me queue categories");
      assert.equal(page.url(), appUrl, "the walkthrough never navigates the real workspace");
      const frame = await page.locator(".walkthrough").boundingBox();
      const button = await page.locator("[data-tour-next]").boundingBox();
      for (const key of ["x", "y", "width", "height"]) {
        assert.ok(Math.abs(frame[key] - originalFrame[key]) < 1, `popup ${key} stays fixed on ${step}: ${frame[key]} vs ${originalFrame[key]}`);
        assert.ok(Math.abs(button[key] - originalButton[key]) < 1, `Next ${key} stays fixed`);
      }
      if (step === "today" && !scenario.reduce) {
        await page.locator('[aria-label="Pause scene"]').click();
        const paused = await page.locator(".walkthrough-stage").getAttribute("data-playback-ms");
        await page.waitForTimeout(300);
        assert.equal(await page.locator(".walkthrough-stage").getAttribute("data-playback-ms"), paused);
        await page.locator('[aria-label="Restart scene"]').click();
        await page.waitForFunction(() => Number(document.querySelector(".walkthrough-stage").dataset.playbackMs) >= 6000, null, { timeout: 20000 });
        assert.equal(await page.locator("[data-onboarding-tour]").getAttribute("data-onboarding-tour"), "today", "scenes hold for the user to advance");
      }
      if (scenario.reduce) assert.equal(await page.locator(".film-pointer").count(), 0);
      if (shots && ["today", "arrange", "pages", "context", "approvals", scenario.stop].includes(step)) await page.screenshot({ path: `${shots}/${scenario.name ?? scenario.role}-${step}.png` });
      if (step === "board" && !resumed) {
        await page.waitForFunction(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((key) => key.startsWith("ensemble.tour:"))))?.step === "board");
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.locator('[data-onboarding-tour="board"]').waitFor();
        resumed = true;
      }
      if (step === "finish") break;
      await page.locator("[data-tour-next]").click();
      assert.ok(await page.locator("[data-tour-next]").evaluate((node) => node === document.activeElement), "keyboard focus stays on Next through the crossfade");
      await page.waitForFunction((previous) => document.querySelector("[data-onboarding-tour]")?.dataset.onboardingTour !== previous, step);
    }
    assert.ok(visited.includes(scenario.stop), `${scenario.role} gets ${scenario.stop}`);
    await page.locator("[data-tour-next]").click();
    await page.locator("[data-onboarding-tour]").waitFor({ state: "detached" });
    const after = await fixture.request("/api/tasks");
    assert.equal(after.tasks.length, before.tasks.length, "tour does not create tasks");
    const preferencesLoaded = page.waitForResponse((response) => response.url().includes("/api/preferences") && response.ok());
    await page.reload({ waitUntil: "domcontentloaded" });
    await preferencesLoaded;
    await page.locator("[data-account-avatar]").waitFor();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator("[data-onboarding-tour]").count(), 0, "completed guide stays dismissed");
    await page.locator("[data-account-avatar]").click();
    await page.getByRole("menuitem", { name: "Take a tour" }).click();
    await page.locator('[data-onboarding-tour="welcome"]').waitFor();
    await page.keyboard.press("Escape");
    await page.locator("[data-onboarding-tour]").waitFor({ state: "detached" });
    assert.deepEqual(crashes, []);
    if (scenario.role === "engineer" && !scenario.name) await verifyPageStory(fixture.request);
    console.log(`${scenario.role}: setup, ${visited.length} simulated chapters, ${scenario.stop}, stable frame/controls, pause, resume, completion and replay passed (${scenario.theme}, ${scenario.viewport.width}×${scenario.viewport.height})`);
    await context.close();
  }
} finally { await browser.close(); }
