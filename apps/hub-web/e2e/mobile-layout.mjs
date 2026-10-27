/**
 * Start scripts/mobile-ui-fixture.ts with isolated local Hub and Node dev servers.
 * CHROME_PATH=... HUB_WEB=http://localhost:3092 NODE_WEB=http://localhost:3392 node apps/hub-web/e2e/mobile-layout.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const WEB = process.env.HUB_WEB ?? "http://localhost:3092";
const NODE = process.env.NODE_WEB;
for (const origin of [WEB, NODE].filter(Boolean)) assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname), "Use only isolated local apps.");
const fixture = JSON.parse(readFileSync(process.env.MOBILE_FIXTURE_PATH ?? "/tmp/ensemble-mobile-ui.json", "utf8"));
const shots = process.env.MOBILE_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ["--no-sandbox"] });
const errors = [];
const content = "export const mobile = true;\n" + "// Long code stays in the editor. ".repeat(80) + "\n";

async function fits(page, label, selector = "body") {
  const result = await page.locator(selector).first().evaluate(el => ({
    width: el.clientWidth, scroll: el.scrollWidth, viewport: innerWidth,
    right: el.getBoundingClientRect().right,
  }));
  assert.ok(result.scroll <= result.width + 2, `${label}: horizontal overflow ${JSON.stringify(result)}`);
  assert.ok(result.right <= result.viewport + 2, `${label}: outside viewport ${JSON.stringify(result)}`);
}

async function scrolls(page, selector, label) {
  const scroller = page.locator(selector).first();
  await scroller.evaluate(el => { el.scrollTop = 0; });
  const box = await scroller.boundingBox();
  assert.ok(box && box.height > 150, `${label} has a usable scroll area`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height - 50;
  if (page.viewportSize().width < 768) {
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 12; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 10 }] });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 180);
  }
  await page.waitForFunction(selector => document.querySelector(selector).scrollTop > 0, selector);
}

async function snap(page, name) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

try {
  for (const width of [320, 390, 640, 768, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 768, hasTouch: width < 768, reducedMotion: "reduce" });
    const [cookieName, ...cookieValue] = fixture.cookie.split("=");
    await context.addCookies([{ name: cookieName, value: cookieValue.join("="), url: WEB }]);
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(`${width}: ${error.message}`));
    await page.route("**/api/shell", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), hostCode: false } });
    });
    await page.route("**/api/devices", async route => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, devices: data.devices.map(device => ({ ...device, online: true })) } });
    });
    await page.route("**/api/devices/*/code", async route => {
      const { path } = route.request().postDataJSON();
      const replies = {
        "/api/code/source": { kind: "repo", repo: "/work/mobile", branch: "mobile-layout", title: "Mobile repository", files: [{ path: "mobile.ts", status: "M", added: 1, removed: 0 }], unreviewable: [], planted: [], decisions: [] },
        "/api/code/repos": { repos: ["/work/mobile"] },
        "/api/code/reviews": { reviews: [] },
        "/api/code/tree": { entries: [{ name: "mobile.ts", kind: "file", size: content.length }], truncated: false },
        "/api/code/versions": { path: "mobile.ts", current: content, start: "", agent: content, original: "", exists: { start: true, agent: true, current: true }, hash: "h1", eol: "lf" },
        "/api/code/scm": { branch: "mobile-layout", staged: [], unstaged: [], untracked: [], log: [], ahead: 0, behind: 0 },
      };
      assert.ok(path in replies, `Unexpected Code read: ${path}`);
      await route.fulfill({ json: replies[path] });
    });
    await page.route("**/api/agent/jobs/*/files", route => route.fulfill({ json: { files: [{ path: "mobile.ts", status: "added", added: 1, removed: 0, stored: true }], live: { available: true } } }));
    await page.route("**/api/agent/jobs/*/file?*", route => route.fulfill({ json: { source: "live", file: { path: "mobile.ts", content, size: content.length, binary: false } } }));

    await page.goto(`${WEB}/runs`);
    await page.locator("[data-run-queue] .tile").first().waitFor();
    await fits(page, `Run queue ${width}`, "#main-content");
    const columns = await page.locator("[data-run-queue]").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    assert.equal(columns, width < 1024 ? 1 : 3);
    await scrolls(page, "#main-content", "Runs");
    await snap(page, `hub-run-queue-${width}`);
    await page.getByRole("button", { name: "Assign task", exact: true }).click();
    await page.getByRole("dialog", { name: "Assign to agent", exact: true }).waitFor();
    await fits(page, `Assignment dialog ${width}`, "[role=dialog]");
    await page.keyboard.press("Escape");

    await page.goto(`${WEB}/needs-me`);
    await page.locator(".decision-option").first().waitFor();
    await fits(page, `Needs me ${width}`, "#main-content");
    for (const button of await page.locator(".decision-option").all()) {
      assert.equal(await button.evaluate(el => el.scrollWidth <= el.clientWidth + 2), true, `Answer ${width} wraps inside its button`);
    }

    await page.goto(`${WEB}/runs`);
    await page.getByRole("button", { name: /^Preview the run/ }).first().waitFor();
    await fits(page, `Runs ${width}`, "#main-content");
    await snap(page, `hub-runs-${width}`);
    await page.getByRole("button", { name: /^Preview the run/ }).first().click();
    await page.locator(".run-sheet [role=tab]").first().waitFor();
    await fits(page, `Run sheet ${width}`, ".run-sheet");
    await page.getByRole("tab", { name: /Traces/ }).click();
    await fits(page, `Run trace ${width}`, ".run-sheet");
    await page.getByRole("button", { name: "Close", exact: true }).click();

    for (const tab of ["overview", "people", "projects", "repos", "graph"]) {
      await page.goto(`${WEB}/context?tab=${tab}`);
      await page.locator("[data-context-lens]").waitFor();
      await fits(page, `Context ${tab} ${width}`, "#main-content");
      if (tab === "people") await page.locator("[data-person-card]").first().waitFor();
    }
    await snap(page, `hub-context-${width}`);
    await page.goto(`${WEB}/context?view=list`);
    await page.locator("[data-context-view=list]").waitFor();
    await fits(page, `Context list ${width}`, "#main-content");

    await page.goto(`${WEB}/code?job=${fixture.jobId}`);
    await page.locator("[data-testid=run-code] .cm-editor").waitFor();
    await fits(page, `Run code ${width}`, "#main-content");
    if (width < 768) {
      await page.getByRole("button", { name: "Files", exact: true }).click();
      assert.equal(await page.getByRole("complementary", { name: "Files", exact: true }).isVisible(), true);
      await page.getByRole("button", { name: /A.*mobile.ts/ }).click();
      assert.equal(await page.getByRole("complementary", { name: "Files", exact: true }).isVisible(), false);
    }
    await page.goto(`${WEB}/code/review?device=${fixture.deviceId}&repo=/work/mobile`);
    await page.locator(".cm-editor").waitFor();
    await fits(page, `Code IDE ${width}`, "#main-content");
    if (width < 768) {
      assert.equal(await page.getByRole("complementary", { name: "Side panel", exact: true }).count(), 0);
      await page.getByRole("button", { name: "Explorer (Ctrl+B)", exact: true }).click();
      await page.getByRole("complementary", { name: "Side panel", exact: true }).waitFor();
      await fits(page, `Code panel ${width}`, 'aside[aria-label="Side panel"]');
      await page.getByRole("button", { name: "mobile.ts", exact: true }).first().click();
      assert.equal(await page.getByRole("complementary", { name: "Side panel", exact: true }).count(), 0);
    }
    await snap(page, `hub-code-${width}`);

    for (const route of ["/today", "/board", "/files", "/skills", "/metrics", "/settings"]) {
      await page.goto(`${WEB}${route}`);
      await page.locator("main h1").first().waitFor();
      if (route === "/board") await page.locator("[data-board-hscroll]").waitFor();
      await fits(page, `Hub ${route} ${width}`, "#main-content");
    }

    if (NODE) {
      await page.goto(`${NODE}/r/${fixture.roomId}`);
      const composer = page.getByRole("textbox", { name: /^Message Mobile/ });
      await composer.waitFor();
      await fits(page, `Node chat ${width}`, "main");
      await scrolls(page, '[aria-relevant="additions"]', "Node timeline");
      await page.locator('[aria-relevant="additions"]').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.getByRole("list", { name: "Answers", exact: true }).waitFor();
      const answerWidth = await page.getByRole("list", { name: "Answers", exact: true }).locator("button > span:nth-child(2)").first().evaluate(el => el.getBoundingClientRect().width);
      assert.ok(answerWidth >= 90, `Recommended answer stays readable, not a sliver: ${answerWidth}`);
      await composer.fill("A draft stays usable on a phone");
      const box = await composer.boundingBox();
      assert.ok(box && box.y + box.height <= 844, "Composer stays on screen");
      await page.getByRole("button", { name: /'s model:/ }).click();
      await page.getByRole("listbox").waitFor();
      await fits(page, `Node model picker ${width}`, "[role=listbox]");
      await page.keyboard.press("Escape");
      if (width < 768) {
        await page.setViewportSize({ width, height: 420 });
        await composer.focus();
        const shortBox = await composer.boundingBox();
        assert.ok(shortBox && shortBox.y + shortBox.height < 420, "Composer fits a short/keyboard-sized viewport");
        assert.equal(await composer.inputValue(), "A draft stays usable on a phone");
        assert.equal(await composer.evaluate(el => getComputedStyle(el).fontSize), "16px", "Typing does not trigger Safari's small-input zoom");
        await page.setViewportSize({ width, height: 844 });
      }
      await snap(page, `node-chat-${width}`);
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Chat settings", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await fits(page, `Node settings drawer ${width}`, "[role=dialog]");
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last().click();
      for (const route of ["/chat", "/computers", "/connections", "/requests", "/new", `/n/${fixture.nodeId}`, "/activity", "/settings"]) {
        await page.goto(`${NODE}${route}`);
        await page.locator("main h1").first().waitFor();
        await fits(page, `Node ${route} ${width}`, "main");
      }
    }
    console.log(`Mobile layout and interactions: ${width}px passed`);
    await context.close();
  }
  assert.deepEqual(errors, [], "Browser runtime errors");
} finally {
  await browser.close();
}
