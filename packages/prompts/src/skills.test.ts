import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SKILLS } from "./skills.generated.js";

const SKILLS_DIR = fileURLToPath(new URL("../../../skills/", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/generate.mjs", import.meta.url));

test("every skill folder at the repository root is embedded, its instructions word for word", () => {
  const folders = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(Object.keys(SKILLS).sort(), folders);
  for (const folder of folders) {
    const source = readFileSync(`${SKILLS_DIR}${folder}/SKILL.md`, "utf8");
    const body = source.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    const skill = SKILLS[folder as keyof typeof SKILLS];
    assert.equal(skill.name, folder);
    assert.equal(skill.body, body, `${folder}'s instructions`);
    assert.ok(source.includes(`description: ${skill.description}\n`), `${folder}'s description`);
  }
});

test("bundled skills: the process skills are p0, and each description says when to use it in under 500 characters", () => {
  const p0 = Object.values(SKILLS).filter((skill) => skill.priority === "p0").map((skill) => skill.name).sort();
  assert.deepEqual(p0, ["clarify-intent", "debugging", "delegation", "independent-review", "planning", "stuck-recovery", "verify-before-done"]);
  for (const skill of Object.values(SKILLS)) {
    assert.match(skill.description, /^Use when /, skill.name);
    assert.ok(skill.description.length <= 500, `${skill.name}: ${skill.description.length} characters`);
    assert.ok(skill.keywords.length >= 5, `${skill.name} has keywords`);
    assert.doesNotMatch(`${skill.description}\n${skill.body}`, /\u2014|\u2013|--|^#/m, skill.name);
  }
  for (const name of ["shopping", "screenshots", "web-files", "sign-in", "web-task", "research"] as const) assert.ok(SKILLS[name].tools.length, `${name} names the tools it needs`);
});

/** parseSkill from the generator, run on one SKILL.md text: its error, or "ok". */
function parsed(source: string, folder = "demo"): string {
  const program = `import { parseSkill } from ${JSON.stringify(SCRIPT)}; try { parseSkill(${JSON.stringify(source)}, ${JSON.stringify(folder)}); console.log("ok"); } catch (error) { console.log(error.message); }`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8" }).trim();
}

test("the generator refuses a skill that breaks the frontmatter or copy rules", () => {
  const skill = (head: string, body = "Do the thing.") => `---\n${head}\n---\n${body}\n`;
  const good = "name: demo\ndescription: Use when a demo is asked for.\nlicense: MIT\nmetadata:\n  keywords: demo, example";
  assert.equal(parsed(skill(good)), "ok");
  assert.match(parsed(skill(good), "other"), /must be the folder's name/);
  assert.match(parsed(skill(good.replace("Use when a demo", "Makes a demo"))), /starts “Use when”/);
  assert.match(parsed(skill(good.replace("a demo is asked for", "x".repeat(500)))), /keep it to 500/);
  assert.match(parsed(skill(`${good}\nallowed-tools: Bash`)), /only name, description, license and metadata/);
  assert.match(parsed(skill(good.replace("  keywords: demo, example", "  tools: browser_open"))), /needs keywords/);
  assert.match(parsed(skill(good, "# Steps\nDo it.")), /Markdown heading/);
  assert.match(parsed(skill(good, "Do it \u2014 now.")), /em dash/);
  assert.match(parsed("name: demo\n"), /frontmatter between two --- lines/);
});
