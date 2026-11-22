/**
 * The agent's own calls in an Ensemble Node's turn on its owner's plan (its shell, files and web), judged
 * on this computer (docs/35 §8.13). Only a turn its owner started and only they read has them
 * (node/brain.ts); every other turn has Ensemble's tools only.
 *
 * - Refused, with why: the hard floor (keys and sign-ins, the system's files, Ensemble's own code and
 *   data, dangerous commands, a search through a folder that holds those: judge.ts `judgeFloor`) and
 *   answering or changing Ensemble's own approvals.
 * - `sudo` and the other privilege prompts: the agent's shell has no terminal to type a password into,
 *   so it is told to use computer_sudo, where its owner approves the command and types the password.
 * - Allowed: reads anywhere above the floor, web searches and public web pages, Ensemble's own tools
 *   (judged where they run).
 * - Commands and file changes: allowed in the node's own folders (the turn's folder, which is the node's
 *   project folder, its `nodes/<handle>` folder, Ensemble's other work folders), in the computer's
 *   temporary folders, in a folder an answer covers, and in an unattended run.
 * - Anything else asks its owner, once per folder: Ensemble on the web posts a card in the node's chat and
 *   holds the call up to 90 seconds (node/own-tool-asks.ts). An answer allows changes and commands in that
 *   folder from then on or for this run (this conversation or plan, for 30 days at most). Not answered in
 *   time: the call is refused with a note to stop here, every later call of the turn too, and the turn parks.
 * - Always asked, unattended too: a program that changes the system (crontab, launchctl, osascript…),
 *   answered at most for the run, and a read or change that names no path the floor could check, answered
 *   for that call only.
 * - The person's own MCP servers' tools (the agent loads them itself; Copilot's keep their server's name,
 *   agent-mcp.ts) and the agent's tools Ensemble does not know: one whose input names a command is judged
 *   as that command (where it does not say where it runs, as if in the home folder), one that names files
 *   in full as reading or changing them, by its name; a server that says it only reads is allowed. Any
 *   other asks, unattended too, with the tool and its input, answered at most for the run.
 * - A shell keeps the folder a `cd` took it to: its next commands are judged there too.
 * - A helper works only in the folders its node gave it, its own folders and temporary ones; the folders
 *   it was given are not its own, so their first change or command asks.
 *
 * The answers are this computer's own rules (`OWN_RULES`), apart from the node's computer tools' (which
 * run in the OS sandbox): one from then on with no end, one for this run only in the turns of its plan or
 * conversation and until Ensemble stops answering from it (`ruleLapses`). Calls asking about the same thing
 * at once share one question.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { env } from "../config.js";
import { prisma as defaultPrisma } from "../lib/prisma.js";
import { NODE_TOOL_RULE_SOURCE } from "../device-tools/policy.js";
import { isEnsembleWorkFolder, ownFolderName, resolveToolFolder } from "../device-tools/folders.js";
import { publicWebAddress } from "../device-tools/http.js";
import { loadSettings } from "../remote/store.js";
import { expandHome, harmlessPath, inTemp, isNeverProgram, outsideRefusal, within, workspaceRoot } from "../workspace/guard.js";
import { gitWrites } from "../workspace/git-read.js";
import { globRoot, HARMLESS, judgeFloor, pathsOf, type EngineAnswer, type EngineCall } from "../workspace/engines/judge.js";
import { parseShell } from "../workspace/shell-parse.js";
import { gitReadSafeAt, outsideArgs, realOutside, segmentReadsOnly } from "../workspace/tools.js";
import type { AgentMcpServer } from "./agent-mcp.js";
import { OWN_ANSWER_DAYS, type OwnAnswer, type OwnAsk, type OwnAskKind, type OwnJudge, type OwnVerdict } from "./bridge.js";
import { logRefused } from "./own-tools.js";

/**
 * An Ensemble Node's turn with the agent's own tools (`assistantTurns` 5), which only its owner started and
 * only they read: how its calls are judged here. `mission`: what "for this run" covers (the plan the turn
 * works for, else its conversation). `attended` false: nobody watches the run (a routine, an unattended run
 * profile), so changes and commands run above the floor. `sudo`: computer_sudo is in the turn. `folders`:
 * a helper's folders (labels or full paths), the only ones it works in.
 */
