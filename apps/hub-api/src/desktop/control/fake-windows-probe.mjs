#!/usr/bin/env node
// A stand-in for the Windows session probe (desktop-helper/windows/probe.ps1) in tests: the helper protocol over
// stdin and stdout (hello, idle, state, notify). FAKE_PROBE_STATE names a JSON file with the session, read on every
// call: `idle_ms`, `input_desktop`, `uac`, `session`, `uia`, `monitors`; `afterTypes` ({count, ms}) is input of the
// owner's once FAKE_CUA_LOG holds that many type_text calls; with `typingIsInput` the driver's own input counts as
// input, as Windows counts SendInput (idle time from its last type_text, or bring_to_front with its no-name key).
// `windows` answers from the stand-in driver's windows (`<FAKE_CUA_STATE>.screen.json`): the front app's top window
// has the keyboard unless `foreground` says otherwise (null: none), a point's window is the top one that shows there
// (cloaked ones do not, `unlisted` ones do). `browsers` answers `browsers`; `fail` makes a method fail.
// FAKE_PROBE_LOG gets one JSON line per call.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const STATE = process.env.FAKE_PROBE_STATE;
const CUA_STATE = process.env.FAKE_CUA_STATE;
const CUA_LOG = process.env.FAKE_CUA_LOG;
const LOG = process.env.FAKE_PROBE_LOG;
const read = () => ({
  idle_ms: 600_000,
  input_desktop: "Default",
  uac: false,
  session: { id: 1, service: false, connect: "active", visible: true },
  uia: true,
  dpi: 144,
  monitors: [{ x: 0, y: 0, width: 2880, height: 1800, primary: true, dpi: 144 }],
  ...(STATE && existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {}),
});
const typing = () => (CUA_LOG && existsSync(CUA_LOG) ? readFileSync(CUA_LOG, "utf8").split("\n").filter((line) => line.includes('"tool":"type_text"') || line.includes('"tool":"bring_to_front"')).map((line) => JSON.parse(line).at) : []);

function idle() {
  const live = read();
  const typed = typing();
  const owner = live.afterTypes && typed.length >= live.afterTypes.count;
  const own = live.typingIsInput && typed.length ? Date.now() - typed.at(-1) : Infinity;
  const desktop = live.input_desktop;
  return { idle_ms: owner ? live.afterTypes.ms : Math.min(live.idle_ms, own), input_desktop: desktop, locked: desktop !== "Default", uac: live.uac === true, lock_screen: desktop !== "Default" && live.uac !== true };
}

/** The stand-in driver's windows and apps as it last wrote them, else as its state file has them. */
function screen() {
  const file = CUA_STATE ? `${CUA_STATE}.screen.json` : null;
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const world = CUA_STATE && existsSync(CUA_STATE) ? JSON.parse(readFileSync(CUA_STATE, "utf8")) : {};
  return { windows: world.windows ?? [], apps: world.apps ?? [] };
}

const describe = (win) => ({ window: win.window_id, pid: win.pid, program: win.program ?? `C:\\Program Files\\${win.app_name}`, title: win.title ?? "", class: "Window", cloaked: win.cloaked === true });

function windows(params) {
  const live = read();
  const { windows: all, apps } = screen();
  const shown = all.filter((win) => !win.minimized && win.is_on_screen !== false && !win.cloaked).sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0));
  const inside = (win, x, y) => win.bounds && x >= win.bounds.x && x < win.bounds.x + win.bounds.width && y >= win.bounds.y && y < win.bounds.y + win.bounds.height;
  const at = (params?.points ?? []).map(([x, y]) => {
    const hit = shown.find((win) => inside(win, x, y));
    return hit ? describe(hit) : null;
  });
  const active = apps.find((app) => app.active);
  const top = active ? shown.find((win) => win.pid === active.pid && !win.unlisted) : null;
  return { foreground: "foreground" in live ? live.foreground : top ? describe(top) : null, cloaked: all.filter((win) => win.cloaked).map((win) => win.window_id), at };
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ method: message.method, params: message.params })}\n`);
  const live = read();
  if (live.fail?.[message.method]) return send({ id: message.id, error: { code: -32603, message: live.fail[message.method], data: { kind: "internal", ran: "no" } } });
  if (message.method === "hello") send({ id: message.id, result: { protocol: 1, version: "1", platform: "win32", methods: ["hello", "idle", "state", "notify", "windows", "browsers"], session: "windows" } });
  else if (message.method === "idle") send({ id: message.id, result: idle() });
  else if (message.method === "state") send({ id: message.id, result: { ...idle(), session: live.session, elevated: live.elevated === true, uia: live.uia, ...(live.uia ? {} : { uia_error: "UI Automation is not available" }), dpi: live.dpi, monitors: live.monitors, os: "10.0.20348.0" } });
  else if (message.method === "notify") send({ id: message.id, result: { shown: true } });
  else if (message.method === "windows") send({ id: message.id, result: windows(message.params) });
  else if (message.method === "browsers") send({ id: message.id, result: { browsers: live.browsers ?? [] } });
  else send({ id: message.id, error: { code: -32601, message: `no method ${message.method}`, data: { kind: "method_not_found", ran: "no" } } });
});
lines.on("close", () => process.exit(0));
