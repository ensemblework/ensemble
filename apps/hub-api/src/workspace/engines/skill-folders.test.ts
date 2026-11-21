import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { BundledSkill } from "@ensemble/prompts";
import { codingSkills, skillsToWrite, writeSkillFolder } from "./skill-folders.js";

const scratch = mkdtempSync(join(tmpdir(), "ensemble-skill-folders-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const bundled = (name: string, over: Partial<BundledSkill> = {}): BundledSkill => ({
  name,
  description: `Use when ${name} fits.`,
  license: "FSL-1.1-MIT",
  priority: "p0",
  keywords: [],
  tools: [],
  metadata: {},
  body: `How to do ${name}.`,
  sha256: "a".repeat(64),
  ...over,
});
const owner = { id: "skill-1", slug: "release-notes", name: "Release notes", description: "How I like release notes written.", body: "Short, grouped by area." };

function repo(name: string): string {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  return root;
}
const status = (root: string) => execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
const home = { home: join(scratch, "home") };
const commit = (root: string) => execFileSync("git", ["-C", root, "-c", "user.name=Mira", "-c", "user.email=mira@fieldnote.example", "commit", "-qm", "theirs"]);

test("the bundled skills a coding agent can follow: none that needs a Node tool, process skills first", () => {
  const all = [bundled("writing", { priority: "p1" }), bundled("delegation", { tools: ["node_delegate"] }), bundled("planning"), bundled("debugging")];
  assert.deepEqual(codingSkills(all).map((skill) => skill.name), ["debugging", "planning", "writing"]);
});

test("skills go into the folder of the agent that runs, inside the run's folder, out of git", async () => {
  const skills = skillsToWrite([bundled("planning")], [owner]);
  for (const [engine, folder] of [["claude-code", ".claude/skills"], ["codex", ".agents/skills"], ["copilot-cli", ".github/skills"], ["cursor-agent", ".cursor/skills"], ["gemini-cli", ".gemini/skills"], ["opencode", ".opencode/skills"]] as const) {
    const root = repo(`run-${engine}`);
    writeFileSync(join(root, "README.md"), "hi\n");
    execFileSync("git", ["-C", root, "add", "README.md"]);
    const written = await writeSkillFolder(root, engine, skills, home);
    assert.equal(written?.rel, folder, engine);
    const file = readFileSync(join(root, folder, "ensemble-planning", "SKILL.md"), "utf8");
    assert.match(file, /^---\nname: ensemble-planning\ndescription: "Use when planning fits\."\nlicense: "FSL-1\.1-MIT"\nmetadata:\n {2}ensemble\.source: "bundled"/);
    assert.match(readFileSync(join(root, folder, "owner-release-notes", "SKILL.md"), "utf8"), /name: owner-release-notes[\s\S]*Short, grouped by area\./);
    assert.deepEqual(written!.excluded, [`/${folder}/ensemble-planning/`, `/${folder}/owner-release-notes/`]);
    assert.equal(status(root), "A  README.md\n", `${engine}: git sees none of them, nor Ensemble's record of them`);
  }
});

