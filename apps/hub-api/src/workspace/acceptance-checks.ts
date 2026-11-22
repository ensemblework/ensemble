/**
 * The checks an assigned run answers to besides those its agent reports (docs/16 §9): the commands its
 * task's or plan step's acceptance criteria name, such as "AC-1 `node accept.js` passes in the export
 * folder". When the agent says it is done, Ensemble runs them again with the agent's reported checks
 * (completion.ts), and the task is done only when they pass.
 */
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { acceptanceOf as stepAcceptance } from "../node/packet.js";
import { within } from "./guard.js";
import { acceptanceOf, type Criterion } from "./turn-packet.js";

export const AcceptanceCheck = z.object({
  id: z.string().min(1).max(80),
  text: z.string().min(1).max(600),
  command: z.string().min(1).max(2000),
  /** A folder the criterion names ("in the web folder"); the run's own folder when it names none, or it is not there. */
  folder: z.string().max(300).nullable(),
});
export type AcceptanceCheck = z.infer<typeof AcceptanceCheck>;

export const MAX_ACCEPTANCE_CHECKS = 12;

/** Programs that run a project's build, tests or checkers: only a command of one of them, or of a script in the project, is run again. */
const PROGRAMS = new Set([
  "node", "npm", "npx", "pnpm", "yarn", "bun", "bunx", "deno", "tsx", "tsc", "eslint", "prettier", "biome", "playwright", "jest", "vitest", "mocha",
  "python", "python3", "pytest", "py.test", "tox", "nox", "uv", "poetry", "pdm", "hatch", "ruff", "mypy", "flake8", "pylint", "black",
  "cargo", "go", "make", "just", "cmake", "ctest", "ninja", "bash", "sh", "zsh", "shellcheck", "ruby", "bundle", "rake", "rspec",
  "mvn", "mvnw", "gradle", "gradlew", "java", "dotnet", "php", "phpunit", "composer", "swift", "xcodebuild", "mix", "dart", "flutter", "perl", "rscript", "julia", "git",
]);
/** Words that make a command reach outside the computer, change the project's dependencies or reset its state: a criterion naming one says what was done, never a check to run again. */
const OUTWARD = new Set([
  "publish", "unpublish", "deploy", "push", "upload", "login", "logout", "release", "reset", "install", "uninstall", "add", "remove", "update", "upgrade",
  "vercel", "netlify", "wrangler", "firebase", "flyctl", "heroku", "kubectl", "terraform", "helm", "twine",
]);
/** What git may run as a check: commands that only read. */
const GIT_READS = new Set(["diff", "status", "log", "show", "grep", "ls-files", "check-ignore", "check-attr", "rev-parse", "rev-list", "describe", "blame", "cat-file", "ls-tree", "merge-base"]);
/** What follows a command that is run: it passes, succeeds, exits 0, is clean. */
const RUNS_AFTER = /^\s*(?:pass(?:es|ing)?\b|succeed(?:s|ing)?\b|exit(?:s|ing)?\s+(?:with\s+)?(?:code\s+)?0\b|returns?\s+0\b|is\s+(?:green|clean|ok)\b|runs?\s+clean(?:ly)?\b|completes?\b)/i;
/** What comes before a command that is run: run, execute, the command. */
const RUNS_BEFORE = /\b(?:run(?:ning|s)?|execut(?:e|es|ing)|command)\s*:?\s*$/i;
/** A folder the criterion names: "in the export folder", "in `packages/web/`". */
const FOLDER_NAMED = /\bin (?:the )?`?([\w.@-][\w.@/-]*?)\/?`? (?:folder|directory|dir|package)\b/i;
const FOLDER_PATH = /\bin `([\w.@-][\w.@/-]*?)\/?`/;
const NOT_A_FOLDER = new Set(["this", "that", "the", "same", "current", "project", "repository", "repo", "root", "run's", "its", "your", "my", "our", "their", "work", "working"]);

/**
 * Whether a backticked span is a check to run again: a known program with its arguments, or a script of
 * the project (`./check.sh`); a program or script alone only where the criterion says it runs or passes
 * (`said`). Never one that changes what lies outside the folder (OUTWARD), nor git beyond reading.
 */
