/**
 * A node's live terminals on this computer (`capabilities.live`, docs/25 §10.4, docs/35 §8.17): a shell
 * (bash, else sh) in a pseudo-terminal (`script`, as device-tools/terminal.ts starts one) in the node's
 * folder, under the OS sandbox as `run` is (its folder writable, keys, Ensemble's data and the browser
 * profile denied, the internet as the node's run profile says), kept open between calls. Its screen is
 * replayed in a headless xterm with 1,000 lines of scrollback, which the node reads as text and the
 * owner watches live (takeover/terminal-view.ts). The shell's prompt marks where each command starts
 * (OSC 133, as terminals' shell integration does), so a line the node submits is judged as the shell
 * will run it: the hard floor's dangerous commands and the programs no agent runs are refused, and the
 * line is cleared instead of run. The owner's own typing is theirs and is not judged. A session ends on
 * `terminal_close`, its shell ending, 30 minutes with nobody typing or watching, 4 hours, or this
 * computer no longer taking work from the web; its live card then ends (`ROUTES.liveEnded`).
 */
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { IMarker, Terminal } from "@xterm/headless";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { browserBroker } from "../browser/index.js";
import type { PrivacyRules } from "../browser/privacy.js";
import { bufferLines, drawn, headlessTerminal, screenRows } from "../capture/screen.js";
import { findOnPath } from "../capture/system.js";
import { appendLedger } from "../lib/ledger.js";
import { savedSecretValues } from "../lib/run-secrets.js";
import type { HostedClient } from "../remote/client.js";
import { LIVE_IDLE_MS, LIVE_MAX_MS, LIVE_MAX_PER_NODE, type CodeAnswer, type LiveAnswer, type NodeToolRequest } from "../remote/contract.js";
import { cacheDir, checkProgram, GuardError, sandboxAvailable } from "../workspace/guard.js";
import { killGroup, runCommand, type RunResult } from "../workspace/runner.js";
import { parseShell } from "../workspace/shell-parse.js";
import { dangerousCommand, dangerousMessage } from "./dangerous.js";
import { nodeToolDenies, type ToolFolder } from "./folders.js";
import { stopWithCommands } from "./run.js";
import { keyBytes, namedKey, terminalEnv } from "./terminal.js";

export type LiveRequest = Extract<NodeToolRequest, { tool: "live" }>;
type App = Pick<FastifyInstance, "prisma">;

const SCROLLBACK = 1000;
/** Output waiting to be drawn past this pauses the shell's output until the screen catches up. */
const BACKLOG_PAUSE = 2 * 1024 * 1024;
const BACKLOG_RESUME = 256 * 1024;
const ESC = "\u001b";
const BEL = "\u0007";

/** Why a session changed, for whoever watches it. */
export type SessionChange = "screen" | "size" | "control" | "ended";

export type TerminalSession = {
  id: string;
  nodeId: string;
  operation: string;
  folder: ToolFolder;
  title: string;
  shell: string;
  term: Terminal;
  columns: number;
  rows: number;
  /** The size the node opened it at: the screen goes back to it when nobody watches. */
  opened: { columns: number; rows: number };
  network: boolean;
  child: ChildProcess | null;
  done: Promise<RunResult | null>;
  events: EventEmitter;
  startedAt: number;
  lastUsed: number;
  /** Where typing starts after the latest prompt. */
  prompt: { marker: IMarker; x: number } | null;
  prompts: number;
  /** What the node typed on the current line since its last Enter (null: it recalled a line, so only the screen knows it). */
  typed: string | null;
  /** Lines the node submitted since the prompt that the shell has not run yet (a line ending in `\`, an open quote). */
  typedLines: string[];
  /** bash: a prompt showed and no command started since (its PS0 mark): what is typed is shell input. */
  awaiting: boolean;
  bash: boolean;
  /** The takeover controlling it from the web: the node's typing waits meanwhile. */
  controlledBy: string | null;
  viewers: number;
  ended: { reason: string; exitCode: number | null } | null;
  rules: PrivacyRules;
  fifo: string;
  backlog: number;
  client: HostedClient;
  timers: NodeJS.Timeout[];
  forget: () => void;
};

