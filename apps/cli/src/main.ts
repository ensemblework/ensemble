import type { ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { normalizeApiBase, loadConfig, saveConfig, loadToken, saveToken, clearToken } from "./config.js";
import { bearerHeaders, fetchJson, HttpError } from "./http.js";
import { resolveLauncherCommand } from "./launcher.js";
import { detectInstallMethod, dailyUpdateNotice, upgradeInstruction } from "./update.js";
import { VERSION } from "./version.js";
import { pollDeviceToken, startDeviceFlow } from "./auth-flow.js";
import { resolveCliPaths, readJsonFile } from "./paths.js";
import { openBrowser } from "./browser.js";
import type { CliPaths } from "./paths.js";
import {
  clearRunnerPidIf,
  defaultSidecarDir,
  readRunnerPid,
  resolveSidecarDir,
  runningRunner,
  sidecarAvailable,
  sidecarErrorMessage,
  startRunner,
  stopRunner,
  tailLog,
  withLocalApi,
  localJson,
} from "./sidecar.js";
import { addFolder, listFolders, listKeys, removeFolder, removeKey, remoteStatus, setKey, withAdminApi } from "./local-commands.js";
import { chooseEditors, configuredEditors, detectEditors, parseEditorNames, removeEditor, setupEditor } from "./editors.js";
import { commandWithSubcommand, isExecutableOnPath } from "./launcher.js";
import { installRunnerService, uninstallRunnerService } from "./services.js";
import { runMcp } from "./mcp.js";

type ArgsOptions = NonNullable<ParseArgsConfig["options"]>;
type ParsedArgs = {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
};

const HELP = `Ensemble CLI ${VERSION}

Usage:
  ensemble login [--api URL] [--name NAME] [--mcp-only] [--no-browser]
  ensemble logout
  ensemble status [--json]
  ensemble mcp
  ensemble mcp setup [editor...] [--all] [--print] [--hosted]
  ensemble mcp remove <editor>
  ensemble mcp editors
  ensemble runner [start] [--foreground] | stop | restart | status | logs [-f] | install | uninstall
  ensemble folders [list] | add <path> [--label L] [--read-only] | remove <label>
  ensemble keys [list] | set <provider> | remove <provider>
  ensemble doctor
  ensemble update
  ensemble version | --version | --help`;

const HELP_BY_COMMAND: Record<string, string> = {
  login: "Usage: ensemble login [--api URL] [--name NAME] [--mcp-only] [--no-browser]",
  logout: "Usage: ensemble logout",
  status: "Usage: ensemble status [--json]",
  mcp: "Usage: ensemble mcp | ensemble mcp setup [editor...] [--all] [--print] [--hosted] | ensemble mcp remove <editor> | ensemble mcp editors",
  runner: "Usage: ensemble runner [start] [--foreground] | stop | restart | status | logs [-f] | install | uninstall",
  folders: "Usage: ensemble folders [list] | add <path> [--label L] [--read-only] | remove <label>",
  keys: "Usage: ensemble keys [list] | set <provider> | remove <provider>",
  doctor: "Usage: ensemble doctor",
  update: "Usage: ensemble update",
};

function parsed(args: string[], options: ArgsOptions = {}, allowPositionals = true): ParsedArgs {
  const result = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      ...options,
    },
    allowPositionals,
    strict: true,
  });
  return {
    values: result.values as Record<string, string | boolean | undefined>,
    positionals: result.positionals,
  };
}

function requirePositionals(values: string[], usage: string, count = 1): void {
  if (values.length < count) throw new Error(usage);
}

