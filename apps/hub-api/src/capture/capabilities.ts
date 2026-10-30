/**
 * What capture can do on this computer (ensemble-node design E§8.6), reported to the node as the
 * computer's `capture` capability and shown by `ensemble capture status`: the browser, the video
 * encoders, the virtual display pieces on Linux, and for each target whether screenshots and video
 * work here, or why not and the one command that fixes it.
 */
import { homedir } from "node:os";
import { findChromium, playwrightRevisions, type ChromiumChoice } from "../browser/chromium.js";
import { ensembleDataHome, playwrightBrowsersDir } from "../browser/paths.js";
import { findDisplayTools, type DisplayTools } from "./display.js";
import { chooseVideoEncoder, findFfmpegs, type FfmpegInfo, type VideoCodec } from "./ffmpeg.js";
import { findOnPath, linuxDistro, runCommand, type Distro } from "./system.js";

/** `tui` (terminal only): full-screen programs such as htop are captured as their screen, in a pseudo-terminal. */
export type Availability = { screenshot: boolean; video: boolean; reason?: string; tui?: boolean };
export type TargetName = "web" | "electron" | "gui" | "terminal" | "desktop";

export type CaptureCapabilities = {
  platform: "linux" | "macos" | "windows" | string;
  /** The owner's own display, if any (capture never uses it). */
  session: { x11: string | null; wayland: string | null };
  browser: {
    available: boolean;
    executablePath: string | null;
    kind: ChromiumChoice["kind"] | null;
    revision: number | null;
    /** The revision playwright-core expects; `ensemble capture setup` installs it. */
    wanted: number;
    matches: boolean;
    source: ChromiumChoice["source"] | null;
    playwright: string;
    installDir: string;
  };
  ffmpeg: Array<Pick<FfmpegInfo, "path" | "source" | "version" | "h264" | "vp9" | "vp8" | "x11grab">>;
  video: { container: "mp4" | "webm"; codec: VideoCodec; ffmpeg: string } | null;
  virtualDisplay: { xvfb: string | null; windowManager: string | null; windowLookup: Array<"xdotool" | "xwininfo" | "xprop" | "wmctrl"> };
  /** macOS only: the Screen Recording permission of the app that runs Ensemble. Web pages and Electron apps do not need it. */
  screenRecording?: "granted" | "denied" | "unknown";
  targets: Record<TargetName, Availability>;
  setup: {
    /** What `ensemble capture setup` installs without administrator rights. */
    ensembleInstalls: string[];
    /** The one command for system packages, for the owner to run. */
    systemCommand: string | null;
    notes: string[];
  };
  checkedAt: string;
};

export type CapabilityProbe = {
  platform: string;
  env: NodeJS.ProcessEnv;
  dataHome: string;
  chromium: (headless: boolean) => ChromiumChoice | null;
  ffmpegs: () => Promise<FfmpegInfo[]>;
  displayTools: () => DisplayTools;
  distro: () => Distro | null;
  screenRecording: () => Promise<"granted" | "denied" | "unknown">;
  /** A pseudo-terminal program (`script`) for a node's terminal screens. */
  pty: () => boolean;
  now: () => Date;
};

/** macOS: asks CoreGraphics whether screen capture is allowed, without prompting. */
async function macScreenRecording(): Promise<"granted" | "denied" | "unknown"> {
  if (process.platform !== "darwin") return "unknown";
  const result = await runCommand("osascript", ["-l", "JavaScript", "-e", "ObjC.import('CoreGraphics'); $.CGPreflightScreenCaptureAccess()"], { timeoutMs: 4_000 });
  const answer = result.stdout.trim();
  return answer === "true" ? "granted" : answer === "false" ? "denied" : "unknown";
}

export function realProbe(dataHome: string = ensembleDataHome()): CapabilityProbe {
  return {
    platform: process.platform,
    env: process.env,
    dataHome,
    chromium: (headless) => findChromium({ headless, dataHome }),
    ffmpegs: () => findFfmpegs({ dataHome }),
    displayTools: () => findDisplayTools(),
    distro: () => linuxDistro(),
    screenRecording: macScreenRecording,
    pty: () => process.platform !== "win32" && Boolean(findOnPath("script")),
    now: () => new Date(),
  };
}