const sessions = new Map<string, TerminalSession>();
let timing = { idleMs: LIVE_IDLE_MS, maxMs: LIVE_MAX_MS };

/** Tests shorten a session's idle and longest times. */
export function setLiveTimingForTests(next: { idleMs?: number; maxMs?: number } | null): void {
  timing = { idleMs: next?.idleMs ?? LIVE_IDLE_MS, maxMs: next?.maxMs ?? LIVE_MAX_MS };
}

const answer = (status: number, body: Record<string, unknown>): CodeAnswer => ({ status, body });
const ledger = (action: string, payload: Record<string, string | number | boolean | null>) => appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "agent", action, payload }).catch(() => undefined);

/** A session by id, while it is open. */
export function terminalSession(id: string): TerminalSession | null {
  const session = sessions.get(id);
  return session && !session.ended ? session : null;
}

/** The shell a session runs: bash (line editing, history, its prompt marks commands as they start), else sh. */
function shellProgram(): { path: string; bash: boolean } {
  const bash = findOnPath("bash");
  return bash ? { path: bash, bash: true } : { path: "/bin/sh", bash: false };
}

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * The shell's prompt: the node's handle and the folder, between the OSC 133 marks that say where a
 * prompt starts (A) and where typing starts (B); bash also marks a command starting (PS0, C).
 */
export function promptEnv(slug: string, bash: boolean): Record<string, string> {
  const name = slug.replace(/[^a-z0-9-]/g, "").slice(0, 40) || "node";
  if (!bash) return { PS1: `${ESC}]133;A${BEL}${name} $ ${ESC}]133;B${BEL}` };
  return {
    PS1: `\\[\\e]133;A\\a\\]\\[\\e[1;32m\\]${name}\\[\\e[0m\\] \\[\\e[1;34m\\]\\W\\[\\e[0m\\] \\$ \\[\\e]133;B\\a\\]`,
    PS0: "\\e]133;C\\a",
    HISTFILE: "",
    HISTCONTROL: "ignoreboth",
    PROMPT_COMMAND: BASH_SETUP,
  };
}

/**
 * Run once by bash before its first prompt (it reads no rc file): no history expansion (`!!`,
 * `^old^new` would run an earlier line unjudged), no editor for `fc` or edit-and-execute (it would
 * run what was edited unjudged), and the prompt and its marks fixed for this shell.
 */
export const BASH_SETUP = "set +H; EDITOR=false; VISUAL=false; FCEDIT=false; PROMPT_COMMAND=; readonly PS0 PS1 PS2 PROMPT_COMMAND EDITOR VISUAL FCEDIT";

/** The prompt as the environment carries it to the shell: a shell started by `script -c` drops PS1, so it is set again just before the shell starts. */
function promptCarried(prompt: Record<string, string>): { env: Record<string, string>; line: string } {
  const env = Object.fromEntries(Object.entries(prompt).map(([key, value]) => [`ENSEMBLE_LIVE_${key}`, value]));
  const names = Object.keys(prompt);
  return { env, line: `export ${names.map((key) => `${key}="$ENSEMBLE_LIVE_${key}"`).join(" ")}; unset ${names.map((key) => `ENSEMBLE_LIVE_${key}`).join(" ")}` };
}

/**
 * What `script` runs: the size, a small helper that applies a new size the owner's screen asks for
 * (it reads `columns rows` from a pipe in the cache and sets them on the terminal, which tells the
 * program in front), then the shell.
 */
