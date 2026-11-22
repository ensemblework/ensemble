import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTestDirectory } from "../../test/temporary.js";

const root = makeTestDirectory("desktop-windows-");
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");

const { WindowsCuaDriver, findFfmpeg, parseWindowsCombo, programName, UAC_TEXT } = await import("./drivers/windows-cua.js");
const { decodePng } = await import("./drivers/png.js");
const { DesktopError, DesktopService } = await import("./service.js");
const { HelperProcess } = await import("./helper-process.js");
const { Desktops } = await import("./screens.js");
const { cuaDriverPin, desktopSystem, helperCommand, NO_AGENT_SCREEN_WINDOWS, NO_CUA_DRIVER_WINDOWS, windowsCuaDriverCommand, windowsCuaDriverPin, windowsProbeCommand } = await import("./index.js");
const { probeWindows, windowsReadiness } = await import("./readiness.js");
const { ensembleWindow, keyboardFloor } = await import("./floor.js");
const { sensitiveApp } = await import("./sensitive.js");
type Service = InstanceType<typeof DesktopService>;
type Driver = InstanceType<typeof WindowsCuaDriver>;
type Caller = import("./service.js").Caller;
type GateApp = import("./service.js").GateApp;

const FAKE = fileURLToPath(new URL("./fake-cua-driver.mjs", import.meta.url));
const PROBE = fileURLToPath(new URL("./fake-windows-probe.mjs", import.meta.url));

