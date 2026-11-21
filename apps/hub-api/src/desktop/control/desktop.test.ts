import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTestDirectory } from "../../test/temporary.js";

const root = makeTestDirectory("desktop-control-");
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");

const { HelperProcess } = await import("./helper-process.js");
const { DesktopError, DesktopService } = await import("./service.js");
const { Desktops } = await import("./screens.js");
type Service = InstanceType<typeof DesktopService>;
type Caller = import("./service.js").Caller;
type ServiceOptions = import("./service.js").DesktopServiceOptions;
const { ObservationLedger } = await import("./ledger.js");
const { boxToRegion, fit, imageToLogical } = await import("./mapping.js");
const { sensitiveApp } = await import("./sensitive.js");
const { elementFloor, ensembleWindow, keyboardFloor, looksSecret, pointerFloor } = await import("./floor.js");
const { CLAIM_IDLE_MS } = await import("./lease.js");
const { withDesktopImages } = await import("./images.js");
const { contentOf } = await import("../../../../../scripts/ensemble-ask-mcp.mjs");

const FAKE = fileURLToPath(new URL("./fake-helper.mjs", import.meta.url));
const services: Service[] = [];
let counter = 0;

type Harness = {
  service: Service;
  helper: InstanceType<typeof HelperProcess>;
  set: (patch: Record<string, unknown>) => Promise<unknown>;
  emit: (event: Record<string, unknown>) => Promise<unknown>;
  log: () => Promise<{ log: Array<{ id?: number; method: string; params: Record<string, unknown> }>; maxActive: number }>;
  clock: { now: () => number; advance: (ms: number) => void };
  captures: string;
};

function harness(options: { agent?: "up" | "fails"; service?: Partial<ServiceOptions> } = {}): Harness {
  let t = Date.now();
  const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
  const args = [FAKE, ...(options.agent === "up" ? ["--agent-screen"] : options.agent === "fails" ? ["--fail-agent"] : [])];
  const helper = new HelperProcess({ spawn: () => ({ command: process.execPath, args, env: { PATH: process.env.PATH ?? "" } }), helloTimeoutMs: 10_000 });
  const captures = join(root, `captures-${(counter += 1)}`);
  const service = new DesktopService({ helper, captureDir: captures, now: clock.now, secretValues: async () => ["saved-value-123"], ...(options.agent ? { screen: "agent" as const } : {}), ...options.service });
  services.push(service);
  const call = (method: string, params: Record<string, unknown>) => helper.call(method, params, { timeoutMs: 5_000 });
  return {
    service,
    helper,
    clock,
    captures,
    set: (patch) => call("test.set", patch),
    emit: (event) => call("test.emit", event),
    log: () => call("test.log", {}) as Promise<{ log: Array<{ id?: number; method: string; params: Record<string, unknown> }>; maxActive: number }>,
  };
}

// Callers here may use the owner's pointer and keyboard (the foreground) unless a test says otherwise.
const caller = (key = "node:n1:m1", extra: Partial<Caller> = {}): Caller => ({ key, label: `@${key}`, budgetMs: 30_000, gate: async () => ({ allow: true }), ...extra });
const methods = async (h: Harness, name: string) => (await h.log()).log.filter((row) => row.method === name);

before(() => {
  rmSync(join(root, "state"), { recursive: true, force: true });
});

after(async () => {
  for (const service of services) await service.stop();
  rmSync(root, { recursive: true, force: true });
});

// ── pure parts ──────────────────────────────────────────────────────────────

test("helper output that is not a JSON-RPC message is ignored: null, arrays, numbers, bytes that are not UTF-8", async () => {
  const h = harness();
  await h.helper.call("test.noise", {}, { timeoutMs: 5_000 });
  assert.equal((await h.helper.call<{ ok: boolean }>("test.set", {}, { timeoutMs: 5_000 })).ok, true);
  assert.equal(h.helper.health().state, "ready");
});

test("mapping: an image point goes to the centre of its pixel on the screen, clamped inside it", () => {
  const image = fit({ width: 2560, height: 1440 });
  assert.deepEqual(image, { width: 1568, height: 882 });
  const region = { x: 0, y: 0, width: 2560, height: 1440 };
  const screen = { width: 2560, height: 1440 };
  const point = imageToLogical({ x: 100, y: 50 }, image, region, screen);
  assert.ok(Math.abs(point.x - (100.5 * 2560) / 1568) < 1e-9);
  assert.equal(point.clamped, false);
  const edge = imageToLogical({ x: 5000, y: -20 }, image, region, screen);
  assert.ok(edge.x < 2560 && edge.x >= 2559 && edge.y >= 0 && edge.y < 2);
  assert.equal(edge.clamped, true);
  const zoom = boxToRegion([784, 441, 1568, 882], image, region, screen);
  assert.deepEqual(zoom, { x: 1280, y: 720, width: 1280, height: 720 });
  const inZoom = imageToLogical({ x: 0, y: 0 }, { width: 1280, height: 720 }, zoom, screen);
  assert.ok(inZoom.x > 1280 && inZoom.x < 1281);
});

