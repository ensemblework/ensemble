import { spawn } from "node:child_process";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The OS opener also runs files and custom URL schemes, and the URL comes from
 * the server named by `--api`. Only https, or http on this computer for local
 * development, is handed over.
 */
export function safeBrowserUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.href;
  return null;
}

export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  // `cmd /c start` re-parses & and ^ inside the URL; the URL handler takes it as one argument.
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] };
}

export function openBrowser(raw: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.ENSEMBLE_NO_BROWSER === "1") return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const url = safeBrowserUrl(raw);
  if (!url) return false;
  const { command, args } = browserCommand(url, platform);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
