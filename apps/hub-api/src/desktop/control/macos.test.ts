import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTestDirectory } from "../../test/temporary.js";

const root = makeTestDirectory("desktop-macos-");
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");

const { MacosCuaDriver, parseCombo } = await import("./drivers/macos-cua.js");
const { decodePng } = await import("./drivers/png.js");
const { DesktopError, DesktopService } = await import("./service.js");
const { HelperProcess } = await import("./helper-process.js");
const { Desktops } = await import("./screens.js");
const { cuaDriverCommand, cuaDriverHostProbeCommand, cuaDriverPin, helperCommand, macosMajor, NO_AGENT_SCREEN_MAC } = await import("./index.js");
const { macReadiness, probeHost, probeMac, socketAnswers } = await import("./readiness.js");
const { DESKTOP_TRANSPORT_MS, desktopTimeoutMs, typingMs } = await import("./tool-specs.js");
const { ensembleWindow } = await import("./floor.js");
type Service = InstanceType<typeof DesktopService>;
type Driver = InstanceType<typeof MacosCuaDriver>;
type Caller = import("./service.js").Caller;
type GateApp = import("./service.js").GateApp;

const FAKE = fileURLToPath(new URL("./fake-cua-driver.mjs", import.meta.url));
/** Where the stand-in Cua Driver app is said to be (fix texts and permission requests name it). */
const APP = "/Applications/Ensemble.app/Contents/Resources/sidecar/bin/CuaDriver.app";

// A Mac with a 2560×1600 Retina display (1280×800 points): Reminders in front, the Ensemble app beside it,
// Safari at the bottom, Clock installed but not running.
const MAC = {
  screen: { width: 2560, height: 1600, scale: 2 },
  apps: [
    { pid: 101, name: "Reminders", bundle_id: "com.apple.reminders", running: true, active: true },
    { pid: 102, name: "Ensemble", bundle_id: "com.ensemblework.desktop", running: true, active: false },
    { pid: 103, name: "Clock", bundle_id: "com.apple.clock", running: false, active: false, launch_path: "/System/Applications/Clock.app" },
    { pid: 104, name: "Safari", bundle_id: "com.apple.Safari", running: true, active: false },
  ],
  windows: [
    { window_id: 11, pid: 101, app_name: "Reminders", title: "Reminders", bounds: { x: 100, y: 100, width: 800, height: 600 }, is_on_screen: true, z_index: 30, layer: 0, minimized: false },
    { window_id: 21, pid: 102, app_name: "Ensemble", title: "Ensemble", bounds: { x: 950, y: 100, width: 300, height: 600 }, is_on_screen: true, z_index: 20, layer: 0, minimized: false },
    { window_id: 31, pid: 103, app_name: "Clock", title: "Clock", bounds: { x: 200, y: 150, width: 700, height: 500 }, is_on_screen: true, z_index: 10, layer: 0, minimized: false },
    { window_id: 41, pid: 104, app_name: "Safari", title: "Start Page", bounds: { x: 0, y: 720, width: 600, height: 60 }, is_on_screen: true, z_index: 5, layer: 0, minimized: false },
  ],
  elements: {
    "11": [
      { role: "AXGroup", depth: 1 },
      { element_index: 1, role: "AXButton", title: "Add", description: "New Reminder", actions: ["AXPress"], frame: { x: 860, y: 110, w: 30, h: 24 }, enabled: true, depth: 2 },
      { element_index: 2, role: "AXTextField", label: "Buy milk", value: "Buy milk", placeholder: "New Reminder", actions: ["AXConfirm"], frame: { x: 140, y: 200, w: 500, h: 22 }, enabled: true, depth: 2 },
      { element_index: 3, role: "AXTextField", subrole: "AXSecureTextField", title: "Password", value: "••••", frame: { x: 140, y: 240, w: 500, h: 22 }, enabled: true, depth: 2 },
      { element_index: 4, role: "AXCheckBox", subrole: "AXSwitch", title: "Alarm", value: "1", actions: ["AXPress"], frame: { x: 140, y: 280, w: 40, h: 22 }, enabled: true, depth: 2 },
    ],
    "31": [
      { element_index: 1, role: "AXRadioButton", subrole: "AXTabButton", title: "Alarms", actions: ["AXPress"], selected: false, frame: { x: 300, y: 160, w: 80, h: 24 }, enabled: true },
      { element_index: 2, role: "AXButton", description: "Add Alarm", actions: ["AXPress"], frame: { x: 860, y: 160, w: 24, h: 24 }, enabled: true },
    ],
  },
};

const drivers: Driver[] = [];
const services: Service[] = [];
let counter = 0;