// A Windows PC with a 2880×1800 display at 150%: Notepad in front, the Ensemble app beside it, Edge minimised,
// PowerShell below them, Notes (a web view) at the back, Paint installed but not running.
const PC = {
  platform: "windows",
  screen: { width: 2880, height: 1800, scale: 1.5 },
  apps: [
    { pid: 201, name: "Notepad", bundle_id: "C:\\Windows\\System32\\notepad.exe", launch_path: "C:\\Windows\\System32\\notepad.exe", running: true, active: true },
    { pid: 202, name: "Ensemble", bundle_id: "C:\\Program Files\\Ensemble\\Ensemble.exe", launch_path: "C:\\Program Files\\Ensemble\\Ensemble.exe", running: true, active: false },
    { pid: 203, name: "Microsoft Edge", bundle_id: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", running: true, active: false },
    { pid: 204, name: "Windows PowerShell", bundle_id: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", launch_path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", running: true, active: false },
    { pid: 205, name: "Paint", bundle_id: "Microsoft.Paint_8wekyb3d8bbwe!App", launch_path: "shell:appsFolder\\Microsoft.Paint_8wekyb3d8bbwe!App", running: false, active: false },
    { pid: 206, name: "Notes", bundle_id: null, running: true, active: false },
  ],
  windows: [
    { window_id: 11, pid: 201, app_name: "notepad.exe", title: "Untitled - Notepad", bounds: { x: 150, y: 150, width: 1200, height: 900 }, is_on_screen: true, z_index: 30, layer: 0, minimized: false },
    { window_id: 21, pid: 202, app_name: "Ensemble.exe", title: "Ensemble", bounds: { x: 1425, y: 150, width: 450, height: 900 }, is_on_screen: true, z_index: 20, layer: 0, minimized: false },
    { window_id: 31, pid: 203, app_name: "msedge.exe", title: "Approvals - Microsoft Edge", bounds: { x: 0, y: 0, width: 1200, height: 900 }, is_on_screen: false, z_index: 2, layer: 0, minimized: true },
    { window_id: 41, pid: 204, app_name: "powershell.exe", title: "Windows PowerShell", bounds: { x: 0, y: 1080, width: 900, height: 600 }, is_on_screen: true, z_index: 10, layer: 0, minimized: false },
    { window_id: 61, pid: 206, app_name: "notes.exe", title: "Notes", bounds: { x: 1500, y: 1100, width: 600, height: 500 }, is_on_screen: true, z_index: 5, layer: 0, minimized: false },
  ],
  elements: {
    "11": [
      { element_index: 1, role: "Edit", label: "Text Editor", value: "", actions: ["set_value", "text", "scroll"], frame: { x: 160, y: 220, w: 1180, h: 820 }, enabled: true, depth: 2 },
      { element_index: 2, role: "MenuItem", label: "File", actions: ["expand"], frame: { x: 160, y: 190, w: 40, h: 24 }, enabled: true, depth: 2 },
      { element_index: 3, role: "CheckBox", label: "Word wrap", actions: ["toggle"], selected: true, frame: { x: 220, y: 190, w: 90, h: 24 }, enabled: true, depth: 2 },
      { element_index: 4, role: "Edit", label: "Password", is_password: true, actions: ["set_value"], frame: { x: 160, y: 1000, w: 300, h: 24 }, enabled: true, depth: 2 },
      { element_index: 5, role: "Button", label: "Bold", actions: ["toggle"], selected: false, frame: { x: 320, y: 190, w: 30, h: 24 }, enabled: true, depth: 2 },
    ],
    "21": [{ element_index: 1, role: "Button", label: "Allow", actions: ["invoke"], frame: { x: 1500, y: 300, w: 80, h: 30 }, enabled: true }],
    "31": [{ element_index: 1, role: "Button", label: "Allow", actions: ["invoke"], frame: { x: 30, y: 30, w: 80, h: 30 }, enabled: true }],
    "41": [{ element_index: 1, role: "Document", label: "Console", value: "PS C:\\> ", actions: ["set_value", "text"], frame: { x: 10, y: 1110, w: 880, h: 560 }, enabled: true }],
    "61": [
      { element_index: 1, role: "Document", label: "Notes", value: "https://notes.example.com/today", in_web_content: true, actions: ["text"], frame: { x: 1510, y: 1130, w: 580, h: 460 }, enabled: true },
      { element_index: 2, role: "Button", label: "New note", actions: ["invoke"], in_web_content: true, frame: { x: 1520, y: 1140, w: 90, h: 30 }, enabled: true },
    ],
  },
  focused: { window: 11, index: 1 },
};

const drivers: Driver[] = [];
const services: Service[] = [];
let counter = 0;

function pc(options: { world?: Record<string, unknown>; probe?: Record<string, unknown>; ffmpeg?: string | null; stopGraceMs?: number } = {}) {
  const dir = join(root, `pc-${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  const state = join(dir, "state.json");
  const probeState = join(dir, "probe.json");
  const log = join(dir, "calls.log");
  const probeLog = join(dir, "probe.log");
  writeFileSync(state, JSON.stringify({ ...structuredClone(PC), ...options.world }));
  writeFileSync(probeState, JSON.stringify(options.probe ?? {}));
  const set = (patch: Record<string, unknown>) => writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, "utf8")), ...patch }));
  const session = (patch: Record<string, unknown>) => writeFileSync(probeState, JSON.stringify({ ...JSON.parse(readFileSync(probeState, "utf8")), ...patch }));
  const lines = (file: string) =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const calls = (): Array<{ tool: string; args: Record<string, unknown> }> => lines(log);
  const env = { PATH: process.env.PATH ?? "", FAKE_CUA_STATE: state, FAKE_CUA_LOG: log, FAKE_PROBE_STATE: probeState, FAKE_PROBE_LOG: probeLog };
  const command = () => ({ command: process.execPath, args: [FAKE], env });
  const probeCommand = () => ({ command: process.execPath, args: [PROBE], env });
  const probe = new HelperProcess({ spawn: probeCommand, helloTimeoutMs: 10_000 });
  const ffmpeg = options.ffmpeg === undefined ? null : options.ffmpeg;
  const driver = new WindowsCuaDriver({ spawn: command, version: "0.56.6", workDir: join(dir, "cua"), probe, ffmpeg: () => ffmpeg, helloTimeoutMs: 10_000, ...(options.stopGraceMs ? { stopGraceMs: options.stopGraceMs } : {}) });
  const service = new DesktopService({ helper: driver, captureDir: join(dir, "captures"), platform: "win32", secretValues: async () => ["saved-value-123"] });
  drivers.push(driver);
  services.push(service);
  return { driver, service, set, session, calls, probeCalls: () => lines(probeLog) as Array<{ method: string }>, command, probeCommand, dir };
}

const caller = (key = "node:n1:m1", extra: Partial<Caller> = {}): Caller => ({ key, label: `@${key}`, budgetMs: 30_000, gate: async () => ({ allow: true }), ...extra });

async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("waited too long");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

after(async () => {
  for (const service of services) await service.stop();
  for (const driver of drivers) await driver.stop();
  rmSync(root, { recursive: true, force: true });
});

test("win32: cua-driver.exe beside the sidecar's Node, on pipes only, with Windows' own variables and no secrets; the probe under PowerShell 5.1", () => {
  const bin = join(root, "win-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "cua-driver.exe"), "");
  const env = {
    SystemRoot: "C:\\Windows",
    Path: "C:\\Windows\\System32;C:\\Tools",
    LOCALAPPDATA: "C:\\Users\\mira\\AppData\\Local",
    USERPROFILE: "C:\\Users\\mira",
    TEMP: "C:\\Users\\mira\\AppData\\Local\\Temp",
    ENSEMBLE_REMOTE_STATE_DIR: join(root, "state"),
    ENSEMBLE_CUA_DRIVER_DIR: bin,
    OPENAI_API_KEY: "sk-not-for-the-driver",
    ENSEMBLE_DESKTOP_TOKEN: "not-for-the-driver",
    PSModulePath: "C:\\Users\\mira\\Documents\\PowerShell\\Modules",
  };
  const spec = windowsCuaDriverCommand(env, process.execPath, "C:\\ffmpeg\\bin\\ffmpeg.exe");
  assert.ok(!("unavailable" in spec), JSON.stringify(spec));
  assert.equal(spec.command, join(bin, "cua-driver.exe"));
  assert.deepEqual(spec.args, ["mcp", "--direct", "--no-overlay"], "its own runtime on our pipes, no daemon, no cursor of its own");
  for (const [key, value] of Object.entries({ DO_NOT_TRACK: "1", CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", CUA_TELEMETRY_ENABLED: "0", CUA_DRIVER_RS_UPDATE_CHECK: "0", CUA_DRIVER_PERMISSION_MODE: "standard", CUA_DRIVER_DISABLE_RUN_SCRIPT: "1", SystemRoot: "C:\\Windows", LOCALAPPDATA: env.LOCALAPPDATA })) assert.equal(spec.env[key], value, key);
  assert.equal(spec.env.PATH, "C:\\Windows\\System32;C:\\Tools;C:\\ffmpeg\\bin", "ffmpeg's folder, so cua-driver can record");
  for (const key of ["OPENAI_API_KEY", "ENSEMBLE_DESKTOP_TOKEN", "ENSEMBLE_CUA_DRIVER_DIR", "ENSEMBLE_REMOTE_STATE_DIR", "PSModulePath", "Path"]) assert.equal(spec.env[key], undefined, key);
  assert.deepEqual(helperCommand(env, "win32", "agent"), { unavailable: NO_AGENT_SCREEN_WINDOWS });
  assert.deepEqual(helperCommand({ ...env, ENSEMBLE_CUA_DRIVER_DIR: join(root, "missing") }, "win32"), { unavailable: NO_CUA_DRIVER_WINDOWS });
  const probe = windowsProbeCommand(env);
  assert.ok(!("unavailable" in probe));
  assert.equal(probe.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(probe.args.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
  assert.match(probe.args[6]!, /desktop-helper[\\/]windows[\\/]probe\.ps1$/);
  assert.ok(existsSync(probe.args[6]!));
  assert.equal(probe.env.OPENAI_API_KEY, undefined);
  assert.equal(desktopSystem("win32"), true);
  // Pinned by checksum, the same version as the Mac's, for both Windows architectures.
  const pin = windowsCuaDriverPin();
  assert.equal(pin.version, cuaDriverPin().version);
  assert.equal(pin.publisher, "Cua AI, Inc.");
  for (const arch of ["x64", "arm64"] as const) {
    const asset = pin.assets[arch];
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.match(asset.exeSha256, /^[0-9a-f]{64}$/);
    assert.equal(asset.url, `https://github.com/trycua/cua/releases/download/${pin.tag}/${asset.asset}`);
    assert.match(asset.member, /\/cua-driver\.exe$/);
  }
});

