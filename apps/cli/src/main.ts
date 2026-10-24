import { answerFor, answerPending, browseFiles, connectedHooks, webAccess, connectHook, formatPending, HOOK_TOOLS, listPending, listTrusted, trustFolder, trustSharing, untrustFolder, webApprovals, type HookTool, type TrustSharing } from "./approvals.js";
import type { ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { normalizeApiBase, loadConfig, saveConfig, loadToken, saveToken, clearToken } from "./config.js";
import { bearerHeaders, fetchJson, HttpError } from "./http.js";
import { resolveLauncherCommand } from "./launcher.js";
import { detectInstallMethod, dailyUpdateNotice, installCliUpdate } from "./update.js";
import { VERSION } from "./version.js";
import { signIn, signOut } from "./login.js";
import { resolveCliPaths, readJsonFile } from "./paths.js";
import { openBrowser } from "./browser.js";
import type { CliPaths } from "./paths.js";
import {
  clearRunnerPidIf,
  DesktopOwnsRuntimeError,
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
import { formatSandbox, sandboxSetup, sandboxStatus } from "./sandbox.js";
import { COMMAND, DOWNLOAD_URL, TESTING } from "./channel.js";

type ArgsOptions = NonNullable<ParseArgsConfig["options"]>;
type ParsedArgs = {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
};

const HELP = `Ensemble ${TESTING ? "Testing " : ""}${VERSION}: your tasks and coding agents, in the terminal.

  ensemble            Open Ensemble here. Two tabs:
                        Tasks  runs on this computer, and what needs you (answer with a click,
                               a number key, or /allow /deny /answer)
                        Chat   Ensemble Code: ask about this folder, plan, and hand work to
                               Ensemble's agent, Claude Code, Codex, Cursor or GitHub Copilot
                      Ensemble starts on this computer if it is not running, and keeps running
                      tasks after you leave.
  ensemble login      Sign in, so tasks you assign on ensemblework.com run here.

Inside the app, type / for commands: /run, /allow, /deny, /answer, /profile, /agent, /model,
/keys, /trust, /hooks, /login, /status, /help.

Scripts and automation: ensemble help commands
`.replace(/\bensemble\b/g, COMMAND).replace("ensemblework.com", TESTING ? "test.ensemblework.com" : "ensemblework.com");

const COMMANDS_HELP = `Ensemble ${VERSION}: commands for scripts and automation (the app does all of this too).

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
  ensemble needs [list] | answer <n> <allow|deny|option number|"answer">
  ensemble trust [list] | add [path] | remove <path> | share [on|off]
  ensemble approvals [status] | on | off
  ensemble browse [status] | on | off
  ensemble web [status] | files|edit|terminal on|off
  ensemble hooks [list] | connect <tool> | disconnect <tool>
  ensemble sandbox [status] | setup
  ensemble doctor
  ensemble update
  ensemble version | --version | --help`.replace(/\bensemble\b/g, COMMAND);

const HELP_BY_COMMAND: Record<string, string> = Object.fromEntries(Object.entries({
  login: "Usage: ensemble login [--api URL] [--name NAME] [--mcp-only] [--no-browser]",
  logout: "Usage: ensemble logout",
  status: "Usage: ensemble status [--json]",
  mcp: "Usage: ensemble mcp | ensemble mcp setup [editor...] [--all] [--print] [--hosted] | ensemble mcp remove <editor> | ensemble mcp editors",
  runner: "Usage: ensemble runner [start] [--foreground] | stop | restart | status | logs [-f] | install | uninstall",
  folders: "Usage: ensemble folders [list] | add <path> [--label L] [--read-only] | remove <label>",
  keys: "Usage: ensemble keys [list] | set <provider> | remove <provider>",
  needs: "Usage: ensemble needs [list] | answer <n> <allow|deny|option number|\"answer\">\nQuestions and approvals waiting on this computer, including pushes and folder trust.",
  trust: "Usage: ensemble trust [list] | add [path] | remove <path> | share [on|off]\nTrusted folders on this computer. Review only and Run unattended need one; Ensemble's own workspace is always trusted.\n`share` shows or sets whether they are trusted in Claude Code, Codex, GitHub Copilot CLI, Cursor and Gemini CLI too (on by default).",
  hooks:
    "Usage: ensemble hooks [list] | connect <claude|codex|copilot-cli|cursor> | disconnect <tool>\nSends permission prompts and questions from tasks Ensemble opens in these tools to Needs me, while the tool's own prompt still works. The hook signs in with a key that can ask Ensemble but never answer.",
  approvals: "Usage: ensemble approvals [status] | on | off\nOn (default): you can approve anything for this computer from the web or phone, and the mode, internet and limits chosen there apply here.",
  browse:
    "Usage: ensemble browse [status] | on | off\nOn (default): Ensemble on the web shows the files of tasks run here: the text of the files a run changed, sent when it ends, and any file or folder in a task's folder, read from here when you open it. Never git's own files or files of keys and secrets.",
  web:
    "Usage: ensemble web [status] | files on|off | edit on|off | terminal on|off\nWhat Ensemble on the web may do on this computer (each on by default):\n  files     show the files of tasks run here, and the code in the Code tab (the same switch as `ensemble browse`)\n  edit      change code from the web's Code tab: accept or reject an agent's changes, edit files, commit, push, pull\n  terminal  open the terminal from the web, after a passkey unlock there (30 minutes idle, 8 hours at most); the same allow-list as here\nNever git's own files or files of keys and secrets.",
  sandbox:
    "Usage: ensemble sandbox [status] | setup\nThis computer's OS sandbox (macOS Seatbelt, Linux bubblewrap or Landlock, Windows sandbox account). No Docker. On Windows, `setup` asks for permission once; the Ensemble app and the CLI share it.",
  doctor: "Usage: ensemble doctor",
  update: "Usage: ensemble update",
}).map(([key, value]) => [key, value.replace(/\bensemble\b/g, COMMAND)]));

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
  const sidecarDir = resolveSidecarDir(import.meta.url);
  const login = await signIn({
    apiBase: stringOption(result.values, "api"),
    name: stringOption(result.values, "name"),
    mcpOnly: Boolean(result.values["mcp-only"]),
    noBrowser: Boolean(result.values["no-browser"]),
    paths,
    onCode(code, url, opened) {
      console.log(`Code: ${code}`);
      console.log(`Open: ${url}`);
      if (!opened && !result.values["no-browser"]) console.error("Open the URL above in your browser to continue.");
    },
  });
  if (login.paired) await offerSandboxSetup(sidecarDir, paths);
  console.log(`Logged in${login.email ? ` as ${login.email}` : ""}.`);
  if (login.paired) {
    console.log(`This computer is paired as "${login.name}". Tasks you assign to it from Ensemble run here.`);
    console.log("");
    console.log("Next:");
    console.log(`  ${COMMAND} folders add <path>    share a folder the agent may work in`);
    console.log(`  ${COMMAND} keys set <provider>   save a model key on this computer (google, openai, anthropic, …)`);
    console.log(`  ${COMMAND} runner install        start the runner now and at every login`);
    console.log(`  ${COMMAND} mcp setup             connect your editors`);
  } else {
    if (!login.hasRunner) console.log(`This install has no runner. Install the full CLI to run tasks on this computer: ${DOWNLOAD_URL}`);
    console.log("");
    console.log(`Next: ${COMMAND} mcp setup    connect your editors`);
  }
}

async function commandLogout(args: string[]): Promise<void> {
  const result = parsed(args);
  if (result.values.help) return void console.log(HELP_BY_COMMAND.logout);
  for (const warning of await signOut()) console.error(warning);
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
    const running = session ? session.discovery : await runningRunner(paths);
    if (!session?.child) {
      console.log(running?.owner === "desktop" ? "The Ensemble app is running this computer's Ensemble. Tasks run there; nothing else to start." : "Runner is already running.");
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
    // The service takes over from a runner started by hand. The app's runtime is left alone; the service waits for it.
    try {
      if (await stopRunner(paths)) console.log("Stopped the runner that was already running; the service starts it again.");
    } catch (error) {
      if (!(error instanceof DesktopOwnsRuntimeError)) throw error;
      console.log("The Ensemble app is running this computer's Ensemble. The service starts the runner when the app quits.");
    }
    console.log(await installRunnerService({ home: homedir(), launcher, logPath: paths.runnerLog }));
    return;
  }
  if (subcommand === "uninstall") {
    parsed(rest);
    for (const warning of await signOut(paths)) console.warn(warning);
    console.log(await uninstallRunnerService({ home: homedir() }));
    // Ending a Windows scheduled task leaves its child running. The app's own runtime stays.
    await stopRunner(paths).catch((error: unknown) => {
      if (!(error instanceof DesktopOwnsRuntimeError)) throw error;
    });
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
        const other = await runningRunner(paths);
        console.log(
          other?.owner === "desktop"
            ? "The Ensemble app is running this computer's Ensemble. This runner starts when the app quits."
            : "Another runner is already running. This one starts when it stops.",
        );
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
  console.log(`running: ${discovery ? (discovery.owner === "desktop" ? "yes (started by the Ensemble app)" : "yes") : "no"}`);
  console.log(`data: ${paths.dataHome}`);
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

const NO_RUNNER = `This install has no runner, so it cannot share folders or keep model keys. Install the full CLI: ${DOWNLOAD_URL}`;

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
    const keys = (await withAdminApi({ sidecarDir, run: listKeys }) ?? []).filter((key) => key.source && key.source !== "none");
    if (!keys.length) {
      console.log("No model keys. Add one on the web (Settings → Models; computers signed in to your account use those keys) or here with `ensemble keys set <provider>`.");
      return;
    }
    const where: Record<string, string> = { you: "this computer", account: "your account", env: "environment", cli: "gh CLI" };
    for (const key of keys) console.log(`${key.provider}\t${where[key.source ?? ""] ?? key.source}\t${key.hint ?? ""}`);
    return;
  }
  const result = parsed(rest);
  requirePositionals(result.positionals, `Usage: ensemble keys ${subcommand} <provider>`);
  if (subcommand === "set") await withAdminApi({ sidecarDir, run: (discovery) => setKey(discovery, result.positionals[0]!) });
  else await withAdminApi({ sidecarDir, run: (discovery) => removeKey(discovery, result.positionals[0]!) });
  console.log(`${subcommand === "set" ? "Saved" : "Removed"} ${result.positionals[0]}.`);
}

async function commandNeeds(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) return void console.log(HELP_BY_COMMAND.needs);
  const subcommand = args[0] && !args[0].startsWith("-") ? args[0] : "list";
  if (!["list", "answer"].includes(subcommand)) throw new Error(HELP_BY_COMMAND.needs);
  const sidecarDir = resolveSidecarDir(import.meta.url);
  if (!(await sidecarAvailable(sidecarDir))) throw new Error(NO_RUNNER);
  if (subcommand === "list") {
    const rows = await withAdminApi({ sidecarDir, run: listPending });
    console.log(formatPending(rows));
    return;
  }
  const [number, ...words] = args.slice(1);
  if (!number || !words.length) throw new Error(HELP_BY_COMMAND.needs);
  await withAdminApi({
    sidecarDir,
    run: async (discovery) => {
      const rows = await listPending(discovery);
      const row = rows[Number(number) - 1] ?? rows.find((item) => item.id === number);
      if (!row) throw new Error(`There is no waiting item ${number}. Run \`ensemble needs\` to see the list.`);
      const answer = answerFor(row, words.join(" "));
      await answerPending(discovery, row, answer);
      console.log(answer.decision === "allow" ? `Sent${answer.reason ? `: ${answer.reason}` : ""}. The task continues.` : "Denied. The agent was told.");
    },
  });
}