const PACKAGES: Record<string, Record<"xvfb" | "ffmpeg" | "wm" | "xdotool", string>> = {
  apt: { xvfb: "xvfb", ffmpeg: "ffmpeg", wm: "openbox", xdotool: "xdotool" },
  dnf: { xvfb: "xorg-x11-server-Xvfb", ffmpeg: "ffmpeg-free", wm: "openbox", xdotool: "xdotool" },
  pacman: { xvfb: "xorg-server-xvfb", ffmpeg: "ffmpeg", wm: "openbox", xdotool: "xdotool" },
  zypper: { xvfb: "xorg-x11-server-Xvfb", ffmpeg: "ffmpeg", wm: "openbox", xdotool: "xdotool" },
};

function packageManager(distro: Distro | null): "apt" | "dnf" | "pacman" | "zypper" | null {
  if (!distro) return null;
  const ids = [distro.id, ...distro.like];
  if (ids.some((id) => ["debian", "ubuntu", "linuxmint", "pop", "elementary", "raspbian"].includes(id))) return "apt";
  if (ids.some((id) => ["fedora", "rhel", "centos", "rocky", "almalinux"].includes(id))) return "dnf";
  if (ids.some((id) => ["arch", "manjaro", "endeavouros"].includes(id))) return "pacman";
  if (ids.some((id) => id.startsWith("opensuse") || id === "suse" || id === "sles")) return "zypper";
  return null;
}

/** The install command for the missing system packages, for this Linux distribution. */
export function systemInstallCommand(missing: Array<"xvfb" | "ffmpeg" | "wm" | "xdotool">, distro: Distro | null): string | null {
  if (!missing.length) return null;
  const manager = packageManager(distro);
  if (!manager) return null;
  const names = missing.map((item) => PACKAGES[manager]![item]);
  if (manager === "apt") return `sudo apt install ${names.join(" ")}`;
  if (manager === "dnf") return `sudo dnf install ${names.join(" ")}`;
  if (manager === "pacman") return `sudo pacman -S ${names.join(" ")}`;
  return `sudo zypper install ${names.join(" ")}`;
}

export function platformName(platform: string): string {
  return platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform;
}

