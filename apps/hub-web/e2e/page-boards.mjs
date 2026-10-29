/**
 * Custom boards, page membership, collapsed Pages groups and stable comment geometry.
 * Run against a local test instance: node apps/hub-web/e2e/page-boards.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const signup = await fetch(`${API}/api/auth/signup`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `page-boards-${Date.now()}@ensemble.test`, password: "board-browser-pass-1", name: "Board test" }),
});
assert.ok(signup.ok, await signup.clone().text());
const cookies = signup.headers.getSetCookie().join(";");
const session = cookies.match(/ensemble_session=([^;]+)/)?.[1];
assert.ok(session);
async function api(path, method = "GET", body) {
  const response = await fetch(`${API}${path}`, {
    method, headers: { cookie: `ensemble_session=${session}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
await api("/api/onboarding", "POST", { role: "engineer", templateId: "branch-desk" });
const independent = (await api("/api/pages", "POST", {})).page;
await api(`/api/pages/${independent.id}`, "PATCH", { title: "Independent journal" });
const paragraph = "A long paragraph should keep its original line breaks, readable width and formatting when someone adds a comment. ".repeat(8).trim();
const doc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Experiment notes" }] },
    { type: "paragraph", content: [{ type: "text", text: "Control group. ", marks: [{ type: "bold" }] }, { type: "text", text: paragraph }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Results" }] },
    { type: "paragraph", content: [{ type: "text", text: "This section must not move when a comment opens." }] },
  ],
};
const task = (await api("/api/tasks", "POST", { title: "Comment layout in a peek", status: "blocked" })).task;
await api(`/api/tasks/${task.id}/page`, "PUT", { revision: 0, content: doc });
await api("/api/tasks", "POST", { title: "Waiting for approval", status: "waiting_approval" });

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);

async function addComment(editor) {
  const paragraph = editor.locator("p").first();
  await paragraph.scrollIntoViewIfNeeded();
  await paragraph.click();
  const before = await paragraph.boundingBox();
  await paragraph.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.waitForTimeout(80);
  await page.keyboard.press("Control+Shift+m");
  const draft = page.getByRole("dialog", { name: "New comment", exact: true });
  await draft.waitFor();
  await draft.getByRole("textbox", { name: "Comment", exact: true }).fill("Keep the formatting intact.");
  await draft.getByRole("button", { name: "Comment", exact: true }).click();
  const thread = page.getByRole("dialog", { name: "Comment", exact: true });
  await thread.waitFor();
  const after = await paragraph.boundingBox();
  for (const dimension of ["width", "height", "x"]) assert.ok(Math.abs(before[dimension] - after[dimension]) < 1, `${dimension} changed after adding a comment: ${JSON.stringify({ before, after })}`);
  assert.equal(await thread.locator(".comment-quote").evaluate((node) => getComputedStyle(node).webkitLineClamp), "2");
  const box = await thread.boundingBox(), viewport = page.viewportSize();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, "thread stays in the viewport");
  if (process.env.EVIDENCE) await page.screenshot({ path: `${process.env.EVIDENCE}.comment.png` });
  await thread.getByRole("button", { name: "Close comment", exact: true }).click();
  await page.waitForTimeout(100);
  const closed = await paragraph.boundingBox();
  assert.ok(Math.abs(before.width - closed.width) < 1 && Math.abs(before.height - closed.height) < 1);
}

try {
  await page.goto(`${WEB}/board`);
  await page.locator('[data-column="in_progress"]').getByText("Waiting for approval", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-column="waiting"]').count(), 0);
  assert.equal(await page.getByText("Builder workspace", { exact: true }).count(), 0);
  await page.getByRole("button", { name: /^Ensemble board/ }).click();
  assert.equal(await page.locator('[data-board-hscroll]').count(), 0);
  await page.getByRole("button", { name: "New board", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "A board for your work" });
  await settings.getByLabel("Board name").fill("Research");
  await settings.getByLabel("Column 2 name", { exact: true }).fill("On-going experiments");
  await settings.getByRole("button", { name: "Create board", exact: true }).click();
  await page.waitForURL(/board\?board=/);
  await page.getByRole("heading", { name: "Research", exact: true }).waitFor();
  const boardId = new URL(page.url()).searchParams.get("board");
  await page.getByRole("button", { name: "New page in On-going experiments", exact: true }).click();
  // A new page opens in the side peek, title first, like a new task on the Ensemble board.
  await page.waitForURL(/[?&]peek=.*kind=page/);
  const pageId = new URL(page.url()).searchParams.get("peek");
  await page.locator("[data-peek-kind=page] .ProseMirror").waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Page title");
  const record = await api(`/api/pages/${pageId}`);
  await api(`/api/pages/${pageId}`, "PATCH", { title: "Control group notes" });
  await api(`/api/pages/${pageId}`, "PUT", { revision: record.revision, content: doc });
  await page.reload();
  await page.locator(".ProseMirror p").first().waitFor();
  await addComment(page.locator(".ProseMirror"));
  await page.getByRole("button", { name: "Assign page to board", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Where does this page belong?" });
  await picker.getByLabel("Board column", { exact: true }).selectOption({ label: "Done" });
  await picker.getByRole("button", { name: "Move page", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  await page.goto(`${WEB}/board?board=${boardId}`);
  await page.getByRole("region", { name: "Done", exact: true }).getByText("Control group notes", { exact: true }).waitFor();
  const donut = page.getByRole("img", { name: /On-going experiments: 0.*Done: 1/ });
  await donut.waitFor();
  // The card is the Ensemble board's: the whole card moves, its trash button shows on hover, a click opens the peek.
  const card = page.locator("[data-bdg-card]", { hasText: "Control group notes" });
  await card.hover();
  await card.getByRole("button", { name: "Delete Control group notes", exact: true }).waitFor();
  assert.equal(await card.locator("a").count(), 0, "a card opens the peek, not the Pages tab");
  await card.focus();
  await page.keyboard.press("Space", { delay: 100 });
  await page.keyboard.press("ArrowLeft");
  await page.locator('[role=region][aria-label="On-going experiments"] [data-bdg-list][data-over]').waitFor();
  await page.keyboard.press("Space");
  await page.getByRole("region", { name: "On-going experiments", exact: true }).getByText("Control group notes", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("region", { name: "On-going experiments", exact: true }).getByText("Control group notes", { exact: true }).waitFor();
  await page.getByRole("region", { name: "On-going experiments", exact: true }).getByText("Control group notes", { exact: true }).click();
  await page.waitForURL(/[?&]peek=.*kind=page/);
  assert.match(new URL(page.url()).pathname, /^\/board/, "the page opens beside the board");
  if (process.env.EVIDENCE) await page.screenshot({ path: `${process.env.EVIDENCE}.board.png` });
  await page.goto(`${WEB}/pages`);
  await page.getByRole("link", { name: /Independent journal/ }).first().waitFor();
  const research = page.locator("details").filter({ hasText: "Research" });
  assert.equal(await research.getAttribute("open"), null, "board group starts collapsed");
  await research.locator("summary").click();
  await research.getByRole("link", { name: /Control group notes/ }).waitFor();
  await page.getByRole("searchbox", { name: "Search pages" }).fill("Control");
  await research.getByRole("link", { name: /Control group notes/ }).waitFor();
  await page.goto(`${WEB}/pages/${pageId}`);
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const closePages = page.getByRole("button", { name: "Close pages browser", exact: true });
    if (await closePages.isVisible()) await closePages.click();
    await page.locator(".comment-marker").first().waitFor();
    const text = page.locator(".ProseMirror p").first();
    await text.scrollIntoViewIfNeeded();
    const before = await text.boundingBox();
    await page.locator(".comment-marker").first().click();
    const thread = page.getByRole("dialog", { name: "Comment", exact: true });
    await thread.waitFor();
    const after = await text.boundingBox(), box = await thread.boundingBox();
    assert.ok(Math.abs(before.width - after.width) < 1 && Math.abs(before.height - after.height) < 1, `stable text at ${width}px`);
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 1001, `thread fits at ${width}px`);
    await page.keyboard.press("Escape");
    await thread.waitFor({ state: "hidden" });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${WEB}/board`);
  await page.getByRole("button", { name: /^Ensemble board/ }).click();
  await page.locator('[data-column="in_progress"]').getByText("Comment layout in a peek", { exact: true }).click();
  await page.locator("[data-peek-kind=task] .ProseMirror").waitFor();
  await addComment(page.locator(".ProseMirror").last());
  assert.deepEqual(errors, [], "no browser errors");
  console.log("Custom board creation, assignment, scoped charts, collapsed page groups and stable full-page/mobile/peek comments passed.");
} catch (error) {
  console.error("Browser route:", page.url(), "Errors:", errors);
  if (process.env.EVIDENCE) await page.screenshot({ path: process.env.EVIDENCE, fullPage: true });
  throw error;
} finally {
  await browser.close();
}