async function commandTrust(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) return void console.log(HELP_BY_COMMAND.trust);
  const subcommand = args[0] && !args[0].startsWith("-") ? args[0] : "list";
  if (!["list", "add", "remove", "share"].includes(subcommand)) throw new Error(HELP_BY_COMMAND.trust);
  const sidecarDir = resolveSidecarDir(import.meta.url);
  if (!(await sidecarAvailable(sidecarDir))) throw new Error(NO_RUNNER);
  if (subcommand === "list") {
    const rows = await withAdminApi({ sidecarDir, run: listTrusted });
    console.log(rows.length ? rows.map((row) => row.path).join("\n") : "No trusted folders yet. Ensemble's own workspace is always trusted. Add one with `ensemble trust add <path>`.");
    const sharing = await withAdminApi({ sidecarDir, run: (discovery) => trustSharing(discovery) }).catch(() => null);
    if (sharing) console.log(`\n${sharingLine(sharing)}`);
    return;
  }
  if (subcommand === "share") {
    const value = args[1];
    if (value !== undefined && value !== "on" && value !== "off") throw new Error("Usage: ensemble trust share [on|off]");
    const sharing = await withAdminApi({ sidecarDir, run: (discovery) => trustSharing(discovery, value === undefined ? undefined : value === "on") });
    console.log(sharingLine(sharing));
    return;
  }
  if (subcommand === "add") {
    const folder = args[1] ?? process.cwd();
    const row = await withAdminApi({ sidecarDir, run: (discovery) => trustFolder(discovery, folder) });
    console.log(`Trusted ${row.path}. Agents can run commands there without asking, and Review only and Run unattended can use it.`);
    return;
  }
  if (!args[1]) throw new Error("Usage: ensemble trust remove <path>");
  const removed = await withAdminApi({ sidecarDir, run: (discovery) => untrustFolder(discovery, args[1]!) });
  console.log(removed ? `No longer trusted: ${args[1]}.` : `${args[1]} was not trusted.`);
}