function stringOption(values: ParsedArgs["values"], key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

async function maybeUpdateNotice(command: string | undefined): Promise<void> {
  // mcp talks to an editor over stdio and runner may be a login service; neither has a person reading stderr.
  if (!command || command === "mcp" || command === "runner" || !process.stderr.isTTY) return;
  try {
    const notice = await dailyUpdateNotice({ paths: resolveCliPaths() });
    if (notice) console.error(notice);
  } catch {
    // A failed update check must never break the requested command.
  }
}

async function commandLogin(args: string[]): Promise<void> {
  const result = parsed(args, {
    api: { type: "string" },
    name: { type: "string" },
    "mcp-only": { type: "boolean" },
    "no-browser": { type: "boolean" },
  });
  if (result.values.help) return void console.log(HELP_BY_COMMAND.login);
  const paths = resolveCliPaths();
  const apiBase = normalizeApiBase(stringOption(result.values, "api") || process.env.ENSEMBLE_API_URL);
  const sidecarDir = resolveSidecarDir(import.meta.url);
  const hasSidecar = await sidecarAvailable(sidecarDir);
  const name = stringOption(result.values, "name") || hostname() || "this computer";
  const scopes = result.values["mcp-only"] ? ["mcp"] : hasSidecar ? ["mcp", "runner"] : ["mcp"];
  const start = await startDeviceFlow({ apiBase, clientName: name, platform: process.platform, scopes });
  console.log(`Code: ${start.userCode}`);
  console.log(`Open: ${start.verificationUriComplete || start.verificationUri}`);
  if (!result.values["no-browser"]) {
    const opened = openBrowser(start.verificationUriComplete || start.verificationUri);
    if (!opened) console.error("Open the URL above in your browser to continue.");
  }
  const token = await pollDeviceToken({ apiBase, deviceCode: start.deviceCode, interval: start.interval, expiresIn: start.expiresIn });
  const finalApi = normalizeApiBase(token.apiBase || apiBase);
  await saveToken(token.token, paths);
  await saveConfig(
    {
      apiBase: finalApi,
      appUrl: token.appUrl?.replace(/\/+$/, "") || "https://ensemblework.com",
      account: token.account ?? null,
      tokenId: token.tokenId ?? null,
      deviceName: name,
      pairedAt: null,
    },
    paths,
  );
  if (token.pairingCode && hasSidecar && !result.values["mcp-only"]) {
    await withLocalApi({
      sidecarDir,
      paths,
      apiBase: finalApi,
      adminOnly: true,
      run: async (discovery) => {
        await localJson(discovery, "/api/remote/pair", {
          method: "POST",
          body: JSON.stringify({ apiBase: finalApi, code: token.pairingCode, name }),
        });
        await localJson(discovery, "/api/remote", { method: "PUT", body: JSON.stringify({ enabled: true }) });
      },
    });
    const config = await loadConfig(paths);
    await saveConfig({ ...config, pairedAt: new Date().toISOString() }, paths);
  }
  const paired = Boolean((await loadConfig(paths)).pairedAt);
  console.log(`Logged in${token.account?.email ? ` as ${token.account.email}` : ""}.`);
  if (paired) {
    console.log(`This computer is paired as "${name}". Tasks you assign to it from Ensemble run here.`);
    console.log("");
    console.log("Next:");
    console.log("  ensemble folders add <path>    share a folder the agent may work in");
    console.log("  ensemble keys set <provider>   save a model key on this computer (google, openai, anthropic, …)");
    console.log("  ensemble runner install        start the runner now and at every login");
    console.log("  ensemble mcp setup             connect your editors");
  } else {
    if (token.pairingCode && !hasSidecar) console.log("This install has no runner. Install the full CLI to run tasks on this computer: https://ensemblework.com/download");
    console.log("");
    console.log("Next: ensemble mcp setup    connect your editors");
  }
}

async function commandLogout(args: string[]): Promise<void> {
  const result = parsed(args);
  if (result.values.help) return void console.log(HELP_BY_COMMAND.logout);
  const paths = resolveCliPaths();
  const config = await loadConfig(paths);
  const token = await loadToken(paths);
  if (token) {
    try {
      await fetchJson(`${config.apiBase}/api/cli/logout`, { method: "POST", headers: bearerHeaders(token) });
    } catch (error) {
      if (!(error instanceof HttpError && (error.status === 401 || error.status === 404))) {
        const reason = error instanceof Error ? error.message : String(error);
        const keyName = config.deviceName ? `"Ensemble CLI on ${config.deviceName}"` : "the Ensemble CLI key";
        console.error(`Could not revoke this computer's key on ${config.apiBase} (${reason}).`);
        console.error(`It is removed from this computer. To revoke it on the server, delete ${keyName} under Connect your apps in Ensemble.`);
      }
    }
  }
  const sidecarDir = resolveSidecarDir(import.meta.url);
  if (await sidecarAvailable(sidecarDir)) {
    try {
      await withLocalApi({ sidecarDir, paths, adminOnly: true, run: (discovery) => localJson(discovery, "/api/remote/unpair", { method: "POST" }) });
    } catch (error) {
      console.error(`Could not unpair local runner: ${sidecarErrorMessage(error)}`);
    }
  }
  await clearToken(paths);
  await saveConfig({ ...config, account: null, tokenId: null, pairedAt: null }, paths);
  console.log("Logged out.");
}

async function commandMcp(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "setup") return commandMcpSetup(args.slice(1));
  if (subcommand === "remove") return commandMcpRemove(args.slice(1));
  if (subcommand === "editors") return commandMcpEditors(args.slice(1));
  const result = parsed(args, { api: { type: "string" } });
  if (result.values.help) return void console.log(HELP_BY_COMMAND.mcp);
  await runMcp({ api: stringOption(result.values, "api") });
}