export function sessionArgv(platform: string, input: { shell: string; bash: boolean; columns: number; rows: number; fifo: string; prompt?: string }): string[] {
  const resize = `F=${quote(input.fifo)}; if mkfifo -m 600 "$F" 2>/dev/null; then (trap '' TTOU INT; while [ -p "$F" ]; do read c r < "$F" || continue; [ "$c" = 0 ] && break; stty cols "$c" rows "$r" < /dev/tty; done) >/dev/null 2>&1 & fi`;
  const shell = input.bash ? `${quote(input.shell)} --noprofile --norc -i` : `${quote(input.shell)} -i`;
  const line = `stty cols ${input.columns} rows ${input.rows} 2>/dev/null; ${resize}; ${input.prompt ? `${input.prompt}; ` : ""}exec ${shell}`;
  return platform === "darwin" ? ["script", "-q", "/dev/null", "/bin/sh", "-c", line] : ["script", "-qfec", line, "/dev/null"];
}

/** The shell's prompt is showing and the cursor is on its line (or a line it wrapped onto): what is typed there is a command. */
export function atPrompt(session: Pick<TerminalSession, "prompt" | "term">): boolean {
  const prompt = session.prompt;
  if (!prompt || prompt.marker.isDisposed || prompt.marker.line < 0) return false;
  const buffer = session.term.buffer.active;
  // A full-screen program draws on the other screen: the prompt is not there.
  if (buffer.type !== "normal") return false;
  const cursor = buffer.baseY + buffer.cursorY;
  if (cursor < prompt.marker.line) return false;
  for (let y = prompt.marker.line + 1; y <= cursor; y += 1) if (!buffer.getLine(y)?.isWrapped) return false;
  return true;
}

/**
 * What was typed since the prompt, as the screen shows it: wrapped rows joined, and with `all` the
 * continuation rows too (after a line ending in `\` or an open quote, bash's `> ` taken off).
 */
export function promptLine(session: Pick<TerminalSession, "prompt" | "term">, all = false): string | null {
  const prompt = session.prompt;
  if (!prompt || prompt.marker.isDisposed || prompt.marker.line < 0) return null;
  if (!all && !atPrompt(session)) return null;
  const buffer = session.term.buffer.active;
  if (buffer.type !== "normal") return null;
  const cursor = buffer.baseY + buffer.cursorY;
  if (cursor < prompt.marker.line || cursor - prompt.marker.line > 200) return null;
  let text = buffer.getLine(prompt.marker.line)?.translateToString(false, prompt.x) ?? "";
  for (let y = prompt.marker.line + 1; y <= cursor; y += 1) {
    const line = buffer.getLine(y);
    if (!line) break;
    text = line.isWrapped ? text + line.translateToString(false) : `${text.trimEnd()}\n${line.translateToString(false).replace(/^> /, "")}`;
  }
  return text.trim();
}

/** A line continued with a backslash is one command to the shell. */
const joined = (text: string) => text.replace(/\\\r?\n/g, "");

/**
 * Judges a line the node submits: the hard floor's dangerous commands always; at the shell's prompt
 * also the programs no agent runs, and those that need the internet where it is off (as `run` does,
 * scripts by path included). Null when it may run.
 */
