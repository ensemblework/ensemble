/**
 * Length limits on text that is stored or shown.
 * JavaScript strings are UTF-16, so `slice` can cut a surrogate pair in half.
 * Postgres then rejects the value, and a title or a saved reply becomes a 500.
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const INTERNAL_ERROR =
  /Invalid `prisma|PrismaClient|\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+\.(?:ts|js|py):\d+|node_modules|\n\s*at /;

type GraphemeSegmenter = { segment: (input: string) => Iterable<{ segment: string }> };

let graphemeSegmenter: GraphemeSegmenter | null | undefined;

function segmenter(): GraphemeSegmenter | null {
  if (graphemeSegmenter !== undefined) return graphemeSegmenter;
  const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locales?: string, options?: { granularity?: "grapheme" }) => GraphemeSegmenter }).Segmenter;
  graphemeSegmenter = Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : null;
  return graphemeSegmenter;
}

export function hasLoneSurrogate(value: string): boolean {
  LONE_SURROGATE.lastIndex = 0;
  return LONE_SURROGATE.test(value);
}

export function stripLoneSurrogates(value: string): string {
  return value.replace(LONE_SURROGATE, "");
}

function graphemes(value: string): string[] {
  const splitter = segmenter();
  if (!splitter) return [...value];
  return [...splitter.segment(value)].map((part) => part.segment);
}

/** At most `maxLength` UTF-16 code units, ending on a grapheme, with no lone surrogate. */
export function truncateText(value: string, maxLength: number): string {
  const clean = stripLoneSurrogates(value);
  if (maxLength <= 0) return "";
  if (clean.length <= maxLength) return clean;
  let out = "";
  for (const part of graphemes(clean)) {
    if (out.length + part.length > maxLength) break;
    out += part;
  }
  return stripLoneSurrogates(out);
}

/**
 * At most `maxLength` code units: the start (two thirds) and the end (one third) with a note of how much
 * was cut between them, on grapheme boundaries. For output whose end matters as much as its start: a
 * command's error, a result's last fields.
 */
export function headAndTail(value: string, maxLength: number): string {
  const clean = stripLoneSurrogates(value);
  if (clean.length <= maxLength) return clean;
  const { head, tail } = headAndTailParts(clean, maxLength);
  return `${head}${cutNote(clean.length - head.length - tail.length)}${tail}`;
}

const cutNote = (cut: number) => `\n… [${cut} characters cut] …\n`;

/**
 * The start and end `headAndTail` keeps of a text longer than `maxLength`, without the note between
 * them: the start ends at `head.length`, the end begins at `value.length - tail.length`.
 */
export function headAndTailParts(value: string, maxLength: number): { head: string; tail: string } {
  if (value.length <= maxLength) return { head: value, tail: "" };
  const room = Math.max(0, maxLength - cutNote(value.length).length);
  const headRoom = Math.ceil((room * 2) / 3);
  const tailRoom = room - headRoom;
  // Graphemes only near the cuts: a long text split whole would cost far more than the parts kept.
  const head = graphemeStart(value.slice(0, headRoom + 16), headRoom);
  const tail = graphemeEnd(value.slice(Math.max(head.length, value.length - tailRoom - 16)), tailRoom);
  return { head, tail };
}

function graphemeStart(text: string, max: number): string {
  let out = "";
  for (const part of graphemes(text)) {
    if (out.length + part.length > max) break;
    out += part;
  }
  return out;
}

function graphemeEnd(text: string, max: number): string {
  const parts = graphemes(text);
  let out = "";
  for (let index = parts.length - 1; index >= 0 && out.length + parts[index]!.length <= max; index -= 1) out = parts[index] + out;
  return out;
}

/** Stream or display chunks that never stop inside an emoji. */
export function chunkText(value: string, size = 24): string[] {
  const clean = stripLoneSurrogates(value);
  if (!clean || size <= 0) return [];
  const chunks: string[] = [];
  let current = "";
  for (const part of graphemes(clean)) {
    if (!current) {
      current = part;
      continue;
    }
    if (current.length + part.length > size) {
      chunks.push(current);
      current = part;
      continue;
    }
    current += part;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function looksInternal(message: string): boolean {
  return INTERNAL_ERROR.test(message);
}

/** A data document (a JSON body, an HTML page) rather than a sentence: never shown to people as an error. */
export function looksLikeData(message: string): boolean {
  const text = message.trim();
  if (/^<(?:[a-z!?/])/i.test(text)) return true;
  if (!/^[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return /^\{\s*"/.test(text);
  }
}

export const GENERIC_SAVE_FAILURE = "The reply could not be saved.";

const GENERIC_FAILURE = "Something went wrong. Nothing else was changed.";

/** The error's own sentence, or `fallback` when it has none fit for people (empty, internal, or a raw body). */
export function safePublicError(error: unknown, fallback = GENERIC_FAILURE): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.trim() && !looksInternal(message) && !looksLikeData(message)) return truncateText(message, 400);
  return fallback.trim() && !looksInternal(fallback) && !looksLikeData(fallback) ? fallback : GENERIC_FAILURE;
}

/**
 * Save `answer` when the database accepts it.
 * A failed save is logged and replaced with a generic sentence. The caller still
 * receives the model's answer so the person is not shown a stack trace.
 */
export async function persistAssistantText(
  write: (content: string) => Promise<void>,
  answer: string,
  log: (error: unknown) => void,
): Promise<{ shown: string; saved: string }> {
  const safeAnswer = stripLoneSurrogates(answer).trim() || "The assistant did not produce a reply.";
  try {
    await write(safeAnswer);
    return { shown: safeAnswer, saved: safeAnswer };
  } catch (error) {
    log(error);
    try {
      await write(GENERIC_SAVE_FAILURE);
    } catch (again) {
      log(again);
    }
    return { shown: safeAnswer, saved: GENERIC_SAVE_FAILURE };
  }
}

/** The first `max` UTF-8 bytes of a text, cut on a character boundary. */
export function sliceBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid)) <= max) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}
