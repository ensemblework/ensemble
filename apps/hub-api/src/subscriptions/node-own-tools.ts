/**
 * The agent's own calls in an Ensemble Node's turn (its shell, files and web), judged on this computer
 * (docs/35 §8.13) by the policy the node's tools here follow (device-tools/policy.ts):
 *
 * - Refused, with why: the hard floor (keys and sign-ins, the system's files, Ensemble's own code and
 *   data, dangerous commands: judge.ts `judgeFloor`) and answering or changing Ensemble's own approvals.
 * - `sudo` and the other privilege prompts: the agent's shell has no terminal to type a password into,
 *   so it is told to use computer_sudo, where its owner approves the command and types the password.
 * - Allowed: reads anywhere above the floor, web searches and public web pages, Ensemble's own tools
 *   (judged where they run).
 * - Commands and file changes: allowed in the node's own folders (the turn's folder, which is the node's
 *   project folder, its `nodes/<handle>` folder, Ensemble's other work folders, a helper's folders), in
 *   the computer's temporary folders, in a folder an answer covers, and in an unattended run. A program
 *   that changes the system (crontab, launchctl, osascript…) is asked about on its own, wherever it runs.
 * - Anything else asks its owner, once per folder: Ensemble on the web posts a card in the node's chat and
 *   holds the call up to 90 seconds (node/own-tool-asks.ts). "Allow" keeps the folder allowed for the
 *   node, "Allow for this run" for this conversation or plan. Not answered in time: the call is refused
 *   with a note to stop here, every later call of the turn too, and the turn parks until the answer.
 *
 * A turn someone other than the owner started, or that others read (`trusted` false), asks about every
 * command and file change, and about reading the owner's files outside the node's own folders and the
 * temporary ones, once per folder per run: only this run's answers count. Public web pages stay open to it.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { env } from "../config.js";
import { prisma as defaultPrisma } from "../lib/prisma.js";
import { decide, NODE_TOOL_RULE_SOURCE } from "../device-tools/policy.js";
import { isEnsembleWorkFolder, ownFolderName, resolveToolFolder } from "../device-tools/folders.js";
import { publicWebAddress } from "../device-tools/http.js";
import { loadSettings } from "../remote/store.js";
import { expandHome, harmlessPath, inTemp, isNeverProgram, within, workspaceRoot } from "../workspace/guard.js";
import { judgeFloor, type EngineAnswer, type EngineCall } from "../workspace/engines/judge.js";
import { parseShell } from "../workspace/shell-parse.js";
import { outsideArgs, readsOnly, realOutside } from "../workspace/tools.js";
import type { OwnAnswer, OwnAsk, OwnJudge } from "./bridge.js";
import { logRefused } from "./own-tools.js";

/**
 * An Ensemble Node's turn with the agent's own tools (`assistantTurns` 5): how its calls are judged here.
 * `mission`: what "Allow for this run" covers (the plan the turn works for, else its conversation).
 * `attended` false: nobody watches the run (a routine, an unattended run profile), so everything above
 * the floor runs. `trusted` false: someone other than the owner started the turn, or others read it.
 * `sudo`: computer_sudo is in the turn. `folders`: a helper's folders (labels or full paths).
 */
export type NodeTurnPolicy = { id: string; slug: string; mission: string; attended: boolean; trusted: boolean; sudo: boolean; folders?: string[] };

type Db = Pick<PrismaClient, "decisionRule">;

export type NodeJudgeInput = {
  /** The turn's own folder on this computer: the node's project folder. */
  folder: string;
  node: NodeTurnPolicy;
  /** Asks the owner through Ensemble on the web; absent, a call that needs them is refused. */
  ask?: (request: OwnAsk) => Promise<OwnAnswer>;
  /** The agent, for the AI activity log. */
  app: string;
  /** Tests: the database, account and approval switch to use. */
  db?: Db;
  userId?: string;
  acceptWeb?: boolean;
};

const ALLOW: EngineAnswer = { decision: "allow" };
const deny = (message: string): EngineAnswer => ({ decision: "deny", message });

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
/** File reads as the judge names them (hookCall maps the other agents' reads to Read). */
const READS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);

/** Ensemble's MCP tools as each agent names them: judged where they run, on the web. */
const ensembleTool = (name: string) => /^(?:mcp__ensemble__|ensemble[-_./:])/.test(name);

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

type Need = { capability: OwnAsk["capability"]; target: string; label: string; scope: OwnAsk["scope"]; operation: string; what: string; folder: boolean };

