/**
 * End-to-end flows against a running hub (mock model, no network keys).
 * Run: node apps/hub-web/e2e/assistant-trash-comments.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const EMAIL = process.env.ENSEMBLE_E2E_EMAIL ?? "prajwal@ensemble.local";
const PASSWORD = process.env.ENSEMBLE_E2E_PASSWORD ?? "ensemble-demo";
const ARTIFACTS = process.env.ENSEMBLE_ARTIFACTS ?? "/opt/cursor/artifacts/features";
const WORKSPACE = process.env.ENSEMBLE_WORKSPACE_ROOT ?? "/tmp/ensemble-workspace";
const stamp = Date.now().toString(36);

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`login did not set a session: ${list.join(" | ")}`);
  return pair[1];
}

async function login() {
  let response = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  let text = await response.text();
  let created = false;
  if (response.status === 401) {
    response = await fetch(`${API}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "E2E" }),
    });
    text = await response.text();
    if (response.status === 409) {
      response = await fetch(`${API}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      });
      text = await response.text();
    } else {
      created = response.ok;
    }
  }
  if (!response.ok) throw new Error(`login ${response.status}: ${text}`);
  const session = cookieHeader(typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : response.headers.get("set-cookie"));
  if (created) {
    const onboard = await fetch(`${API}/api/onboarding`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
      body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
    });
    if (!onboard.ok) throw new Error(`onboarding ${onboard.status}: ${await onboard.text()}`);
  }
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
    if (!response.ok) {
      const error = new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 400)}`);
      error.status = response.status;
      error.body = json;
      throw error;
    }
    return json;
  };
}

async function main() {
  console.log(`e2e login ${EMAIL} artifacts ${ARTIFACTS} workspace ${WORKSPACE}`);
  const session = await login();
  const api = client(session);
  await api("PATCH", "/api/settings", {
    assistant: { defaultTier: "medium", writePolicy: "preview" },
    completedVisible: 5,
    models: {
      easy: { provider: "mock", model: "mock", effort: "minimal" },
      medium: { provider: "mock", model: "mock", effort: "low" },
      high: { provider: "mock", model: "mock", effort: "medium" },
      max: { provider: "mock", model: "mock", effort: "high" },
    },
  });

  const project = (await api("POST", "/api/projects", { name: `e2e project ${stamp}` })).project;
  const person = (await api("POST", "/api/people", { name: `e2e person ${stamp}` })).person;
  const skill = (await api("POST", "/api/skills", { name: `e2e skill ${stamp}` })).skill;
  const repo = (await api("POST", "/api/repos", { fullName: `e2e/repo-${stamp}` })).repo;
  const deliverable = (await api("POST", "/api/deliverables", { title: `e2e deliverable ${stamp}`, projectId: project.id })).deliverable;
  const reminder = (await api("POST", "/api/reminders", { title: `e2e reminder ${stamp}`, dueDate: "2026-12-01", dueTime: "09:00" })).reminder;
  const task = (await api("POST", "/api/tasks", { title: `e2e task ${stamp}` })).task;
  const document = (
    await api("POST", "/api/documents", {
      filename: `e2e-${stamp}.txt`,
      mediaType: "text/plain",
      dataBase64: Buffer.from(`e2e document ${stamp}`).toString("base64"),
      summarize: false,
    })
  ).document;

  const created = [
    ["task", task.id, `/api/tasks/${task.id}`],
    ["project", project.id, `/api/projects/${project.id}`],
    ["person", person.id, `/api/people/${person.id}`],
    ["skill", skill.id, `/api/skills/${skill.id}`],
    ["repo", repo.id, `/api/repos/${repo.id}`],
    ["deliverable", deliverable.id, `/api/deliverables/${deliverable.id}`],
    ["reminder", reminder.id, `/api/reminders/${reminder.id}`],
    ["document", document.id, `/api/documents/${document.id}`],
  ];
  for (const [, , path] of created) await api("DELETE", path);

  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  await context.addCookies([
    { name: "ensemble_session", value: session, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
  await context.addInitScript(() => {
    localStorage.setItem("ensemble.assistant.open", "false");
    localStorage.setItem("ensemble.appearance", JSON.stringify({ theme: "dark" }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  await page.goto(`${WEB}/trash`, { waitUntil: "domcontentloaded" });
  async function restoreLabel(label) {
    const row = page.locator(".record-row").filter({ has: page.getByText(label, { exact: true }) });
    await row.getByRole("button", { name: "Restore", exact: true }).click();
    await page.waitForTimeout(150);
  }
  for (const label of [
    `e2e task ${stamp}`,
    `e2e project ${stamp}`,
    `e2e person ${stamp}`,
    `e2e skill ${stamp}`,
    `e2e deliverable ${stamp}`,
    `e2e reminder ${stamp}`,
    `e2e/repo-${stamp}`,
    `e2e-${stamp}.txt`,
  ]) {
    await restoreLabel(label);
  }
  await page.waitForTimeout(400);
  const trash = await api("GET", "/api/deleted");
  const lingering = (trash.items ?? []).filter((item) => String(item.label).includes(stamp));
  assert.equal(lingering.length, 0, `still in trash: ${JSON.stringify(lingering)}`);
  const projects = await api("GET", "/api/projects");
  assert.ok(projects.projects.some((row) => row.id === project.id));

  await api("PATCH", `/api/tasks/${task.id}`, { status: "todo" });
  const done = await api("PATCH", `/api/tasks/${task.id}`, { status: "done" });
  assert.equal(done.task.status, "done");
  await page.goto(`${WEB}/completed`, { waitUntil: "domcontentloaded" });
  await page.getByText(`e2e task ${stamp}`).waitFor();
  await page.getByRole("button", { name: "Reopen" }).first().click();
  await page.waitForTimeout(500);
  const reopened = await api("GET", `/api/tasks/${task.id}`);
  assert.notEqual(reopened.task.status, "done");
  await api("PATCH", "/api/settings", { completedVisible: 4 });
  const settings = await api("GET", "/api/settings");
  assert.equal(settings.settings.completedVisible, 4);
  await api("PATCH", "/api/settings", { completedVisible: 5 });

  const quote = `Discuss ${stamp}`;
  await api("PUT", `/api/tasks/${task.id}/page`, {
    revision: 0,
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: `${quote} before Friday.` }] }],
    },
  });
  await page.goto(`${WEB}/tasks/${task.id}`, { waitUntil: "domcontentloaded" });
  await page.getByText(quote).waitFor();
  await page.getByText("All changes saved").waitFor();
  const prose = page.locator(".ProseMirror").first();
  await prose.click({ position: { x: 12, y: 10 } });
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  let selected = false;
  for (let i = 0; i < quote.length * 3; i += 1) {
    await page.keyboard.press("ArrowRight");
    selected = await page.evaluate((prefix) => (window.getSelection()?.toString() ?? "").startsWith(prefix), quote);
    if (selected) break;
  }
  await page.keyboard.up("Shift");
  if (!selected) {
    const detail = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    throw new Error(`selection missed: ${JSON.stringify(detail)}`);
  }
  const commentButton = page.getByRole("button", { name: "Comment", exact: true });
  await commentButton.waitFor();
  await commentButton.click();
  const commentBox = page.getByRole("textbox", { name: "Comment" });
  await commentBox.fill(`Check the date ${stamp}.`);
  const posted = page.waitForResponse((res) => res.url().includes("/comments") && res.request().method() === "POST");
  await commentBox.locator("xpath=ancestor::form").getByRole("button", { name: "Comment", exact: true }).click();
  const createdComment = await posted;
  if (!createdComment.ok()) throw new Error(`comment create ${createdComment.status()} ${await createdComment.text()}`);
  await page.getByText(`Check the date ${stamp}.`).waitFor();
  const comments = await api("GET", `/api/pages/task/${task.id}/comments`);
  const mine = comments.comments.find((row) => !row.parentId && row.authorKind === "human" && String(row.quote || "").includes(stamp));
  assert.ok(mine, `anchored comment missing: ${JSON.stringify(comments.comments)}`);
  await page.getByRole("button", { name: "Edit" }).last().click();
  await page.getByLabel("Edit comment").fill(`Check the date ${stamp} carefully.`);
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText(`Check the date ${stamp} carefully.`).waitFor();
  await page.getByRole("button", { name: "Resolve" }).last().click();
  await page.getByRole("button", { name: "Reopen" }).last().waitFor();
  await prose.click();
  await page.keyboard.press("End");
  const savedPage = page.waitForResponse((res) => res.url().includes(`/api/tasks/${task.id}/page`) && res.request().method() === "PUT");
  await page.keyboard.type(" Extra sentence.");
  await savedPage;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Extra sentence.").waitFor();
  await page.getByText(`Check the date ${stamp} carefully.`).waitFor();
  const after = await api("GET", `/api/pages/task/${task.id}/comments`);
  const still = after.comments.find((row) => row.id === mine.id);
  assert.equal(still.markId, mine.markId);
  const pageBody = await api("GET", `/api/tasks/${task.id}/page`);
  const serialized = JSON.stringify(pageBody.content ?? pageBody);
  assert.match(serialized, new RegExp(mine.markId));

  let replyFailed = false;
  try {
    await api("POST", `/api/comments/${mine.id}/reply`, { body: { text: "no" } });
  } catch (error) {
    replyFailed = error.status === 400;
  }
  assert.equal(replyFailed, true);

  const ask = page.getByPlaceholder("@ensemble…").first();
  await ask.fill("[[fixture:clarify]] which deadline");
  await ask.press("Enter");
  await page.getByText("Which deadline should I use?").waitFor({ timeout: 20000 });

  await prose.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("@ensemble [[fixture:citation]] cite the rule");
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "Court rules" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Insert into page" }).waitFor();

  await page.getByRole("button", { name: "Ask Ensemble" }).click();
  await page.getByPlaceholder("Ask, or tell me what to change").waitFor();
  await page.getByPlaceholder("Ask, or tell me what to change").fill("[[fixture:create_task]] add the filing task");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("Nothing has changed yet").waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Send" }).waitFor();
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByText(/Applied|ready|Added|created/i).waitFor({ timeout: 15000 }).catch(() => undefined);
  const tasks = await api("GET", "/api/tasks");
  const list = tasks.tasks ?? tasks.items ?? [];
  assert.ok(list.some((row) => row.title === "File the response"), "Apply did not create the proposed task");

  await page.getByPlaceholder("Ask, or tell me what to change").fill("[[fixture:slow]] wait please");
  await page.getByRole("button", { name: "Send" }).click();
  const stop = page.getByLabel("Stop");
  await stop.waitFor();
  await stop.click();
  await page.getByText(/Stopped/).waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Close" }).click();
  await page.locator("article").filter({ hasText: `Check the date ${stamp} carefully.` }).getByRole("button", { name: "Delete" }).click();
  await page.waitForTimeout(500);
  const gone = await api("GET", `/api/pages/task/${task.id}/comments`);
  assert.equal(gone.comments.some((row) => row.id === mine.id), false);
  const trashed = await api("GET", "/api/deleted");
  assert.ok(trashed.items.some((item) => item.kind === "comment" && item.id === mine.id));
  await page.goto(`${WEB}/trash`, { waitUntil: "domcontentloaded" });
  await page.getByText(mine.quote, { exact: true }).waitFor();

  await browser.close();
  console.log("e2e ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
