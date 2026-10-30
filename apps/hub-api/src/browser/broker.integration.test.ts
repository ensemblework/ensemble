/**
 * The browser broker against a real headless Chromium and a local HTTP server: reading and driving
 * pages, masked screenshots, console and network errors, uploads and downloads in the evidence
 * folder, recordings, tab ownership, the janitor, sensitive mode and the live view. Skipped when
 * this computer has no Chromium (`ensemble capture setup` installs one).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserBroker, BrowserError, checkUrl, type LiveFrame } from "./broker.js";
import { findChromium } from "./chromium.js";
import type { PrivacyRules } from "./privacy.js";
import { decodePng, isJpeg, probeVideo } from "../capture/probe.js";
import { chooseVideoEncoder, findFfmpegs } from "../capture/ffmpeg.js";

const chromium = findChromium({ headless: true });
const skip = chromium ? false : "no Chromium on this computer (run `ensemble capture setup`)";
const SECRET = "correct-horse-battery-staple";
const QUOTED_SECRET = 'S3cr"et\\w0rd!';

const PAGES: Record<string, string> = {
  "/": `<!doctype html><title>Home</title>
    <h1 id="greeting">Hello</h1>
    <label>Name <input id="name"></label>
    <label>Password <input id="pw" type="password" value="hunter2-hunter2" style="width:200px;height:30px"></label>
    <label>Code <input id="otp" autocomplete="one-time-code" value="424242"></label>
    <button onclick="document.getElementById('greeting').textContent = 'Hi ' + document.getElementById('name').value; console.error('clicked the button'); setTimeout(() => { throw new Error('late failure'); });">Greet</button>
    <a href="/download">Get the report</a>
    <label>Attachment <input id="file" type="file" onchange="document.title = this.files[0].name + ':' + this.files[0].size"></label>
    <script>fetch('/missing').catch(() => {}); console.warn('starting up');</script>`,
  "/secret": `<!doctype html><title>Settings</title><p>Your key: ${SECRET}</p>`,
  "/plain": `<!doctype html><title>Plain</title><p style="font-size:40px">Nothing secret here</p>`,
  "/moving": `<!doctype html><title>Moving</title><style>#b{width:80px;height:80px;background:#06c;animation:m 1s linear infinite alternate}@keyframes m{to{transform:translateX(400px)}}</style><div id="b"></div>`,
  "/next": `<!doctype html><title>Next</title><p>Signed in</p>`,
  "/fields": `<!doctype html><title>Fields</title>
    <label>Password <input id="hint" type="password" placeholder="Enter your password" value="pl4ceholder-pass"></label>
    <label>Code <input autocomplete="one-time-code" placeholder="6 digits" value="913377"></label>
    <p>Shown: ${QUOTED_SECRET.replace(/</g, "&lt;")}</p>
    <iframe srcdoc="<input autocomplete='cc-number' value='4242 4242 4242 4242' style='width:300px;height:40px;font-size:24px'>" style="position:absolute;left:0;top:200px;width:400px;height:100px;border:0"></iframe>`,
  "/opener": `<!doctype html><title>Opener</title><button onclick="window.open('/next')">Sign in with a popup</button>`,
};

let server: Server;
let base = "";
let root = "";
const rules: PrivacyRules = { secretValues: [SECRET, QUOTED_SECRET] };

test.before(async () => {
  root = mkdtempSync(join(tmpdir(), "ensemble-broker-"));
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    if (path === "/download") {
      response.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="report.txt"' });
      response.end("quarterly numbers\n");
      return;
    }
    const page = PAGES[path];
    if (!page) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.after(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  if (root) rmSync(root, { recursive: true, force: true });
});

function newBroker(over: ConstructorParameters<typeof BrowserBroker>[0] = {}): BrowserBroker {
  return new BrowserBroker({ dataHome: join(root, `data-${Math.random().toString(36).slice(2)}`), privacy: () => rules, ...over });
}

function evidence(name: string): string {
  const dir = join(root, "evidence", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const refOf = (snapshot: string, pattern: RegExp) => {
  const match = pattern.exec(snapshot);
  assert.ok(match, `no ${pattern} in:\n${snapshot}`);
  return match[1]!;
};

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof BrowserError && error.code === code);
}

test("only web pages open: file, javascript and other schemes are refused", () => {
  assert.throws(() => checkUrl("file:///etc/passwd"), (error: unknown) => error instanceof BrowserError && error.code === "refused");
  assert.throws(() => checkUrl("javascript:alert(1)"), (error: unknown) => error instanceof BrowserError && error.code === "refused");
  assert.throws(() => checkUrl("chrome://settings"), (error: unknown) => error instanceof BrowserError && error.code === "refused");
  assert.throws(() => checkUrl("not a url"), (error: unknown) => error instanceof BrowserError && error.code === "bad_input");
  assert.equal(checkUrl("http://localhost:3000/a"), "http://localhost:3000/a");
});

test("opens, reads, types and clicks; snapshots hide password and code values; errors are collected", { skip, timeout: 90_000 }, async () => {
  const broker = newBroker();
  try {
    const op = broker.operation("job-read", { evidenceDir: evidence("read") });
    const opened = await op.open(`${base}/`);
    assert.equal(opened.status, 200);
    assert.equal(opened.title, "Home");
    assert.equal(opened.profile, "default");
    const snap = await op.snapshot(opened.tab);
    assert.match(snap.snapshot, /heading "Hello"/);
    assert.ok(!snap.snapshot.includes("hunter2-hunter2"), "the password value is not in the snapshot");
    assert.ok(!snap.snapshot.includes("424242"), "the one-time code is not in the snapshot");
    assert.match(snap.snapshot, /textbox "Password" \[ref=\w+\]: \[hidden\]/);
    await op.type(opened.tab, refOf(snap.snapshot, /textbox "Name" \[ref=(\w+)\]/), "Ada");
    await op.click(opened.tab, refOf(snap.snapshot, /button "Greet" \[ref=(\w+)\]/));
    await op.wait(opened.tab, { text: "Hi Ada", timeoutMs: 5_000 });
    const after = await op.snapshot(opened.tab);
    assert.match(after.snapshot, /heading "Hi Ada"/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const errors = await op.console(opened.tab, { level: "error" });
    assert.ok(errors.messages.some((entry) => entry.text.includes("clicked the button")));
    assert.ok(errors.messages.some((entry) => entry.type === "pageerror" && entry.text.includes("late failure")));
    assert.ok(!errors.messages.some((entry) => entry.text.includes("starting up")), "warnings are not errors");
    const all = await op.console(opened.tab);
    assert.ok(all.messages.some((entry) => entry.type === "warning" && entry.text.includes("starting up")));
    const network = op.networkErrors(opened.tab);
    assert.ok(network.errors.some((entry) => entry.url.endsWith("/missing") && entry.status === 404));
    await rejects(op.type(opened.tab, refOf(after.snapshot, /textbox "Name" \[ref=(\w+)\]/), `my ${SECRET}`), "refused");
    await rejects(op.click(opened.tab, "e1 >> css=body"), "bad_input");
    const tabs = await op.tabs();
    assert.deepEqual(tabs.map((tab) => tab.tab), [opened.tab]);
  } finally {
    await broker.shutdown();
  }
});

test("a screenshot masks password and code fields and is held when the page shows a saved secret", { skip, timeout: 90_000 }, async () => {
  const broker = newBroker();
  try {
    const dir = evidence("shots");
    const op = broker.operation("job-shots", { evidenceDir: dir });
    const opened = await op.open(`${base}/`);
    const shot = await op.screenshot(opened.tab, { name: "home" });
    assert.equal(shot.path, join(dir, "home.png"));
    assert.equal(shot.held, false);
    assert.ok((shot.masked ?? 0) >= 2);
    const image = await decodePng(readFileSync(shot.path));
    const box = await broker.pageFor("job-shots", opened.tab).locator("#pw").boundingBox();
    assert.ok(box);
    const at = (Math.round(box.y + box.height / 2) * image.width + Math.round(box.x + box.width / 2)) * 4;
    assert.deepEqual([...image.data.subarray(at, at + 3)], [255, 0, 255], "the password field is covered by the mask colour");
    const small = await op.screenshot(opened.tab, { viewport: { width: 400, height: 300 }, name: "small" });
    assert.equal(small.width, 400);
    assert.equal(small.height, 300);
    assert.deepEqual(broker.pageFor("job-shots", opened.tab).viewportSize(), { width: 1280, height: 800 }, "the viewport is restored");
    await op.open(`${base}/secret`, { tab: opened.tab });
    const secret = await op.screenshot(opened.tab, { name: "secret" });
    assert.equal(secret.held, true);
    assert.match(secret.reason ?? "", /saved secret/);
    const snap = await op.snapshot(opened.tab);
    assert.ok(!snap.snapshot.includes(SECRET));
    assert.match(snap.snapshot, /\[hidden\]/);
    const withToken = await op.open(`${base}/plain?access_token=abc123secret&page=2`, { tab: opened.tab });
    assert.equal(withToken.url, `${base}/plain?access_token=[redacted]&page=2`, "secret query values never reach the agent");
  } finally {
    await broker.shutdown();
  }
});

test("values split by a placeholder, secrets with quotes, and code fields inside frames stay hidden", { skip, timeout: 60_000 }, async () => {
  const broker = newBroker();
  try {
    const op = broker.operation("job-fields", { evidenceDir: evidence("fields") });
    const opened = await op.open(`${base}/fields`);
    const snap = await op.snapshot(opened.tab);
    for (const value of ["pl4ceholder-pass", "913377", 'S3cr\\"et', "w0rd!"]) assert.ok(!snap.snapshot.includes(value), `${value} is not in:\n${snap.snapshot}`);
    assert.match(snap.snapshot, /placeholder: Enter your password/, "the placeholder stays");
    const shot = await op.screenshot(opened.tab, { name: "fields" });
    assert.ok((shot.masked ?? 0) >= 3, "fields in frames are counted");
    const image = await decodePng(readFileSync(shot.path));
    const at = (220 * image.width + 150) * 4;
    assert.deepEqual([...image.data.subarray(at, at + 3)], [255, 0, 255], "the card field inside the frame is masked");
    assert.equal(shot.held, true, "the quoted secret on the page holds the screenshot");
  } finally {
    await broker.shutdown();
  }
});

test("a trace covers its whole context: it is refused next to a sensitive page and dropped when a popup signs in", { skip, timeout: 60_000 }, async () => {
  const broker = newBroker();
  try {
    const op = broker.operation("job-trace", { evidenceDir: evidence("trace") });
    const opener = await op.open(`${base}/opener`, { private: true });
    await op.record(opener.tab, { kind: "trace", action: "start" });
    const snap = await op.snapshot(opener.tab);
    await op.click(opener.tab, refOf(snap.snapshot, /button "Sign in with a popup" \[ref=(\w+)\]/));
    await waitFor(() => broker.status().tabs === 2, 5_000);
    const popup = (await op.tabs()).find((tab) => tab.tab !== opener.tab)!;
    await broker.markSensitive(popup.tab, true);
    await rejects(op.record(opener.tab, { kind: "trace", action: "stop" }), "not_found");
    await rejects(op.record(opener.tab, { kind: "trace", action: "start" }), "busy");
    await broker.markSensitive(popup.tab, false);
    await op.record(opener.tab, { kind: "trace", action: "start" });
    const stopped = await op.record(opener.tab, { kind: "trace", action: "stop" });
    assert.ok(stopped.file && existsSync(stopped.file.path));
  } finally {
    await broker.shutdown();
  }
});

test("sites the owner marked are never captured, or held for a preview", { skip, timeout: 60_000 }, async () => {
  const marked: PrivacyRules = { neverCapture: [] };
  const broker = newBroker({ privacy: () => marked });
  try {
    const op = broker.operation("job-sites", { evidenceDir: evidence("sites") });
    const opened = await op.open(`${base}/plain`);
    marked.previewFirst = ["127.0.0.1"];
    const held = await op.screenshot(opened.tab);
    assert.equal(held.held, true);
    assert.match(held.reason ?? "", /see captures of this site/);
    marked.neverCapture = [base];
    await rejects(op.screenshot(opened.tab), "refused");
    await rejects(op.snapshot(opened.tab), "refused");
    await rejects(op.record(opened.tab, { kind: "video", action: "start" }), "refused");
  } finally {
    await broker.shutdown();
  }
});

test("uploads only regular files from the evidence folder; downloads land in it", { skip, timeout: 90_000 }, async () => {
  const broker = newBroker();
  try {
    const dir = evidence("files");
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "not for upload");
    writeFileSync(join(dir, "photo.txt"), "twelve bytes");
    writeFileSync(join(dir, ".env"), "TOKEN=1");
    symlinkSync(outside, join(dir, "link.txt"));
    const op = broker.operation("job-files", { evidenceDir: dir });
    const opened = await op.open(`${base}/`);
    const snap = await op.snapshot(opened.tab);
    const fileRef = refOf(snap.snapshot, /button "Attachment" \[ref=(\w+)\]/);
    const sent = await op.upload(opened.tab, fileRef, join(dir, "photo.txt"));
    assert.equal(sent.size, 12);
    await op.wait(opened.tab, { url: "**/", timeoutMs: 1_000 });
    assert.equal(await broker.pageFor("job-files", opened.tab).title(), "photo.txt:12");
    await rejects(op.upload(opened.tab, fileRef, outside), "refused");
    await rejects(op.upload(opened.tab, fileRef, join(dir, "link.txt")), "refused");
    await rejects(op.upload(opened.tab, fileRef, join(dir, ".env")), "refused");
    const saved = await op.download(opened.tab, { ref: refOf(snap.snapshot, /link "Get the report" \[ref=(\w+)\]/) });
    assert.equal(saved.name, "report.txt");
    assert.equal(saved.path, join(dir, "report.txt"));
    assert.equal(readFileSync(saved.path, "utf8"), "quarterly numbers\n");
  } finally {
    await broker.shutdown();
  }
});

