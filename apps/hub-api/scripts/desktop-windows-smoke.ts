/**
 * Desktop control on a real Windows desktop (.github/workflows/desktop-windows-smoke.yml): DesktopService on the
 * Windows driver with the pinned cua-driver.exe (in ENSEMBLE_CUA_DRIVER_DIR) and the session probe, on the
 * runner's interactive desktop. It checks readiness, opens Notepad behind the other windows, types into its text
 * there through UI Automation (a packaged Notepad takes it; a classic one's text box drops it, and the step must say
 * so), brings it to the front (the owner's screen is asked for once; Windows' foreground lock may keep it behind, and
 * the step must say so), clicks into its text by its place on a screenshot and goes to its end,
 * types "Ensemble 0.9.1 on Windows" in chunks and reads it back through UI Automation, takes a
 * screenshot (not blank, the main display's size) and keeps it in `--out`, presses keys, records a few seconds
 * when ffmpeg is there (else checks that readiness says recording is unavailable), has the floor refuse a window
 * titled "Ensemble", and closes Notepad without saving (alt+F4, then "Don't save" by its element). Every action
 * cua-driver is asked for is logged with its answer (and any call slower than 3 s), and a failed check lets the
 * rest run, so one run shows every step that fails; the run fails at the end.
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
type HelperElement = import("../src/desktop/control/protocol.js").HelperElement;
type McpResult = import("../src/desktop/control/drivers/mcp-stdio.js").McpResult;

const TEXT = "Ensemble 0.9.1 on Windows";
const BEHIND = "Typed behind the other windows. ";
const started = Date.now();
const step = (what: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)} s] ${what}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const asked: string[] = [];
const caller: Caller = { key: "node:smoke:windows", label: "the Windows smoke test", budgetMs: 120_000, gate: async (app) => (asked.push(`${app.category}: ${app.name}`), { allow: true }) };
const children: ChildProcess[] = [];
const failures: string[] = [];

/** A check that lets the rest of the smoke run; the run fails at the end. */
function expect(ok: unknown, message: string): boolean {
  if (!ok) {
    failures.push(message);
    console.log(`  FAILED: ${message}`);
  }
  return Boolean(ok);
}

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
const calls = trace(driver);

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
  const area = await editor();
  console.log(`  its text area: ${area.id} ${area.role} ${JSON.stringify(area.name)}, actions ${JSON.stringify(area.actions)}, states ${JSON.stringify(area.states)}`);
  const behind = await service.act(caller, { steps: [{ action: "type", element: area.id, text: BEHIND }], observe: false });
  console.log(`  ${JSON.stringify(behind)}`);
  assert.equal(behind.mode, "background");
  assert.equal(behind.steps[0]!.ran, "yes");
  const added = await notepadText();
  console.log(`  ${JSON.stringify(added)}`);
  // A packaged Notepad takes it through UI Automation; a classic text box of a window that never had the focus drops
  // keys sent to it, and the step says so instead of claiming it.
  const honest = behind.steps[0]!.verdict === "confirmed" ? added.includes(BEHIND) : behind.steps[0]!.verdict === "no_effect" && !added.includes(BEHIND);
  expect(honest, `typed in the background (${behind.steps[0]!.verdict}: ${behind.steps[0]!.detail ?? ""}), Notepad holds ${JSON.stringify(added)}`);
  if (behind.steps[0]!.verdict !== "confirmed") {
    const set = await service.act(caller, { steps: [{ action: "set_text", element: (await editor()).id, text: BEHIND }], observe: false });
    console.log(`  set_text instead: ${JSON.stringify(set.steps)}; Notepad holds ${JSON.stringify(await notepadText())}`);
  }

  step("bring it to the front (asks for the owner's screen once)");
  const front = await service.act(caller, { foreground: true, steps: [{ action: "open", app: "Notepad" }], observe: false });
  console.log(`  ${JSON.stringify(front.steps)}`);
  console.log(`  in front: ${await frontName()}`);
  // Windows' foreground lock can keep it behind (seen on the Windows 11 arm64 runner, whose foreground is the shell):
  // then the step says so, and the click into its text below brings it forward.
  expect(front.steps[0]!.verdict === "confirmed" || (front.steps[0]!.verdict === "partial" && /did not come to the front/.test(front.steps[0]!.detail ?? "")), `the open step brought Notepad to the front or said it did not (${front.steps[0]!.verdict}: ${front.steps[0]!.detail ?? ""})`);

  step("click into its text, by its place on a screenshot, and go to its end");
  const at = await editorPoint();
  const aim = await service.observe(caller, { elements: false });
  assert.ok(aim.display && aim.scale, "a screenshot to aim at");
  const click = await service.act(caller, { foreground: true, steps: [{ action: "click", x: Math.round(at.x / aim.scale), y: Math.round(at.y / aim.scale), captureId: aim.captureId }, { action: "key", keys: "ctrl+End" }], observe: false });
  console.log(`  at ${at.x},${at.y}, then ctrl+End: ${JSON.stringify(click.steps)}`);
  expect(click.steps.every((done) => done.ran === "yes"), "the click and the keys ran");
  const inFront = await frontName();
  console.log(`  in front: ${inFront}`);

  if (expect(/notepad/i.test(inFront), `Notepad is in front after the click (${inFront})`)) {
    step(`type "${TEXT}" in chunks`);
    const chunksBefore = calls.filter((call) => call.name === "type_text").length;
    const typed = await service.act(caller, { foreground: true, steps: [{ action: "type", text: TEXT }], observe: false });
    console.log(`  ${JSON.stringify(typed.steps)}`);
    const chunks = calls.filter((call) => call.name === "type_text").length - chunksBefore;
    expect(typed.steps[0]!.ran === "yes", "typing ran");
    expect(chunks === Math.ceil(TEXT.length / 8), `typed in ${Math.ceil(TEXT.length / 8)} chunks of at most 8 characters (${chunks})`);

    step("read it back through UI Automation");
    const text = await notepadText();
    console.log(`  ${JSON.stringify(text)}`);
    expect(text.includes(TEXT), `typed in front, Notepad holds ${JSON.stringify(text)} (${typed.steps[0]!.verdict}: ${typed.steps[0]!.detail ?? ""})`);
  }

  step("screenshot");
  const look = await service.observe(caller, { elements: false });
  assert.ok(look.image?.path && look.display, "a screenshot");
  const pixels = decodePng(readFileSync(look.image.path));
  const scale = Math.min(1, 1568 / Math.max(look.display.width, look.display.height));
  console.log(`  ${look.display.width}×${look.display.height} display, ${pixels.width}×${pixels.height} picture, ${colours(pixels.data)} colours`);
  expect(pixels.width === Math.round(look.display.width * scale) && pixels.height === Math.round(look.display.height * scale), "the picture is the display's size");
  expect(colours(pixels.data) > 16, "the picture is not blank");
  copyFileSync(look.image.path, join(out, "screen.png"));

  if (/notepad/i.test(await frontName())) {
    step("keys: select all and delete");
    const keys = await service.act(caller, { foreground: true, steps: [{ action: "key", keys: "ctrl+a" }, { action: "key", keys: "BackSpace" }], observe: false });
    console.log(`  ${JSON.stringify(keys.steps)}`);
    expect(keys.steps.every((done) => done.ran === "yes"), "the keys ran");
    const cleared = await notepadText();
    expect(!cleared.includes(TEXT) && !cleared.includes(BEHIND), `after the keys Notepad holds ${JSON.stringify(cleared)}`);
  } else {
    expect(false, "Notepad is in front for the keys");
  }

  step("recording");
  if (readiness.recorder) {
    await service.recordStart(caller, { evidenceDir: join(out, "evidence"), maxSec: 10 });
    await sleep(3_000);
    const saved = await service.recordSave(caller, { name: "windows smoke" });
    console.log(`  ${saved.width}×${saved.height}, ${saved.durationMs} ms, ${saved.frames} frames`);
    expect(saved.durationMs > 1_000, "a recording of more than a second");
  } else {
    const recorder = (await service.status(60_000)).facts.recorder!;
    expect(recorder.state === "failed" && /winget install Gyan\.FFmpeg/.test(String(recorder.detail)), `without ffmpeg readiness says recording is unavailable, with the fix (${recorder.state}: ${String(recorder.detail).slice(0, 120)})`);
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
  expect(pressed.steps[0]!.verdict === "refused" && pressed.steps[0]!.ran === "no" && pressed.steps[0]!.rule === "ensemble_window", "the floor refused the window titled Ensemble");
  for (const child of children.splice(0)) child.kill();

  step("close Notepad without saving");
  // A title bar's Close button is not pressed through UI Automation in the background (cua-driver posts a click that
  // the title bar ignores): alt+F4 goes to Notepad in front.
  if (expect(await notepadInFront(), `Notepad is in front for alt+F4 (${await frontName()})`)) {
    console.log(`  alt+F4: ${JSON.stringify((await service.act(caller, { foreground: true, steps: [{ action: "key", keys: "alt+F4" }], observe: false })).steps)}`);
  }
  // Closed: no window of Notepad's twice in a row; a prompt to save is answered "Don't save" by its button, else by
  // its key in front.
  let gone = 0;
  let presses = 0;
  for (let tries = 0; tries < 30 && gone < 2; tries += 1) {
    await sleep(500);
    if (!(await running("Notepad"))) {
      gone += 1;
      continue;
    }
    gone = 0;
    const prompt = await service.observe(caller, { app: "Notepad", screenshot: false, maxElements: 200 }).catch((error: unknown) => (console.log(`  ${error instanceof Error ? error.message : String(error)}`), null));
    const dontSave = prompt?.tree?.elements.find((element) => /^don.?t save$/i.test(element.name.replace(/&/g, "").trim()));
    if (tries % 10 === 0) console.log(`  Notepad's window “${prompt?.tree?.window ?? "?"}”: ${JSON.stringify(prompt?.tree?.elements.map((element) => `${element.id} ${element.role} ${element.name}`).slice(0, 40))}`);
    if (!dontSave) continue;
    presses += 1;
    if (presses <= 2) console.log(`  Don't Save, in the background: ${JSON.stringify((await service.act(caller, { steps: [{ action: "press", element: dontSave.id }], observe: false })).steps)}`);
    else if (presses === 3) console.log(`  Don't Save by its key (n), in front of ${await frontName()}: ${JSON.stringify((await service.act(caller, { foreground: true, steps: [{ action: "key", keys: "n" }], observe: false })).steps)}`);
  }
  expect(gone >= 2, "Notepad is closed");
  console.log(`  the owner was asked about: ${JSON.stringify(asked)}`);
  expect(asked.some((item) => item.startsWith("screen")), "the owner's screen was asked for");
  writeFileSync(join(out, "result.json"), JSON.stringify({ ok: failures.length === 0, failures, seconds: (Date.now() - started) / 1000, readiness: { checks: readiness.checks, recorder: readiness.recorder } }, null, 2));
} finally {
  for (const child of children) child.kill();
  await service.stop().catch(() => undefined);
  await driver.stop().catch(() => undefined);
}
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  process.exit(1);
}
step("all checks passed");