function mac(options: { world?: Record<string, unknown>; macosMajor?: number | null; handlers?: string[]; clock?: boolean; stopGraceMs?: number } = {}) {
  const dir = join(root, `mac-${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  const state = join(dir, "state.json");
  const log = join(dir, "calls.log");
  writeFileSync(state, JSON.stringify({ ...structuredClone(MAC), ...options.world }));
  const set = (patch: Record<string, unknown>) => writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, "utf8")), ...patch }));
  const calls = (): Array<{ tool: string; args: Record<string, unknown>; screen?: { x: number; y: number } }> =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const command = (embedded = false) => ({ command: process.execPath, args: [FAKE, ...(embedded ? ["--embedded"] : [])], env: { PATH: process.env.PATH ?? "", FAKE_CUA_STATE: state, FAKE_CUA_LOG: log } });
  // The owner last used the computer ten minutes ago, and the screen is not locked; `afterTypes` is input of
  // theirs once that many chunks were typed.
  const idle = { ms: 600_000, locked: false, afterTypes: null as null | { count: number; ms: number } };
  const temp = join(dir, "user-temp");
  mkdirSync(temp, { recursive: true });
  const execs: Array<{ program: string; args: string[] }> = [];
  // With `clock` the driver's time is a stand-in that only its pauses and `ioreg` move, so long typing runs fast.
  const clock = { now: 1_000_000 };
  const exec = async (program: string, args: string[]) => {
    execs.push({ program, args });
    if (program.endsWith("ioreg")) {
      if (options.clock) clock.now += 10;
      const typed = idle.afterTypes ? calls().filter((call) => call.tool === "type_text").length : 0;
      const ms = idle.afterTypes && typed >= idle.afterTypes.count ? idle.afterTypes.ms : idle.ms;
      return args.includes("IOHIDSystem") ? `  |   "HIDIdleTime" = ${ms * 1_000_000}\n` : `  "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes${idle.locked ? ',"CGSSessionScreenIsLocked"=Yes' : ""}})\n`;
    }
    if (program.endsWith("getconf")) return `${temp}/\n`;
    if (program.endsWith("osascript") && args.includes("JavaScript")) return `${JSON.stringify(options.handlers ?? ["com.apple.Safari"])}\n`;
    if (program.endsWith("/open")) {
      // Cua Driver's permission host writes what it found into the file it was given.
      const file = args[args.indexOf("--result-file") + 1]!;
      writeFileSync(file, JSON.stringify({ structuredContent: { accessibility: false, screen_recording: false } }));
    }
    return "";
  };
  const timing = options.clock ? { now: () => clock.now, sleep: async (ms: number) => void (clock.now += ms) } : {};
  const driver = new MacosCuaDriver({ spawn: () => command(), version: "0.56.6", workDir: join(dir, "cua"), appPath: APP, macosMajor: options.macosMajor === undefined ? 15 : options.macosMajor, exec, helloTimeoutMs: 10_000, ...(options.stopGraceMs ? { stopGraceMs: options.stopGraceMs } : {}), ...timing });
  const service = new DesktopService({ helper: driver, captureDir: join(dir, "captures"), platform: "darwin", secretValues: async () => ["saved-value-123"] });
  drivers.push(driver);
  services.push(service);
  return { driver, service, set, calls, command, idle, dir, execs, temp };
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