test("a tab belongs to one operation: others can neither see nor drive it", { skip, timeout: 60_000 }, async () => {
  const broker = newBroker();
  try {
    const mine = broker.operation("job-a", { evidenceDir: evidence("a") });
    const theirs = broker.operation("job-b", { evidenceDir: evidence("b") });
    const opened = await mine.open(`${base}/plain`);
    assert.deepEqual(await theirs.tabs(), []);
    await rejects(theirs.snapshot(opened.tab), "not_yours");
    await rejects(theirs.click(opened.tab, "e1"), "not_yours");
    await rejects(theirs.screenshot(opened.tab), "not_yours");
    await rejects(theirs.close(opened.tab), "not_yours");
    await rejects(theirs.open(`${base}/next`, { tab: opened.tab }), "not_yours");
    const second = await theirs.open(`${base}/next`);
    assert.notEqual(second.tab, opened.tab);
    assert.equal((await mine.tabs()).length, 1);
    await theirs.release();
    assert.equal((await mine.tabs()).length, 1, "releasing one operation leaves the other's tabs");
  } finally {
    await broker.shutdown();
  }
});

test("the janitor closes tabs whose lease ran out, then the idle browser", { skip, timeout: 60_000 }, async () => {
  let clock = Date.now();
  const broker = newBroker({ now: () => clock, leaseMs: 60_000, idleBrowserMs: 120_000 });
  try {
    const op = broker.operation("job-lease");
    const first = await op.open(`${base}/plain`);
    clock += 50_000;
    await op.snapshot(first.tab);
    clock += 50_000;
    assert.deepEqual((await broker.sweep()).closedTabs, [], "using a tab renews its lease");
    clock += 61_000;
    const swept = await broker.sweep();
    assert.deepEqual(swept.closedTabs, [first.tab]);
    assert.deepEqual(await op.tabs(), []);
    await rejects(op.snapshot(first.tab), "not_found");
    assert.equal(broker.status().contexts.length, 1, "the browser stays for a while after its last tab");
    clock += 121_000;
    assert.deepEqual((await broker.sweep()).closedContexts, ["profile:default"]);
    assert.equal(broker.status().contexts.length, 0);
    const again = await broker.operation("job-lease").open(`${base}/plain`);
    assert.equal(again.title, "Plain", "a new browser starts on the next open");
  } finally {
    await broker.shutdown();
  }
});

