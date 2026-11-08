/**
 * Text signals for choosing a session (docs/30, Choosing a session), without any model: the same text
 * always gives the same answer.
 *
 * - Anchors: exact things two tasks can share — file paths (and their file names), code names
 *   (`rateLimiter`, `auth_session`, `SessionStore`), issue and pull request numbers (`#123`, `ABC-42`),
 *   web addresses. Taken out before the words.
 * - Terms: words without the common English ones, reduced to their stem (Porter's algorithm: ranking,
 *   ranked and ranks are all `rank`), and each two neighbouring stems as a phrase.
 * - Rarity: a term weighs log((N+1)/(df+1)) over the person's own N tasks (df: in how many it appears),
 *   so words in nearly every task (fix, update, the project's name) weigh about nothing.
 * - Similarity: the cosine of the two weighted term vectors, 0 to 1.
 */

/** Common English words, and words every task has. `text.extraStopwords` adds more. */
export const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are aren as at be because been before being below between both but by can cannot could " +
    "did do does doing don down during each etc few for from further get gets got had has have having he her here hers herself him himself his how " +
    "i if in into is isn it its itself just let lets like make makes me might more most must my myself need needs no nor not now of off on once only or other " +
    "our ours ourselves out over own per please same shall she should so some such than that the their theirs them themselves then there these they " +
    "this those through to too under until up upon us use used using very via was we were what when where which while who whom why will with within " +
    "without would yet you your yours yourself yourselves one two three new task tasks thing things something way want wants going done ok okay thanks"
  ).split(" "),
);

// ---------- Porter stemmer (M. F. Porter, 1980) ----------

function consonant(word: string, i: number): boolean {
  const c = word[i]!;
  if ("aeiou".includes(c)) return false;
  if (c === "y") return i === 0 ? true : !consonant(word, i - 1);
  return true;
}

/** m in [C](VC)^m[V]. */
function measure(stem: string): number {
  let m = 0;
  let i = 0;
  while (i < stem.length && consonant(stem, i)) i += 1;
  while (i < stem.length) {
    while (i < stem.length && !consonant(stem, i)) i += 1;
    if (i >= stem.length) break;
    while (i < stem.length && consonant(stem, i)) i += 1;
    m += 1;
  }
  return m;
}

const hasVowel = (stem: string) => [...stem].some((_, i) => !consonant(stem, i));
const doubleConsonant = (w: string) => w.length >= 2 && w[w.length - 1] === w[w.length - 2] && consonant(w, w.length - 1);
const cvc = (w: string) => w.length >= 3 && consonant(w, w.length - 3) && !consonant(w, w.length - 2) && consonant(w, w.length - 1) && !"wxy".includes(w[w.length - 1]!);

const STEP2: Array<[string, string]> = [
  ["ational", "ate"], ["tional", "tion"], ["enci", "ence"], ["anci", "ance"], ["izer", "ize"], ["bli", "ble"], ["alli", "al"], ["entli", "ent"], ["eli", "e"], ["ousli", "ous"],
  ["ization", "ize"], ["ation", "ate"], ["ator", "ate"], ["alism", "al"], ["iveness", "ive"], ["fulness", "ful"], ["ousness", "ous"], ["aliti", "al"], ["iviti", "ive"], ["biliti", "ble"], ["logi", "log"],
];
const STEP3: Array<[string, string]> = [["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"], ["ical", "ic"], ["ful", ""], ["ness", ""]];
const STEP4 = ["al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement", "ment", "ent", "ion", "ou", "ism", "ate", "iti", "ous", "ive", "ize"];

/** The first rule whose suffix the word ends with decides; it applies only when its condition holds (as Porter's own code). */
function replaceFirst(word: string, rules: Array<[string, string]>, minMeasure: number): string {
  for (const [suffix, replacement] of rules) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, -suffix.length);
    return measure(stem) > minMeasure ? stem + replacement : word;
  }
  return word;
}

