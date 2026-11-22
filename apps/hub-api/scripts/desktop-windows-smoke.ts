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
 * titled "Ensemble" (and an untitled popup of Ensemble's over Notepad, a window under a cloaked one, typing that stops at
 * the next chunk when Ensemble takes the keyboard behind a window on top, and a browser Windows has registered that the
 * program list does not know, with windows from desktop-windows-smoke-windows.cs), and closes Notepad without saving
 * (alt+F4, then "Don't save" by its element). Every action
 * cua-driver is asked for is logged with its answer (and any call slower than 3 s), and a failed check lets the
 * rest run, so one run shows every step that fails; the run fails at the end. With `--foreground-may-be-held`, when
 * a window that is no app's keeps the foreground (Windows' first sign-in screen on the arm64 runner), the checks that
 * need the owner's screen are reported as not checked (a warning), and Notepad closes through its File menu.
 *
 *   tsx scripts/desktop-windows-smoke.ts --out <dir>
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
/** What could not be checked because Windows keeps the foreground on a window that is no app's (`--foreground-may-be-held`). */
const unchecked: string[] = [];
const heldOk = process.argv.includes("--foreground-may-be-held");
let held: string | null = null;
/** The app in front at the latest `frontApp()`. */
let frontAppName = "";
/** Run after each cua-driver call (the typing test switches the keyboard to Ensemble after the first chunk). */
let afterCall: ((name: string) => Promise<void>) | null = null;
// Windows PowerShell 5.1 with its own modules: PowerShell 7's module path (from the job's shell) breaks them.
const shellEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
const powershell = (script: string) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: shellEnv, timeout: 120_000 });

// The smoke's own windows (desktop-windows-smoke-windows.cs): Ensemble.exe, and copies under other names. A browser
// Windows has registered (Clients\StartMenuInternet) that the program list does not know: iron.exe, before the driver
// reads the registered browsers.
const floorDir = join(out, "floor");
mkdirSync(floorDir, { recursive: true });
const ensembleExe = join(floorDir, "Ensemble.exe");
const coverExe = join(floorDir, "smoke-cover.exe");
const ironExe = join(floorDir, "iron.exe");
const IRON_KEY = "HKCU:\\Software\\Clients\\StartMenuInternet\\EnsembleSmokeIron";
{
  const source = join(dirname(fileURLToPath(import.meta.url)), "desktop-windows-smoke-windows.cs");
  const compiled = powershell(`Add-Type -Path '${source}' -OutputAssembly '${ensembleExe}' -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing`);
  assert.equal(compiled.status, 0, compiled.stderr);
  copyFileSync(ensembleExe, coverExe);
  copyFileSync(ensembleExe, ironExe);
  const registered = powershell(`New-Item -Path '${IRON_KEY}\\shell\\open\\command' -Force | Out-Null; Set-Item -Path '${IRON_KEY}\\shell\\open\\command' -Value '"${ironExe}"'`);
  assert.equal(registered.status, 0, registered.stderr);
}

/** A check that lets the rest of the smoke run; the run fails at the end. */
function expect(ok: unknown, message: string): boolean {
  if (!ok) {
    failures.push(message);
    console.log(`  FAILED: ${message}`);
  }
  return Boolean(ok);
}

/** A check of the owner's screen: not made while a window that is no app's holds the foreground on a runner that may have one. */
function onScreen(ok: () => unknown, message: string): boolean {
  if (held && heldOk) {
    unchecked.push(message);
    console.log(`  NOT CHECKED (${held}, a window that is no app's, holds the foreground): ${message}`);
    return false;
  }
  return expect(ok(), message);
}