test("a sensitive tab refuses capture and actions, pauses the live view, and comes back", { skip, timeout: 90_000 }, async () => {
  const frames: LiveFrame[] = [];
  const broker = newBroker({ liveViewMs: 250 });
  try {
    const op = broker.operation("job-live", { evidenceDir: evidence("live"), onLiveFrame: (frame) => frames.push(frame) });
    const opened = await op.open(`${base}/moving`);
    await waitFor(() => frames.filter((frame) => frame.jpeg).length >= 2, 5_000);
    const live = frames.filter((frame) => frame.jpeg);
    for (const frame of live) {
      assert.ok(isJpeg(frame.jpeg!), "frames are JPEG");
      assert.ok(frame.jpeg!.length < 150_000, "frames are small");
      assert.equal(frame.tab, opened.tab);
    }
    await broker.markSensitive(opened.tab, true);
    await waitFor(() => frames.some((frame) => frame.paused === "sensitive"), 5_000);
    const pausedAt = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.ok(frames.slice(pausedAt).every((frame) => !frame.jpeg), "no picture while sensitive");
    await rejects(op.snapshot(opened.tab), "sensitive");
    await rejects(op.screenshot(opened.tab), "sensitive");
    await rejects(op.record(opened.tab, { kind: "video", action: "start" }), "sensitive");
    await rejects(op.click(opened.tab, "e1"), "sensitive");
    await rejects(op.console(opened.tab), "sensitive");
    assert.equal((await op.tabs())[0]!.sensitive, true);
    await op.wait(opened.tab, { url: "**/moving", timeoutMs: 2_000 });
    // Taken over from the web, its live view says so instead of "signing in".
    broker.markControlled(opened.tab, true);
    await waitFor(() => frames.some((frame) => frame.paused === "controlled"), 5_000);
    broker.markControlled(opened.tab, false);
    await broker.markSensitive(opened.tab, false);
    const resumedAt = frames.length;
    await waitFor(() => frames.slice(resumedAt).some((frame) => frame.jpeg), 5_000);
    assert.equal((await op.snapshot(opened.tab)).tab, opened.tab, "it can be read again");
    await op.close(opened.tab);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const closedAt = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(frames.length, closedAt, "the live view stops with the last tab");
  } finally {
    await broker.shutdown();
  }
});

