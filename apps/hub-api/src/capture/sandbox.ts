/**
 * Apps started for capture run in this computer's OS sandbox (docs/25 §10.2), confined as an agent's
 * commands are (`prepareSpawn`): their folder and the cache writable, the agent's environment (no
 * credentials, the cache's home), Ensemble's data, keys, sign-ins and the browser profiles denied. On
 * Linux the app gets back what its private display needs inside the sandbox: that display's X socket
 * (`/tmp/.X11-unix/X<n>`, under the sandbox's own /tmp) and the folder of its cookie (in
 * `$XDG_RUNTIME_DIR`, which the sandbox hides), never another display's.
 *
 * An Electron app keeps the computer's network: Playwright drives it over a local debugging port,
 * which a separate network namespace would hide. Inside the OS sandbox it runs without Chromium's own
 * sandbox, which cannot nest there.
 *
 * Not re-exported by capture/index.ts: it reads the runtime's configuration, which the capture CLI
 * script runs without.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";
import { askpassPath, blockedReason, cacheDir, childEnv, ENSEMBLE_SOURCE, holdsProtected } from "../workspace/guard.js";
import { isEnsembleData } from "../workspace/data-denies.js";
import { prepareSpawn } from "../workspace/sandbox/spawn.js";
import type { CommandWrapper } from "./apps.js";
import { LEASE_ENV } from "./leases.js";
import { CaptureError } from "./media.js";

/** What a program on a private display needs to find it (capture/apps.ts `virtualDisplayEnv`). */
const DISPLAY_KEYS = ["DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE", "GDK_BACKEND", "QT_QPA_PLATFORM", "SDL_VIDEODRIVER", "CLUTTER_BACKEND", "MOZ_ENABLE_WAYLAND", "ELECTRON_OZONE_PLATFORM_HINT", "NO_AT_BRIDGE", LEASE_ENV];

/** The X server's socket folder; tests point it elsewhere. */
export const X11_SOCKETS = "/tmp/.X11-unix";

/** The display number of `:n` or `:n.screen`, else null (a TCP display is never used here). */
export function displayNumber(display: string | undefined): string | null {
  const match = /^:(\d{1,5})(?:\.\d+)?$/.exec(display?.trim() ?? "");
  return match ? match[1]! : null;
}

export function captureAppWrapper(options: { socketDir?: string; platform?: NodeJS.Platform } = {}): CommandWrapper {
  const socketDir = options.socketDir ?? X11_SOCKETS;
  return async (input) => {
    const platform = options.platform ?? process.platform;
    const folder = await realpath(input.cwd).catch(() => null);
    if (!folder) throw new CaptureError("bad_input", `The folder ${input.cwd} does not exist.`);
    const blocked = blockedReason(folder);
    if (blocked || holdsProtected(folder) || isEnsembleData(folder)) {
      throw new CaptureError("refused", `An app is not started in ${input.cwd}: ${blocked ?? "it holds keys, sign-ins or Ensemble's own data."}`);
    }
    const cache = await cacheDir();
    const base = await childEnv(folder, { useCredentials: false, who: "agent" });
    const display: NodeJS.ProcessEnv = {};
    for (const key of DISPLAY_KEYS) if (typeof input.env[key] === "string") display[key] = input.env[key];
    const env: NodeJS.ProcessEnv = { ...base, ...(input.appEnv ?? {}), ...display };
    const readOnly: string[] = [];
    const sockets: Array<{ path: string; at: string }> = [];
    const number = displayNumber(display.DISPLAY);
    if (platform === "linux" && number !== null) {
      sockets.push({ path: join(socketDir, `X${number}`), at: join(X11_SOCKETS, `X${number}`) });
      if (display.XAUTHORITY) readOnly.push(dirname(display.XAUTHORITY));
    }
    const electron = input.kind === "electron";
    const home = homedir();
    const prepared = prepareSpawn(
      {
        runId: "capture-app",
        cwd: folder,
        readWrite: [folder, cache],
        readOnly,
        deny: [],
        network: electron || input.network ? "outbound" : "none",
        env,
        who: "agent",
        home,
        ensembleSource: ENSEMBLE_SOURCE,
        appDataDir: desktopDataDir({ platform, home }),
        askpassPath: await askpassPath(),
        confined: true,
        sockets,
      },
      { program: input.program, args: input.args },
    );
    // Chromium's own sandbox cannot nest inside the OS sandbox; the OS sandbox is the boundary here.
    const args = electron && prepared.sandboxed && platform === "linux" ? [...prepared.args, "--no-sandbox"] : prepared.args;
    return { program: prepared.command, args, env: prepared.env };
  };
}