step("the session probe");
const probe = new HelperProcess({ spawn: () => windowsProbeCommand(), helloTimeoutMs: 60_000 });
try {
  const state = await probe.call<Record<string, unknown>>("state", {}, { timeoutMs: 60_000 });
  console.log(`  ${JSON.stringify(state)}`);
  // What Windows itself says about its windows and browsers, which the floor and typing go by.
  const view = await probe.call<{ foreground: { title: string | null; program: string | null } | null; cloaked: number[]; at: Array<{ title: string | null; program: string | null } | null> }>("windows", { points: [[5, 5]] }, { timeoutMs: 30_000 });
  console.log(`  windows: the keyboard's ${JSON.stringify(view.foreground)}, ${view.cloaked.length} cloaked, at (5,5) ${JSON.stringify(view.at[0])}`);
  expect(Array.isArray(view.cloaked) && view.at.length === 1 && view.at[0] !== null, "the probe says which window is at a point");
  const { browsers } = await probe.call<{ browsers: Array<{ name: string; program: string }> }>("browsers", {}, { timeoutMs: 30_000 });
  console.log(`  registered browsers: ${JSON.stringify(browsers.map((item) => `${item.name}: ${item.program}`))}`);
  expect(browsers.some((item) => item.program.toLowerCase() === ironExe.toLowerCase()), "the probe reads the browsers Windows has registered");
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
  console.log(`  in front: ${(await frontApp()) ?? "no app"}`);
  // Windows' foreground lock can keep it behind: then the step says so, and a click into its text brings it forward.
  expect(front.steps[0]!.verdict === "confirmed" || (front.steps[0]!.verdict === "partial" && /did not come to the front/.test(front.steps[0]!.detail ?? "")), `the open step brought Notepad to the front or said it did not (${front.steps[0]!.verdict}: ${front.steps[0]!.detail ?? ""})`);

  step("click into its text, by its place on a screenshot, and go to its end");
  const at = await editorPoint();
  const aim = await service.observe(caller, { elements: false });
  assert.ok(aim.display && aim.scale, "a screenshot to aim at");
  // A click into an empty text box may change nothing on the screen (no_effect), which ends a batch: the keys go apart.
  const click = await service.act(caller, { foreground: true, steps: [{ action: "click", x: Math.round(at.x / aim.scale), y: Math.round(at.y / aim.scale), captureId: aim.captureId }], observe: false });
  console.log(`  at ${at.x},${at.y}: ${JSON.stringify(click.steps)}`);
  expect(click.steps[0]!.ran === "yes", "the click ran");
  if (!(await frontApp())) {
    // Nothing that is an app holds the foreground, and a click into Notepad does not reach it: a system window covers
    // the desktop (the Windows 11 arm64 runner shows Windows' first sign-in privacy screen; screen.png shows it).
    held = foregroundHolder();
    console.log(`  the foreground: ${held}`);
  }
  if (onScreen(() => /notepad/i.test(frontAppName), `Notepad is in front after the click`)) {
    const end = await service.act(caller, { foreground: true, steps: [{ action: "key", keys: "ctrl+End" }], observe: false });
    console.log(`  ctrl+End: ${JSON.stringify(end.steps)}`);
    expect(end.steps[0]!.ran === "yes", "ctrl+End ran");

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
  } else {
    onScreen(() => false, `"${TEXT}" typed in chunks in front and read back`);
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

  const keysInFront = /notepad/i.test((await frontApp()) ?? "");
  if (onScreen(() => keysInFront, "Notepad is in front for the keys")) {
    step("keys: select all and delete");
    const keys = await service.act(caller, { foreground: true, steps: [{ action: "key", keys: "ctrl+a" }, { action: "key", keys: "BackSpace" }], observe: false });
    console.log(`  ${JSON.stringify(keys.steps)}`);
    expect(keys.steps.every((done) => done.ran === "yes"), "the keys ran");
    const cleared = await notepadText();
    expect(!cleared.includes(TEXT) && !cleared.includes(BEHIND), `after the keys Notepad holds ${JSON.stringify(cleared)}`);
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

  step('the floor: a window titled "Ensemble" and its untitled popup over Notepad');
  const textArea = (await editorPoint()).at;
  const trigger = join(floorDir, "take-the-keyboard");
  const main = { x: 560, y: 360, width: 440, height: 300 };
  const popup = { x: textArea.x - 100, y: textArea.y - 30, width: 200, height: 60 };
  launch(ensembleExe, ["ensemble", ...rect(main), ...rect(popup), trigger]);
  const ensemble = await waitFor("Ensemble", (look) => look.tree?.elements.some((element) => element.name === "Allow") === true);
  const allow = ensemble.tree!.elements.find((element) => element.name === "Allow")!;
  const pressed = await service.act(caller, { steps: [{ action: "press", element: allow.id }], observe: false });
  console.log(`  Allow, by its element: ${JSON.stringify(pressed.steps)}`);
  expect(pressed.steps[0]!.verdict === "refused" && pressed.steps[0]!.ran === "no" && pressed.steps[0]!.rule === "ensemble_window", "the floor refused the window titled Ensemble");
  if (onScreen(() => true, "a click on Ensemble's untitled popup over Notepad is refused")) {
    const hit = await hitAt(center(popup));
    const clicked = await clickAt(center(popup));
    console.log(`  Windows finds ${hit} at the popup; the click: ${JSON.stringify(clicked)}`);
    expect(clicked.verdict === "refused" && clicked.rule === "ensemble_window", "a click on Ensemble's untitled popup over Notepad is refused");
  }

  step("a window cloaked as on another virtual desktop, over Ensemble's popup");
  // Both are always on top, the cover above: Windows shows the popup there, and a list of windows puts the cover first.
  const covered = { x: popup.x - 20, y: popup.y - 20, width: popup.width + 40, height: popup.height + 40 };
  launch(coverExe, ["cover", ...rect(covered)]);
  const coverWindow = async () => (await listed()).flatMap((app) => app.windows).find((window) => window.title === "Cover");
  for (let tries = 0; tries < 40 && !(await coverWindow()); tries += 1) await sleep(500);
  // It cloaks itself once it shows.
  await sleep(1_000);
  const cover = await coverWindow();
  const rawCover = ((await raw("list_windows", {})).structuredContent?.windows as Array<Record<string, unknown>> | undefined)?.find((window) => window.title === "Cover");
  console.log(`  cua-driver lists it with is_on_screen ${String(rawCover?.is_on_screen)}; desktop control: ${JSON.stringify(cover)}`);
  expect(cover && cover.showing === false, "a cloaked window does not show");
  if (onScreen(() => true, "a click on Ensemble's popup under the cloaked window is judged by the window Windows finds there")) {
    const hit = await hitAt(center(popup));
    const clicked = await clickAt(center(popup));
    console.log(`  Windows finds ${hit} under the cloaked window; the click: ${JSON.stringify(clicked)}`);
    expect(!/notepad/i.test(hit), `the popup or the cover is at that point (${hit})`);
    expect(/ensemble/i.test(hit) ? clicked.verdict === "refused" && clicked.rule === "ensemble_window" : clicked.ran === "yes", `the click is judged by ${hit}`);
  }
  stopApp(coverExe);

  step("typing stops at the next chunk when Ensemble takes the keyboard behind a window on top");
  launch(coverExe, ["overlay", 10, 660, 220, 50]);
  await sleep(1_500);
  if (onScreen(() => true, "typing stops at the next chunk when Ensemble takes the keyboard") && expect(await notepadInFront(), "Notepad is in front to type")) {
    const before = await notepadText();
    const driverProbe = (driver as unknown as { options: { probe: { call<T>(method: string, params: Record<string, unknown>, options: { timeoutMs: number }): Promise<T> } } }).options.probe;
    afterCall = async (name) => {
      if (name !== "type_text") return;
      afterCall = null;
      writeFileSync(trigger, "now");
      for (let tries = 0; tries < 40; tries += 1) {
        await sleep(50);
        const view = await driverProbe.call<{ foreground: { title: string | null } | null }>("windows", { points: [] }, { timeoutMs: 5_000 });
        if (view.foreground?.title === "Ensemble") return;
      }
      console.log("  Ensemble did not take the keyboard");
    };
    const text = "abcdefgh".repeat(5);
    const typed = await service.act(caller, { foreground: true, steps: [{ action: "type", text }], observe: false });
    afterCall = null;
    console.log(`  ${JSON.stringify(typed.steps)}; in front now: ${(await frontApp()) ?? "no app"}`);
    expect(typed.steps[0]!.verdict === "partial" && /Typing stopped after 8 of 40 characters: the window in front changed/.test(typed.steps[0]!.detail ?? ""), "typing stopped after the first chunk");
    const after = await notepadText();
    expect(after === `${before}abcdefgh`, `Notepad got the first chunk only (${JSON.stringify(after)})`);
    const notes = (await service.observe(caller, { app: "Ensemble", screenshot: false })).tree?.elements.find((element) => element.name === "Notes");
    expect(notes && !notes.value, `nothing reached Ensemble's Notes box (${JSON.stringify(notes?.value)})`);
  }
  stopApp(coverExe);

  step("a browser Windows has registered that the program list does not know");
  launch(ironExe, ["browser", 40, 120, 420, 220]);
  const iron = await waitFor("iron.exe", (look) => look.tree?.elements.some((element) => element.name === "Approve") === true);
  const ironApp = (await listed()).find((app) => /^iron/i.test(app.name));
  console.log(`  ${ironApp?.name}: toolkit ${ironApp?.toolkit}`);
  expect(ironApp?.toolkit === "Web", "a registered browser is a browser");
  const approve = await service.act(caller, { steps: [{ action: "press", element: iron.tree!.elements.find((element) => element.name === "Approve")!.id }], observe: false });
  console.log(`  Approve, by its element: ${JSON.stringify(approve.steps)}`);
  expect(approve.steps[0]!.verdict === "refused" && approve.steps[0]!.rule === "ensemble_page", "its window titled with a Hub page's title is refused as an Ensemble page");
  for (const child of children.splice(0)) child.kill();

  step("close Notepad without saving");
  if (!held && (await notepadText()) && (await notepadInFront())) console.log(`  cleared: ${JSON.stringify((await service.act(caller, { foreground: true, steps: [{ action: "key", keys: "ctrl+a" }, { action: "key", keys: "BackSpace" }], observe: false })).steps)}`);
  // A title bar's Close button is not pressed through UI Automation in the background (cua-driver posts a click that
  // the title bar ignores): alt+F4 goes to Notepad in front, or its File menu's Exit is pressed in the background.
  if (!held && expect(await notepadInFront(), `Notepad is in front for alt+F4 (${(await frontApp()) ?? "no app"})`)) {
    // Windows may not see Notepad read the keys before its window closes: then they ran "maybe", never "no".
    const closing = await service.act(caller, { foreground: true, steps: [{ action: "key", keys: "alt+F4" }], observe: false });
    console.log(`  alt+F4: ${JSON.stringify(closing.steps)}`);
    expect(closing.steps[0]!.ran !== "no", `alt+F4 ran (${closing.steps[0]!.ran})`);
  } else if (held) {
    await exitByMenu();
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
    else if (presses === 3 && !held) console.log(`  Don't Save by its key (n), in front of ${(await frontApp()) ?? "no app"}: ${JSON.stringify((await service.act(caller, { foreground: true, steps: [{ action: "key", keys: "n" }], observe: false })).steps)}`);
  }
  if (held && gone < 2) onScreen(() => false, "Notepad closed without saving (alt+F4 needs it in front; its File menu's Exit in the background did not close it)");
  else expect(gone >= 2, "Notepad is closed");
  console.log(`  the owner was asked about: ${JSON.stringify(asked)}`);
  expect(asked.some((item) => item.startsWith("screen")), "the owner's screen was asked for");
  writeFileSync(join(out, "result.json"), JSON.stringify({ ok: failures.length === 0, failures, unchecked, held, seconds: (Date.now() - started) / 1000, readiness: { checks: readiness.checks, recorder: readiness.recorder } }, null, 2));
} finally {
  for (const child of children) child.kill();
  await service.stop().catch(() => undefined);
  await driver.stop().catch(() => undefined);
  powershell(`Remove-Item -Path '${IRON_KEY}' -Recurse -Force -ErrorAction SilentlyContinue`);
}
if (unchecked.length) {
  // Said on the job's page: these need the owner's screen, which this runner does not give.
  const why = `${held}, a window that is no app's, holds the foreground on this runner and covers the desktop (screen.png in the artifact shows it), so what needs the owner's screen was not checked here: ${unchecked.join("; ")}. The background steps were checked.`;
  console.log(`::warning title=Desktop control smoke: the owner's screen was not checked::${why}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Desktop control smoke\n\n${why}\n`);
}
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  process.exit(1);
}
step(unchecked.length ? `all checks passed but ${unchecked.length} that need the owner's screen` : "all checks passed");

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
      if (afterCall) await afterCall(name);
      return result;
    } catch (error) {
      console.log(`    cua ${name}(${brief(args).slice(0, 300)}) failed after ${Date.now() - began} ms: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
      throw error;
    }
  };
  return seen;
}

/** A cua-driver tool called directly, for what the smoke shows about the driver itself. */
async function raw(name: string, args: Record<string, unknown>): Promise<McpResult> {
  return (driver as unknown as { mcp: { call(name: string, args: Record<string, unknown>, options: { timeoutMs: number }): Promise<McpResult> } }).mcp.call(name, args, { timeoutMs: 15_000 });
}

function rect(box: { x: number; y: number; width: number; height: number }): number[] {
  return [box.x, box.y, box.width, box.height];
}

function center(box: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

function launch(exe: string, args: Array<string | number>): void {
  children.push(spawn(exe, args.map(String), { stdio: "ignore", detached: false }));
}

/** Ends the smoke's windows started from `exe`. */
function stopApp(exe: string): void {
  for (const child of children.filter((item) => item.spawnfile === exe)) child.kill();
}

/** The app's elements once `ready` says they show. */
async function waitFor(app: string, ready: (look: Observation) => boolean): Promise<Observation> {
  let look: Observation | null = null;
  for (let tries = 0; tries < 40 && !(look && ready(look)); tries += 1) {
    await sleep(500);
    look = await service.observe(caller, { app, screenshot: false }).catch(() => null);
  }
  assert.ok(look && ready(look), `${app}'s window can be read`);
  return look;
}

/** The window Windows finds at a point (screen pixels), as desktop control asks for it before a click. */
async function hitAt(point: { x: number; y: number }): Promise<string> {
  const answer = await driver.call<{ hit_test?: { ok: boolean; hits?: Array<{ app: HelperApp; window: { title: string } } | null> } }>("a11y.apps", { points: [[point.x, point.y]] }, { timeoutMs: 30_000 });
  if (!answer.hit_test?.ok) return "nothing Windows could say";
  return [...new Set((answer.hit_test.hits ?? []).map((hit) => (hit ? `${hit.app.name} “${hit.window.title}”` : "no window")))].join(" or ");
}

/** A click by position (screen pixels) on a fresh screenshot, in the foreground. */
async function clickAt(point: { x: number; y: number }): Promise<{ verdict: string; ran: string; rule?: string; detail?: string }> {
  const aim = await service.observe(caller, { elements: false });
  const done = await service.act(caller, { foreground: true, captureId: aim.captureId, steps: [{ action: "click", x: Math.round(point.x / aim.scale!), y: Math.round(point.y / aim.scale!) }], observe: false });
  return done.steps[0]!;
}

/** Notepad in front: brought there by an open step, else by a click into its text. */
async function notepadInFront(): Promise<boolean> {
  if (/notepad/i.test((await frontApp()) ?? "")) return true;
  console.log(`  bring Notepad forward: ${JSON.stringify((await service.act(caller, { foreground: true, steps: [{ action: "open", app: "Notepad" }], observe: false })).steps)}`);
  if (/notepad/i.test((await frontApp()) ?? "")) return true;
  const at = await editorPoint();
  const aim = await service.observe(caller, { elements: false });
  console.log(`  click into its text: ${JSON.stringify((await service.act(caller, { foreground: true, steps: [{ action: "click", x: Math.round(at.x / aim.scale!), y: Math.round(at.y / aim.scale!), captureId: aim.captureId }], observe: false })).steps)}`);
  return /notepad/i.test((await frontApp()) ?? "");
}

/** The app in front with its window's title, as desktop control sees it; null when no app is. */
async function frontApp(): Promise<string | null> {
  const look = await service.observe(caller, { screenshot: false, elements: false }).catch(() => null);
  frontAppName = look?.focus?.app ? `${look.focus.app}${look.focus.window ? ` “${look.focus.window}”` : ""}` : "";
  return frontAppName || null;
}

/** The program and window class of the foreground window, from Windows itself (Windows PowerShell 5.1). */
function foregroundHolder(): string {
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public static class Fg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n); }'; $h = [Fg]::GetForegroundWindow(); $p = [uint32]0; [void][Fg]::GetWindowThreadProcessId($h, [ref]$p); $c = New-Object System.Text.StringBuilder 256; [void][Fg]::GetClassName($h, $c, 256); "$((Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName).exe (window class $c)"`;
  return powershell(script).stdout.trim().split("\n").pop()?.trim() || "a window Windows did not name";
}

