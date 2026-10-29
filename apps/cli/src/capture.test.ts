import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureScriptArgs, captureScriptEnv, changeSites, formatCapture, formatSites, parseSitesArgs, runCaptureScript, type CaptureReport } from "./capture.js";
import { resolveCliPaths } from "./paths.js";

const linux: CaptureReport = {
  platform: "linux",
  browser: { available: true, kind: "headless-shell", revision: 1248, wanted: 1243, matches: false, source: "playwright", installDir: "/home/mira/.local/share/com.ensemblework.desktop/playwright" },
  video: { container: "webm", codec: "vp9", ffmpeg: "/home/mira/.cache/ms-playwright/ffmpeg-1013/ffmpeg-linux" },
  virtualDisplay: { xvfb: null, windowManager: null, windowLookup: ["xwininfo", "xprop"] },
  targets: {
    web: { screenshot: true, video: true },
    electron: { screenshot: false, video: false, reason: "Needs Xvfb for a private virtual display." },
    desktop: { screenshot: false, video: false, reason: "Capturing your real screen is not supported yet." },
  },
  setup: { ensembleInstalls: ["Playwright's Chromium 153.0.8010.12"], systemCommand: "sudo apt install xvfb ffmpeg openbox xdotool", notes: ["Videos are WebM (VP9 or VP8) until a system ffmpeg with an H.264 encoder is installed; then they are MP4."] },
};

test("capture status lists each target, what setup installs, and the one system command", () => {
  const lines = formatCapture(linux);
  assert.equal(lines[0], "browser: Chromium (headless shell) r1248, Ensemble expects r1243");
  assert.equal(lines[1], "video: WEBM (vp9)");
  assert.equal(lines[2], "virtual display: none");
  assert.ok(lines.includes("  web       yes          yes"));
  assert.ok(lines.some((line) => line.startsWith("  electron  no           no   Needs Xvfb")));
  assert.ok(lines.includes("`ensemble capture setup` installs Playwright's Chromium 153.0.8010.12 into /home/mira/.local/share/com.ensemblework.desktop/playwright."));
  assert.deepEqual(lines.slice(-2), ["For desktop apps and MP4 video, run this once:", "  sudo apt install xvfb ffmpeg openbox xdotool"]);
  const mac = formatCapture({ ...linux, platform: "macos", screenRecording: "denied", setup: { ensembleInstalls: [], systemCommand: "brew install ffmpeg", notes: [] } });
  assert.ok(mac.includes("screen recording permission: denied"));
  assert.ok(!mac.some((line) => line.startsWith("virtual display")));
  assert.deepEqual(mac.slice(-2), ["For MP4 video, run this once:", "  brew install ffmpeg"]);
});

test("the runtime's capture entry runs with the sidecar's Node against this channel's data folder", () => {
  assert.deepEqual(captureScriptArgs("status"), ["--import", "tsx", "src/capture/cli.ts", "status", "--json"]);
  assert.deepEqual(captureScriptArgs("setup", { dryRun: true }), ["--import", "tsx", "src/capture/cli.ts", "setup", "--json", "--dry-run"]);
  const paths = resolveCliPaths({ platform: "linux", home: "/home/mira", env: { ENSEMBLE_DATA_HOME: "/data/ens" } });
  const env = captureScriptEnv(paths, { PATH: "/usr/bin" });
  assert.equal(env.ENSEMBLE_REMOTE_STATE_DIR, "/data/ens");
  assert.equal(env.ENSEMBLE_DATA_DIR, join("/data/ens", "pglite"));
  assert.equal(env.PATH, "/usr/bin");
});

test("runCaptureScript reads the runtime's JSON report and passes its progress on", { skip: process.platform === "win32" && "uses a shell script as the sidecar's node" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-cli-capture-"));
  try {
    mkdirSync(join(dir, "app"));
    const node = join(dir, "node");
    writeFileSync(join(dir, "report.json"), JSON.stringify(linux));
    writeFileSync(node, `#!/bin/sh\necho "downloading Chromium" >&2\ncat "${join(dir, "report.json")}"\n`);
    chmodSync(node, 0o755);
    const progress: string[] = [];
    const report = await runCaptureScript({ sidecarDir: dir, paths: resolveCliPaths({ platform: "linux", home: dir, env: {} }), command: "status", onProgress: (line) => progress.push(line) });
    assert.deepEqual(report.targets.web, { screenshot: true, video: true });
    assert.deepEqual(progress, ["downloading Chromium"]);
    writeFileSync(node, "#!/bin/sh\necho 'Cannot find package tsx' >&2\nexit 1\n");
    await assert.rejects(runCaptureScript({ sidecarDir: dir, paths: resolveCliPaths({ platform: "linux", home: dir, env: {} }), command: "status" }), /could not report capture: Cannot find package tsx/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture sites: list, add and remove a never or preview site", () => {
  assert.deepEqual(parseSitesArgs([]), { change: null });
  assert.deepEqual(parseSitesArgs(["list"]), { change: null });
  assert.deepEqual(parseSitesArgs(["add", "never", "mail.example.com"]), { change: { action: "add", list: "never", site: "mail.example.com" } });
  assert.deepEqual(parseSitesArgs(["remove", "preview", "https://bank.example"]), { change: { action: "remove", list: "preview", site: "https://bank.example" } });
  for (const bad of [["add", "always", "x.com"], ["add", "never"], ["drop", "never", "x.com"], ["add", "never", "a.com", "b.com"]]) assert.ok("error" in parseSitesArgs(bad), bad.join(" "));
  const sites = { never: ["bank.example"], preview: [] };
  assert.deepEqual(changeSites(sites, { action: "add", list: "preview", site: "mail.example.com" }), { never: ["bank.example"], preview: ["mail.example.com"] });
  assert.deepEqual(changeSites(sites, { action: "add", list: "never", site: "Bank.Example" }), { never: ["Bank.Example"], preview: [] }, "the same site once");
  assert.deepEqual(changeSites(sites, { action: "remove", list: "never", site: "*.bank.example" }), { never: [], preview: [] });
  assert.deepEqual(formatSites({ never: ["bank.example"], preview: [] }), ["Never captured (no screenshot, video, page reading or live view):", "  bank.example", "Preview first (captures wait for you before they are sent anywhere):", "  (none)"]);
});