/** One call of a node's turn, judged: the floor, the folder policy, the owner's answer. */
export function nodeOwnJudge(input: NodeJudgeInput): OwnJudge {
  const node = input.node;
  const db = input.db ?? defaultPrisma;
  const userId = input.userId ?? env.ENSEMBLE_DEV_USER_ID;
  let parked: string | null = null;
  let own: Promise<string[]> | null = null;
  const at = (base: string, path: string) => resolve(base, expandHome(path));

  /** The node's own folders here: the turn's, `nodes/<handle>` and a helper's folders. */
  const ownFolders = () =>
    (own ??= (async () => {
      const root = await workspaceRoot().catch(() => null);
      const helper = await Promise.all((node.folders ?? []).map((name) => resolveToolFolder(name).then((folder) => folder.path, () => null)));
      return [input.folder, ...(root ? [join(root, "nodes", ownFolderName({ nodeId: node.id, nodeSlug: node.slug }))] : []), ...helper.filter((path): path is string => Boolean(path))];
    })());

  /** A command or a change here needs nobody: a temporary folder or a device file, or (in the owner's own turn) one of the node's folders. */
  const free = async (path: string): Promise<boolean> => {
    if (harmlessPath(path) || inTemp(path)) return true;
    if (!node.trusted) return false;
    return (await ownFolders()).some((folder) => within(folder, path)) || (await isEnsembleWorkFolder(path));
  };

  /** Where a turn reads without asking: anywhere above the floor in the owner's own turn; else the node's folders and temporary ones. */
  const readable = async (path: string): Promise<boolean> => {
    if (node.trusted || harmlessPath(path) || inTemp(path)) return true;
    return (await ownFolders()).some((folder) => within(folder, path));
  };

  /** A saved answer whose folder holds this one: its target, so the policy finds it. */
  const covering = async (need: Need): Promise<string> => {
    if (!need.folder) return need.target;
    const rules = await db.decisionRule.findMany({ where: { userId, source: NODE_TOOL_RULE_SOURCE, toolName: "folder", decision: "allow" }, select: { pattern: true, sessionId: true }, take: 500 });
    const found = rules.find((rule) => (rule.sessionId === node.mission || (rule.sessionId === null && node.trusted)) && isAbsolute(rule.pattern) && within(rule.pattern, need.target));
    return found?.pattern ?? need.target;
  };

  const answerFor = async (need: Need): Promise<EngineAnswer> => {
    const acceptWeb = input.acceptWeb ?? loadSettings().acceptWebApprovals;
    const policy = { capability: need.capability, target: await covering(need), label: need.label, scope: need.scope, mission: node.mission, attended: node.attended || !node.trusted, grants: [] };
    const verdict = await decide(db, userId, policy, { weak: false, acceptWeb, lasting: node.trusted });
    if (verdict.kind === "allow") return ALLOW;
    if (verdict.kind === "refuse") return deny(verdict.reason);
    if (!input.ask) return deny(`This needs your owner's answer (${need.what}, ${need.label}), and this turn cannot ask for it. Say what you need.`);
    const answer = await input.ask({ capability: need.capability, target: need.target, label: need.label, scope: need.scope, operation: need.operation, what: need.what });
    if (answer.decision === "allow") {
      // Kept here as the node's own tools keep an answer: the same folder or address is not asked again.
      await decide(db, userId, { ...policy, target: answer.grant.target, grants: [answer.grant] }, { weak: false, acceptWeb: true, lasting: node.trusted });
      return ALLOW;
    }
    if (answer.waiting) parked = answer.message;
    return deny(answer.message);
  };

  /**
   * What one folder of a call asks about, unless it needs nobody. Where the folder would be the home
   * folder or the top of the disk, the answer covers only `exact`: the file, or the command.
   */
  const folderNeed = async (path: string, capability: Need["capability"], operation: string, what: (folder: string) => string, exact?: string): Promise<Need | null> => {
    const real = await realOutside(path);
    if (await free(real)) return null;
    const folder = await folderOf(real);
    if (folder) return { capability, target: folder, label: shown(folder), scope: "folder", operation, what: what(folder), folder: true };
    return { capability, target: exact ?? real, label: shown(exact ? real : dirname(real)), scope: "folder", operation, what: what(dirname(real)), folder: false };
  };

  /** What reading a path asks about, unless the turn reads there without asking: its folder, or the path itself at the home folder or the top of the disk. */
  const readNeed = async (path: string, operation: string, what: (folder: string) => string): Promise<Need | null> => {
    const real = await realOutside(path);
    if (await readable(real)) return null;
    const folder = await folderOf(real);
    if (folder) return { capability: "read", target: folder, label: shown(folder), scope: "folder", operation, what: what(folder), folder: true };
    return { capability: "read", target: real, label: shown(real), scope: "folder", operation, what: what(dirname(real)), folder: false };
  };

  /**
   * The programs and folders a command acts on, one answer each: the folder it runs in and the ones it names
   * to write, and, in a turn that is not trusted, those it reads.
   */
  const commandNeeds = async (command: string, cwd: string): Promise<Need[] | EngineAnswer> => {
    const parsed = parseShell(command, cwd);
    const needs: Need[] = [];
    const operation = `Run: ${command.trim().slice(0, 2000)}\nIn: ${shown(cwd)}`;
    const what = command.replace(/\s+/g, " ").trim().slice(0, 120);
    const add = (need: Need | null) => {
      if (need && !needs.some((known) => known.target === need.target)) needs.push(need);
    };
    for (const segment of parsed) {
      const program = segment.argv[0] ? programOf(segment.argv[0]) : "";
      if (!program) continue;
      if (PRIVILEGE.has(program)) return deny(sudoGuidance(node.sudo));
      if (readsSignIns(program, segment.argv)) return deny(SIGN_INS);
      if (/^ensemble(-test)?$/.test(program) && (segment.argv.includes("approvals") || (segment.argv.includes("needs") && segment.argv.includes("answer")))) return deny(CARDS);
      // A program that changes the system (its scheduler, its settings, other programs) is asked about wherever it runs.
      if (isNeverProgram(program)) add({ capability: "run", target: `program:${program}`, label: program, scope: "folder", operation, what, folder: false });
    }
    for (const segment of parsed) {
      if (!segment.argv.length) continue;
      const writes = !readsOnly(segment.argv);
      if (writes || !node.trusted) add(await folderNeed(segment.cwd, "run", operation, () => what, `command:${command.trim().slice(0, 1000)}`));
      for (const redirect of segment.redirects) {
        const full = at(segment.cwd, redirect.path);
        if (redirect.write && !harmlessPath(full)) add(await folderNeed(full, "files", operation, () => what));
        else if (!redirect.write) add(await readNeed(full, operation, () => what));
      }
      for (const path of outsideArgs(segment.cwd, segment.argv, segment.cwd)) add(writes ? await folderNeed(path, "run", operation, () => what) : await readNeed(path, operation, () => what));
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
      const needs = await commandNeeds(command, text(given.cwd) ? at(input.folder, text(given.cwd)) : input.folder);
      if (!Array.isArray(needs)) return needs;
      for (const need of needs) {
        const answer = await answerFor(need);
        if (answer.decision !== "allow") return answer;
      }
      return ALLOW;
    }
    if (READS.has(call.tool)) {
      const paths = [given.file_path, given.path, given.notebook_path, given.filePath].map(text).filter(Boolean);
      // A glob that names where it looks (`~/notes/**/*.md`): the folder before its first wildcard.
      const pattern = text(given.pattern);
      if (call.tool === "Glob" && !paths.length && /^(?:~|\/|[A-Za-z]:[\\/])/.test(pattern)) paths.push(pattern.split(/[*?[{]/)[0]!.replace(/[^\\/]*$/, "") || "/");
      for (const path of paths) {
        const full = at(input.folder, path);
        const need = await readNeed(full, `Read: ${shown(full)}`, (folder) => {
          const rel = relative(folder, full);
          return `read ${rel && !rel.startsWith("..") ? rel.split(/[\\/]/).join("/") : shown(full)}`;
        });
        const answer = need ? await answerFor(need) : ALLOW;
        if (answer.decision !== "allow") return answer;
      }
      return ALLOW;
    }
    if (WRITES.has(call.tool)) {
      for (const path of [given.file_path, given.path, given.notebook_path].map(text).filter(Boolean)) {
        const full = at(input.folder, path);
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
      return answerFor({ capability: "http", target: origin, label: origin, scope: "origin", operation: `Open: ${url.slice(0, 2000)}`, what: `open ${url.slice(0, 200)}`, folder: false });
    }
    // Web searches, and the agent's own bookkeeping (its to-dos; its sub-agents, whose calls come here too).
    return ALLOW;
  };

  return async (calls) => {
    for (const call of calls) {
      const verdict = parked ? deny(parked) : await one(call);
      if (verdict.decision !== "allow") {
        logRefused(input.app, call, verdict);
        return verdict;
      }
    }
    return ALLOW;
  };
}