test("ledger: only the latest look of a controller is aimed at, on the screen it was taken of", () => {
  const ledger = new ObservationLedger();
  const screen = { node: 42, x: 0, y: 0, width: 2560, height: 1440, name: "DP-2", primary: true };
  const base = { controller: "a", epoch: 1, screen, region: { x: 0, y: 0, width: 2560, height: 1440 }, image: { width: 1568, height: 882 }, frame: { width: 2560, height: 1440 }, takenAt: 1, hash: 1, parent: null, tree: null, path: null };
  const first = ledger.record({ ...base, id: "cap_000000000001" });
  const second = ledger.record({ ...base, id: "cap_000000000002" });
  assert.equal(ledger.check("a", first.id, [screen], 1).ok, false);
  assert.equal(ledger.check("a", second.id, [screen], 1).ok, true);
  assert.equal(ledger.check("b", second.id, [screen], 1).ok, false, "another controller's look");
  assert.equal(ledger.check("a", second.id, [{ ...screen, width: 1920 }], 1).ok, false, "the screen changed size");
  assert.equal(ledger.check("a", second.id, [{ ...screen, node: 43 }], 1).ok, false, "another display");
  assert.equal(ledger.check("a", second.id, [screen], 2).ok, false, "a new session");
  const zoom = ledger.record({ ...base, id: "cap_000000000003", parent: second.id });
  assert.equal(ledger.check("a", zoom.id, [screen], 1).ok, true, "a zoom of the latest look");
  ledger.owe("a", "it failed");
  assert.equal(ledger.debt("a"), "it failed");
  assert.equal(ledger.check("a", second.id, [screen], 1).ok, false);
});

test("sensitive apps and Ensemble's own windows are told apart from other apps", () => {
  assert.equal(sensitiveApp({ id: "org.keepassxc.KeePassXC", name: "KeePassXC" }), "password_manager");
  assert.equal(sensitiveApp({ id: "org.gnome.Ptyxis", name: "Terminal" }), "terminal");
  assert.equal(sensitiveApp({ id: "org.gnome.Settings", name: "Settings" }), "system_settings");
  assert.equal(sensitiveApp({ id: "org.gnome.Calculator", name: "Calculator" }), null);
  assert.equal(sensitiveApp({ id: "beekeeper-studio", name: "Beekeeper Studio" }), null);
  assert.ok(ensembleWindow({ name: "ensemble-desktop", app_id: "com.ensemblework.desktop", toolkit: "GTK" }, "Ensemble"));
  assert.ok(ensembleWindow({ name: "Terminal", app_id: "org.gnome.Ptyxis", toolkit: "GTK" }, "ensemble needs"));
  assert.equal(ensembleWindow({ name: "Terminal", app_id: "org.gnome.Ptyxis", toolkit: "GTK" }, "~/code: vim"), null);
  assert.equal(ensembleWindow({ name: "Firefox", app_id: "firefox", toolkit: "Gecko" }, "Ensemble"), null, "a page titled Ensemble is judged by its address");
  assert.equal(looksSecret("ghp_0123456789abcdefghijABCDEFGHIJ012345", []), true);
  assert.equal(looksSecret("my saved-value-123 here", ["saved-value-123"]), true);
  assert.equal(looksSecret("hello world", ["saved-value-123"]), false);
});

test("images: a screenshot marker becomes a picture line on the computer that took it, and the MCP server shows it", async () => {
  const dir = join(root, "images");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cap_0123456789ab.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  const answer = await withDesktopImages({ text: '{"summary":"Screenshot.\\n[desktop screenshot cap_0123456789ab]"}' }, dir);
  assert.match(answer.text, /\nensemble-image:data:image\/jpeg;base64,/);
  const missing = await withDesktopImages({ text: "[desktop screenshot cap_ffffffffffff]" }, dir);
  assert.equal(missing.text, "[desktop screenshot cap_ffffffffffff]");
  const content = contentOf(answer.text);
  assert.equal(content.length, 2);
  assert.equal(content[0]!.type, "text");
  assert.ok(!(content[0] as { text: string }).text.includes("ensemble-image:"));
  assert.deepEqual({ type: content[1]!.type, mimeType: (content[1] as { mimeType: string }).mimeType }, { type: "image", mimeType: "image/jpeg" });
});

// ── the service, with a helper process speaking the protocol ────────────────

test("one call at a time reaches the helper, whoever calls", { timeout: 30_000 }, async () => {
  const h = harness();
  await h.set({ slow: { "frame.capture": { ms: 250 } } });
  const a = caller();
  const [one, two, status] = await Promise.all([h.service.observe(a, {}), h.service.observe(a, {}), h.service.status()]);
  assert.notEqual(one.captureId, two.captureId);
  assert.equal(status.session.state, "on");
  assert.equal((await h.log()).maxActive, 1);
  assert.ok(existsSync(join(h.captures, `${two.captureId}.jpg`)));
});

test("one controller at a time: the others hear it is busy, with their place in line", { timeout: 30_000 }, async () => {
  const h = harness();
  await h.service.observe(caller("node:n1:m1"), {});
  const busy = await h.service.observe(caller("node:n2:m1"), {}).catch((error: unknown) => error);
  assert.ok(busy instanceof DesktopError);
  assert.equal(busy.code, "busy");
  assert.equal(busy.extra.place, 1);
  const third = await h.service.observe(caller("run:job3"), {}).catch((error: unknown) => error);
  assert.equal((third as InstanceType<typeof DesktopError>).extra.place, 2);
  const again = await h.service.observe(caller("node:n2:m1"), {}).catch((error: unknown) => error);
  assert.equal((again as InstanceType<typeof DesktopError>).extra.place, 1);
  assert.equal((await h.service.status()).controller?.label, "@node:n1:m1");
  await h.service.release("node:n1:m1");
  const next = await h.service.observe(caller("node:n2:m1"), {});
  assert.match(next.captureId, /^cap_[0-9a-f]{12}$/);
});