async function commandMcpSetup(args: string[]): Promise<void> {
  const result = parsed(args, {
    all: { type: "boolean" },
    print: { type: "boolean" },
    hosted: { type: "boolean" },
    api: { type: "string" },
  });
  if (result.values.help) return void console.log(HELP_BY_COMMAND.mcp);
  const paths = resolveCliPaths();
  const config = await loadConfig(paths);
  const apiBase = normalizeApiBase(stringOption(result.values, "api") || config.apiBase);
  const token = await loadToken(paths);
  const sidecarDir = resolveSidecarDir(import.meta.url);
  const launcher = resolveLauncherCommand({
    argv1: process.argv[1],
    sidecarAvailable: await sidecarAvailable(sidecarDir),
  });
  let editors = parseEditorNames(result.positionals);
  if (editors.length === 0) {
    const detected = detectEditors().filter((row) => row.found);
    if (result.values.all) editors = detected.map((row) => row.editor);
    else {
      if (!process.stdin.isTTY) {
        console.log(detected.map((row) => `${row.editor}${row.printOnly ? " (print-only)" : ""}`).join("\n") || "No supported editors detected.");
        return;
      }
      editors = await chooseEditors();
    }
  }
  if (editors.length === 0) {
    console.log("No editors selected.");
    return;
  }
  for (const editor of editors) {
    const resultLine = await setupEditor(
      editor,
      { hosted: Boolean(result.values.hosted), apiBase, token, launcher },
      { printOnly: Boolean(result.values.print) },
    );
    console.log(resultLine.message);
  }
}

async function commandMcpRemove(args: string[]): Promise<void> {
  const result = parsed(args);
  if (result.values.help) return void console.log(HELP_BY_COMMAND.mcp);
  requirePositionals(result.positionals, "Usage: ensemble mcp remove <editor>");
  const [editor] = parseEditorNames([result.positionals[0]!]);
  const removed = await removeEditor(editor);
  console.log(removed.message);
}

async function commandMcpEditors(args: string[]): Promise<void> {
  const result = parsed(args);
  if (result.values.help) return void console.log(HELP_BY_COMMAND.mcp);
  for (const row of detectEditors()) {
    console.log(`${row.editor}\t${row.found ? "found" : "not found"}${row.printOnly ? "\tprint-only" : ""}${row.path ? `\t${row.path}` : ""}`);
  }
}