export function stem(input: string): string {
  let w = input;
  if (w.length <= 2) return w;
  // Step 1a
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (!w.endsWith("ss") && w.endsWith("s")) w = w.slice(0, -1);
  // Step 1b
  let trimmed = false;
  if (w.endsWith("eed")) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else if (w.endsWith("ed") && hasVowel(w.slice(0, -2))) {
    w = w.slice(0, -2);
    trimmed = true;
  } else if (w.endsWith("ing") && hasVowel(w.slice(0, -3))) {
    w = w.slice(0, -3);
    trimmed = true;
  }
  if (trimmed) {
    if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
    else if (doubleConsonant(w) && !"lsz".includes(w[w.length - 1]!)) w = w.slice(0, -1);
    else if (measure(w) === 1 && cvc(w)) w += "e";
  }
  // Step 1c
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = `${w.slice(0, -1)}i`;
  // Steps 2 and 3
  w = replaceFirst(w, STEP2, 0);
  w = replaceFirst(w, STEP3, 0);
  // Step 4
  for (const suffix of STEP4) {
    if (!w.endsWith(suffix)) continue;
    const base = w.slice(0, -suffix.length);
    if (measure(base) > 1 && (suffix !== "ion" || base.endsWith("s") || base.endsWith("t"))) w = base;
    break;
  }
  // Step 5
  if (w.endsWith("e")) {
    const base = w.slice(0, -1);
    const m = measure(base);
    if (m > 1 || (m === 1 && !cvc(base))) w = base;
  }
  if (measure(w) > 1 && doubleConsonant(w) && w.endsWith("l")) w = w.slice(0, -1);
  return w;
}

// ---------- Anchors and terms ----------

const URL_RE = /\bhttps?:\/\/[^\s<>()"'`\]]+/gi;
const FILE_EXT = "ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|rb|php|cs|cpp|cc|c|h|hpp|m|scala|md|mdx|json|yaml|yml|toml|ini|sql|sh|ps1|css|scss|html|vue|svelte|ipynb|tex|bib|txt|csv|xml|proto|graphql|tf|lock|prisma|r";
const PATH_RE = new RegExp(`(?:[\\w.@-]+\\/)+[\\w.@-]+|\\b[\\w-]+\\.(?:${FILE_EXT})\\b`, "gi");
const CODE_RE = /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const REF_RE = /(?:^|[^\w&])#(\d{1,7})\b|\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g;
const SEGMENT = /[.!?;:\n\r]+/;

/** Exact things in a text another text can share, in one lower-case form. */
export function anchorsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,]+$/, "");
    try {
      const parsed = new URL(url);
      out.add(`url:${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`);
    } catch {
      // not an address after all
    }
  }
  const rest = text.replace(URL_RE, " ");
  for (const match of rest.matchAll(PATH_RE)) {
    const path = match[0].replace(/^\.?\/+/, "").replace(/[.,]+$/, "").toLowerCase();
    if (!/[a-z]/.test(path) || path.length < 3) continue;
    out.add(`path:${path}`);
    const name = path.split("/").pop()!;
    if (name !== path && /\.[a-z0-9]+$/.test(name)) out.add(`path:${name}`);
  }
  for (const match of rest.matchAll(CODE_RE)) out.add(`code:${match[0].toLowerCase()}`);
  for (const match of rest.matchAll(REF_RE)) out.add(match[1] ? `ref:#${match[1]}` : `ref:${match[2]!.toLowerCase()}`);
  return out;
}

/**
 * The text whose words are terms: addresses, paths and issue numbers count only as anchors; code names
 * add their words too (rateLimiter is about rate and limiting).
 */