test("Ensemble's own sign-in code reads a sensitive tab, keeps it open, shows it only on a screen, and keeps it through a browser restart", { skip, timeout: 90_000 }, async () => {
  // No display here, whatever this machine has: the tab cannot be shown in a window.
  const broker = newBroker({ env: { PATH: process.env.PATH } });
  try {
    const op = broker.operation("job-signin");
    const opened = await op.open(`${base}/next`);
    await broker.markSensitive(opened.tab, true);
    const owner = broker.ownerTab(opened.tab);
    assert.deepEqual([owner.operation, owner.profile, owner.sensitive], ["job-signin", "default", true]);
    assert.equal(await owner.page.title(), "Next", "the broker's own code reads the page no agent can");
    await rejects(op.snapshot(opened.tab), "sensitive");
    const before = Date.parse((await op.tabs())[0]!.expiresAt);
    broker.keepTab(opened.tab, 3_600_000);
    assert.ok(Date.parse((await op.tabs())[0]!.expiresAt) > before + 60_000, "a waiting sign-in keeps its tab");
    assert.equal(broker.hasWindow(), false);
    const shown = await broker.showTab(opened.tab);
    assert.equal(shown.shown, false);
    assert.equal(!shown.shown && shown.reason, "no_display");
    const restarted = await broker.restartProfile("default", { headless: true });
    assert.equal(restarted.tabs, 1);
    const again = broker.ownerTab(opened.tab);
    assert.notEqual(again.page, owner.page, "a new page under the same tab id");
    assert.equal(again.sensitive, true, "still sensitive");
    assert.match(again.page.url(), /\/next$/, "at the address it showed");
    assert.equal((await op.tabs()).length, 1, "the old page closing did not close the tab");
    await broker.markSensitive(opened.tab, false);
    assert.match((await op.snapshot(opened.tab)).snapshot, /Signed in/);
  } finally {
    await broker.shutdown();
  }
});