async function commandRunner(args: string[]): Promise<void> {
  const subcommand = args[0] && !args[0].startsWith("-") ? args[0] : "start";
  const rest = subcommand === "start" ? (args[0] === "start" ? args.slice(1) : args) : args.slice(1);
  if (!["start", "stop", "restart", "status", "logs", "install", "uninstall"].includes(subcommand)) throw new Error(HELP_BY_COMMAND.runner);
  const paths = resolveCliPaths();
  const sidecarDir = resolveSidecarDir(import.meta.url);
  if (subcommand === "start") {
    const result = parsed(rest, { foreground: { type: "boolean" } });
    if (result.values.help) return void console.log(HELP_BY_COMMAND.runner);
    if (result.values.foreground) return runForeground(sidecarDir, paths);
    const session = await startRunner({ sidecarDir, paths });
    if (!session) {
      console.log("Runner is already running.");
      return;
    }
    console.log(`Runner started on http://127.0.0.1:${session.discovery.port}. Logs: ${paths.runnerLog}`);
    return;
  }
  if (subcommand === "stop") {
    parsed(rest);
    console.log((await stopRunner(paths)) ? "Runner stopped." : "Runner was not running.");
    return;
  }
  if (subcommand === "restart") {
    parsed(rest);
    await stopRunner(paths);
    const session = await startRunner({ sidecarDir, paths });
    console.log(session ? `Runner restarted. Logs: ${paths.runnerLog}` : "Runner is already running.");
    return;
  }
  if (subcommand === "status") {
    parsed(rest);
    await printRunnerStatus(paths);
    return;
  }
  if (subcommand === "logs") {
    const result = parsed(rest, { follow: { type: "boolean", short: "f" } });
    if (result.values.help) return void console.log(HELP_BY_COMMAND.runner);
    await printLogs(paths.runnerLog, Boolean(result.values.follow));
    return;
  }
  if (subcommand === "install") {
    parsed(rest);
    if (!(await sidecarAvailable(sidecarDir))) throw new Error("Runner service install needs the full Ensemble CLI with the packaged sidecar.");
    const launcher = commandWithSubcommand(resolveLauncherCommand({ argv1: process.argv[1], sidecarAvailable: true }), "runner").command;
    await mkdir(paths.logsDir, { recursive: true });
    // The service takes over from a runner started by hand.
    if (await stopRunner(paths)) console.log("Stopped the runner that was already running; the service starts it again.");
    console.log(await installRunnerService({ home: homedir(), launcher, logPath: paths.runnerLog }));
    return;
  }
  if (subcommand === "uninstall") {
    parsed(rest);
    console.log(await uninstallRunnerService({ home: homedir() }));
    // Ending a Windows scheduled task leaves its child running.
    await stopRunner(paths);
  }
}

/**
 * The form login services run. It stays attached to the sidecar, passes stop
 * signals on, and exits 0 when stopped on purpose so launchd (SuccessfulExit
 * false) and systemd (Restart=on-failure) only restart it after a crash. When
 * another runner already holds the data folder it waits for that one to stop
 * instead of exiting, which would make the service restart in a loop.
 */
