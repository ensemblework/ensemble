/**
 * The capture service with a real headless Chromium and this computer's ffmpeg: web screenshots at
 * two viewports, a frame-stepped CSS animation checked frame by frame in the encoded video,
 * real-time video, the media pipeline's container and codec, privacy holds, terminal transcripts,
 * and the checks before sending. Parts that need what this computer lacks (Chromium, an encoder,
 * H.264, Xvfb) are skipped with the reason.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserBroker } from "../browser/broker.js";
import { findChromium } from "../browser/chromium.js";
import type { PrivacyRules } from "../browser/privacy.js";
import { chooseVideoEncoder, findFfmpegs, type VideoChoice } from "./ffmpeg.js";
import { recordStepped } from "./frames.js";
import { CaptureError } from "./media.js";
import { decodePng, imageInfo, probeVideo } from "./probe.js";
import { CaptureService, type CaptureRequest } from "./service.js";
import { findDisplayTools } from "./display.js";
import { findOnPath } from "./system.js";
import { runCaptureTool } from "./tools.js";

const skip = findChromium({ headless: true }) ? false : "no Chromium on this computer (run `ensemble capture setup`)";
const SECRET = "s3cret-value-for-capture";

const PAGES: Record<string, string> = {
  "/": `<!doctype html><meta name="viewport" content="width=device-width"><title>Sign-up</title>
    <style>body{font:16px sans-serif;margin:24px} main{max-width:640px;margin:auto} @media (max-width:500px){h1{font-size:22px}}</style>
    <main><h1>Create your account</h1><label>Email <input type="email"></label><button>Sign up</button><p>Already have one? Sign in.</p></main>`,
  "/blank": `<!doctype html><title>Blank</title><body style="background:#fff"></body>`,
  "/anim": `<!doctype html><title>Animation</title><style>body{margin:0;background:#fff}#box{position:absolute;left:0;top:40px;width:50px;height:50px;background:#f00;animation:slide 1s linear infinite}@keyframes slide{from{transform:translateX(0)}to{transform:translateX(300px)}}</style><div id="box"></div>`,
  "/secret": `<!doctype html><title>Keys</title><p>API key: ${SECRET}</p><div style="width:200px;height:100px;background:#09c"></div>`,
  "/clock": `<!doctype html><title>Clock</title><p id="t">0</p><script>const start = performance.now(); requestAnimationFrame(function f(){ document.getElementById('t').textContent = Math.round(performance.now() - start); requestAnimationFrame(f); });</script>`,
};

let server: Server;
let base = "";
let root = "";
let broker: BrowserBroker;
let service: CaptureService;
let choice: VideoChoice | null = null;
const rules: PrivacyRules = { secretValues: [SECRET] };

test.before(async () => {
  root = mkdtempSync(join(tmpdir(), "ensemble-capture-"));
  server = createServer((request, response) => {
    const page = PAGES[new URL(request.url ?? "/", "http://x").pathname];
    response.writeHead(page ? 200 : 404, { "content-type": "text/html" });
    response.end(page ?? "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  broker = new BrowserBroker({ dataHome: join(root, "data"), privacy: () => rules });
  service = new CaptureService({ broker, dataHome: join(root, "data") });
  await service.start();
  choice = chooseVideoEncoder(await findFfmpegs());
});

test.after(async () => {
  await service?.shutdown();
  await broker?.shutdown();
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  if (root) rmSync(root, { recursive: true, force: true });
});

function request(name: string, over: Partial<CaptureRequest> = {}): CaptureRequest {
  const evidenceDir = join(root, "evidence", name);
  mkdirSync(evidenceDir, { recursive: true });
  return { operation: `job-${name}`, evidenceDir, ...over };
}

/** Decodes a video into PNG frames with the ffmpeg that wrote it. */
function decodeFrames(video: string, into: string): string[] {
  mkdirSync(into, { recursive: true });
  const run = spawnSync(choice!.ffmpeg.path, ["-hide_banner", "-loglevel", "error", "-i", video, "-f", "image2", "-c:v", "png", join(into, "f%04d.png")]);
  assert.equal(run.status, 0, run.stderr?.toString());
  return readdirSync(into).sort().map((name) => join(into, name));
}

