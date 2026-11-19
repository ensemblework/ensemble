/**
 * A short name for a thread from its first message, without a model: a few of the words that matter.
 * Fast and small enough to run on every new thread, on the web or the server.
 *
 * It reads only the start of the message (the first two lines, at most 240 characters), so a pasted log,
 * a long prompt or attached content costs nothing. Greetings and "can you…" go; links, paths and code
 * become a short word or go; the rest is split into phrases at stop words and punctuation (as RAKE
 * does), and the name is the action word, if the message starts with one, then the first phrase,
 * filled out with the next phrase while there is room (keeping a short joining word such as "on").
 *
 *   "hey can you please fix the login redirect bug on Safari"  → "Fix login redirect bug on Safari"
 *   "I want you to add a dark mode toggle to the settings page" → "Add dark mode toggle"
 */

const MAX_WORDS = 6;
const MAX_CHARS = 48;
const READ_CHARS = 240;

const OPENER = /^(?:(?:hi|hello|hey|hiya|yo|ok(?:ay)?|so|please|pls|kindly|now|then|also|and|just|great|thanks|thank you)\b[\s,!.:-]*|(?:can|could|would|will) (?:you|u)\s+(?:please\s+)?|(?:i\s+(?:want|need|would like|wanna)\s+(?:you\s+)?(?:to\s+)?)|(?:i'?d like (?:you )?to)\s+|(?:let'?s|lets)\s+|(?:help me|go ahead and|make sure (?:to|that)?|try to|please)\s+(?:to\s+)?)/i;

/** Words that start a request: kept as the name's first word. */
const ACTIONS = new Set(
  "add adjust analyze analyse audit automate build bump change check clean compare configure convert create debug delete deploy design document draft explain explore export find fix generate implement import improve install investigate list make merge migrate move optimize optimise organize organise plan polish port publish refactor release remove rename reorganize replace research restore review rewrite run scaffold search set setup ship show sort speed split summarize summarise support sync test track translate update upgrade validate verify wire write".split(" "),
);

/** Short words that may join two phrases ("bug on Safari"). */
const JOINERS = new Set(["on", "in", "for", "to", "from", "with", "into", "via", "of"]);

/** Words between a joining word and its phrase ("for the page") that keep the joining word. */
const ARTICLES = new Set(["the", "a", "an", "this", "that", "these", "those", "my", "your", "our", "its", "their", "his", "her"]);

/** Words that carry no meaning in a name. */
const STOP = new Set(
  (
    "a an the this that these those it its it's is are was were be been being am do does did done doing have has had having " +
    "i me my mine we us our ours you your yours he she they them their his her him " +
    "and or but if then else so as at by about above after again against all also any because before below between both " +
    "can could would should will shall may might must need needs want wants wanna like likes please pls kindly " +
    "just really very quite maybe actually basically simply only even still yet already now currently " +
    "some something anything everything thing things stuff lot lots bit little more most much many few " +
    "what which who whom whose when where why how whether there here out up down over under again " +
    "not no yes ok okay hey hi hello thanks thank etc e.g i.e via per such than too " +
    "get got go going gonna let lets let's make sure try see look able sort kind way"
  ).split(" "),
);

/** The part of a message a name is read from: the first lines, without code, links or attached content. */
function opening(message: string): string {
  // Only the start is read, so a pasted log or attached content costs nothing.
  const cut = message.slice(0, 4000).split(/\n\n\((?:Mentioned in|Attached from) Ensemble:/)[0] ?? "";
  const noCode = cut.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`([^`\n]{1,40})`/g, "$1");
  const lines = noCode
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*>#]+|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 2);
  return lines.join(". ").slice(0, READ_CHARS);
}

/** A link becomes its last meaningful part ("github.com/o/r/issues/12" → "issue 12"), a path its file name. */
function plainWords(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, (url) => {
      const issue = /\/(issues|pull)\/(\d+)/.exec(url);
      if (issue) return ` ${issue[1] === "pull" ? "PR" : "issue"} #${issue[2]} `;
      const parts = url.replace(/[?#].*$/, "").split("/").filter(Boolean);
      const last = parts.at(-1) ?? "";
      return ` ${parts.length > 2 && !/^[\w.-]+\.[a-z]{2,}$/i.test(last) ? last : (parts[1] ?? "").replace(/^www\./, "")} `;
    })
    .replace(/(?:~|\.{1,2}|\b[\w.@-]+)?(?:\/[\w.@-]+)+/g, (path) => ` ${path.split("/").pop()} `)
    .replace(/@[a-z]+:/gi, "");
}

