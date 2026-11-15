import { spawn } from "node:child_process";
import { access, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pathApi } from "./platform.js";
import { COMMAND, TESTING } from "./channel.js";

const LAUNCH_AGENT_LABEL = TESTING ? "com.ensemblework.cli.testing.runner" : "com.ensemblework.cli.runner";
const SYSTEMD_UNIT = TESTING ? "ensemble-test-runner.service" : "ensemble-runner.service";
const WINDOWS_TASK = TESTING ? "Ensemble Testing Runner" : "Ensemble Runner";

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function launchAgentPlist(input: { launcher: string; logPath: string }): string {
  const args = [input.launcher, "runner", "start", "--foreground"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.logPath)}</string>
</dict>
</plist>
`;
}

export function systemdUserUnit(input: { launcher: string; logPath: string }): string {
  return `[Unit]
Description=${WINDOWS_TASK}

[Service]
Type=simple
ExecStart=${systemdQuote(input.launcher)} runner start --foreground
Restart=on-failure
StandardOutput=append:${input.logPath}
StandardError=append:${input.logPath}

[Install]
WantedBy=default.target
`;
}

function systemdQuote(value: string): string {
  return value.includes(" ") ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : value;
}

export function windowsTaskCreateCommand(launcher: string): string[] {
  return [
    "/Create",
    "/TN",
    WINDOWS_TASK,
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/F",
    "/TR",
    `"${launcher}" runner start --foreground`,
  ];
}

export type ExecFile = (command: string, args: string[], options?: { quiet?: boolean }) => Promise<void>;


/** For steps that fail when there is nothing to undo, such as booting out a job that is not loaded. */
async function tryQuietly(exec: ExecFile, command: string, args: string[]): Promise<boolean> {
  try {
    await exec(command, args, { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function launchdDomain(): string {
  return `gui/${typeof process.getuid === "function" ? process.getuid() : ""}`;
}

export async function installRunnerService(input: {
  platform?: NodeJS.Platform;
  home: string;
  launcher: string;
  logPath: string;
  execFile?: ExecFile;
}): Promise<string> {
  const platform = input.platform ?? process.platform;
  const path = pathApi(platform);
  const exec = input.execFile ?? execFilePromise;
  if (platform === "darwin") {
    const plist = path.join(input.home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
    await mkdir(dirname(plist), { recursive: true });
    await writeFile(plist, launchAgentPlist({ launcher: input.launcher, logPath: input.logPath }));
    // bootstrap fails while an older copy of the job is loaded.
    await tryQuietly(exec, "launchctl", ["bootout", `${launchdDomain()}/${LAUNCH_AGENT_LABEL}`]);
    await exec("launchctl", ["bootstrap", launchdDomain(), plist]);
    return `Installed LaunchAgent at ${plist}`;
  }
  if (platform === "linux") {
    const unit = path.join(input.home, ".config", "systemd", "user", SYSTEMD_UNIT);
    await mkdir(dirname(unit), { recursive: true });
    await writeFile(unit, systemdUserUnit({ launcher: input.launcher, logPath: input.logPath }));
    await exec("systemctl", ["--user", "daemon-reload"]);
    await exec("systemctl", ["--user", "enable", SYSTEMD_UNIT]);
    await exec("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
    return `Installed systemd user unit at ${unit}. If it should run before login, run: loginctl enable-linger ${process.env.USER ?? "$USER"}`;
  }
  if (platform === "win32") {
    await exec("schtasks.exe", windowsTaskCreateCommand(input.launcher));
    await tryQuietly(exec, "schtasks.exe", ["/End", "/TN", WINDOWS_TASK]);
    await exec("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK]);
    return `Installed Windows scheduled task "${WINDOWS_TASK}"`;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * The login service `ensemble runner install` set up on this computer, by the name its service manager
 * knows it by, or null when there is none.
 */
export async function installedRunnerService(input: { platform?: NodeJS.Platform; home: string; execFile?: ExecFile }): Promise<string | null> {
  const platform = input.platform ?? process.platform;
  const path = pathApi(platform);
  const exists = (file: string) => access(file).then(() => true, () => false);
  if (platform === "darwin") return (await exists(path.join(input.home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`))) ? LAUNCH_AGENT_LABEL : null;
  if (platform === "linux") return (await exists(path.join(input.home, ".config", "systemd", "user", SYSTEMD_UNIT))) ? SYSTEMD_UNIT : null;
  if (platform === "win32") return (await tryQuietly(input.execFile ?? execFilePromise, "schtasks.exe", ["/Query", "/TN", WINDOWS_TASK])) ? WINDOWS_TASK : null;
  return null;
}

/**
 * Starts the installed login service when it is not running; one that runs is left as it is. The runtime
 * it starts is the computer's only one, so a launcher never starts a second one beside it.
 */
export async function startRunnerService(input: { platform?: NodeJS.Platform; home: string; execFile?: ExecFile }): Promise<void> {
  const platform = input.platform ?? process.platform;
  const exec = input.execFile ?? execFilePromise;
  const failed = (error: unknown) => new Error(`The Ensemble login service is installed but did not start (${error instanceof Error ? error.message : String(error)}). Run \`${COMMAND} runner install\` to set it up again, or \`${COMMAND} runner uninstall\` to stop using it.`);
  if (platform === "darwin") {
    if (await tryQuietly(exec, "launchctl", ["kickstart", `${launchdDomain()}/${LAUNCH_AGENT_LABEL}`])) return;
    // Not loaded (booted out by hand, or since this login): loading it starts it (RunAtLoad).
    const plist = pathApi(platform).join(input.home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
    await exec("launchctl", ["bootstrap", launchdDomain(), plist], { quiet: true }).catch((error: unknown) => Promise.reject(failed(error)));
    return;
  }
  if (platform === "linux") {
    await exec("systemctl", ["--user", "start", SYSTEMD_UNIT], { quiet: true }).catch((error: unknown) => Promise.reject(failed(error)));
    return;
  }
  if (platform === "win32") {
    await exec("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK], { quiet: true }).catch((error: unknown) => Promise.reject(failed(error)));
    return;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

export async function uninstallRunnerService(input: {
  platform?: NodeJS.Platform;
  home: string;
  execFile?: ExecFile;
}): Promise<string> {
  const platform = input.platform ?? process.platform;
  const path = pathApi(platform);
  const exec = input.execFile ?? execFilePromise;
  if (platform === "darwin") {
    const plist = path.join(input.home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
    await tryQuietly(exec, "launchctl", ["bootout", `${launchdDomain()}/${LAUNCH_AGENT_LABEL}`]);
    await rm(plist, { force: true });
    return `Removed LaunchAgent at ${plist}`;
  }
  if (platform === "linux") {
    await tryQuietly(exec, "systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    const unit = path.join(input.home, ".config", "systemd", "user", SYSTEMD_UNIT);
    await rm(unit, { force: true });
    await tryQuietly(exec, "systemctl", ["--user", "daemon-reload"]);
    return `Removed systemd user unit at ${unit}`;
  }
  if (platform === "win32") {
    await tryQuietly(exec, "schtasks.exe", ["/End", "/TN", WINDOWS_TASK]);
    const removed = await tryQuietly(exec, "schtasks.exe", ["/Delete", "/TN", WINDOWS_TASK, "/F"]);
    return removed ? `Removed Windows scheduled task "${WINDOWS_TASK}"` : `No Windows scheduled task "${WINDOWS_TASK}" was installed.`;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

function execFilePromise(command: string, args: string[], options: { quiet?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.quiet ? "ignore" : "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? "without a code"}`));
    });
  });
}