export type NodeTurnPolicy = { id: string; slug: string; mission: string; attended: boolean; sudo: boolean; folders?: string[] };

/**
 * This computer's answers about the agent's own calls (`decision_rules.tool_name`, source `node-tools`):
 * changes and commands in a folder, calls to an address, or one program or one tool for one run. The
 * node's computer tools keep theirs as `folder` and `origin`, which never count here.
 */
export const OWN_RULES = { write: "own:write", origin: "own:origin", program: "own:program", tool: "own:tool" } as const;
/** What an answer covers at most for the run, never from then on. */
const RUN_ONLY: ReadonlySet<OwnAskKind> = new Set(["program", "tool"]);
const DAY_MS = 86_400_000;

/**
 * When one of this computer's answers about the agent's own calls stops counting, in milliseconds: one for
 * this run (`sessionId`, its plan or conversation) at its `expiresAt`, when Ensemble on the web stops answering
 * from it; kept before rules carried that, `OWN_ANSWER_DAYS` after it was kept. One from then on: never.
 */
export function ruleLapses(rule: { sessionId: string | null; createdAt: Date; expiresAt: Date | null }): number {
  if (rule.expiresAt) return rule.expiresAt.getTime();
  return rule.sessionId === null ? Number.POSITIVE_INFINITY : rule.createdAt.getTime() + OWN_ANSWER_DAYS * DAY_MS;
}

type Db = Pick<PrismaClient, "decisionRule">;

export type NodeJudgeInput = {
  /** The turn's own folder on this computer: the node's project folder. */
  folder: string;
  node: NodeTurnPolicy;
  /** Asks the owner through Ensemble on the web; absent, a call that needs them is refused. */
  ask?: (request: OwnAsk) => Promise<OwnAnswer>;
  /** The MCP servers the agent loads by itself here besides Ensemble's (agent-mcp.ts): how its calls to them are named. */
  mcpServers?: AgentMcpServer[];
  /** The agent, for the AI activity log. */
  app: string;
  /** How each call was answered, for the turn's trace: allowed with no question, asked and allowed by the owner, or refused. */
  onVerdict?: (call: EngineCall, verdict: OwnVerdict) => void;
  /** Tests: the database, account and approval switch to use. */
  db?: Db;
  userId?: string;
  acceptWeb?: boolean;
};

const ALLOW: EngineAnswer = { decision: "allow" };
const deny = (message: string): EngineAnswer => ({ decision: "deny", message });

/** The call being judged: whether its answer came from the owner (a call can wait on another's question). */
const judging = new AsyncLocalStorage<{ asked: boolean }>();
const noteAsked = () => {
  const state = judging.getStore();
  if (state) state.asked = true;
};

/** Programs that ask for a password on a terminal the agent's shell does not have. */
const PRIVILEGE = new Set(["sudo", "su", "doas", "pkexec", "runas", "gsudo"]);
const programOf = (word: string) => word.split(/[\\/]/).pop()!.replace(/\.exe$/i, "");

