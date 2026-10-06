import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathApi, splitPathList } from "./platform.js";

export type LauncherCommand = {
  command: string;
  argsPrefix: string[];
  source: "env" | "argv" | "npm" | "npx";
};

export function mapStableLauncherPath(inputPath: string, platform: string = process.platform): string {
  const path = pathApi(platform);
  let value = inputPath;
  const normalized = platform === "win32" ? value.replaceAll("/", "\\") : value.replaceAll("\\", "/");
  if (platform !== "win32") {
    const match = /^(.*)\/Cellar\/ensemble\/[^/]+\/libexec\/bin\/ensemble$/.exec(normalized);
    if (match) return path.join(match[1] || path.sep, "bin", "ensemble");
  } else {
    const scoop = /^(.*\\apps\\ensemble\\)[^\\]+(\\.*)$/.exec(normalized);
    if (scoop) return `${scoop[1]}current${scoop[2]}`;
  }
  return value;
}

export function isExecutableOnPath(command: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  const path = pathApi(platform);
  const names = platform === "win32" && !/\.(?:exe|cmd|bat)$/i.test(command) ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command] : [command];
  for (const dir of splitPathList(env.PATH, platform)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return null;
}

export function resolveLauncherCommand(input: {
  argv1?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  cwd?: string;
  sidecarAvailable?: boolean;
} = {}): LauncherCommand {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const path = pathApi(platform);
  const selected = env.ENSEMBLE_LAUNCHER?.trim() || input.argv1 || process.argv[1] || "ensemble";
  const absolute = path.isAbsolute(selected) ? selected : resolve(input.cwd ?? process.cwd(), selected);
  const stable = mapStableLauncherPath(absolute, platform);
  const isNpm = /(?:^|[\\/])node_modules[\\/]/.test(stable);
  if (isNpm && !input.sidecarAvailable) {
    const global = isExecutableOnPath("ensemble", env, platform);
    if (global) return { command: global, argsPrefix: [], source: "npm" };
    return { command: platform === "win32" ? "npx.cmd" : "npx", argsPrefix: ["-y", "ensemblework"], source: "npx" };
  }
  return { command: stable, argsPrefix: [], source: env.ENSEMBLE_LAUNCHER ? "env" : "argv" };
}

export function commandWithSubcommand(launcher: LauncherCommand, subcommand: string): { command: string; args: string[] } {
  return { command: launcher.command, args: [...launcher.argsPrefix, subcommand] };
}

export function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function bundleInstallRoot(bundlePath: string): string {
  return dirname(dirname(bundlePath));
}