/** Notepad's File menu, then Exit (or Close window), pressed through UI Automation in the background. */
async function exitByMenu(): Promise<void> {
  const look = await service.observe(caller, { app: "Notepad", screenshot: false, maxElements: 200 });
  const file = look.tree?.elements.find((element) => element.role === "menu item" && /^file$/i.test(element.name));
  if (!file) return void console.log("  no File menu");
  console.log(`  File, in the background: ${JSON.stringify((await service.act(caller, { steps: [{ action: "press", element: file.id }], observe: false })).steps)}`);
  for (let tries = 0; tries < 6; tries += 1) {
    await sleep(500);
    const menu = await service.observe(caller, { app: "Notepad", screenshot: false, maxElements: 300 }).catch(() => null);
    const exit = menu?.tree?.elements.find((element) => /^(?:exit|close window)$/i.test(element.name.replace(/&/g, "").trim()));
    if (!exit) {
      if (tries === 5) console.log(`  no Exit among ${JSON.stringify(menu?.tree?.elements.map((element) => `${element.id} ${element.role} ${element.name}`).slice(0, 60))}`);
      continue;
    }
    console.log(`  ${exit.name}, in the background: ${JSON.stringify((await service.act(caller, { steps: [{ action: "press", element: exit.id }], observe: false })).steps)}`);
    return;
  }
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

/** A point in Notepad's text area on the screen, in screen pixels (its window's place plus its place in the window), and the area's middle. */
async function editorPoint(): Promise<{ x: number; y: number; at: { x: number; y: number } }> {
  const area = await editor();
  const window = (await listed()).find((app) => /notepad/i.test(`${app.name} ${app.app_id ?? ""}`))?.windows.find((item) => item.showing && item.box);
  assert.ok(area.box && window?.box, `where Notepad's text is: ${JSON.stringify({ box: area.box, window })}`);
  const x = Math.round(window.box[0] + area.box[0] + area.box[2] / 2);
  return { x, y: Math.round(window.box[1] + area.box[1] + Math.min(area.box[3] / 2, 40)), at: { x, y: Math.round(window.box[1] + area.box[1] + area.box[3] / 2) } };
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