/** The red box's left edge on row `y`: the first clearly red pixel. */
function redLeftEdge(image: { width: number; data: Uint8Array }, y: number): number {
  for (let x = 0; x < image.width; x += 1) {
    const at = (y * image.width + x) * 4;
    if (image.data[at]! > 170 && image.data[at + 1]! < 100 && image.data[at + 2]! < 100) return x;
  }
  return -1;
}

test("screenshots of a localhost page at two viewports, checked as not blank", { skip, timeout: 60_000 }, async () => {
  const req = request("viewports");
  const desktop = await service.screenshot(req, { kind: "web", url: `${base}/`, viewport: { width: 1280, height: 800 } }, "signup-desktop");
  const mobile = await service.screenshot(req, { kind: "web", url: `${base}/`, viewport: { width: 390, height: 844 } }, "signup-mobile");
  assert.deepEqual([desktop.width, desktop.height], [1280, 800]);
  assert.deepEqual([mobile.width, mobile.height], [390, 844]);
  assert.equal(desktop.path, join(req.evidenceDir, "signup-desktop.png"));
  for (const shot of [desktop, mobile]) {
    assert.equal(shot.held, false);
    assert.equal(shot.mime, "image/png");
    assert.equal((await service.checkImage(shot.path)).verdict, "pass");
  }
  const phone = await service.screenshot(req, { kind: "web", url: `${base}/`, device: "iPhone 13" });
  assert.equal(phone.width, 390 * 3, "device emulation renders at the phone's pixel ratio");
  const blank = await service.screenshot(req, { kind: "web", url: `${base}/blank` });
  const check = await service.checkImage(blank.path, { id: "screen-not-blank" });
  assert.equal(check.verdict, "fail");
  assert.equal(check.id, "screen-not-blank");
  assert.match(check.detail ?? "", /blank/);
  assert.equal(broker.status().tabs, 0, "capture's own tabs are closed afterwards");
});

test("a 1-second CSS animation recorded frame by frame at 30 fps: 30 frames, exact times, the box where the timing puts it", { skip, timeout: 120_000 }, async (t) => {
  if (!choice) return t.skip("no video encoder on this computer");
  const req = request("frames");
  const video = await service.video(req, { target: { kind: "web", url: `${base}/anim`, viewport: { width: 400, height: 120 } }, durationSec: 1, mode: "frames", fps: 30, name: "slide" });
  assert.equal(video.kind, "video");
  assert.equal(video.fps, 30);
  assert.equal(video.frames, 30);
  const probe = await probeVideo(video.path);
  assert.equal(probe.frames, 30);
  // WebM stores milliseconds; MP4 stores ticks of its own time scale.
  probe.timestampsMs.forEach((time, index) => assert.ok(Math.abs(time - (index * 1000) / 30) <= 0.5, `frame ${index} at ${time} ms`));
  assert.ok(Math.abs(probe.durationMs - 1000) <= 1, `duration ${probe.durationMs}`);
  const frames = decodeFrames(video.path, join(req.evidenceDir, "decoded"));
  assert.equal(frames.length, 30);
  for (const index of [0, 7, 15, 22, 29]) {
    const image = await decodePng(readFileSync(frames[index]!));
    const expected = (300 * index) / 30;
    const edge = redLeftEdge(image, 65);
    assert.ok(Math.abs(edge - expected) <= 2, `frame ${index}: box at ${edge}, timing says ${expected}`);
  }
  assert.ok(video.poster && existsSync(video.poster.path), "a poster frame");
  assert.equal(imageInfo(readFileSync(video.poster.path))?.width, 400);
  if (video.preview) assert.ok(video.preview.width <= 320);
});

test("frame-stepped time is frozen between frames and moves exactly one frame at a time", { skip, timeout: 60_000 }, async () => {
  const op = "job-stepped-clock";
  broker.operation(op);
  try {
    const opened = await broker.open(op, `${base}/clock`, { private: true, clock: true });
    const page = broker.pageFor(op, opened.tab);
    const times: Array<{ perf: number; date: number }> = [];
    // An encoder stand-in that reads the page's clock when each frame is written.
    const encoder = {
      full: false,
      write: async () => {
        times.push(await page.evaluate(() => ({ perf: performance.now(), date: Date.now() })));
        return true;
      },
    };
    const result = await recordStepped({ page, encoder, fps: 10, durationMs: 500 });
    assert.deepEqual(result, { frames: 5, truncated: false });
    for (let index = 1; index < times.length; index += 1) {
      assert.equal(Math.round(times[index]!.perf - times[index - 1]!.perf), 100, "performance.now() advances one frame");
      assert.equal(times[index]!.date - times[index - 1]!.date, 100, "Date.now() advances one frame");
    }
    const before = await page.evaluate(() => Date.now());
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok((await page.evaluate(() => Date.now())) - before >= 250, "time runs again afterwards");
  } finally {
    await broker.release(op);
  }
});

