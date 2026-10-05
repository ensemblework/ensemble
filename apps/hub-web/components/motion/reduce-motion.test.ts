import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "../..");

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) cssFiles(path, out);
    else if (name.endsWith(".css")) out.push(path);
  }
  return out;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return css.length;
}

/** Board drag is a separate slot. Its motion is left for that work. */
function isBoardDrag(file: string, selector: string): boolean {
  return file.includes("/components/board/") || /board\.drag/.test(selector);
}

function prop(body: string, name: string): string | null {
  const match = body.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i"));
  return match ? match[1].replace(/!important/gi, "").trim() : null;
}

/** A reduce-motion rule that still names a keyframe or a non-zero duration. */
function runningAnimation(body: string): string | null {
  if (body.includes("{")) return null;
  const shorthand = prop(body, "animation");
  const name = prop(body, "animation-name");
  const duration = prop(body, "animation-duration");
  if (shorthand !== null) return /^none\b/.test(shorthand) ? null : `animation: ${shorthand}`;
  if (name !== null && !/^none\b/.test(name)) return `animation-name: ${name}`;
  if (duration !== null && !/^0m?s$/.test(duration.split(",")[0]?.trim() ?? "")) return `animation-duration: ${duration}`;
  return null;
}

function walk(css: string, reduce: boolean, file: string, hits: string[]) {
  let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i] ?? "")) i++;
    if (i >= css.length || css[i] === "}") return i;
    const open = css.indexOf("{", i);
    if (open === -1) return css.length;
    const prelude = css.slice(i, open).trim();
    const close = matchingBrace(css, open);
    const body = css.slice(open + 1, close);
    if (/^@(-webkit-)?keyframes\b/.test(prelude)) {
      i = close + 1;
      continue;
    }
    if (prelude.startsWith("@")) {
      const mediaReduce = /@media\b/.test(prelude) && /prefers-reduced-motion\s*:\s*reduce\b/.test(prelude);
      walk(body, reduce || mediaReduce, file, hits);
    } else {
      const selectorReduce = /\[data-reduce-motion\s*=\s*["']true["']\]/.test(prelude);
      const here = reduce || selectorReduce;
      if (here && !isBoardDrag(file, prelude)) {
        const detail = runningAnimation(body);
        if (detail) hits.push(`${relative(ROOT, file)} ${prelude} { ${detail} }`);
      }
      if (body.includes("{")) walk(body, here, file, hits);
    }
    i = close + 1;
  }
  return css.length;
}

test("reduced motion does not run an animation", () => {
  const hits: string[] = [];
  for (const file of cssFiles(ROOT)) walk(stripComments(readFileSync(file, "utf8")), false, file, hits);
  assert.deepEqual(hits, []);
});