test("readiness: the owner's interactive session, UI Automation and a screenshot that is not black prove it, with what to do otherwise", async () => {
  const check = async (world: Record<string, unknown>, probe: Record<string, unknown>, ffmpeg: string | null = null) => {
    const h = pc({ world, probe });
    return windowsReadiness(await probeWindows(h.command(), h.probeCommand(), "0.56.6", 10_000), null, "stopped", ffmpeg);
  };
  const ok = await check({}, {});
  assert.deepEqual([ok.ready, ok.session, ok.background, ok.consent, ok.recorder], [true, "windows", true, "remembered", null]);
  assert.deepEqual(ok.checks, { interactive: true, uia: true, screenshot: true, scale: 1.5 });
  assert.equal(ok.agentScreen.reason, NO_AGENT_SCREEN_WINDOWS);
  assert.equal((await check({}, {}, "C:\\ffmpeg\\bin\\ffmpeg.exe")).recorder, "mp4");
  const service = await check({}, { session: { id: 0, service: true, connect: "active", visible: false } });
  assert.deepEqual([service.ready, service.background], [false, false]);
  assert.match(service.reason!, /session 0 here \(as a service\), which has no screen/);
  const away = await check({}, { session: { id: 2, service: false, connect: "disconnected", visible: true } });
  assert.match(away.reason!, /disconnected/);
  const noUia = await check({}, { uia: false });
  assert.deepEqual([noUia.ready, noUia.background], [false, false]);
  assert.match(noUia.reason!, /UI Automation does not answer/);
  const black = await check({ blackScreen: true }, {});
  assert.deepEqual([black.ready, black.background, black.checks?.screenshot], [false, true, false], "never assumed: a black screenshot is no proof");
  const uac = await check({ blackScreen: true }, { input_desktop: null, uac: true });
  assert.match(uac.reason!, /User Account Control prompt is open/);
  assert.equal(windowsReadiness(null, NO_CUA_DRIVER_WINDOWS, "stopped", null).reason, NO_CUA_DRIVER_WINDOWS);
});

