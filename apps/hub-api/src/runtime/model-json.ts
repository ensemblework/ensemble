/**
 * Pull one JSON value out of a model reply.
 *
 * The caller names the shape it can use. Triage wants a todos array or an
 * object that holds one. The planner wants an object with `steps`. A complete
 * value that does not match is skipped, and the scan keeps going. A value
 * nested inside an opener that never closes is not a candidate, so a cut-off
 * reply is no match and the caller can fall back. The scan is one forward
 * pass and gives up after 64 top-level starts, so a long run of unmatched
 * braces stays cheap. Deep nesting that blows the parser stack is no match.
 */

const MAX_STARTS = 64;

export type JsonShape = "triage" | "plan";

export function parseModelJson(text: string, shape?: JsonShape): unknown {
  const found = firstMatch(text, shape);
  if (found !== undefined) return found;
  // A stray quote or brace in the prose used to hide a later object. The strict
  // scan still rejects a cut-off reply and two top-level values. This pass only
  // runs when that scan found nothing.
  const recovered = recover(text, shape);
  if (recovered !== undefined) {
    // The reply is not logged. It may be an email.
    console.warn(`model json fell back to a raw scan: ${proseFault(text)}`);
    return recovered;
  }
  throw new Error(`The model did not return JSON: ${text.slice(0, 200)}`);
}

/** Why the strict scan missed a later value. Structural only; no reply text. */
function proseFault(text: string): string {
  let quote = false;
  let brace = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === '"') quote = true;
    if ((char === "{" || char === "[") && !looksLikeJson(text, index)) brace = true;
    if ((char === "{" || char === "[") && looksLikeJson(text, index)) break;
  }
  if (quote && brace) return "stray quote and brace in prose";
  if (quote) return "stray quote in prose";
  if (brace) return "stray brace in prose";
  return "prose before the JSON value";
}

function firstMatch(text: string, shape: JsonShape | undefined): unknown | undefined {
  const trimmed = text.trim();
  if (trimmed) {
    const whole = tryParse(trimmed);
    if (whole.ok && accepts(whole.value, shape)) return whole.value;
  }
  return scan(text, shape);
}

function accepts(value: unknown, shape: JsonShape | undefined): boolean {
  if (shape === "triage") return isTriagePayload(value);
  if (shape === "plan") return isPlanPayload(value);
  return true;
}

/** A todos array, one todo, or an object that wraps them. `[1]` and `{}` are not. */
export function isTriagePayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((item) => isRecord(item));
  if (!isRecord(value)) return false;
  if (Array.isArray(value.todos)) return true;
  if ("todo" in value && (value.todo == null || isRecord(value.todo))) return true;
  return typeof value.id === "string" && typeof value.title === "string" && value.title.trim().length > 0;
}

function isPlanPayload(value: unknown): boolean {
  return isRecord(value) && "steps" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return { ok: false };
    throw error;
  }
}

/**
 * One left-to-right pass. Only a value that starts and ends at depth 0 is a
 * candidate. Two values that both match is no match: keeping the first would
 * drop the rest with no fallback.
 */
function scan(text: string, shape: JsonShape | undefined): unknown | undefined {
  let accepted: unknown;
  let acceptedCount = 0;
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  let starts = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      if (depth === 0) {
        if (starts >= MAX_STARTS) break;
        starts += 1;
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char !== "}" && char !== "]") continue;
    if (depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    const parsed = tryParse(text.slice(start, index + 1));
    start = -1;
    if (!parsed.ok || !accepts(parsed.value, shape)) continue;
    acceptedCount += 1;
    if (acceptedCount > 1) return undefined;
    accepted = parsed.value;
  }
  if (depth !== 0) return undefined;
  return acceptedCount === 1 ? accepted : undefined;
}

function looksLikeJson(text: string, open: number): boolean {
  let index = open + 1;
  while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
  const next = text[index] ?? "";
  if ((text[open] ?? "") === "{") return next === '"' || next === "}";
  return next === '"' || next === "{" || next === "[" || next === "]" || next === "-" || next === "t" || next === "f" || next === "n" || (next >= "0" && next <= "9");
}

/** End index of one JSON value, or null when the opener never closes. */
function jsonEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char !== "}" && char !== "]") continue;
    depth -= 1;
    if (depth === 0) return index + 1;
  }
  return null;
}

/**
 * First well-formed value, ignoring quotes and braces that are not themselves
 * JSON. An opener that looks like JSON and never closes is a cut-off reply:
 * nothing inside it is returned.
 */
function recover(text: string, shape: JsonShape | undefined): unknown | undefined {
  let accepted: unknown;
  let acceptedCount = 0;
  let starts = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char !== "{" && char !== "[") continue;
    if (starts >= MAX_STARTS) break;
    starts += 1;
    if (!looksLikeJson(text, index)) continue;
    const end = jsonEnd(text, index);
    if (end === null) return undefined;
    const parsed = tryParse(text.slice(index, end));
    if (!parsed.ok || !accepts(parsed.value, shape)) {
      index = end - 1;
      continue;
    }
    acceptedCount += 1;
    if (acceptedCount > 1) return undefined;
    accepted = parsed.value;
    index = end - 1;
  }
  return acceptedCount === 1 ? accepted : undefined;
}