test("coordinates on an older look are refused; on the latest they are mapped to the screen", { timeout: 30_000 }, async () => {
  const h = harness();
  const a = caller();
  const old = await h.service.observe(a, {});
  const latest = await h.service.observe(a, {});
  const stale = await h.service.act(a, { captureId: old.captureId, foreground: true, steps: [{ action: "click", x: 100, y: 100 }], observe: false });
  assert.equal(stale.steps[0]!.verdict, "refused");
  assert.equal(stale.steps[0]!.code, "stale_capture");
  assert.equal(stale.steps[0]!.ran, "no");
  assert.equal((await methods(h, "input.pointer")).length, 0);
  const done = await h.service.act(a, { captureId: latest.captureId, foreground: true, steps: [{ action: "click", x: 100, y: 100 }] });
  assert.equal(done.steps[0]!.verdict, "confirmed");
  assert.equal(done.steps[0]!.ran, "yes");
  const sent = await methods(h, "input.pointer");
  assert.ok(Math.abs((sent[0]!.params.x as number) - (100.5 * 2560) / 1568) < 1e-6);
  assert.ok(done.observation, "a fresh look comes back");
  const afterwards = await h.service.act(a, { captureId: latest.captureId, foreground: true, steps: [{ action: "click", x: 5, y: 5 }], observe: false });
  assert.equal(afterwards.steps[0]!.code, "stale_capture", "the look before the input is stale after it");
});