test("observe: a PNG of the main display in its own pixels at 150%, and UI Automation's elements in the helper's words", async () => {
  const h = pc();
  const look = await h.service.observe(caller(), { app: "Notepad" });
  assert.equal(look.screen, "owner");
  assert.deepEqual([look.display!.width, look.display!.height], [2880, 1800], "physical pixels, not scaled again");
  assert.deepEqual([look.image!.width, look.image!.height], [1568, 980]);
  assert.equal(look.focus!.app, "Notepad");
  const elements = Object.fromEntries(look.tree!.elements.map((element) => [element.id, element]));
  assert.deepEqual([elements.e1!.role, elements.e1!.name, elements.e1!.box], ["text", "Text Editor", [10, 70, 1180, 820]]);
  assert.ok(elements.e1!.states.includes("editable"));
  assert.deepEqual(elements.e1!.actions, ["set value", "text", "scroll"]);
  assert.deepEqual([elements.e2!.role, elements.e2!.actions], ["menu item", ["expand"]]);
  assert.equal(elements.e3!.role, "check box");
  assert.ok(elements.e3!.states.includes("checked"));
  assert.deepEqual([elements.e4!.role, elements.e4!.value], ["password text", undefined]);
  assert.equal(elements.e5!.role, "toggle button");
  const status = await h.service.status();
  assert.equal(status.facts.dpi!.state, "working");
  assert.match(String(status.facts.dpi!.detail), /2880×1800 pixels at 150% \(144 dpi\)/);
  assert.equal(status.facts.session!.state, "working");
  assert.equal(status.facts.uia!.state, "working");
  assert.match(String(status.facts.driver!.detail), /Medium integrity/);
  assert.equal(status.facts.agent_screen!.state, "failed");
});

test("background: elements through UI Automation without the owner's pointer or keyboard; anything else needs their screen; apps open behind", async () => {
  const h = pc();
  const look = await h.service.observe(caller(), { app: "Notepad" });
  const clicked = await h.service.act(caller(), { captureId: look.captureId, steps: [{ action: "click", x: 300, y: 300 }] });
  assert.deepEqual([clicked.steps[0]!.verdict, clicked.steps[0]!.ran, clicked.steps[0]!.code], ["refused", "no", "needs_screen"]);
  assert.doesNotMatch(clicked.steps[0]!.detail!, /agent screen/, "Windows has none to offer");
  const typed = await h.service.act(caller(), { steps: [{ action: "type", text: "hello" }] });
  assert.equal(typed.steps[0]!.code, "needs_screen");
  assert.ok(!h.calls().some((call) => ["click", "type_text", "move_cursor"].includes(call.tool)), "nothing reached the pointer or keyboard");

  await h.service.observe(caller(), { app: "Notepad", screenshot: false });
  const done = await h.service.act(caller(), { steps: [{ action: "type", element: "e1", text: "Ensemble 0.9.1" }, { action: "toggle", element: "e3" }, { action: "key", element: "e1", keys: "ctrl+a" }] });
  assert.deepEqual(done.steps.map((step) => [step.verdict, step.ran]), [["confirmed", "yes"], ["confirmed", "yes"], ["unknown", "yes"]]);
  const calls = h.calls();
  assert.match(String(calls.find((call) => call.tool === "type_text")!.args.element_token), /:1$/);
  assert.equal(calls.find((call) => call.tool === "type_text")!.args.scope, undefined);
  assert.deepEqual(calls.find((call) => call.tool === "hotkey")!.args.keys, ["ctrl", "a"]);
  const again = await h.service.observe(caller(), { app: "Notepad", screenshot: false });
  assert.equal(again.tree!.elements.find((element) => element.id === "e1")!.value, "Ensemble 0.9.1", "read back through UI Automation");

  const asked: GateApp[] = [];
  const quiet = caller("node:n1:m1", { gate: async (app) => (asked.push(app), { allow: false, ask: true }) });
  const opened = await h.service.open(quiet, { app: "Paint", waitSec: 1 });
  assert.deepEqual([opened.focused, opened.via], [false, "background"]);
  assert.deepEqual(asked, [], "opening behind the owner's windows asks nothing");
  assert.ok(h.calls().some((call) => call.tool === "launch_app" && call.args.aumid === "Microsoft.Paint_8wekyb3d8bbwe!App"), "a packaged app by its AppUserModelID");
  await h.service.open(quiet, { app: "Notepad", waitSec: 1 });
  assert.ok(h.calls().some((call) => call.tool === "launch_app" && call.args.launch_path === "C:\\Windows\\System32\\notepad.exe"), "a desktop app by its launch path");
  assert.ok(!h.calls().some((call) => call.tool === "bring_to_front"));
});

