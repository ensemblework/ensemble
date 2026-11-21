/**
 * Skills in the coding agent's own skill folder (docs/30 §10): for a Code tab turn, Ensemble's bundled
 * skills (root `skills/`, embedded by packages/prompts) and the owner's skills linked to the thread go
 * into the one project skill folder the agent that runs reads (`.claude/skills` for Claude Code,
 * `.agents/skills` for Codex, …; research/12 §2), inside the run's folder only: `ensemble-<name>` and
 * `owner-<name>` folders with a portable SKILL.md each, kept out of git through `.git/info/exclude`.
 * Never the owner's own skill folders (their home's), which every session of theirs loads.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as prompts from "@ensemble/prompts";
import type { CodeEngine } from "@ensemble/shared-types";
import { within } from "../guard.js";
import { excludeInGit, folderIn, writeSafely } from "../run-files.js";
import type { OwnerSkill } from "../turn-packet.js";
import { skillRootsHere } from "./skills.js";

/** A skill packages/prompts bundles (its `SKILLS`), as that package types it. */
export type BundledSkill = {
  name: string;
  description: string;
  license: string;
  priority: string;
  keywords: readonly string[];
  tools: readonly string[];
  metadata: Readonly<Record<string, string>>;
  body: string;
  sha256: string;
};

/** The bundled skills of this build; none in a build whose packages/prompts has no `SKILLS` yet. */
export function bundledSkills(): BundledSkill[] {
  const all = (prompts as unknown as { SKILLS?: Record<string, BundledSkill> }).SKILLS;
  return all ? Object.values(all) : [];
}

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
export function codingSkills(all: readonly BundledSkill[] = bundledSkills()): BundledSkill[] {
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
  skills: WrittenSkill[];
  /** The lines in the repository's exclude file that keep them out of git; empty outside a repository. */
  excluded: string[];
};

/**
 * Writes the skills into the agent's skill folder in `root`, removes the `ensemble-` and `owner-`
 * folders an earlier turn left there that are not wanted now, and keeps them out of git. Null when
 * the folder cannot take them here (a link on the way, or the owner's own skill folder).
 */
export async function writeSkillFolder(root: string, engine: string, skills: readonly WrittenSkill[], home = homedir()): Promise<SkillFolder | null> {
  const parts = skillFolderOf(engine);
  const real = await realpath(root).catch(() => null);
  if (!real) return null;
  const target = join(real, ...parts);
  if (real === resolve(home) || skillRootsHere(home).some((own) => within(own, target))) return null;
  const folder = await folderIn(real, parts);
  if (!folder) return null;
  const wanted = new Set(skills.map((skill) => skill.name));
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (/^(ensemble|owner)-/.test(entry.name) && !wanted.has(entry.name)) await rm(join(folder, entry.name), { recursive: true, force: true });
  }
  const written: WrittenSkill[] = [];
  for (const skill of skills) {
    const dir = join(folder, skill.name);
    const info = await lstat(dir).catch(() => null);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) await rm(dir, { force: true });
    const made = await folderIn(folder, [skill.name]);
    if (!made) continue;
    await writeSafely(made, "SKILL.md", skill.text);
    written.push(skill);
  }
  const rel = parts.join("/");
  const excluded = await excludeInGit(real, [`${rel}/ensemble-*/`, `${rel}/owner-*/`], "Ensemble's skills for the agent (Code tab)").catch(() => []);
  return { folder, rel, skills: written, excluded };
}
