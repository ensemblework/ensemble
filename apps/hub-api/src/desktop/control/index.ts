/**
 * This computer's desktop control (docs/25 §11): a `DesktopService` for the owner's screen and one for
 * the agent screen (`Desktops`, screens.ts), each started on first use with the Linux helper as its child
 * process. The helper gets the desktop session's variables (its bus, its display) and nothing else of
 * this runtime's environment; the agent screen's helper starts a private headless GNOME Shell and ends it
 * after `ENSEMBLE_AGENT_SCREEN_IDLE_MINUTES` (default 10) without a call. Other systems answer that
 * desktop control is not there.
 */
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensembleDataHome } from "../../browser/paths.js";
import { findPython3 } from "../../runtime/python-spawn.js";
import { HelperProcess, type HelperCommand } from "./helper-process.js";
import { Desktops } from "./screens.js";
import { DesktopService } from "./service.js";

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

export const UNSUPPORTED_HERE = "Desktop control works on Linux, on desktops with the desktop portal (GNOME, KDE and others).";

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
  const owner = new DesktopService({ helper: new HelperProcess({ spawn: () => helperCommand(), log: settings.log }), captureDir: join(desktopDataDir(), "captures"), log: settings.log, secretValues: settings.secretValues });
  const idle = agentScreenIdleMs();
  shared = new Desktops(owner, () =>
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
