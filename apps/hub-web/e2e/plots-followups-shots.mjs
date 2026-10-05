/**
 * Screenshots for the plots follow-ups: dark and light grids, and the
 * canvas preview beside the matplotlib export of the same figure.
 *
 *   HUB_WEB=http://127.0.0.1:3000 node apps/hub-web/e2e/plots-followups-shots.mjs
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const API = process.env.HUB_API ?? "http://127.0.0.1:4000";
const WEB = process.env.HUB_WEB ?? "http://127.0.0.1:3000";
const OUT = "docs/screenshots/plots-followups";
const CHROME =
  process.env.CHROME_PATH ??
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");

function cookieHeader(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const pair = list.join(",").match(/ensemble_session=([^;]+)/);
  if (!pair) throw new Error(`no session: ${list.join(" | ")}`);
  return pair[1];
}

async function setTheme(page, theme) {
  await page.evaluate((next) => {
    const raw = JSON.parse(localStorage.getItem("ensemble.appearance") || "{}");
    localStorage.setItem("ensemble.appearance", JSON.stringify({ ...raw, theme: next }));
    document.documentElement.dataset.theme = next;
  }, theme);
  await page.waitForTimeout(500);
}

async function enableMinor(page) {
  await page.getByRole("tab", { name: "Style", exact: true }).click();
  for (const label of ["Minor X grid", "Minor Y grid"]) {
    const box = page.getByLabel(label);
    if (!(await box.isChecked())) await box.check();
  }
  await page.waitForTimeout(300);
}

async function openTile(page, id) {
  if (await page.locator("[data-plot-focus]").count()) {
    await page.getByRole("button", { name: "Back" }).first().click();
    await page.locator("[data-plot-focus]").waitFor({ state: "detached" });
  }
  await page.locator(`[data-plot-tile="${id}"]`).dblclick();
  await page.locator("[data-plot-focus]").waitFor();
}

async function readCode(page) {
  await page.getByRole("tab", { name: "Code", exact: true }).click();
  await page.locator("[data-plot-focus] .cm-content").waitFor();
  await page.waitForFunction(() => {
    const content = document.querySelector("[data-plot-focus] .cm-content");
    const view = content && content.cmTile && content.cmTile.view;
    const text = view ? view.state.doc.toString() : "";
    return text.includes("FixedLocator") && text.includes("save(");
  });
  return page.evaluate(() => {
    const content = document.querySelector("[data-plot-focus] .cm-content");
    const view = content && content.cmTile && content.cmTile.view;
    return view ? view.state.doc.toString() : "";
  });
}

async function renderExport(session, workspaceId, code, file, format = "png") {
  const rendered = await fetch(`${API}/api/plots/${workspaceId}/render`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
    body: JSON.stringify({ format, code, dpi: 140 }),
  });
  if (!rendered.ok) throw new Error(`render ${format} ${rendered.status} ${await rendered.text()}`);
  const payload = await rendered.json();
  const stderr = String(payload.stderr ?? "");
  if (/missing from font|Glyph/i.test(stderr)) throw new Error(`${format} glyph warning:\n${stderr}`);
  const body = format === "svg" ? payload.data : Buffer.from(payload.data, "base64");
  await writeFile(file, body);
  if (format === "svg" && /[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]/.test(String(body))) throw new Error(`${file} embeds a superscript the serif font cannot draw`);
  return payload;
}

async function pair(page, previewName, exportName, outName, theme) {
  const preview = `data:image/png;base64,${(await readFile(`${OUT}/${previewName}`)).toString("base64")}`;
  const exported = `data:image/png;base64,${(await readFile(`${OUT}/${exportName}`)).toString("base64")}`;
  const paper = theme === "dark" ? "#221e1a" : "#fffcf7";
  const pageBg = theme === "dark" ? "#141210" : "#f4f1ea";
  const ink = theme === "dark" ? "#f3eee6" : "#1c1915";
  await page.setContent(`<!doctype html>
    <html><body style="margin:0;background:${pageBg};color:${ink};font-family:sans-serif">
      <div style="display:flex;gap:16px;padding:16px;align-items:flex-start">
        <figure style="margin:0"><figcaption style="margin-bottom:8px">Preview</figcaption><img src="${preview}" style="background:${paper};border:1px solid #888"></figure>
        <figure style="margin:0"><figcaption style="margin-bottom:8px">Matplotlib export</figcaption><img src="${exported}" style="background:${paper};border:1px solid #888"></figure>
      </div>
    </body></html>`, { waitUntil: "load" });
  await page.screenshot({ path: `${OUT}/${outName}`, fullPage: true });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const email = `plots-shots-${Date.now().toString(36)}@ensemble.test`;
  const signup = await fetch(`${API}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "plot-shot-pass-1", name: "Shots" }),
  });
  if (!signup.ok) throw new Error(`signup ${signup.status} ${await signup.text()}`);
  const session = cookieHeader(typeof signup.headers.getSetCookie === "function" ? signup.headers.getSetCookie() : signup.headers.get("set-cookie"));
  const onboard = await fetch(`${API}/api/onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
    body: JSON.stringify({ role: "engineer", templateId: "branch-desk" }),
  });
  if (!onboard.ok) throw new Error(`onboarding ${onboard.status} ${await onboard.text()}`);
  const modules = await fetch(`${API}/api/settings/modules`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: `ensemble_session=${session}` },
    body: JSON.stringify({ id: "plots", on: true }),
  });
  if (!modules.ok) throw new Error(`modules ${modules.status} ${await modules.text()}`);
  const workspace = await fetch(`${API}/api/plots/workspace`, { headers: { cookie: `ensemble_session=${session}` } });
  if (!workspace.ok) throw new Error(`workspace ${workspace.status} ${await workspace.text()}`);
  const workspaceId = (await workspace.json()).workspace.id;

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  try {
    await page.addInitScript(() => {
      localStorage.setItem("ensemble.appearance", JSON.stringify({ theme: "dark", accent: "indigo" }));
    });
    await page.context().addCookies([{ name: "ensemble_session", value: session, url: WEB }]);
    await page.goto(`${WEB}/plots`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-plot-sample]").first().click();
    await page.locator('[data-plot-tile="sample-scaling"]').waitFor({ timeout: 40000 });

    const chart = () => page.locator("[data-plot-focus] [data-plot-chart]");
    await openTile(page, "sample-scaling");
    await enableMinor(page);
    await setTheme(page, "dark");
    await chart().screenshot({ path: `${OUT}/dark-grid.png` });
    const scalingDark = await readCode(page);
    if (!scalingDark.includes("set_xscale('log')") || !scalingDark.includes("set_yscale('log')")) throw new Error("scaling export is not log-log");
    if (!scalingDark.includes("LogFormatterMathtext()")) throw new Error("scaling export does not use mathtext");
    if (/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]/.test(scalingDark)) throw new Error("scaling export still uses unicode superscripts");
    await renderExport(session, workspaceId, scalingDark, `${OUT}/scaling-dark-export.png`);
    await renderExport(session, workspaceId, scalingDark, `${OUT}/scaling-dark-export.pdf`, "pdf");
    await renderExport(session, workspaceId, scalingDark, `${OUT}/scaling-dark-export.svg`, "svg");

    await setTheme(page, "light");
    await page.getByRole("tab", { name: "Encode", exact: true }).click();
    await chart().screenshot({ path: `${OUT}/light-grid.png` });
    const scalingLight = await readCode(page);
    if (!scalingLight.includes("LogFormatterMathtext()")) throw new Error("light scaling export does not use mathtext");
    await renderExport(session, workspaceId, scalingLight, `${OUT}/scaling-light-export.png`);
    await renderExport(session, workspaceId, scalingLight, `${OUT}/scaling-light-export.pdf`, "pdf");
    await renderExport(session, workspaceId, scalingLight, `${OUT}/scaling-light-export.svg`, "svg");

    await openTile(page, "sample-train");
    await enableMinor(page);
    await setTheme(page, "dark");
    await chart().screenshot({ path: `${OUT}/training-dark-preview.png` });
    const trainDark = await readCode(page);
    if (!trainDark.includes("groupby")) throw new Error("training export does not derive the seed mean");
    if (!trainDark.includes("std(ddof=1)") || (trainDark.match(/fill_between\(_x, _y - _e, _y \+ _e/g) ?? []).length < 2) {
      throw new Error("training export is missing ±std bands");
    }
    await renderExport(session, workspaceId, trainDark, `${OUT}/training-dark-export.png`);

    await setTheme(page, "light");
    await page.getByRole("tab", { name: "Encode", exact: true }).click();
    await chart().screenshot({ path: `${OUT}/training-light-preview.png` });
    const trainLight = await readCode(page);
    await renderExport(session, workspaceId, trainLight, `${OUT}/training-light-export.png`);

    const darkSrc = `data:image/png;base64,${(await readFile(`${OUT}/dark-grid.png`)).toString("base64")}`;
    const lightSrc = `data:image/png;base64,${(await readFile(`${OUT}/light-grid.png`)).toString("base64")}`;
    await page.setContent(`<!doctype html>
      <html><body style="margin:0;background:#1a1814;color:#f3eee6;font-family:sans-serif">
        <div style="display:flex;gap:16px;padding:16px;align-items:flex-start">
          <figure style="margin:0"><figcaption style="margin-bottom:8px">Dark preview</figcaption><img src="${darkSrc}" style="background:#221e1a;border:1px solid #333"></figure>
          <figure style="margin:0"><figcaption style="margin-bottom:8px">Light preview</figcaption><img src="${lightSrc}" style="background:#fffcf7;border:1px solid #ccc"></figure>
        </div>
      </body></html>`, { waitUntil: "load" });
    await page.screenshot({ path: `${OUT}/light-vs-dark.png`, fullPage: true });

    await pair(page, "dark-grid.png", "scaling-dark-export.png", "preview-vs-export-scaling-dark.png", "dark");
    await pair(page, "light-grid.png", "scaling-light-export.png", "preview-vs-export-scaling-light.png", "light");
    await pair(page, "training-dark-preview.png", "training-dark-export.png", "preview-vs-export-training-dark.png", "dark");
    await pair(page, "training-light-preview.png", "training-light-export.png", "preview-vs-export-training-light.png", "light");
    await pair(page, "dark-grid.png", "scaling-dark-export.png", "preview-vs-export.png", "dark");
    console.log("shots ok");
  } finally {
    await browser.close();
  }
  checkPixels();
}

function checkPixels() {
  const python = existsSync("/workspace/apps/agent-runtime/.venv/bin/python")
    ? "/workspace/apps/agent-runtime/.venv/bin/python"
    : "python3";
  execFileSync(python, ["-c", `
from PIL import Image
from pathlib import Path
root = Path(${JSON.stringify(OUT)})
def near(px, target, tol):
    return all(abs(int(a) - b) <= tol for a, b in zip(px[:3], target))
im = Image.open(root / "scaling-dark-export.png").convert("RGB")
major = minor = 0
for px in im.getdata():
    if near(px, (170, 165, 159), 22):
        major += 1
    elif near(px, (149, 144, 138), 18):
        minor += 1
print("dark export major", major, "minor", minor, "size", im.size)
if major < 80 or minor < 40:
    raise SystemExit("dark export grid is not visible")
im = Image.open(root / "scaling-light-export.png").convert("RGB")
major = minor = 0
for px in im.getdata():
    if near(px, (141, 138, 134), 18):
        major += 1
    elif near(px, (164, 161, 156), 16):
        minor += 1
print("light export major", major, "minor", minor)
if major < 80 or minor < 40:
    raise SystemExit("light export grid is not visible")

def band_pixels(path, bg, targets):
    image = Image.open(path).convert("RGB")
    counts = {name: 0 for name, _color in targets}
    width, height = image.size
    pix = image.load()
    for y in range(height):
        for x in range(width):
            px = pix[x, y]
            if sum((int(a) - b) ** 2 for a, b in zip(px, bg)) < 30:
                continue
            for name, color in targets:
                if all(abs(int(a) - b) <= 10 for a, b in zip(px, color)):
                    counts[name] += 1
    print(path.name, counts, image.size)
    return counts

dark_bands = band_pixels(root / "training-dark-export.png", (34, 30, 26), [("train", (54, 47, 75)), ("eval", (77, 58, 20))])
light_bands = band_pixels(root / "training-light-export.png", (255, 252, 247), [("train", (217, 212, 240)), ("eval", (250, 232, 193))])
for name, count in {**dark_bands, **{f"light {key}": value for key, value in light_bands.items()}}.items():
    if count < 400:
        raise SystemExit(f"{name} band is not visible ({count} px)")
`], { stdio: "inherit" });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
