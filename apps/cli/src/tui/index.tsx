/**
 * `ensemble` with no arguments: make sure this computer's Ensemble is running (start it in the
 * background if not; it keeps running tasks after you leave), then open the app full-screen.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { render } from "ink";
import { connectedHooks, connectHook, type HookTool } from "../approvals.js";
import { loadConfig } from "../config.js";
import { commandWithSubcommand, resolveLauncherCommand } from "../launcher.js";
import { signIn, signOut } from "../login.js";
import { resolveCliPaths } from "../paths.js";
import { installRunnerService, uninstallRunnerService } from "../services.js";
import { DesktopOwnsRuntimeError, resolveSidecarDir, runningRunner, sidecarAvailable, startRunner, stopRunner } from "../sidecar.js";
import { VERSION } from "../version.js";
import { App, type Ops } from "./app.js";
import { LocalApi } from "./local.js";
import { MOUSE_OFF, MOUSE_ON } from "./mouse.js";
import { loadPrefs, savePrefs } from "./prefs.js";
import { RENDER_OPTIONS, takeScreen } from "./screen.js";

export async function runApp(): Promise<void> {
  const paths = resolveCliPaths();
  const sidecarDir = resolveSidecarDir(import.meta.url);
  if (!(await sidecarAvailable(sidecarDir))) {
    console.log("This install of Ensemble only connects editors (MCP), so the app cannot run here.");
    console.log("Install the full CLI to run tasks and use the app: https://ensemblework.com/download");
    return;
  }
  let discovery = await runningRunner(paths);
  if (!discovery) {
    process.stdout.write("Starting Ensemble on this computer… ");
    await mkdir(paths.logsDir, { recursive: true });
    const session = await startRunner({ sidecarDir, paths });
    discovery = session?.discovery ?? (await runningRunner(paths));
    if (!discovery) throw new Error(`Ensemble did not start. See ${paths.runnerLog}`);
    process.stdout.write("ready.\n");
  }
  const config = await loadConfig(paths);
  const prefs = await loadPrefs(paths);
  const api = new LocalApi(discovery);
  const runner = discovery;

  const ops: Ops = {
    signIn: (onCode, signal) => signIn({ onCode, signal, paths }).then((result) => ({ email: result.email, paired: result.paired })),
    signOut: () => signOut(paths),
    savePrefs: (next) => void savePrefs(next, paths).catch(() => undefined),
    connectHook: (tool, remove) => connectHook(runner, tool as HookTool, remove).then((result) => result.message),
    connectedHooks: () => connectedHooks(runner),
    async runnerService(install) {
      if (!install) {
        const message = await uninstallRunnerService({ home: homedir() });
        return `${message} Ensemble keeps running until you restart; it no longer starts at login.`;
      }
      const launcher = commandWithSubcommand(resolveLauncherCommand({ argv1: process.argv[1], sidecarAvailable: true }), "runner").command;
      await mkdir(paths.logsDir, { recursive: true });
      try {
        await stopRunner(paths);
      } catch (error) {
        if (!(error instanceof DesktopOwnsRuntimeError)) throw error;
      }
      return installRunnerService({ home: homedir(), launcher, logPath: paths.runnerLog });
    },
  };

  const giveBack = takeScreen(process.stdout);
  process.stdout.write(MOUSE_ON);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdout.write(MOUSE_OFF);
    giveBack();
  };
  process.once("exit", restore);
  try {
    const app = render(
      <App
        api={api}
        folder={process.cwd()}
        version={VERSION}
        account={{ email: config.account?.email ?? null, paired: Boolean(config.pairedAt), apiBase: config.apiBase }}
        prefs={prefs}
        ops={ops}
      />,
      RENDER_OPTIONS,
    );
    await app.waitUntilExit();
  } finally {
    restore();
    process.removeListener("exit", restore);
  }
  console.log("Ensemble keeps running tasks on this computer in the background. Run `ensemble` to come back.");
}