function wordsText(text: string): string {
  return text.replace(URL_RE, " ").replace(PATH_RE, " ").replace(REF_RE, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

/** Stems of a text's meaningful words, with each two neighbours as a phrase (`a b`). */
export function termsOf(text: string, extraStopwords: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (const segment of wordsText(text).split(SEGMENT)) {
    let previous: string | null = null;
    for (const raw of segment.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3 || raw.length > 30 || /^\d+$/.test(raw) || STOPWORDS.has(raw) || extraStopwords.has(raw)) {
        previous = null;
        continue;
      }
      const term = stem(raw);
      out.push(term);
      if (previous && previous !== term) out.push(`${previous} ${term}`);
      previous = term;
    }
  }
  return out;
}

/** Each stem (and phrase) of a text as it was first written there, to show a reason in words. */
export function surfaceForms(text: string, extraStopwords: ReadonlySet<string> = new Set()): Map<string, string> {
  const out = new Map<string, string>();
  for (const segment of wordsText(text).split(SEGMENT)) {
    let previous: { term: string; word: string } | null = null;
    for (const raw of segment.split(/[^A-Za-z0-9]+/)) {
      const lower = raw.toLowerCase();
      if (lower.length < 3 || lower.length > 30 || /^\d+$/.test(lower) || STOPWORDS.has(lower) || extraStopwords.has(lower)) {
        previous = null;
        continue;
      }
      const term = stem(lower);
      if (!out.has(term)) out.set(term, lower);
      if (previous && previous.term !== term && !out.has(`${previous.term} ${term}`)) out.set(`${previous.term} ${term}`, `${previous.word} ${lower}`);
      previous = { term, word: lower };
    }
  }
  return out;
}

export interface TextFeatures {
  /** Term → weighted count (fields count more by their weight; a phrase counts 1.5×). */
  terms: Map<string, number>;
  anchors: Set<string>;
}

/** Features of weighted fields: the title counts more than the body. */
export function featuresOf(fields: ReadonlyArray<{ text: string; weight: number }>, extraStopwords: ReadonlySet<string> = new Set()): TextFeatures {
  const terms = new Map<string, number>();
  const anchors = new Set<string>();
  for (const field of fields) {
    if (!field.text) continue;
    for (const anchor of anchorsOf(field.text)) anchors.add(anchor);
    for (const term of termsOf(field.text, extraStopwords)) terms.set(term, (terms.get(term) ?? 0) + field.weight * (term.includes(" ") ? 1.5 : 1));
  }
  return { terms, anchors };
}

// ---------- Rarity over the person's own tasks ----------

export interface Corpus {
  docs: number;
  /** Term or anchor → in how many tasks it appears. */
  df: Map<string, number>;
  builtAt: number;
}

/** Document frequencies over texts (one per task). Null when the deadline passes first. */
export function buildCorpus(texts: Iterable<string>, deadline: number, extraStopwords: ReadonlySet<string> = new Set()): Corpus | null {
  const df = new Map<string, number>();
  let docs = 0;
  for (const text of texts) {
    if (Date.now() > deadline) return null;
    docs += 1;
    const seen = new Set<string>([...termsOf(text, extraStopwords), ...anchorsOf(text)]);
    for (const key of seen) df.set(key, (df.get(key) ?? 0) + 1);
  }
  return { docs, df, builtAt: Date.now() };
}

export const idf = (corpus: Corpus, key: string): number => Math.log((corpus.docs + 1) / ((corpus.df.get(key) ?? 0) + 1));

function vector(features: TextFeatures, corpus: Corpus): Map<string, number> {
  const out = new Map<string, number>();
  for (const [term, count] of features.terms) {
    const weight = (1 + Math.log(count)) * idf(corpus, term);
    if (weight > 0) out.set(term, weight);
  }
  return out;
}

export interface Similarity {
  /** Cosine of the weighted term vectors, 0–1. */
  cosine: number;
  /** Shared terms that are not common (idf ≥ 1: in fewer than about a third of the tasks), most telling first. */
  shared: string[];
  /** Shared anchors that are not common (in at most `anchorMaxDocShare` of the tasks). */
  anchors: string[];
}

export function similarity(a: TextFeatures, b: TextFeatures, corpus: Corpus, anchorMaxDocShare: number): Similarity {
  const va = vector(a, corpus);
  const vb = vector(b, corpus);
  let dot = 0;
  let na = 0;
  let nb = 0;
  const shared: Array<[string, number]> = [];
  for (const [term, x] of va) {
    na += x * x;
    const y = vb.get(term);
    if (y) {
      dot += x * y;
      if (idf(corpus, term) >= 1) shared.push([term, x * y]);
    }
  }
  for (const y of vb.values()) nb += y * y;
  const cosine = na && nb ? Math.min(1, dot / Math.sqrt(na * nb)) : 0;
  const limit = Math.max(1, Math.floor(anchorMaxDocShare * corpus.docs));
  const both = [...a.anchors].filter((anchor) => b.anchors.has(anchor) && (corpus.df.get(anchor) ?? 0) <= limit);
  // A file shared by its full path is not counted again by its name.
  const named = new Set(both.filter((anchor) => anchor.startsWith("path:") && anchor.includes("/")).map((anchor) => `path:${anchor.split("/").pop()}`));
  const anchors = both.filter((anchor) => !named.has(anchor)).sort((x, y) => Number(y.includes("/")) - Number(x.includes("/")) || x.localeCompare(y));
  return { cosine, shared: shared.sort((x, y) => y[1] - x[1]).map(([term]) => term), anchors };
}