/** Works out the report from what the probe finds. */
export async function computeCapabilities(probe: CapabilityProbe): Promise<CaptureCapabilities> {
  const linux = probe.platform === "linux";
  const mac = probe.platform === "darwin";
  const wanted = playwrightRevisions();
  const browser = probe.chromium(true);
  const ffmpegs = await probe.ffmpegs();
  const video = chooseVideoEncoder(ffmpegs);
  const tools: DisplayTools = linux ? probe.displayTools() : { xvfb: null, windowManager: null, xdotool: null, xwininfo: null, xprop: null, wmctrl: null };
  const grabber = ffmpegs.find((info) => info.x11grab);
  const grabVideo = grabber && chooseVideoEncoder([grabber]);
  const system = ffmpegs.find((info) => info.source === "system" || info.source === "explicit");
  const notes: string[] = [];
  const ensembleInstalls: string[] = [];
  if (!browser || !browser.matches) ensembleInstalls.push(`Playwright's Chromium ${wanted.chromiumVersion ?? `r${wanted.chromium}`}`);
  if (!video) ensembleInstalls.push("Playwright's ffmpeg (WebM video)");
  const missing: Array<"xvfb" | "ffmpeg" | "wm" | "xdotool"> = [];
  if (linux) {
    if (!tools.xvfb) missing.push("xvfb");
    if (!grabber || !system?.h264) missing.push("ffmpeg");
    if (!tools.windowManager) missing.push("wm");
    if (!tools.xdotool) missing.push("xdotool");
  }
  let systemCommand = linux ? systemInstallCommand(missing, probe.distro()) : null;
  if (linux && missing.length && !systemCommand) notes.push(`Install with your package manager: ${missing.map((item) => ({ xvfb: "Xvfb", ffmpeg: "ffmpeg", wm: "a window manager such as openbox", xdotool: "xdotool" })[item]).join(", ")}.`);
  if (mac && !system?.h264) systemCommand = "brew install ffmpeg";
  if (video && video.container === "webm") notes.push("Videos are WebM (VP9 or VP8) until a system ffmpeg with an H.264 encoder is installed; then they are MP4.");
  if (browser && !browser.matches) notes.push(`Using ${browser.source === "system" ? "the installed Chrome" : `Chromium r${browser.revision} from ${browser.source === "ensemble" ? "Ensemble's folder" : "Playwright's shared folder"}`}; Playwright ${wanted.version} expects r${wanted.chromium}.`);

  const noBrowser = "No Chromium here. Run `ensemble capture setup`.";
  const noEncoder = "No video encoder here. Run `ensemble capture setup`.";
  const web: Availability = { screenshot: Boolean(browser), video: Boolean(browser && video), ...(!browser ? { reason: noBrowser } : !video ? { reason: noEncoder } : {}) };
  let electron: Availability;
  let gui: Availability;
  if (linux) {
    const xvfbMissing = "Needs Xvfb for a private virtual display.";
    electron = { screenshot: Boolean(tools.xvfb), video: Boolean(tools.xvfb && video), ...(!tools.xvfb ? { reason: xvfbMissing } : !video ? { reason: noEncoder } : {}) };
    gui = {
      screenshot: Boolean(tools.xvfb && grabber),
      video: Boolean(tools.xvfb && grabVideo),
      ...(!tools.xvfb ? { reason: xvfbMissing } : !grabber ? { reason: "Needs the system's ffmpeg, which can read an X display." } : !grabVideo ? { reason: "The system's ffmpeg has no video encoder." } : {}),
    };
  } else if (mac) {
    electron = { screenshot: true, video: Boolean(video), ...(!video ? { reason: noEncoder } : {}) };
    gui = { screenshot: false, video: false, reason: "Other desktop apps on macOS need window capture with Screen Recording permission, which Ensemble does not do yet." };
  } else {
    electron = { screenshot: false, video: false, reason: "Not supported on this system yet." };
    gui = { screenshot: false, video: false, reason: "Not supported on this system yet." };
  }
  const tui = Boolean(browser) && probe.platform !== "win32" && probe.pty();
  const terminal: Availability = !browser
    ? { screenshot: false, video: false, tui: false, reason: "Images of a terminal need Chromium; an HTML transcript works without it." }
    : tui
      ? { screenshot: true, video: false, tui: true, reason: "A terminal is captured as its screen (full-screen programs such as htop too) or its transcript, not as video." }
      : { screenshot: true, video: false, tui: false, reason: probe.platform === "win32" ? "A terminal is captured as its transcript (HTML or an image): full-screen programs need a pseudo-terminal, which Windows does not give Ensemble yet." : "A terminal is captured as its transcript (HTML or an image): full-screen programs need `script` (util-linux), which is not installed." };
  const desktop: Availability = { screenshot: false, video: false, reason: "Capturing your real screen is not supported yet. It will ask for your consent each time." };

  return {
    platform: platformName(probe.platform),
    session: { x11: probe.env.DISPLAY?.trim() || null, wayland: probe.env.WAYLAND_DISPLAY?.trim() || null },
    browser: {
      available: Boolean(browser),
      executablePath: browser?.executablePath ?? null,
      kind: browser?.kind ?? null,
      revision: browser?.revision ?? null,
      wanted: wanted.chromium,
      matches: Boolean(browser?.matches),
      source: browser?.source ?? null,
      playwright: wanted.version,
      installDir: playwrightBrowsersDir(probe.dataHome),
    },
    ffmpeg: ffmpegs.map(({ path, source, version, h264, vp9, vp8, x11grab }) => ({ path, source, version, h264, vp9, vp8, x11grab })),
    video: video ? { container: video.container, codec: video.codec, ffmpeg: video.ffmpeg.path } : null,
    virtualDisplay: {
      xvfb: tools.xvfb,
      windowManager: tools.windowManager?.name ?? null,
      windowLookup: (["xdotool", "xwininfo", "xprop", "wmctrl"] as const).filter((name) => tools[name]),
    },
    ...(mac ? { screenRecording: await probe.screenRecording() } : {}),
    targets: { web, electron, gui, terminal, desktop },
    setup: { ensembleInstalls, systemCommand, notes },
    checkedAt: probe.now().toISOString(),
  };
}

let cached: { at: number; value: CaptureCapabilities; dataHome: string } | null = null;

/** This computer's capture capabilities, cached for a minute unless `refresh`. */
export async function captureCapabilities(options: { refresh?: boolean; dataHome?: string; probe?: CapabilityProbe } = {}): Promise<CaptureCapabilities> {
  const dataHome = options.dataHome ?? options.probe?.dataHome ?? ensembleDataHome(process.env, process.platform, homedir());
  if (!options.probe && !options.refresh && cached && cached.dataHome === dataHome && Date.now() - cached.at < 60_000) return cached.value;
  const value = await computeCapabilities(options.probe ?? realProbe(dataHome));
  if (!options.probe) cached = { at: Date.now(), value, dataHome };
  return value;
}
