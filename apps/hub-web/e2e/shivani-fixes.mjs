/**
 * Board column height, Plots after the Settings toggle, comment margin,
 * context lens, collapsed Jump to, and marketplace nested anchors.
 * Run: node apps/hub-web/e2e/shivani-fixes.mjs
 */
import assert from "node:assert/strict";
import { execSqlChanging, markTester } from "./sql-change.mjs";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const CHROME = process.env.CHROME_PATH ?? (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");
const OUT = process.env.FIX_SHOTS ?? "/opt/cursor/artifacts/fixes";

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
  return { status: response.status, text, json: () => JSON.parse(text || "null") };
}

async function shot(page, name) {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

async function columnFits(page, id) {
  return page.locator(`[data-column="${id}"] .board-column`).evaluate((column) => {
    const box = column.getBoundingClientRect();
    const cards = [...column.querySelectorAll("[data-bdg-card]")].map((node) => node.getBoundingClientRect());
    const add = [...column.querySelectorAll("button")].find((node) => (node.textContent || "").includes("New task"));
    const addBox = add ? add.getBoundingClientRect() : null;
    const last = cards.at(-1);
    const coversCards = !last || last.bottom <= box.bottom + 2;
    const coversAdd = !addBox || addBox.bottom <= box.bottom + 2;
    return {
      height: box.height,
      cards: cards.length,
      coversCards,
      coversAdd,
      tallerThanViewport: box.height > window.innerHeight,
    };
  });
}

async function signup(label) {
  const email = `${label}-${Date.now().toString(36)}@ensemble.test`;
  const response = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "fieldnote-relay", name: "Shivani" }),
  });
  if (!response.ok) throw new Error(`signup ${response.status}: ${await response.text()}`);
  const session = cookieHeader(typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : response.headers.get("set-cookie"));
  const onboard = await authed(session, "/api/onboarding", {
    method: "POST",
    body: JSON.stringify({ role: "lawyer", templateId: "matter-desk" }),
  });
  assert.equal(onboard.status, 200, onboard.text);
  const appearance = await authed(session, "/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ appearance: { theme: "dark", accent: "indigo", accentCustom: null } }),
  });
  assert.equal(appearance.status, 200, appearance.text);
  const safeEmail = email.replaceAll("'", "");
  const psql = process.env.DATABASE_URL ?? "postgresql://ensemble:ensemble@127.0.0.1:5432/ensemble";
  markTester(psql, safeEmail);
  execSqlChanging(
    psql,
    `INSERT INTO artifacts (id, user_id, kind, external_id, url, ts, title, text, metadata, authored_by_me)
     SELECT gen_random_uuid(), id, 'pr', 'e2e:pr-128', 'https://github.com/fieldnote/relay/pull/128', now(),
            'fieldnote/relay #128 · reuse the original signature', 'A pull request, not a task.', '{"source":"GitHub"}'::jsonb, false
     FROM users WHERE email = '${safeEmail}';`,
    "seed artifact",
  );
  return session;
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

