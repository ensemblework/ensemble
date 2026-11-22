/**
 * Desktop control on a real Windows desktop (.github/workflows/desktop-windows-smoke.yml): DesktopService on the
 * Windows driver with the pinned cua-driver.exe (in ENSEMBLE_CUA_DRIVER_DIR) and the session probe, on the
 * runner's interactive desktop. It checks readiness, opens Notepad behind the other windows, adds text to it there
 * through UI Automation, then brings it to the front (the owner's screen is asked for once), clicks into its text and goes to its end,
 * types "Ensemble 0.9.1 on Windows" in chunks and reads it back through UI Automation, takes a
 * screenshot (not blank, the main display's size) and keeps it in `--out`, presses keys, records a few seconds
 * when ffmpeg is there (else checks that readiness says recording is unavailable), has the floor refuse a window
 * titled "Ensemble", and closes Notepad without saving through its elements, in the background.
 *
 *   tsx scripts/desktop-windows-smoke.ts --out <dir>
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.platform !== "win32") throw new Error("The Windows desktop smoke test runs on Windows only.");
const at = process.argv.indexOf("--out");
const out = resolve(at > 0 ? process.argv[at + 1]! : ".smoke");
mkdirSync(out, { recursive: true });
process.env.ENSEMBLE_REMOTE_STATE_DIR ??= join(out, "state");

const { WindowsCuaDriver } = await import("../src/desktop/control/drivers/windows-cua.js");
const { decodePng } = await import("../src/desktop/control/drivers/png.js");
const { HelperProcess } = await import("../src/desktop/control/helper-process.js");
const { desktopDataDir, helperCommand, windowsCuaDriverPin, windowsFfmpeg, windowsProbeCommand } = await import("../src/desktop/control/index.js");
const { desktopReadiness } = await import("../src/desktop/control/readiness.js");
const { DesktopService } = await import("../src/desktop/control/service.js");
type Caller = import("../src/desktop/control/service.js").Caller;
type Observation = import("../src/desktop/control/service.js").Observation;
type HelperApp = import("../src/desktop/control/protocol.js").HelperApp;

const TEXT = "Ensemble 0.9.1 on Windows";
const BEHIND = "Typed behind the other windows. ";
const started = Date.now();
const step = (what: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)} s] ${what}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const asked: string[] = [];
const caller: Caller = { key: "node:smoke:windows", label: "the Windows smoke test", budgetMs: 120_000, gate: async (app) => (asked.push(`${app.category}: ${app.name}`), { allow: true }) };
const children: ChildProcess[] = [];

step("the session probe");
const probe = new HelperProcess({ spawn: () => windowsProbeCommand(), helloTimeoutMs: 60_000 });
try {
  const state = await probe.call<Record<string, unknown>>("state", {}, { timeoutMs: 60_000 });
  console.log(`  ${JSON.stringify(state)}`);
} catch (error) {
  console.log(`  the probe failed: ${error instanceof Error ? error.message : String(error)}\n  its last output: ${probe.stderr()}`);
  throw error;
} finally {
  await probe.stop();
}

step("readiness");
const readiness = await desktopReadiness("win32");
console.log(JSON.stringify({ ready: readiness.ready, session: readiness.session, background: readiness.background, recorder: readiness.recorder, checks: readiness.checks, reason: readiness.reason ?? null }));
assert.equal(readiness.session, "windows");
assert.ok(readiness.ready, `desktop control is not ready here: ${readiness.reason}`);
assert.deepEqual([readiness.checks?.interactive, readiness.checks?.uia, readiness.checks?.screenshot], [true, true, true]);

const log = (message: string) => console.log(`  driver: ${message}`);
const driver = new WindowsCuaDriver({ spawn: () => helperCommand(), version: windowsCuaDriverPin().version, workDir: join(desktopDataDir(), "cua"), probe: new HelperProcess({ spawn: () => windowsProbeCommand(), log, helloTimeoutMs: 60_000 }), ffmpeg: () => windowsFfmpeg(), log, helloTimeoutMs: 60_000 });
const service = new DesktopService({ helper: driver, captureDir: join(out, "captures"), platform: "win32", log, secretValues: async () => [] });

try {
  step("status");
  const status = await service.status(60_000);
  for (const [name, fact] of Object.entries(status.facts)) console.log(`  ${name}: ${fact.state}${fact.detail ? `: ${String(fact.detail).slice(0, 200)}` : ""}`);
  assert.equal(status.facts.session?.state, "working");
  assert.equal(status.facts.uia?.state, "working");
  assert.equal(status.facts.dpi?.state, "working");

  step("open Notepad behind the other windows");
  const opened = await service.open(caller, { app: "Notepad", waitSec: 20 });
  console.log(`  ${JSON.stringify(opened)}`);
  if (!opened.stages.window) console.log(`  the windows here: ${JSON.stringify((await listed()).map((app) => `${app.pid} ${app.name} (${app.app_id}): ${app.windows.map((window) => JSON.stringify(window.title)).join(", ")}`))}`);
  assert.ok(opened.stages.window, "Notepad has a window");
  assert.equal(opened.focused, false, "it opened without taking the front");

  step("add text in the background, through UI Automation");
  const behind = await service.act(caller, { steps: [{ action: "type", element: (await editor()).id, text: BEHIND }], observe: false });
  console.log(`  ${JSON.stringify(behind)}`);
  assert.equal(behind.mode, "background");
  assert.equal(behind.steps[0]!.ran, "yes");
  const added = await notepadText();
  console.log(`  ${JSON.stringify(added)}`);
  assert.ok(added.includes(BEHIND), `Notepad holds ${JSON.stringify(added)}`);

  step("bring it to the front (asks for the owner's screen once)");
  const front = await service.act(caller, { foreground: true, steps: [{ action: "open", app: "Notepad" }], observe: false });
  console.log(`  ${JSON.stringify(front.steps)}`);
  assert.equal(front.steps[0]!.verdict, "confirmed");
  await frontApp("Notepad");

  step("click into its text, by its place on a screenshot, and go to its end");
  const at = await editorPoint();
  const aim = await service.observe(caller, { elements: false });
  assert.ok(aim.display && aim.scale, "a screenshot to aim at");
  const click = await service.act(caller, { foreground: true, steps: [{ action: "click", x: Math.round(at.x / aim.scale), y: Math.round(at.y / aim.scale), captureId: aim.captureId }, { action: "key", keys: "ctrl+End" }], observe: false });
  console.log(`  at ${at.x},${at.y}, then ctrl+End: ${JSON.stringify(click.steps)}`);
  assert.ok(click.steps.every((done) => done.ran === "yes"));

  step(`type "${TEXT}" in chunks`);
  const typed = await service.act(caller, { foreground: true, steps: [{ action: "type", text: TEXT }], observe: false });
  console.log(`  ${JSON.stringify(typed.steps)}`);
  assert.equal(typed.steps[0]!.ran, "yes");
  assert.ok(typed.steps[0]!.verdict === "confirmed" || typed.steps[0]!.verdict === "unknown", `typing: ${typed.steps[0]!.verdict} ${typed.steps[0]!.detail ?? ""}`);

  step("read it back through UI Automation");
  const text = await notepadText();
  console.log(`  ${JSON.stringify(text)}`);
  assert.ok(text.includes(TEXT), `Notepad holds ${JSON.stringify(text)}`);

  step("screenshot");
  const look = await service.observe(caller, { elements: false });
  assert.ok(look.image?.path && look.display, "a screenshot");
  const pixels = decodePng(readFileSync(look.image.path));
  const scale = Math.min(1, 1568 / Math.max(look.display.width, look.display.height));
  console.log(`  ${look.display.width}×${look.display.height} display, ${pixels.width}×${pixels.height} picture`);
  assert.deepEqual([pixels.width, pixels.height], [Math.round(look.display.width * scale), Math.round(look.display.height * scale)]);
  console.log(`  ${colours(pixels.data)} colours`);
  assert.ok(colours(pixels.data) > 16, "the picture is not blank");
  copyFileSync(look.image.path, join(out, "screen.png"));

  step("keys: select all and delete");
  const keys = await service.act(caller, { foreground: true, steps: [{ action: "key", keys: "ctrl+a" }, { action: "key", keys: "BackSpace" }], observe: false });
  console.log(`  ${JSON.stringify(keys.steps)}`);
  assert.ok(keys.steps.every((done) => done.ran === "yes"));
  const cleared = await notepadText();
  assert.ok(!cleared.includes(TEXT), `after the keys Notepad holds ${JSON.stringify(cleared)}`);

  step("recording");
  if (readiness.recorder) {
    await service.recordStart(caller, { evidenceDir: join(out, "evidence"), maxSec: 10 });
    await sleep(3_000);
    const saved = await service.recordSave(caller, { name: "windows smoke" });
    console.log(`  ${saved.width}×${saved.height}, ${saved.durationMs} ms, ${saved.frames} frames`);
    assert.ok(saved.durationMs > 1_000);
  } else {
    const recorder = (await service.status(60_000)).facts.recorder!;
    assert.equal(recorder.state, "failed");
    assert.match(String(recorder.detail), /winget install Gyan\.FFmpeg/);
    console.log("  no ffmpeg here: readiness says recording is unavailable, with the fix");
  }

  step('the floor: a window titled "Ensemble"');
  const exe = join(out, "smoke-window.exe");
  // Windows PowerShell 5.1 with its own modules: PowerShell 7's module path (from the job's shell) breaks them.
  const shellEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
  const compile = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -OutputAssembly '${exe}' -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition 'using System.Windows.Forms; public static class SmokeWindow { public static void Main() { var form = new Form(); form.Text = "Ensemble"; form.Width = 480; form.Height = 320; var button = new Button(); button.Text = "Allow"; button.Width = 160; button.Height = 60; form.Controls.Add(button); Application.Run(form); } }'`], { encoding: "utf8", env: shellEnv });
  assert.equal(compile.status, 0, compile.stderr);
  children.push(spawn(exe, [], { stdio: "ignore", detached: false }));
  let ensemble: Observation | null = null;
  for (let tries = 0; tries < 30 && !ensemble?.tree?.elements.length; tries += 1) {
    await sleep(500);
    ensemble = await service.observe(caller, { app: "smoke-window", screenshot: false }).catch(() => null);
  }
  assert.ok(ensemble?.tree, "the window titled Ensemble can be read");
  const allow = ensemble.tree.elements.find((element) => element.name === "Allow");
  assert.ok(allow, JSON.stringify(ensemble.tree.elements));
  const pressed = await service.act(caller, { steps: [{ action: "press", element: allow.id }], observe: false });
  console.log(`  ${JSON.stringify(pressed.steps)}`);
  assert.deepEqual([pressed.steps[0]!.verdict, pressed.steps[0]!.ran, pressed.steps[0]!.rule], ["refused", "no", "ensemble_window"]);

  step("close Notepad without saving");
  for (const child of children.splice(0)) child.kill();
  const window = await service.observe(caller, { app: "Notepad", screenshot: false, maxElements: 200 });
  const close = window.tree?.elements.find((element) => element.role === "push button" && /^close$/i.test(element.name));
  if (close) {
    console.log(`  its Close button, in the background: ${JSON.stringify((await service.act(caller, { steps: [{ action: "press", element: close.id }], observe: false })).steps)}`);
  } else {
    console.log(`  no Close button among ${JSON.stringify(window.tree?.elements.map((element) => `${element.role} ${element.name}`))}: alt+F4 in front`);
    await frontApp("Notepad");
    console.log(`  ${JSON.stringify((await service.act(caller, { foreground: true, steps: [{ action: "key", keys: "alt+F4" }], observe: false })).steps)}`);
  }
  for (let tries = 0; tries < 20 && (await running("Notepad")); tries += 1) {
    await sleep(500);
    const prompt = await service.observe(caller, { app: "Notepad", screenshot: false, maxElements: 200 }).catch((error: unknown) => (console.log(`  ${error instanceof Error ? error.message : String(error)}`), null));
    const dontSave = prompt?.tree?.elements.find((element) => /^don.?t save$/i.test(element.name.replace(/&/g, "").trim()));
    if (tries === 0 || tries === 10) console.log(`  Notepad's window “${prompt?.tree?.window ?? "?"}”: ${JSON.stringify(prompt?.tree?.elements.map((element) => `${element.id} ${element.role} ${element.name}`).slice(0, 40))}`);
    if (dontSave) console.log(`  ${JSON.stringify((await service.act(caller, { steps: [{ action: "press", element: dontSave.id }], observe: false })).steps)}`);
  }
  assert.equal(await running("Notepad"), false, "Notepad is closed");
  console.log(`  the owner was asked about: ${JSON.stringify(asked)}`);
  assert.equal(asked.filter((item) => item.startsWith("screen")).length >= 1, true);
  writeFileSync(join(out, "result.json"), JSON.stringify({ ok: true, seconds: (Date.now() - started) / 1000, readiness: { checks: readiness.checks, recorder: readiness.recorder } }, null, 2));
  step("all checks passed");
} finally {
  for (const child of children) child.kill();
  await service.stop().catch(() => undefined);
  await driver.stop().catch(() => undefined);
}

/** The app in front is `name`: the open step brought it forward. */
async function frontApp(name: string): Promise<void> {
  for (let tries = 0; tries < 10; tries += 1) {
    const look = await service.observe(caller, { screenshot: false, elements: false }).catch(() => null);
    if (look?.focus?.app?.toLowerCase().includes(name.toLowerCase())) return;
    await sleep(500);
  }
  throw new Error(`${name} did not come to the front.`);
}