function sharingLine(sharing: TrustSharing): string {
  if (!sharing.enabled) return "Trust is not shared with other AI tools. Turn it on with `ensemble trust share on`.";
  const found = sharing.tools.filter((tool) => tool.found).map((tool) => tool.name);
  return found.length
    ? `These folders are also trusted in ${found.join(", ")} on this computer. Turn that off with \`ensemble trust share off\`.`
    : "No other AI tools found on this computer to share trust with (Claude Code, Codex, GitHub Copilot CLI, Cursor, Gemini CLI).";
}

async function commandApprovals(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) return void console.log(HELP_BY_COMMAND.approvals);
  const subcommand = args[0] ?? "status";
  if (!["status", "on", "off"].includes(subcommand)) throw new Error(HELP_BY_COMMAND.approvals);
  const sidecarDir = resolveSidecarDir(import.meta.url);
  if (!(await sidecarAvailable(sidecarDir))) throw new Error(NO_RUNNER);
  const on = await withAdminApi({ sidecarDir, run: (discovery) => webApprovals(discovery, subcommand === "status" ? undefined : subcommand === "on") });
  console.log(
    on
      ? "Approvals from the web and phone: on. You can approve anything for this computer from Needs me (with a confirm step for pushes and trust), and the run settings chosen there apply here."
      : "Approvals from the web and phone: off. Pushes, folder trust and paths outside a folder are answered only here (`ensemble needs`), and web settings can only narrow.",
  );
}

