/**
 * Shivani's four UI fixes: palette scroll, search focus ring, resize handle, mono editor font.
 *
 * Run: node apps/hub-web/e2e/shivani-ui.mjs
 * Screenshots: SHIVANI_ARTIFACTS=/opt/cursor/artifacts/shivani-fixes/after
 * Font reloads: SHIVANI_FONT_LOOPS=20
 * WebKit: SHIVANI_BROWSER=webkit
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, webkit } from "playwright-core";

const exec = promisify(execFile);
const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const OUT = process.env.SHIVANI_ARTIFACTS ?? "/opt/cursor/artifacts/shivani-fixes";
const FONT_LOOPS = Number(process.env.SHIVANI_FONT_LOOPS ?? "20");
const CHROME =
  process.env.CHROME_PATH ??
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");

const DIAGRAM_SOURCE = [
  "title First-week path",
  "direction down",
  "",
  'node clone "Clone the sample with a deliberately long label so the wrap depends on the face" shape rectangle',
  'node task "File one task" shape rectangle',
  'node mention "Mention Priya" shape rectangle',
  "edge clone > task",
  "edge task > mention",
].join("\n");

function expandHome(input) {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
  return input;
}

function workspaceRoot() {
  const fromEnv = process.env.ENSEMBLE_WORKSPACE_ROOT;
  if (fromEnv) return expandHome(fromEnv);
  try {
    const text = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
    const line = text.split("\n").find((row) => row.startsWith("ENSEMBLE_WORKSPACE_ROOT="));
    if (line) return expandHome(line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, ""));
  } catch {
    /* demo default */
  }
  return join(homedir(), "ensemble-workspace");
}

/**
 * Hide the system JetBrains face, and publish a proportional font named Arial.
 * next/font's automatic fallback is local("Arial"). On a machine that already
 * has JetBrains Mono installed, that is the only way to see the proportional face.
 */
const FONTCONFIG = "/tmp/shivani-no-jetbrains.conf";
const ARIAL_DIR = "/tmp/shivani-fonts";
try {
  execFileSync("python3", ["-c", `
from pathlib import Path
from fontTools.ttLib import TTFont
src = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
out = Path("${ARIAL_DIR}")
out.mkdir(parents=True, exist_ok=True)
font = TTFont(src)
name = font["name"]
for rec in list(name.names):
    if rec.nameID in (1, 4, 6, 16):
        name.setName("Arial", rec.nameID, rec.platformID, rec.platEncID, rec.langID)
font.save(out / "Arial.ttf")
`], { stdio: "ignore" });
} catch {
  /* The check still runs; without this face the fallback is invisible on Linux. */
}
writeFileSync(
  FONTCONFIG,
  `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${ARIAL_DIR}</dir>
  <selectfont>
    <rejectfont>
      <pattern><patelt name="family"><string>JetBrains Mono</string></patelt></pattern>
    </rejectfont>
  </selectfont>
</fontconfig>
`,
);

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
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) };
}

