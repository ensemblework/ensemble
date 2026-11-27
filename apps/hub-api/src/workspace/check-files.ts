/**
 * What an assigned run's acceptance checks run (docs/16 §9): the files their commands name (`node
 * accept.js`, pytest's paths), the package scripts they use (`npm test`, `npm run lint`, and the files
 * such a script names) and the Makefile of a make target (`make test`), hashed when the run starts,
 * before its agent works. A check whose own file or script the run changed proves nothing: Ensemble does
 * not run it, and the run is not verified, with the file named, unless the task's own words ask to change
 * it. A file the check names that was not there when the run started is the run's to write. A change an
 * earlier run of the same task in the same session made still counts: the next run starts from that
 * run's baseline when nothing changed between.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { checkFiles, instructionText, isCheckCommand, makefileAt, makeTarget, NEGATED, type AcceptanceCheck } from "./acceptance-checks.js";

/** The run's event with the baseline as it started, and the one with each entry's hash as its agent left it. */
export const BASELINE_EVENT = "check_baseline";
export const END_EVENT = "check_files";

const CheckEntry = z.object({
  /** `file:<path>` or `script:<package.json path>#<name>`. */
  key: z.string().max(4200),
  /** How the owner reads it: the path in the run's folder, or the script and its package.json. */
  label: z.string().max(600),
  /** The file's name or the script's, as the task's words would say it. */
  name: z.string().max(300),
  sha: z.string().max(80).nullable(),
  /** The checks (`checkKey`) that run it. */
  checks: z.array(z.string().max(4400)).max(20),
  /** The task's own words ask to change it. */
  allowed: z.boolean().optional(),
});
export type CheckEntry = z.infer<typeof CheckEntry>;
const CheckBaseline = z.object({ entries: z.array(CheckEntry).max(200) });
export type CheckBaseline = z.infer<typeof CheckBaseline>;
const CheckEnd = z.object({ end: z.record(z.string().max(80).nullable()) });
export type Earlier = { baseline: CheckBaseline; end: Record<string, string | null> };

/** One check where it runs: its real folder and its command with one space between words. */
export function checkKey(cwd: string, command: string): string {
  return `${cwd}\0${command.replace(/\s+/g, " ").trim()}`;
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** The package.json script a check command runs: `test` for `npm|pnpm|yarn test` (`bun test` is Bun's own runner), `lint` for `npm run lint`; null for any other command. */
export function scriptOf(command: string): string | null {
  const [program = "", sub = "", name] = command.trim().split(/\s+/);
  if (!PACKAGE_MANAGERS.has(program)) return null;
  return sub === "test" && program !== "bun" ? "test" : sub === "run" && name ? name : null;
}

/** At most this many files of a test folder are read for its hash. */
const FOLDER_FILES = 2000;
const SKIP = new Set(["node_modules", "__pycache__", "vendor"]);

async function folderHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  let left = FOLDER_FILES;
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (left <= 0) return;
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        left -= 1;
        hash.update(`${relative(root, path)}\0`);
        hash.update(createHash("sha256").update(await readFile(path).catch(() => Buffer.alloc(0))).digest("hex"));
      }
    }
  };
  await walk(root);
  return hash.digest("hex");
}

/** An entry's hash now: the file's (a test folder's, over its files), or the script's text; null when it is not there. */
export async function entryHash(key: string): Promise<string | null> {
  if (key.startsWith("file:")) {
    const path = key.slice(5);
    const info = await stat(path).catch(() => null);
    if (!info) return null;
    if (info.isDirectory()) return folderHash(path);
    return info.isFile() ? createHash("sha256").update(await readFile(path)).digest("hex") : null;
  }
  const at = key.lastIndexOf("#");
  const scripts = await packageScripts(key.slice(7, at));
  const script = scripts?.[key.slice(at + 1)];
  return typeof script === "string" ? createHash("sha256").update(script).digest("hex") : null;
}

