/**
 * board.drag: mouse drag persists, keyboard drag announces, touch long-press
 * lifts while a quick swipe does not, haptics fire, each motion style shows,
 * and reduce motion leaves no board animation running.
 *
 * Run: node apps/hub-web/e2e/board-drag.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const ARTIFACTS = process.env.ENSEMBLE_ARTIFACTS ?? "/opt/cursor/artifacts/board-drag";

const APPEARANCE = {
  theme: "dark",
  textScale: 100,
  font: "system",
  motion: "expressive",
  reduceMotion: false,
  accent: "rose",
  accentCustom: null,
};

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function signup() {
  const email = `board-drag-${Date.now().toString(36)}@ensemble.test`;
  const response = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "board-drag-pass-1", name: "Board drag" }),
  });
  if (!response.ok) throw new Error(`signup ${response.status} ${await response.text()}`);
  const session = cookieHeader(typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : response.headers.get("set-cookie"));
  const onboard = await fetch(`${API}/api/onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
    body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
  });
  if (!onboard.ok) throw new Error(`onboard ${onboard.status} ${await onboard.text()}`);
  return session;
}

function client(session) {
  return async function api(method, path, body) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        cookie: `ensemble_session=${session}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 400)}`);
    return json;
  };
}

function appearanceScript(appearance) {
  const payload = JSON.stringify({ ...appearance, accentAt: Date.now() });
  return `localStorage.setItem("ensemble.assistant.open", "false");
    if (!localStorage.getItem("ensemble.appearance")) localStorage.setItem("ensemble.appearance", ${JSON.stringify(payload)});
    window.__haptics = window.__haptics || [];
    window.__hapticBridge = window.__hapticBridge || [];
    if (!window.__hapticListening) {
      window.__hapticListening = true;
      window.addEventListener("ensemble:haptic", (event) => window.__haptics.push(event.detail));
      window.__ensembleHaptic = (kind) => window.__hapticBridge.push(kind);
    }`;
}

async function openBoard(browser, session, { appearance = APPEARANCE, viewport = { width: 1440, height: 900 }, hasTouch = false, reducedMotion, video } = {}) {
  const context = await browser.newContext({
    viewport,
    colorScheme: "dark",
    hasTouch,
    isMobile: hasTouch,
    ...(reducedMotion ? { reducedMotion } : {}),
    ...(video ? { recordVideo: { dir: `${ARTIFACTS}/video`, size: viewport } } : {}),
  });
  await context.addCookies([
    { name: "ensemble_session", value: session, url: WEB },
    { name: "ensemble_accent", value: `${appearance.accent}@${Date.now()}`, url: WEB },
  ]);
  await context.addInitScript(appearanceScript(appearance));
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => console.error("PAGE", error.message));
  await page.goto(`${WEB}/board`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-motion-slot='board.drag']").waitFor();
  await page.waitForFunction(
    (theme) => document.documentElement.dataset.motionTheme === theme,
    appearance.motion,
  );
  if (appearance.accent === "rose") {
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase() === "#f0a0b8");
  }
  return { context, page };
}

async function card(page, title) {
  const handle = page.locator("[data-bdg-card]").filter({ hasText: title }).first();
  await handle.waitFor();
  await handle.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
  return handle;
}

async function pointOn(locator, dx, dy) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no box");
  return { x: box.x + dx, y: box.y + dy };
}

async function centerOf(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no box");
  return { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 28) };
}

async function waitFloat(page) {
  await page.locator(".bdg-float").first().waitFor();
}

async function settleFloats(page) {
  await page.waitForFunction(() => document.querySelectorAll(".bdg-float").length === 0, null, { timeout: 4000 }).catch(() => {});
}

async function dismissPeek(page) {
  const dialog = page.getByRole("dialog");
  if (await dialog.count()) {
    await page.keyboard.press("Escape");
    await dialog.first().waitFor({ state: "hidden" }).catch(() => {});
  }
}

async function runningBoardAnimations(page) {
  return page.evaluate(() => {
    const roots = document.querySelectorAll('.board-frame, .bdg-float, .bdg-layer, [data-motion-slot="board.drag"]');
    const running = [];
    for (const root of roots) {
      for (const animation of root.getAnimations({ subtree: true })) {
        if (animation.playState === "running") {
          const target = animation.effect?.target;
          running.push(target instanceof Element ? `${target.tagName}.${target.className}` : "unknown");
        }
      }
    }
    return running;
  });
}

async function assertHoverLift(page, handle, motion) {
  const point = await centerOf(handle);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(220);
  const lift = await handle.evaluate((node) => {
    const card = node.querySelector(".board-card");
    const cardStyle = getComputedStyle(card);
    const wrapStyle = getComputedStyle(node);
    return {
      cardTranslate: cardStyle.translate,
      cardTransform: cardStyle.transform,
      wrapTranslate: wrapStyle.translate,
      wrapTransform: wrapStyle.transform,
    };
  });
  assert.equal(lift.cardTransform, "none", `${motion} hover uses transform ${JSON.stringify(lift)}`);
  assert.equal(lift.wrapTransform, "none", `${motion} wrapper transform ${JSON.stringify(lift)}`);
  assert.equal(lift.wrapTranslate, "none", `${motion} wrapper translate ${JSON.stringify(lift)}`);
  if (motion === "expressive") assert.equal(lift.cardTranslate, "0px -1px", JSON.stringify(lift));
  else assert.equal(lift.cardTranslate, "none", `${motion} ${JSON.stringify(lift)}`);
  console.log(`hover ${motion} ${JSON.stringify(lift)}`);
}

async function placeholder(page) {
  return page.evaluate(() => {
    const el = document.querySelector("[data-bdg-ph]");
    if (!el) return null;
    const before = getComputedStyle(el, "::before");
    return {
      borderStyle: before.borderTopStyle,
      borderWidth: before.borderTopWidth,
      width: before.width,
      height: before.height,
      radius: before.borderTopLeftRadius,
    };
  });
}

async function mouseDragAcross(page, title, { shots } = {}) {
  const handle = await card(page, title);
  const start = await pointOn(handle, 28, 18);
  const column = page.locator("[data-column='in_progress']");
  const end = await pointOn(column, 80, 150);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 16, start.y + 10, { steps: 6 });
  await waitFloat(page);
  if (shots) await page.screenshot({ path: `${ARTIFACTS}/${shots}-lift.png` });
  await page.mouse.move(end.x, end.y, { steps: 24 });
  await page.waitForTimeout(80);
  if (shots) await page.screenshot({ path: `${ARTIFACTS}/${shots}-over.png` });
  const over = await page.locator("[data-column='in_progress'] [data-bdg-list]").getAttribute("data-over");
  assert.equal(over, "yes", `${title} did not mark In progress as the drop column`);
  const moved = page.waitForResponse((response) => response.url().includes("/move") && response.request().method() === "POST");
  await page.mouse.up();
  if (shots) {
    await page.waitForTimeout(90);
    await page.screenshot({ path: `${ARTIFACTS}/${shots}-drop.png` });
  }
  const response = await moved;
  assert.equal(response.ok(), true, await response.text());
  await settleFloats(page);
  await dismissPeek(page);
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });
  mkdirSync(`${ARTIFACTS}/video`, { recursive: true });
  const session = await signup();
  const api = client(session);
  const stamp = Date.now().toString(36);
  const titles = {
    persist: `drag persist ${stamp}`,
    reorderA: `reorder a ${stamp}`,
    reorderB: `reorder b ${stamp}`,
    keys: `drag keys ${stamp}`,
    touch: `drag touch ${stamp}`,
    swipe: `drag swipe ${stamp}`,
    cancel: `drag cancel ${stamp}`,
    reduce: `drag reduce ${stamp}`,
    agent: `drag agent ${stamp}`,
    done: `drag done ${stamp}`,
    expressive: `style expressive ${stamp}`,
    quiet: `style quiet ${stamp}`,
    dot: `style dot ${stamp}`,
  };
  const created = {};
  for (const [key, title] of Object.entries(titles)) {
    const status = key === "reorderA" || key === "reorderB" ? "todo" : "todo";
    created[key] = (await api("POST", "/api/tasks", { title, status, priority: "p1" })).task;
  }

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const { context, page } = await openBoard(browser, session, { video: true });
    await page.getByText(titles.persist, { exact: true }).waitFor();

    const agentVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bdg-agent").trim().toLowerCase());
    const accentVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase());
    assert.equal(agentVar, "#9d8fff", `agent violet drifted to ${agentVar}`);
    assert.equal(accentVar, "#f0a0b8", `rose accent did not apply (${accentVar})`);
    const touchAction = await page.locator("[data-bdg-card]").first().evaluate((el) => getComputedStyle(el).touchAction);
    assert.equal(touchAction, "pan-y");

    await mouseDragAcross(page, titles.persist);
    assert.equal((await api("GET", `/api/tasks/${created.persist.id}`)).task.status, "in_progress");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`[data-column='in_progress'] [data-bdg-card]`).filter({ hasText: titles.persist }).waitFor();
    assert.equal((await api("GET", `/api/tasks/${created.persist.id}`)).task.status, "in_progress");

    await page.locator("header").click();
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(800);
    assert.equal((await api("GET", `/api/tasks/${created.persist.id}`)).task.status, "todo", "undo did not restore the dragged card");

    const beforeOrder = (await api("GET", "/api/tasks")).tasks
      .filter((task) => task.id === created.reorderA.id || task.id === created.reorderB.id)
      .map((task) => task.id);
    const top = await card(page, titles.reorderA);
    const below = await card(page, titles.reorderB);
    const from = await pointOn(top, 30, 16);
    const to = await pointOn(below, 30, 36);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 18 });
    const reordered = page.waitForResponse((response) => response.url().includes("/move") && response.request().method() === "POST");
    await page.mouse.up();
    assert.equal((await reordered).ok(), true);
    await settleFloats(page);
    await dismissPeek(page);
    const afterOrder = (await api("GET", "/api/tasks")).tasks
      .filter((task) => task.id === created.reorderA.id || task.id === created.reorderB.id)
      .map((task) => task.id);
    assert.deepEqual(afterOrder, [beforeOrder[1], beforeOrder[0]], `reorder expected ${beforeOrder[1]} then ${beforeOrder[0]}, got ${afterOrder.join(",")}`);

    const keyCard = await card(page, titles.keys);
    await keyCard.focus();
    await page.keyboard.press("Space");
    // The live region is atomic, so the pickup line is replaced as soon as the card is over a column.
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some((el) => /Picked up|is over/.test(el.textContent || "")));
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some((el) => /is over (?!todo)/.test(el.textContent || "")));
    const keyMoved = page.waitForResponse((response) => response.url().includes("/move") && response.request().method() === "POST");
    await page.keyboard.press("Space");
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some((el) => /Dropped/.test(el.textContent || "")));
    assert.equal((await keyMoved).ok(), true);
    assert.notEqual((await api("GET", `/api/tasks/${created.keys.id}`)).task.status, "todo", "keyboard drag did not leave To do");
    await dismissPeek(page);

    const hapticsBefore = await page.evaluate(() => window.__haptics.length);
    const cancelCard = await card(page, titles.cancel);
    const cancelAt = await pointOn(cancelCard, 24, 16);
    await page.mouse.move(cancelAt.x, cancelAt.y);
    await page.mouse.down();
    await page.mouse.move(cancelAt.x + 40, cancelAt.y + 8, { steps: 8 });
    await waitFloat(page);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await settleFloats(page);
    const haptics = await page.evaluate(() => ({ events: window.__haptics, bridge: window.__hapticBridge }));
    const fresh = haptics.events.slice(hapticsBefore);
    assert.ok(fresh.some((event) => event.kind === "lift" && event.reduced === false), `missing lift haptic ${JSON.stringify(fresh)}`);
    assert.ok(fresh.some((event) => event.kind === "cancel" && event.reduced === false), `missing cancel haptic ${JSON.stringify(fresh)}`);
    assert.ok(haptics.bridge.includes("lift") && haptics.bridge.includes("cancel"), "native haptic bridge was not called");
    assert.equal((await api("GET", `/api/tasks/${created.cancel.id}`)).task.status, "todo");

  const dropCard = await card(page, titles.expressive);
  const dropAt = await centerOf(dropCard);
  const hapticsAt = await page.evaluate(() => window.__haptics.length);
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    const card = el?.closest?.("[data-bdg-card]");
    return { x, y, tag: el?.tagName, cls: String(el?.className || "").slice(0, 80), card: card?.getAttribute("data-id") ?? null };
  }, dropAt);
  if (!hit.card) throw new Error(`drop grab missed a card ${JSON.stringify(hit)}`);
  await page.mouse.move(dropAt.x, dropAt.y);
  await page.mouse.down();
  await page.mouse.move(dropAt.x + 30, dropAt.y + 12, { steps: 6 });
  await waitFloat(page);
    const column = page.locator("[data-column='in_progress']");
    const land = await pointOn(column, 70, 160);
    await page.mouse.move(land.x, land.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const dropEvents = await page.evaluate((start) => window.__haptics.slice(start), hapticsAt);
    assert.ok(dropEvents.some((event) => event.kind === "drop"), `missing drop haptic ${JSON.stringify(dropEvents)}`);
    await dismissPeek(page);

    await page.evaluate(() => {
      window.__boardStates = [];
      document.querySelector("[data-motion-slot='board.drag']")?.addEventListener("board:state", (event) => {
        window.__boardStates.push(event.detail?.state);
      });
    });
    await api("POST", `/api/tasks/${created.agent.id}/move`, { status: "in_progress" });
    await page.locator(`[data-column='in_progress']`).getByText(titles.agent, { exact: true }).waitFor({ timeout: 8000 });
    await page.waitForFunction(() => window.__boardStates?.includes("agent"), null, { timeout: 4000 });
    const sawRope = await page.locator(".bdg-rope").count();
    console.log(`agent states=${JSON.stringify(await page.evaluate(() => window.__boardStates))} rope=${sawRope}`);

    await page.evaluate(() => { window.__boardStates = []; });
    await api("POST", `/api/tasks/${created.done.id}/move`, { status: "done" });
    await page.locator(`[data-column='done']`).getByText(titles.done, { exact: true }).waitFor({ timeout: 8000 });
    await page.waitForFunction(() => window.__boardStates?.includes("done"), null, { timeout: 4000 });

    const styles = [
      ["expressive", titles.expressive, { borderStyle: "dashed" }],
      ["minimal-quiet", titles.quiet, { borderStyle: "solid", borderWidth: "1px" }],
      ["minimal-dot", titles.dot, { width: "7px", height: "7px" }],
    ];
    for (const [motion, title, expectPh] of styles) {
      await page.evaluate((motion) => {
        const raw = JSON.parse(localStorage.getItem("ensemble.appearance") || "{}");
        localStorage.setItem("ensemble.appearance", JSON.stringify({ ...raw, motion, reduceMotion: false, accent: "rose" }));
      }, motion);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction((theme) => document.documentElement.dataset.motionTheme === theme, motion);
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bdg-agent").trim().toLowerCase()), "#9d8fff");
      const handle = await card(page, title);
      await assertHoverLift(page, handle, motion);
      const start = await centerOf(handle);
      const end = await pointOn(page.locator("[data-column='waiting']"), 70, 120);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 18, start.y + 8, { steps: 6 });
      await waitFloat(page);
      const ph = await placeholder(page);
      assert.ok(ph, `${motion} did not leave a placeholder`);
      if (expectPh.borderStyle) assert.equal(ph.borderStyle, expectPh.borderStyle, `${motion} ${JSON.stringify(ph)}`);
      if (expectPh.borderWidth) assert.equal(ph.borderWidth, expectPh.borderWidth, `${motion} ${JSON.stringify(ph)}`);
      if (expectPh.width) assert.equal(ph.width, expectPh.width, motion);
      if (expectPh.height) assert.equal(ph.height, expectPh.height, motion);
      await page.screenshot({ path: `${ARTIFACTS}/${motion}-lift.png` });
      await page.mouse.move(end.x, end.y, { steps: 22 });
      await page.waitForTimeout(100);
      const over = await page.locator("[data-column='waiting'] [data-bdg-list]").getAttribute("data-over");
      assert.equal(over, "yes", `${motion} over-column marker`);
      await page.screenshot({ path: `${ARTIFACTS}/${motion}-over.png` });
      await page.mouse.up();
      await page.waitForTimeout(120);
      await page.screenshot({ path: `${ARTIFACTS}/${motion}-drop.png` });
      await settleFloats(page);
      await dismissPeek(page);
    }

    const video = page.video();
    await context.close();
    if (video) {
      const saved = await video.path();
      console.log(`video ${saved}`);
    }

    const reducedAppearance = { ...APPEARANCE, motion: "expressive", reduceMotion: true };
    const reduced = await openBoard(browser, session, { appearance: reducedAppearance });
    await reduced.page.waitForFunction(() => document.documentElement.dataset.reduceMotion === "true");
    const reduceHandle = await card(reduced.page, titles.reduce);
    const reduceAt = await pointOn(reduceHandle, 24, 16);
    await reduced.page.mouse.move(reduceAt.x, reduceAt.y);
    await reduced.page.mouse.down();
    await reduced.page.mouse.move(reduceAt.x + 20, reduceAt.y + 8, { steps: 5 });
    await waitFloat(reduced.page);
    const whileHeld = await runningBoardAnimations(reduced.page);
    assert.deepEqual(whileHeld, [], `reduce motion still running while held: ${whileHeld.join(", ")}`);
    await reduced.page.mouse.up();
    await reduced.page.waitForTimeout(450);
    const afterDrop = await runningBoardAnimations(reduced.page);
    assert.deepEqual(afterDrop, [], `reduce motion still running after drop: ${afterDrop.join(", ")}`);
    const reducedHaptic = await reduced.page.evaluate(() => window.__haptics.find((event) => event.kind === "lift"));
    assert.equal(reducedHaptic?.reduced, true);
    await reduced.context.close();

    const touch = await openBoard(browser, session, {
      hasTouch: true,
      viewport: { width: 390, height: 640 },
    });
    const swipeHandle = await card(touch.page, titles.swipe);
    const swipeAt = await pointOn(swipeHandle, 40, 20);
    const cdp = await touch.context.newCDPSession(touch.page);
    const scrollBefore = await touch.page.evaluate(() => document.querySelector("main")?.scrollTop ?? 0);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: swipeAt.x, y: swipeAt.y, id: 1 }] });
    await touch.page.waitForTimeout(40);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: swipeAt.x, y: swipeAt.y + 70, id: 1 }] });
    await touch.page.waitForTimeout(30);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await touch.page.waitForTimeout(200);
    assert.equal(await touch.page.locator(".bdg-float").count(), 0, "quick swipe lifted a card");
    assert.equal(await touch.page.locator("[data-bdg-ph]").count(), 0, "quick swipe left a placeholder");
    const scrollAfter = await touch.page.evaluate(() => document.querySelector("main")?.scrollTop ?? 0);
    console.log(`touch swipe scroll ${scrollBefore} -> ${scrollAfter}`);

    const liftHandle = await card(touch.page, titles.touch);
    const liftAt = await pointOn(liftHandle, 40, 18);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: liftAt.x, y: liftAt.y, id: 1 }] });
    await touch.page.waitForTimeout(120);
    assert.equal(await touch.page.locator(".bdg-float").count(), 0, "card lifted before the long-press delay");
    await waitFloat(touch.page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: liftAt.x + 24, y: liftAt.y + 10, id: 1 }] });
    await touch.page.waitForTimeout(80);
    await touch.page.screenshot({ path: `${ARTIFACTS}/touch-lift.png` });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await settleFloats(touch.page);
    const touchHaptic = await touch.page.evaluate(() => window.__haptics.map((event) => event.kind));
    assert.ok(touchHaptic.includes("lift"), `touch lift haptic missing ${touchHaptic.join(",")}`);
    await touch.context.close();

    console.log("board.drag checks passed");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
