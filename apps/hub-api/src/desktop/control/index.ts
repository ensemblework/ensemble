/**
 * This computer's desktop control (docs/25 §11): a `DesktopService` for the owner's screen and one for
 * the agent screen (`Desktops`, screens.ts), each started on first use with its helper as a child process.
 *
 * - Linux: the Python helper (desktop-helper/linux). It gets the desktop session's variables (its bus, its
 *   display) and nothing else of this runtime's environment; the agent screen's helper starts a private
 *   headless GNOME Shell and ends it after `ENSEMBLE_AGENT_SCREEN_IDLE_MINUTES` (default 10) without a call.
 * - macOS: cua-driver (drivers/macos-cua.ts), bundled at `<sidecar>/bin/cua-driver` at the version pinned in
 *   desktop-helper/macos/cua-driver.json, only in the Ensemble app's own runtime (macOS then asks about its
 *   permissions for Ensemble). It gets a minimal environment with telemetry and update checks off. There is
 *   no agent screen on macOS.
 * - Windows and other systems answer that desktop control is not there.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensembleDataHome } from "../../browser/paths.js";
import { evidenceRoot } from "../../evidence/files.js";
import { findPython3 } from "../../runtime/python-spawn.js";
import { MacosCuaDriver } from "./drivers/macos-cua.js";
import { HelperProcess, type HelperCommand } from "./helper-process.js";
import { Desktops } from "./screens.js";
import { DesktopService, RECORDING_SAVE_MS, sweepRecordingParts, type HelperLike } from "./service.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The helper's script: `desktop-helper/linux` of this package, beside `src` and `dist` alike. */
export function helperScript(): string | null {
  const script = resolve(HERE, "../../../desktop-helper/linux/ensemble_desktop.py");
  return existsSync(script) ? script : null;
}

/** Where the helper keeps the portal's restore token and the model's recent screenshots. */
export function desktopDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(ensembleDataHome(env), "desktop");
}

export const UNSUPPORTED_HERE = "Desktop control works on Linux (desktops with the desktop portal: GNOME, KDE and others) and on macOS 13 or later in the Ensemble app.";
export const WINDOWS_UNSUPPORTED = "Desktop control is not available on Windows in this version: it works on Linux and on macOS.";
export const NO_AGENT_SCREEN_MAC = "macOS has no private agent screen in this version: desktop work happens on your owner's screen, in the background where it can (apps open behind their windows, and elements are read and pressed through accessibility).";
export const MAC_APP_ONLY = "On macOS, desktop control runs inside the Ensemble app, so macOS asks about Accessibility and Screen Recording for Ensemble and not for a terminal. This runtime was started by the `ensemble` command line: stop it with `ensemble runner stop`, then quit and reopen the Ensemble app so it starts its own.";
/** The Ensemble app's bundle id (apps/desktop/src-tauri/tauri.conf.json), as cua-driver's advisory host label. */
const ENSEMBLE_BUNDLE_ID = "com.ensemblework.desktop";

/** Whether desktop control works on this system at all (Linux and macOS). */
export function desktopSystem(platform: string = process.platform): boolean {
  return platform === "linux" || platform === "darwin";
}

/** The cua-driver this Ensemble is built for: desktop-helper/macos/cua-driver.json, which the macOS build fetches by its checksum. */
export type CuaDriverPin = { version: string; tag: string; asset: string; url: string; sha256: string; member: string };
let pinned: CuaDriverPin | null = null;
export function cuaDriverPin(): CuaDriverPin {
  pinned ??= JSON.parse(readFileSync(resolve(HERE, "../../../desktop-helper/macos/cua-driver.json"), "utf8")) as CuaDriverPin;
  return pinned;
}

/** macOS's major version from the kernel's (Darwin 22 is macOS 13, Darwin 24 macOS 15, Darwin 25 macOS 26); null elsewhere. */
export function macosMajor(kernel: string = release()): number | null {
  const darwin = Number(kernel.split(".")[0]);
  if (!Number.isInteger(darwin) || darwin < 20) return null;
  return darwin >= 25 ? darwin + 1 : darwin - 9;
}