test("darwin: Cua Driver runs through the disclaim launcher, as its own process for macOS, with telemetry off and no secrets", () => {
  const bin = join(root, "bin");
  const executable = join(bin, "CuaDriver.app", "Contents", "MacOS", "cua-driver");
  const launcher = join(bin, "ensemble-disclaim");
  mkdirSync(join(bin, "CuaDriver.app", "Contents", "MacOS"), { recursive: true });
  for (const file of [executable, launcher]) {
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
  }
  const env = {
    HOME: root,
    PATH: "/usr/bin",
    ENSEMBLE_REMOTE_STATE_DIR: join(root, "state"),
    ENSEMBLE_RUNTIME_OWNER: "cli",
    ENSEMBLE_INSTALL_PATH: "/opt/homebrew/bin/ensemble",
    ENSEMBLE_CUA_DRIVER_DIR: bin,
    OPENAI_API_KEY: "sk-not-for-the-driver",
    ANTHROPIC_API_KEY: "not-for-the-driver",
    ENSEMBLE_DESKTOP_TOKEN: "not-for-the-driver",
  };
  const spec = helperCommand(env, "darwin");
  assert.ok(!("unavailable" in spec), JSON.stringify(spec));
  assert.equal(spec.command, launcher, "the launcher disclaims, so macOS asks about Cua Driver and never Ensemble");
  assert.deepEqual(spec.args, [executable, "mcp", "--direct"]);
  for (const [key, value] of Object.entries({ DO_NOT_TRACK: "1", CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", CUA_TELEMETRY_ENABLED: "0", CUA_DRIVER_RS_UPDATE_CHECK: "0", CUA_DRIVER_PERMISSION_MODE: "standard", CUA_DRIVER_DISABLE_RUN_SCRIPT: "1" })) assert.equal(spec.env[key], value, key);
  for (const key of ["CUA_DRIVER_EMBEDDED", "CUA_DRIVER_HOST_BUNDLE_ID", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ENSEMBLE_DESKTOP_TOKEN", "ENSEMBLE_CUA_DRIVER_DIR", "ENSEMBLE_REMOTE_STATE_DIR"]) assert.equal(spec.env[key], undefined, key);
  // Only the Ensemble app's own runtime checks the app's grants: in embedded mode, with no launcher.
  assert.equal(cuaDriverHostProbeCommand(env), null);
  const app = { ...env, ENSEMBLE_RUNTIME_OWNER: "desktop", ENSEMBLE_INSTALL_PATH: "/Applications/Ensemble.app/Contents/MacOS/ensemble-desktop" };
  const host = cuaDriverHostProbeCommand(app)!;
  assert.deepEqual([host.command, host.args, host.env.CUA_DRIVER_EMBEDDED], [executable, ["mcp", "--direct", "--embedded"], "1"]);
  assert.deepEqual(helperCommand(env, "darwin", "agent"), { unavailable: NO_AGENT_SCREEN_MAC });
  assert.match((helperCommand({ ...env, ENSEMBLE_CUA_DRIVER_DIR: join(root, "missing") }, "darwin") as { unavailable: string }).unavailable, /install or update the Ensemble app/);
  assert.match((cuaDriverCommand(env, process.execPath, "21.6.0") as { unavailable: string }).unavailable, /macOS 13 or later; this Mac runs macOS 12/);
  assert.deepEqual([macosMajor("22.6.0"), macosMajor("24.1.0"), macosMajor("25.0.0"), macosMajor("6.8.0-45-generic")], [13, 15, 26, null]);
  const pin = cuaDriverPin();
  assert.equal(pin.version, "0.56.6");
  assert.equal(pin.member, "cua-driver-rs-0.56.6-darwin-universal/CuaDriver.app");
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  assert.equal(pin.url, `https://github.com/trycua/cua/releases/download/${pin.tag}/${pin.asset}`);
});

test("a cua-driver of another version is not used", async () => {
  const { driver } = mac({ world: { version: "0.57.0" } });
  await assert.rejects(driver.call("status", {}, { timeoutMs: 10_000 }), (error: unknown) => (error as { kind?: string }).kind === "unavailable" && /0\.57\.0/.test(String((error as Error).message)) && /0\.56\.6/.test(String((error as Error).message)));
  assert.equal(driver.health().state, "unavailable");
});

test("readiness: Cua Driver's own permission check and a test screenshot prove it, never ready on a failed probe, with the exact fix", async () => {
  const probe = (world: Record<string, unknown>) => probeMac(mac({ world }).command(), "0.56.6", 10_000);
  const off = macReadiness(await probe({ accessibility: false, screen_recording: false }), null, "stopped", 15, null, APP);
  assert.equal(off.ready, false);
  assert.equal(off.background, false);
  assert.match(off.reason!, /System Settings › Privacy & Security › Accessibility: turn on Cua Driver/);
  assert.ok(off.reason!.includes(APP), "where to find it when macOS does not list it");
  const noScreen = await probe({ accessibility: true, screen_recording: false });
  const partly = macReadiness(noScreen, null, "stopped", 15, null, APP);
  assert.equal(partly.ready, false);
  assert.equal(partly.background, true, "elements can still be read and pressed");
  assert.match(partly.reason!, /System Settings › Privacy & Security › Screen & System Audio Recording: turn on Cua Driver/);
  assert.match(macReadiness(noScreen, null, "stopped", 14, null, APP).reason!, /Privacy & Security › Screen Recording: turn on Cua Driver/);
  const blank = macReadiness(await probe({ screenshotFails: true }), null, "stopped", 15, null, APP);
  assert.equal(blank.ready, false, "Screen Recording on, but the test screenshot failed");
  assert.deepEqual(blank.permissions, { accessibility: true, screenRecording: true, screenshot: false });
  const on = macReadiness(await probe({}), null, "stopped", 15, null, APP);
  assert.equal(on.ready, true);
  assert.equal(on.consent, "remembered");
  assert.deepEqual(on.permissions, { accessibility: true, screenRecording: true, screenshot: true });
  assert.equal(on.recorder, "mp4");
  assert.equal(on.agentScreen.ready, false);
  assert.equal(on.agentScreen.reason, NO_AGENT_SCREEN_MAC);
  assert.equal(macReadiness(await probe({}), null, "stopped", 14, null, APP).recorder, null, "video needs macOS 15");
  const missing = macReadiness(null, "Desktop control on a Mac needs the Ensemble app.", "stopped", 15, null, APP);
  assert.equal(missing.ready, false);
});

test("readiness: an Ensemble app holding Accessibility or Screen Recording itself is not ready, since everything it starts would inherit them", async () => {
  const h = mac({ world: { host_screen_recording: true } });
  const host = await probeHost(h.command(true), "0.56.6", 10_000);
  assert.deepEqual(host, { accessibility: false, screenRecording: true });
  const leaking = macReadiness(await probeMac(h.command(), "0.56.6", 10_000), null, "stopped", 15, host, APP);
  assert.deepEqual([leaking.ready, leaking.background], [false, false]);
  assert.match(leaking.reason!, /Ensemble itself is allowed/);
  assert.match(leaking.reason!, /turn Ensemble off under Accessibility and under Screen & System Audio Recording/);
  assert.equal(macReadiness(await probeMac(h.command(), "0.56.6", 10_000), null, "stopped", 15, { accessibility: false, screenRecording: false }, APP).ready, true);
});

test("readiness notes Cua Driver's own daemon when something answers on its socket, and not for a file left behind", async () => {
  const path = join(root, "daemon.sock");
  assert.equal(await socketAnswers(path), false);
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(path, resolve));
  assert.equal(await socketAnswers(path), true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(path, { force: true });
  writeFileSync(path, "");
  assert.equal(await socketAnswers(path), false);
});

test("the service asks for each grant with its fix, has macOS ask for Cua Driver once, and takes the grant once given (a fresh driver reads it again)", async () => {
  const h = mac({ world: { accessibility: false, screen_recording: false } });
  const status = await h.service.status();
  assert.equal(status.facts.accessibility!.state, "needed");
  assert.match(status.facts.accessibility!.fix!, /^System Settings › Privacy & Security › Accessibility: turn on Cua Driver/);
  assert.equal(status.facts.screen_recording!.state, "needed");
  assert.equal(status.facts.agent_screen!.state, "failed");
  await assert.rejects(h.service.observe(caller(), {}), (error: unknown) => error instanceof DesktopError && error.code === "consent_needed" && /Screen & System Audio Recording: turn on Cua Driver/.test(error.message));
  await assert.rejects(h.service.observe(caller(), { app: "Reminders", screenshot: false }), (error: unknown) => error instanceof DesktopError && error.code === "consent_needed" && /Accessibility: turn on Cua Driver/.test(error.message));
  // Cua Driver's own permission host asks macOS, under Cua Driver's name, once while the same grants are missing.
  const asked = h.execs.filter((run) => run.program === "/usr/bin/open");
  assert.equal(asked.length, 1, JSON.stringify(asked));
  const [file] = asked[0]!.args.slice(-1);
  assert.deepEqual(asked[0]!.args.slice(0, -1), ["-n", "-W", "-g", APP, "--args", "__permissions-host-request", "--result-file"]);
  assert.match(file!, new RegExp(`^${h.temp}/cua-driver-permissions-\\d+-\\d+\\.json$`));
  assert.equal(existsSync(file!), false, "the result file is removed");
  h.set({ accessibility: true, screen_recording: true });
  const look = await h.service.observe(caller(), { app: "Reminders" });
  assert.equal(look.image?.mime, "image/png");
  assert.equal(look.tree?.app, "Reminders");
});

test("observe: a PNG of the main display at the model's size, and the app's elements in the helper's words", async () => {
  const h = mac();
  const look = await h.service.observe(caller(), { app: "Reminders" });
  assert.equal(look.screen, "owner");
  assert.deepEqual([look.image!.width, look.image!.height], [1568, 980]);
  assert.match(look.image!.path!, /cap_[0-9a-f]{12}\.png$/);
  assert.ok(existsSync(look.image!.path!));
  assert.deepEqual([look.display!.id, look.display!.width, look.display!.height], ["main", 2560, 1600]);
  assert.equal(look.focus!.app, "Reminders");
  assert.equal(look.focus!.focused, null, "macOS does not say which element has the keyboard");
  const elements = Object.fromEntries(look.tree!.elements.map((element) => [element.id, element]));
  assert.deepEqual(Object.keys(elements), ["e1", "e2", "e3", "e4"]);
  assert.deepEqual([elements.e1!.role, elements.e1!.name, elements.e1!.actions, elements.e1!.box], ["push button", "Add", ["press"], [760, 10, 30, 24]]);
  assert.deepEqual([elements.e2!.role, elements.e2!.name, elements.e2!.value], ["text", "New Reminder", "Buy milk"]);
  assert.ok(elements.e2!.states.includes("editable"));
  assert.deepEqual([elements.e3!.role, elements.e3!.value], ["password text", undefined]);
  assert.equal(elements.e4!.role, "switch");
  assert.ok(elements.e4!.states.includes("checked"));
  const calls = h.calls();
  assert.ok(calls.some((call) => call.tool === "get_desktop_state" && call.args.max_image_dimension === 1568));
  assert.ok(calls.some((call) => call.tool === "get_window_state" && call.args.window_id === 11 && call.args.include_screenshot === false));
  // A zoom is cut from a full-size capture: its left quarter is the white stripe.
  const zoom = await h.service.zoom(caller(), { captureId: look.captureId, box: [0, 0, 784, 490] });
  assert.deepEqual([zoom.image!.width, zoom.image!.height], [1280, 800]);
  const pixels = decodePng(readFileSync(zoom.image!.path!));
  assert.deepEqual([...pixels.data.subarray(0, 3)], [255, 255, 255]);
  assert.notDeepEqual([...pixels.data.subarray((pixels.width - 1) * 4, (pixels.width - 1) * 4 + 3)], [255, 255, 255]);
});

test("a driver that will not write the screenshot to a file sends it in its answer", async () => {
  const h = mac({ world: { refuseOutFile: true } });
  const look = await h.service.observe(caller(), { app: "Reminders" });
  assert.deepEqual([look.image!.width, look.image!.height], [1568, 980]);
  const shots = h.calls().filter((call) => call.tool === "get_desktop_state");
  assert.ok(shots[0]!.args.screenshot_out_file, "a file first");
  assert.ok(shots.slice(1).every((call) => call.args.screenshot_out_file === undefined), "then always in the answer");
});

test("act: cua-driver's own account of each action is its verdict, and a refusal says nothing ran", async () => {
  const h = mac();
  await h.service.observe(caller(), { app: "Reminders", screenshot: false });
  const done = await h.service.act(caller(), { steps: [{ action: "press", element: "e1" }, { action: "set_text", element: "e2", text: "Call the dentist" }] });
  assert.equal(done.mode, "background");
  assert.deepEqual(done.steps.map((step) => step.verdict), ["confirmed", "confirmed"]);
  const calls = h.calls();
  assert.match(String(calls.find((call) => call.tool === "click")!.args.element_token), /^s[0-9a-f]{8}:1$/);
  assert.equal(calls.find((call) => call.tool === "set_value")!.args.value, "Call the dentist");
  assert.ok(done.observation?.tree, "a fresh look at the app's elements follows");

  const verdictOf = async (effects: Record<string, string>, refuse: Record<string, string> = {}) => {
    h.set({ effects, refuse });
    await h.service.observe(caller(), { app: "Reminders", screenshot: false });
    return (await h.service.act(caller(), { steps: [{ action: "press", element: "e1" }, { action: "press", element: "e4" }] })).steps;
  };
  const noop = await verdictOf({ click: "suspected_noop" });
  assert.deepEqual(noop.map((step) => step.verdict), ["no_effect", "not_run"]);
  assert.equal((await verdictOf({ click: "partial" }))[0]!.verdict, "partial");
  const unknown = await verdictOf({ click: "unverifiable" });
  assert.deepEqual(unknown.map((step) => [step.verdict, step.ran]), [["unknown", "yes"], ["unknown", "yes"]], "unknown, but it ran: the batch goes on");
  const background = (await verdictOf({}, { click: "background_unavailable" }))[0]!;
  assert.deepEqual([background.verdict, background.ran, background.code], ["refused", "no", "needs_screen"]);
  const stale = (await verdictOf({}, { click: "stale_element_token" }))[0]!;
  assert.deepEqual([stale.verdict, stale.ran, stale.code], ["not_run", "no", "element_gone"]);
});

test("background: the owner's pointer and keyboard are refused without their screen; apps open behind their windows and keys go to an element", async () => {
  const h = mac();
  const look = await h.service.observe(caller(), { app: "Reminders" });
  const clicked = await h.service.act(caller(), { captureId: look.captureId, steps: [{ action: "click", x: 300, y: 300 }] });
  assert.deepEqual([clicked.steps[0]!.verdict, clicked.steps[0]!.ran, clicked.steps[0]!.code], ["refused", "no", "needs_screen"]);
  assert.doesNotMatch(clicked.steps[0]!.detail!, /agent screen/, "macOS has none to offer");
  const typed = await h.service.act(caller(), { steps: [{ action: "type", text: "hello" }] });
  assert.equal(typed.steps[0]!.code, "needs_screen");
  assert.equal(h.calls().filter((call) => call.tool === "click" || call.tool === "type_text").length, 0);

  const asked: GateApp[] = [];
  const quiet = caller("node:n1:m1", { gate: async (app) => (asked.push(app), { allow: false, ask: true }) });
  const opened = await h.service.open(quiet, { app: "Clock" });
  assert.deepEqual([opened.focused, opened.via, opened.stages.window], [false, "background", true]);
  assert.deepEqual(asked, [], "opening behind the owner's windows asks nothing");
  assert.ok(h.calls().some((call) => call.tool === "launch_app" && call.args.bundle_id === "com.apple.clock"));
  assert.ok(!h.calls().some((call) => call.tool === "bring_to_front"));
  await h.service.observe(quiet, { app: "Clock", screenshot: false });
  const done = await h.service.act(quiet, { steps: [{ action: "press", element: "e1" }, { action: "key", element: "e2", keys: "cmd+n" }, { action: "open", app: "Reminders" }] });
  assert.deepEqual(done.steps.map((step) => step.verdict), ["confirmed", "unknown", "confirmed"]);
  assert.deepEqual(asked, []);
  const hotkey = h.calls().find((call) => call.tool === "hotkey")!;
  assert.deepEqual(hotkey.args.keys, ["cmd", "n"]);
  assert.match(String(hotkey.args.element_token), /:2$/);
});

test("foreground: the owner's pointer and keyboard go to screen pixels, a click judged by the window under it", async () => {
  const h = mac();
  const look = await h.service.observe(caller(), { app: "Reminders" });
  const done = await h.service.act(caller(), { captureId: look.captureId, foreground: true, steps: [{ action: "click", x: 300, y: 300 }] });
  assert.equal(done.mode, "foreground");
  assert.equal(done.steps[0]!.verdict, "confirmed", "the screen changed and settled");
  const click = h.calls().find((call) => call.tool === "click")!;
  assert.deepEqual([click.args.scope, click.args.delivery_mode, click.args.button, click.args.count], ["desktop", "foreground", "left", 1]);
  const moved = h.calls().find((call) => call.tool === "move_cursor")!;
  assert.deepEqual([moved.args.scope, moved.args.delivery_mode], ["desktop", "foreground"]);
  assert.ok(Math.abs(moved.screen!.x - click.screen!.x) < 0.001 && Math.abs(moved.screen!.y - click.screen!.y) < 0.001, "the pointer goes there first");
  assert.ok(Math.abs(click.screen!.x - (300.5 * 2560) / 1568) < 0.01 && Math.abs(click.screen!.y - (300.5 * 1600) / 980) < 0.01, "native screen pixels");
  const second = await h.service.observe(caller(), {});
  const own = await h.service.act(caller(), { captureId: second.captureId, foreground: true, steps: [{ action: "click", x: 1300, y: 400 }] });
  assert.deepEqual([own.steps[0]!.verdict, own.steps[0]!.rule], ["refused", "ensemble_window"]);
  const third = await h.service.observe(caller(), {});
  const browser = await h.service.act(caller(), { captureId: third.captureId, foreground: true, steps: [{ action: "click", x: 100, y: 900 }] });
  assert.deepEqual([browser.steps[0]!.verdict, browser.steps[0]!.rule], ["refused", "unknown_page"]);
  h.set({ effects: { hotkey: "confirmed" } });
  const keys = await h.service.act(caller(), { foreground: true, steps: [{ action: "key", keys: "cmd+s" }, { action: "type", text: "Groceries" }] });
  assert.deepEqual(keys.steps.map((step) => step.verdict), ["confirmed", "confirmed"]);
  assert.deepEqual(h.calls().find((call) => call.tool === "hotkey")!.args, { keys: ["cmd", "s"], scope: "desktop" });
  const typed = h.calls().filter((call) => call.tool === "type_text");
  assert.deepEqual(typed.map((call) => call.args), [{ text: "Grocerie", scope: "desktop" }, { text: "s", scope: "desktop" }]);
});

test("recording: unavailable before macOS 15; from 15 an MP4 through cua-driver, checked and saved without its notes", async () => {
  const old = mac({ macosMajor: 14 });
  await assert.rejects(old.service.recordStart(caller(), { evidenceDir: join(old.dir, "evidence") }), (error: unknown) => error instanceof DesktopError && error.code === "unsupported" && /macOS 15 or later/.test(error.message));
  assert.equal((await old.service.status()).facts.recorder!.state, "failed");

  const h = mac();
  const started = await h.service.recordStart(caller(), { evidenceDir: join(h.dir, "evidence"), maxSec: 30 });
  assert.equal(started.container, "mp4");
  assert.ok(h.calls().some((call) => call.tool === "start_recording" && call.args.record_video === true && call.args.include_accessibility_tree === false));
  // A saved secret is never filled in while the recording keeps notes of what each action sent.
  const secret = caller("node:n1:m1", { secret: async () => "pw-123" });
  await h.service.observe(secret, { app: "Reminders", screenshot: false });
  const filled = await h.service.act(secret, { steps: [{ action: "set_text", element: "e3", text: "$SITE_PASSWORD" }] });
  assert.deepEqual([filled.steps[0]!.ran, filled.steps[0]!.code], ["no", "unsupported"]);
  assert.ok(!h.calls().some((call) => call.tool === "set_value"));
  const saved = await h.service.recordSave(caller(), { name: "Reminder made" });
  assert.match(saved.path, /reminder-made\.mp4$/);
  assert.deepEqual([saved.mime, saved.width, saved.height, saved.durationMs, saved.frames, saved.codec], ["video/mp4", 2560, 1600, 2000, 60, "h264"]);
  assert.deepEqual(readdirSync(join(h.dir, "cua", "recordings")), [], "the recording's notes are gone");
});

test("a call cua-driver does not answer in time may have run, and the driver is ended so it cannot act later", async () => {
  const h = mac();
  const tree = await h.driver.call<{ tree_id: string }>("a11y.tree", { app: "Reminders", max_elements: 50 }, { timeoutMs: 10_000 });
  const pid = h.driver.health().pid;
  h.set({ slow: { click: 5_000 } });
  await assert.rejects(h.driver.call("a11y.do", { tree_id: tree.tree_id, element: "e1", action: "press" }, { timeoutMs: 1_000, effects: true }), (error: unknown) => (error as { kind?: string }).kind === "deadline" && (error as { ran?: string }).ran === "maybe");
  h.set({ slow: {} });
  await h.driver.call("a11y.apps", {}, { timeoutMs: 10_000 });
  assert.notEqual(h.driver.health().pid, pid);
  assert.equal(h.driver.health().restarts, 1);
});

test("there is no agent screen on macOS: calls go to the owner's screen, and naming the agent screen says why not", async () => {
  const h = mac();
  const agent = new DesktopService({ screen: "agent", helper: new HelperProcess({ spawn: () => helperCommand({}, "darwin", "agent") }), captureDir: join(h.dir, "agent-captures"), platform: "darwin" });
  services.push(agent);
  const screens = new Desktops(h.service, () => agent, "owner");
  assert.equal(screens.pick("node:n1:m1"), "owner");
  await assert.rejects(screens.service("agent").observe(caller(), {}), (error: unknown) => error instanceof DesktopError && error.code === "unavailable" && error.message === NO_AGENT_SCREEN_MAC);
});

test("every window of a browser is a page that cannot be read, also one minimised, hidden or on another Space", async () => {
  const away = { window_id: 42, pid: 104, app_name: "Safari", title: "Approvals", bounds: { x: 0, y: 0, width: 900, height: 700 }, is_on_screen: false, z_index: null, layer: 0, minimized: false };
  const h = mac({ world: { windows: [...MAC.windows.filter((win) => win.pid !== 104), away], elements: { ...MAC.elements, "42": [{ element_index: 1, role: "AXButton", title: "Allow", actions: ["AXPress"], frame: { x: 20, y: 20, w: 60, h: 24 }, enabled: true }] } } });
  await h.service.observe(caller(), { app: "Safari", screenshot: false });
  const done = await h.service.act(caller(), { steps: [{ action: "press", element: "e1" }] });
  assert.deepEqual([done.steps[0]!.verdict, done.steps[0]!.rule], ["refused", "unknown_page"]);
  assert.ok(!h.calls().some((call) => call.tool === "click"));
});

test("browsers are told apart by LaunchServices (apps that open https links) and web-app bundles, and Ensemble's own windows by their titles", async () => {
  const button = (x: number) => [{ element_index: 1, role: "AXButton", title: "Allow", actions: ["AXPress"], frame: { x, y: 20, w: 60, h: 24 }, enabled: true }];
  const h = mac({
    // Nimbus is a browser no list knows: LaunchServices says it opens https links. DuckDuckGo is known by its bundle.
    handlers: ["com.apple.Safari", "org.example.Nimbus"],
    world: {
      apps: [...MAC.apps, { pid: 105, name: "DuckDuckGo", bundle_id: "com.duckduckgo.macos.browser", running: true, active: false }, { pid: 106, name: "Notes Wrapper", bundle_id: "com.example.wrapper", running: true, active: false }, { pid: 107, name: "Ensemble Hub", bundle_id: "com.apple.Safari.WebApp.1A2B", running: true, active: false }, { pid: 108, name: "Site", bundle_id: "com.example.site", running: true, active: false }, { pid: 109, name: "Nimbus", bundle_id: "org.example.Nimbus", running: true, active: false }],
      windows: [
        ...MAC.windows,
        { window_id: 51, pid: 105, app_name: "DuckDuckGo", title: "Search", bounds: { x: 0, y: 0, width: 400, height: 300 }, is_on_screen: true, z_index: 4, layer: 0, minimized: false },
        { window_id: 61, pid: 106, app_name: "Notes Wrapper", title: "Today · Ensemble", bounds: { x: 0, y: 0, width: 400, height: 300 }, is_on_screen: true, z_index: 3, layer: 0, minimized: false },
        { window_id: 71, pid: 107, app_name: "Ensemble Hub", title: "Inbox", bounds: { x: 0, y: 0, width: 400, height: 300 }, is_on_screen: true, z_index: 2, layer: 0, minimized: false },
        { window_id: 81, pid: 108, app_name: "Site", title: "Ensemble Node", bounds: { x: 0, y: 0, width: 400, height: 300 }, is_on_screen: true, z_index: 1, layer: 0, minimized: false },
        { window_id: 91, pid: 109, app_name: "Nimbus", title: "Start", bounds: { x: 0, y: 0, width: 400, height: 300 }, is_on_screen: true, z_index: 0, layer: 0, minimized: false },
      ],
      elements: { ...MAC.elements, "51": button(10), "61": button(10), "71": button(10), "81": button(10), "91": button(10) },
    },
  });
  for (const [app, rule] of [["Nimbus", "unknown_page"], ["DuckDuckGo", "unknown_page"], ["Notes Wrapper", "ensemble_window"], ["Ensemble Hub", "unknown_page"], ["Site", "ensemble_window"]] as const) {
    await h.service.observe(caller(), { app, screenshot: false });
    const done = await h.service.act(caller(), { steps: [{ action: "press", element: "e1" }] });
    assert.deepEqual([done.steps[0]!.verdict, done.steps[0]!.rule], ["refused", rule], app);
  }
  assert.ok(!h.calls().some((call) => call.tool === "click"));
  assert.equal(h.execs.filter((run) => run.program.endsWith("osascript")).length, 1, "the https handlers are read once, not at every look");
  const plain = { name: "Wrapper", app_id: "com.example.wrapper", toolkit: "macOS" };
  for (const title of ["Ensemble", "Today · Ensemble", "Ensemble Node", "Inbox · Ensemble Node", "Quick capture"]) assert.ok(ensembleWindow(plain, title), title);
  for (const title of ["Ensemble Theater", "Ensembles", "Notes"]) assert.equal(ensembleWindow(plain, title), null, title);
  assert.equal(ensembleWindow({ name: "Orion", app_id: "com.kagi.kagimacOS", toolkit: "Web" }, "Today · Ensemble"), null, "a browser's page is judged by its address");
});

test("typing goes in short chunks and stops when the window in front changes or the owner types", async () => {
  const text = "The quick brown fox jumps over the lazy dog";
  const typedBy = (h: ReturnType<typeof mac>) =>
    h
      .calls()
      .filter((call) => call.tool === "type_text")
      .map((call) => String(call.args.text));
  // Safari comes to the front with its window on top after two chunks: the window on top is checked after each.
  const moved = mac({ world: { frontAfterTypes: { count: 2, pid: 104 } } });
  const first = await moved.service.act(caller(), { foreground: true, steps: [{ action: "type", text }] });
  assert.deepEqual([first.steps[0]!.verdict, first.steps[0]!.ran], ["partial", "yes"]);
  assert.match(first.steps[0]!.detail!, /Typing stopped after 16 of 43 characters: the window in front changed/);
  assert.deepEqual(typedBy(moved), ["The quic", "k brown "]);

  // An app with no window to raise takes the front after one chunk: the app in front is checked every fourth.
  const windowless = mac({ world: { frontAfterTypes: { count: 1, pid: 104, raise: false } } });
  const quiet = await windowless.service.act(caller(), { foreground: true, steps: [{ action: "type", text }] });
  assert.match(quiet.steps[0]!.detail!, /after 32 of 43 characters: the window in front changed/);
  assert.equal(typedBy(windowless).length, 4);

  const touched = mac();
  touched.idle.afterTypes = { count: 1, ms: 20 };
  const second = await touched.service.act(caller(), { foreground: true, steps: [{ action: "type", text }] });
  assert.equal(second.steps[0]!.verdict, "partial");
  assert.match(second.steps[0]!.detail!, /your owner used the keyboard or mouse/);
  assert.equal(typedBy(touched).length, 1);
  assert.equal(touched.service.lease.holder, "owner");

  const whole = mac();
  const third = await whole.service.act(caller(), { foreground: true, steps: [{ action: "type", text }] });
  assert.equal(third.steps[0]!.verdict, "confirmed");
  assert.equal(typedBy(whole).join(""), text);
});

test("the longest text a type step takes finishes in its time; with less time it stops between chunks and says how much went in", async () => {
  const text = Array.from({ length: 5_000 }, (_, index) => "abcdefghijklmnopqrstuvwxyz0123456789 "[index % 37]).join("");
  // The call's time covers typing all of it, with the look after it and the way to the computer and back.
  assert.ok(typingMs(text.length) + 8_000 + DESKTOP_TRANSPORT_MS <= desktopTimeoutMs("desktop_act", { steps: [{ action: "type", text }] }));
  const typedBy = (h: ReturnType<typeof mac>) =>
    h
      .calls()
      .filter((call) => call.tool === "type_text")
      .map((call) => String(call.args.text))
      .join("");
  const long = mac({ clock: true });
  const done = await long.service.act(caller("node:n1:m1", { budgetMs: desktopTimeoutMs("desktop_act", { steps: [{ action: "type", text }] }) - DESKTOP_TRANSPORT_MS }), { foreground: true, steps: [{ action: "type", text }] });
  assert.deepEqual([done.steps[0]!.verdict, done.steps[0]!.ran], ["confirmed", "yes"]);
  assert.equal(typedBy(long), text);

  const short = mac({ clock: true });
  const cut = await short.service.act(caller("node:n1:m1", { budgetMs: 40_000 }), { foreground: true, steps: [{ action: "type", text }] });
  assert.deepEqual([cut.steps[0]!.verdict, cut.steps[0]!.ran], ["partial", "yes"]);
  const told = /Typing stopped after (\d+) of 5000 characters: this call ran out of time, so the rest was not typed\. Look, then type the rest \(from character (\d+)\) in another step\./.exec(cut.steps[0]!.detail!);
  assert.ok(told, cut.steps[0]!.detail);
  const count = Number(told[1]);
  assert.ok(count > 0 && count < 5_000 && count % 8 === 0, String(count));
  assert.equal(Number(told[2]), count + 1);
  assert.equal(typedBy(short), text.slice(0, count), "exactly what it says went in");
});

test("a failure after some chunks went in says the step ran, with how much was typed, so it is not typed again", async () => {
  const text = "The quick brown fox jumps over the lazy dog";
  const h = mac({ world: { failAfterTypes: { count: 3, tool: "list_windows" } } });
  const done = await h.service.act(caller(), { foreground: true, steps: [{ action: "type", text }] });
  assert.deepEqual([done.steps[0]!.verdict, done.steps[0]!.ran], ["unknown", "yes"]);
  assert.match(done.steps[0]!.detail!, /^Typing stopped after 24 of 43 characters \(the rest was not typed\): list_windows failed/);
  assert.equal(done.ran, 1);
  assert.deepEqual(
    h
      .calls()
      .filter((call) => call.tool === "type_text")
      .map((call) => call.args.text)
      .join(""),
    text.slice(0, 24),
  );
});

test("a run that ends stops its typing before the next chunk, saying how much went in", async () => {
  const h = mac();
  const chunks = () => h.calls().filter((call) => call.tool === "type_text").length;
  const text = "x".repeat(400);
  const acting = h.service.act(caller("run:job-1"), { foreground: true, steps: [{ action: "type", text }] });
  await until(() => chunks() >= 3);
  const before = chunks();
  await h.service.release("run:job-1");
  const done = await acting;
  const after = chunks();
  assert.ok(after <= before + 1, `${before} chunks when it ended, ${after} after`);
  assert.deepEqual([done.steps[0]!.verdict, done.steps[0]!.ran], ["partial", "yes"]);
  assert.equal(done.steps[0]!.detail, `Typing stopped after ${after * 8} of 400 characters: the work it was for ended, or desktop control stopped, so the rest was not typed.`);
});

test("stopping desktop control during typing returns at once; a call still running after the grace ends with the driver", async () => {
  const h = mac();
  const chunks = () => h.calls().filter((call) => call.tool === "type_text").length;
  const text = "y".repeat(400);
  const acting = h.service.act(caller(), { foreground: true, steps: [{ action: "type", text }] });
  await until(() => chunks() >= 2);
  let started = Date.now();
  await h.driver.stop();
  assert.ok(Date.now() - started < 1_000, `stopped in ${Date.now() - started} ms`);
  const done = await acting;
  assert.deepEqual([done.steps[0]!.verdict, done.steps[0]!.ran], ["partial", "yes"]);
  assert.match(done.steps[0]!.detail!, /^Typing stopped after \d+ of 400 characters: the work it was for ended, or desktop control stopped/);

  // The driver does not answer a chunk: after the grace it is killed, and the chunk may have gone in.
  const hung = mac({ stopGraceMs: 1_000, world: { slow: { type_text: 30_000 } } });
  const stuck = hung.service.act(caller(), { foreground: true, steps: [{ action: "type", text }] });
  await until(() => hung.calls().some((call) => call.tool === "type_text"));
  started = Date.now();
  await hung.driver.stop();
  const took = Date.now() - started;
  assert.ok(took >= 900 && took < 3_000, `stopped in ${took} ms`);
  const cut = await stuck;
  assert.deepEqual([cut.steps[0]!.verdict, cut.steps[0]!.ran], ["unknown", "maybe"]);
  assert.equal(hung.driver.health().crashes, 0, "killed on purpose, not counted as a crash");
});

test("lines from cua-driver that are not MCP messages are ignored: null, arrays, numbers, a 10 MB line, bytes that are not UTF-8", async () => {
  const h = mac({ world: { noise: true } });
  const listed = await h.driver.call<{ apps: unknown[] }>("a11y.apps", {}, { timeoutMs: 30_000 });
  assert.ok(listed.apps.length > 0);
  assert.equal(h.driver.health().state, "ready");
  const again = await h.driver.call<{ apps: unknown[] }>("a11y.apps", {}, { timeoutMs: 30_000 });
  assert.equal(again.apps.length, listed.apps.length);
});

test("key names: Linux-style combinations in cua-driver's words", () => {
  assert.deepEqual(parseCombo("cmd+shift+t"), { modifiers: ["cmd", "shift"], key: "t" });
  assert.deepEqual(parseCombo("Return"), { modifiers: [], key: "return" });
  assert.deepEqual(parseCombo("super+Page_Up"), { modifiers: ["cmd"], key: "pageup" });
  assert.deepEqual(parseCombo("BackSpace"), { modifiers: [], key: "delete" });
  assert.deepEqual(parseCombo("ctrl+alt+Delete"), { modifiers: ["ctrl", "option"], key: "forwarddelete" });
  assert.deepEqual(parseCombo("F5"), { modifiers: [], key: "f5" });
  assert.throws(() => parseCombo("hyper+x"), /not a modifier/);
  assert.throws(() => parseCombo("Launch"), /not a key name/);
});