/** Notepad's text, read through UI Automation (its editor's value). */
async function notepadText(): Promise<string> {
  const look = await service.observe(caller, { app: "Notepad", screenshot: false, maxElements: 200 });
  const editors = (look.tree?.elements ?? []).filter((element) => element.states.includes("editable") && typeof element.value === "string");
  return editors.map((element) => String(element.value)).join("\n");
}

/** Notepad's text area, in its latest look. */
async function editor(): Promise<import("../src/desktop/control/protocol.js").HelperElement> {
  const look = await service.observe(caller, { app: "Notepad", screenshot: false, maxElements: 200 });
  const editors = (look.tree?.elements ?? []).filter((element) => element.states.includes("editable"));
  const found = editors.find((element) => element.role === "document" || element.role === "text") ?? editors[0];
  assert.ok(found, `no text area among ${JSON.stringify(look.tree?.elements.map((element) => `${element.id} ${element.role} ${element.name}`))}`);
  return found;
}

/** The middle of Notepad's text area on the screen, in screen pixels: its window's place plus its place in the window. */
async function editorPoint(): Promise<{ x: number; y: number }> {
  const area = await editor();
  const window = (await listed()).find((app) => /notepad/i.test(`${app.name} ${app.app_id ?? ""}`))?.windows.find((item) => item.showing && item.box);
  assert.ok(area.box && window?.box, `where Notepad's text is: ${JSON.stringify({ box: area.box, window })}`);
  return { x: Math.round(window.box[0] + area.box[0] + area.box[2] / 2), y: Math.round(window.box[1] + area.box[1] + Math.min(area.box[3] / 2, 40)) };
}

/** The driver's running apps with their windows (boxes in screen pixels). */
async function listed(): Promise<HelperApp[]> {
  return (await driver.call<{ apps: HelperApp[] }>("a11y.apps", {}, { timeoutMs: 30_000 })).apps;
}

async function running(name: string): Promise<boolean> {
  const listed = await service.apps({ running: true });
  return listed.running.some((app) => app.name.toLowerCase().includes(name.toLowerCase()));
}

function colours(data: Uint8Array | Buffer): number {
  const seen = new Set<number>();
  for (let index = 0; index < data.length && seen.size < 1_000; index += 4) seen.add((data[index]! << 16) | (data[index + 1]! << 8) | data[index + 2]!);
  return seen.size;
}

