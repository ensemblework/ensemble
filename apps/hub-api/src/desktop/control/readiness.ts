/**
 * Whether desktop control can work on this computer, as cheaply as it can be told: for the
 * capabilities this computer reports (`capabilities.desktop`, the capture line's `desktop` target).
 * It never starts screen control or the agent screen: the libraries and the agent screen's GNOME Shell
 * are checked by the helper's `--check` (once in ten minutes), consent by whether a restore token is
 * kept, and the rest by the running helpers, if any.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP_API } from "../../remote/contract.js";
import { findPython3 } from "../../runtime/python-spawn.js";
import { desktopDataDir, helperEnv, helperScript, runningDesktop, UNSUPPORTED_HERE } from "./index.js";

export type AgentScreenReadiness = { ready: boolean; version: string | null; reason?: string };

export type DesktopReadiness = {
  /** Screen control of the owner's screen could start here (the owner may still be asked to allow it). */
  ready: boolean;
  session: "wayland" | "x11" | "none";
  /** The owner allowed screen control before and it is remembered (it starts without asking). */
  consent: "remembered" | "ask";
  recorder: "mp4" | "webm" | null;
  helper: string;
  reason?: string;
  /** The agent's own private screen: a headless GNOME Shell. */
  agentScreen: AgentScreenReadiness;
};

type AgentCheck = { gnome_shell: boolean; dbus_daemon: boolean; a11y_launcher: boolean; pipewire: boolean; headless: boolean; version: string | null };
type Check = { gi: boolean; atspi: boolean; gst: boolean; pipewiresrc: boolean; recorder: "mp4" | "webm" | null; agent_screen?: AgentCheck };

const LIBRARIES = "sudo apt install python3-gi gir1.2-atspi-2.0 gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-good";

/** Whether the agent screen can start, and the fix when it cannot. */
export function agentScreenReadiness(libs: Check | null): AgentScreenReadiness {
  if (!libs || !libs.gi || !libs.atspi || !libs.gst || !libs.pipewiresrc) return { ready: false, version: null, reason: `Needs python3 with its GObject bindings: ${LIBRARIES}` };
  const agent = libs.agent_screen;
  if (!agent) return { ready: false, version: null, reason: "Update Ensemble on this computer: its desktop helper cannot start an agent screen." };
  const version = agent.version ?? null;
  if (!agent.gnome_shell) return { ready: false, version, reason: "Needs GNOME Shell for the agent screen: sudo apt install gnome-shell" };
  if (!agent.headless) return { ready: false, version, reason: `${version ?? "This GNOME Shell"} cannot run headless with a virtual monitor and a Wayland display name of its own: its help lists no such options.` };
  if (!agent.dbus_daemon) return { ready: false, version, reason: "Needs dbus-daemon for the agent screen's own bus: sudo apt install dbus-daemon" };
  if (!agent.a11y_launcher) return { ready: false, version, reason: "Needs the AT-SPI bus launcher: sudo apt install at-spi2-core" };
  if (!agent.pipewire) return { ready: false, version, reason: "Needs PipeWire running for this user (systemctl --user start pipewire)." };
  return { ready: true, version };
}

let checked: { at: number; value: Check | null } | null = null;
const CHECK_MS = 10 * 60_000;

function runCheck(timeoutMs = 20_000): Promise<Check | null> {
  const script = helperScript();
  const python = findPython3();
  if (!script || !python) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(python, [script, "--check"], { env: helperEnv(), stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref?.();
    child.stdout!.on("data", (chunk: Buffer) => {
      if (out.length < 4_000) out += chunk.toString("utf8");
    });
    child.once("error", () => resolve(null));
    child.once("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.trim().split("\n").at(-1) ?? "") as Check);
      } catch {
        resolve(null);
      }
    });
  });
}

async function libraries(): Promise<Check | null> {
  if (checked && Date.now() - checked.at < CHECK_MS) return checked.value;
  const value = await runCheck();
  checked = { at: Date.now(), value };
  return value;
}