async function runForeground(sidecarDir: string, paths: CliPaths): Promise<void> {
  let child: ChildProcess | undefined;
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    stopping = true;
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
    else process.exit(0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    let announced = false;
    for (;;) {
      const session = await startRunner({ sidecarDir, paths, foreground: true });
      if (session?.child) {
        child = session.child;
        console.log(`Runner started on http://127.0.0.1:${session.discovery.port}. Logs: ${paths.runnerLog}`);
        break;
      }
      if (!announced) {
        console.log("Another runner is already running. This one starts when it stops.");
        announced = true;
      }
      while (await runningRunner(paths)) await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
    const running = child;
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      if (running.exitCode !== null || running.signalCode !== null) return resolve({ code: running.exitCode, signal: running.signalCode });
      running.once("error", reject);
      running.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (running.pid) await clearRunnerPidIf(running.pid, paths);
    const onPurpose = stopping || outcome.code === 0 || outcome.signal === "SIGTERM" || outcome.signal === "SIGINT";
    if (!onPurpose) throw new Error(`Runner exited ${outcome.code ?? outcome.signal ?? "without a code"}. Logs: ${paths.runnerLog}`);
    console.log("Runner stopped.");
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

async function printRunnerStatus(paths = resolveCliPaths()): Promise<void> {
  const discovery = await runningRunner(paths);
  const pid = await readRunnerPid(paths);
  console.log(`running: ${discovery ? "yes" : "no"}`);
  if (pid) {
    console.log(`pid: ${pid.pid}`);
    if (pid.startedAt) {
      console.log(`started: ${pid.startedAt}`);
      console.log(`uptime: ${formatDuration(Date.now() - Date.parse(pid.startedAt))}`);
    }
  }
  if (discovery) {
    const status = await remoteStatus(discovery);
    console.log(`paired: ${status.paired ? "yes" : "no"}`);
    console.log(`enabled: ${status.enabled ? "yes" : "no"}`);
    console.log(`folders: ${(status.folders ?? []).length}`);
    for (const folder of status.folders ?? []) console.log(`  ${folder.label}\t${folder.path}\t${folder.access ?? ""}`);
  }
  const lines = await tailLog(paths.runnerLog, 10);
  if (lines.length) console.log(`last logs:\n${lines.map((line) => `  ${line}`).join("\n")}`);
}

async function printLogs(file: string, follow: boolean): Promise<void> {
  for (const line of await tailLog(file, 100)) console.log(line);
  if (!follow) return;
  let offset = 0;
  try {
    offset = (await readFile(file)).length;
  } catch {
    offset = 0;
  }
  setInterval(() => {
    const stream = createReadStream(file, { start: offset });
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      offset += buffer.length;
      process.stdout.write(buffer);
    });
    stream.on("error", () => undefined);
  }, 1000);
  await new Promise(() => undefined);
}

const NO_RUNNER = "This install has no runner, so it cannot share folders or keep model keys. Install the full CLI: https://ensemblework.com/download";

async function commandFolders(args: string[]): Promise<void> {
  const subcommand = args[0] && !args[0].startsWith("-") ? args[0] : "list";
  const rest = subcommand === "list" ? (args[0] === "list" ? args.slice(1) : args) : args.slice(1);
  if (args.includes("--help") || args.includes("-h")) return void console.log(HELP_BY_COMMAND.folders);
  if (!["list", "add", "remove"].includes(subcommand)) throw new Error(HELP_BY_COMMAND.folders);
  const sidecarDir = resolveSidecarDir(import.meta.url);
  if (!(await sidecarAvailable(sidecarDir))) throw new Error(NO_RUNNER);
  if (subcommand === "list") {
    parsed(rest);
    const folders = await withAdminApi({ sidecarDir, run: listFolders });
    for (const folder of folders ?? []) console.log(`${folder.label}\t${folder.path}\t${folder.access ?? ""}`);
    return;
  }
  if (subcommand === "add") {
    const result = parsed(rest, { label: { type: "string" }, "read-only": { type: "boolean" } });
    requirePositionals(result.positionals, "Usage: ensemble folders add <path> [--label L] [--read-only]");
    const folders = await withAdminApi({
      sidecarDir,
      run: (discovery) => addFolder(discovery, result.positionals[0]!, { label: stringOption(result.values, "label"), readOnly: Boolean(result.values["read-only"]) }),
    });
    for (const folder of folders ?? []) console.log(`${folder.label}\t${folder.path}\t${folder.access ?? ""}`);
    return;
  }
  const result = parsed(rest);
  requirePositionals(result.positionals, "Usage: ensemble folders remove <label>");
  await withAdminApi({ sidecarDir, run: (discovery) => removeFolder(discovery, result.positionals[0]!) });
  console.log(`Removed ${result.positionals[0]}.`);
}

async function commandKeys(args: string[]): Promise<void> {
  const subcommand = args[0] && !args[0].startsWith("-") ? args[0] : "list";
  const rest = subcommand === "list" ? (args[0] === "list" ? args.slice(1) : args) : args.slice(1);
  if (args.includes("--help") || args.includes("-h")) return void console.log(HELP_BY_COMMAND.keys);
  if (!["list", "set", "remove"].includes(subcommand)) throw new Error(HELP_BY_COMMAND.keys);
  const sidecarDir = resolveSidecarDir(import.meta.url);
  if (!(await sidecarAvailable(sidecarDir))) throw new Error(NO_RUNNER);
  if (subcommand === "list") {
    parsed(rest);
    const keys = await withAdminApi({ sidecarDir, run: listKeys });
    for (const key of keys ?? []) console.log(`${key.provider}\t${key.source}\t${key.hint ?? ""}`);
    return;
  }
  const result = parsed(rest);
  requirePositionals(result.positionals, `Usage: ensemble keys ${subcommand} <provider>`);
  if (subcommand === "set") await withAdminApi({ sidecarDir, run: (discovery) => setKey(discovery, result.positionals[0]!) });
  else await withAdminApi({ sidecarDir, run: (discovery) => removeKey(discovery, result.positionals[0]!) });
  console.log(`${subcommand === "set" ? "Saved" : "Removed"} ${result.positionals[0]}.`);
}

async function statusSummary(): Promise<Record<string, unknown>> {
  const paths = resolveCliPaths();
  const config = await loadConfig(paths);
  const token = await loadToken(paths);
  const sidecarDir = resolveSidecarDir(import.meta.url);
  const runner = await runningRunner(paths);
  const pid = runner ? await readRunnerPid(paths) : null;
  const apiReachable = await checkApi(config.apiBase);
  const tokenValid = token ? await checkToken(config.apiBase, token) : false;
  const remote = runner ? await remoteStatus(runner).catch(() => null) : null;
  const keys = runner ? await listKeys(runner).catch(() => []) : [];
  return {
    version: VERSION,
    account: config.account ?? null,
    apiBase: config.apiBase,
    apiReachable,
    loggedIn: Boolean(token),
    tokenValid,
    deviceName: config.deviceName ?? null,
    pairedAt: config.pairedAt ?? null,
    sidecarPresent: await sidecarAvailable(sidecarDir),
    runnerRunning: Boolean(runner),
    runnerPid: pid?.pid ?? null,
    runnerStartedAt: pid?.startedAt || null,
    remoteEnabled: remote?.enabled ?? null,
    folders: remote?.folders ?? null,
    modelKeys: runner ? (keys ?? []).filter((key) => key.source && key.source !== "none").map((key) => key.provider) : null,
    node: process.version,
    git: Boolean(isExecutableOnPath("git")),
    editors: await configuredEditors(),
  };
}

type Summary = Awaited<ReturnType<typeof statusSummary>>;

function statusLines(status: Summary): string[] {
  const account = status.account as { email?: string; name?: string } | null;
  const folders = status.folders as Array<{ label: string; path: string; access?: string }> | null;
  const keys = status.modelKeys as string[] | null;
  const editors = status.editors as string[];
  const startedAt = typeof status.runnerStartedAt === "string" ? Date.parse(status.runnerStartedAt) : Number.NaN;
  const row = (label: string, value: string) => `${label.padEnd(13)}${value}`;
  const runnerOff = status.sidecarPresent ? "stopped (start with `ensemble runner start`)" : "not included in this install";
  return [
    row("Version", String(status.version)),
    row("Account", account?.email ? `${account.email}${account.name ? ` (${account.name})` : ""}` : "not logged in (run `ensemble login`)"),
    row("API", `${status.apiBase} ${status.apiReachable ? "(reachable)" : "(unreachable)"}`),
    row("Sign-in", !status.loggedIn ? "none" : status.tokenValid ? "valid" : "rejected (run `ensemble login` again)"),
    row("Computer", status.pairedAt ? `paired as "${status.deviceName}"` : "not paired for tasks"),
    row(
      "Runner",
      status.runnerRunning
        ? `running${status.runnerPid ? ` (pid ${status.runnerPid}${Number.isFinite(startedAt) ? `, up ${formatDuration(Date.now() - startedAt)}` : ""})` : ""}${status.remoteEnabled === false ? ", remote work off" : ""}`
        : runnerOff,
    ),
    row(
      "Folders",
      folders === null ? "start the runner to list" : folders.length ? folders.map((folder) => `${folder.label} → ${folder.path}${folder.access === "review" ? " (read-only)" : ""}`).join("\n" + " ".repeat(13)) : "none (add one with `ensemble folders add <path>`)",
    ),
    row("Model keys", keys === null ? "start the runner to list" : keys.length ? keys.join(", ") : "none on this computer"),
    row("Editors", editors.length ? editors.join(", ") : "none configured (run `ensemble mcp setup`)"),
  ];
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

async function checkApi(apiBase: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function checkToken(apiBase: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiBase}/api/bridge/today`, { headers: bearerHeaders(token), signal: AbortSignal.timeout(5000) });
    return response.status === 200;
  } catch {
    return false;
  }
}

async function commandStatus(args: string[]): Promise<void> {
  const result = parsed(args, { json: { type: "boolean" } });
  if (result.values.help) return void console.log(HELP_BY_COMMAND.status);
  const status = await statusSummary();
  if (result.values.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  for (const line of statusLines(status)) console.log(line);
}

async function commandDoctor(args: string[]): Promise<void> {
  const result = parsed(args);
  if (result.values.help) return void console.log(HELP_BY_COMMAND.doctor);
  const status = await statusSummary();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const checks: Array<[string, boolean, string]> = [
    ["Logged in", Boolean(status.loggedIn), "run `ensemble login`"],
    ["API reachable", Boolean(status.apiReachable), `check your network, or the API address ${status.apiBase}`],
    ["Sign-in accepted", Boolean(status.tokenValid), "run `ensemble login` again"],
    ["Runner included", Boolean(status.sidecarPresent), "install the full CLI: https://ensemblework.com/download"],
    ["Computer paired", Boolean(status.pairedAt), "run `ensemble login` and approve “Run tasks”"],
    ["Runner running", Boolean(status.runnerRunning), "run `ensemble runner start` or `ensemble runner install`"],
    ["Git on PATH", Boolean(status.git), "install git; code tasks need it"],
    ["Node 20 or newer", nodeMajor >= 20, "upgrade Node"],
  ];
  let failed = 0;
  for (const [label, ok, fix] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "fail"}  ${label}${ok ? "" : ` — ${fix}`}`);
  }
  console.log("");
  for (const line of statusLines(status).slice(5)) console.log(line);
  if (failed) process.exitCode = 1;
}

