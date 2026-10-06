import { delimiter, win32, posix } from "node:path";

export type CliPlatform = NodeJS.Platform | "linux" | "darwin" | "win32";

export type PlatformInput = {
  platform?: CliPlatform;
  env?: NodeJS.ProcessEnv;
  home?: string;
};

export function platformOf(input: PlatformInput = {}): CliPlatform {
  return input.platform ?? process.platform;
}

export function envOf(input: PlatformInput = {}): NodeJS.ProcessEnv {
  return input.env ?? process.env;
}

export function homeOf(input: PlatformInput = {}): string {
  return input.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
}

export function pathApi(platform: string = process.platform): typeof win32 | typeof posix {
  return platform === "win32" ? win32 : posix;
}

export function pathDelimiter(platform: string = process.platform): string {
  return platform === "win32" ? ";" : delimiter;
}

export function splitPathList(value: string | undefined, platform: string = process.platform): string[] {
  if (!value) return [];
  return value.split(pathDelimiter(platform)).filter(Boolean);
}
