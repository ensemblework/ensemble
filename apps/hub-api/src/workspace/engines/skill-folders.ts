/**
 * Skills in the coding agent's own skill folder (docs/30 §10): for a Code tab turn, Ensemble's bundled
 * skills (root `skills/`, embedded by packages/prompts) and the owner's skills linked to the thread go
 * into the one project skill folder the agent that runs reads (`.claude/skills` for Claude Code,
 * `.agents/skills` for Codex, …; research/12 §2), inside the run's folder only: `ensemble-<name>` and
 * `owner-<name>` folders with a portable SKILL.md each, kept out of git through `.git/info/exclude`.
 * Never the owner's own skill folders (their home's), which every session of theirs loads.
 *
 * The folder is shared with the repository and the owner, who may keep skills of their own there under
 * the same kind of name (a repository's tracked `ensemble-context`). So Ensemble keeps a record of what
 * it wrote (`.ensemble/skills.json`, out of git) and touches only those folders, while they are as it
 * left them; never a folder git tracks, a link, or anything on a read-only turn.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SKILLS, type BundledSkill } from "@ensemble/prompts";
import type { CodeEngine } from "@ensemble/shared-types";
import { git } from "../../lib/git.js";
import { within } from "../guard.js";
import { excludeInGit, folderIn, isFolder, readRegular, repositoryOf, writeSafely } from "../run-files.js";
import type { OwnerSkill } from "../turn-packet.js";
import { skillRootsHere } from "./skills.js";

/** The project skill folder each agent reads in the folder it works in (research/12 §2). */
export const SKILL_FOLDERS: Record<CodeEngine, readonly string[]> = {
  "claude-code": [".claude", "skills"],
  codex: [".agents", "skills"],
  "copilot-cli": [".github", "skills"],
  "cursor-agent": [".cursor", "skills"],
  "gemini-cli": [".gemini", "skills"],
  opencode: [".opencode", "skills"],
  "grok-cli": [".grok", "skills"],
  antigravity: [".agents", "skills"],
  "qwen-code": [".qwen", "skills"],
  "mistral-vibe": [".vibe", "skills"],
  "kimi-code": [".agents", "skills"],
};

export const skillFolderOf = (engine: string): readonly string[] => SKILL_FOLDERS[engine as CodeEngine] ?? [".agents", "skills"];

/** At most this many bundled skills go to a coding agent. */
const MAX_BUNDLED = 8;

/**
 * The bundled skills a coding agent can follow: those that need none of Ensemble Node's own tools,
 * process skills (p0) first. The same for every turn, so a session's skill folder stays as it is.
 */
export function codingSkills(all: readonly BundledSkill[] = Object.values(SKILLS)): BundledSkill[] {
  const rank = (skill: BundledSkill) => (skill.priority === "p0" ? 0 : skill.priority === "p1" ? 1 : 2);
  return all
    .filter((skill) => skill.tools.length === 0)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, MAX_BUNDLED);
}

const slug = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/, "") || "skill";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** One skill as written: its folder's name (also its `name`), where it came from and its SKILL.md. */
export type WrittenSkill = { name: string; source: "ensemble" | "owner"; id: string | null; description: string; sha256: string; text: string };

