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

export const GENERIC_SAVE_FAILURE = "The reply could not be saved.";

export function safePublicError(error: unknown, fallback = "Something went wrong. Nothing else was changed."): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.trim() || looksInternal(message)) return fallback;
  return truncateText(message, 400);
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
