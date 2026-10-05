/**
 * Start a command from a desktop script.
 *
 * On Windows, `pnpm` is `pnpm.cmd`. CreateProcess does not apply PATHEXT, and
 * since CVE-2024-27980 Node refuses to spawn `.cmd` / `.bat` unless the
 * command goes through `cmd.exe` (`shell: true`). A direct spawn returns EINVAL.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat"];

export function resolveCommand(command, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || WINDOWS_EXTENSIONS.some((ext) => command.toLowerCase().endsWith(ext))) {
    return command;
  }
  const pathApi = path.win32;
  const exists = options.exists ?? existsSync;
  const dirs = (options.path ?? process.env.PATH ?? "").split(";");
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of WINDOWS_EXTENSIONS) {
      const candidate = pathApi.join(dir, command + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return `${command}.cmd`;
}

/** One argv element for cmd.exe. Quotes, percents, and a trailing backslash are escaped. */
export function quoteForCmd(value) {
  let text = String(value).replace(/%/g, "%%");
  text = text.replace(/(\\*)"/g, (_, slashes) => `${slashes}${slashes}""`);
  text = text.replace(/(\\+)$/, (slashes) => slashes + slashes);
  return `"${text}"`;
}

/** The command line `cmd /d /s /c` runs after it strips one pair of outer quotes. */
export function windowsCommandLine(program, args) {
  return [program, ...args].map(quoteForCmd).join(" ");
}

export function run(command, args = [], options = {}) {
  const program = resolveCommand(command);
  const batch = process.platform === "win32" && /\.(cmd|bat)$/i.test(program);
  const { shell: _shell, ...spawnOptions } = options;
  const result = batch ? spawnBatch(program, args, spawnOptions) : spawnSync(program, args, {
    stdio: "inherit",
    windowsHide: true,
    ...spawnOptions,
  });
  if (result.error) {
    console.error(`Could not start ${program}: ${result.error.message}`);
  } else if (result.status == null) {
    const signal = result.signal ? ` (signal ${result.signal})` : "";
    console.error(`${program} ended without an exit code${signal}.`);
  }
  writeCaptured(result.stdout, process.stdout);
  writeCaptured(result.stderr, process.stderr);
  return result.status ?? 1;
}

function spawnBatch(program, args, options) {
  // Node's shell:true path is `cmd.exe /d /s /c "<line>"`. /s strips the outer
  // quotes, so each argument is quoted inside that line (paths with spaces stay one argument).
  const line = windowsCommandLine(program, args);
  return spawnSync(line, {
    stdio: "inherit",
    windowsHide: true,
    ...options,
    shell: true,
  });
}

function writeCaptured(chunk, stream) {
  if (chunk == null || chunk.length === 0) return;
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}