test("the media pipeline: MP4 with H.264 where the system ffmpeg has it, else WebM, within the length limit", { skip, timeout: 120_000 }, async (t) => {
  if (!choice) return t.skip("no video encoder on this computer");
  const req = request("pipeline", { maxVideoMs: 1_000 });
  const video = await service.video(req, { target: { kind: "web", url: `${base}/anim`, viewport: { width: 320, height: 200 } }, durationSec: 3, mode: "frames", fps: 20 });
  assert.equal(video.frames, 20, "stopped at the one-second limit");
  assert.equal(video.truncated, true);
  const probe = await probeVideo(video.path);
  if (choice.codec === "h264") {
    assert.equal(video.mime, "video/mp4");
    assert.equal(probe.container, "mp4");
    assert.equal(probe.codec, "avc1");
  } else {
    assert.equal(video.mime, "video/webm");
    assert.equal(probe.container, "webm");
    assert.equal(probe.codec, choice.codec === "vp9" ? "V_VP9" : "V_VP8");
    t.diagnostic("no system ffmpeg with an H.264 encoder on this computer: checked the WebM path only");
  }
  const realtime = await service.video(request("realtime"), { target: { kind: "web", url: `${base}/anim`, viewport: { width: 320, height: 200 } }, durationSec: 1.2, mode: "realtime", fps: 10 });
  const live = await probeVideo(realtime.path);
  assert.ok(live.frames >= 10 && live.frames <= 15, `about 12 frames, got ${live.frames}`);
  assert.equal(realtime.width, 320);
  assert.ok(realtime.poster && existsSync(realtime.poster.path));
});

test("H.264 MP4 output", { skip, timeout: 60_000 }, async (t) => {
  if (choice?.codec !== "h264") return t.skip("no system ffmpeg with an H.264 encoder on this computer");
  const video = await service.video(request("h264"), { target: { kind: "web", url: `${base}/anim`, viewport: { width: 320, height: 200 } }, durationSec: 0.5, mode: "frames", fps: 30 });
  const probe = await probeVideo(video.path);
  assert.equal(probe.codec, "avc1");
  assert.equal(probe.frames, 15);
});

test("a page showing a saved secret is held, never sent in clear; a never-captured site is refused", { skip, timeout: 90_000 }, async () => {
  const shot = await service.screenshot(request("secret"), { kind: "web", url: `${base}/secret` });
  assert.equal(shot.held, true);
  assert.match(shot.reason ?? "", /saved secret/);
  if (choice) {
    const stepped = await service.video(request("secret-frames"), { target: { kind: "web", url: `${base}/secret`, viewport: { width: 320, height: 200 } }, durationSec: 0.2, mode: "frames", fps: 10 });
    assert.equal(stepped.held, true);
    const realtime = await service.video(request("secret-live"), { target: { kind: "web", url: `${base}/secret`, viewport: { width: 320, height: 200 } }, durationSec: 0.5 });
    assert.equal(realtime.held, true);
  }
  rules.neverCapture = ["127.0.0.1"];
  try {
    await assert.rejects(service.screenshot(request("never"), { kind: "web", url: `${base}/` }), (error: unknown) => error instanceof CaptureError && error.code === "refused");
  } finally {
    rules.neverCapture = [];
  }
});