function checkCommand(span: string, said: boolean): boolean {
  if (span.length < 2 || span.length > 300) return false;
  const [first = "", ...rest] = span.split(/\s+/);
  const script = /^\.{1,2}\//.test(first);
  if (!script && !/^\/?[A-Za-z][\w.+/-]*$/.test(first)) return false;
  const program = first.replace(/^.*\//, "").toLowerCase();
  if (!script && !PROGRAMS.has(program)) return false;
  if (!rest.length && !said) return false;
  const words = rest.filter((word) => !word.startsWith("-")).map((word) => word.toLowerCase());
  if (program === "git" && !GIT_READS.has(words[0] ?? "")) return false;
  return !words.some((word) => OUTWARD.has(word));
}

function folderOf(text: string): string | null {
  const named = (FOLDER_NAMED.exec(text) ?? FOLDER_PATH.exec(text))?.[1]?.replace(/\/+$/, "") ?? "";
  return named && !NOT_A_FOLDER.has(named.toLowerCase()) && !named.split("/").includes("..") ? named.slice(0, 300) : null;
}

/** The commands acceptance criteria name to run, each under its criterion's id (`checkCommand`). Each command once. */
export function acceptanceCommands(criteria: readonly Criterion[]): AcceptanceCheck[] {
  const out: AcceptanceCheck[] = [];
  for (const criterion of criteria) {
    const folder = folderOf(criterion.text);
    for (const match of criterion.text.matchAll(/`([^`\n]+)`/g)) {
      const span = match[1]!.trim();
      const said = RUNS_AFTER.test(criterion.text.slice(match.index! + match[0].length)) || RUNS_BEFORE.test(criterion.text.slice(0, match.index));
      if (!checkCommand(span, said)) continue;
      if (out.some((check) => check.command.replace(/\s+/g, " ") === span.replace(/\s+/g, " "))) continue;
      out.push({ id: criterion.id.slice(0, 80), text: criterion.text.slice(0, 600), command: span, folder });
      if (out.length >= MAX_ACCEPTANCE_CHECKS) return out;
    }
  }
  return out;
}

const Requirements = z.array(z.object({ id: z.string(), acceptance: z.array(z.object({ id: z.string(), text: z.string(), proof: z.string().nullish(), mandatory: z.boolean().optional() }).passthrough()).default([]) }).passthrough());

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * An assigned run's acceptance commands: those its task's own text (`text`: its description and notes)
 * names, and those of the plan step the run is for, when a node's mission handed it the run.
 */
export async function acceptanceChecksFor(db: Db, input: { userId: string; jobId: string; text: string }): Promise<AcceptanceCheck[]> {
  const criteria: Criterion[] = acceptanceOf(input.text);
  const run = await db.nodeRun.findUnique({ where: { jobId: input.jobId }, select: { userId: true, planId: true, planStep: true } }).catch(() => null);
  if (run?.planId && run.planStep && run.userId === input.userId) {
    const mission = await db.nodeMission.findUnique({ where: { id: run.planId }, select: { requirements: true } });
    const step = await db.nodeStep.findFirst({ where: { missionId: run.planId, id: run.planStep }, select: { requirementIds: true, acceptanceIds: true } });
    const requirements = Requirements.safeParse(mission?.requirements);
    if (step && requirements.success) {
      const data = { requirements: requirements.data.map((row) => ({ ...row, acceptance: row.acceptance.map((item) => ({ ...item, proof: item.proof ?? undefined })) })) } as unknown as Parameters<typeof stepAcceptance>[0];
      for (const item of stepAcceptance(data, step)) if (!criteria.some((known) => known.id === item.id && known.text === item.text)) criteria.push({ id: item.id, text: item.text });
    }
  }
  return acceptanceCommands(criteria);
}

/** The acceptance commands a run from the web came with (the claim's `acceptance`); null when it came with none. */
export function acceptanceInContext(context: unknown): AcceptanceCheck[] | null {
  const value = typeof context === "object" && context !== null ? (context as { acceptance?: unknown }).acceptance : undefined;
  if (!Array.isArray(value)) return null;
  return value.map((row) => AcceptanceCheck.safeParse(row)).flatMap((row) => (row.success ? [row.data] : [])).slice(0, MAX_ACCEPTANCE_CHECKS);
}

/** Where an acceptance command runs: the folder its criterion names when it is a real folder inside the run's folder, else the run's folder (null). */
export async function acceptanceFolder(root: string, folder: string | null): Promise<string | null> {
  if (!folder) return null;
  const real = await realpath(root).catch(() => null);
  if (!real) return null;
  const candidate = join(real, folder);
  if (!within(real, candidate)) return null;
  const found = await realpath(candidate).catch(() => null);
  if (!found || !within(real, found)) return null;
  return (await lstat(found).then((info) => info.isDirectory(), () => false)) ? folder : null;
}