async function commandBrowse(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) return void console.log(HELP_BY_COMMAND.browse);
  const subcommand = args[0] ?? "status";
  if (!["status", "on", "off"].includes(subcommand)) throw new Error(HELP_BY_COMMAND.browse);
  const sidecarDir = resolveSidecarDir(import.meta.url);
  if (!(await sidecarAvailable(sidecarDir))) throw new Error(NO_RUNNER);
  const on = await withAdminApi({ sidecarDir, run: (discovery) => browseFiles(discovery, subcommand === "status" ? undefined : subcommand === "on") });
  console.log(
    on
      ? "Task files on the web: on. Ensemble on the web shows the files tasks here changed, and files in a task's folder when you open them there. Never git's own files or secrets files."
      : "Task files on the web: off. The web shows only file names and line counts for tasks run here.",
  );
}

async function commandWeb(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) return void console.log(HELP_BY_COMMAND.web);
  const [what = "status", value] = args;
  const keys = { files: "browseFiles", edit: "webEdit", terminal: "webTerminal" } as const;
  if (what !== "status" && (!(what in keys) || !["on", "off"].includes(value ?? ""))) throw new Error(HELP_BY_COMMAND.web);
  const sidecarDir = resolveSidecarDir(import.meta.url);
  if (!(await sidecarAvailable(sidecarDir))) throw new Error(NO_RUNNER);
  const change = what === "status" ? undefined : { [keys[what as keyof typeof keys]]: value === "on" };
  const access = await withAdminApi({ sidecarDir, run: (discovery) => webAccess(discovery, change) });
  const word = (on: boolean) => (on ? "on " : "off");
  console.log(`Ensemble on the web, on this computer:
  files     ${word(access.browseFiles)}  task files and code in the Code tab
  edit      ${word(access.webEdit)}  accept/reject, edit, commit, push from the Code tab
  terminal  ${word(access.webTerminal)}  the terminal, after a passkey unlock on the web`);
}