test("a later turn removes only the skills Ensemble wrote: never the repository's own, the owner's, or one changed since", async () => {
  const root = repo("later");
  const skills = join(root, ".github", "skills");
  // The repository keeps a skill of its own under a name like Ensemble's.
  mkdirSync(join(skills, "ensemble-context"), { recursive: true });
  writeFileSync(join(skills, "ensemble-context", "SKILL.md"), "---\nname: ensemble-context\ndescription: Ours.\n---\n");
  execFileSync("git", ["-C", root, "add", "."]);
  commit(root);
  mkdirSync(join(skills, "ensemble-notes"));
  writeFileSync(join(skills, "ensemble-notes", "SKILL.md"), "---\nname: ensemble-notes\n---\n");
  mkdirSync(join(skills, "house-style"));
  writeFileSync(join(skills, "house-style", "SKILL.md"), "---\nname: house-style\n---\n");

  const first = await writeSkillFolder(root, "copilot-cli", skillsToWrite([bundled("planning"), bundled("debugging"), bundled("context")], []), home);
  assert.deepEqual(first?.skills.map((skill) => skill.name), ["ensemble-planning", "ensemble-debugging"], "the repository's ensemble-context is not Ensemble's to write");
  await writeSkillFolder(root, "copilot-cli", skillsToWrite([bundled("planning")], []), home);
  assert.ok(existsSync(join(skills, "ensemble-planning", "SKILL.md")));
  assert.ok(!existsSync(join(skills, "ensemble-debugging")), "Ensemble's own, no longer given, is gone");
  assert.equal(readFileSync(join(skills, "ensemble-context", "SKILL.md"), "utf8"), "---\nname: ensemble-context\ndescription: Ours.\n---\n");
  assert.ok(existsSync(join(skills, "ensemble-notes", "SKILL.md")), "an ensemble- folder Ensemble did not write stays");
  assert.ok(existsSync(join(skills, "house-style", "SKILL.md")));
  assert.equal(status(root), "?? .github/skills/ensemble-notes/SKILL.md\n?? .github/skills/house-style/SKILL.md\n", "the tracked skill is untouched and the owner's own still show");

  // A skill Ensemble wrote that someone changed since is theirs now: kept when no longer given.
  writeFileSync(join(skills, "ensemble-planning", "SKILL.md"), "---\nname: ensemble-planning\n---\nOur own notes now.\n");
  await writeSkillFolder(root, "copilot-cli", skillsToWrite([], []), home);
  assert.match(readFileSync(join(skills, "ensemble-planning", "SKILL.md"), "utf8"), /Our own notes now/);
  assert.ok(existsSync(join(skills, "ensemble-context", "SKILL.md")));

  // A run left links where the skills go: Ensemble writes nothing through them, and leaves them be.
  const elsewhere = join(scratch, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const linked = repo("linked");
  symlinkSync(elsewhere, join(linked, ".agents"));
  assert.equal(await writeSkillFolder(linked, "codex", skillsToWrite([bundled("planning")], []), home), null);
  assert.ok(!existsSync(join(elsewhere, "skills")));
  const planted = repo("planted");
  mkdirSync(join(planted, ".claude", "skills"), { recursive: true });
  symlinkSync(elsewhere, join(planted, ".claude", "skills", "ensemble-planning"));
  const beside = await writeSkillFolder(planted, "claude-code", skillsToWrite([bundled("planning"), bundled("debugging")], []), home);
  assert.deepEqual(beside?.skills.map((skill) => skill.name), ["ensemble-debugging"]);
  assert.ok(lstatSync(join(planted, ".claude", "skills", "ensemble-planning")).isSymbolicLink(), "the link stays");
  assert.ok(!existsSync(join(elsewhere, "SKILL.md")), "nothing was written through it");
});

test("a read-only turn, or one whose skills did not change, writes and removes nothing", async () => {
  const root = repo("same");
  const file = join(root, ".claude", "skills", "ensemble-planning", "SKILL.md");
  await writeSkillFolder(root, "claude-code", skillsToWrite([bundled("planning"), bundled("debugging")], []), home);
  const before = statSync(file).ino;
  const record = statSync(join(root, ".ensemble", "skills.json")).ino;
  const again = await writeSkillFolder(root, "claude-code", skillsToWrite([bundled("planning"), bundled("debugging")], []), home);
  assert.deepEqual(again?.skills.map((skill) => skill.name), ["ensemble-planning", "ensemble-debugging"]);
  assert.equal(statSync(file).ino, before, "SKILL.md was not written again");
  assert.equal(statSync(join(root, ".ensemble", "skills.json")).ino, record);

  assert.equal(await writeSkillFolder(root, "claude-code", skillsToWrite([bundled("planning")], []), { ...home, readOnly: true }), null);
  assert.ok(existsSync(join(root, ".claude", "skills", "ensemble-debugging", "SKILL.md")), "a read-only turn removes nothing");
  const fresh = repo("read-only");
  assert.equal(await writeSkillFolder(fresh, "claude-code", skillsToWrite([bundled("planning")], []), { ...home, readOnly: true }), null);
  assert.ok(!existsSync(join(fresh, ".claude")) && !existsSync(join(fresh, ".ensemble")), "nor writes anything");
});

test("never the owner's own skill folders: a run in the home folder gets none", async () => {
  const home = repo("home-run");
  assert.equal(await writeSkillFolder(home, "claude-code", skillsToWrite([bundled("planning")], []), { home }), null);
  assert.ok(!existsSync(join(home, ".claude")));
});

test("a run in a folder inside a repository excludes the skills under that folder's path", async () => {
  const root = repo("outer");
  mkdirSync(join(root, "packages", "web"), { recursive: true });
  const written = await writeSkillFolder(join(root, "packages", "web"), "codex", skillsToWrite([bundled("planning")], []), home);
  assert.deepEqual(written?.excluded, ["/packages/web/.agents/skills/ensemble-planning/"]);
  assert.equal(status(root), "");
});
