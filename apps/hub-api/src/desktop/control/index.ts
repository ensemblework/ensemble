/**
 * This computer's desktop control (docs/25 §11): one `DesktopService` per runtime, started on first
 * use, with the Linux helper as its child process. The helper gets the desktop session's variables
 * (its bus, its display) and nothing else of this runtime's environment. Other systems answer that
 * desktop control is not there yet.
 */
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensembleDataHome } from "../../browser/paths.js";
import { findPython3 } from "../../runtime/python-spawn.js";
import { HelperProcess, type HelperCommand } from "./helper-process.js";
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

export function helperCommand(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): HelperCommand | { unavailable: string } {
  if (platform !== "linux") return { unavailable: UNSUPPORTED_HERE };
  const script = helperScript();
  if (!script) return { unavailable: "This Ensemble was installed without its desktop helper. Install it again, or update." };
  const python = findPython3(env);
  if (!python) return { unavailable: "Desktop control needs python3 with its GObject bindings. On Ubuntu or Debian: sudo apt install python3-gi gir1.2-atspi-2.0 gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-good" };
  const state = desktopDataDir(env);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  return { command: python, args: [script, "--state-dir", state], env: helperEnv(env), cwd: state };
}

let shared: DesktopService | null = null;
let settings: { log?: (message: string) => void; secretValues?: () => Promise<readonly string[]> } = {};

/** The runtime's logger and the owner's saved secret values (for the floor). Takes effect when the service is next created. */
export function configureDesktop(options: typeof settings): void {
  settings = { ...settings, ...options };
}

export function desktopService(): DesktopService {
  if (shared) return shared;
  const helper = new HelperProcess({ spawn: () => helperCommand(), log: settings.log });
  shared = new DesktopService({ helper, captureDir: join(desktopDataDir(), "captures"), log: settings.log, secretValues: settings.secretValues });
  return shared;
}

/** The service if this runtime started it, else null: for ending work without starting it. */
export function runningDesktop(): DesktopService | null {
  return shared;
}

/** Ends screen control and the helper (the runtime stops, or remote work ends). */
export async function stopDesktop(): Promise<void> {
  const service = shared;
  shared = null;
  await service?.stop();
}