test("a terminal transcript becomes HTML or an image, with secrets hidden", { skip, timeout: 60_000 }, async () => {
  const transcript = `\u001b[32m✓\u001b[0m 12 tests passed\nexport API_TOKEN=${SECRET}\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123\n\u001b[31mFAIL\u001b[0m one\n`;
  const html = await runCaptureTool(service, "capture_screenshot", { target: "terminal", transcript, title: "npm test", format: "html" }, request("terminal"));
  assert.ok(html.ok);
  const page = readFileSync((html.result as { path: string }).path, "utf8");
  assert.ok(!page.includes(SECRET) && !page.includes("ghp_abcdef"));
  assert.match(page, /color:#0dbc79/);
  assert.match(page, /Content-Security-Policy/);
  const png = await service.screenshot(request("terminal-png"), { kind: "terminal", transcript, title: "npm test" });
  assert.equal(png.mime, "image/png");
  assert.equal(png.held, false);
  assert.ok(png.height! < 400, "the image is as tall as the transcript");
});

test("checks before sending: the page's text, the image, and unsupported targets say why", { skip, timeout: 60_000 }, async () => {
  const req = request("checks");
  const pass = await service.checkText(req, { url: `${base}/` }, ["Create your account", "sign up"], { id: "signup-form" });
  assert.equal(pass.verdict, "pass");
  assert.equal(pass.id, "signup-form");
  const fail = await service.checkText(req, { url: `${base}/` }, ["Create your account", "Forgot password"]);
  assert.equal(fail.verdict, "fail");
  assert.match(fail.detail ?? "", /Forgot password/);
  const desktop = await runCaptureTool(service, "capture_screenshot", { target: "desktop" }, req);
  assert.equal(desktop.ok, false);
  assert.equal(!desktop.ok && desktop.error.code, "not_supported");
  const status = await runCaptureTool(service, "capture_status", {}, req);
  assert.ok(status.ok);
  assert.equal((status.result as { targets: { web: { screenshot: boolean } } }).targets.web.screenshot, true);
});

test("without Xvfb, desktop apps are refused with the reason and the fix", { timeout: 30_000, skip: process.platform !== "linux" && "Linux only" }, async () => {
  const bare = new CaptureService({ broker, dataHome: join(root, "data-bare"), displayTools: () => ({ xvfb: null, windowManager: null, xdotool: null, xwininfo: null, xprop: null, wmctrl: null }) });
  const result = await runCaptureTool(bare, "capture_app_start", { kind: "gui", command: "true", cwd: root }, request("bare", { unsandboxedApps: true }));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, "unavailable");
  assert.match(!result.ok ? result.error.message : "", /Xvfb.*ensemble capture setup/);
});

test("apps run in the OS sandbox: without a sandbox wrapper, starting one is refused unless the owner allowed it", { timeout: 30_000 }, async () => {
  const fakeXvfb = { xvfb: "/nonexistent/Xvfb", windowManager: null, xdotool: null, xwininfo: null, xprop: null, wmctrl: null };
  const strict = new CaptureService({ broker, dataHome: join(root, "data-strict"), displayTools: () => fakeXvfb, platform: "linux" });
  for (const input of [{ kind: "gui", command: "xeyes", cwd: root }, { kind: "electron", cwd: root }]) {
    const result = await runCaptureTool(strict, "capture_app_start", input, request("strict"));
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, "refused");
    assert.match(!result.ok ? result.error.message : "", /OS sandbox/);
  }
  assert.deepEqual(strict.leases.list(), [], "nothing was started");
});

const xvfb = findDisplayTools().xvfb;
const xprogram = ["xmessage", "xeyes", "xclock", "xlogo"].map((name) => findOnPath(name)).find(Boolean);
const guiSkip = process.platform !== "linux" ? "Linux only" : !xvfb ? "no Xvfb on this computer (sudo apt install xvfb)" : !xprogram ? "no small X program (xmessage, xeyes, xclock, xlogo) to start" : false;

test("a desktop app on a private virtual display: started, found, captured, checked and stopped", { skip: guiSkip, timeout: 120_000 }, async (t) => {
  const req = request("gui", { unsandboxedApps: true });
  const app = await service.appStart(req, { kind: "gui", command: xprogram!.endsWith("xmessage") ? `${xprogram} -center "Hello from the display"` : xprogram!, cwd: root });
  assert.match(app.display ?? "", /^:\d+$/);
  assert.notEqual(app.display, process.env.DISPLAY, "never the owner's display");
  const checks = await service.checkApp(req, app.app, { aliveMs: 1_000 });
  assert.equal(checks[0]!.verdict, "pass");
  const grabber = (await findFfmpegs()).find((info) => info.x11grab);
  if (grabber) {
    const shot = await service.screenshot(req, { kind: "gui", app: app.app });
    assert.equal(shot.held, true, "a desktop app's window is previewed by the owner first");
    assert.ok((shot.width ?? 0) > 0);
  } else t.diagnostic("no ffmpeg with x11grab: screenshot skipped");
  const stopped = await service.appStop(req, app.app);
  assert.equal(stopped.stopped, true);
  assert.deepEqual(service.leases.list(req.operation), [], "the display and the app are gone");
});