/** SKILL.md with only the frontmatter every agent accepts: name (the folder's), description, license, metadata. */
function skillFile(input: { name: string; description: string; license?: string; metadata: Record<string, string>; body: string }): string {
  const meta = Object.entries(input.metadata).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`);
  return [
    "---",
    `name: ${input.name}`,
    `description: ${JSON.stringify(input.description.replace(/\s+/g, " ").trim().slice(0, 1024))}`,
    ...(input.license ? [`license: ${JSON.stringify(input.license)}`] : []),
    ...(meta.length ? ["metadata:", ...meta] : []),
    "---",
    "",
    input.body.trim(),
    "",
  ].join("\n");
}

/** The skills to write for a turn: the bundled ones as `ensemble-<name>`, the owner's as `owner-<name>`. */
export function skillsToWrite(bundled: readonly BundledSkill[], owner: readonly OwnerSkill[]): WrittenSkill[] {
  const out: WrittenSkill[] = [];
  const taken = new Set<string>();
  for (const skill of bundled) {
    const name = `ensemble-${slug(skill.name)}`;
    if (taken.has(name)) continue;
    taken.add(name);
    const text = skillFile({ name, description: skill.description, license: skill.license, metadata: { "ensemble.source": "bundled", "ensemble.sha256": skill.sha256 }, body: skill.body });
    out.push({ name, source: "ensemble", id: null, description: skill.description, sha256: skill.sha256 || sha256(text), text });
  }
  for (const skill of owner) {
    let name = `owner-${slug(skill.slug || skill.name)}`;
    if (taken.has(name)) name = `${name.slice(0, 55)}-${skill.id.slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    if (taken.has(name)) continue;
    taken.add(name);
    const description = skill.description.trim() || `Use when the request fits ${skill.name}.`;
    const text = skillFile({ name, description, metadata: { "ensemble.source": "owner", "ensemble.id": skill.id }, body: skill.body });
    out.push({ name, source: "owner", id: skill.id, description, sha256: sha256(text), text });
  }
  return out;
}

export type SkillFolder = {
  /** The folder, absolute, and as the agent finds it from the run's folder (`.claude/skills`). */
  folder: string;
  rel: string;
  /** The skills in place for the turn: written now or left as they were. */
  skills: WrittenSkill[];
  /** The lines in the repository's exclude file that keep them out of git; empty outside a repository. */
  excluded: string[];
};

const MANIFEST_DIR = [".ensemble"] as const;
const MANIFEST_FILE = "skills.json";
const MANIFEST_SCHEMA = "ensemble.skills.v1";
const SKILL_NAME = /^(?:ensemble|owner)-[a-z0-9-]{1,80}$/;
/** Each skill folder (`.claude/skills`) → the folders Ensemble wrote there → the SHA-256 of the SKILL.md it wrote. */
type Manifest = Record<string, Record<string, string>>;

/** Ensemble's record of the skill folders it wrote here; null when there is none (or it cannot be read). */
async function readManifest(root: string): Promise<Manifest | null> {
  if (!(await isFolder(join(root, ...MANIFEST_DIR)))) return null;
  const text = await readRegular(join(root, ...MANIFEST_DIR, MANIFEST_FILE));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { schema?: unknown; folders?: unknown };
    if (parsed.schema !== MANIFEST_SCHEMA || typeof parsed.folders !== "object" || parsed.folders === null) return null;
    const out: Manifest = {};
    for (const [rel, names] of Object.entries(parsed.folders)) {
      if (typeof names !== "object" || names === null) continue;
      const kept = Object.entries(names).filter((entry): entry is [string, string] => SKILL_NAME.test(entry[0]) && typeof entry[1] === "string" && /^[0-9a-f]{64}$/.test(entry[1]));
      if (kept.length) out[rel] = Object.fromEntries(kept);
    }
    return out;
  } catch {
    return null;
  }
}

async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  const dir = await folderIn(root, MANIFEST_DIR);
  if (!dir) return;
  await writeSafely(dir, MANIFEST_FILE, `${JSON.stringify({ schema: MANIFEST_SCHEMA, folders: manifest }, null, 2)}\n`);
  await excludeInGit(root, [`${MANIFEST_DIR.join("/")}/${MANIFEST_FILE}`], "Ensemble's record of the skills it wrote (Code tab)").catch(() => []);
}

/** The folders in the skill folder git tracks a file in, by name; null when git cannot tell. */
async function trackedIn(root: string, rel: string): Promise<Set<string> | null> {
  if (!(await repositoryOf(root))) return new Set();
  const listed = await git(root, ["-c", "core.fsmonitor=false", "ls-files", "-z", "--", rel]).catch(() => null);
  if (listed === null) return null;
  const names = new Set<string>();
  for (const path of listed.split("\0")) {
    if (path.startsWith(`${rel}/`)) names.add(path.slice(rel.length + 1).split("/")[0]!);
  }
  return names;
}