async function commandHooks(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) return void console.log(HELP_BY_COMMAND.hooks);
  const subcommand = args[0] ?? "list";
  if (!["list", "connect", "disconnect"].includes(subcommand)) throw new Error(HELP_BY_COMMAND.hooks);
  const sidecarDir = resolveSidecarDir(import.meta.url);
  if (!(await sidecarAvailable(sidecarDir))) throw new Error(NO_RUNNER);
  if (subcommand === "list") {
    const connected = await withAdminApi({ sidecarDir, run: connectedHooks });
    for (const [tool, name] of Object.entries(HOOK_TOOLS)) console.log(`${connected.includes(tool) ? "connected    " : "not connected"}  ${tool.padEnd(12)} ${name}`);
    return;
  }
  const tool = args[1];
  if (!tool || !(tool in HOOK_TOOLS)) throw new Error(HELP_BY_COMMAND.hooks);
  const result = await withAdminApi({ sidecarDir, run: (discovery) => connectHook(discovery, tool as HookTool, subcommand === "disconnect") });
  console.log(result.message);
}

async function commandSandbox(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) return void console.log(HELP_BY_COMMAND.sandbox);
  const subcommand = args[0] ?? "status";
  if (!["status", "setup"].includes(subcommand)) throw new Error(HELP_BY_COMMAND.sandbox);
  const sidecarDir = resolveSidecarDir(import.meta.url);
  if (!(await sidecarAvailable(sidecarDir))) throw new Error(NO_RUNNER);
  if (subcommand === "status") {
    const caps = await withAdminApi({ sidecarDir, run: (discovery) => sandboxStatus(discovery, true) });
    for (const line of formatSandbox(caps)) console.log(line);
    return;
  }
  if (process.platform === "win32") console.log("Setting up the Windows sandbox. Windows asks for permission once.");
  const result = await withAdminApi({ sidecarDir, run: sandboxSetup });
  console.log(result.message);
  for (const line of formatSandbox(result.sandbox)) console.log(line);
  if (!result.ok) process.exitCode = 1;
}

/** At login on Windows, turn the sandbox on while someone is there to approve the prompt. */
async function offerSandboxSetup(sidecarDir: string, paths: CliPaths): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const caps = await withLocalApi({ sidecarDir, paths, adminOnly: true, run: (discovery) => sandboxStatus(discovery, true) });
    if (caps.osSandbox || !caps.setup?.needed) return;
    console.log("Setting up the Windows sandbox so tasks can run safely here. Windows asks for permission once.");
    const result = await withLocalApi({ sidecarDir, paths, adminOnly: true, run: sandboxSetup });
    console.log(result.ok ? result.message : `${result.message} Run \`ensemble sandbox setup\` later to turn it on.`);
  } catch (error) {
    console.error(`Could not set up the sandbox now (${sidecarErrorMessage(error)}). Run \`ensemble sandbox setup\` later.`);
  }
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
    row("Model keys", keys === null ? "start the runner to list" : keys.length ? keys.join(", ") : "none (add one on the web in Settings → Models, or `ensemble keys set <provider>`)"),
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
    const response = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(5000), ...(TESTING ? { redirect: "error" as const } : {}) });
    return response.ok;
  } catch {
    return false;
  }
}

async function checkToken(apiBase: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiBase}/api/bridge/today`, { headers: bearerHeaders(token), signal: AbortSignal.timeout(5000), ...(TESTING ? { redirect: "error" as const } : {}) });
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
    console.log(JSON.stringify({ ...status, channel: TESTING ? "testing" : "production" }, null, 2));
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
  const runner = await runningRunner(resolveCliPaths());
  const sandbox = runner ? await sandboxStatus(runner).catch(() => null) : null;
  if (sandbox) checks.push(["OS sandbox", sandbox.osSandbox, sandbox.setup?.needed ? "run `ensemble sandbox setup`" : sandbox.reason]);
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
  console.log(await installCliUpdate(fileURLToPath(import.meta.url)));
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    const { runApp } = await import("./tui/index.js");
    return runApp();
  }
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return;
  }
  if (argv[0] === "help") {
    console.log(argv[1] === "commands" ? COMMANDS_HELP : HELP);
    return;
  }
  if (argv[0] === "app") {
    const { runApp } = await import("./tui/index.js");
    return runApp();
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
    case "needs":
      return commandNeeds(rest);
    case "trust":
      return commandTrust(rest);
    case "approvals":
      return commandApprovals(rest);
    case "browse":
      return commandBrowse(rest);
    case "web":
      return commandWeb(rest);
    case "hooks":
      return commandHooks(rest);
    case "sandbox":
      return commandSandbox(rest);
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