function monoProbe(root) {
  const node = root.querySelector?.(".cm-content") ?? root;
  const cs = getComputedStyle(node);
  const bodyCs = getComputedStyle(document.body);
  const measure = (family, text) => {
    const span = document.createElement("span");
    span.textContent = text;
    span.style.position = "fixed";
    span.style.left = "-9999px";
    span.style.whiteSpace = "pre";
    span.style.fontStyle = cs.fontStyle;
    span.style.fontWeight = cs.fontWeight;
    span.style.fontSize = cs.fontSize;
    span.style.fontFamily = family;
    document.body.appendChild(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    return width;
  };
  const narrow = measure(cs.fontFamily, "iiiiii");
  const wide = measure(cs.fontFamily, "MMMMMM");
  const line = root.querySelector?.(".cm-line") ?? document.querySelector(".cm-line");
  const gutter = root.querySelector?.(".cm-gutterElement") ?? document.querySelector(".cm-gutterElement");
  const lineBox = line?.getBoundingClientRect();
  const gutterBox = gutter?.getBoundingClientRect();
  return {
    family: cs.fontFamily,
    body: bodyCs.fontFamily,
    mono: Math.abs(narrow - wide) < 1.25,
    widthDelta: Math.abs(narrow - wide),
    sameAsBody: cs.fontFamily === bodyCs.fontFamily,
    align: lineBox && gutterBox ? Math.abs(lineBox.top - gutterBox.top) : null,
    lines: (root.querySelectorAll?.(".cm-line") ?? []).length,
  };
}

async function shoot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function readField(page, locator) {
  await locator.click();
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    const field = el.closest(".sq-field, .tile") || el;
    const fieldCs = getComputedStyle(field);
    const fieldRect = field.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const mirror = document.createElement("span");
    mirror.textContent = (el.value || el.getAttribute("placeholder") || "Ag").slice(0, 32);
    mirror.style.cssText = `position:fixed;left:-9999px;top:0;visibility:hidden;white-space:pre;margin:0;padding:0;border:0;font:${cs.font};line-height:${cs.lineHeight};`;
    document.body.appendChild(mirror);
    const lineH = mirror.getBoundingClientRect().height;
    mirror.remove();
    const borderTop = parseFloat(cs.borderTopWidth) || 0;
    const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const contentTop = rect.top + borderTop + padTop;
    const contentH = rect.height - borderTop - borderBottom - padTop - padBottom;
    const appearance = cs.appearance || cs.webkitAppearance;
    const topAligned = el.tagName === "TEXTAREA" || appearance === "none";
    const lineTop = topAligned ? contentTop : contentTop + Math.max(0, (contentH - lineH) / 2);
    const textMid = lineTop + lineH / 2;
    const fieldMid = fieldRect.top + fieldRect.height / 2;
    const icon = field.querySelector(".sq-ic, svg, button");
    const iconRect = icon ? icon.getBoundingClientRect() : null;
    const iconMid = iconRect && iconRect.height > 0 ? iconRect.top + iconRect.height / 2 : null;
    return {
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      inputShadow: cs.boxShadow,
      boxSizing: cs.boxSizing,
      lineHeight: cs.lineHeight,
      paddingTop: cs.paddingTop,
      paddingBottom: cs.paddingBottom,
      fieldBorder: fieldCs.borderTopColor,
      fieldShadow: fieldCs.boxShadow,
      fieldBorderW: parseFloat(fieldCs.borderTopWidth) || 0,
      textDelta: Math.abs(textMid - fieldMid),
      iconDelta: iconMid == null ? null : Math.abs(textMid - iconMid),
    };
  });
}

