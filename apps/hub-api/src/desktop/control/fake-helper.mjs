#!/usr/bin/env node
// A stand-in for desktop-helper/linux/ensemble_desktop.py in tests: the same JSON-RPC over stdin and
// stdout, with a desktop held in memory. Tests steer it with `test.set` (merge state), `test.emit` (an
// event) and read what it did with `test.log`.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);

const screen = { node: 42, x: 0, y: 0, width: 2560, height: 1440, frame_width: 2560, frame_height: 1440, name: "DP-2", primary: true, scale: 1 };
const state = {
  consent: "given",
  epoch: 0,
  session: false,
  streams: [screen],
  hash: 1000,
  locked: false,
  idle: 60_000,
  noEffect: false,
  slow: {},
  fail: {},
  focus: { app: { name: "Calculator", toolkit: "GTK", pid: 501, app_id: "org.gnome.Calculator" }, window: { index: 0, title: "Calculator", role: "frame" }, shell: false, prompt: null, focused: { role: "push button", name: "7", editable: false }, documents: [] },
  apps: [{ name: "Calculator", toolkit: "GTK", pid: 501, app_id: "org.gnome.Calculator", windows: [{ index: 0, title: "Calculator", role: "frame", active: true, showing: true, iconified: false }] }],
  tree: {
    tree_id: "t1",
    app: { name: "Calculator", toolkit: "GTK", pid: 501, app_id: "org.gnome.Calculator", windows: [] },
    window: { index: 0, title: "Calculator", role: "frame", active: true, extents: [0, 0, 400, 600] },
    elements: [
      { id: "e1", role: "push button", name: "7", states: ["focusable"], actions: ["click"], box: [10, 200, 60, 40] },
      { id: "e2", role: "text", name: "Result", states: ["editable"], actions: [], value: "0", box: [10, 20, 380, 60] },
      { id: "e3", role: "password text", name: "Password", states: ["editable"], actions: [], box: [10, 100, 380, 30] },
    ],
    truncated: false,
    visited: 40,
  },
  catalog: [
    { id: "org.gnome.Calculator", name: "Calculator", exec: "gnome-calculator" },
    { id: "org.gnome.Ptyxis", name: "Terminal", exec: "ptyxis" },
  ],
  recordings: {},
};
const log = [];
let active = 0;
let maxActive = 0;

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const fail = (kind, message, ran = "no") => {
  throw Object.assign(new Error(message), { rpc: { code: -32000, message, data: { kind, ran } } });
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const changed = () => {
  if (!state.noEffect) state.hash += 1;
};

const methods = {
  hello: () => ({ protocol: 1, version: "fake", platform: "linux", methods: Object.keys(methods) }),
  ping: () => ({ pong: true }),
  status: () => ({
    facts: { session: { state: "working", detail: "wayland" }, consent: { state: state.consent === "given" ? "remembered" : "ask" } },
    session: { state: state.session ? "on" : "off", epoch: state.epoch, ...(state.session ? { streams: state.streams } : {}) },
    registered: true,
    recordings: [],
  }),
  idle: () => ({ locked: state.locked, idle_ms: state.idle }),
  notify: () => ({ shown: true }),
  "session.start": () => {
    if (state.session) return { state: "on", epoch: state.epoch, streams: state.streams };
    if (state.consent !== "given") return { state: "waiting_owner_at_computer" };
    state.session = true;
    state.epoch += 1;
    return { state: "on", epoch: state.epoch, streams: state.streams, silent: true };
  },
  "session.stop": () => {
    state.session = false;
    return { state: "off" };
  },
  "frame.capture": (params) => {
    if (!state.session) fail("no_session", "Screen control is not on.");
    const crop = params.crop ?? [0, 0, screen.width, screen.height];
    const long = Math.max(crop[2], crop[3]);
    const scale = params.max_long_edge > 0 ? Math.min(1, params.max_long_edge / long) : 1;
    const image = { width: Math.round(crop[2] * scale), height: Math.round(crop[3] * scale), mime: params.format === "png" ? "image/png" : "image/jpeg", bytes: 14 };
    if (params.save_path) {
      writeFileSync(params.save_path, params.format === "png" ? PNG : JPEG, { mode: 0o600, flag: "wx" });
      image.path = params.save_path;
    }
    if (params.inline) image.base64 = JPEG.toString("base64");
    return { display: params.display, epoch: state.epoch, image, frame: { width: screen.frame_width, height: screen.frame_height }, region: crop, hash: state.hash, seq: 1, settled: true, waited_ms: 0, at: Date.now() };
  },
  "frame.state": () => ({ hash: state.hash, seq: 1 }),
  "frame.settle": () => ({ settled: true, hash: state.hash, seq: 1, waited_ms: 120 }),
  "input.pointer": (params) => {
    if (params.action !== "move") changed();
    return { sent: true, x: params.x, y: params.y, clamped: false };
  },
  "input.drag": () => (changed(), { sent: true }),
  "input.scroll": () => (changed(), { sent: true }),
  "input.keys": () => (changed(), { sent: true, times: 1 }),
  "input.text": (params) => {
    changed();
    if (state.focus.focused && typeof state.focus.focused.text === "string" && !state.noEffect) state.focus.focused.text += params.text;
    return { sent: true, typed: { keysym: params.text.length, atspi: 0, clipboard: 0, untyped: 0 } };
  },
  "a11y.focus": (params) => ({ ...state.focus, ...(params.documents === false ? { documents: undefined } : {}) }),
  "a11y.apps": () => ({ apps: state.apps, units: [] }),
  "a11y.tree": () => state.tree,
  "a11y.do": (params) => {
    changed();
    return params.action === "set_text" ? { done: true, via: "atspi:set_text", verified: params.text !== undefined ? true : null } : { done: true, via: `atspi:${params.action}`, states_before: ["focusable"], states_after: params.action === "focus" ? ["focusable", "focused"] : ["focusable"] };
  },
  "apps.catalog": (params) => ({ apps: state.catalog.filter((app) => !params.query || `${app.id} ${app.name}`.toLowerCase().includes(String(params.query).toLowerCase())) }),
  "apps.launch": (params) => {
    const app = state.catalog.find((item) => item.id === params.id);
    if (!app) fail("target_not_found", "No such app.");
    return { app: { id: app.id, name: app.name, running: { name: app.name, toolkit: "GTK", pid: 777, app_id: app.id, windows: [] } }, stages: { accepted: true, process: true, window: true, inspectable: true, focused: true }, waited_ms: 300 };
  },
  "apps.focus": () => ({ focused: true, via: "atspi" }),
  "record.start": (params) => {
    if (Object.values(state.recordings).some((recording) => recording.active)) fail("recording_active", "A recording is already running.");
    const id = `r${Object.keys(state.recordings).length + 1}`;
    state.recordings[id] = { path: params.path, active: true };
    writeFileSync(params.path, Buffer.from("webm-bytes"), { flag: "wx" });
    return { id, display: params.display, container: "webm", codec: "vp8", mime: "video/webm", size: [1920, 1080] };
  },
  "record.stop": (params) => {
    const recording = state.recordings[params.id];
    if (!recording) fail("no_recording", "There is no such recording.");
    recording.active = false;
    return { id: params.id, path: recording.path, size: 10, wall_ms: 5000, frames_in: 150, reason: "stopped", container: "webm", codec: "vp8" };
  },
  "record.discard": (params) => {
    delete state.recordings[params.id];
    return { discarded: true };
  },
  "media.check": (params) => {
    if (params.poster_path) writeFileSync(params.poster_path, JPEG, { flag: "wx" });
    if (params.preview_path) writeFileSync(params.preview_path, JPEG, { flag: "wx" });
    return { frames: 150, duration_ms: 5000, container_duration_ms: 5000, width: 1920, height: 1080, codec: "vp8dec", size: 10, poster: { path: params.poster_path, width: 1920, height: 1080 }, preview: { path: params.preview_path, width: 320, height: 180 } };
  },
  "test.set": (params) => {
    Object.assign(state, params);
    return { ok: true };
  },
  "test.emit": (params) => {
    send({ method: "event", params });
    return { ok: true };
  },
  "test.log": () => ({ log, maxActive }),
};

async function handle(request) {
  const { id, method, params = {} } = request;
  const tracked = !method.startsWith("test.");
  if (tracked) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    log.push({ method, params: method === "input.text" ? { ...params } : params, at: Date.now() });
  }
  try {
    const slow = state.slow[method];
    if (slow && (!slow.when || Object.entries(slow.when).every(([key, value]) => params[key] === value))) await sleep(slow.ms);
    const failure = state.fail[method];
    if (failure) fail(failure.kind, failure.message ?? failure.kind, failure.ran ?? "no");
    const handler = methods[method];
    if (!handler) fail("method_not_found", `Unknown method ${method}.`);
    send({ id, result: await handler(params) });
  } catch (error) {
    send({ id, error: error.rpc ?? { code: -32603, message: String(error.message ?? error), data: { kind: "internal", ran: "no" } } });
  } finally {
    if (tracked) active -= 1;
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  void handle(request);
}