/** cua-driver's calls: each action with its answer, and any call that failed or took more than 3 s. */
function trace(target: object): Array<{ name: string; ms: number; error: boolean }> {
  const seen: Array<{ name: string; ms: number; error: boolean }> = [];
  const ACTIONS = new Set(["launch_app", "bring_to_front", "type_text", "set_value", "click", "press_key", "hotkey", "scroll"]);
  const mcp = (target as { mcp: { call(name: string, args: Record<string, unknown>, options: { timeoutMs: number; effects?: boolean }): Promise<McpResult> } }).mcp;
  const call = mcp.call.bind(mcp);
  const brief = (value: unknown) => JSON.stringify(value, (key, item: unknown) => (typeof item === "string" && item.length > 80 ? `${item.slice(0, 80)}…` : ["elements", "windows", "apps", "screenshot", "image"].includes(key) ? `[${Array.isArray(item) ? item.length : "…"}]` : item));
  const said = (result: McpResult) => `${(result?.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join(" ").replace(/\s+/g, " ").slice(0, 400)} ${brief(result?.structuredContent ?? null).slice(0, 700)}`;
  mcp.call = async (name, args, options) => {
    const began = Date.now();
    try {
      const result = await call(name, args, options);
      const ms = Date.now() - began;
      seen.push({ name, ms, error: result?.isError === true });
      if (ACTIONS.has(name) || result?.isError || ms > 3_000) console.log(`    cua ${name}(${brief(args).slice(0, 300)}) ${ms} ms${result?.isError ? " ERROR" : ""}: ${said(result)}`);
      return result;
    } catch (error) {
      console.log(`    cua ${name}(${brief(args).slice(0, 300)}) failed after ${Date.now() - began} ms: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
      throw error;
    }
  };
  return seen;
}

/** Notepad in front: brought there by an open step, else by a click into its text. */
async function notepadInFront(): Promise<boolean> {
  if (/notepad/i.test(await frontName())) return true;
  console.log(`  bring Notepad forward: ${JSON.stringify((await service.act(caller, { foreground: true, steps: [{ action: "open", app: "Notepad" }], observe: false })).steps)}`);
  if (/notepad/i.test(await frontName())) return true;
  const at = await editorPoint();
  const aim = await service.observe(caller, { elements: false });
  console.log(`  click into its text: ${JSON.stringify((await service.act(caller, { foreground: true, steps: [{ action: "click", x: Math.round(at.x / aim.scale!), y: Math.round(at.y / aim.scale!), captureId: aim.captureId }], observe: false })).steps)}`);
  return /notepad/i.test(await frontName());
}

/** The app in front, as desktop control sees it. */
async function frontName(): Promise<string> {
  const look = await service.observe(caller, { screenshot: false, elements: false }).catch((error: unknown) => ({ focus: { app: `(${error instanceof Error ? error.message.slice(0, 120) : "no answer"})`, window: null } }));
  return `${look.focus?.app ?? "nothing"}${look.focus?.window ? ` “${look.focus.window}”` : ""}`;
}

/** Notepad's text, read through UI Automation (its editor's value). */
async function notepadText(): Promise<string> {
  const look = await service.observe(caller, { app: "Notepad", screenshot: false, maxElements: 200 });
  const editors = (look.tree?.elements ?? []).filter((element) => element.states.includes("editable") && typeof element.value === "string");
  return editors.map((element) => String(element.value)).join("\n");
}

/** Notepad's text area, in its latest look. */
async function editor(): Promise<HelperElement> {
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