/** Ensemble's mark in a SKILL.md it wrote (`skillFile`). */
const MARK = /^---\n[\s\S]*?^ {2}ensemble\.source: "(?:bundled|owner)"$[\s\S]*?^---$/m;

/**
 * A skill folder as Ensemble left it, with its SKILL.md text: a real folder holding nothing but that
 * file, with the text Ensemble recorded writing (`sha`), or Ensemble's mark when there is no record at
 * all. Null for anything else: someone's own, or Ensemble's changed since.
 */
async function asLeft(dir: string, sha: string | undefined, markCounts: boolean): Promise<string | null> {
  if (!(await isFolder(dir))) return null;
  const entries = await readdir(dir).catch(() => null);
  if (!entries || entries.some((name) => name !== "SKILL.md" && !/^\.SKILL\.md\.[0-9a-f]+\.tmp$/.test(name))) return null;
  const text = await readRegular(join(dir, "SKILL.md"));
  if (text === null) return null;
  return (sha ? sha256(text) === sha : markCounts && MARK.test(text)) ? text : null;
}

/**
 * Writes the skills into the agent's skill folder in `root` and keeps them out of git. A folder there
 * Ensemble did not write (by its record), one changed since, one git tracks and a link are left as they
 * are, and a skill whose name they hold is not given. Folders Ensemble wrote for an earlier turn that
 * are not wanted now are removed while they are as it left them. Nothing is written when nothing
 * changed, and nothing at all on a read-only turn. Null when the folder cannot take them here (a link
 * on the way, or the owner's own skill folder).
 */
export async function writeSkillFolder(root: string, engine: string, skills: readonly WrittenSkill[], options: { home?: string; readOnly?: boolean } = {}): Promise<SkillFolder | null> {
  if (options.readOnly) return null;
  const home = options.home ?? homedir();
  const parts = skillFolderOf(engine);
  const real = await realpath(root).catch(() => null);
  if (!real) return null;
  const target = join(real, ...parts);
  if (real === resolve(home) || skillRootsHere(home).some((own) => within(own, target))) return null;
  const rel = parts.join("/");
  const manifest = await readManifest(real);
  const before = manifest?.[rel] ?? {};
  if (!skills.length && !Object.keys(before).length) return null;
  const folder = await folderIn(real, parts);
  if (!folder) return null;
  // When git cannot tell what it tracks, Ensemble changes no folder that is there.
  const tracked = await trackedIn(real, rel);
  const wanted = new Set(skills.map((skill) => skill.name));
  const now: Record<string, string> = {};
  for (const [name, sha] of Object.entries(before)) {
    if (wanted.has(name) || !tracked || tracked.has(name)) continue;
    if ((await asLeft(join(folder, name), sha, false)) !== null) await rm(join(folder, name), { recursive: true, force: true });
  }
  const written: WrittenSkill[] = [];
  for (const skill of skills) {
    if (!SKILL_NAME.test(skill.name) || tracked?.has(skill.name)) continue;
    const dir = join(folder, skill.name);
    if (await lstat(dir).then(() => true, () => false)) {
      const text = tracked ? await asLeft(dir, before[skill.name], manifest === null) : null;
      if (text === null) continue;
      if (text !== skill.text) await writeSafely(dir, "SKILL.md", skill.text);
    } else {
      const made = await folderIn(folder, [skill.name]);
      if (!made) continue;
      await writeSafely(made, "SKILL.md", skill.text);
    }
    now[skill.name] = sha256(skill.text);
    written.push(skill);
  }
  if (JSON.stringify(now) !== JSON.stringify(before)) {
    const next: Manifest = { ...(manifest ?? {}) };
    if (Object.keys(now).length) next[rel] = now;
    else delete next[rel];
    await writeManifest(real, next);
  }
  const excluded = written.length ? await excludeInGit(real, written.map((skill) => `${rel}/${skill.name}/`), "Ensemble's skills for the agent (Code tab)").catch(() => []) : [];
  return { folder, rel, skills: written, excluded };
}