async function packageScripts(path: string): Promise<Record<string, unknown> | null> {
  try {
    const scripts = (JSON.parse(await readFile(path, "utf8")) as { scripts?: unknown }).scripts;
    return scripts && typeof scripts === "object" ? (scripts as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Named = Pick<CheckEntry, "key" | "label" | "name">;

/** What one check runs, in its folder `cwd`: the files its command names, the package script it uses with the files that script names, and the Makefile a make target is in. */
async function entriesOf(root: string, cwd: string, command: string): Promise<Named[]> {
  const file = (path: string): Named => {
    const full = resolve(cwd, path);
    return { key: `file:${full}`, label: relative(root, full) || path, name: basename(full) };
  };
  const out = checkFiles(command).map(file);
  const script = scriptOf(command);
  if (script) {
    const pkg = join(cwd, "package.json");
    out.push({ key: `script:${pkg}#${script}`, label: `the "${script}" script in ${relative(root, pkg) || "package.json"}`, name: script });
    const text = (await packageScripts(pkg))?.[script];
    if (typeof text === "string" && isCheckCommand(text.trim())) out.push(...checkFiles(text.trim()).map(file));
  }
  if (makeTarget(command)) out.push(file((await makefileAt(cwd)) ?? "Makefile"));
  return out;
}

/** Words that change a file. */
const CHANGES = /\b(?:change[sd]?|changing|edit(?:s|ed|ing)?|update[sd]?|updating|fix(?:es|ed|ing)?|modif(?:y|ies|ied|ying)|rewrit(?:e|es|ing|ten)|rewrote|repair(?:s|ed|ing)?|adjust(?:s|ed|ing)?|replac(?:e|es|ed|ing)|amend(?:s|ed|ing)?|rework(?:s|ed|ing)?|refactor(?:s|ed|ing)?)\b/gi;

/**
 * Whether the task's own words (`instructionText`) ask to change this file or script: one sentence names
 * it (its file name, or the script as "the test script" or its package.json) and says to change, edit,
 * update or fix it, not "do not change" or "never edit".
 */
export function asksToChange(text: string, entry: Pick<CheckEntry, "key" | "name">): boolean {
  const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = entry.key.startsWith("script:") ? new RegExp(`\\b${escaped}\\s+script\\b|package\\.json`, "i") : new RegExp(`(?:^|[\\s\`'"(/])${escaped}(?=$|[\\s\`'".,;:!?)])`, "i");
  return instructionText(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => {
      if (!names.test(sentence)) return false;
      for (const verb of sentence.matchAll(CHANGES)) {
        const before = sentence.slice(0, verb.index).split(/\s+/).slice(-4).join(" ");
        if (!NEGATED.test(before)) return true;
      }
      return false;
    });
}

/**
 * The run's baseline as it starts: each file and script its acceptance checks run (`checks`, each in its
 * real folder), with its hash now, or the earlier run's baseline hash when that run of the same task changed
 * it and nothing did since (`earlier`). `taskText`: the task's own words, which may ask to change one.
 */
export async function checkBaseline(root: string, checks: ReadonlyArray<{ check: Pick<AcceptanceCheck, "command">; cwd: string }>, taskText: string, earlier: Earlier | null): Promise<CheckBaseline> {
  const entries = new Map<string, CheckEntry>();
  for (const { check, cwd } of checks) {
    const key = checkKey(cwd, check.command);
    for (const named of await entriesOf(root, cwd, check.command)) {
      const known = entries.get(named.key);
      if (known) {
        if (!known.checks.includes(key)) known.checks.push(key);
        continue;
      }
      const now = await entryHash(named.key);
      const before = earlier?.baseline.entries.find((row) => row.key === named.key);
      const carried = before && before.sha !== null && earlier!.end[named.key] === now && before.sha !== now;
      const sha = carried ? before.sha : now;
      entries.set(named.key, { ...named, sha, checks: [key], ...(asksToChange(taskText, named) ? { allowed: true } : {}) });
    }
  }
  return { entries: [...entries.values()].slice(0, 200) };
}

/**
 * What the run changed of its checks: each entry's hash as the agent left it (`end`, kept for the next run
 * of the task), and for each check (`checkKey`) the files and scripts it runs that changed. A file that was
 * not there when the run started, or one the task asks to change, is left out.
 */
export async function checkChanges(baseline: CheckBaseline): Promise<{ end: Record<string, string | null>; changed: Map<string, string[]> }> {
  const end: Record<string, string | null> = {};
  const changed = new Map<string, string[]>();
  for (const entry of baseline.entries) {
    end[entry.key] = await entryHash(entry.key);
    if (entry.sha === null || entry.allowed || end[entry.key] === entry.sha) continue;
    for (const check of entry.checks) changed.set(check, [...(changed.get(check) ?? []), entry.label]);
  }
  return { end, changed };
}

/** The result of a check the run changed: not run, not verified, with what changed. */
export function changedReason(labels: readonly string[]): string {
  return `Not verified: the check itself was changed by the run (${[...new Set(labels)].join(", ")}). A changed check proves nothing, so Ensemble did not run it.`;
}

/**
 * The baseline of the latest earlier run of the same task in this run's chain (`chain`: the runs it
 * continues, newest first), with its end, when it recorded both; null otherwise.
 */
export async function earlierBaseline(db: Pick<PrismaClient, "workspaceJob" | "workspaceEvent"> | Prisma.TransactionClient, chain: readonly string[], taskId: string): Promise<Earlier | null> {
  if (!chain.length) return null;
  const same = new Set((await db.workspaceJob.findMany({ where: { id: { in: [...chain] }, taskId }, select: { id: true } })).map((row) => row.id));
  for (const id of chain) {
    if (!same.has(id)) continue;
    const rows = await db.workspaceEvent.findMany({ where: { jobId: id, kind: { in: [BASELINE_EVENT, END_EVENT] } }, orderBy: { sequence: "desc" }, take: 4, select: { kind: true, data: true } });
    const baseline = CheckBaseline.safeParse(rows.find((row) => row.kind === BASELINE_EVENT)?.data);
    if (!baseline.success) continue;
    const end = CheckEnd.safeParse(rows.find((row) => row.kind === END_EVENT)?.data);
    return end.success ? { baseline: baseline.data, end: end.data.end } : null;
  }
  return null;
}

/**
 * The line a message to a coding session gets when its task's acceptance checks run files or scripts:
 * not to edit them or reset what the checks keep between runs, since a check the work changed does not
 * count. Null when they run none.
 */
export function checkFilesNote(acceptance: readonly Pick<AcceptanceCheck, "command">[]): string | null {
  const names = new Set<string>();
  const commands: string[] = [];
  for (const check of acceptance) {
    const files = checkFiles(check.command).map((file) => file.replace(/^\.\//, ""));
    const script = scriptOf(check.command);
    const target = makeTarget(check.command);
    if (!files.length && !script && !target) continue;
    commands.push(`\`${check.command}\``);
    for (const file of files) names.add(file);
    if (script) names.add(`the "${script}" script in package.json`);
    if (target) names.add("the Makefile");
  }
  if (!names.size) return null;
  const list = [...names];
  const named = list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} or ${list.at(-1)}`;
  const one = commands.length === 1;
  return `Do not edit ${named} or reset what ${one ? "the check keeps" : "the checks keep"} between runs: ${commands.join(", ")} ${one ? "is this task's acceptance check" : "are this task's acceptance checks"}, and a check the work changed does not count. Fix the work, not the check.`;
}
