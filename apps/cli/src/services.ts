import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pathApi } from "./platform.js";

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
  <string>com.ensemblework.cli.runner</string>
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
Description=Ensemble Runner

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
    "Ensemble Runner",
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

const LAUNCH_AGENT_LABEL = "com.ensemblework.cli.runner";

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
    const plist = path.join(input.home, "Library", "LaunchAgents", "com.ensemblework.cli.runner.plist");
    await mkdir(dirname(plist), { recursive: true });
    await writeFile(plist, launchAgentPlist({ launcher: input.launcher, logPath: input.logPath }));
    // bootstrap fails while an older copy of the job is loaded.
    await tryQuietly(exec, "launchctl", ["bootout", `${launchdDomain()}/${LAUNCH_AGENT_LABEL}`]);
    await exec("launchctl", ["bootstrap", launchdDomain(), plist]);
    return `Installed LaunchAgent at ${plist}`;
  }
  if (platform === "linux") {
    const unit = path.join(input.home, ".config", "systemd", "user", "ensemble-runner.service");
    await mkdir(dirname(unit), { recursive: true });
    await writeFile(unit, systemdUserUnit({ launcher: input.launcher, logPath: input.logPath }));
    await exec("systemctl", ["--user", "daemon-reload"]);
    await exec("systemctl", ["--user", "enable", "ensemble-runner.service"]);
    await exec("systemctl", ["--user", "restart", "ensemble-runner.service"]);
    return `Installed systemd user unit at ${unit}. If it should run before login, run: loginctl enable-linger ${process.env.USER ?? "$USER"}`;
  }
  if (platform === "win32") {
    await exec("schtasks.exe", windowsTaskCreateCommand(input.launcher));
    await tryQuietly(exec, "schtasks.exe", ["/End", "/TN", "Ensemble Runner"]);
    await exec("schtasks.exe", ["/Run", "/TN", "Ensemble Runner"]);
    return "Installed Windows scheduled task \"Ensemble Runner\"";
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
    const plist = path.join(input.home, "Library", "LaunchAgents", "com.ensemblework.cli.runner.plist");
    await tryQuietly(exec, "launchctl", ["bootout", `${launchdDomain()}/${LAUNCH_AGENT_LABEL}`]);
    await rm(plist, { force: true });
    return `Removed LaunchAgent at ${plist}`;
  }
  if (platform === "linux") {
    await tryQuietly(exec, "systemctl", ["--user", "disable", "--now", "ensemble-runner.service"]);
    const unit = path.join(input.home, ".config", "systemd", "user", "ensemble-runner.service");
    await rm(unit, { force: true });
    await tryQuietly(exec, "systemctl", ["--user", "daemon-reload"]);
    return `Removed systemd user unit at ${unit}`;
  }
  if (platform === "win32") {
    await tryQuietly(exec, "schtasks.exe", ["/End", "/TN", "Ensemble Runner"]);
    const removed = await tryQuietly(exec, "schtasks.exe", ["/Delete", "/TN", "Ensemble Runner", "/F"]);
    return removed ? "Removed Windows scheduled task \"Ensemble Runner\"" : "No Windows scheduled task \"Ensemble Runner\" was installed.";
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