/** The bundled cua-driver beside the sidecar's Node (`<sidecar>/bin/cua-driver`), or one named by ENSEMBLE_CUA_DRIVER. */
export function findCuaDriver(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): string | null {
  const candidates = [env.ENSEMBLE_CUA_DRIVER, join(dirname(execPath), "bin", "cua-driver"), join(dirname(execPath), "..", "bin", "cua-driver")].filter((value): value is string => Boolean(value?.trim()));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try the next
    }
  }
  return null;
}

/** Why this runtime cannot hold macOS's grants for Ensemble (it was not started by the Ensemble app), or null. */
export function macHostProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ENSEMBLE_RUNTIME_OWNER === "desktop" && /\.app\/Contents\/MacOS\//.test(env.ENSEMBLE_INSTALL_PATH ?? "") ? null : MAC_APP_ONLY;
}

/** cua-driver's environment: what it needs to run, its own folder, telemetry and update checks off. Never this runtime's secrets. */
export function cuaDriverEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "USER", "LOGNAME", "LANG", "TMPDIR"]) if (env[key]) out[key] = env[key];
  for (const [key, value] of Object.entries(env)) if (key.startsWith("LC_") && value !== undefined) out[key] = value;
  return {
    ...out,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CUA_DRIVER_RS_HOME: home,
    CUA_DRIVER_EMBEDDED: "1",
    CUA_DRIVER_HOST_BUNDLE_ID: ENSEMBLE_BUNDLE_ID,
    CUA_DRIVER_PERMISSION_MODE: "standard",
    CUA_DRIVER_DISABLE_RUN_SCRIPT: "1",
    DO_NOT_TRACK: "1",
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
    CUA_TELEMETRY_ENABLED: "0",
    CUA_DRIVER_RS_UPDATE_CHECK: "0",
  };
}

/**
 * `cua-driver mcp --direct --embedded`: the driver's runtime in its own process, kept in this runtime's chain
 * of responsibility (the Ensemble app's), never prompting and never handing itself to LaunchServices.
 */
export function cuaDriverCommand(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath, kernel: string = release()): HelperCommand | { unavailable: string } {
  const major = macosMajor(kernel);
  if (major !== null && major < 13) return { unavailable: `Desktop control needs macOS 13 or later; this Mac runs macOS ${major}.` };
  const host = macHostProblem(env);
  if (host) return { unavailable: host };
  const binary = findCuaDriver(env, execPath);
  if (!binary) return { unavailable: "This Ensemble app has no macOS desktop driver (cua-driver) beside its runtime: update the Ensemble app." };
  const home = join(desktopDataDir(env), "cua-driver");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { command: binary, args: ["mcp", "--direct", "--embedded", "--host-bundle-id", ENSEMBLE_BUNDLE_ID], env: cuaDriverEnv(env, home), cwd: home };
}

/** The session's own variables: its bus, display and language. Never this runtime's secrets. */
const PASS = new Set(["HOME", "USER", "LOGNAME", "PATH", "LANG", "LANGUAGE", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "WAYLAND_DISPLAY", "DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "XDG_DATA_DIRS", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "GI_TYPELIB_PATH", "GST_PLUGIN_PATH", "GST_PLUGIN_SYSTEM_PATH"]);

export function helperEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined && (PASS.has(key) || key.startsWith("LC_"))) out[key] = value;
  // The helper's folder may be read-only where Ensemble is installed, and the person's own Python packages never shadow the system's.
  out.PYTHONDONTWRITEBYTECODE = "1";
  out.PYTHONNOUSERSITE = "1";
  return out;
}

/** The agent screen's size (`ENSEMBLE_AGENT_SCREEN_SIZE`, default 1600x1000). */
export function agentScreenSize(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.ENSEMBLE_AGENT_SCREEN_SIZE?.trim();
  return value && /^\d{3,4}x\d{3,4}$/.test(value) ? value : "1600x1000";
}