/** Ensemble's routes that answer its approval cards, and the CLI commands that answer or change approvals. */
const CARD_ROUTE = /\/api\/(?:decisions\/[^\s/?#'"]+\/decide|approvals\/[^\s/?#'"]+\/decide|code\/decide|node\/(?:approvals|sudo|secrets|logins)\/[^\s/?#'"]+)/i;
const CARDS = "Only your owner answers Ensemble's approval cards or changes its approvals: ask them in your reply instead.";

/** The computer's sign-in stores read through their programs (the macOS keychain, the Linux secret service): the hard floor, like their files. */
function readsSignIns(program: string, argv: string[]): boolean {
  if (program === "security") return argv.slice(1).some((arg) => /^(find-generic-password|find-internet-password|dump-keychain|export|export-pkcs12)$/.test(arg));
  if (program === "secret-tool") return argv.slice(1).some((arg) => arg === "lookup" || arg === "search");
  return false;
}
const SIGN_INS = "That reads the computer's saved passwords and keys, which never leave it through an agent.";

const WRITES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELLS = new Set(["Bash", "PowerShell"]);
/** Reads of named files, and searches (which look in the turn's folder when they name none), as the judge names them. */
const FILE_READS = new Set(["Read", "NotebookRead"]);
const SEARCHES = new Set(["Grep", "Glob", "LS"]);

/** Ensemble's MCP tools as each agent names them: judged where they run, on the web. */
const ensembleTool = (name: string) => /^(?:mcp__ensemble__|ensemble[-_./:])/.test(name);

/** The agents' own bookkeeping, Claude Code's (judge.ts) and GitHub Copilot CLI's: nothing outside the agent itself. */
const BOOKKEEPING: ReadonlySet<string> = new Set([
  ...HARMLESS,
  "AskUserQuestion",
  "report_intent", "think", "update_todo", "read_bash", "list_bash", "stop_bash", "task", "read_agent", "list_agents", "write_agent", "skill", "fetch_copilot_cli_documentation", "tool_search_tool", "sql",
]);

/**
 * The server and tool an MCP call names: `mcp__<server>__<tool>` (Claude Code, ACP agents), or GitHub
 * Copilot CLI's `<server>-<tool>` for a server it loads here (its name with every character but letters,
 * digits, _ and - as -). Never Ensemble's.
 */
function mcpOf(name: string, servers: AgentMcpServer[]): { server: string; tool: string; readOnly: boolean } | null {
  const pair = /^mcp__(.+?)__(.+)$/.exec(name);
  if (pair) return pair[1] === "ensemble" ? null : { server: pair[1]!, tool: pair[2]!, readOnly: servers.some((server) => server.name === pair[1] && server.readOnly) };
  let found: { server: AgentMcpServer; prefix: number } | null = null;
  for (const server of servers) {
    const prefix = `${server.name.replace(/[^A-Za-z0-9_-]/g, "-")}-`;
    if (server.name !== "ensemble" && name.length > prefix.length && name.startsWith(prefix) && (!found || prefix.length > found.prefix)) found = { server, prefix: prefix.length };
  }
  return found ? { server: found.server.name, tool: name.slice(found.prefix), readOnly: found.server.readOnly } : null;
}

const COMMAND_FIELDS = ["command", "cmd", "script", "shell_command", "commandLine"];
const PLACE_FIELDS = ["cwd", "workdir", "working_directory", "workingDirectory", "directory", "dir"];
const PATH_FIELDS = ["path", "paths", "file_path", "filePath", "file", "files", "filename", "fileName", "absolute_path", "directory", "dir", "folder", "source", "destination", "src", "dest", "from", "to", "old_path", "new_path", "oldPath", "newPath"];
/** A path given in full: from the top of the disk or the home folder. */
const FULL_PATH = /^(?:~(?=[\\/]|$)|[\\/]|[A-Za-z]:[\\/])/;

/** The words of a tool's name that say what it does with the files it names. */
const CHANGE_WORDS = new Set([
  "write", "edit", "create", "move", "rename", "delete", "remove", "rm", "rmdir", "mkdir", "append", "patch", "replace", "set", "update", "insert", "save", "copy", "cp", "mv",
  "put", "upload", "download", "touch", "chmod", "chown", "truncate", "unlink", "extract", "unzip", "untar", "zip", "archive", "compress", "apply", "modify", "change", "overwrite",
  "clear", "empty", "format", "convert", "store", "merge", "restore", "import", "export", "link", "symlink", "mount", "unmount", "trash", "purge", "wipe", "destroy", "drop", "reset", "new", "add", "make",
]);
const SEARCH_WORDS = new Set(["search", "find", "grep", "glob", "scan"]);
const LIST_WORDS = new Set(["list", "ls", "tree", "dir"]);
const READ_WORDS = new Set(["read", "get", "view", "show", "stat", "info", "cat", "head", "tail", "exists", "describe", "inspect", "lookup", "count", "diff", "compare", "check", "preview", "peek"]);

/**
 * The call a tool Ensemble does not know makes, where its input says: a command (run where it says, else
 * in `away`), or files it names in full that it reads, searches, lists or changes by the words of its
 * name. Null when nothing says: no command, a path not given in full (found where the tool runs, which is
 * not known here), or a name that says neither.
 */
function shapeOf(tool: string, input: Record<string, unknown>, away: string | null): EngineCall | null {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const command = COMMAND_FIELDS.map((field) => text(input[field])).find(Boolean);
  if (command) {
    const place = PLACE_FIELDS.map((field) => text(input[field])).find((value) => FULL_PATH.test(value)) ?? away;
    return { tool: "Bash", input: { command, ...(place ? { cwd: place } : {}) } };
  }
  // A value with no folder in it ("README.md", "bob@example.com") is not taken for a path.
  const values = PATH_FIELDS.flatMap((field) => (Array.isArray(input[field]) ? (input[field] as unknown[]) : [input[field]]).map(text)).filter((value) => FULL_PATH.test(value) || /[\\/]/.test(value));
  if (!values.length || values.some((value) => !FULL_PATH.test(value))) return null;
  const words = tool.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  const paths = { paths: [...new Set(values)] };
  if (words.some((word) => CHANGE_WORDS.has(word))) return { tool: "Write", input: paths };
  if (words.some((word) => SEARCH_WORDS.has(word))) return { tool: "Grep", input: paths };
  if (words.some((word) => LIST_WORDS.has(word))) return { tool: "LS", input: paths };
  if (words.some((word) => READ_WORDS.has(word))) return { tool: "Read", input: paths };
  return null;
}

/** What a privilege prompt in the agent's own shell is told. */
export function sudoGuidance(offered: boolean): string {
  const why = "Commands as the administrator (sudo and the like) ask for a password, and your shell has no terminal to type one into.";
  return offered
    ? `${why} Run this one with computer_sudo instead, with the command and why: your owner approves it and types their password on a card in this chat, and you get its output.`
    : `${why} They are not run from this turn: say which command needs it and why.`;
}

/** A path as the owner reads it: under their home folder with ~ (a card's label holds 300 characters). */
function shown(path: string, home = homedir()): string {
  if (path === home) return "~";
  const rel = relative(home, path);
  const text = rel && !rel.startsWith("..") && !isAbsolute(rel) ? `~/${rel.split(/[\\/]/).join("/")}` : path;
  return text.length > 300 ? `…${text.slice(-299)}` : text;
}

const isFolder = (path: string) => stat(path).then((info) => info.isDirectory(), () => false);
const exists = (path: string) => stat(path).then(() => true, () => false);

/**
 * The folder a path belongs to, as one answer covers it: the top of its git work tree, else the folder
 * itself (a file's: the folder it is in). Null for the home folder itself, a path directly in it or at
 * the top of the disk: an answer never covers a whole home folder.
 */
export async function folderOf(path: string, home = homedir()): Promise<string | null> {
  let folder = (await isFolder(path)) ? path : dirname(path);
  while (!(await isFolder(folder)) && dirname(folder) !== folder) folder = dirname(folder);
  if (folder === home || dirname(folder) === folder || dirname(folder) === dirname(home)) return null;
  for (let probe = folder, depth = 0; depth < 40 && probe !== home && dirname(probe) !== probe; probe = dirname(probe), depth += 1) {
    if (await exists(join(probe, ".git"))) return probe;
  }
  return folder;
}

type Need = { kind: OwnAskKind; capability: OwnAsk["capability"]; target: string; label: string; scope: OwnAsk["scope"]; operation: string; what: string; folder: boolean };
type Grant = Extract<OwnAnswer, { decision: "allow" }>["grant"];

/** One call of a node's turn, judged: the floor, the folder policy, the owner's answer. */
export function nodeOwnJudge(input: NodeJudgeInput): OwnJudge {
  const node = input.node;
  const helper = node.folders !== undefined;
  const db = input.db ?? defaultPrisma;
  const userId = input.userId ?? env.ENSEMBLE_DEV_USER_ID;
  let parked: string | null = null;
  let own: Promise<string[]> | null = null;
  let granted: Promise<string[]> | null = null;
  const inflight = new Map<string, Promise<void>>();
  /** The folders besides the turn's that the agent's shells may be in now: a `cd` holds for a shell's next command (Claude Code's, a Copilot shell session's). */
  const shellPlaces = new Set<string>();
  const at = (base: string, path: string) => resolve(base, expandHome(path));

  /** The node's own folders here: the turn's and `nodes/<handle>`. */
  const ownFolders = () =>
    (own ??= (async () => {
      const root = await workspaceRoot().catch(() => null);
      return [input.folder, ...(root ? [join(root, "nodes", ownFolderName({ nodeId: node.id, nodeSlug: node.slug }))] : [])];
    })());

  /** A helper's folders, as its node gave them. */
  const helperFolders = () =>
    (granted ??= (async () => {
      const found = await Promise.all((node.folders ?? []).map((name) => resolveToolFolder(name).then((folder) => folder.path, () => null)));
      return found.filter((path): path is string => Boolean(path));
    })());

  /** A command or a change here needs nobody: a temporary folder or a device file, or one of the node's own (a helper: its own only). */
  const free = async (path: string): Promise<boolean> => {
    if (harmlessPath(path) || inTemp(path)) return true;
    if ((await ownFolders()).some((folder) => within(folder, path))) return true;
    return !helper && (await isEnsembleWorkFolder(path));
  };

  /** A helper's call outside the folders it may use, refused with why; null where it may. */
  const beyond = async (path: string): Promise<EngineAnswer | null> => {
    if (!helper) return null;
    const real = await realOutside(path);
    if (harmlessPath(real) || inTemp(real) || (await ownFolders()).some((folder) => within(folder, real))) return null;
    const folders = await helperFolders();
    if (folders.some((folder) => within(folder, real))) return null;
    const named = folders.map((folder) => shown(folder)).join(", ") || "no folder";
    return deny(`You work only in ${named}, the folders your node gave you, and your own folder. Report what needs another folder.`);
  };

  /**
   * This computer's answers about the agent's own calls that still count (never the node's computer tools'); none it
   * cannot read, so the owner is asked. Those that lapsed leave this computer's rules.
   */
  let pruned = false;
  const kept = async () => {
    const rules = await db.decisionRule
      .findMany({ where: { userId, source: NODE_TOOL_RULE_SOURCE, decision: "allow", toolName: { in: Object.values(OWN_RULES) } }, select: { id: true, toolName: true, pattern: true, sessionId: true, createdAt: true, expiresAt: true }, orderBy: { createdAt: "desc" }, take: 1000 })
      .catch(() => []);
    const now = Date.now();
    const lapsed = rules.filter((rule) => ruleLapses(rule) <= now).map((rule) => rule.id);
    if (lapsed.length && !pruned) {
      pruned = true;
      await db.decisionRule.deleteMany({ where: { id: { in: lapsed } } }).catch(() => undefined);
    }
    return rules.filter((rule) => ruleLapses(rule) > now);
  };

  /** An answer covers this: one of its own kind, for this run or (but a program's or a tool's) from then on, for its target or a folder holding it. */
  const covered = async (need: Need): Promise<boolean> => {
    if (need.kind === "unnamed") return false;
    const toolName = OWN_RULES[need.kind];
    return (await kept()).some(
      (rule) =>
        rule.toolName === toolName &&
        (rule.sessionId === node.mission || (rule.sessionId === null && !RUN_ONLY.has(need.kind))) &&
        (rule.pattern === need.target || (need.folder && isAbsolute(rule.pattern) && within(rule.pattern, need.target))),
    );
  };

  /**
   * The owner's answer, kept as this computer's rule for what it was given for: from then on with no end; for this run
   * (a program's or a tool's at most) with the turn's plan or conversation, until the time the grant says it lapses (from
   * an Ensemble that sends none, `OWN_ANSWER_DAYS` from now), in place of an older answer for the same; once, not at all.
   */
  const keep = async (need: Need, grant: Grant): Promise<void> => {
    if (need.kind === "unnamed" || grant.scope === "once") return;
    if (grant.target !== need.target && !(need.folder && isAbsolute(grant.target) && within(grant.target, need.target))) return;
    const always = grant.scope === "always" && !RUN_ONLY.has(need.kind);
    const rule = { userId, source: NODE_TOOL_RULE_SOURCE, toolName: OWN_RULES[need.kind], pattern: grant.target, decision: "allow", sessionId: always ? null : node.mission };
    const until = grant.until ? Date.parse(grant.until) : Number.NaN;
    const expiresAt = new Date(Number.isFinite(until) ? until : Date.now() + OWN_ANSWER_DAYS * DAY_MS);
    // The answer stands for this call either way; a rule that cannot be kept means the next call asks again.
    await (async () => {
      if (always) {
        if (!(await db.decisionRule.findFirst({ where: rule }))) await db.decisionRule.create({ data: rule });
        return;
      }
      await db.decisionRule.deleteMany({ where: rule });
      if (expiresAt.getTime() > Date.now()) await db.decisionRule.create({ data: { ...rule, expiresAt } });
    })().catch(() => undefined);
  };

  const answerFor = async (need: Need): Promise<EngineAnswer> => {
    const key = `${need.kind}\u0000${need.target}`;
    // Calls asking about the same thing at once share one question: the others go by its answer.
    for (let asking = inflight.get(key); asking; asking = inflight.get(key)) {
      noteAsked();
      await asking;
    }
    if (parked) return deny(parked);
    if (await covered(need)) return ALLOW;
    // Nobody watches an unattended run: changes, commands and calls go ahead above the floor (never a program, a tool Ensemble does not know, nor a call that names no path).
    if (!node.attended && (need.kind === "write" || need.kind === "origin")) return ALLOW;
    if (!(input.acceptWeb ?? loadSettings().acceptWebApprovals)) {
      return deny("This computer takes approvals only on itself (approvals from the web are off), so this call cannot be approved. Turn them on there with `ensemble approvals on`.");
    }
    if (!input.ask) return deny(`This needs your owner's answer (${need.what}, ${need.label}), and this turn cannot ask for it. Say what you need.`);
    const ask = input.ask;
    noteAsked();
    const asking = (async (): Promise<EngineAnswer> => {
      const answer = await ask({ capability: need.capability, target: need.target, label: need.label, scope: need.scope, operation: need.operation, what: need.what });
      if (answer.decision === "allow") {
        await keep(need, answer.grant);
        return ALLOW;
      }
      if (answer.waiting) parked = answer.message;
      return deny(answer.message);
    })();
    const settled = asking.then(
      () => undefined,
      () => undefined,
    );
    inflight.set(key, settled);
    try {
      return await asking;
    } finally {
      if (inflight.get(key) === settled) inflight.delete(key);
    }
  };

  /**
   * What one folder of a call asks about, unless it needs nobody. Where the folder would be the home
   * folder or the top of the disk, the answer covers only `exact`: the file, or the command.
   */
  const folderNeed = async (path: string, capability: Need["capability"], operation: string, what: (folder: string) => string, exact?: string): Promise<Need | null> => {
    const real = await realOutside(path);
    if (await free(real)) return null;
    const folder = await folderOf(real);
    if (folder) return { kind: "write", capability, target: folder, label: shown(folder), scope: "folder", operation, what: what(folder), folder: true };
    return { kind: "write", capability, target: exact ?? real, label: shown(exact ? real : dirname(real)), scope: "folder", operation, what: what(dirname(real)), folder: false };
  };

  /** A read or a change that names no path the floor could check: asked about exactly as the agent gave it, for that call only. */
  const unnamed = (call: EngineCall, write: boolean): Need => {
    const said = typeof call.input.described === "string" ? call.input.described : JSON.stringify(call.input ?? {});
    const text = `${call.tool}${said && said !== "{}" ? ` ${said}` : ""}`;
    const verb = write ? "change" : "read";
    return {
      kind: "unnamed",
      capability: write ? "files" : "read",
      target: `unnamed:${createHash("sha256").update(text).digest("hex").slice(0, 24)}`,
      label: "files it does not name",
      scope: "folder",
      operation: `${write ? "Change" : "Read"} files it does not name: ${text}`.slice(0, 2000),
      what: `${verb} files it does not name`,
      folder: false,
    };
  };

  /** A tool Ensemble does not know, asked about with its input, for the run at most: one of a server's, or of the agent's own. */
  const toolNeed = (call: EngineCall, mcp: { server: string; tool: string } | null): Need => {
    const named = mcp ? `${mcp.tool} from ${mcp.server}` : call.tool;
    return {
      kind: "tool",
      capability: "run",
      target: `tool:${mcp ? `${mcp.server}/${mcp.tool}` : call.tool}`.slice(0, 4096),
      label: named.slice(0, 300),
      scope: "folder",
      operation: `Use: ${named}\nWith: ${JSON.stringify(call.input ?? {})}`.slice(0, 4000),
      what: `use ${named}`.slice(0, 300),
      folder: false,
    };
  };

  /** Where a command's shell may be once it ran: each folder it went to (`cd`, `pushd`) and ran in. */
  const notePlaces = (command: string, place: string) => {
    for (const segment of parseShell(`${command}\n__ensemble_where__`, place)) {
      if (shellPlaces.size >= 50) return;
      if (segment.cwd !== input.folder) shellPlaces.add(segment.cwd);
    }
  };

  /** The programs and folders a command acts on, one answer each: the folder it runs in and those it names to write, and a program that changes the system. */
  const commandNeeds = async (command: string, cwd: string): Promise<Need[] | EngineAnswer> => {
    const parsed = parseShell(command, cwd);
    const needs: Need[] = [];
    const operation = `Run: ${command.trim().slice(0, 2000)}\nIn: ${shown(cwd)}`;
    const what = command.replace(/\s+/g, " ").trim().slice(0, 120);
    const add = (need: Need | null) => {
      if (need && !needs.some((known) => known.kind === need.kind && known.target === need.target)) needs.push(need);
    };
    for (const segment of parsed) {
      const program = segment.argv[0] ? programOf(segment.argv[0]) : "";
      if (!program) continue;
      if (PRIVILEGE.has(program)) return deny(sudoGuidance(node.sudo));
      if (readsSignIns(program, segment.argv)) return deny(SIGN_INS);
      if (/^ensemble(-test)?$/.test(program) && (segment.argv.includes("approvals") || (segment.argv.includes("needs") && segment.argv.includes("answer")))) return deny(CARDS);
      // A program that changes the system (its scheduler, its settings, other programs) is asked about wherever it runs.
      if (isNeverProgram(program)) add({ kind: "program", capability: "run", target: `program:${program}`, label: program, scope: "folder", operation, what, folder: false });
    }
    for (const segment of parsed) {
      if (!segment.argv.length) continue;
      const named = outsideArgs(segment.cwd, segment.argv, segment.cwd);
      const redirects = segment.redirects.map((redirect) => ({ ...redirect, full: at(segment.cwd, redirect.path) }));
      for (const path of [segment.cwd, ...named, ...redirects.map((redirect) => redirect.full)]) {
        const outside = await beyond(path);
        if (outside) return outside;
      }
      // The same test as a coding run's (workspace/tools.ts `segmentReadsOnly`, git-read.ts): nothing set in front, an allowlisted
      // git read, and a repository whose own config starts no program.
      const git = programOf(segment.argv[0]!) === "git";
      const writes = !(await segmentReadsOnly(segment)) || (git && !(await gitReadSafeAt(segment.argv, segment.cwd)));
      if (writes) add(await folderNeed(segment.cwd, "run", operation, () => what, `command:${command.trim().slice(0, 1000)}`));
      // A git config write to --global, --system or --file writes that file wherever the command runs.
      for (const path of git ? gitWrites(segment.argv, segment.cwd) : []) {
        const real = await realOutside(path);
        const floor = outsideRefusal(real, true);
        if (floor) return deny(`${shown(real)}: ${floor}`);
        add(await folderNeed(real, "files", operation, () => what));
      }
      for (const redirect of redirects) if (redirect.write && !harmlessPath(redirect.full)) add(await folderNeed(redirect.full, "files", operation, () => what));
      if (writes) for (const path of named) add(await folderNeed(path, "run", operation, () => what));
    }
    return needs;
  };

  const one = async (call: EngineCall): Promise<EngineAnswer> => {
    if (ensembleTool(call.tool)) return ALLOW;
    const floor = await judgeFloor(input.folder, call, { neverPrograms: false });
    if (floor.decision !== "allow") return floor;
    const given = call.input ?? {};
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
    if (SHELLS.has(call.tool)) {
      const command = text(given.command);
      if (!command) return ALLOW;
      if (CARD_ROUTE.test(command)) return deny(CARDS);
      // Where the agent says it runs; else the turn's folder, or wherever a `cd` left one of its shells.
      const places = text(given.cwd) ? [at(input.folder, text(given.cwd))] : [input.folder, ...shellPlaces];
      const needs: Need[] = [];
      for (const [index, place] of places.entries()) {
        if (index > 0) {
          const floor = await judgeFloor(input.folder, { tool: call.tool, input: { command, cwd: place } }, { neverPrograms: false });
          if (floor.decision !== "allow") return floor;
        }
        const found = await commandNeeds(command, place);
        if (!Array.isArray(found)) return found;
        for (const need of found) if (!needs.some((known) => known.kind === need.kind && known.target === need.target)) needs.push(need);
      }
      for (const need of needs) {
        const answer = await answerFor(need);
        if (answer.decision !== "allow") return answer;
      }
      // A command that says where it runs (Codex's, a server's) starts there each time; a shell of the agent's keeps its folder.
      if (!text(given.cwd)) for (const place of places) notePlaces(command, place);
      return ALLOW;
    }
    if (SEARCHES.has(call.tool)) {
      const glob = call.tool === "Glob" ? globRoot(given.pattern) : null;
      for (const path of [...pathsOf(given), ...(glob ? [glob] : [])]) {
        const outside = await beyond(at(input.folder, path));
        if (outside) return outside;
      }
      return ALLOW;
    }
    if (FILE_READS.has(call.tool)) {
      const paths = pathsOf(given);
      if (!paths.length) return answerFor(unnamed(call, false));
      for (const path of paths) {
        const outside = await beyond(at(input.folder, path));
        if (outside) return outside;
      }
      return ALLOW;
    }
    if (WRITES.has(call.tool)) {
      const paths = pathsOf(given);
      if (!paths.length) return answerFor(unnamed(call, true));
      for (const path of paths) {
        const full = at(input.folder, path);
        const outside = await beyond(full);
        if (outside) return outside;
        const need = await folderNeed(full, "files", `Change: ${shown(full)}`, (folder) => {
          const rel = relative(folder, full);
          return `change ${rel && !rel.startsWith("..") ? rel.split(/[\\/]/).join("/") : shown(full)}`;
        });
        const answer = need ? await answerFor(need) : ALLOW;
        if (answer.decision !== "allow") return answer;
      }
      return ALLOW;
    }
    if (call.tool === "WebFetch") {
      const url = text(given.url);
      if (!url) return ALLOW;
      if (CARD_ROUTE.test(url)) return deny(CARDS);
      if (await publicWebAddress(url)) return ALLOW;
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        return ALLOW;
      }
      return answerFor({ kind: "origin", capability: "http", target: origin, label: origin, scope: "origin", operation: `Open: ${url.slice(0, 2000)}`, what: `open ${url.slice(0, 200)}`, folder: false });
    }
    // Web searches, and the agent's own bookkeeping (its to-dos; its sub-agents, whose calls come here too).
    if (call.tool === "WebSearch" || BOOKKEEPING.has(call.tool)) return ALLOW;
    // Copilot's text typed into one of its shells: a command there.
    if (call.tool === "write_bash") return one({ tool: "Bash", input: { command: text(given.input) } });
    const mcp = mcpOf(call.tool, input.mcpServers ?? []);
    if (mcp?.readOnly) {
      const local = pathsOf(given).filter((path) => FULL_PATH.test(path));
      return local.length ? one({ tool: "Read", input: { paths: local } }) : ALLOW;
    }
    // A server's command runs where the server does, not in the turn's folder: as if in the home folder, where most start.
    const shaped = shapeOf(mcp?.tool ?? call.tool, given, mcp ? homedir() : null);
    return shaped ? one(shaped) : answerFor(toolNeed(call, mcp));
  };

  // One request of the agent's is one of its calls, however many parts it is judged in: one verdict for it.
  return async (calls) => {
    const state = { asked: false };
    const answer = await judging.run(state, async () => {
      for (const call of calls) {
        const verdict = parked ? deny(parked) : await one(call);
        if (verdict.decision !== "allow") {
          logRefused(input.app, call, verdict);
          return verdict;
        }
      }
      return ALLOW;
    });
    if (calls[0]) input.onVerdict?.(calls[0], answer.decision !== "allow" ? "refused" : state.asked ? "asked" : "allowed");
    return answer;
  };
}