test("a new session (other screens) makes every look stale", { timeout: 30_000 }, async () => {
  const h = harness();
  const a = caller();
  const look = await h.service.observe(a, {});
  await h.set({ epoch: 7, streams: [{ node: 50, x: 0, y: 0, width: 1920, height: 1080, frame_width: 1920, frame_height: 1080, name: "HDMI-1", primary: true }] });
  await h.emit({ kind: "session.started", epoch: 7, streams: [{ node: 50, x: 0, y: 0, width: 1920, height: 1080, name: "HDMI-1", primary: true }] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const result = await h.service.act(a, { captureId: look.captureId, foreground: true, steps: [{ action: "click", x: 10, y: 10 }], observe: false });
  assert.equal(result.steps[0]!.code, "stale_capture");
});

test("after a failed look only waiting and opening run until a look works", { timeout: 30_000 }, async () => {
  const h = harness();
  const a = caller();
  const look = await h.service.observe(a, {});
  await h.set({ fail: { "frame.capture": { kind: "capture_failed", message: "The screen stream stopped." } } });
  await assert.rejects(h.service.observe(a, {}), (error: unknown) => error instanceof DesktopError && error.code === "capture_failed");
  const blocked = await h.service.act(a, { captureId: look.captureId, foreground: true, steps: [{ action: "click", x: 10, y: 10 }], observe: false });
  assert.equal(blocked.steps[0]!.code, "observation_required");
  const waited = await h.service.act(a, { steps: [{ action: "wait", ms: 10 }], observe: false });
  assert.equal(waited.steps[0]!.verdict, "confirmed");
  await h.set({ fail: {} });
  const fresh = await h.service.observe(a, {});
  const works = await h.service.act(a, { captureId: fresh.captureId, foreground: true, steps: [{ action: "click", x: 10, y: 10 }], observe: false });
  assert.equal(works.steps[0]!.verdict, "confirmed");
});

test("the owner's input takes the computer: the agent pauses, and gets it back after two quiet minutes with a new counter", { timeout: 30_000 }, async () => {
  const h = harness();
  const a = caller();
  const look = await h.service.observe(a, {});
  await h.service.act(a, { captureId: look.captureId, foreground: true, steps: [{ action: "click", x: 10, y: 10 }] });
  const counter = h.service.lease.counter;
  h.clock.advance(10_000);
  await h.set({ idle: 2_000 });
  const paused = await h.service.act(a, { foreground: true, steps: [{ action: "key", keys: "Return" }], observe: false });
  assert.equal(paused.steps[0]!.code, "owner_has_control");
  assert.equal(paused.steps[0]!.ran, "no");
  assert.equal(h.service.lease.holder, "owner");
  assert.equal(h.service.lease.counter, counter + 1);
  await assert.rejects(h.service.observe(a, {}), (error: unknown) => error instanceof DesktopError && error.code === "owner_has_control");
  h.clock.advance(130_000);
  await h.set({ idle: 130_000 });
  const back = await h.service.observe(a, {});
  assert.equal(h.service.lease.holder, "agent");
  assert.equal(h.service.lease.counter, counter + 2);
  assert.match(back.captureId, /^cap_/);
});

test("a look the owner's takeover overlapped is discarded with its file", { timeout: 30_000 }, async () => {
  const h = harness();
  const a = caller();
  await h.service.observe(a, {});
  await h.set({ slow: { "frame.capture": { ms: 400 } } });
  const looking = h.service.observe(a, {});
  setTimeout(() => h.service.lease.take("owner_input"), 150);
  await assert.rejects(looking, (error: unknown) => error instanceof DesktopError && error.code === "owner_has_control");
  assert.equal(readdirSync(h.captures).length, 1, "only the first look's screenshot is kept");
});

test("a step the helper does not answer in time may have run; the helper is started again", { timeout: 40_000 }, async () => {
  const h = harness();
  const a = caller("node:n1:m1", { budgetMs: 7_000 });
  const look = await h.service.observe(a, {});
  await h.set({ slow: { "input.pointer": { ms: 20_000, when: { action: "click" } } } });
  const result = await h.service.act(a, { captureId: look.captureId, foreground: true, steps: [{ action: "click", x: 10, y: 10 }, { action: "key", keys: "Return" }], observe: false });
  assert.equal(result.steps[0]!.verdict, "unknown");
  assert.equal(result.steps[0]!.ran, "maybe");
  assert.equal(result.steps[1]!.verdict, "not_run");
  assert.ok(result.stopped);
  // Killed so it can never act on that click later: its end arrives just after.
  for (let tries = 0; tries < 40 && h.helper.health().crashes === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.helper.health().crashes, 1);
  const status = await h.service.status();
  assert.equal(status.helper.restarts, 1);
  assert.equal(status.helper.state, "ready");
});

test("a recording is saved under a new name, never over a file, hashed, with its poster, and held", { timeout: 30_000 }, async () => {
  const h = harness();
  const a = caller();
  const evidenceDir = join(root, "evidence-recording");
  await h.service.recordStart(a, { evidenceDir });
  await assert.rejects(h.service.recordStart(a, { evidenceDir }), (error: unknown) => error instanceof DesktopError && error.code === "recording_active");
  const first = await h.service.recordSave(a, { name: "Demo run" });
  assert.equal(first.path, join(evidenceDir, "demo-run.webm"));
  assert.equal(first.codec, "vp8");
  assert.equal(first.durationMs, 5000);
  assert.equal(first.held, true);
  assert.equal(first.sha256, createHash("sha256").update(readFileSync(first.path)).digest("hex"));
  assert.ok(first.poster && existsSync(first.poster.path));
  await h.service.recordStart(a, { evidenceDir });
  const second = await h.service.recordSave(a, { name: "Demo run" });
  assert.equal(second.path, join(evidenceDir, "demo-run-2.webm"));
  await h.service.recordStart(a, { evidenceDir });
  await h.service.recordDiscard(a);
  assert.deepEqual(readdirSync(evidenceDir).filter((name) => name.endsWith(".part")), [], "a discarded recording leaves nothing");
});

test("the hard floor: Ensemble's own windows and pages, password prompts and secrets typed as text", { timeout: 30_000 }, async () => {
  const h = harness();
  const a = caller("node:n1:m1", { secret: async (name) => (name === "GH_PASSWORD" ? "s3cr3t-Value-99" : null) });
  const calculator = { name: "Calculator", toolkit: "GTK", pid: 501, app_id: "org.gnome.Calculator" };
  const ensemble = { name: "ensemble-desktop", toolkit: "GTK", pid: 900, app_id: "com.ensemblework.desktop" };
  const look = await h.service.observe(a, {});

  await h.set({ focus: { app: ensemble, window: { index: 0, title: "Ensemble", role: "frame" }, shell: false, prompt: null, focused: { role: "push button", name: "Allow", editable: false }, documents: [] } });
  const typed = await h.service.act(a, { foreground: true, steps: [{ action: "type", text: "yes" }], observe: false });
  assert.equal(typed.steps[0]!.verdict, "refused");
  assert.equal(typed.steps[0]!.rule, "ensemble_window");

  await h.set({
    focus: { app: calculator, window: { index: 0, title: "Calculator", role: "frame" }, shell: false, prompt: null, focused: null, documents: [] },
    apps: [{ ...calculator, windows: [{ index: 0, title: "Calculator", role: "frame", active: true, showing: true, iconified: false }] }, { ...ensemble, windows: [{ index: 0, title: "Ensemble", role: "frame", active: false, showing: true, iconified: false }] }],
  });
  const fresh = await h.service.observe(a, {});
  const click = await h.service.act(a, { captureId: fresh.captureId, foreground: true, steps: [{ action: "click", x: 50, y: 50 }], observe: false });
  assert.equal(click.steps[0]!.rule, "ensemble_window", "a click by position while Ensemble shows");
  const again = await h.service.observe(a, {});
  const press = await h.service.act(a, { captureId: again.captureId, foreground: true, steps: [{ action: "press", element: "e1" }], observe: false });
  assert.equal(press.steps[0]!.verdict, "confirmed", "an element of another app is exact");

  await h.set({ apps: [{ ...calculator, windows: [{ index: 0, title: "Calculator", role: "frame", active: true, showing: true, iconified: false }] }], focus: { app: { name: "Firefox", toolkit: "Gecko", pid: 70, app_id: "firefox" }, window: { index: 0, title: "Ensemble", role: "frame" }, shell: false, prompt: null, focused: null, documents: [{ app: "Firefox", url: "https://app.ensemblework.com/r/1", window: "Ensemble", active: true }] } });
  const page = await h.service.observe(a, {});
  const onPage = await h.service.act(a, { captureId: page.captureId, foreground: true, steps: [{ action: "click", x: 50, y: 50 }], observe: false });
  assert.equal(onPage.steps[0]!.rule, "ensemble_page");

  await h.set({ focus: { app: { name: "gnome-shell", toolkit: "GNOME Shell", pid: 2, app_id: null }, window: { index: 0, title: "", role: "window" }, shell: true, prompt: { title: "Authentication Required" }, focused: { role: "password text", name: "", editable: true }, documents: [] } });
  const prompt = await h.service.act(a, { foreground: true, steps: [{ action: "type", text: "anything" }], observe: false });
  assert.equal(prompt.steps[0]!.rule, "password_prompt");

  await h.set({ focus: { app: calculator, window: { index: 0, title: "Calculator", role: "frame" }, shell: false, prompt: null, focused: { role: "text", name: "Notes", editable: true, text: "" }, documents: [] } });
  const token = await h.service.act(a, { foreground: true, steps: [{ action: "type", text: "ghp_0123456789abcdefghijABCDEFGHIJ012345" }], observe: false });
  assert.equal(token.steps[0]!.rule, "secret_text");
  const saved = await h.service.act(a, { foreground: true, steps: [{ action: "type", text: "the saved-value-123" }], observe: false });
  assert.equal(saved.steps[0]!.rule, "secret_text");

  await h.set({ focus: { app: calculator, window: { index: 0, title: "Calculator", role: "frame" }, shell: false, prompt: null, focused: { role: "password text", name: "Password", editable: true }, documents: [] } });
  const plain = await h.service.act(a, { foreground: true, steps: [{ action: "type", text: "hunter2" }], observe: false });
  assert.equal(plain.steps[0]!.rule, "secret_field");
  assert.equal((await methods(h, "input.text")).length, 0, "nothing was typed so far");
  const reference = await h.service.act(a, { foreground: true, steps: [{ action: "type", text: "$GH_PASSWORD" }], observe: false });
  assert.equal(reference.steps[0]!.ran, "yes");
  const sent = await methods(h, "input.text");
  assert.equal(sent.at(-1)!.params.text, "s3cr3t-Value-99");
  assert.ok(!JSON.stringify(reference).includes("s3cr3t-Value-99"), "the value never comes back");
  void look;
});

test("the owner's pointer and keyboard, and a sensitive app, are each asked once per mission; unattended work goes ahead", { timeout: 40_000 }, async () => {
  const h = harness();
  const { runNodeDesktop } = await import("./device.js");
  const rules: Array<{ userId: string; source: string; toolName: string; pattern: string; decision: string; sessionId: string | null }> = [];
  const match = (where: Record<string, unknown>) => (rule: (typeof rules)[number]) => Object.entries(where).every(([key, value]) => (rule as Record<string, unknown>)[key] === value);
  const prisma = {
    decisionRule: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => rules.find(match(where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => rules.filter(match(where)),
      create: async ({ data }: { data: (typeof rules)[number] }) => (rules.push(data), data),
    },
  };
  await h.set({ focus: { app: { name: "Terminal", toolkit: "GTK", pid: 66, app_id: "org.gnome.Ptyxis" }, window: { index: 0, title: "~", role: "frame" }, shell: false, prompt: null, focused: { role: "terminal", name: "", editable: true }, documents: [] } });
  const screens = new Desktops(h.service, () => assert.fail("this work stays on the owner's screen"));
  const request = (mission: string, extra: Record<string, unknown> = {}) =>
    ({ id: "q1", nodeId: "n1", nodeSlug: "helper", mission, attended: true, grants: [], tool: "desktop", name: "desktop_act", input: { screen: "owner", foreground: true, steps: [{ action: "type", text: "ls" }] }, operation: "node:n1:own", inlineImage: false, ...extra }) as never;
  const app = { prisma } as never;
  const client = {} as never;
  const screenGrant = { id: "g0", scope: "mission", target: "screen:owner" };
  const terminalGrant = { id: "g1", scope: "mission", target: "org.gnome.Ptyxis" };

  const asked = await runNodeDesktop(app, client, request("plan-1"), screens);
  assert.equal(asked.status, 428);
  assert.deepEqual(asked.body.ask, { capability: "desktop", target: "screen:owner", label: "the pointer and keyboard", scope: "app", weak: false });
  const terminal = await runNodeDesktop(app, client, request("plan-1", { grants: [screenGrant] }), screens);
  assert.equal(terminal.status, 428);
  assert.deepEqual(terminal.body.ask, { capability: "desktop", target: "org.gnome.Ptyxis", label: "Terminal", scope: "app", weak: false });
  assert.equal((await methods(h, "input.text")).length, 0);

  const allowed = await runNodeDesktop(app, client, request("plan-1", { grants: [screenGrant, terminalGrant] }), screens);
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.grantsUsed, ["g0", "g1"]);
  assert.equal((await methods(h, "input.text")).length, 1);
  assert.match(String(allowed.body.summary), /on your owner's screen, with their pointer and keyboard/);

  const later = await runNodeDesktop(app, client, request("plan-1"), screens);
  assert.equal(later.status, 200, "the same mission is not asked again");
  await screens.release("node:n1:plan-1");
  const other = await runNodeDesktop(app, client, request("plan-2"), screens);
  assert.equal(other.status, 428, "another mission asks again");
  await screens.release("node:n1:plan-2");
  const unattended = await runNodeDesktop(app, client, request("plan-3", { attended: false }), screens);
  assert.equal(unattended.status, 200);
  assert.equal(rules.length, 2);
});

// ── background mode and the agent screen ────────────────────────────────────

test("in the background on the owner's screen, steps on elements go through accessibility; anything else needs the screen and sends nothing", { timeout: 30_000 }, async () => {
  const h = harness();
  const a = caller("node:n1:m1", { gate: async () => assert.fail("the background asks nobody") });
  await h.set({ idle: 300_000 });
  const look = await h.service.observe(a, {});
  const done = await h.service.act(a, { steps: [{ action: "press", element: "e1" }, { action: "type", element: "e2", text: "12" }, { action: "select", element: "e1" }, { action: "toggle", element: "e1" }, { action: "scroll", element: "e1" }], observe: false });
  assert.equal(done.mode, "background");
  assert.equal(done.screen, "owner");
  assert.deepEqual(done.steps.map((step) => step.verdict), ["confirmed", "confirmed", "confirmed", "confirmed", "confirmed"]);
  assert.deepEqual((await methods(h, "a11y.do")).map((row) => row.params.action), ["press", "insert_text", "select", "toggle", "scroll_to"]);
  for (const step of [{ action: "click", x: 10, y: 10, captureId: look.captureId }, { action: "type", text: "hello" }, { action: "key", keys: "ctrl+s" }, { action: "focus", element: "e2" }, { action: "double_click", element: "e1" }, { action: "open", app: "org.gnome.Calculator" }] as const) {
    await h.service.observe(a, {});
    const refused = await h.service.act(a, { steps: [step], observe: false });
    assert.equal(refused.steps[0]!.verdict, "refused", step.action);
    assert.equal(refused.steps[0]!.code, "needs_screen");
    assert.match(refused.steps[0]!.detail ?? "", /^Needs the screen: ask to use the owner's screen .* or use the agent screen\./);
  }
  const sent = (await h.log()).log.filter((row) => row.method.startsWith("input.") || row.method === "apps.launch");
  assert.deepEqual(sent, [], "no pointer, keyboard or launch on the owner's screen");
});

test("a background step waits while the owner uses the app it acts in; elsewhere it goes on while they type", { timeout: 30_000 }, async () => {
  const h = harness({ service: { ownerWaitMs: 0 } });
  const a = caller();
  await h.service.observe(a, {});
  await h.set({ idle: 1_500 });
  const waiting = await h.service.act(a, { steps: [{ action: "press", element: "e1" }], observe: false });
  assert.equal(waiting.steps[0]!.verdict, "not_run");
  assert.equal(waiting.steps[0]!.code, "owner_using_app");
  assert.equal((await methods(h, "a11y.do")).length, 0);
  await h.set({ focus: { app: { name: "Text Editor", toolkit: "GTK", pid: 777, app_id: "org.gnome.TextEditor" }, window: { index: 0, title: "notes", role: "frame" }, shell: false, prompt: null, focused: { role: "text", name: "", editable: true }, documents: [] } });
  const elsewhere = await h.service.act(a, { steps: [{ action: "press", element: "e1" }], observe: false });
  assert.equal(elsewhere.steps[0]!.verdict, "confirmed", "the owner types in another app");
  const foreground = await h.service.act(a, { foreground: true, steps: [{ action: "key", keys: "Return" }], observe: false });
  assert.equal(foreground.steps[0]!.code, "owner_has_control", "their keyboard waits until they pause");
  assert.equal((await methods(h, "input.keys")).length, 0);
});

test("a look at elements only needs no screen control; its ids work, its coordinates do not", { timeout: 30_000 }, async () => {
  const h = harness();
  const a = caller();
  await h.set({ idle: 300_000 });
  const look = await h.service.observe(a, { screenshot: false, app: "Calculator" });
  assert.equal(look.image, null);
  assert.equal(look.tree?.elements.length, 3);
  const pressed = await h.service.act(a, { steps: [{ action: "press", element: "e1" }] });
  assert.deepEqual([pressed.steps[0]!.verdict, pressed.steps[0]!.ran], ["unknown", "yes"], "without a screenshot to compare, the new look shows what changed");
  assert.ok(pressed.observation && pressed.observation.image === null, "the new look is of elements only too");
  const aimed = await h.service.act(a, { captureId: pressed.observation!.captureId, foreground: true, steps: [{ action: "click", x: 5, y: 5 }], observe: false });
  assert.equal(aimed.steps[0]!.code, "observation_required");
  assert.equal((await methods(h, "session.start")).length, 0, "no screen control was started");
  h.service.lease.take("owner_input");
  await h.set({ idle: 1_000, focus: { app: { name: "Text Editor", toolkit: "GTK", pid: 777, app_id: "org.gnome.TextEditor" }, window: { index: 0, title: "notes", role: "frame" }, shell: false, prompt: null, focused: null, documents: [] } });
  await assert.rejects(h.service.observe(a, {}), (error: unknown) => error instanceof DesktopError && error.code === "owner_has_control" && /screenshot false/.test(error.message));
  const stillReads = await h.service.observe(a, { screenshot: false, app: "Calculator" });
  assert.equal(stillReads.tree?.app, "Calculator", "elements of another app are read while the owner types");
});

test("on the agent screen the pointer and keyboard are the agent's: no owner checks, results name the screen", { timeout: 30_000 }, async () => {
  const h = harness({ agent: "up" });
  const a = caller("node:n1:m1", { gate: async (app) => (app.id === "screen:owner" ? assert.fail("the agent screen is not the owner's") : { allow: true }) });
  const opened = await h.service.open(a, { app: "org.gnome.Calculator" });
  assert.equal(opened.screen, "agent");
  const look = await h.service.observe(a, {});
  assert.equal(look.screen, "agent");
  assert.equal(look.display?.id, "Meta-0");
  const done = await h.service.act(a, { captureId: look.captureId, steps: [{ action: "click", x: 100, y: 100 }, { action: "type", text: "7*6" }, { action: "key", keys: "Return" }] });
  assert.equal(done.mode, "agent_screen");
  assert.deepEqual(done.steps.map((step) => step.ran), ["yes", "yes", "yes"]);
  assert.equal((await methods(h, "idle")).length, 0, "nobody's idle time is read there");
  const { actText, observationText } = await import("./text.js");
  assert.match(actText(done), /3 of 3 steps ran, on the agent screen\./);
  assert.match(observationText(look), /of the agent screen: monitor Meta-0/);
  await assert.rejects(h.service.handoff(a, { reason: "password" }), (error: unknown) => error instanceof DesktopError && error.code === "unsupported");
  const frame = await h.service.liveFrame({ maxWidth: 800 });
  assert.equal(frame.screen, "agent");
  assert.ok(frame.base64.length > 0 && frame.width <= 800);
  assert.equal((await methods(h, "frame.capture")).at(-1)!.params.save_path, undefined, "a live frame is kept nowhere");
});

test("an agent screen that cannot start says why, and nothing moves to the owner's screen", { timeout: 30_000 }, async () => {
  const owner = harness();
  const agent = harness({ agent: "fails" });
  const screens = new Desktops(owner.service, () => agent.service);
  const a = caller();
  const where = screens.pick(a.key, {});
  assert.equal(where, "agent", "work starts on the agent screen");
  await assert.rejects(screens.service(where).observe(a, {}), (error: unknown) => error instanceof DesktopError && error.code === "unavailable" && /could not start.*Fix:/.test(error.message));
  assert.equal(agent.helper.health().state, "unavailable");
  assert.equal(owner.helper.health().state, "stopped", "the owner's screen was not touched");
});

test("a call works on the screen it names, its look's, its recording's or the last one used, else the agent screen", { timeout: 30_000 }, async () => {
  const owner = harness();
  const agent = harness({ agent: "up" });
  const screens = new Desktops(owner.service, () => agent.service);
  const a = caller();
  assert.equal(screens.runningAgent(), null, "asking does not start the agent screen");
  const both = await screens.status(20_000, async () => ({ ready: true, version: "GNOME Shell 50.1" }));
  assert.equal(both.agent, null);
  const { statusText } = await import("./text.js");
  assert.match(statusText(both), /The agent screen \(yours, private\): ready, not running/);
  const ownerLook = await screens.service("owner").observe(a, {});
  screens.remember(a.key, "owner");
  assert.equal(screens.pick(a.key, {}), "owner", "where it last worked");
  assert.equal(screens.pick(a.key, { screen: "agent" }), "agent");
  const agentLook = await screens.service("agent").observe(a, {});
  screens.remember(a.key, "agent");
  assert.equal(screens.pick(a.key, { captureId: ownerLook.captureId }), "owner", "a look's own screen");
  assert.equal(screens.pick(a.key, { captureId: agentLook.captureId }), "agent");
  await screens.service("owner").recordStart(a, { evidenceDir: join(root, "evidence-router") });
  assert.equal(screens.pick(a.key, { recording: true }), "owner", "save goes where the recording is");
  assert.ok(screens.runningAgent());
  const apps = await screens.apps({ running: true }, 20_000);
  assert.deepEqual(apps.map((list) => list.screen), ["owner", "agent"]);
  await screens.release(a.key);
  assert.equal(screens.pick(a.key, {}), "agent");
});

// ── what a review found ─────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const calculatorApp = { name: "Calculator", toolkit: "GTK", pid: 501, app_id: "org.gnome.Calculator" };
const calculatorWindow = { index: 0, title: "Calculator", role: "frame", active: true, showing: true, iconified: false };

test("a browser page whose address cannot be read counts as Ensemble's: no clicks, typing or element actions in that window", () => {
  const chromium = { name: "Chromium", toolkit: "Chromium", pid: 70, app_id: "chromium" };
  const unknown = { app: "Chromium", url: null, window: "Some page", active: true };
  const focus = { app: chromium, window: { index: 0, title: "Some page", role: "frame" }, shell: false, prompt: null, focused: null, documents: [unknown] };
  assert.equal(keyboardFloor(focus)?.rule, "unknown_page");
  assert.equal(elementFloor(chromium, "Some page", focus)?.rule, "unknown_page");
  const behind = { ...focus, app: calculatorApp, window: { index: 0, title: "Calculator", role: "frame" }, documents: [{ ...unknown, active: false }] };
  assert.equal(pointerFloor(behind, [])?.rule, "unknown_page", "a click by position could land in it");
  assert.equal(keyboardFloor(behind), null, "the keyboard goes to the calculator in front");
  assert.equal(elementFloor(chromium, "Another window", focus), null, "another window is judged by its own page");
  const readable = { ...focus, documents: [{ ...unknown, url: "https://example.com/" }] };
  assert.equal(keyboardFloor(readable), null);
  assert.equal(pointerFloor(readable, []), null);
});

test("typing that stops because the owner acted, or the window in front changed, is partial", { timeout: 30_000 }, async () => {
  const h = harness();
  const a = caller();
  await h.set({ idle: 300_000, typing: { after: 3, stopped: "owner_input" } });
  const owner = await h.service.act(a, { foreground: true, steps: [{ action: "type", text: "hello world" }, { action: "key", keys: "Return" }], observe: false });
  assert.deepEqual([owner.steps[0]!.verdict, owner.steps[0]!.ran], ["partial", "yes"]);
  assert.match(owner.steps[0]!.detail ?? "", /3 of 11 characters.*owner/);
  assert.equal(owner.steps[1]!.verdict, "not_run");
  assert.equal(h.service.lease.holder, "owner", "the computer is the owner's until they stop");
  h.service.lease.release("test");
  await h.set({ typing: { after: 5, stopped: "focus_moved" } });
  const moved = await h.service.act(a, { foreground: true, steps: [{ action: "type", text: "hello world" }], observe: false });
  assert.deepEqual([moved.steps[0]!.verdict, moved.steps[0]!.ran], ["partial", "yes"]);
  assert.match(moved.steps[0]!.detail ?? "", /window in front changed/);
  assert.equal(h.service.lease.holder, "agent");
});

test("ending a controller's work cancels its request in the helper", { timeout: 30_000 }, async () => {
  const h = harness();
  const a = caller();
  await h.set({ idle: 300_000, slow: { "input.text": { ms: 6_000, ran: "yes" } } });
  const started = Date.now();
  const acting = h.service.act(a, { foreground: true, steps: [{ action: "type", text: "a long text" }], observe: false });
  await sleep(500);
  await h.service.release(a.key);
  const done = await acting;
  assert.ok(Date.now() - started < 4_000, "it did not wait for the slow request to end");
  assert.equal(done.steps[0]!.ran, "yes");
  const sent = (await h.log()).log;
  const typing = sent.find((row) => row.method === "input.text");
  assert.deepEqual(sent.filter((row) => row.method === "cancel").map((row) => row.params.id), [typing!.id]);
});

test("a click by position asks about each sensitive app showing on the screen, not only the one in front", { timeout: 30_000 }, async () => {
  const h = harness();
  const asked: string[] = [];
  const a = caller("node:n1:m1", {
    gate: async (app) => {
      asked.push(app.id);
      return app.id === "org.gnome.Ptyxis" ? { allow: false, ask: true } : { allow: true };
    },
  });
  const terminal = { name: "Terminal", toolkit: "GTK", pid: 66, app_id: "org.gnome.Ptyxis", windows: [{ index: 0, title: "~", role: "frame", active: false, showing: true, iconified: false }] };
  await h.set({ idle: 300_000, apps: [{ ...calculatorApp, windows: [calculatorWindow] }, terminal] });
  const look = await h.service.observe(a, {});
  await assert.rejects(
    h.service.act(a, { captureId: look.captureId, foreground: true, steps: [{ action: "click", x: 50, y: 50 }], observe: false }),
    (error: unknown) => error instanceof DesktopError && error.code === "needs_owner" && (error.extra.app as { id: string }).id === "org.gnome.Ptyxis",
  );
  assert.equal((await methods(h, "input.pointer")).length, 0);
  assert.deepEqual(asked, ["screen:owner", "org.gnome.Ptyxis"]);
  await h.set({ apps: [{ ...calculatorApp, windows: [calculatorWindow] }, { ...terminal, windows: [{ ...terminal.windows[0]!, iconified: true }] }] });
  const again = await h.service.observe(a, {});
  const clicked = await h.service.act(a, { captureId: again.captureId, foreground: true, steps: [{ action: "click", x: 50, y: 50 }], observe: false });
  assert.equal(clicked.steps[0]!.ran, "yes", "a minimised terminal is not where a click lands");
});

test("in the background a press that could only move the focus is refused", { timeout: 30_000 }, async () => {
  const h = harness();
  const a = caller();
  await h.set({ idle: 300_000 });
  await h.service.observe(a, {});
  const done = await h.service.act(a, { steps: [{ action: "press", element: "e2" }], observe: false });
  assert.deepEqual([done.steps[0]!.verdict, done.steps[0]!.code, done.steps[0]!.ran], ["refused", "needs_screen", "no"]);
  assert.equal((await methods(h, "a11y.do"))[0]!.params.background, true);
});

test("a saved secret is typed as one: never through the clipboard, and whole or not at all", { timeout: 30_000 }, async () => {
  const h = harness();
  const a = caller("node:n1:m1", { secret: async (name) => (name === "PIN" ? "pässwörd" : null) });
  await h.set({ idle: 300_000, focus: { app: calculatorApp, window: { index: 0, title: "Sign in", role: "frame" }, shell: false, prompt: null, focused: { role: "password text", name: "Password", editable: true }, documents: [] } });
  const refused = await h.service.act(a, { foreground: true, steps: [{ action: "type", text: "$PIN" }], observe: false });
  assert.deepEqual([refused.steps[0]!.verdict, refused.steps[0]!.ran, refused.steps[0]!.rule], ["refused", "no", "secret_field"]);
  assert.equal((await methods(h, "input.text")).at(-1)!.params.secret, true);
  assert.ok(!JSON.stringify(refused).includes("pässwörd"), "the value never comes back");
  await h.set({ fillSecrets: true });
  const filled = await h.service.act(a, { foreground: true, steps: [{ action: "type", text: "$PIN" }], observe: false });
  assert.equal(filled.steps[0]!.ran, "yes");
});

test("an unsaved recording is dropped once its time to be saved has passed, and its controller is let go", { timeout: 30_000 }, async () => {
  const { RECORDING_SAVE_MS } = await import("./service.js");
  const h = harness();
  const a = caller("node:n1:m1");
  const evidenceDir = join(root, "evidence-unsaved");
  const started = await h.service.recordStart(a, { evidenceDir, maxSec: 60 });
  await h.emit({ kind: "record.stopped", id: started.id, reason: "max_duration" });
  await sleep(100);
  await assert.rejects(h.service.observe(caller("node:n2:m1"), {}), (error: unknown) => error instanceof DesktopError && error.code === "busy", "it waits to be saved for a while");
  h.clock.advance(RECORDING_SAVE_MS + CLAIM_IDLE_MS + 1_000);
  const look = await h.service.observe(caller("node:n2:m1"), {});
  assert.match(look.captureId, /^cap_/);
  assert.deepEqual(readdirSync(evidenceDir).filter((name) => name.endsWith(".part")), []);
  assert.equal((await methods(h, "record.discard")).length, 1);
  await assert.rejects(h.service.recordSave(a, {}), (error: unknown) => error instanceof DesktopError && error.code === "no_recording" && /not saved/.test(error.message));
});

test("a recording the helper lost leaves no partial file", { timeout: 30_000 }, async () => {
  const h = harness();
  const evidenceDir = join(root, "evidence-lost");
  await h.service.recordStart(caller(), { evidenceDir });
  assert.equal(readdirSync(evidenceDir).filter((name) => name.endsWith(".part")).length, 1);
  process.kill(h.helper.health().pid!, "SIGKILL");
  for (let tries = 0; tries < 60 && readdirSync(evidenceDir).some((name) => name.endsWith(".part")); tries += 1) await sleep(50);
  assert.deepEqual(readdirSync(evidenceDir).filter((name) => name.endsWith(".part")), []);
});

test("partial recordings a stopped runtime left are swept from the evidence folders", { timeout: 30_000 }, async () => {
  const { sweepRecordingParts } = await import("./service.js");
  const evidence = join(root, "evidence-sweep");
  mkdirSync(join(evidence, "node", "abc"), { recursive: true });
  mkdirSync(join(evidence, "job1"), { recursive: true });
  const stale = join(evidence, "node", "abc", ".desktop-recording-0123456789ab.part");
  const live = join(evidence, "job1", ".desktop-recording-ba9876543210.part");
  const other = join(evidence, "job1", "notes.part");
  for (const path of [stale, live, other]) writeFileSync(path, "x");
  const hourAgo = (Date.now() - 3_600_000) / 1000;
  utimesSync(stale, hourAgo, hourAgo);
  utimesSync(other, hourAgo, hourAgo);
  assert.equal(await sweepRecordingParts(evidence, 30 * 60_000), 1);
  assert.deepEqual([existsSync(stale), existsSync(live), existsSync(other)], [false, true, true]);
});