async function commandUpdate(args: string[]): Promise<void> {
  const result = parsed(args);
  if (result.values.help) return void console.log(HELP_BY_COMMAND.update);
  const sidecarDir = resolveSidecarDir(import.meta.url);
  const method = detectInstallMethod({
    bundlePath: fileURLToPath(import.meta.url),
    sidecarAvailable: await sidecarAvailable(sidecarDir),
    home: homedir(),
  });
  console.log(upgradeInstruction(method));
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "version") {
    console.log(VERSION);
    return;
  }
  const command = argv[0]!;
  await maybeUpdateNotice(command);
  const rest = argv.slice(1);
  switch (command) {
    case "login":
      return commandLogin(rest);
    case "logout":
      return commandLogout(rest);
    case "status":
      return commandStatus(rest);
    case "mcp":
      return commandMcp(rest);
    case "runner":
      return commandRunner(rest);
    case "folders":
      return commandFolders(rest);
    case "keys":
      return commandKeys(rest);
    case "doctor":
      return commandDoctor(rest);
    case "update":
      return commandUpdate(rest);
    default:
      throw new Error(`Unknown command "${command}". Run \`ensemble --help\`.`);
  }
}

// `ensemble … | head` closes the pipe early; that is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message.replace(/\s+/g, " ").trim()}`);
  process.exitCode = 1;
});