type Token = { word: string; stop: boolean; joiner: boolean; break: boolean };

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const part of text.split(/(\s+|[,;:!?()[\]{}"“”]|\.(?=\s|$))/)) {
    if (!part || /^\s+$/.test(part)) continue;
    if (/^[,;:!?()[\]{}"“”.]$/.test(part)) {
      out.push({ word: part, stop: true, joiner: false, break: true });
      continue;
    }
    const word = part.replace(/^['’]+|['’]+$/g, "");
    if (!word) continue;
    const lower = word.toLowerCase();
    out.push({ word, stop: STOP.has(lower) || JOINERS.has(lower), joiner: JOINERS.has(lower), break: false });
  }
  return out;
}

/** Runs of meaningful words, each with the joining word just before it (if any). */
function phrases(list: Token[]): Array<{ words: string[]; joiner: string | null }> {
  const out: Array<{ words: string[]; joiner: string | null }> = [];
  let current: string[] = [];
  let joiner: string | null = null;
  let pending: string | null = null;
  const close = () => {
    if (current.length) out.push({ words: current, joiner });
    current = [];
    joiner = null;
  };
  for (const token of list) {
    if (token.break) {
      close();
      pending = null;
      continue;
    }
    if (token.stop) {
      close();
      if (token.joiner) pending = token.word.toLowerCase();
      else if (!(pending && ARTICLES.has(token.word.toLowerCase()))) pending = null;
      continue;
    }
    if (!current.length) joiner = pending;
    pending = null;
    current.push(token.word);
  }
  close();
  return out;
}

export function threadTitle(message: string): string {
  let text = plainWords(opening(message)).replace(/\s+/g, " ").trim();
  for (let round = 0; round < 5; round += 1) {
    const next = text.replace(OPENER, "");
    if (next === text) break;
    text = next;
  }
  const list = tokens(text);
  let action: string | null = null;
  const first = list.find((token) => !token.break);
  if (first && ACTIONS.has(first.word.toLowerCase())) {
    action = first.word.toLowerCase();
    list.splice(list.indexOf(first), 1);
  }
  const words: string[] = action ? [action] : [];
  const seen = new Set(words);
  for (const phrase of phrases(list)) {
    const fresh = phrase.words.filter((word) => !seen.has(word.toLowerCase()));
    if (!fresh.length) continue;
    const room = MAX_WORDS - words.length;
    const content = words.length - (action ? 1 : 0);
    // A later phrase joins only when it fits whole and follows on: after a joining word ("on Safari"), or
    // to fill out a one-word start. A new action ("… and create tasks") or a list after a comma ends the name.
    const add = content > 0 ? [...(phrase.joiner ? [phrase.joiner] : []), ...fresh] : fresh;
    if (content > 0 && (add.length > room || content >= 4 || (!phrase.joiner && content >= 2) || ACTIONS.has(fresh[0]!.toLowerCase()))) break;
    for (const word of add.slice(0, room)) {
      words.push(word);
      seen.add(word.toLowerCase());
    }
    if (words.length >= MAX_WORDS) break;
  }
  if (!words.length || (action && words.length === 1 && !list.length)) {
    return action ? action.charAt(0).toUpperCase() + action.slice(1) : "New thread";
  }
  let title = words.join(" ");
  if (title.length > MAX_CHARS) title = title.slice(0, MAX_CHARS).replace(/\s+\S*$/, "") || title.slice(0, MAX_CHARS);
  title = title.replace(/\s+(?:on|in|for|to|from|with|into|via|of)$/i, "");
  return title.charAt(0).toUpperCase() + title.slice(1);
}
