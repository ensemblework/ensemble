/**
 * Clicks through the desktop UI: the static hub-web export, served the way
 * the Tauri shell serves `ensemble://` (assets.rs), with the shell's injected
 * script (site.rs) pointing fetches at a real sidecar on PGlite.
 *
 * Needs `pnpm desktop:export` first. Browser: ENSEMBLE_E2E_BROWSER=webkit
 * (Tauri's engine on macOS and Linux) or chromium (WebView2's engine).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bootSidecar, git, makeSourceRepo, prepareAccount, sleep, startStubRuntime, TOKEN, type Sidecar } from "./e2e-harness.js";
import { startFakeHost } from "../remote/fake-host.js";
import { desktopInitScript } from "./shell-script.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const webDir = process.env.ENSEMBLE_WEB_DIR ?? join(repoRoot, "apps/hub-web/out");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

/** assets.rs `resolve`: the file, its index.html, the `_` placeholder for a dynamic route, then `lost/`. */
function resolveAsset(root: string, requestPath: string): string | null {
  let rel = decodeURIComponent(requestPath.split(/[?#]/)[0]!.replace(/^\/+/, ""));
  if (rel.split(/[/\\]/).includes("..")) return null;
  if (!rel) rel = "index.html";
  const isFile = (path: string) => existsSync(path) && statSync(path).isFile();
  const direct = normalize(join(root, rel));
  if (isFile(direct)) return direct;
  if (isFile(join(direct, "index.html"))) return join(direct, "index.html");
  const parts = rel.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length === 2 && isFile(join(root, parts[0]!, "_", "index.html"))) return join(root, parts[0]!, "_", "index.html");
  if (!rel.includes(".") && isFile(join(root, "lost", "index.html"))) return join(root, "lost", "index.html");
  return null;
}

async function serveExport(root: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const file = resolveAsset(root, req.url ?? "/");
    if (!file) {
      res.writeHead(404, { "content-type": "text/html" });
      return void res.end("This page is not in the Ensemble desktop bundle.");
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

async function launchBrowser() {
  const { chromium, webkit } = await import("playwright-core");
  const which = process.env.ENSEMBLE_E2E_BROWSER ?? "chromium";
  if (which === "webkit") return { name: "webkit", browser: await webkit.launch() };
  const executablePath = process.env.CHROME_PATH ?? (existsSync("/usr/local/bin/google-chrome") ? "/usr/local/bin/google-chrome" : undefined);
  return { name: "chromium", browser: await chromium.launch({ executablePath, args: ["--no-sandbox"] }) };
}

test("assign dialog → Needs me → review → accept → push, then Run again after a quit, clicked in the static export", { timeout: 600_000, skip: !existsSync(join(webDir, "index.html")) && "run pnpm desktop:export first" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-desktop-ui-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  const shots = process.env.ENSEMBLE_E2E_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const stub = await startStubRuntime();
  const site = await serveExport(webDir);
  const source = makeSourceRepo(root);
  const env = { HUB_WEB_ORIGIN: site.origin };
  let side: Sidecar = await bootSidecar(root, stub.url, env);
  const { name, browser } = await launchBrowser();
  const errors: string[] = [];
  const apiProblems: string[] = [];
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await context.addInitScript({ content: desktopInitScript(side.base, TOKEN) });
    const page = await context.newPage();
    page.on("response", (response) => {
      if (!response.url().startsWith(side.base)) return;
      const allowed = response.headers()["access-control-allow-origin"];
      if (response.status() >= 400 || allowed !== site.origin) apiProblems.push(`${response.status()} ${response.url()} allow-origin=${allowed}`);
    });
    page.on("pageerror", (error) => {
      // WebKit reports a fetch cancelled by a page change as a CORS failure; real CORS is checked on every response above.
      if (name === "webkit" && /^Fetch API cannot load .* due to access control checks\.$/m.test(error.stack ?? "")) return;
      errors.push(`${page.url()}: ${error.message}`);
    });
    return { context, page };
  };
  const shot = async (page: import("playwright-core").Page, label: string) => {
    if (shots) await page.screenshot({ path: join(shots, `${name}-${label}.png`) });
  };
  t.after(async () => {
    await browser.close();
    await side.stop("SIGKILL");
    await site.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  try {
    await prepareAccount(side);
    const title = "[edit] Change the greeting";
    const created = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title } });
    const taskId = created.body.task.id;

    let { context, page } = await open();
    await page.goto(`${site.origin}/tasks/${taskId}`);
    await page.getByRole("button", { name: "Agent does it" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /^Code on your computer\b/ }).click();
    await dialog.getByPlaceholder(/owner\/repo/).fill(source);
    if (process.platform !== "darwin") await dialog.getByTestId("not-sandboxed").waitFor();
    await dialog.getByRole("button", { name: "Run unattended" }).click();
    await dialog.getByRole("button", { name: "Review only" }).click();
    await assertText(dialog.getByTestId("assign-mode-help"), /Read-only/);
    await dialog.getByRole("button", { name: "Ask", exact: true }).click();
    await dialog.getByPlaceholder(/Run the test suite/).fill("Change the greeting in hello.txt.");
    await shot(page, "1-assign");
    await dialog.getByRole("button", { name: "Assign", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });

    await page.getByText("Needs you", { exact: true }).first().waitFor({ timeout: 60_000 });
    await page.goto(`${site.origin}/needs-me`);
    const card = page.getByTestId("ensemble-decision").filter({ hasText: "Which greeting?" });
    await card.waitFor({ timeout: 30_000 });
    await shot(page, "2-needs-me");
    await card.getByRole("button", { name: /world/ }).click();
    await card.waitFor({ state: "detached" });

    await page.goto(`${site.origin}/tasks/${taskId}`);
    const reviewLink = page.getByRole("link", { name: "Review changes" });
    await reviewLink.waitFor({ timeout: 60_000 });
    await reviewLink.click();
    await page.waitForURL(/\/code\/review/);
    await page.getByText("hello, world").first().waitFor({ timeout: 30_000 });
    await shot(page, "3-review");
    await page.getByRole("button", { name: "Accept all" }).click();
    await page.getByText("Reviewed", { exact: true }).waitFor();
    const push = page.getByRole("button", { name: /^Push ensemble\// });
    await push.click();
    await page.getByText(/Pushed ensemble\/.+ \(fast-forward\)/).waitFor();
    await shot(page, "4-pushed");
    const branches = git(source, "for-each-ref", "--format=%(refname:short)", "refs/heads/ensemble");
    assert.match(branches, /^ensemble\/[0-9a-f-]{36}\/edit-change-the-greeting$/);
    assert.equal(git(source, "show", `${branches}:hello.txt`), "hello, world");
    await context.close();

    // ── quit mid-run, relaunch, Run again from the task page ────────────
    const slowTitle = "[slow] Interrupted in the UI";
    const slow = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title: slowTitle } });
    const assigned = await side.api<{ jobId: string }>("/api/agent/assign", { json: { taskId: slow.body.task.id, kind: "code", provider: "openai", model: "stub-model" } });
    assert.equal(assigned.status, 201);
    while ((stub.calls.get(slowTitle) ?? 0) === 0) await sleep(200);
    await side.stop("SIGTERM");
    side = await bootSidecar(root, stub.url, env);
    ({ context, page } = await open());
    await page.goto(`${site.origin}/tasks/${slow.body.task.id}`);
    await page.getByText("Interrupted", { exact: true }).first().waitFor({ timeout: 30_000 });
    await page.getByText(/Ensemble quit while this was running/).waitFor();
    await shot(page, "5-interrupted");
    stub.fast.add(slowTitle);
    await page.getByRole("button", { name: "Run again" }).first().click();
    await page.getByText("Done", { exact: true }).first().waitFor({ timeout: 60_000 });
    await context.close();

    assert.deepEqual(errors, [], "no uncaught page errors");
    assert.deepEqual(apiProblems, [], "every API response is a success the page's origin may read");
  } catch (error) {
    console.error(side.logs().slice(-4000));
    throw error;
  }
});

test("pairing and the remote-task switch, in WebKit and Chromium", { timeout: 600_000, skip: !existsSync(join(webDir, "index.html")) && "run pnpm desktop:export first" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-remote-ui-"));
  const stub = await startStubRuntime();
  const host = await startFakeHost({ leaseMs: 8_000, sweepMs: 400 });
  const site = await serveExport(webDir);
  let side = await bootSidecar(root, stub.url, {
    HUB_WEB_ORIGIN: site.origin,
    ENSEMBLE_REMOTE_API: host.origin,
    ENSEMBLE_REMOTE_HEARTBEAT_MS: "400",
    ENSEMBLE_REMOTE_POLL_MS: "400",
    ENSEMBLE_REMOTE_SYNC_MS: "400",
  });
  const browsers: Array<{ name: string; browser: import("playwright-core").Browser }> = [];
  t.after(async () => {
    await Promise.all(browsers.map((entry) => entry.browser.close()));
    await side.stop("SIGKILL");
    await site.close();
    await host.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });
  const { chromium, webkit } = await import("playwright-core");
  const chrome = process.env.CHROME_PATH ?? (existsSync("/usr/local/bin/google-chrome") ? "/usr/local/bin/google-chrome" : undefined);
  browsers.push({ name: "webkit", browser: await webkit.launch() });
  browsers.push({ name: "chromium", browser: await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] }) });
  try {
    for (const { name, browser } of browsers) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript({ content: desktopInitScript(side.base, TOKEN) });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => {
        if (name === "webkit" && /^Fetch API cannot load .* due to access control checks\.$/m.test(error.stack ?? "")) return;
        pageErrors.push(error.message);
      });
      await page.goto(`${site.origin}/settings#this-mac`);
      const status = page.getByTestId("remote-status");
      await status.waitFor({ timeout: 30_000 });
      await page.getByTestId("remote-url").fill(host.origin);
      await page.getByTestId("remote-code").fill("paircode");
      await page.getByTestId("remote-pair").click();
      await status.getByText("Remote tasks are off").waitFor({ timeout: 20_000 });
      await page.getByRole("switch", { name: "Allow remote tasks" }).click();
      await page.locator('[data-testid="remote-online"][data-online="yes"]').waitFor({ timeout: 20_000 });
      host.revoke();
      await status.getByText("Removed from Ensemble on the web. Pair again to keep running remote tasks.").waitFor({ timeout: 20_000 });
      assert.deepEqual(pageErrors, [], `${name} page errors`);
      await context.close();
      const repaired = await side.api("/api/remote/pair", { json: { apiBase: host.origin, code: host.code } });
      assert.equal(repaired.status, 200, `${name} re-pair ${JSON.stringify(repaired.body)}`);
    }
  } catch (error) {
    console.error(side.logs().slice(-4000));
    throw error;
  }
});

