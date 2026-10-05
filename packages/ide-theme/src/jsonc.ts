/** JSON with comments and trailing commas, as shipped by VS Code themes. No code evaluation. */

export class ThemeSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThemeSyntaxError";
  }
}

export function parseJsonc(text: string): unknown {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (source.length > 512 * 1024) throw new ThemeSyntaxError("This theme file is too large.");
  const stripped = stripTrailingCommas(stripComments(source));
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    throw new ThemeSyntaxError("This theme file isn't valid JSON.");
  }
}

function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      if (i >= text.length) throw new ThemeSyntaxError("This theme file has an unfinished comment.");
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      if (text[j] === "}" || text[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}
