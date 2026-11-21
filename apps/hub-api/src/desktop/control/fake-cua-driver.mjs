#!/usr/bin/env node
// A stand-in for cua-driver 0.56.6 (`cua-driver mcp --direct`) in tests: MCP over stdin and stdout
// (initialize, tools/list, tools/call) with the tool shapes of the macOS backend, and a Mac held in memory.
// FAKE_CUA_STATE names a JSON file with the Mac (apps, windows, elements, screen, permissions); it is read at
// start, and again on every call for what tests change on the fly (effects, refusals, slow tools, failures).
// Like macOS, the permissions are read once per process: Cua Driver's own (`accessibility`, `screen_recording`),
// or with `--embedded` the launching app's (`host_accessibility`, `host_screen_recording`). `noise` writes lines
// that are not MCP messages before each answer. `frontAfterTypes` brings an app to the front (its windows on top
// unless `raise` is false) after that many typed chunks; `failAfterTypes` makes one tool fail from then on.
// FAKE_CUA_LOG gets one JSON line per tool call.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { deflateSync } from "node:zlib";

const STATE = process.env.FAKE_CUA_STATE;
const LOG = process.env.FAKE_CUA_LOG;
const read = () => (STATE && existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const world = {
  version: "0.56.6",
  accessibility: true,
  screen_recording: true,
  screen: { width: 2560, height: 1600, scale: 2 },
  seed: 1,
  apps: [],
  windows: [],
  elements: {},
  ...read(),
};
const EMBEDDED = process.argv.includes("--embedded") || process.env.CUA_DRIVER_EMBEDDED === "1";
const granted = EMBEDDED
  ? { accessibility: world.host_accessibility === true, screen_recording: world.host_screen_recording === true }
  : { accessibility: world.accessibility === true, screen_recording: world.screen_recording === true };
let typed = 0;
let snapshot = 0;
const tokens = new Map();
let recorder = null;

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const text = (value) => ({ type: "text", text: value });
const ok = (structured, words = "✅ done") => ({ content: [text(words)], structuredContent: structured });
const failed = (words, structured) => ({ content: [text(words)], isError: true, ...(structured ? { structuredContent: structured } : {}) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── pictures ────────────────────────────────────────────────────────────────

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}
/** A picture of the screen: one colour from the seed, with a stripe so a crop differs from the whole. */
function png(width, height, seed) {
  const row = Buffer.alloc(1 + width * 3);
  const colour = [(seed * 37) % 256, (seed * 91) % 256, (seed * 53) % 256];
  for (let x = 0; x < width; x += 1) row.set(x < width / 4 ? [255, 255, 255] : colour, 1 + x * 3);
  const raw = Buffer.alloc(height * row.length);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ── a finished MP4: ftyp, moov (mvhd, one picture track) and mdat ───────────

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
const full = (flags, ...parts) => Buffer.concat([u32(flags), ...parts]);
function mp4({ width, height, durationMs, frames }) {
  const duration = Math.round((durationMs * 600) / 1000);
  const mvhd = box("mvhd", full(0, u32(0), u32(0), u32(600), u32(duration), Buffer.alloc(80)));
  const tkhd = box("tkhd", full(3, u32(0), u32(0), u32(1), u32(0), u32(duration), Buffer.alloc(52), u32(width * 65536), u32(height * 65536)));
  const hdlr = box("hdlr", full(0, u32(0), Buffer.from("vide", "latin1"), Buffer.alloc(12), Buffer.from("Video\0", "latin1")));
  const stsd = box("stsd", full(0, u32(1), box("avc1", Buffer.alloc(78))));
  const stsz = box("stsz", full(0, u32(0), u32(frames)));
  const trak = box("trak", tkhd, box("mdia", hdlr, box("minf", box("stbl", stsd, stsz))));
  return Buffer.concat([box("ftyp", Buffer.from("isom", "latin1"), u32(512)), box("mdat", Buffer.alloc(4096, 7)), box("moov", mvhd, trak)]);
}

// ── the tools ───────────────────────────────────────────────────────────────

const ACTION = { session: { type: "string" }, delivery_mode: { type: "string", enum: ["background", "foreground"] } };
const SCHEMAS = {
  check_permissions: { prompt: {}, probe_direct_capture: {} },
  get_desktop_state: { session: {}, max_image_dimension: {}, screenshot_out_file: {} },
  list_apps: {},
  list_windows: { pid: {}, on_screen_only: {} },
  get_window_state: { session: {}, pid: {}, window_id: {}, query: {}, include_accessibility_tree: {}, include_screenshot: {}, screenshot_out_file: {}, max_elements: {}, max_depth: {}, timeout_ms: {}, tree_format: {}, since: {} },
  click: { ...ACTION, pid: {}, window_id: {}, element_token: {}, capture_id: {}, x: {}, y: {}, action: {}, button: {}, count: {}, modifier: {}, scope: {} },
  set_value: { session: {}, pid: {}, window_id: {}, element_token: {}, value: {} },
  type_text: { ...ACTION, pid: {}, window_id: {}, element_token: {}, text: {}, x: {}, y: {}, delay_ms: {}, scope: {} },
  press_key: { ...ACTION, pid: {}, window_id: {}, element_token: {}, key: {}, modifiers: {}, x: {}, y: {}, scope: {} },
  hotkey: { ...ACTION, pid: {}, window_id: {}, element_token: {}, keys: {}, x: {}, y: {}, scope: {} },
  scroll: { ...ACTION, pid: {}, window_id: {}, element_token: {}, direction: {}, amount: {}, by: {}, x: {}, y: {}, scope: {} },
  drag: { ...ACTION, pid: {}, window_id: {}, from_x: {}, from_y: {}, to_x: {}, to_y: {}, duration_ms: {}, steps: {}, modifier: {}, button: {}, scope: {} },
  move_cursor: { session: {}, x: {}, y: {}, scope: {}, cursor_id: {}, delivery_mode: {} },
  launch_app: { bundle_id: {}, name: {}, urls: {}, creates_new_application_instance: {}, additional_arguments: {} },
  bring_to_front: { pid: {}, window_id: {} },
  start_recording: { session: {}, output_dir: {}, record_video: {}, state_timeout_ms: {}, include_accessibility_tree: {}, redact_values: {} },
  stop_recording: {},
  get_recording_state: {},
};

function action(effect, extra = {}) {
  return { effect, route: extra.route ?? "accessibility", ...(effect === "refused" ? {} : { delivery: { mode: extra.mode ?? "background" } }), ...(effect === "confirmed" ? { evidence: [{ kind: "value_readback" }] } : {}), ...(effect === "partial" ? { delivery: { mode: "background", delivered_count: 1 } } : {}), summary: extra.summary ?? "sent" };
}

function element(token) {
  const found = tokens.get(token);
  if (!found || (read().staleTokens && found.snapshot !== snapshot)) return null;
  return found;
}

/** A refusal set by the test for `tool`, in one of the shapes cua-driver uses. */
function refusal(tool, live) {
  const code = live.refuse?.[tool];
  if (!code) return null;
  if (code === "stale_element_token") return failed("Refused: the element token is stale.", { status: "refused", refusal: { code, message: "stale" } });
  return failed(`Refused: ${code}`, { code, effect: "refused" });
}

const screenPoints = () => ({ width: world.screen.width / world.screen.scale, height: world.screen.height / world.screen.scale });

const tools = {
  check_permissions: () => ok({ accessibility: granted.accessibility, screen_recording: granted.screen_recording, screen_recording_capturable: null, direct_capture_status: "not_checked", source: { attribution: "host", embedded: EMBEDDED, direct_runtime: !EMBEDDED } }),
  get_desktop_state: (args, live) => {
    if (!granted.screen_recording) return failed("Screen Recording permission is not granted for this process.");
    if (live.screenshotFails) return failed("capture failed: the display stream returned no frame");
    if (args.screenshot_out_file && live.refuseOutFile) return failed("screenshot_out_file is outside the folders this driver may write.");
    const native = world.screen;
    const edge = args.max_image_dimension ?? 1568;
    const scale = edge > 0 ? Math.min(1, edge / Math.max(native.width, native.height)) : 1;
    const width = Math.max(1, Math.round(native.width * scale));
    const height = Math.max(1, Math.round(native.height * scale));
    const picture = png(width, height, world.seed);
    const points = screenPoints();
    const facts = { platform: "macos", display: "primary", screenshot_width: width, screenshot_height: height, screen_width: points.width, screen_height: points.height, scale_factor: native.scale, screenshot_mime_type: "image/png", capture_id: `cap-${world.seed}`, ...(scale < 1 ? { screenshot_original_width: native.width, screenshot_original_height: native.height } : {}) };
    if (args.screenshot_out_file) {
      writeFileSync(args.screenshot_out_file, picture);
      return ok({ ...facts, screenshot_file_path: args.screenshot_out_file });
    }
    return { content: [{ type: "image", data: picture.toString("base64"), mimeType: "image/png" }], structuredContent: facts };
  },
  list_apps: () => ok({ apps: world.apps.map(({ pid, name, bundle_id, running, active, launch_path }) => ({ pid: running ? pid : 0, name, ...(bundle_id ? { bundle_id } : {}), running: Boolean(running), active: Boolean(active), ...(launch_path ? { launch_path } : {}), kind: "desktop" })) }),
  list_windows: (args) => ok({ windows: world.windows.filter((win) => args.pid === undefined || win.pid === args.pid).filter((win) => !args.on_screen_only || win.is_on_screen) }),
  get_window_state: (args) => {
    if (!granted.accessibility) return failed("Accessibility permission is not granted: AXIsProcessTrusted() is false.");
    const win = world.windows.find((item) => item.window_id === args.window_id && item.pid === args.pid);
    if (!win) return failed("window_id_not_found", { code: "window_id_not_found" });
    snapshot += 1;
    const id = (0x1000 + snapshot).toString(16).padStart(8, "0");
    const elements = (world.elements[String(win.window_id)] ?? []).slice(0, args.max_elements ?? 250).map((item) => {
      if (item.element_index === undefined) return item;
      const token = `s${id}:${item.element_index}`;
      tokens.set(token, { snapshot, window: win.window_id, item });
      return { ...item, element_token: token };
    });
    return ok({ snapshot_id: snapshot, window_title: win.title, app_name: win.app_name, elements, truncated: false, element_count: elements.length });
  },
  click: (args, live) => {
    if (args.element_token) {
      const found = element(args.element_token);
      if (!found) return failed("Refused: the element token is stale.", { status: "refused", refusal: { code: "stale_element_token", message: "stale" } });
      if (found.item.press) Object.assign(found.item, found.item.press);
      return ok(action(live.effects?.click ?? "confirmed"));
    }
    if (args.scope !== "desktop") return failed('click: x,y given with no pid/window_id, but scope is "window".', { code: "desktop_scope_disabled" });
    if (!live.noEffect) world.seed += 1;
    return ok({ path: "cgevent_hid", verified: false, effect: "unverifiable" }, "Sent screen-absolute click (desktop scope; not driver-verified).");
  },
  set_value: (args, live) => {
    const found = element(args.element_token);
    if (!found) return failed("Refused: the element token is stale.", { status: "refused", refusal: { code: "stale_element_token", message: "stale" } });
    found.item.value = args.value;
    return ok(action(live.effects?.set_value ?? "confirmed"));
  },
  type_text: (args, live) => {
    if (args.element_token && !element(args.element_token)) return failed("Refused: the element token is stale.", { status: "refused", refusal: { code: "stale_element_token", message: "stale" } });
    if (!args.element_token && args.scope !== "desktop") return failed("type_text needs a pid, an element_token or scope desktop.", { code: "invalid_arguments" });
    typed += 1;
    const front = live.frontAfterTypes;
    if (front && typed === front.count) {
      for (const app of world.apps) app.active = app.pid === front.pid;
      const top = Math.max(0, ...world.windows.map((win) => win.z_index ?? 0));
      if (front.raise !== false) for (const win of world.windows) if (win.pid === front.pid) win.z_index = top + 1;
    }
    return ok(action(live.effects?.type_text ?? "confirmed", { route: args.element_token ? "accessibility" : "synthetic_events" }));
  },
  press_key: (args, live) => ok(action(live.effects?.press_key ?? "unverifiable", { route: "synthetic_events" })),
  hotkey: (args, live) => ok(action(live.effects?.hotkey ?? "unverifiable", { route: "synthetic_events" })),
  scroll: (args, live) => ok(action(live.effects?.scroll ?? "unverifiable", { route: "synthetic_events" })),
  drag: () => {
    world.seed += 1;
    return ok(action("unverifiable", { route: "global_input", mode: "foreground" }));
  },
  move_cursor: () => ok(action("unverifiable", { route: "global_input", mode: "foreground" })),
  launch_app: (args) => {
    const app = world.apps.find((item) => (args.bundle_id ? item.bundle_id === args.bundle_id : item.name === args.name || item.launch_path === args.name));
    if (!app) return failed(`App not installed: ${args.bundle_id ?? args.name}`, { error: "APP_NOT_INSTALLED", suggestions: [] });
    app.running = true;
    const windows = world.windows.filter((win) => win.pid === app.pid);
    return ok({ pid: app.pid, bundle_id: app.bundle_id, name: app.name, windows, launch_state: { requested: true, process_running: true, window_ready: windows.length > 0 }, self_activation_suppressed: true });
  },
  bring_to_front: (args) => {
    for (const app of world.apps) app.active = app.pid === args.pid;
    return ok({ status: "activated", code: "bring_to_front_exact_window_verified", pid: args.pid, window_id: args.window_id ?? null, activated: true });
  },
  start_recording: (args, live) => {
    if (live.recordingFails) return failed("video recording requires macOS 15.0 or later");
    mkdirSync(join(args.output_dir, "turn-00001"), { recursive: true });
    writeFileSync(join(args.output_dir, "turn-00001", "action.json"), JSON.stringify({ tool: "click" }));
    recorder = { dir: args.output_dir, video: args.record_video === true, active: true };
    return ok({ output_dir: args.output_dir, video: args.record_video === true });
  },
  stop_recording: () => {
    if (!recorder) return failed("No recording is running.");
    const path = join(recorder.dir, "recording.mp4");
    if (recorder.video) writeFileSync(path, mp4({ width: world.screen.width, height: world.screen.height, durationMs: 2_000, frames: 60 }));
    recorder.active = false;
    return ok({ stopped: true, video_path: recorder.video ? path : null });
  },
  get_recording_state: () => ok({ active: Boolean(recorder?.active), video_active: Boolean(recorder?.active && recorder.video), last_error: null, last_video_path: recorder && !recorder.active ? join(recorder.dir, "recording.mp4") : null }),
};

async function callTool(name, args) {
  const live = read();
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ tool: name, args })}\n`);
  const schema = SCHEMAS[name];
  if (!schema || !tools[name]) return failed(`Unknown tool: ${name}`);
  const unknown = Object.keys(args).filter((key) => !(key in schema));
  if (unknown.length) return failed(`${name}: unknown argument ${unknown.join(", ")}`, { code: "invalid_arguments" });
  if (live.slow?.[name]) await sleep(live.slow[name]);
  if (live.failAfterTypes && typed >= live.failAfterTypes.count && name === live.failAfterTypes.tool) return failed(`${name} failed: WindowServer did not answer`, { code: "internal_error" });
  return refusal(name, live) ?? tools[name](args, live);
}

/** Output that is not an MCP message: JSON that is no object, a 10 MB line and bytes that are not UTF-8. */
function noise() {
  for (const line of ["null", "[1,2,3]", "42", '"text"', "true", "{}", "{\"id\":\"x\",\"result\":{}}"]) process.stdout.write(`${line}\n`);
  process.stdout.write(`{"padding":"${"x".repeat(10 * 1024 * 1024)}"}\n`);
  process.stdout.write(Buffer.concat([Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x7b]), Buffer.from("\n")]));
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  if (read().noise) noise();
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cua-driver", version: world.version }, instructions: "Act by element_token." } });
  } else if (message.method === "tools/list") {
    send({ id: message.id, result: { tools: Object.entries(SCHEMAS).map(([name, properties]) => ({ name, inputSchema: { type: "object", properties, additionalProperties: false } })) } });
  } else if (message.method === "tools/call") {
    send({ id: message.id, result: await callTool(message.params?.name, message.params?.arguments ?? {}) });
  } else send({ id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
});
lines.on("close", () => process.exit(0));