test("a board card opens in the side peek without a reload, then as a full page, in WebKit and Chromium", { timeout: 300_000, skip: !existsSync(join(webDir, "index.html")) && "run pnpm desktop:export first" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-board-ui-"));
  const shots = process.env.ENSEMBLE_E2E_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const stub = await startStubRuntime();
  const site = await serveExport(webDir);
  const side = await bootSidecar(root, stub.url, { HUB_WEB_ORIGIN: site.origin });
  const browsers: Array<{ name: string; browser: import("playwright-core").Browser }> = [];
  t.after(async () => {
    await Promise.all(browsers.map((entry) => entry.browser.close()));
    await side.stop("SIGKILL");
    await site.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });
  const { chromium, webkit } = await import("playwright-core");
  const chrome = process.env.CHROME_PATH ?? (existsSync("/usr/local/bin/google-chrome") ? "/usr/local/bin/google-chrome" : undefined);
  browsers.push({ name: "webkit", browser: await webkit.launch() });
  browsers.push({ name: "chromium", browser: await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] }) });
  try {
    await prepareAccount(side);
    for (const { name, browser } of browsers) {
      const title = `Board page in ${name}`;
      const created = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title, status: "todo", owner: "me" } });
      const taskId = created.body.task.id;
      const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      await context.addInitScript({ content: desktopInitScript(side.base, TOKEN) });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => {
        if (name === "webkit" && /^Fetch API cannot load .* due to access control checks\.$/m.test(error.stack ?? "")) return;
        pageErrors.push(error.message);
      });
      await page.goto(`${site.origin}/board/`);
      const card = page.locator(`[data-bdg-card][data-id="${taskId}"]`);
      await card.waitFor({ timeout: 30_000 });
      // A full page load clears this. Next's router must open the peek in place.
      await page.evaluate('window.__boardMarker = "kept"');
      await card.click();
      await page.waitForURL((url) => url.searchParams.get("peek") === taskId, { timeout: 15_000 });
      const peek = page.locator('[data-peek-kind="task"]');
      await peek.waitFor({ timeout: 20_000 });
      await waitForTitle(page, '[data-peek-kind="task"] textarea', title);
      assert.equal(await page.evaluate("window.__boardMarker"), "kept", `${name}: opening a card reloaded the page`);
      if (shots) await page.screenshot({ path: join(shots, `${name}-board-peek.png`) });

      await peek.getByTitle("Open as full page").click();
      await page.waitForURL((url) => url.pathname.replace(/\/$/, "") === `/tasks/${taskId}` && !url.searchParams.has("peek"), { timeout: 20_000 });
      await waitForTitle(page, "textarea", title);
      assert.equal(await page.locator('[data-peek-kind="task"]').count(), 0, `${name}: the full page still shows the peek`);
      if (shots) await page.screenshot({ path: join(shots, `${name}-task-page.png`) });
      assert.deepEqual(pageErrors, [], `${name} page errors`);
      await context.close();
    }
  } catch (error) {
    console.error(side.logs().slice(-4000));
    throw error;
  }
});

/** The task page's title is a textarea, so match its value rather than its text. */
async function waitForTitle(page: import("playwright-core").Page, selector: string, title: string) {
  // A string, because this package's tsconfig has no DOM types.
  await page.waitForFunction(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].some((node) => node.value === ${JSON.stringify(title)})`,
    undefined,
    { timeout: 20_000 },
  );
}

async function assertText(locator: import("playwright-core").Locator, pattern: RegExp) {
  await locator.waitFor();
  assert.match((await locator.textContent()) ?? "", pattern);
}