test("the floor: Ensemble's own windows, browsers (minimised too), pages that show Ensemble and Windows' prompts are refused; other web views are not", async () => {
  const consent = { window_id: 71, pid: 207, app_name: "consent.exe", title: "User Account Control", bounds: { x: 900, y: 500, width: 700, height: 500 }, is_on_screen: true, z_index: 40, layer: 0, minimized: false };
  const h = pc({ world: { apps: [...PC.apps, { pid: 207, name: "consent.exe", bundle_id: null, running: true, active: false }], windows: [...PC.windows, consent], elements: { ...PC.elements, "71": [{ element_index: 1, role: "Button", label: "Yes", actions: ["invoke"], frame: { x: 1000, y: 900, w: 100, h: 30 }, enabled: true }] } } });
  for (const [app, rule] of [["Ensemble", "ensemble_window"], ["Microsoft Edge", "unknown_page"], ["consent.exe", "password_prompt"]] as const) {
    await h.service.observe(caller(), { app, screenshot: false });
    const done = await h.service.act(caller(), { steps: [{ action: "press", element: "e1" }] });
    assert.deepEqual([done.steps[0]!.verdict, done.steps[0]!.rule], ["refused", rule], app);
  }
  assert.ok(!h.calls().some((call) => call.tool === "click"));
  // A web view whose document says its address: refused when it is Ensemble's, allowed otherwise.
  await h.service.observe(caller(), { app: "Notes", screenshot: false });
  assert.equal((await h.service.act(caller(), { steps: [{ action: "press", element: "e2" }] })).steps[0]!.verdict, "confirmed");
  const elements = structuredClone(PC.elements) as Record<string, Array<Record<string, unknown>>>;
  elements["61"]![0]!.value = "https://app.ensemblework.com/today";
  const shown = pc({ world: { elements } });
  await shown.service.observe(caller(), { app: "Notes", screenshot: false });
  const page = await shown.service.act(caller(), { steps: [{ action: "press", element: "e2" }] });
  assert.deepEqual([page.steps[0]!.verdict, page.steps[0]!.rule], ["refused", "ensemble_page"]);
  // Clicks by position are judged by the window under them: Ensemble's, and the prompt's.
  const scale = 1568 / 2880;
  for (const [x, y, rule] of [[1600, 400, "ensemble_window"], [1000, 600, "password_prompt"]] as const) {
    const look = await h.service.observe(caller(), {});
    const done = await h.service.act(caller(), { captureId: look.captureId, foreground: true, steps: [{ action: "click", x: x * scale, y: y * scale }] });
    assert.deepEqual([done.steps[0]!.verdict, done.steps[0]!.rule], ["refused", rule], `${x},${y}: ${done.steps[0]!.detail}`);
  }
  // Titles: Ensemble's own in any app that is not a browser, and its command line in a Windows terminal.
  const notepad = { name: "Notepad", app_id: "C:\\Windows\\System32\\notepad.exe", toolkit: "Windows" };
  for (const title of ["Ensemble", "Today · Ensemble", "Ensemble Node", "Inbox · Ensemble Node"]) assert.ok(ensembleWindow(notepad, title), title);
  assert.equal(ensembleWindow(notepad, "Ensemble notes.txt - Notepad"), null);
  assert.ok(ensembleWindow({ name: "Ensemble", app_id: "C:\\Program Files\\Ensemble\\Ensemble.exe", toolkit: "Windows" }, "Settings"));
  assert.ok(ensembleWindow({ name: "Ensemble Capture", app_id: "C:\\Program Files\\Ensemble Capture\\ensemble-capture.exe", toolkit: "Windows" }, "Quick capture"));
  const terminal = { name: "Terminal", app_id: "Microsoft.WindowsTerminal_8wekyb3d8bbwe", toolkit: "Windows" };
  for (const title of ["Command Prompt - ensemble needs", "C:\\Users\\mira\\AppData\\Local\\ensemble\\bin\\ensemble.exe"]) assert.ok(ensembleWindow(terminal, title), title);
  assert.equal(ensembleWindow(terminal, "Windows PowerShell"), null);
  assert.equal(ensembleWindow({ name: "Google Chrome", app_id: "chrome.exe", toolkit: "Chromium" }, "Today · Ensemble"), null, "a browser's page is judged by its address");
  assert.equal(programName("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), "chrome");
});

test("the keyboard: refused in a prompt or on User Account Control's secure desktop, which the owner is handed; sensitive apps are asked once", async () => {
  const h = pc();
  // The node remembers an answer for the app and mission (device-tools/policy.ts): asked once, by one id.
  const asked: GateApp[] = [];
  const answered = new Set<string>();
  const owner = caller("node:n1:m1", { gate: async (app) => (answered.has(app.id) ? undefined : asked.push(app), answered.add(app.id), { allow: true }) });
  // PowerShell is a terminal: asked about once for the mission, then not again, never refused for being sensitive.
  await h.service.observe(owner, { app: "Windows PowerShell", screenshot: false });
  await h.service.act(owner, { steps: [{ action: "set_text", element: "e1", text: "Get-Date" }] });
  await h.service.observe(owner, { app: "Windows PowerShell", screenshot: false });
  await h.service.act(owner, { steps: [{ action: "set_text", element: "e1", text: "Get-Date" }] });
  assert.deepEqual(asked.map((app) => [app.category, app.name]), [["terminal", "Windows PowerShell"]]);
  for (const app of [{ name: "Settings", id: "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel" }, { name: "Terminal", id: "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App" }, { name: "KeePassXC", id: "C:\\Program Files\\KeePassXC\\KeePassXC.exe" }, { name: "Microsoft Store", id: "Microsoft.WindowsStore_8wekyb3d8bbwe!App" }, { name: "Command Prompt", id: "C:\\Windows\\System32\\cmd.exe" }]) assert.ok(sensitiveApp(app), app.name);
  assert.equal(sensitiveApp({ name: "Notepad", id: "C:\\Windows\\System32\\notepad.exe" }), null);
  assert.equal(sensitiveApp({ name: "Fieldnote", id: "C:\\Users\\mira\\Settings Backup\\fieldnote.exe" }), null, "a program file by its name, not its folders");

  // User Account Control holds the secure desktop: nothing runs, and the owner is handed it with a clear message.
  h.session({ input_desktop: null, uac: true });
  await assert.rejects(h.service.observe(owner, { app: "Notepad", screenshot: false }), (error: unknown) => error instanceof DesktopError && error.code === "screen_locked" && error.message === UAC_TEXT);
  const stopped = await h.service.act(owner, { foreground: true, steps: [{ action: "type", text: "anything" }] });
  assert.deepEqual([stopped.steps[0]!.verdict, stopped.steps[0]!.code, stopped.steps[0]!.ran], ["refused", "screen_locked", "no"]);
  assert.equal(stopped.steps[0]!.detail, UAC_TEXT);
  assert.ok(!h.calls().some((call) => call.tool === "type_text"));
  const focus = { app: { name: "Notepad", toolkit: "Windows", pid: 201, app_id: "notepad.exe" }, window: { index: 0, title: "Untitled - Notepad", role: "window" }, shell: false, prompt: { title: "User Account Control" }, focused: null, documents: [] };
  assert.equal(keyboardFloor(focus)?.rule, "password_prompt");
});

test("the owner's pointer and keyboard are asked once per mission; keys and clicks go to screen pixels", async () => {
  const h = pc();
  const asked: GateApp[] = [];
  const answered = new Set<string>();
  const owner = caller("node:n1:m1", { gate: async (app) => (answered.has(app.id) ? undefined : asked.push(app), answered.add(app.id), { allow: true }) });
  const look = await h.service.observe(owner, {});
  const done = await h.service.act(owner, { captureId: look.captureId, foreground: true, steps: [{ action: "click", x: 300, y: 300 }] });
  assert.equal(done.steps[0]!.verdict, "confirmed");
  const click = h.calls().find((call) => call.tool === "click")!;
  assert.deepEqual([click.args.scope, click.args.delivery_mode], ["desktop", "foreground"]);
  assert.ok(Math.abs(Number(click.args.x) - (300.5 * 2880) / 1568) < 0.01, "the display's own pixels");
  h.set({ effects: { hotkey: "confirmed" } });
  const keys = await h.service.act(owner, { foreground: true, steps: [{ action: "key", keys: "cmd+s" }] });
  assert.equal(keys.steps[0]!.verdict, "confirmed");
  assert.deepEqual(h.calls().find((call) => call.tool === "hotkey")!.args, { keys: ["ctrl", "s"], scope: "desktop" }, "a Mac's cmd is ctrl here");
  assert.deepEqual(asked.map((app) => app.id), ["screen:owner"], "one press for the mission");
});

test("typing goes in chunks that stop when the window on top changes or the owner types, and says how much went in", async () => {
  const text = "Ensemble 0.9.1 on Windows, typed in chunks";
  const typedBy = (h: ReturnType<typeof pc>) =>
    h
      .calls()
      .filter((call) => call.tool === "type_text")
      .map((call) => String(call.args.text));
  const whole = pc();
  const all = await whole.service.act(caller(), { foreground: true, steps: [{ action: "type", text }] });
  assert.deepEqual([all.steps[0]!.verdict, all.steps[0]!.ran], ["confirmed", "yes"]);
  assert.deepEqual(typedBy(whole), ["Ensemble", " 0.9.1 o", "n Window", "s, typed", " in chun", "ks"]);
  const back = await whole.service.observe(caller(), { app: "Notepad", screenshot: false });
  assert.equal(back.tree!.elements.find((element) => element.id === "e1")!.value, text);

  const moved = pc({ world: { frontAfterTypes: { count: 2, pid: 204 } } });
  const first = await moved.service.act(caller(), { foreground: true, steps: [{ action: "type", text }] });
  assert.deepEqual([first.steps[0]!.verdict, first.steps[0]!.ran], ["partial", "yes"]);
  assert.match(first.steps[0]!.detail!, /Typing stopped after 16 of 42 characters: the window in front changed/);

  const touched = pc({ probe: { afterTypes: { count: 1, ms: 15 } } });
  const second = await touched.service.act(caller(), { foreground: true, steps: [{ action: "type", text }] });
  assert.equal(second.steps[0]!.verdict, "partial");
  assert.match(second.steps[0]!.detail!, /Typing stopped after 8 of 42 characters: your owner used the keyboard or mouse/);
  assert.equal(touched.service.lease.holder, "owner");

  // Windows counts the driver's own keys as input: the app it typed into is read at once, not waited on as the owner's.
  const own = pc({ probe: { typingIsInput: true } });
  await own.service.act(caller(), { foreground: true, steps: [{ action: "type", text: "Ensemble" }] });
  const started = Date.now();
  const read = await own.service.observe(caller(), { app: "Notepad", screenshot: false });
  assert.equal(read.tree!.elements.find((element) => element.id === "e1")!.value, "Ensemble");
  assert.ok(Date.now() - started < 3_000, `read in ${Date.now() - started} ms`);

  // User Account Control taking the secure desktop between chunks stops it too.
  const uac = pc();
  const acting = uac.service.act(caller(), { foreground: true, steps: [{ action: "type", text: "z".repeat(200) }] });
  await until(() => typedBy(uac).length >= 2);
  uac.session({ input_desktop: null, uac: true });
  const cut = await acting;
  assert.deepEqual([cut.steps[0]!.verdict, cut.steps[0]!.ran], ["partial", "yes"]);
  assert.match(cut.steps[0]!.detail!, /the window in front changed/);
});

test("a run that ends stops its typing within a chunk; stopping desktop control kills a chunk not answered; ran stays honest", async () => {
  const h = pc();
  const chunks = () => h.calls().filter((call) => call.tool === "type_text").length;
  const acting = h.service.act(caller("run:job-1"), { foreground: true, steps: [{ action: "type", text: "x".repeat(400) }] });
  await until(() => chunks() >= 3);
  const before = chunks();
  await h.service.release("run:job-1");
  const done = await acting;
  assert.ok(chunks() <= before + 1);
  assert.deepEqual([done.steps[0]!.verdict, done.steps[0]!.ran], ["partial", "yes"]);
  assert.equal(done.steps[0]!.detail, `Typing stopped after ${chunks() * 8} of 400 characters: the work it was for ended, or desktop control stopped, so the rest was not typed.`);

  const failing = pc({ world: { failAfterTypes: { count: 3, tool: "list_windows" } } });
  const failed = await failing.service.act(caller(), { foreground: true, steps: [{ action: "type", text: "The quick brown fox jumps over the lazy dog" }] });
  assert.deepEqual([failed.steps[0]!.verdict, failed.steps[0]!.ran], ["unknown", "yes"]);
  assert.match(failed.steps[0]!.detail!, /^Typing stopped after 24 of 43 characters \(the rest was not typed\)/);

  const hung = pc({ stopGraceMs: 1_000, world: { slow: { type_text: 30_000 } } });
  const stuck = hung.service.act(caller(), { foreground: true, steps: [{ action: "type", text: "y".repeat(100) }] });
  await until(() => hung.calls().some((call) => call.tool === "type_text"));
  const started = Date.now();
  await hung.driver.stop();
  assert.ok(Date.now() - started < 3_000);
  const cut = await stuck;
  assert.deepEqual([cut.steps[0]!.verdict, cut.steps[0]!.ran], ["unknown", "maybe"]);
});

test("recording: unavailable without ffmpeg, saying how to get it; with it, cua-driver's MP4", async () => {
  const none = pc();
  await assert.rejects(none.service.recordStart(caller(), { evidenceDir: join(none.dir, "evidence") }), (error: unknown) => error instanceof DesktopError && error.code === "unsupported" && /winget install Gyan\.FFmpeg/.test(error.message));
  assert.equal((await none.service.status()).facts.recorder!.state, "failed");
  const h = pc({ ffmpeg: "C:\\ffmpeg\\bin\\ffmpeg.exe" });
  await h.service.recordStart(caller(), { evidenceDir: join(h.dir, "evidence"), maxSec: 30 });
  const saved = await h.service.recordSave(caller(), { name: "Notepad typed" });
  assert.deepEqual([saved.mime, saved.width, saved.height, saved.codec], ["video/mp4", 2880, 1800, "h264"]);
  assert.deepEqual(readdirSync(join(h.dir, "cua", "recordings")), []);
});

test("no agent screen on Windows; the probe answers the helper protocol; ffmpeg is found where Windows installers put it; key names", async () => {
  const h = pc();
  const agent = new DesktopService({ screen: "agent", helper: new HelperProcess({ spawn: () => helperCommand({}, "win32", "agent") }), captureDir: join(h.dir, "agent-captures"), platform: "win32" });
  services.push(agent);
  const screens = new Desktops(h.service, () => agent, "owner");
  assert.equal(screens.pick("node:n1:m1"), "owner");
  await assert.rejects(screens.service("agent").observe(caller(), {}), (error: unknown) => error instanceof DesktopError && error.code === "unavailable" && error.message === NO_AGENT_SCREEN_WINDOWS);
  // The notice of a handoff goes through the probe.
  await h.driver.call("notify", { title: "Ensemble's agent handed you control", body: "Answer the prompt." }, { timeoutMs: 10_000 });
  assert.ok(h.probeCalls().some((call) => call.method === "notify"));

  const files = new Set(["C:\\Tools\\ffmpeg.exe", "C:\\Users\\mira\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0-full_build\\bin\\ffmpeg.exe"]);
  const dirs: Record<string, string[]> = { "C:\\Users\\mira\\AppData\\Local\\Microsoft\\WinGet\\Packages": ["Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"], "C:\\Users\\mira\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe": ["ffmpeg-8.0-full_build"] };
  const find = (env: NodeJS.ProcessEnv) => findFfmpeg(env, (path) => files.has(path), (dir) => dirs[dir] ?? []);
  assert.equal(find({ Path: "C:\\Windows;C:\\Tools\\", LOCALAPPDATA: "C:\\Users\\mira\\AppData\\Local" }), "C:\\Tools\\ffmpeg.exe");
  assert.match(find({ PATH: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\mira\\AppData\\Local" })!, /Gyan\.FFmpeg.*\\bin\\ffmpeg\.exe$/);
  assert.equal(findFfmpeg({ PATH: "C:\\Windows" }, () => false), null);

  assert.deepEqual(parseWindowsCombo("ctrl+shift+t"), { modifiers: ["ctrl", "shift"], key: "t" });
  assert.deepEqual(parseWindowsCombo("cmd+s"), { modifiers: ["ctrl"], key: "s" });
  assert.deepEqual(parseWindowsCombo("super+e"), { modifiers: ["win"], key: "e" });
  assert.deepEqual(parseWindowsCombo("alt+F4"), { modifiers: ["alt"], key: "f4" });
  assert.deepEqual(parseWindowsCombo("BackSpace"), { modifiers: [], key: "backspace" });
  assert.deepEqual(parseWindowsCombo("Delete"), { modifiers: [], key: "delete" });
  assert.deepEqual(parseWindowsCombo("Return"), { modifiers: [], key: "return" });
  assert.throws(() => parseWindowsCombo("hyper+x"), /not a modifier/);
  assert.throws(() => parseWindowsCombo("Launch"), /not a key name/);
  // The probe's own picture is never taken; its look at the display is the driver's, checked for being lit.
  const shot = await h.driver.call<{ image: { path: string } }>("frame.capture", { display: 1, max_long_edge: 200, save_path: join(h.dir, "shot.png") }, { timeoutMs: 10_000 }).catch(() => null);
  assert.equal(shot, null, "no screen control before a session starts");
  await h.driver.call("session.start", {}, { timeoutMs: 10_000 });
  const taken = await h.driver.call<{ image: { path: string } }>("frame.capture", { display: 1, max_long_edge: 200, save_path: join(h.dir, "shot.png") }, { timeoutMs: 10_000 });
  assert.equal(decodePng(readFileSync(taken.image.path)).width, 200);
});
