#!/usr/bin/env node
/**
 * Writes src/sections.generated.ts from sections/<folder>/<NN-name>.md: each section's text (notes in
 * <!-- --> removed, trimmed), the {{variables}} it uses and the SHA-256 of that text. Writes
 * src/skills.generated.ts from the bundled skills at the repository root (skills/<name>/SKILL.md): each
 * skill's frontmatter (name, description, license, metadata) and its instructions. The API, the desktop
 * sidecar and the CLI's bundle read the generated modules, never the Markdown files.
 *
 *   node scripts/generate.mjs           write the modules
 *   node scripts/generate.mjs --check   fail when a module is out of date
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUTPUT = join(root, "src", "sections.generated.ts");
export const SKILLS_OUTPUT = join(root, "src", "skills.generated.ts");
export const SKILLS_DIR = join(root, "..", "..", "skills");
const FILE = /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const VARIABLE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
// People read every prompt (Settings → Prompts, traces), and the model copies what it is shown.
const FORBIDDEN = [
  ["\u2014", "an em dash"],
  ["\u2013", "an en dash"],
  ["--", "a double hyphen"],
];
// The portable frontmatter every agent harness accepts (Agent Skills): nothing else, so a skill loads anywhere.
const SKILL_FIELDS = new Set(["name", "description", "license", "metadata"]);
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_PRIORITIES = new Set(["p0", "p1", "p2"]);
// A description says when to use the skill, never what it does: models followed a summary instead of the body.
const DESCRIPTION_MAX = 500;

/** A section's text as sent: notes for people removed, trailing spaces and outer blank lines dropped. */
export function sectionText(source) {
  return source
    .replace(/\r\n/g, "\n")
    .replace(/<!--[\s\S]*?-->[ \t]*\n?/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Text people may read: never a dash the copy rules refuse, never a Markdown heading. */
function checkText(where, text, { headings = true } = {}) {
  for (const [sequence, label] of FORBIDDEN) {
    if (text.includes(sequence)) throw new Error(`${where} has ${label}: use a period, comma or colon.`);
  }
  // A heading reads as a label to repeat: models have copied one into their replies.
  if (headings && /^#/m.test(text)) throw new Error(`${where} has a Markdown heading: write the rule as what to do.`);
}

/** Every section file under sections/, in folder then file order. */
export function readSections(dir = join(root, "sections")) {
  const sections = [];
  for (const folder of readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    for (const file of readdirSync(join(dir, folder)).sort()) {
      if (!file.endsWith(".md")) continue;
      if (!FILE.test(file)) throw new Error(`sections/${folder}/${file}: a section file is named NN-name.md (two digits, then lower-case words joined by hyphens).`);
      const name = `${folder}/${file.slice(0, -3)}`;
      const text = sectionText(readFileSync(join(dir, folder, file), "utf8"));
      checkText(`sections/${name}.md`, text);
      const vars = [...new Set([...text.matchAll(VARIABLE)].map((match) => match[1]))].sort();
      sections.push({ name, folder, text, vars, sha256: createHash("sha256").update(text).digest("hex") });
    }
  }
  return sections;
}

const unquote = (value) => {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
};
const list = (value) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/**
 * One SKILL.md: frontmatter between `---` lines with `name` (the folder's name), `description` (when to
 * use it: starts "Use when", at most 500 characters), `license` and `metadata` (indented `key: value`
 * lines: `keywords` and `tools` are comma-separated lists, `priority` is p0, p1 or p2), then the
 * instructions. Throws with the reason when the file breaks a rule.
 */
export function parseSkill(source, folder) {
  const where = `skills/${folder}/SKILL.md`;
  const found = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(source.replace(/\r\n/g, "\n"));
  if (!found) throw new Error(`${where} starts with its frontmatter between two --- lines.`);
  const fields = {};
  const metadata = {};
  let inMetadata = false;
  for (const line of found[1].split("\n")) {
    if (!line.trim()) continue;
    const nested = /^\s+([A-Za-z0-9_.-]+):(.*)$/.exec(line);
    if (nested) {
      if (!inMetadata) throw new Error(`${where}: “${line.trim()}” is indented outside metadata.`);
      metadata[nested[1]] = unquote(nested[2]);
      continue;
    }
    const top = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (!top) throw new Error(`${where}: “${line}” is not a key: value line.`);
    const [, key, value] = top;
    if (!SKILL_FIELDS.has(key)) throw new Error(`${where}: frontmatter has ${key}; a skill has only name, description, license and metadata.`);
    inMetadata = key === "metadata";
    if (inMetadata) {
      if (value.trim()) throw new Error(`${where}: metadata holds indented key: value lines.`);
      continue;
    }
    fields[key] = unquote(value);
  }
  const name = fields.name ?? "";
  if (name !== folder) throw new Error(`${where}: name is “${name}”; it must be the folder's name.`);
  if (!SKILL_NAME.test(name) || name.length > 64) throw new Error(`${where}: a name is lower-case words joined by hyphens, at most 64 characters.`);
  const description = fields.description ?? "";
  if (!description.startsWith("Use when")) throw new Error(`${where}: the description says when to use the skill and starts “Use when”.`);
  if (description.length > DESCRIPTION_MAX) throw new Error(`${where}: the description has ${description.length} characters; keep it to ${DESCRIPTION_MAX}.`);
  if (!fields.license) throw new Error(`${where}: frontmatter needs a license.`);
  const keywords = list(metadata.keywords);
  if (!keywords.length) throw new Error(`${where}: metadata needs keywords, the words and phrases that call for the skill.`);
  const priority = metadata.priority ?? "p1";
  if (!SKILL_PRIORITIES.has(priority)) throw new Error(`${where}: metadata priority is p0, p1 or p2.`);
  const body = sectionText(found[2] ?? "");
  if (!body) throw new Error(`${where} has no instructions after its frontmatter.`);
  checkText(where, [description, ...Object.values(metadata)].join("\n"), { headings: false });
  checkText(where, body);
  const text = `${JSON.stringify({ name, description, license: fields.license, metadata })}\n${body}`;
  return { name, description, license: fields.license, priority, keywords, tools: list(metadata.tools), metadata, body, sha256: createHash("sha256").update(text).digest("hex") };
}

/** Every bundled skill (a folder with a SKILL.md under skills/), by name. */
export function readSkills(dir = SKILLS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .filter((folder) => existsSync(join(dir, folder, "SKILL.md")))
    .map((folder) => parseSkill(readFileSync(join(dir, folder, "SKILL.md"), "utf8"), folder));
}

const HEADER = (from) => [
  `// Generated by packages/prompts/scripts/generate.mjs from ${from}. Edit the Markdown, then run`,
  "// `pnpm --filter @ensemble/prompts build:sections`.",
  "",
];

/** The generated sections module's source. */
export function generatedSource(sections = readSections()) {
  const lines = [
    ...HEADER("sections/*/*.md"),
    'import type { GeneratedSection } from "./types.js";',
    "",
    "export const SECTIONS = {",
    ...sections.map((section) =>
      [
        `  ${JSON.stringify(section.name)}: {`,
        `    folder: ${JSON.stringify(section.folder)},`,
        `    text: ${JSON.stringify(section.text)},`,
        `    vars: ${JSON.stringify(section.vars)},`,
        `    sha256: ${JSON.stringify(section.sha256)},`,
        "  },",
      ].join("\n"),
    ),
    "} as const satisfies Record<string, GeneratedSection>;",
    "",
    "export type SectionName = keyof typeof SECTIONS;",
    "",
  ];
  return lines.join("\n");
}

/** The generated skills module's source. */
export function generatedSkillsSource(skills = readSkills()) {
  const lines = [
    ...HEADER("skills/*/SKILL.md at the repository root"),
    'import type { BundledSkill } from "./types.js";',
    "",
    "export const SKILLS = {",
    ...skills.map((skill) =>
      [
        `  ${JSON.stringify(skill.name)}: {`,
        `    name: ${JSON.stringify(skill.name)},`,
        `    description: ${JSON.stringify(skill.description)},`,
        `    license: ${JSON.stringify(skill.license)},`,
        `    priority: ${JSON.stringify(skill.priority)},`,
        `    keywords: ${JSON.stringify(skill.keywords)},`,
        `    tools: ${JSON.stringify(skill.tools)},`,
        `    metadata: ${JSON.stringify(skill.metadata)},`,
        `    body: ${JSON.stringify(skill.body)},`,
        `    sha256: ${JSON.stringify(skill.sha256)},`,
        "  },",
      ].join("\n"),
    ),
    "} as const satisfies Record<string, BundledSkill>;",
    "",
    "export type SkillName = keyof typeof SKILLS;",
    "",
  ];
  return lines.join("\n");
}

function main() {
  const outputs = [
    [OUTPUT, generatedSource()],
    [SKILLS_OUTPUT, generatedSkillsSource()],
  ];
  if (process.argv.includes("--check")) {
    const stale = outputs.filter(([file, source]) => {
      try {
        return readFileSync(file, "utf8") !== source;
      } catch {
        // A missing module is out of date too.
        return true;
      }
    });
    if (stale.length) {
      for (const [file] of stale) console.error(`packages/prompts/${file.slice(root.length + 1)} is out of date. Run \`pnpm --filter @ensemble/prompts build:sections\` and commit it.`);
      process.exit(1);
    }
    console.log("Prompt sections and bundled skills are up to date.");
    return;
  }
  for (const [file, source] of outputs) {
    writeFileSync(file, source);
    console.log(`Wrote ${file.slice(root.length + 1)}.`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