test("records a tab's video and a private tab's trace into the evidence folder", { skip, timeout: 120_000 }, async (t) => {
  const broker = newBroker();
  try {
    const dir = evidence("record");
    const op = broker.operation("job-record", { evidenceDir: dir });
    const priv = await op.open(`${base}/moving`, { private: true });
    assert.equal(priv.profile, null);
    await op.record(priv.tab, { kind: "trace", action: "start" });
    await op.open(`${base}/next`, { tab: priv.tab });
    const trace = await op.record(priv.tab, { kind: "trace", action: "stop", name: "flow" });
    assert.equal(trace.file?.path, join(dir, "flow.zip"));
    assert.equal(readFileSync(trace.file!.path).subarray(0, 2).toString("latin1"), "PK");
    if (!chooseVideoEncoder(await findFfmpegs())) return t.skip("no video encoder on this computer");
    const tab = await op.open(`${base}/moving`);
    await op.record(tab.tab, { kind: "video", action: "start", fps: 10 });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const video = await op.record(tab.tab, { kind: "video", action: "stop" });
    const file = video.file!;
    assert.ok(existsSync(file.path));
    const probe = await probeVideo(file.path);
    assert.ok(probe.frames >= 12 && probe.frames <= 20, `about 15 frames at 10 fps, got ${probe.frames}`);
    assert.equal(probe.width, 1280);
    assert.ok(file.poster && existsSync(file.poster.path));
  } finally {
    await broker.shutdown();
  }
});

async function waitFor(condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