try {
  const session = await signup("fixes");
  await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);

  for (let index = 0; index < 3; index += 1) {
    const created = await authed(session, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title: `Board card ${index + 1}`, status: "todo" }),
    });
    assert.equal(created.status, 201, created.text);
  }
  await page.goto(`${WEB}/board`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-column=todo] [data-bdg-card]").nth(2).waitFor();
  const three = await columnFits(page, "todo");
  assert.ok(three.cards >= 3, JSON.stringify(three));
  assert.equal(three.coversCards, true, JSON.stringify(three));
  assert.equal(three.coversAdd, true, JSON.stringify(three));
  assert.equal(three.tallerThanViewport, false, JSON.stringify(three));
  const empty = await columnFits(page, "done");
  assert.equal(empty.cards, 0, JSON.stringify(empty));
  assert.equal(empty.coversAdd, true, JSON.stringify(empty));
  assert.equal(empty.tallerThanViewport, false, JSON.stringify(empty));
  await shot(page, "board-3-cards");

  for (let index = 3; index < 15; index += 1) {
    const created = await authed(session, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title: `Board card ${index + 1}`, status: "todo" }),
    });
    assert.equal(created.status, 201, created.text);
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-column=todo] [data-bdg-card]").nth(14).waitFor();
  const many = await columnFits(page, "todo");
  assert.equal(many.cards, three.cards + 12, JSON.stringify(many));
  assert.equal(many.coversCards, true, JSON.stringify(many));
  assert.equal(many.coversAdd, true, JSON.stringify(many));
  assert.equal(many.tallerThanViewport, true, JSON.stringify(many));
  await shot(page, "board-15-cards");

  await page.goto(`${WEB}/settings`, { waitUntil: "domcontentloaded" });
  const plotsSwitch = page.getByRole("switch", { name: "Plots" });
  await plotsSwitch.waitFor();
  if ((await plotsSwitch.getAttribute("aria-checked")) !== "true") {
    const saved = page.waitForResponse((response) => response.url().includes("/api/settings/modules") && response.request().method() === "PUT");
    await plotsSwitch.click();
    const modules = await saved;
    assert.equal(modules.ok(), true, await modules.text());
  }
  await page.goto(`${WEB}/plots`, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-plot-canvas]").waitFor({ timeout: 20000 });
  assert.equal(await page.locator("[data-plot-error]").count(), 0);
  await shot(page, "plots-after-enable");

  const task = await authed(session, "/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "Comment host", status: "todo" }),
  });
  assert.equal(task.status, 201, task.text);
  const taskId = task.json().task.id;
  await page.goto(`${WEB}/tasks/${taskId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Comment on this page" }).waitFor();
  assert.equal(await page.locator(".comment-rail").count(), 0);
  assert.equal(await page.getByText("No comments on this page.").count(), 0);
  await shot(page, "page-no-comments");
  const comment = await authed(session, `/api/pages/task/${taskId}/comments`, {
    method: "POST",
    body: JSON.stringify({ quote: "Comment host", body: { text: "Margin note from the thread." } }),
  });
  assert.equal(comment.status, 201, comment.text);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-comment-bubble]").getByText("Margin note from the thread.").waitFor();
  assert.equal(await page.locator(".comment-rail").count(), 0);
  await shot(page, "page-with-comments");

  const person = await authed(session, "/api/people", {
    method: "POST",
    body: JSON.stringify({ name: "Samir Shah", email: "samir@fieldnote.dev", role: "Backend" }),
  });
  assert.equal(person.status, 201, person.text);
  const priya = await authed(session, "/api/people", {
    method: "POST",
    body: JSON.stringify({ name: "Priya Raman", email: "priya.raman@northwind.example", role: "Design partner" }),
  });
  assert.equal(priya.status, 201, priya.text);
  const decoy = await authed(session, "/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "Latency numbers for Priya", status: "todo" }),
  });
  assert.equal(decoy.status, 201, decoy.text);
  await page.goto(`${WEB}/context`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-context-lens=chambers]").waitFor();
  await page.getByRole("tab", { name: "People", exact: true }).click();
  await page.locator("[data-lens-people]").getByText("Samir Shah").waitFor();
  await page.locator("[data-lens-people]").getByText("Priya Raman").waitFor();
  await page.locator("[data-person-name='Sunita Rao']").waitFor();
  await page.locator("[data-person-name='Adv. Kavita Sen']").waitFor();
  await page.locator("[data-person-name='Suresh Yadav']").waitFor();
  assert.equal(await page.locator("[data-person-name='Client']").count(), 0);
  const rao = await page.locator("[data-person-name='Sunita Rao']").innerText();
  assert.match(rao, /Client/);
  assert.match(rao, /open/);
  await shot(page, "context-people");
  await page.getByRole("tab", { name: "Graph", exact: true }).click();
  await page.locator("[data-lens-graph] canvas").waitFor();
  await page.locator(".graph-count-full").waitFor();
  const graphCount = await page.locator(".graph-count-full").innerText();
  const graphNums = graphCount.match(/(\d+)\s+nodes?.*?(\d+)\s+links?/i);
  assert.ok(graphNums, graphCount);
  const graphNodes = Number(graphNums[1]);
  const graphLinks = Number(graphNums[2]);
  assert.ok(graphLinks >= graphNodes - 1, graphCount);
  assert.ok(graphLinks > 6, graphCount);
  const zoomText = await page.locator(".graph-zoom").innerText();
  const zoomMatch = zoomText.match(/(\d+)%/);
  assert.ok(zoomMatch, zoomText);
  assert.ok(Number(zoomMatch[1]) >= 80, zoomText);
  assert.equal(await page.locator("[data-lens-panel=graph]").getByText("Limitation", { exact: true }).count(), 0);
  const graphNames = await page.locator("[data-lens-graph] .sr-only").innerText();
  assert.match(graphNames, /Sunita Rao/);
  assert.match(graphNames, /Rao v\. Sunrise Hospital/);
  await shot(page, "context-graph");
  await page.getByRole("tab", { name: "Artifacts & sync" }).click();
  await page.locator("[data-lens-artifacts]").getByText("fieldnote/relay #128").waitFor();
  await page.locator("[data-lens-artifacts]").getByText("rao-sunrise #12").waitFor();
  const artifactText = await page.locator("[data-lens-panel=artifacts]").innerText();
  assert.equal(artifactText.includes("Latency numbers for Priya"), false, artifactText);
  assert.equal(artifactText.includes("Read the draft"), false, artifactText);
  assert.equal(artifactText.includes("List the dates"), false, artifactText);
  assert.match(artifactText, /Pull request/);
  assert.match(artifactText, /GitHub/);
  assert.match(artifactText, /File/);
  await shot(page, "context-artifacts");

  await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.waitForFunction(() => {
    const nodes = [...document.querySelectorAll(".sidebar-search")];
    return nodes.length > 0 && nodes.every((node) => node.getClientRects().length === 0);
  });
  await page.keyboard.press("Control+KeyK");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "hidden" });
  await shot(page, "sidebar-collapsed");

  consoleErrors.length = 0;
  await page.goto(`${WEB}/marketplace`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "A desk for the work you do" }).waitFor();
  await page.locator("[data-desk-mini]").first().waitFor();
  await page.locator("[data-desk-tile]").first().waitFor({ timeout: 15000 });
  await page.locator('[data-market-card="mkt.chambers"]').waitFor();
  await page.waitForTimeout(600);
  const nested = await page.locator("a a").count();
  assert.equal(nested, 0, `nested anchors: ${nested}`);
  const hydration = consoleErrors.filter((line) => /hydrat|nested|cannot be a descendant/i.test(line));
  assert.deepEqual(hydration, [], hydration.join("\n"));
  await shot(page, "marketplace");

  console.log("shivani-fixes e2e ok");
} finally {
  await browser.close();
}
