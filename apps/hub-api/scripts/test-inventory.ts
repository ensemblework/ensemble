/**
 * Every test file under apps/hub-api runs from one of its package scripts (docs/01 §9, docs/37): a file that no
 * script names, by its path or by a glob, fails this check unless SKIPPED says why it runs nowhere. A
 * skipped file that a script runs, or that is gone, fails it too, and so does a script naming a test
 * file that is gone. `pnpm --filter @ensemble/hub-api test:inventory:check`; the fast checks run it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const TEST_FILE = /\.test\.(ts|tsx|mts|mjs|js)$/;

/** Test files that no package script runs, each with the reason. */
const SKIPPED: Record<string, string> = {
  "src/docs-helper/helper.test.ts": "Answers from the built public docs (apps/docs/out/search-index.json): the fast checks' docs step builds them first, then runs it.",
};

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return TEST_FILE.test(entry.name) ? [relative(root, path).split(sep).join("/")] : [];
  });
}

/** A script's glob (`src/bridge/**\/*.test.ts`) as a pattern over paths from the package folder. */
function globPattern(glob: string): RegExp {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, "(?:.*/)?");
  return new RegExp(`^${source}$`);
}

const scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
const words = Object.values(scripts)
  .flatMap((script) => script.split(/\s+/))
  .map((word) => word.replace(/^["']|["']$/g, "").replace(/^\.\//, ""))
  .filter((word) => TEST_FILE.test(word));
const named = new Set(words.filter((word) => !word.includes("*")));
const globs = words.filter((word) => word.includes("*")).map(globPattern);
const listed = (file: string) => named.has(file) || globs.some((glob) => glob.test(file));

const files = testFiles(root).sort();
const problems = [
  ...files.filter((file) => !listed(file) && !SKIPPED[file]?.trim()).map((file) => `${file}: in no package script; add it to "test" (unit tests) or "test:public" (in-memory API tests), or to SKIPPED here with the reason it runs nowhere.`),
  ...Object.keys(SKIPPED).filter(listed).map((file) => `${file}: a package script runs it, so it comes off SKIPPED.`),
  ...Object.keys(SKIPPED).filter((file) => !existsSync(join(root, file))).map((file) => `${file}: on SKIPPED but gone.`),
  ...[...named].filter((file) => !existsSync(join(root, file))).map((file) => `${file}: a package script names it, but it is gone.`),
];
console.log(`${files.length} test files: ${files.filter(listed).length} in package scripts, ${Object.keys(SKIPPED).length} skipped.`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