export function judgeLine(line: string, input: { shell: boolean; network: boolean; cwd: string }): string | null {
  const text = joined(line).trim();
  if (!text) return null;
  const hit = dangerousCommand(text);
  if (hit) return dangerousMessage(hit);
  if (!input.shell) return null;
  // History expansion runs an earlier line again, changed, where it is not judged (a shell started inside this one has it on).
  if (/(?:^|[\s;&|(`])!(?=[!\-0-9A-Za-z?#$^*])|^\s*\^[^^\s]*\^/.test(text)) return "History expansion (!!, !-1, ^old^new) runs earlier commands again without them being checked: type the command itself.";
  try {
    for (const segment of parseShell(text, input.cwd)) {
      if (!segment.argv.length) continue;
      const [program, ...rest] = segment.argv;
      // `fc` runs earlier lines again (edited or substituted) where they are not judged.
      if (basename(program!) === "fc") return "fc runs earlier commands again without them being checked: type the command itself.";
      checkProgram([basename(program!), ...rest], { who: "agent", sandboxed: true, network: input.network });
    }
  } catch (error) {
    if (error instanceof GuardError) return error.message;
    throw error;
  }
  return null;
}

/** Waits until nothing new was drawn for `quietMs`, or `maxMs` passed. */
async function settle(session: TerminalSession, quietMs: number, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  let last = Date.now();
  const touch = () => (last = Date.now());
  session.events.on("change", touch);
  try {
    while (Date.now() < deadline && Date.now() - last < quietMs && !session.ended) await sleep(Math.min(25, quietMs));
  } finally {
    session.events.off("change", touch);
  }
  await drawn(session.term);
}

/** Waits for the shell's prompt after `prompts` (a command ended), at most `maxMs`. */
async function promptAfter(session: TerminalSession, prompts: number, maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline && !session.ended) {
    if (session.prompts > prompts && atPrompt(session)) return true;
    await sleep(20);
  }
  return session.prompts > prompts;
}

function write(session: TerminalSession, bytes: string): void {
  const stdin = session.child?.stdin;
  if (stdin?.writable) stdin.write(bytes);
}

/** Tells the size helper in the shell the new size (it waits on its pipe); a full pipe or no helper does nothing. */
async function tellSize(session: TerminalSession, columns: number, rows: number): Promise<void> {
  for (let tries = 0; tries < 10; tries += 1) {
    const kind = await lstat(session.fifo).catch(() => null);
    if (!kind?.isFIFO()) return;
    try {
      const handle = await open(session.fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      try {
        await handle.write(`${columns} ${rows}\n`);
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENXIO" && (error as NodeJS.ErrnoException).code !== "EAGAIN") return;
      await sleep(30);
    }
  }
}

/** The answer about a session: its screen as text (or its last `lines`, scrollback too), secrets hidden. */
export async function sessionView(session: TerminalSession, lines?: number): Promise<LiveAnswer> {
  await drawn(session.term);
  const buffer = session.term.buffer.active;
  const visible = screenRows(session.term, session.rules);
  return {
    session: session.id,
    title: session.title,
    folder: session.folder.label,
    screen: lines ? bufferLines(session.term, lines, session.rules) : visible.text,
    cursor: { x: buffer.cursorX, y: buffer.cursorY },
    columns: session.columns,
    rows: session.rows,
    atPrompt: atPrompt(session),
    hidden: visible.hidden,
    ended: Boolean(session.ended),
    exitCode: session.ended?.exitCode ?? null,
    controlled: Boolean(session.controlledBy),
  };
}

/** Keeps a session's rules for hiding secrets current with the saved secrets here. */
async function refreshRules(app: App, session: TerminalSession): Promise<void> {
  session.rules = { secretValues: await savedSecretValues(app.prisma, env.ENSEMBLE_DEV_USER_ID).catch(() => session.rules.secretValues ?? []) };
}

/** Opens a session in the folder (already judged by the policy here) and answers its first screen. */
async function openSession(app: App, client: HostedClient, request: LiveRequest, folder: ToolFolder): Promise<CodeAnswer> {
  if (process.platform === "win32" || !findOnPath("script")) return answer(409, { error: "Live terminals need a pseudo-terminal (`script`), which this computer does not have. Use computer_run." });
  if (!sandboxAvailable()) return answer(409, { error: "Live terminals run only inside this computer's sandbox, which is not set up here. Your owner runs `ensemble sandbox setup` there; until then use computer_run." });
  const mine = [...sessions.values()].filter((row) => row.nodeId === request.nodeId && !row.ended);
  if (mine.length >= LIVE_MAX_PER_NODE) return answer(409, { error: `You have ${mine.length} terminals open here already (${mine.map((row) => row.id).join(", ")}): close one with terminal_close first.` });
  const id = `ts${randomBytes(6).toString("hex")}`;
  const { path: shellPath, bash } = shellProgram();
  const shell = basename(shellPath);
  const fifoDir = join(await cacheDir(), "live", id);
  await mkdir(fifoDir, { recursive: true, mode: 0o700 });
  const term = await headlessTerminal(request.columns, request.rows, SCROLLBACK);
  const group = `node-live:${id}`;
  const controller = new AbortController();
  const events = new EventEmitter();
  events.setMaxListeners(50);
  const session: TerminalSession = {
    id,
    nodeId: request.nodeId,
    operation: request.operation,
    folder,
    title: request.title?.trim() || `${shell} in ${folder.label}`,
    shell,
    term,
    columns: request.columns,
    rows: request.rows,
    opened: { columns: request.columns, rows: request.rows },
    network: request.network,
    child: null,
    done: Promise.resolve(null),
    events,
    startedAt: Date.now(),
    lastUsed: Date.now(),
    prompt: null,
    prompts: 0,
    typed: "",
    typedLines: [],
    awaiting: false,
    bash,
    controlledBy: null,
    viewers: 0,
    ended: null,
    rules: {},
    fifo: join(fifoDir, "size"),
    backlog: 0,
    client,
    timers: [],
    forget: () => undefined,
  };
  await refreshRules(app, session);
  // Shell integration marks: where a prompt ends and typing starts (B), and where a command starts (C).
  term.parser.registerOscHandler(133, (data) => {
    const mark = data.split(";")[0];
    if (mark === "B") {
      session.awaiting = true;
      session.typedLines = [];
      session.prompt?.marker.dispose();
      const marker = term.registerMarker(0);
      session.prompt = marker ? { marker, x: term.buffer.active.cursorX } : null;
      session.prompts += 1;
    } else if (mark === "C") {
      // The prompt's place is kept: whether the cursor is still on it is told by the screen, not by a mark a program could print.
      session.awaiting = false;
      session.typedLines = [];
    }
    return true;
  });
  // The terminal's own answers (where the cursor is, what it is) go back to the program, as a real terminal's do.
  term.onData((reply) => write(session, reply));
  session.forget = stopWithCommands(group, () => void closeSession(id, "stopped"));
  sessions.set(id, session);
  const changed = () => events.emit("change", "screen" satisfies SessionChange);
  const prompt = promptCarried(promptEnv(request.nodeSlug ?? "node", bash));
  session.done = runCommand({
    userId: env.ENSEMBLE_DEV_USER_ID,
    argv: sessionArgv(process.platform, { shell: shellPath, bash, columns: request.columns, rows: request.rows, fifo: session.fifo, prompt: prompt.line }),
    cwd: folder.path,
    root: folder.path,
    sandboxed: true,
    network: request.network,
    useCredentials: false,
    who: "agent",
    readWrite: [folder.path],
    deny: await nodeToolDenies(),
    timeoutMs: timing.maxMs + 60_000,
    signal: controller.signal,
    group,
    extraEnv: { ...terminalEnv(request.columns, request.rows), SHELL: shellPath, ...prompt.env },
    unsetEnv: ["NO_COLOR", "CI", "COLUMNS", "LINES"],
    stdin: true,
    onSpawn: (spawned) => {
      session.child = spawned;
      spawned.stdin?.on("error", () => undefined);
    },
    onData: (chunk) => {
      session.backlog += chunk.length;
      if (session.backlog > BACKLOG_PAUSE) session.child?.stdout?.pause();
      term.write(chunk, () => {
        session.backlog -= chunk.length;
        if (session.backlog < BACKLOG_RESUME && session.child?.stdout?.isPaused()) session.child.stdout.resume();
        changed();
      });
    },
  }).then(
    (result) => result,
    () => null,
  );
  void session.done.then((result) => void closeSession(id, "exited", result?.exitCode ?? null));
  const killer = () => controller.abort();
  session.timers.push(
    setTimeout(() => void closeSession(id, "max"), timing.maxMs),
    setInterval(() => {
      if (!session.viewers && Date.now() - session.lastUsed > timing.idleMs) void closeSession(id, "idle");
    }, Math.min(60_000, Math.max(200, timing.idleMs / 4))),
  );
  for (const timer of session.timers) timer.unref();
  events.once("ended", killer);
  // The first prompt: the shell is ready.
  await promptAfter(session, 0, 8_000);
  await settle(session, 60, 500);
  if (session.ended) return answer(500, { error: `The shell ended at once (exit code ${session.ended.exitCode ?? "unknown"}).`, ...(await sessionView(session)) });
  await ledger("node.tool.terminal_session", { nodeId: request.nodeId, session: id, action: "open", shell, folder: folder.label, operationId: request.operationId ?? null });
  return answer(200, { ...(await sessionView(session)) });
}

/** The node's own session, or why not: one that ended (or never was here) answers so, and its card ends. */
function ownSession(request: LiveRequest): TerminalSession | CodeAnswer {
  const session = request.session ? sessions.get(request.session) : undefined;
  if (!session) return answer(200, { session: request.session, ended: true, gone: true, exitCode: null });
  if (session.nodeId !== request.nodeId) return answer(404, { error: `Terminal ${request.session} is not yours.` });
  return session;
}

/** A token the node sends: text as typed, or a named key. */
type Token = { text: string } | { key: string; bytes: string; app?: string };

/** Keys the node does not send: they run or insert a line where it is not judged (operate-and-get-next, edit-and-execute, quoted insert, Alt bindings). */
const UNSENT_KEYS = /^(?:(?:alt|meta|option)[+-].+|ctrl[+-][oxv])$/i;

/** Whether bytes typed submit the line (Enter, Ctrl+M, Ctrl+J). */
const submits = (bytes: string) => bytes === "\r" || bytes === "\n";

function tokensOf(request: LiveRequest): Token[] | string {
  const tokens: Token[] = [];
  const text = request.text ?? "";
  // Control characters go as named keys, where they are judged; in text only tabs and new lines.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return "Send control keys in keys (Escape, Ctrl+C, Backspace…), not inside text.";
  // A new line in the text is Enter, as a terminal sends it.
  for (const [index, part] of text.split(/\r\n|\r|\n/).entries()) {
    if (index > 0) tokens.push({ key: "enter", bytes: "\r" });
    if (part) tokens.push({ text: part });
  }
  for (const name of request.keys) {
    const key = namedKey(name);
    if (!key) return `${name} is not a key this terminal knows. Use Enter, Tab, Escape, Backspace, Up, Down, Left, Right, Home, End, PageUp, PageDown, Delete, F1–F12 or Ctrl+A…Ctrl+Z.`;
    if (UNSENT_KEYS.test(name.trim().replace(/\s+/g, ""))) return `${name} is not sent from here: it would run or insert a line without it being checked. Type the line and press Enter.`;
    tokens.push({ key: name.trim().toLowerCase(), bytes: key.normal, ...(key.app ? { app: key.app } : {}) });
  }
  return tokens;
}

/** What the node's typing does to its own record of the current line. */
function track(session: TerminalSession, token: Token): void {
  if ("text" in token) {
    if (session.typed === null) return;
    for (const char of token.text) {
      if (char === "\u007f" || char === "\b") session.typed = session.typed.slice(0, -1);
      else if (char === "\u0015" || char === "\u0003") session.typed = "";
      else session.typed += char;
    }
    return;
  }
  // Ctrl+C drops what waits to be run too.
  if (token.bytes === "\u0003") session.typedLines = [];
  if (token.bytes === "\u0003" || token.bytes === "\u0015") session.typed = "";
  else if (token.bytes === "\u007f") session.typed = session.typed?.slice(0, -1) ?? null;
  else if (["up", "down", "pageup", "pagedown", "tab", "ctrl+r", "ctrl+p", "ctrl+n"].includes(token.key)) session.typed = null;
}

/** Types what the node sends, judging each line before its Enter; answers the screen after. */
async function sendTo(app: App, request: LiveRequest, session: TerminalSession): Promise<CodeAnswer> {
  if (session.ended) return answer(200, { ...(await sessionView(session)) });
  if (session.controlledBy) return answer(409, { error: "Your owner has taken control of this terminal from the web. terminal_read shows what they do; try again once they hand it back.", ...(await sessionView(session)) });
  const tokens = tokensOf(request);
  if (typeof tokens === "string") return answer(400, { error: tokens });
  await refreshRules(app, session);
  session.lastUsed = Date.now();
  const promptsBefore = session.prompts;
  let submitted = false;
  for (const token of tokens) {
    if (session.ended) break;
    const enter = "key" in token && submits(token.bytes);
    if (enter) {
      // What the shell would run: the node's own record of what it typed since the prompt and, at the prompt, the input as the screen shows it.
      await settle(session, 40, 400);
      const shell = atPrompt(session) || (session.bash && session.awaiting);
      const lines = [[...session.typedLines, session.typed ?? ""].join("\n"), shell ? (promptLine(session, session.bash && session.awaiting) ?? "") : ""];
      const why = lines.map((line) => judgeLine(line, { shell, network: session.network, cwd: session.folder.path })).find(Boolean);
      if (why) {
        // Not run: at the shell its whole input is dropped (Ctrl+C, a continued line too); in a program the line is cleared (to its end, then all of it).
        write(session, shell ? "\u0003" : "\u0005\u0015");
        session.typed = "";
        session.typedLines = [];
        await settle(session, 60, 400);
        await ledger("node.tool.refused", { nodeId: request.nodeId, tool: "terminal_send", session: session.id });
        return answer(403, { error: why, ...(await sessionView(session)) });
      }
      const program = (lines[1] || lines[0] || "").trim().split(/\s+/)[0]?.slice(0, 60) ?? "";
      if (program) await ledger("node.tool.terminal_line", { nodeId: request.nodeId, session: session.id, program, prompt: shell });
      // Until the shell runs it (a line ending in `\`, an open quote), the next line is judged with this one.
      if (shell) session.typedLines.push(session.typed ?? "");
      session.typed = "";
      submitted = true;
    }
    track(session, token);
    write(session, "text" in token ? token.text : session.term.modes.applicationCursorKeysMode && token.app ? token.app : token.bytes);
    if ("key" in token) await sleep(30);
  }
  const waitMs = request.waitMs ?? (submitted ? 3_000 : 1_000);
  if (submitted) {
    if (await promptAfter(session, promptsBefore, waitMs)) await settle(session, 60, 500);
  } else await settle(session, 250, waitMs);
  session.lastUsed = Date.now();
  return answer(200, { ...(await sessionView(session)) });
}

/** Ends a session: its shell and everything it started are stopped, its live card ends. */
export async function closeSession(id: string, reason: string, exitCode: number | null = null): Promise<boolean> {
  const session = sessions.get(id);
  if (!session || session.ended) return false;
  session.ended = { reason, exitCode };
  for (const timer of session.timers) clearTimeout(timer);
  session.prompt?.marker.dispose();
  // The size helper waits on its pipe: told to stop before the shell goes.
  await tellSize(session, 0, 0).catch(() => undefined);
  killGroup(`node-live:${id}`);
  session.events.emit("ended", "ended" satisfies SessionChange);
  await Promise.race([session.done, sleep(2_000)]);
  session.forget();
  sessions.delete(id);
  await rm(join(session.fifo, ".."), { recursive: true, force: true }).catch(() => undefined);
  await ledger("node.tool.terminal_session", { nodeId: session.nodeId, session: id, action: "close", reason, exitCode, minutes: Math.round((Date.now() - session.startedAt) / 60_000) });
  await session.client.liveEnded?.(id, { reason, exitCode }).catch(() => undefined);
  // The screen stays readable for a viewer that is still closing.
  setTimeout(() => session.term.dispose(), 5_000).unref();
  return true;
}

/** The owner types into a session from the web (watching or in control): characters as typed, Enter as "\r". */
export function ownerType(session: TerminalSession, text: string): void {
  if (session.ended) return;
  session.lastUsed = Date.now();
  if (session.typed !== null) session.typed = null;
  write(session, text.replace(/\r\n|\n/g, "\r"));
}

/** The owner presses a named key; false for a name this terminal does not know. */
export function ownerKey(session: TerminalSession, name: string): boolean {
  const key = namedKey(name);
  if (!key || session.ended) return false;
  session.lastUsed = Date.now();
  session.typed = null;
  write(session, keyBytes({ key }, session.term.modes.applicationCursorKeysMode));
  return true;
}

/** Shows the session at a new size: the headless screen and the terminal the shell sees. */
export async function resizeSession(session: TerminalSession, columns: number, rows: number): Promise<void> {
  if (session.ended || (session.columns === columns && session.rows === rows)) return;
  session.columns = columns;
  session.rows = rows;
  session.term.resize(columns, rows);
  await tellSize(session, columns, rows);
  session.events.emit("change", "size" satisfies SessionChange);
}

/** Someone watches it from the web (no idle end meanwhile); when the last one leaves it goes back to the node's size. */
export function watchSession(session: TerminalSession, on: boolean): void {
  session.viewers = Math.max(0, session.viewers + (on ? 1 : -1));
  session.lastUsed = Date.now();
  if (!on && !session.viewers) {
    session.controlledBy = null;
    void resizeSession(session, session.opened.columns, session.opened.rows);
  }
}

/** The owner takes control of a session from the web (the node's typing waits), or hands it back. */
export function controlSession(session: TerminalSession, takeoverId: string, on: boolean): void {
  if (on) session.controlledBy = takeoverId;
  else if (session.controlledBy === takeoverId) session.controlledBy = null;
  session.events.emit("change", "control" satisfies SessionChange);
}

/** Watched tabs with a live card: their end is told to the web. */
const watchedTabs = new Map<string, { tab: string; operation: string; timer: NodeJS.Timeout }>();

/** Checks the node's tab is its own, and tells the web when it closes (the live card ends). */
async function watchTab(client: HostedClient, request: LiveRequest): Promise<CodeAnswer> {
  if (!request.tab || !request.liveId) return answer(400, { error: "Name the tab and the live view." });
  let tab;
  try {
    tab = browserBroker().ownerTab(request.tab);
  } catch {
    return answer(404, { error: `There is no tab ${request.tab}: open one with browser_open first.` });
  }
  if (tab.operation !== request.operation) return answer(404, { error: `Tab ${request.tab} is not yours.` });
  const liveId = request.liveId;
  if (!watchedTabs.has(liveId)) {
    const check = () => {
      let open = false;
      try {
        open = browserBroker().ownerTab(request.tab!).operation === request.operation;
      } catch {
        open = false;
      }
      if (open) return;
      const watched = watchedTabs.get(liveId);
      if (watched) clearInterval(watched.timer);
      watchedTabs.delete(liveId);
      void client.liveEnded?.(liveId, { reason: "tab_closed" }).catch(() => undefined);
    };
    const timer = setInterval(check, 5_000);
    timer.unref();
    watchedTabs.set(liveId, { tab: request.tab, operation: request.operation, timer });
  }
  const url = tab.sensitive ? "" : tab.page.url().split(/[?#]/)[0]!.slice(0, 2000);
  const title = tab.sensitive ? "" : await tab.page.title().catch(() => "");
  return answer(200, { tab: request.tab, url, title: title.slice(0, 300) });
}

/** A node's `live` call here; the folder of `terminal_open` was judged already. */
export async function runNodeLive(app: App, client: HostedClient, request: LiveRequest, folder: ToolFolder | null): Promise<CodeAnswer> {
  if (request.action === "browser_tab") return watchTab(client, request);
  if (request.action === "terminal_open") {
    if (!folder) return answer(400, { error: "That request could not be read." });
    return openSession(app, client, request, folder);
  }
  const session = ownSession(request);
  if (!("id" in session)) return session;
  if (request.action === "terminal_send") return sendTo(app, request, session);
  if (request.action === "terminal_close") {
    await closeSession(session.id, "closed");
    return answer(200, { session: session.id, ended: true, exitCode: null });
  }
  await refreshRules(app, session);
  return answer(200, { ...(await sessionView(session, request.lines)) });
}

/** Ends every session here (the remote loop is ending). */
export async function closeAllSessions(reason: string): Promise<void> {
  for (const id of [...sessions.keys()]) await closeSession(id, reason);
  for (const [liveId, watched] of watchedTabs) {
    clearInterval(watched.timer);
    watchedTabs.delete(liveId);
  }
}