function fieldOk(reading) {
  const inputClear = (reading.outlineStyle === "none" || reading.outlineWidth === "0px") && reading.inputShadow === "none";
  const outer = reading.fieldShadow !== "none" || reading.fieldBorderW >= 1;
  const centred = reading.textDelta <= 1.25 && (reading.iconDelta == null || reading.iconDelta <= 1.25);
  return inputClear && outer && centred;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const engine = process.env.SHIVANI_BROWSER === "webkit" ? "webkit" : "chromium";
  const launchEnv = { ...process.env, FONTCONFIG_FILE: FONTCONFIG };
  const browser =
    engine === "webkit"
      ? await webkit.launch({ headless: true, env: launchEnv })
      : await chromium.launch({
          executablePath: CHROME,
          headless: true,
          env: launchEnv,
          args: ["--no-sandbox", "--disk-cache-size=1"],
        });

  const email = `shivani-${Date.now().toString(36)}@ensemble.test`;
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "shivani-pass-1", name: "Shivani" }),
  });
  if (!signup.ok) throw new Error(`signup ${signup.status}: ${await signup.text()}`);
  const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
  const onboard = await authed(session, "/api/onboarding", {
    method: "POST",
    body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
  });
  assert.equal(onboard.status, 200, onboard.text);
  const task = await authed(session, "/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "Resize the page", status: "todo" }),
  });
  assert.equal(task.status, 201, task.text);
  const taskId = task.json().task.id;
  const diagram = await authed(session, "/api/diagrams", {
    method: "POST",
    body: JSON.stringify({ title: "First-week path", source: DIAGRAM_SOURCE }),
  });
  assert.equal(diagram.status, 201, diagram.text);
  const diagramId = diagram.json().diagram.id;

  const repo = `${workspaceRoot()}/shivani-font-${Date.now().toString(36)}`;
  await mkdir(repo, { recursive: true });
  await exec("git", ["init"], { cwd: repo });
  await exec("git", ["config", "user.email", "e2e@ensemble.local"], { cwd: repo });
  await exec("git", ["config", "user.name", "e2e"], { cwd: repo });
  await writeFile(`${repo}/line.ts`, "const answer = 1;\n");
  await exec("git", ["add", "line.ts"], { cwd: repo });
  await exec("git", ["commit", "-m", "init"], { cwd: repo });
  await writeFile(`${repo}/line.ts`, "const answer = 1;\nconst answer = ".padEnd(120, "x") + ";\n");

  const failures = [];
  const note = (label, error) => {
    failures.push(`${label}: ${error instanceof Error ? error.message : error}`);
    console.error("FAIL", label, error instanceof Error ? error.message : error);
  };

  async function contextFor(viewport, theme) {
    const context = await browser.newContext({
      viewport,
      colorScheme: theme,
    });
    await context.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
    await context.addInitScript((next) => {
      localStorage.setItem("ensemble.appearance", JSON.stringify({ theme: next, accent: "iris" }));
    }, theme);
    return context;
  }

  const shots = [
    { width: 1440, height: 900, theme: "dark" },
    { width: 1440, height: 900, theme: "light" },
    { width: 1024, height: 640, theme: "dark" },
    { width: 1024, height: 640, theme: "light" },
    { width: 390, height: 844, theme: "dark" },
  ];

  for (const shot of shots) {
    const context = await contextFor({ width: shot.width, height: shot.height }, shot.theme);
    const page = await context.newPage();
    const tag = `${shot.theme}-${shot.width}x${shot.height}`;
    try {
      await page.goto(`${WEB}/today`, { waitUntil: "load" });
      await page.getByRole("button", { name: "Toggle sidebar" }).waitFor();
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, shot.theme);
      const dialog = page.getByRole("dialog", { name: "Command palette" });
      let opened = false;
      for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
        await page.keyboard.press("Control+k");
        opened = await dialog.waitFor({ timeout: 2500 }).then(() => true).catch(() => false);
      }
      if (!opened) throw new Error("palette did not open");
      const panel = dialog.locator(".sq").first();
      const list = page.locator("#command-list");
      await list.locator("[role=option]").first().waitFor();
      const geometry = await page.evaluate(() => {
        const panel = document.querySelector('[role="dialog"] .sq');
        const list = document.getElementById("command-list");
        const options = [...document.querySelectorAll("#command-list [role=option]")];
        const panelBox = panel.getBoundingClientRect();
        const listBox = list.getBoundingClientRect();
        const last = options[options.length - 1]?.getBoundingClientRect();
        const style = getComputedStyle(list);
        return {
          count: options.length,
          panelBottom: panelBox.bottom,
          panelTop: panelBox.top,
          listBottom: listBox.bottom,
          listClient: list.clientHeight,
          listScroll: list.scrollHeight,
          overflowY: style.overflowY,
          lastBottom: last?.bottom ?? 0,
          vh: window.innerHeight,
        };
      });
      await shoot(page, `palette-${tag}`);
      const listInside = geometry.listBottom <= geometry.panelBottom + 1 && geometry.panelBottom <= geometry.vh - 8;
      const overflows = geometry.listScroll > geometry.listClient + 2;
      const reachable = !overflows || ["auto", "scroll"].includes(geometry.overflowY);
      const inside = listInside && reachable;
      if (!(inside && reachable)) {
        throw new Error(`palette overflow ${tag} ${JSON.stringify(geometry)}`);
      }
      const jumps = Math.min(24, geometry.count - 1);
      for (let step = 0; step < jumps; step += 1) await page.keyboard.press("ArrowDown");
      const visible = await page.evaluate(() => {
        const list = document.getElementById("command-list");
        const selected = list.querySelector('[aria-selected="true"]');
        const listBox = list.getBoundingClientRect();
        const row = selected.getBoundingClientRect();
        return row.top >= listBox.top - 1 && row.bottom <= listBox.bottom + 1;
      });
      if (!visible) throw new Error(`selected row left the list at ${tag}`);
      console.log("ok palette", tag, "results", geometry.count, "scroll", geometry.listScroll, "client", geometry.listClient);
    } catch (error) {
      note(`palette ${tag}`, error);
    }

    try {
      await page.keyboard.press("Escape");
      const ask = page.getByRole("searchbox", { name: "Ask Ensemble" }).first();
      await ask.waitFor();
      const askRing = await readField(page, ask);
      await shoot(page, `search-ask-${tag}`);
      if (!fieldOk(askRing)) throw new Error(`ask ring ${tag} ${JSON.stringify(askRing)}`);

      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog", { name: "Command palette" });
      await dialog.waitFor();
      const paletteInput = dialog.getByRole("searchbox", { name: "Jump to a page or task" });
      const paletteRing = await readField(page, paletteInput);
      await shoot(page, `search-palette-${tag}`);
      if (!fieldOk(paletteRing)) throw new Error(`palette ring ${tag} ${JSON.stringify(paletteRing)}`);
      console.log("ok search", tag, "askΔ", askRing.textDelta.toFixed(2), "paletteΔ", paletteRing.textDelta.toFixed(2));
    } catch (error) {
      note(`search ${tag}`, error);
    }

    if (shot.width >= 1024) {
      try {
        await page.goto(`${WEB}/board?peek=${taskId}`, { waitUntil: "domcontentloaded" });
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, shot.theme);
        const handle = page.getByRole("separator", { name: "Page width" });
        await handle.waitFor();
        await handle.hover();
        const metrics = await handle.evaluate((el) => {
          const line = el.querySelector("[data-resize-line]") ?? el.firstElementChild;
          const handleBox = el.getBoundingClientRect();
          const lineBox = line.getBoundingClientRect();
          return {
            handleW: handleBox.width,
            lineW: lineBox.width,
            cursor: getComputedStyle(el).cursor,
            touch: getComputedStyle(el).touchAction,
          };
        });
        await shoot(page, `resize-${tag}`);
        if (metrics.cursor !== "col-resize") throw new Error(`cursor ${metrics.cursor}`);
        if (metrics.handleW < 8 || metrics.handleW > 12) throw new Error(`hit area ${metrics.handleW}`);
        if (metrics.lineW < 1.5 || metrics.lineW > 3) throw new Error(`line ${metrics.lineW}`);
        await handle.focus();
        const before = await handle.getAttribute("aria-valuenow");
        await page.keyboard.press("ArrowLeft");
        const after = await handle.getAttribute("aria-valuenow");
        if (before === after) throw new Error("arrow key did not resize");
        console.log("ok resize", tag, metrics);
      } catch (error) {
        note(`resize ${tag}`, error);
      }
    }
    if (shot.width === 1440 && shot.theme === "dark") {
      try {
        const targets = [
          { name: "board", url: `${WEB}/board`, locate: (p) => p.getByRole("searchbox", { name: "Search tasks" }) },
          { name: "context", url: `${WEB}/context?view=board`, locate: (p) => p.getByRole("textbox", { name: "Filter context" }) },
          { name: "people", url: `${WEB}/context?view=widgets&tab=people`, locate: (p) => p.getByPlaceholder("Filter people…") },
          { name: "artifacts", url: `${WEB}/context?view=widgets&tab=artifacts`, locate: (p) => p.getByPlaceholder("Search uploaded filenames") },
          { name: "marketplace", url: `${WEB}/marketplace`, locate: (p) => p.getByRole("textbox", { name: "Search templates" }) },
          { name: "skills", url: `${WEB}/skills`, locate: (p) => p.getByPlaceholder("Search skills…") },
          { name: "diagrams", url: `${WEB}/diagrams`, locate: (p) => p.getByRole("textbox", { name: "Search diagrams" }) },
          { name: "meetings", url: `${WEB}/meetings`, locate: (p) => p.getByRole("textbox", { name: "Summarize across meetings" }) },
        ];
        const misses = [];
        for (const target of targets) {
          try {
            await page.goto(target.url, { waitUntil: "domcontentloaded" });
            const field = target.locate(page);
            const gated = page.getByRole("heading", { name: "This isn't part of your template." });
            await field.or(gated).first().waitFor({ timeout: 20_000 });
            if (await gated.isVisible().catch(() => false)) {
              console.log("skip", target.name, "(template gate, search not mounted)");
              continue;
            }
            const reading = await readField(page, field);
            if (target.name === "board" || target.name === "context" || target.name === "marketplace") await shoot(page, `search-${target.name}-${tag}`);
            if (!fieldOk(reading)) throw new Error(`${target.name} ${JSON.stringify(reading)}`);
            console.log("ok search", target.name, "Δ", reading.textDelta.toFixed(2), "iconΔ", reading.iconDelta);
          } catch (error) {
            misses.push(`${target.name}: ${error instanceof Error ? error.message : error}`);
          }
        }
        if (misses.length) throw new Error(misses.join(" | "));
        await page.goto(`${WEB}/today`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Toggle sidebar" }).waitFor();
        const composer = page.getByPlaceholder("Ask, or tell me what to change. @ to mention…");
        const askButton = page.getByRole("button", { name: "Ask Ensemble" });
        if (!(await composer.isVisible().catch(() => false))) {
          // Chrome treats Ctrl+J as "downloads", so open the dock from its Ask button.
          await askButton.click();
        }
        await composer.waitFor({ timeout: 8_000 });
        const composerReading = await readField(page, composer);
        await shoot(page, `search-assistant-${tag}`);
        if (!fieldOk(composerReading)) throw new Error(`assistant ${JSON.stringify(composerReading)}`);
        console.log("ok search assistant Δ", composerReading.textDelta.toFixed(2), "iconΔ", composerReading.iconDelta);
      } catch (error) {
        note(`all search inputs ${tag}`, error);
      }
    }
    await context.close();
  }

  async function openEditor(page, which) {
    if (which === "diagram") {
      await page.goto(`${WEB}/diagrams/${diagramId}`, { waitUntil: "domcontentloaded" });
      await page.locator(".diagram-code .cm-content").waitFor({ timeout: 20_000 });
      return ".diagram-code";
    }
    await page.goto(`${WEB}/code/review?repo=${encodeURIComponent(repo)}`, { waitUntil: "domcontentloaded" });
    const fileButton = page.getByRole("button", { name: "file", exact: true });
    try {
      await fileButton.waitFor({ timeout: 20_000 });
    } catch (error) {
      const text = await page.locator("body").innerText().catch(() => "");
      throw new Error(`${error instanceof Error ? error.message : error} body=${text.slice(0, 240)}`);
    }
    await fileButton.click();
    await page.locator(".cm-content").waitFor({ timeout: 20_000 });
    return ".cm-editor";
  }

  await browser.close();
  // A second process so the palette pages cannot warm the webfont cache.
  const fontBrowser =
    engine === "webkit"
      ? await webkit.launch({ headless: true, env: launchEnv })
      : await chromium.launch({
          executablePath: CHROME,
          headless: true,
          env: launchEnv,
          args: ["--no-sandbox", "--disk-cache-size=1"],
        });

  let fontStopped = false;
  for (let loop = 0; loop < FONT_LOOPS && !fontStopped; loop += 1) {
    for (const which of ["diagram", "code"]) {
      if (fontStopped) break;
      const context = await fontBrowser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
      await context.addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
      await context.route("**/*", async (route) => {
        const url = route.request().url();
        // Cold cache: the webfont never arrives, so the editor must already be a monospace fallback.
        if (/\.woff2?(\?|$)/i.test(url)) {
          await route.abort();
          return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      if (engine === "chromium") {
        const client = await context.newCDPSession(page);
        await client.send("Network.setCacheDisabled", { cacheDisabled: true });
        await client.send("Network.clearBrowserCache").catch(() => undefined);
      }
      try {
        const root = await openEditor(page, which);
        const early = await page.locator(root).evaluate(monoProbe);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(50);
        const late = await page.locator(root).evaluate(monoProbe);
        if (early.error || late.error) throw new Error(early.error || late.error);
        if (!early.mono || early.sameAsBody) throw new Error(`early face ${which} #${loop} ${JSON.stringify(early)}`);
        if (!late.mono || late.sameAsBody) throw new Error(`late face ${which} #${loop} ${JSON.stringify(late)}`);
        if (late.align != null && late.align > 4) throw new Error(`gutter align ${which} #${loop} ${late.align}`);
        if (loop === 0 && which === "diagram") await shoot(page, "font-diagram-dark-1440x900");
        if (loop === 0) console.log("ok font", which, late.family);
      } catch (error) {
        note(`font ${which} #${loop}`, error);
        await context.close();
        fontStopped = true;
        break;
      }
      await context.close();
    }
  }

  await fontBrowser.close();
  if (failures.length) {
    console.error(failures.join("\n"));
    throw new Error(`${failures.length} shivani UI checks failed`);
  }
  console.log("shivani ui ok", { engine, fontLoops: FONT_LOOPS });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
