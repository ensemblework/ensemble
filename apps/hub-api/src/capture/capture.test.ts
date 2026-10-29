/**
 * Capture's pieces without a browser or display: capability reports from fake probes, ffmpeg
 * listings and the exact command lines, the virtual display's arguments, cookie file and window
 * lookup, Electron detection, constant-rate resampling, file probing, checks and transcripts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { playwrightRevisions } from "../browser/chromium.js";
import { virtualDisplayEnv, findElectron, OutputTail } from "./apps.js";
import { computeCapabilities, systemInstallCommand, type CapabilityProbe } from "./capabilities.js";
import { blankVerdict, checkImage, checkTextIn, crashLine } from "./checks.js";
import { findWindow, parseWmctrl, parseXdotoolGeometry, parseXpropPid, parseXwininfoTree, processTree, xauthorityEntry, xvfbArgs, type DisplayTools } from "./display.js";
import { chooseVideoEncoder, encodeFramesArgs, even, parseFilters, parseListing, parseVersion, previewArgs, probeFfmpeg, x11RecordArgs, x11ScreenshotArgs, type FfmpegInfo } from "./ffmpeg.js";
import { ConstantRateFeeder, reserveFile, slugName } from "./media.js";
import { decodePng, imageInfo, pngStats, probeMp4, probeWebm } from "./probe.js";
import { findOnPath, linuxDistro } from "./system.js";
import { ansiToHtml, settleLines, stripAnsi, transcriptHtml, xtermColour } from "./terminal.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x += 1) Buffer.from(pixel(x, y)).copy(raw, y * (width * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const ffmpeg = (over: Partial<FfmpegInfo>): FfmpegInfo => ({
  path: "/usr/bin/ffmpeg",
  source: "system",
  version: "7.1",
  major: 7,
  h264: null,
  vp9: false,
  vp8: false,
  jpegFrames: true,
  png: true,
  jpeg: true,
  scale: true,
  x11grab: false,
  ...over,
});

const noTools: DisplayTools = { xvfb: null, windowManager: null, xdotool: null, xwininfo: null, xprop: null, wmctrl: null };
const wanted = playwrightRevisions();

function probe(over: Partial<CapabilityProbe>): CapabilityProbe {
  return {
    platform: "linux",
    env: {},
    dataHome: "/home/mira/.local/share/com.ensemblework.desktop",
    chromium: () => ({ executablePath: "/x/chrome-headless-shell", kind: "headless-shell", revision: 1248, matches: false, source: "playwright" }),
    ffmpegs: async () => [ffmpeg({ path: "/pw/ffmpeg-linux", source: "playwright", vp9: true, jpeg: false })],
    displayTools: () => noTools,
    distro: () => ({ id: "ubuntu", like: ["debian"] }),
    screenRecording: async () => "unknown",
    now: () => new Date("2026-10-30T10:00:00Z"),
    ...over,
  };
}

// ── capabilities ────────────────────────────────────────────────────────────

test("capabilities: an Ubuntu computer with only Playwright's downloads captures web pages and says what to install", async () => {
  const caps = await computeCapabilities(probe({ env: { WAYLAND_DISPLAY: "wayland-0" } }));
  assert.equal(caps.platform, "linux");
  assert.deepEqual(caps.session, { x11: null, wayland: "wayland-0" });
  assert.deepEqual(caps.targets.web, { screenshot: true, video: true });
  assert.equal(caps.targets.electron.screenshot, false);
  assert.match(caps.targets.electron.reason ?? "", /Xvfb/);
  assert.equal(caps.targets.gui.video, false);
  assert.equal(caps.targets.terminal.screenshot, true);
  assert.equal(caps.targets.desktop.screenshot, false);
  assert.deepEqual(caps.video, { container: "webm", codec: "vp9", ffmpeg: "/pw/ffmpeg-linux" });
  assert.equal(caps.browser.matches, false);
  assert.equal(caps.browser.wanted, wanted.chromium);
  assert.equal(caps.browser.installDir, "/home/mira/.local/share/com.ensemblework.desktop/playwright");
  assert.equal(caps.setup.systemCommand, "sudo apt install xvfb ffmpeg openbox xdotool");
  assert.equal(caps.setup.ensembleInstalls.length, 1);
  assert.match(caps.setup.ensembleInstalls[0]!, /Chromium/);
  assert.ok(caps.setup.notes.some((note) => /WebM/.test(note)));
  assert.equal(caps.checkedAt, "2026-10-30T10:00:00.000Z");
});

test("capabilities: a fully set up Linux computer captures everything but the real desktop, MP4 first", async () => {
  const caps = await computeCapabilities(
    probe({
      chromium: () => ({ executablePath: "/data/playwright/chromium_headless_shell/x", kind: "headless-shell", revision: wanted.headlessShell, matches: true, source: "ensemble" }),
      ffmpegs: async () => [ffmpeg({ h264: "libx264", vp9: true, vp8: true, x11grab: true }), ffmpeg({ path: "/pw/ffmpeg", source: "playwright", vp9: true })],
      displayTools: () => ({ xvfb: "/usr/bin/Xvfb", windowManager: { name: "openbox", path: "/usr/bin/openbox", args: [] }, xdotool: "/usr/bin/xdotool", xwininfo: "/usr/bin/xwininfo", xprop: "/usr/bin/xprop", wmctrl: null }),
    }),
  );
  for (const target of ["web", "electron", "gui"] as const) assert.deepEqual(caps.targets[target], { screenshot: true, video: true });
  assert.equal(caps.video?.container, "mp4");
  assert.equal(caps.virtualDisplay.windowManager, "openbox");
  assert.deepEqual(caps.virtualDisplay.windowLookup, ["xdotool", "xwininfo", "xprop"]);
  assert.equal(caps.setup.systemCommand, null);
  assert.deepEqual(caps.setup.ensembleInstalls, []);
});

test("capabilities: missing pieces name the right package for each distribution", async () => {
  assert.equal(systemInstallCommand(["xvfb"], { id: "fedora", like: [] }), "sudo dnf install xorg-x11-server-Xvfb");
  assert.equal(systemInstallCommand(["xvfb", "ffmpeg"], { id: "manjaro", like: ["arch"] }), "sudo pacman -S xorg-server-xvfb ffmpeg");
  assert.equal(systemInstallCommand(["xdotool"], { id: "pop", like: ["ubuntu", "debian"] }), "sudo apt install xdotool");
  assert.equal(systemInstallCommand(["wm"], { id: "opensuse-tumbleweed", like: ["opensuse", "suse"] }), "sudo zypper install openbox");
  assert.equal(systemInstallCommand(["xvfb"], { id: "gentoo", like: [] }), null);
  assert.equal(systemInstallCommand([], { id: "ubuntu", like: [] }), null);
  const unknown = await computeCapabilities(probe({ distro: () => ({ id: "gentoo", like: [] }) }));
  assert.equal(unknown.setup.systemCommand, null);
  assert.ok(unknown.setup.notes.some((note) => /package manager: Xvfb/.test(note)));
});

test("capabilities: macOS reports Screen Recording and brew; Windows says not yet; no browser or encoder says run setup", async () => {
  const mac = await computeCapabilities(probe({ platform: "darwin", ffmpegs: async () => [ffmpeg({ path: "/pw/ffmpeg-mac", source: "playwright", vp8: true })], screenRecording: async () => "denied" }));
  assert.equal(mac.platform, "macos");
  assert.equal(mac.screenRecording, "denied");
  assert.equal(mac.setup.systemCommand, "brew install ffmpeg");
  assert.deepEqual(mac.targets.electron, { screenshot: true, video: true });
  assert.equal(mac.targets.gui.screenshot, false);
  const windows = await computeCapabilities(probe({ platform: "win32" }));
  assert.equal(windows.platform, "windows");
  assert.match(windows.targets.electron.reason ?? "", /not supported/i);
  assert.equal(windows.setup.systemCommand, null);
  const bare = await computeCapabilities(probe({ chromium: () => null, ffmpegs: async () => [] }));
  assert.equal(bare.targets.web.screenshot, false);
  assert.match(bare.targets.web.reason ?? "", /ensemble capture setup/);
  assert.equal(bare.setup.ensembleInstalls.length, 2);
  assert.equal(bare.browser.available, false);
});

// ── ffmpeg ──────────────────────────────────────────────────────────────────

const ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 VF...D png                  PNG (Portable Network Graphics) image
 V....D libvpx-vp9           libvpx VP9 (codec vp9)
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
`;
const FILTERS = `Filters:
  T.. = Timeline support
  .S. = Slice threading
  A = Audio input/output
 ..C crop              V->V       Crop the input video.
 ..C scale             V->V       Scale the input video size and/or convert the image format.
 ... buffer            |->V       Buffer video frames.
`;
const FORMATS = `Formats:
 D.. = Demuxing supported
 ---
 D   image2pipe      piped image2 sequence
 D   matroska,webm   Matroska / WebM
 D  d x11grab        X11 screen capture, using XCB
`;

test("ffmpeg listings: encoders, formats and filters by name; the version and its major number", () => {
  assert.deepEqual([...parseListing(ENCODERS)], ["png", "libvpx-vp9", "libx264"]);
  assert.deepEqual([...parseListing(FORMATS)], ["image2pipe", "matroska", "webm", "x11grab"]);
  assert.deepEqual([...parseFilters(FILTERS)], ["crop", "scale", "buffer"]);
  assert.deepEqual(parseVersion("ffmpeg version n7.0.1-playwright-build-1013 Copyright"), { version: "n7.0.1-playwright-build-1013", major: 7 });
  assert.deepEqual(parseVersion("ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright"), { version: "4.4.2-0ubuntu0.22.04.1", major: 4 });
  assert.deepEqual(parseVersion("nothing"), { version: null, major: null });
});

test("ffmpeg probe: a build's abilities come from its own listings", async () => {
  const outputs: Record<string, string> = {
    "-version": "ffmpeg version 6.1.1-3ubuntu5 Copyright",
    "-encoders": ENCODERS + " V....D mjpeg  MJPEG\n",
    "-decoders": "Decoders:\n ------\n V....D mjpeg   Motion JPEG\n",
    "-demuxers": FORMATS,
    "-muxers": "Formats:\n ---\n  E image2   image2 sequence\n  E mp4      MP4\n",
    "-filters": FILTERS,
    "-devices": "Devices:\n ---\n D  x11grab   X11 screen capture\n",
  };
  const info = await probeFfmpeg("/usr/bin/ffmpeg", "system", async (_program, args) => ({ code: 0, signal: null, stdout: outputs[args[1]!] ?? "", stderr: "" }));
  assert.ok(info);
  assert.equal(info.h264, "libx264");
  assert.equal(info.vp9, true);
  assert.equal(info.vp8, false);
  assert.equal(info.jpegFrames, true);
  assert.equal(info.jpeg, true);
  assert.equal(info.x11grab, true);
  assert.equal(info.major, 6);
  assert.equal(await probeFfmpeg("/nope", "system", async () => ({ code: null, signal: null, stdout: "", stderr: "", error: "ENOENT" })), null);
});

test("ffmpeg choice: H.264 MP4 over VP9 over VP8 WebM; nothing without JPEG input or scaling", () => {
  const pw9 = ffmpeg({ path: "/pw9", source: "playwright", vp9: true, jpeg: false });
  const pw8 = ffmpeg({ path: "/pw8", source: "playwright", vp8: true, jpeg: false });
  const system = ffmpeg({ h264: "libx264", vp9: true });
  assert.equal(chooseVideoEncoder([pw9, system])?.container, "mp4");
  assert.equal(chooseVideoEncoder([pw9, system])?.ffmpeg.path, "/usr/bin/ffmpeg");
  assert.deepEqual([chooseVideoEncoder([pw8, pw9])?.codec, chooseVideoEncoder([pw8, pw9])?.mime], ["vp9", "video/webm"]);
  assert.equal(chooseVideoEncoder([pw8])?.codec, "vp8");
  assert.equal(chooseVideoEncoder([ffmpeg({ h264: "libx264", jpegFrames: false })]), null);
  assert.equal(chooseVideoEncoder([ffmpeg({ vp9: true, scale: false })]), null);
  assert.equal(chooseVideoEncoder([]), null);
});

test("ffmpeg command lines: frames from a pipe at a constant rate, fitted to even sizes", () => {
  const h264 = chooseVideoEncoder([ffmpeg({ h264: "libx264" })])!;
  const args = encodeFramesArgs({ choice: h264, fps: 30, width: 401, height: 121, output: "/e/clip.mp4" });
  const line = args.join(" ");
  assert.ok(line.includes("-f image2pipe -c:v mjpeg -framerate 30 -i pipe:0"), line);
  assert.ok(line.includes("scale=400:120:force_original_aspect_ratio=decrease:eval=frame,pad=400:120:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p"), line);
  assert.ok(line.includes("-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart"), line);
  assert.deepEqual(args.slice(-3), ["-r", "30", "/e/clip.mp4"]);
  assert.ok(args.indexOf("-framerate") < args.indexOf("-i"), "the input rate comes before the input");
  const vp9 = encodeFramesArgs({ choice: chooseVideoEncoder([ffmpeg({ vp9: true })])!, fps: 60, width: 1280, height: 720, output: "/e/a.webm" }).join(" ");
  assert.ok(vp9.includes("-c:v libvpx-vp9 -b:v 0 -crf 32"));
  const vp8 = encodeFramesArgs({ choice: chooseVideoEncoder([ffmpeg({ vp8: true })])!, fps: 25, width: 640, height: 480, output: "/e/b.webm" }).join(" ");
  assert.ok(vp8.includes("-c:v libvpx -b:v 4M"));
  const openh264 = encodeFramesArgs({ choice: chooseVideoEncoder([ffmpeg({ h264: "libopenh264" })])!, fps: 25, width: 640, height: 480, output: "/e/c.mp4" }).join(" ");
  assert.ok(openh264.includes("-c:v libopenh264"));
  assert.deepEqual(previewArgs({ maxWidth: 320, format: "png", output: "/e/p.png" }).slice(-9), ["-vf", "scale=w=min(320\\,iw):h=-2", "-frames:v", "1", "-c:v", "png", "-f", "image2", "/e/p.png"]);
  assert.equal(even(7), 6);
  assert.equal(even(1), 2);
});

test("ffmpeg command lines: x11grab of a window's region on a private display", () => {
  const region = { display: ":99", x: 108, y: 81, width: 801, height: 600 };
  assert.deepEqual(x11ScreenshotArgs(region, "/e/app.png"), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "x11grab", "-draw_mouse", "0", "-video_size", "800x600", "-i", ":99.0+108,81", "-frames:v", "1", "-c:v", "png", "-f", "image2", "/e/app.png"]);
  const choice = chooseVideoEncoder([ffmpeg({ h264: "libx264", x11grab: true })])!;
  const record = x11RecordArgs({ region: { ...region, x: -5 }, fps: 25, seconds: 15, choice, output: "/e/app.mp4" });
  const line = record.join(" ");
  assert.ok(line.includes("-framerate 25 -f x11grab -draw_mouse 0 -video_size 800x600 -i :99.0+0,81 -t 15.000"), line);
  assert.ok(line.includes("-c:v libx264"));
  assert.equal(record.at(-1), "/e/app.mp4");
});

// ── virtual displays ────────────────────────────────────────────────────────

test("Xvfb picks its own display, takes no TCP connections and reads a private cookie", () => {
  assert.deepEqual(xvfbArgs({ width: 1920, height: 1080, authFile: "/d/xauth-1" }), ["-displayfd", "3", "-screen", "0", "1920x1080x24", "-nolisten", "tcp", "-auth", "/d/xauth-1", "-noreset", "-dpi", "96"]);
  const cookie = Buffer.alloc(16, 0xab);
  const entry = xauthorityEntry(cookie);
  assert.deepEqual([...entry.subarray(0, 8)], [0xff, 0xff, 0, 0, 0, 0, 0, 18]);
  assert.equal(entry.subarray(8, 26).toString("latin1"), "MIT-MAGIC-COOKIE-1");
  assert.deepEqual([...entry.subarray(26, 28)], [0, 16]);
  assert.ok(entry.subarray(28).equals(cookie));
});

test("the cookie file is one that xauth itself reads", { skip: !findOnPath("xauth") && "no xauth on this computer" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-xauth-"));
  try {
    const file = join(dir, "cookie");
    writeFileSync(file, xauthorityEntry(Buffer.alloc(16, 0x1f)));
    const listed = spawnSync("xauth", ["-f", file, "list"], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /MIT-MAGIC-COOKIE-1\s+1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TREE = `
xwininfo: Window id: 0x1e5 (the root window) (has no name)

  Root window id: 0x1e5 (the root window) (has no name)
  Parent window id: 0x0 (none)
     3 children:
     0x400001 "Openbox": ()  1x1+-1+-1  +-1+-1
     0x600005 (has no name): ()  816x639+100+50  +100+50
        1 child:
        0x200003 "Hello \\"there\\"": ("xmessage" "Xmessage")  800x600+8+31  +108+81
     0x400002 (has no name): ()  1x1+-100+-100  +-100+-100
`;

test("window lookup output: xwininfo trees, xprop pids, xdotool geometry and wmctrl lists", () => {
  const windows = parseXwininfoTree(TREE);
  assert.deepEqual(
    windows.map((window) => [window.id, window.title, window.width, window.height, window.x, window.y]),
    [
      ["0x400001", "Openbox", 1, 1, -1, -1],
      ["0x600005", "", 816, 639, 100, 50],
      ["0x200003", 'Hello \\"there\\"', 800, 600, 108, 81],
      ["0x400002", "", 1, 1, -100, -100],
    ],
  );
  assert.equal(parseXpropPid("_NET_WM_PID(CARDINAL) = 4242"), 4242);
  assert.equal(parseXpropPid("_NET_WM_PID:  not found."), null);
  assert.deepEqual(parseXdotoolGeometry("WINDOW=12\nX=10\nY=-4\nWIDTH=640\nHEIGHT=480\nSCREEN=0\n"), { x: 10, y: -4, width: 640, height: 480 });
  assert.equal(parseXdotoolGeometry("nothing"), null);
  assert.deepEqual(parseWmctrl("0x01200003  0 4242   10 20  800 600 host My App — Main\n"), [{ id: "0x01200003", pid: 4242, x: 10, y: 20, width: 800, height: 600, title: "My App — Main" }]);
});

type Calls = Record<string, string>;
const runner = (outputs: Calls) => async (program: string, args: string[]) => ({ code: 0, signal: null, stdout: outputs[`${program.split("/").pop()} ${args.join(" ")}`] ?? "", stderr: "" });
const size = { width: 1920, height: 1080 };

test("finding the app's window: by process id, then title, then the only window, then the whole display", async () => {
  const xdotool: DisplayTools = { ...noTools, xdotool: "/usr/bin/xdotool" };
  const byPid = await findWindow({
    env: {},
    size,
    pids: new Set([41, 42]),
    tools: xdotool,
    run: runner({ "xdotool search --onlyvisible --pid 42": "12345\n", "xdotool getwindowgeometry --shell 12345": "X=10\nY=20\nWIDTH=800\nHEIGHT=600\n", "xdotool getwindowname 12345": "Editor\n" }),
  });
  assert.deepEqual(byPid, { id: "0x3039", title: "Editor", x: 10, y: 20, width: 800, height: 600, pid: 42, how: "pid" });
  const tree: DisplayTools = { ...noTools, xwininfo: "/usr/bin/xwininfo", xprop: "/usr/bin/xprop" };
  const withPid = await findWindow({ env: {}, size, pids: new Set([7, 8]), tools: tree, run: runner({ "xwininfo -root -tree": TREE, "xprop -id 0x200003 _NET_WM_PID": "_NET_WM_PID(CARDINAL) = 8" }) });
  assert.equal(withPid.how, "pid");
  assert.equal(withPid.id, "0x200003");
  assert.deepEqual([withPid.x, withPid.y], [108, 81]);
  const twoWindows = TREE.replace("0x400002 (has no name): ()  1x1+-100+-100  +-100+-100", '0x400009 "Settings": ()  300x200+0+0  +0+0');
  const byTitle = await findWindow({ env: {}, size, pids: new Set([99]), title: "hello", tools: tree, run: runner({ "xwininfo -root -tree": twoWindows }) });
  assert.equal(byTitle.how, "title");
  assert.equal(byTitle.id, "0x200003");
  const only = await findWindow({ env: {}, size, pids: new Set([99]), tools: tree, run: runner({ "xwininfo -root -tree": TREE }) });
  assert.equal(only.how, "only-window", "a 1×1 window manager window is not a candidate");
  const none = await findWindow({ env: {}, size, pids: new Set([99]), tools: tree, run: runner({ "xwininfo -root -tree": twoWindows }) });
  assert.deepEqual(none, { id: "root", title: "", x: 0, y: 0, width: 1920, height: 1080, how: "display" });
  const wmctrl: DisplayTools = { ...noTools, wmctrl: "/usr/bin/wmctrl" };
  const listed = await findWindow({ env: {}, size, pids: new Set([5]), tools: wmctrl, run: runner({ "wmctrl -lpG": "0x01200003  0 5   0 0  640 480 host Main\n" }) });
  assert.equal(listed.how, "pid");
});

test("a process's tree from /proc, including names with spaces and brackets", () => {
  const stats: Record<string, string> = {
    "/proc/1/stat": "1 (systemd) S 0 1 1",
    "/proc/42/stat": "42 (sh) S 1 42 42",
    "/proc/43/stat": "43 (my (odd) app) S 42 42 42",
    "/proc/44/stat": "44 (electron) S 43 42 42",
    "/proc/50/stat": "50 (other) S 1 50 50",
  };
  const tree = processTree(42, (path) => {
    if (!(path in stats)) throw new Error("gone");
    return stats[path]!;
  }, () => ["1", "42", "43", "44", "50", "51", "self", "cpuinfo"]);
  assert.deepEqual([...tree].sort(), [42, 43, 44]);
});

test("an app on a virtual display sees only that display: no Wayland, no session bus, X11 toolkits", () => {
  const env = virtualDisplayEnv({ PATH: "/usr/bin", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", XDG_SESSION_TYPE: "wayland", HOME: "/home/mira" }, { DISPLAY: ":99", XAUTHORITY: "/d/xauth" });
  assert.equal(env.DISPLAY, ":99");
  assert.equal(env.XAUTHORITY, "/d/xauth");
  assert.equal(env.WAYLAND_DISPLAY, undefined);
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, undefined);
  assert.equal(env.XDG_SESSION_TYPE, "x11");
  assert.equal(env.GDK_BACKEND, "x11");
  assert.equal(env.QT_QPA_PLATFORM, "xcb");
  assert.equal(env.ELECTRON_OZONE_PLATFORM_HINT, "x11");
  assert.equal(env.PATH, "/usr/bin");
});

test("Electron is found from the app's own node_modules, in its folder or a parent, without running it", () => {
  const files: Record<string, string> = {
    "/work/node_modules/electron/package.json": '{"name":"electron","version":"33.2.0"}',
    "/work/node_modules/electron/path.txt": "electron\n",
    "/work/node_modules/electron/dist/electron": "",
  };
  const exists = (path: string) => path in files;
  const read = (path: string) => {
    if (!(path in files)) throw new Error("ENOENT");
    return files[path]!;
  };
  assert.deepEqual(findElectron("/work/apps/notifier", exists, read), { executablePath: "/work/node_modules/electron/dist/electron", version: "33.2.0", packageDir: "/work/node_modules/electron" });
  delete files["/work/node_modules/electron/dist/electron"];
  assert.equal(findElectron("/work/apps/notifier", exists, read), null, "an install without its binary does not count");
  assert.equal(findElectron("/elsewhere", exists, read), null);
});

test("an app's output keeps its last lines, with keys hidden", () => {
  const tail = new OutputTail(3);
  tail.push("one\ntwo\nthree\n");
  tail.push("token ghp_abcdefghijklmnopqrstuvwxyz0123\nfour");
  assert.equal(tail.text(), "three\ntoken [redacted]\nfour");
});

// ── media ───────────────────────────────────────────────────────────────────

test("real-time frames are resampled to a constant rate: each slot shows the newest frame captured by then", async () => {
  const written: string[] = [];
  const encoder = { full: false, write: async (frame: Buffer) => (written.push(frame.toString()), true) };
  const feeder = new ConstantRateFeeder(encoder, 10);
  await feeder.push(Buffer.from("A"), 1_000);
  await feeder.push(Buffer.from("B"), 1_100);
  await feeder.push(Buffer.from("C"), 1_250);
  await feeder.end(1_400);
  assert.deepEqual(written, ["A", "B", "B", "C"]);
  const single: string[] = [];
  const once = new ConstantRateFeeder({ full: false, write: async (frame: Buffer) => (single.push(frame.toString()), true) }, 25);
  await once.push(Buffer.from("only"), 5);
  await once.end(5);
  assert.deepEqual(single, ["only"], "a recording with one frame still has it");
  let count = 0;
  const limited = new ConstantRateFeeder({ full: false, write: async () => (count += 1) < 3 }, 10);
  await limited.push(Buffer.from("x"), 0);
  await limited.push(Buffer.from("y"), 1_000);
  await limited.end(2_000);
  assert.equal(count, 3, "writing stops at the encoder's limit");
  assert.equal(limited.limitReached, true);
});

test("file names: slugs, and reserving never overwrites", async () => {
  assert.equal(slugName("Sign-up page (mobile)!", "x"), "sign-up-page-mobile");
  assert.equal(slugName("   ", "fallback"), "fallback");
  assert.equal(slugName(undefined, "fallback"), "fallback");
  assert.equal(slugName("Ünïcödé name", "x"), "unicode-name");
  const dir = mkdtempSync(join(tmpdir(), "ensemble-reserve-"));
  try {
    const first = await reserveFile(dir, "shot", "png");
    const second = await reserveFile(dir, "shot", "png");
    assert.equal(first, join(dir, "shot.png"));
    assert.equal(second, join(dir, "shot-2.png"));
    assert.deepEqual(readdirSync(dir).sort(), ["shot-2.png", "shot.png"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PNG decoding and statistics tell a blank image from a drawn one", async () => {
  const blank = png(64, 32, () => [255, 255, 255, 255]);
  const drawn = png(64, 32, (x, y) => (x > 10 && x < 40 && y > 5 && y < 20 ? [200, 30, 30, 255] : [255, 255, 255, 255]));
  const transparent = png(16, 16, () => [0, 0, 0, 0]);
  assert.deepEqual(imageInfo(drawn), { format: "png", mime: "image/png", width: 64, height: 32 });
  const decoded = await decodePng(drawn);
  assert.deepEqual([...decoded.data.subarray((10 * 64 + 20) * 4, (10 * 64 + 20) * 4 + 4)], [200, 30, 30, 255]);
  assert.equal(blankVerdict(await pngStats(blank)).blank, true);
  assert.equal(blankVerdict(await pngStats(drawn)).blank, false);
  const empty = await pngStats(transparent);
  assert.equal(empty.dominant.hex, "#ffffff", "transparent pixels count as the page behind them");
  assert.equal(blankVerdict(empty).blank, true);
  assert.match(blankVerdict(await pngStats(blank)).detail, /100\.0% of it is #ffffff/);
});

test("checkImage: a blank file fails, a drawn one passes, others are skipped or blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-check-"));
  try {
    writeFileSync(join(dir, "blank.png"), png(40, 40, () => [12, 12, 12, 255]));
    writeFileSync(join(dir, "drawn.png"), png(40, 40, (x) => (x < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255])));
    writeFileSync(join(dir, "notes.txt"), "not an image");
    const blank = await checkImage(join(dir, "blank.png"), { id: "screen" });
    assert.deepEqual([blank.verdict, blank.id, blank.evidence], ["fail", "screen", ["blank.png"]]);
    assert.equal((await checkImage(join(dir, "drawn.png"))).verdict, "pass");
    assert.equal((await checkImage(join(dir, "notes.txt"), { tools: [] })).verdict, "skipped");
    assert.equal((await checkImage(join(dir, "missing.png"))).verdict, "blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function webm(options: { unknownSize?: boolean } = {}): Buffer {
  const vint = (size: number) => {
    const out = Buffer.alloc(8);
    out[0] = 0x01;
    out.writeUIntBE(size, 2, 6);
    return out;
  };
  const el = (id: number[], body: Buffer, unknown = false) => Buffer.concat([Buffer.from(id), unknown ? Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : vint(body.length), body]);
  const uint = (value: number, bytes = 4) => {
    const out = Buffer.alloc(bytes);
    out.writeUIntBE(value, 0, bytes);
    return out;
  };
  const float = (value: number) => {
    const out = Buffer.alloc(8);
    out.writeDoubleBE(value);
    return out;
  };
  const block = (track: number, time: number) => {
    const head = Buffer.alloc(4);
    head[0] = 0x80 | track;
    head.writeInt16BE(time, 1);
    head[3] = 0x80;
    return el([0xa3], Buffer.concat([head, Buffer.from([1, 2, 3])]));
  };
  const info = el([0x15, 0x49, 0xa9, 0x66], Buffer.concat([el([0x2a, 0xd7, 0xb1], uint(1_000_000)), el([0x44, 0x89], float(400))]));
  const video = el([0xae], Buffer.concat([el([0xd7], uint(1, 1)), el([0x83], uint(1, 1)), el([0x86], Buffer.from("V_VP9")), el([0xe0], Buffer.concat([el([0xb0], uint(400, 2)), el([0xba], uint(120, 2))]))]));
  const audio = el([0xae], Buffer.concat([el([0xd7], uint(2, 1)), el([0x83], uint(2, 1)), el([0x86], Buffer.from("A_OPUS"))]));
  const tracks = el([0x16, 0x54, 0xae, 0x6b], Buffer.concat([video, audio]));
  const cluster1 = el([0x1f, 0x43, 0xb6, 0x75], Buffer.concat([el([0xe7], uint(0, 2)), block(1, 0), block(2, 10), block(1, 100)]));
  const cluster2 = el([0x1f, 0x43, 0xb6, 0x75], Buffer.concat([el([0xe7], uint(200, 2)), block(1, 0), block(1, 100)]));
  const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], Buffer.from("webm")));
  return Buffer.concat([header, el([0x18, 0x53, 0x80, 0x67], Buffer.concat([info, tracks, cluster1, cluster2]), options.unknownSize)]);
}

test("WebM probing: the video track's frames, times, size and codec", () => {
  for (const unknownSize of [false, true]) {
    const probe = probeWebm(webm({ unknownSize }));
    assert.deepEqual(probe, { container: "webm", codec: "V_VP9", width: 400, height: 120, durationMs: 400, frames: 4, timestampsMs: [0, 100, 200, 300] });
  }
});

function mp4(): Buffer {
  const box = (type: string, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length + 8);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, body]);
  };
  const u32 = (...values: number[]) => {
    const out = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => out.writeUInt32BE(value, index * 4));
    return out;
  };
  const tkhd = box("tkhd", u32(0, 0, 0, 1, 0, 1000), Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(36), u32(640 * 65536, 360 * 65536));
  const mdhd = box("mdhd", u32(0, 0, 0, 15360, 15360), Buffer.alloc(4));
  const hdlr = box("hdlr", u32(0, 0), Buffer.from("vide"), Buffer.alloc(12), Buffer.from("VideoHandler\0"));
  const stsd = box("stsd", u32(0, 1), u32(86), Buffer.from("avc1"), Buffer.alloc(78));
  const stts = box("stts", u32(0, 1, 30, 512));
  const soundHdlr = box("hdlr", u32(0, 0), Buffer.from("soun"), Buffer.alloc(12));
  const sound = box("trak", box("mdia", soundHdlr));
  const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", box("stbl", stsd, stts))));
  return Buffer.concat([box("ftyp", Buffer.from("isom"), u32(512), Buffer.from("isomavc1")), box("moov", box("mvhd", Buffer.alloc(100)), sound, trak), box("mdat", Buffer.alloc(16))]);
}

test("MP4 probing: the video track's frames, times, size and codec", () => {
  const probe = probeMp4(mp4());
  assert.equal(probe.codec, "avc1");
  assert.deepEqual([probe.width, probe.height, probe.frames, probe.durationMs], [640, 360, 30, 1000]);
  probe.timestampsMs.forEach((time, index) => assert.ok(Math.abs(time - (index * 1000) / 30) < 1e-9));
  assert.throws(() => probeMp4(Buffer.from("not an mp4 at all")), /movie header/);
});

// ── checks and transcripts ──────────────────────────────────────────────────

test("text checks ignore case and spacing and name what is missing", () => {
  const text = "Create your   account\nSign UP now";
  assert.deepEqual(checkTextIn(text, ["create your account", "sign up"], { id: "form" }), { id: "form", name: "Shows the expected text", verdict: "pass", detail: "Found “create your account”, “sign up”." });
  const missing = checkTextIn(text, ["Sign up", "Forgot password"]);
  assert.equal(missing.verdict, "fail");
  assert.equal(missing.detail, "Not found: “Forgot password”.");
  assert.equal(checkTextIn(text, [" "]).verdict, "skipped");
});

test("crash lines in an app's output", () => {
  assert.equal(crashLine("ready\nSegmentation fault (core dumped)\n"), "Segmentation fault (core dumped)");
  assert.equal(crashLine("App threw an error during load\nA JavaScript error occurred in the main process"), "A JavaScript error occurred in the main process");
  assert.equal(crashLine("Traceback (most recent call last):\n  File x"), "Traceback (most recent call last):");
  assert.equal(crashLine("all good\nlistening on 3000"), null);
});

test("terminal transcripts: carriage returns redraw, colours become spans, HTML is escaped", () => {
  assert.equal(settleLines("progress 10%\rprogress 100%\nabcdef\rXY\nab\bc"), "progress 100%\nXYcdef\nac");
  assert.equal(stripAnsi("\u001b[1;31merror\u001b[0m \u001b]0;title\u0007done"), "error done");
  assert.equal(ansiToHtml("\u001b[32mok\u001b[0m <b>"), '<span style="color:#0dbc79">ok</span> &lt;b&gt;');
  assert.equal(ansiToHtml("\u001b[1;38;5;196mhot\u001b[22;39m cold"), '<span style="color:#ff0000;font-weight:bold">hot</span> cold');
  assert.equal(ansiToHtml("\u001b[48;2;1;2;3mbg\u001b[49m"), '<span style="background:#010203">bg</span>');
  assert.equal(ansiToHtml("\u001b[7minverse"), '<span style="color:#1e1e1e;background:#e5e5e5">inverse</span>');
  assert.equal(xtermColour(16), "#000000");
  assert.equal(xtermColour(231), "#ffffff");
  assert.equal(xtermColour(244), "#808080");
});

test("terminal transcripts hide saved secrets and keys, even when colour codes split them", () => {
  const rules = { secretValues: ["opensesame-123"] };
  const plain = transcriptHtml({ transcript: "token ghp_abcdefghijklmnopqrstuvwxyz0123\npassword opensesame-123\n", rules });
  assert.ok(!plain.html.includes("opensesame-123") && !plain.html.includes("ghp_abc"));
  assert.equal(plain.hidden, true);
  const split = transcriptHtml({ transcript: "\u001b[33mopen\u001b[0m\u001b[34msesame-123\u001b[0m", rules });
  assert.ok(!split.html.includes("sesame-123"), split.html);
  assert.ok(!split.html.includes("<span"), "colours are dropped to hide a split secret");
  const clean = transcriptHtml({ transcript: "\u001b[32mall 12 passed\u001b[0m", title: "<npm test>", rules });
  assert.equal(clean.hidden, false);
  assert.match(clean.html, /<title>&lt;npm test&gt;<\/title>/);
  assert.match(clean.html, /default-src 'none'/);
});

// ── system helpers ──────────────────────────────────────────────────────────

test("finding programs on PATH, and the Linux distribution", () => {
  const present = new Set(["/opt/bin/Xvfb", "/usr/bin/ffmpeg"]);
  assert.equal(findOnPath("Xvfb", { PATH: "/usr/bin:/opt/bin" }, "linux", (path) => present.has(path)), "/opt/bin/Xvfb");
  assert.equal(findOnPath("missing", { PATH: "/usr/bin" }, "linux", (path) => present.has(path)), null);
  assert.equal(findOnPath("/usr/bin/ffmpeg", {}, "linux", (path) => present.has(path)), "/usr/bin/ffmpeg");
  assert.equal(findOnPath("ffmpeg", { Path: "C:\\bin", PATHEXT: ".EXE" }, "win32", (path) => path === join("C:\\bin", "ffmpeg.exe")), join("C:\\bin", "ffmpeg.exe"));
  assert.deepEqual(linuxDistro(() => 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="26.04"\n'), { id: "ubuntu", like: ["debian"] });
  assert.deepEqual(linuxDistro(() => 'ID="fedora"\n'), { id: "fedora", like: [] });
  assert.equal(linuxDistro(() => {
    throw new Error("ENOENT");
  }), null);
});
