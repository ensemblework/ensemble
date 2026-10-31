/**
 * A node's `terminal` call (nodeTools 2): a command in a pseudo-terminal of `columns` × `rows`
 * (util-linux `script` on Linux, the BSD one on macOS), judged and sandboxed like `run` (its folder
 * writable, the never-list refused, the internet as the call says), but able to list this computer's
 * processes where that is safe (`hostPids`, workspace/sandbox/linux.ts), so htop and top show the
 * real system. Keys the node gives are typed once it has started. After `seconds`, or when it ends if
 * sooner, its screen, replayed in a headless terminal (capture/screen.ts), is rendered to a PNG in
 * the operation's evidence folder, secrets hidden, and kept as the node's evidence like a capture;
 * then it is stopped (SIGTERM, then SIGKILL a second later). A full-screen program that quits (a key
 * typed) is pictured as it last drew; an empty screen keeps no picture, and the node is told why. Without a pseudo-terminal (Windows, or
 * no `script`), the command runs as `run` runs it and its output becomes a transcript image.
 */
import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { hideSecrets, type PrivacyRules } from "../browser/privacy.js";
import { captureService } from "../capture/index.js";
import { slugName, type MediaFile } from "../capture/media.js";
import { drawn, headlessTerminal, holdAlternateScreen, renderScreen, screenViewport } from "../capture/screen.js";
import { findOnPath } from "../capture/system.js";
import { settleLines, stripAnsi } from "../capture/terminal.js";
import { capturedFiles } from "../evidence/captures.js";
import { operationEvidenceDir } from "../evidence/files.js";
import { appendLedger } from "../lib/ledger.js";
import { savedSecretValues } from "../lib/run-secrets.js";
import type { HostedClient } from "../remote/client.js";
import type { NodeCaptureAnswer, NodeToolRequest } from "../remote/contract.js";
import { checkProgram, GuardError, parseCommand, sandboxAvailable } from "../workspace/guard.js";
import { killGroup, runCommand } from "../workspace/runner.js";
import { parseShell } from "../workspace/shell-parse.js";
import { keepEvidence } from "./capture.js";
import { nodeToolDenies, type ToolFolder } from "./folders.js";
import { stopWithCommands } from "./run.js";

type TerminalRequest = Extract<NodeToolRequest, { tool: "terminal" }>;
type App = Pick<FastifyInstance, "prisma">;

/** What one key name types: as a terminal sends it, and (`app`) when the program asked for application cursor keys. */
type KeyCode = { normal: string; app?: string };

