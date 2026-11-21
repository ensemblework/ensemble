import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { codingSkills, skillsToWrite, writeSkillFolder, type BundledSkill } from "./skill-folders.js";

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
    const written = await writeSkillFolder(root, engine, skills, join(scratch, "home"));
    assert.equal(written?.rel, folder, engine);
    const file = readFileSync(join(root, folder, "ensemble-planning", "SKILL.md"), "utf8");
    assert.match(file, /^---\nname: ensemble-planning\ndescription: "Use when planning fits\."\nlicense: "FSL-1\.1-MIT"\nmetadata:\n {2}ensemble\.source: "bundled"/);
    assert.match(readFileSync(join(root, folder, "owner-release-notes", "SKILL.md"), "utf8"), /name: owner-release-notes[\s\S]*Short, grouped by area\./);
    assert.deepEqual(written!.excluded, [`/${folder}/ensemble-*/`, `/${folder}/owner-*/`]);
    assert.equal(status(root), "A  README.md\n", `${engine}: git sees none of them`);
  }
});

test("a later turn removes the skills it no longer gives, never the folder's own, and never follows a link", async () => {
  const root = repo("later");
  await writeSkillFolder(root, "claude-code", skillsToWrite([bundled("planning"), bundled("debugging")], []), join(scratch, "home"));
  mkdirSync(join(root, ".claude", "skills", "house-style"));
  writeFileSync(join(root, ".claude", "skills", "house-style", "SKILL.md"), "---\nname: house-style\n---\n");
  await writeSkillFolder(root, "claude-code", skillsToWrite([bundled("planning")], []), join(scratch, "home"));
  assert.ok(existsSync(join(root, ".claude", "skills", "ensemble-planning")));
  assert.ok(!existsSync(join(root, ".claude", "skills", "ensemble-debugging")));
  assert.ok(existsSync(join(root, ".claude", "skills", "house-style", "SKILL.md")), "the folder's own skill stays");

  // A run left links where the skills go: Ensemble writes nothing through them.
  const elsewhere = join(scratch, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const linked = repo("linked");
  symlinkSync(elsewhere, join(linked, ".agents"));
  assert.equal(await writeSkillFolder(linked, "codex", skillsToWrite([bundled("planning")], []), join(scratch, "home")), null);
  assert.ok(!existsSync(join(elsewhere, "skills")));
  const planted = repo("planted");
  mkdirSync(join(planted, ".claude", "skills"), { recursive: true });
  symlinkSync(elsewhere, join(planted, ".claude", "skills", "ensemble-planning"));
  await writeSkillFolder(planted, "claude-code", skillsToWrite([bundled("planning")], []), join(scratch, "home"));
  assert.ok(lstatSync(join(planted, ".claude", "skills", "ensemble-planning")).isDirectory());
  assert.ok(!existsSync(join(elsewhere, "SKILL.md")), "the link was replaced, not followed");
});

test("never the owner's own skill folders: a run in the home folder gets none", async () => {
  const home = repo("home-run");
  assert.equal(await writeSkillFolder(home, "claude-code", skillsToWrite([bundled("planning")], []), home), null);
  assert.ok(!existsSync(join(home, ".claude")));
});

test("a run in a folder inside a repository excludes the skills under that folder's path", async () => {
  const root = repo("outer");
  mkdirSync(join(root, "packages", "web"), { recursive: true });
  const written = await writeSkillFolder(join(root, "packages", "web"), "codex", skillsToWrite([bundled("planning")], []), join(scratch, "home"));
  assert.deepEqual(written?.excluded, ["/packages/web/.agents/skills/ensemble-*/", "/packages/web/.agents/skills/owner-*/"]);
  assert.equal(status(root), "");
});