/** How long the agent screen stays up without a call (`ENSEMBLE_AGENT_SCREEN_IDLE_MINUTES`, default 10). */
export function agentScreenIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.ENSEMBLE_AGENT_SCREEN_IDLE_MINUTES ?? "");
  return Number.isFinite(minutes) && minutes > 0 ? Math.min(24 * 60, minutes) * 60_000 : 10 * 60_000;
}

export function helperCommand(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, screen: "owner" | "agent" = "owner"): HelperCommand | { unavailable: string } {
  if (platform === "darwin") return screen === "agent" ? { unavailable: NO_AGENT_SCREEN_MAC } : cuaDriverCommand(env);
  if (platform === "win32") return { unavailable: WINDOWS_UNSUPPORTED };
  if (platform !== "linux") return { unavailable: UNSUPPORTED_HERE };
  const script = helperScript();
  if (!script) return { unavailable: "This Ensemble was installed without its desktop helper. Install it again, or update." };
  const python = findPython3(env);
  if (!python) return { unavailable: "Desktop control needs python3 with its GObject bindings. On Ubuntu or Debian: sudo apt install python3-gi gir1.2-atspi-2.0 gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-good" };
  const state = screen === "agent" ? join(desktopDataDir(env), "agent-screen") : desktopDataDir(env);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const args = screen === "agent" ? [script, "--state-dir", state, "--agent-screen", agentScreenSize(env)] : [script, "--state-dir", state];
  return { command: python, args, env: helperEnv(env), cwd: state };
}

let shared: Desktops | null = null;
let settings: { log?: (message: string) => void; secretValues?: () => Promise<readonly string[]> } = {};

/** The runtime's logger and the owner's saved secret values (for the floor). Takes effect when the services are next created. */
export function configureDesktop(options: typeof settings): void {
  settings = { ...settings, ...options };
}

/** Both screens' services. */
export function desktops(): Desktops {
  if (shared) return shared;
  // Recordings a stopped runtime never saved: older than the longest recording and its time to be saved.
  void sweepRecordingParts(evidenceRoot(), 600_000 + RECORDING_SAVE_MS + 5 * 60_000)
    .then((removed) => {
      if (removed) settings.log?.(`desktop: removed ${removed} unsaved recording(s) a stopped runtime left`);
    })
    .catch(() => undefined);
  const mac = process.platform === "darwin";
  const helper: HelperLike = mac
    ? new MacosCuaDriver({ spawn: () => helperCommand(), version: cuaDriverPin().version, workDir: join(desktopDataDir(), "cua"), macosMajor: macosMajor(), log: settings.log })
    : new HelperProcess({ spawn: () => helperCommand(), log: settings.log });
  const owner = new DesktopService({ helper, captureDir: join(desktopDataDir(), "captures"), log: settings.log, secretValues: settings.secretValues, platform: mac ? "darwin" : "linux" });
  const idle = agentScreenIdleMs();
  shared = new Desktops(
    owner,
    () =>
      new DesktopService({
        screen: "agent",
        // The helper answers once its screen is up; it ends the screen and the apps on it before it exits.
        helper: new HelperProcess({ spawn: () => helperCommand(process.env, process.platform, "agent"), log: settings.log, helloTimeoutMs: 40_000, stopGraceMs: 15_000, unavailableRetryMs: 3 * 60_000 }),
        captureDir: join(desktopDataDir(), "captures"),
        log: settings.log,
        secretValues: settings.secretValues,
        // The agent screen is its helper: it ends as a whole when idle.
        helperIdleMs: idle,
        sessionIdleMs: idle,
      }),
    // macOS has no agent screen: work goes to the owner's unless a call names the agent screen.
    mac ? "owner" : "agent",
  );
  return shared;
}

/** The owner's screen's service (capture's `desktop` target, readiness). */
export function desktopService(): DesktopService {
  return desktops().owner;
}

/** The services if this runtime made them, else null: for ending work without starting anything. */
export function runningDesktop(): Desktops | null {
  return shared;
}

/** Ends screen control, the agent screen and the helpers (the runtime stops, or remote work ends). */
export async function stopDesktop(): Promise<void> {
  const both = shared;
  shared = null;
  await both?.stop();
}