const ESC = "\u001b";
const NAMED: Record<string, KeyCode> = {
  enter: { normal: "\r" },
  return: { normal: "\r" },
  escape: { normal: ESC },
  esc: { normal: ESC },
  tab: { normal: "\t" },
  "shift+tab": { normal: `${ESC}[Z` },
  backspace: { normal: "\u007f" },
  space: { normal: " " },
  up: { normal: `${ESC}[A`, app: `${ESC}OA` },
  down: { normal: `${ESC}[B`, app: `${ESC}OB` },
  right: { normal: `${ESC}[C`, app: `${ESC}OC` },
  left: { normal: `${ESC}[D`, app: `${ESC}OD` },
  home: { normal: `${ESC}[H`, app: `${ESC}OH` },
  end: { normal: `${ESC}[F`, app: `${ESC}OF` },
  pageup: { normal: `${ESC}[5~` },
  pagedown: { normal: `${ESC}[6~` },
  insert: { normal: `${ESC}[2~` },
  delete: { normal: `${ESC}[3~` },
  f1: { normal: `${ESC}OP` },
  f2: { normal: `${ESC}OQ` },
  f3: { normal: `${ESC}OR` },
  f4: { normal: `${ESC}OS` },
  f5: { normal: `${ESC}[15~` },
  f6: { normal: `${ESC}[17~` },
  f7: { normal: `${ESC}[18~` },
  f8: { normal: `${ESC}[19~` },
  f9: { normal: `${ESC}[20~` },
  f10: { normal: `${ESC}[21~` },
  f11: { normal: `${ESC}[23~` },
  f12: { normal: `${ESC}[24~` },
};
const ALIASES: Record<string, string> = { pgup: "pageup", pgdn: "pagedown", pgdown: "pagedown", del: "delete", ins: "insert", arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", backtab: "shift+tab" };
/** Control characters that are not letters: Ctrl+[ is Escape, Ctrl+? is Delete. */
const CTRL_SYMBOLS: Record<string, string> = { "@": "\u0000", space: "\u0000", "[": ESC, "\\": "\u001c", "]": "\u001d", "^": "\u001e", _: "\u001f", "?": "\u007f" };

/** A key name in braces ({Enter}, {Ctrl+C}, {Alt+x}, {F10}), as what it types; null when it names no key. */
export function namedKey(name: string): KeyCode | null {
  const key = name.trim().toLowerCase().replace(/\s+/g, "").replace(/^(control|ctl)[+-]/, "ctrl+").replace(/^(ctrl|alt|shift|meta|option)-/, "$1+");
  const known = NAMED[ALIASES[key] ?? key];
  if (known) return known;
  const ctrl = /^ctrl\+(.+)$/.exec(key)?.[1];
  if (ctrl) {
    if (/^[a-z]$/.test(ctrl)) return { normal: String.fromCharCode(ctrl.charCodeAt(0) & 0x1f) };
    const symbol = CTRL_SYMBOLS[ctrl];
    return symbol === undefined ? null : { normal: symbol };
  }
  const alt = /^(?:alt|meta|option)\+(.+)$/.exec(key)?.[1];
  if (alt) {
    // Alt sends Escape first; a letter keeps the case it was written in.
    const original = /\+(.)$/.exec(name.trim())?.[1];
    if (alt.length === 1) return { normal: `${ESC}${original ?? alt}` };
    const inner = namedKey(alt);
    return inner ? { normal: `${ESC}${inner.normal}`, ...(inner.app ? { app: `${ESC}${inner.app}` } : {}) } : null;
  }
  return null;
}

export type KeyToken = { text: string } | { key: KeyCode };

/** What the `keys` type, in order: plain text, and key names in braces; braces that name no key are typed as written. */
export function keyTokens(keys: readonly string[]): KeyToken[] {
  const tokens: KeyToken[] = [];
  for (const entry of keys) {
    let last = 0;
    for (const match of entry.matchAll(/\{([^{}]{1,24})\}/g)) {
      const key = namedKey(match[1]!);
      if (!key) continue;
      if (match.index! > last) tokens.push({ text: entry.slice(last, match.index) });
      tokens.push({ key });
      last = match.index! + match[0].length;
    }
    if (last < entry.length) tokens.push({ text: entry.slice(last) });
  }
  return tokens;
}

/** The bytes one token types now. */
export function keyBytes(token: KeyToken, applicationCursor: boolean): string {
  if ("text" in token) return token.text;
  return applicationCursor && token.key.app ? token.key.app : token.key.normal;
}

const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * The pseudo-terminal's command: `script` sets the terminal's size and runs the node's command in it
 * (through the shell in the sandbox, where shell syntax is the sandbox's to contain; as one program
 * outside it).
 */
export function ptyArgv(platform: string, input: { command: string; columns: number; rows: number; shell: boolean }): string[] {
  const program = input.shell ? `/bin/sh -c ${shellQuote(input.command)}` : parseCommand(input.command).map(shellQuote).join(" ");
  const line = `stty cols ${input.columns} rows ${input.rows} 2>/dev/null; exec ${program}`;
  return platform === "darwin" ? ["script", "-q", "/dev/null", "/bin/sh", "-c", line] : ["script", "-qfec", line, "/dev/null"];
}

/** The terminal's environment: a colour terminal of its size, in this computer's language (UTF-8). */
export function terminalEnv(columns: number, rows: number, lang = process.env.LANG): Record<string, string> {
  const locale = lang && /utf-?8/i.test(lang) ? lang : "C.UTF-8";
  return { TERM: "xterm-256color", COLORTERM: "truecolor", COLUMNS: String(columns), LINES: String(rows), LANG: locale, LC_ALL: locale, SHELL: "/bin/sh" };
}

/** The terminal's output a screen replays at most: past this a flood (`yes`) is no longer drawn. */
const MAX_SCREEN_BYTES = 16 * 1024 * 1024;
/** How long the program has to draw before the first key, and between keys. */
const FIRST_KEY_MS = 1_000;
const KEY_GAP_MS = 150;

type Ran = { exitCode: number | null; ended: boolean; ms: number };

/** Checks the command like `run` checks its programs; a shell line only where the OS sandbox contains it. */
function checkCommand(command: string, folder: ToolFolder, sandboxed: boolean, network: boolean, shell: boolean): string {
  if (!shell) return checkProgram(parseCommand(command), { who: "agent", sandboxed, network });
  const segments = parseShell(command, folder.path).filter((segment) => segment.argv.length);
  if (!segments.length) throw new GuardError("Type a command.");
  for (const segment of segments) checkProgram(segment.argv, { who: "agent", sandboxed, network });
  return segments[0]!.argv[0]!.split(/[\\/]/).pop()!;
}

/** Runs the command in a pseudo-terminal, types the keys, and returns its screen at the end. */
async function ptyScreen(request: TerminalRequest, folder: ToolFolder, input: { platform: string; sandboxed: boolean; rules: PrivacyRules; title: string }): Promise<Ran & { screen: ReturnType<typeof renderScreen>; hostPids: boolean }> {
  const term = await headlessTerminal(request.columns, request.rows);
  const held = holdAlternateScreen(term);
  const group = `node-terminal:${request.id}`;
  const controller = new AbortController();
  let child: ChildProcess | null = null;
  let hostPids = false;
  let fed = 0;
  let started!: () => void;
  const output = new Promise<void>((resolve) => (started = resolve));
  const forget = stopWithCommands(group, () => controller.abort());
  const begun = Date.now();
  const tokens = keyTokens(request.keys);
  const done = runCommand({
    userId: env.ENSEMBLE_DEV_USER_ID,
    argv: ptyArgv(input.platform, { command: request.command, columns: request.columns, rows: request.rows, shell: input.sandboxed }),
    cwd: folder.path,
    root: folder.path,
    sandboxed: input.sandboxed,
    network: request.network,
    useCredentials: false,
    who: "agent",
    readWrite: [folder.path],
    deny: await nodeToolDenies(),
    timeoutMs: (request.seconds + 30 + tokens.length) * 1000,
    signal: controller.signal,
    group,
    extraEnv: terminalEnv(request.columns, request.rows),
    unsetEnv: ["NO_COLOR", "CI"],
    stdin: true,
    hostPids: true,
    onSpawn: (spawned, prepared) => {
      child = spawned;
      hostPids = prepared.hostPids === true;
      spawned.stdin?.on("error", () => undefined);
    },
    onData: (chunk) => {
      started();
      if (fed >= MAX_SCREEN_BYTES) return;
      fed += chunk.length;
      term.write(chunk);
    },
  });
  // The terminal's own answers (where the cursor is, what it is) go back to the program, as a real terminal's do.
  const answers = term.onData((reply) => {
    const stdin = (child as ChildProcess | null)?.stdin;
    if (stdin?.writable) stdin.write(reply);
  });
  const outcome = done.then(
    (result) => ({ result, error: null as unknown }),
    (error: unknown) => ({ result: null, error }),
  );
  let over = false;
  void outcome.then(() => (over = true));
  try {
    if (tokens.length) {
      await Promise.race([output.then(() => sleep(300)), sleep(FIRST_KEY_MS), outcome]);
      for (const token of tokens) {
        if (over) break;
        const stdin = (child as ChildProcess | null)?.stdin;
        if (stdin?.writable) stdin.write(keyBytes(token, term.modes.applicationCursorKeysMode));
        await sleep(KEY_GAP_MS);
      }
    }
    const rest = Math.max(request.seconds * 1000 - (Date.now() - begun), tokens.length ? 500 : 0);
    const ended = await Promise.race([outcome.then(() => true), sleep(rest).then(() => false)]);
    const finished = ended ? await outcome : null;
    if (finished?.error) throw finished.error;
    await drawn(term);
    const screen = renderScreen(term, { title: input.title, rules: input.rules });
    const ms = Date.now() - begun;
    if (!ended) {
      const pid = (child as ChildProcess | null)?.pid;
      if (pid && process.platform !== "win32") {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      if (!(await Promise.race([outcome.then(() => true), sleep(1_000).then(() => false)]))) controller.abort();
      await outcome;
    }
    return { screen, exitCode: ended ? (finished?.result?.exitCode ?? null) : null, ended, ms, hostPids };
  } finally {
    answers.dispose();
    held.dispose();
    controller.abort();
    killGroup(group);
    forget();
    term.dispose();
  }
}

/** Without a pseudo-terminal: the command runs as `run` runs it, for at most `seconds`, and its output is the transcript. */
async function plainTranscript(request: TerminalRequest, folder: ToolFolder, sandboxed: boolean, shell: boolean): Promise<Ran & { transcript: string; hostPids: boolean }> {
  const group = `node-terminal:${request.id}`;
  const controller = new AbortController();
  const forget = stopWithCommands(group, () => controller.abort());
  const begun = Date.now();
  let hostPids = false;
  try {
    const result = await runCommand({
      userId: env.ENSEMBLE_DEV_USER_ID,
      argv: shell ? ["sh", "-c", request.command] : parseCommand(request.command),
      cwd: folder.path,
      root: folder.path,
      sandboxed,
      network: request.network,
      useCredentials: false,
      who: "agent",
      readWrite: [folder.path],
      deny: await nodeToolDenies(),
      timeoutMs: request.seconds * 1000,
      signal: controller.signal,
      group,
      extraEnv: { COLUMNS: String(request.columns), LINES: String(request.rows) },
      hostPids: true,
      onSpawn: (_child, prepared) => (hostPids = prepared.hostPids === true),
    });
    return { transcript: result.output, exitCode: result.timedOut ? null : result.exitCode, ended: !result.timedOut, ms: Date.now() - begun, hostPids };
  } finally {
    killGroup(group);
    forget();
  }
}

/** The screen as text from a transcript: what its last rows showed, secrets hidden. */
function transcriptText(transcript: string, rows: number, rules: PrivacyRules): string {
  const lines = hideSecrets(stripAnsi(settleLines(transcript.replace(/\r\n/g, "\n"))), rules).split("\n");
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.slice(-rows).map((line) => line.trimEnd()).join("\n");
}

/** Runs the call, keeps its screen as the node's evidence, and answers. */
export async function runNodeTerminal(app: App, client: HostedClient, request: TerminalRequest, folder: ToolFolder, options: { platform?: string; pty?: boolean } = {}): Promise<NodeCaptureAnswer> {
  const userId = env.ENSEMBLE_DEV_USER_ID;
  const platform = options.platform ?? process.platform;
  const sandboxed = sandboxAvailable();
  // A shell line needs the OS sandbox around it (and Windows has no /bin/sh): elsewhere one program, as `run` takes it.
  const shell = sandboxed && platform !== "win32";
  const program = checkCommand(request.command, folder, sandboxed, request.network, shell);
  const pty = options.pty ?? (platform !== "win32" && Boolean(findOnPath("script")));
  const evidenceDir = operationEvidenceDir(request.operation);
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const rules: PrivacyRules = { secretValues: await savedSecretValues(app.prisma, userId).catch(() => [] as string[]) };
  const title = request.title?.trim() || `${program} — ${folder.label}`;
  const name = slugName(request.title ?? `terminal ${program}`, "terminal");
  const capture = { operation: request.operation, evidenceDir, network: request.network, loopbackOnly: !request.network };
  let ran: Ran;
  let screen: string;
  let hostPids = true;
  let shot: () => Promise<MediaFile>;
  if (pty) {
    const result = await ptyScreen(request, folder, { platform, sandboxed, rules, title });
    ({ hostPids } = result);
    ran = result;
    screen = result.screen.text;
    shot = () => captureService().then((service) => service.htmlScreenshot(capture, { html: result.screen.html, name, viewport: screenViewport(request.columns, request.rows), element: "#term", title }));
  } else {
    const result = await plainTranscript(request, folder, sandboxed, shell);
    ({ hostPids } = result);
    ran = result;
    screen = transcriptText(result.transcript, request.rows, rules);
    shot = () => captureService().then((service) => service.screenshot(capture, { kind: "terminal", transcript: result.transcript, title, columns: request.columns }, name));
  }
  const view = ran.ended ? `It ended (exit code ${ran.exitCode ?? "unknown"}).` : `It was still running after ${request.seconds} s and was stopped after the capture.`;
  const processes = hostPids || platform !== "linux" ? "" : " Only its own processes were visible to it: this computer cannot show it the others safely.";
  const result = { screen, exitCode: ran.exitCode, ended: ran.ended };
  let answer: NodeCaptureAnswer;
  if (!screen.trim()) {
    // An empty picture is worth nothing to the owner: the node is told why, and nothing is kept.
    const why = ran.ended
      ? `${view} If a key you typed quit it (q, {F10}, {Ctrl+C}), leave the keys out: it is stopped by itself after the picture.`
      : `${view} Give it more seconds to draw.`;
    answer = { ok: false, error: { code: "empty_screen", message: `The terminal was empty when the picture was taken, so no picture was kept. ${why}` }, result, evidence: [], refused: [] };
    await appendLedger({ userId, actor: "agent", action: "node.tool.terminal", payload: { nodeId: request.nodeId, program, folder: folder.label, exitCode: ran.exitCode, ended: ran.ended, ms: ran.ms, files: 0, empty: true, operationId: request.operationId ?? null } }).catch(() => undefined);
    return answer;
  }
  try {
    const file = await shot();
    const kept = await keepEvidence(app, client, { nodeId: request.nodeId, operation: request.operation, uploadId: request.uploadId }, capturedFiles(file));
    answer = { ok: true, summary: `The terminal running \`${request.command.slice(0, 120)}\` (${request.columns}×${request.rows}), as an image. ${view}${processes}`, result, ...kept };
  } catch (error) {
    const why = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    answer = { ok: false, error: { code: "capture_failed", message: `The screen could not be made into an image (${why}). ${view} The screen showed:\n${screen}`.slice(0, 2000) }, result, evidence: [], refused: [] };
  }
  await appendLedger({ userId, actor: "agent", action: "node.tool.terminal", payload: { nodeId: request.nodeId, program, folder: folder.label, exitCode: ran.exitCode, ended: ran.ended, ms: ran.ms, files: answer.evidence.length, operationId: request.operationId ?? null } }).catch(() => undefined);
  return answer;
}