/** The desktop session this runtime lives in; a runtime started as a user service may lack its variables, so its sockets count too. */
export function sessionKind(env: NodeJS.ProcessEnv = process.env): DesktopReadiness["session"] {
  const kind = env.XDG_SESSION_TYPE?.trim().toLowerCase();
  if (kind === "wayland" || env.WAYLAND_DISPLAY) return "wayland";
  if (kind === "x11" || env.DISPLAY) return "x11";
  const runtime = env.XDG_RUNTIME_DIR?.trim() || (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "");
  if (runtime && existsSync(join(runtime, "wayland-0"))) return "wayland";
  if (existsSync("/tmp/.X11-unix/X0")) return "x11";
  return "none";
}

export async function desktopReadiness(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<DesktopReadiness> {
  const helper = runningDesktop() ? "running" : "stopped";
  if (platform !== "linux") return { ready: false, session: "none", consent: "ask", recorder: null, helper, reason: UNSUPPORTED_HERE, agentScreen: { ready: false, version: null, reason: UNSUPPORTED_HERE } };
  const session = sessionKind(env);
  const consent = existsSync(join(desktopDataDir(env), "portal-restore-token")) ? "remembered" : "ask";
  const libs = await libraries();
  const agentScreen = agentScreenReadiness(libs);
  if (!libs) return { ready: false, session, consent, recorder: null, helper, reason: `Needs python3 with its GObject bindings: ${LIBRARIES}`, agentScreen };
  if (!libs.gi || !libs.atspi || !libs.gst) return { ready: false, session, consent, recorder: null, helper, reason: "Needs AT-SPI and GStreamer for Python: sudo apt install python3-gi gir1.2-atspi-2.0 gir1.2-gstreamer-1.0", agentScreen };
  if (!libs.pipewiresrc) return { ready: false, session, consent, recorder: libs.recorder, helper, reason: "Needs GStreamer's PipeWire source: sudo apt install gstreamer1.0-pipewire", agentScreen };
  if (session === "none") return { ready: false, session, consent, recorder: libs.recorder, helper, reason: "Ensemble here does not run inside a desktop session.", agentScreen };
  return { ready: true, session, consent, recorder: libs.recorder, helper, agentScreen };
}

/** The capture line's `desktop` target: a screenshot or a video of the owner's screen. */
export async function desktopAvailability(): Promise<{ screenshot: boolean; video: boolean; reason?: string }> {
  const readiness = await desktopReadiness();
  if (!readiness.ready) return { screenshot: false, video: false, reason: readiness.reason };
  const consent = readiness.consent === "remembered" ? "Allowed before: starts without asking." : "Asks the owner at the computer the first time.";
  return { screenshot: true, video: Boolean(readiness.recorder), reason: `Your screen, through the desktop portal (${readiness.session}). ${consent}${readiness.recorder ? "" : " No video encoder works here."}` };
}

let lastKnown: DesktopReadiness | null = null;

/** `capabilities.desktop` and `capabilities.desktopReadiness`, for this computer's heartbeat; nothing off Linux. */
export async function desktopCapabilities(timeoutMs = 5_000): Promise<Record<string, unknown>> {
  if (process.platform !== "linux") return {};
  const check = desktopReadiness().then((value) => (lastKnown = value)).catch(() => lastKnown);
  const readiness = await Promise.race([check, new Promise<DesktopReadiness | null>((resolve) => setTimeout(() => resolve(lastKnown), timeoutMs).unref())]);
  return {
    desktop: DESKTOP_API,
    desktopReadiness: readiness
      ? {
          ready: readiness.ready,
          session: readiness.session,
          consent: readiness.consent,
          recorder: readiness.recorder,
          ...(readiness.reason ? { reason: readiness.reason.slice(0, 300) } : {}),
          agentScreen: { ready: readiness.agentScreen.ready, version: readiness.agentScreen.version, ...(readiness.agentScreen.reason ? { reason: readiness.agentScreen.reason.slice(0, 300) } : {}) },
        }
      : null,
  };
}
