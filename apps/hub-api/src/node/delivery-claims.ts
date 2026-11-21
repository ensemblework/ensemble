/**
 * Does a node's reply say it sent something into the chat that did not reach it? (docs/35 §6.1, the
 * delivery check.) "Here is the screenshot", "I've attached the report", "the video is below": each such
 * claim needs a picture, video or file that reaches the chat with this turn (the turn's media, a capture
 * held for its owner's preview card, or a link to a saved file in the reply). Only the node's own word is a
 * claim: said with I or we, or with no subject ("Sent you the screenshots", "Here is …"), never what someone
 * else did or said, and never words in quotes or code. English words only, from a short list, no model call.
 * A claim with nothing behind it goes back to the model once; if it stays, it is taken out of the reply and
 * a plain note says what was not attached.
 */

export type ClaimKind = "screenshot" | "picture" | "video" | "file";

/** One claim in a reply: what it says was sent, the sentence that says it, and where that sentence is. */
export type DeliveryClaim = {
  kind: ClaimKind;
  /** The thing named, as written ("screenshots", "report.md"). */
  noun: string;
  sentence: string;
  start: number;
  end: number;
  /** The sentence says nothing but the claim, so it can go without losing anything. */
  whole: boolean;
};

/** What reached the chat with this turn, by class. */
export type Delivered = { pictures: number; videos: number; files: number };

const NOUNS: Record<ClaimKind, string> = {
  screenshot: String.raw`screen ?shots?|screen ?grabs?|screen ?captures?`,
  picture: String.raw`pictures?|images?|photos?|photographs?`,
  video: String.raw`screen ?recordings?|recordings?|videos?|screencasts?`,
  file: String.raw`[\w-]+\.(?:md|markdown|txt|pdf|csv|tsv|json|ya?ml|html?|docx?|xlsx?|pptx?|zip|log|png|jpe?g|gif|webp|mp4|webm|mov)|files?|reports?|documents?|pdfs?|spreadsheets?|csvs?|archives?|summar(?:y|ies)`,
};
/** Text within one sentence: a dot inside a name ("report.md", "example.com") does not end it. */
const SAME = String.raw`(?:[^.!?\n]|\.(?=\S))`;
const DET = String.raw`(?:the|a|an|your|my|this|that|these|those|both|all|\d+|one|two|three|four|five|six|seven|eight|nine|ten)`;
const BETWEEN = String.raw`(?:[\w’'-]+(?:\.[\w’'-]+)*\s+){0,4}?`;
const NOT_YOURS = String.raw`(?<!\byou\s)(?<!\byou['’]ve\s)(?<!\byou have\s)`;

/** The claims for one kind of thing: pictures and videos may be "here", a file must be attached or sent. `acts`: a verb whose subject is checked. */
function patterns(kind: ClaimKind): Array<{ pattern: RegExp; acts: boolean }> {
  const noun = `(?<noun>${NOUNS[kind]})`;
  const shown = kind === "file" ? "attached|included" : "attached|included|below|above";
  const list = [
    // "the screenshot of the page is attached", "the screenshots are below"
    String.raw`\b${noun}\b${SAME}{0,60}?\b(?:is|are)\s+(?:now\s+)?(?:${shown})\b`,
    // "**Screenshot:** attached below"
    String.raw`\b${noun}\b\s*[:*]+\s*(?:\*+\s*)?(?:attached|${kind === "file" ? "included" : "below|above"})\b`,
    // "attached is the report", "attached are the pictures"
    String.raw`\battached\s+(?:is|are|below|above|here)\b${SAME}{0,40}?\b${noun}\b`,
    // "see the attached file", "see the screenshot below"
    String.raw`\bsee\s+(?:the\s+)?attached\s+${BETWEEN}${noun}\b`,
    String.raw`\bsee\s+(?:the\s+)?${noun}\s+(?:below|above|attached)\b`,
  ];
  // "here is the screenshot": a picture or video cannot be written in the reply itself; a report or file can.
  if (kind !== "file") list.unshift(String.raw`\bhere(?:['’]s|\s+is|\s+are)\s+(?:${DET}\s+)?${BETWEEN}${noun}\b`);
  // "I've attached the report", "sent you the screenshots", "created and shared the summary": whoever did it is checked.
  const acts = String.raw`${NOT_YOURS}\b(?:attached|sent|shared|posted|uploaded)\s+(?:you\s+)?(?:${DET}\s+)?${BETWEEN}${noun}\b`;
  return [...list.map((source) => ({ pattern: new RegExp(source, "gi"), acts: false })), { pattern: new RegExp(acts, "gi"), acts: true }];
}

const PATTERNS = (["screenshot", "picture", "video", "file"] as const).map((kind) => ({ kind, list: patterns(kind) }));

/** A sentence that says something was not sent, or asks, or makes it depend on something else: not a claim. */
const NEGATED = /\b(?:no|not|never|nothing|none|cannot|unable|without|failed)\b|n['’]t\b/i;
const CONDITIONAL = /^\W*(?:if|once|when|after|before|as soon as|unless)\b/i;
/** Something the owner sent: "the PDF you attached". */
const THEIRS = /\byou(?:['’]ve| have)?\s+(?:attached|sent|shared|uploaded|posted)\b/i;
/** Where a claim says it went, when that is the chat itself. */
const CHAT = /^(?:you|yourself|here|this chat|the chat|this conversation|our chat|this thread|the thread|this message|this reply|my reply)\b/i;
/** Somewhere else: "to the task", "into your Drive", "with Mira", "with the team", "in the Jira ticket". */
const TO_SOMEONE = /\b(?:to|into|onto)\s+((?:the|your|a|an|my|our|their|his|her)\b[^,.;:!?\n]{0,40}|[A-Z@#][^,.;:!?\n]{0,40})|\bwith\s+((?:the|your|our)\s+team\b|everyone\b|them\b|him\b|her\b|[A-Z@#][^,.;:!?\n]{0,40})/g;
const IN_APP =
  /\b(?:in|on)\s+(?:the\s+|your\s+|a\s+|an\s+|my\s+|our\s+)?(?:task|ticket|issue|card|page|doc|google|drive|dropbox|onedrive|sharepoint|notion|slack|teams|jira|linear|github|gitlab|confluence|email|inbox|calendar|event|meeting|project|board|folder|repo|repository|channel|ensemble files|files)\b|\b(?:in|on)\s+[#@][\w-]+|\b(?:by|via|over|through)\s+(?:e-?mail|mail|slack|teams|text|sms|whatsapp|telegram|discord)\b/i;

function elsewhere(rest: string): boolean {
  for (const match of rest.matchAll(TO_SOMEONE)) if (!CHAT.test((match[1] ?? match[2] ?? "").trim())) return true;
  return IN_APP.test(rest);
}

/** What stands in, at the same length, for text the reply quotes or shows as code: no letter, space or sentence end. */
const BLANK = "\u2063";
const FENCED = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g;
const QUOTED = /``[^\n]*?``|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|^[ \t]*>[^\n]*/gm;
const blanked = (found: string) => found.replace(/[^\n]/g, BLANK);

/**
 * The reply with what it quotes, its code and its block quotes blanked, at the same length: words there are not the
 * node's claims. A quoted sentence keeps its own end ("Thanks.") so the sentence after the quote is one of its own.
 */
function unquoted(text: string): string {
  return text.replace(FENCED, blanked).replace(QUOTED, (found) => {
    const end = /[.!?]+(?=["”]$)/.exec(found);
    const blank = blanked(found);
    return end ? `${blank.slice(0, end.index)}${end[0]}${blank.slice(end.index + end[0].length)}` : blank;
  });
}

/** Abbreviations whose dot ends no sentence ("U.S.", "e.g.", "i.e.", "etc.", "vs.", "Dr. Rao", "9 a.m."): a line break after one still does. */
const ABBREVIATION = /(?:^|[^\p{L}\p{N}])(?:\p{L}(?:\.\p{L})+|etc|vs|mr|mrs|ms|dr|prof|sr|jr|st|approx|inc|ltd|co|corp|fig|cf|al|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/iu;

/**
 * Whether a sentence ends at `index`: a line break, "!" or "?", or a dot followed by a space, a closing mark or the end,
 * but not the dot in "report.md" or "4.99", after an abbreviation, or after a list item's number ("1. Here is …").
 */
const stops = (text: string, index: number): boolean => {
  const char = text[index]!;
  if (char === "\n" || char === "!" || char === "?") return true;
  if (char !== ".") return false;
  if (index + 1 >= text.length || text[index + 1] === "\n") return true;
  if (!/[\s)"'’\]*_\u2063]/.test(text[index + 1]!)) return false;
  return !ABBREVIATION.test(text.slice(Math.max(0, index - 12), index)) && !/^[ \t]*\d{1,3}$/.test(text.slice(text.lastIndexOf("\n", index - 1) + 1, index));
};

/** The sentence around `index`: from the last stop before it to the next one after it. */
function sentenceAt(text: string, index: number): { start: number; end: number } {
  let start = index;
  while (start > 0 && !stops(text, start - 1)) start -= 1;
  let end = index;
  while (end < text.length && !stops(text, end)) end += 1;
  while (end < text.length && /[.!?]/.test(text[end]!)) end += 1;
  return { start, end };
}

const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
/** A clause's words, without list bullets, emphasis or quote marks. */
const tokens = (text: string) => text.match(/[\p{L}\p{N}][\p{L}\p{N}’'@#-]*/gu) ?? [];

/** The node itself: "I", "I've", "we". */
const SELF = /^(?:i|we)(?:['’](?:ve|d))?$/i;
/** Between a subject and its verb ("have just"), or opening a clause without naming anyone ("also", "done"). */
const FILLER = /^(?:have|has|had|just|also|now|already|then|finally|successfully|again|both|all|and|so|ok|okay|sure|done|great|yes|plus|next)$/i;
/** A word a clause that names no subject opens with: a verb in the past ("fixed it and sent…", "made it and shared…"). */
const VERB = /^(?:\p{L}+ed|made|took|ran|wrote|found|built|got|did|put|set|read|saw|sent|drew|began|brought|kept|left|gave|chose|caught|held|led|paid|went)$/iu;
/** Where one clause ends and the next begins; `and`, `then` and the like join a verb to the clause before. */
const CLAUSE = /([,;:()\n]|\s[-–]\s)|\b(and|but|so|then|because|while|since|although|though)\b/gi;
/** Someone said it: "Mira said here is …", "the client says the report is attached". */
const REPORTED = /\b(?:says|said|wrote|writes|mentions|mentioned|told|tells|thinks|thought|confirms|confirmed|claims|claimed|noted|according to|replies|replied|asks|asked)\b/i;

/** The last clause of `text`, what comes before it, and whether a conjunction joined it to that ("fixed it and sent"). */
function lastClause(text: string): { clause: string; before: string; conjunction: boolean } {
  let last: RegExpExecArray | null = null;
  for (const match of text.matchAll(CLAUSE)) last = match;
  if (!last) return { clause: text, before: "", conjunction: false };
  return { clause: text.slice(last.index + last[0].length), before: text.slice(0, last.index), conjunction: Boolean(last[2]) };
}

/** A clause's words without the fillers it opens with ("also", "done") or that stand before its verb ("have just"). */
function cleaned(clause: string): string[] {
  const words = tokens(clause);
  while (words.length && FILLER.test(words[0]!)) words.shift();
  while (words.length && FILLER.test(words.at(-1)!)) words.pop();
  return words;
}

/**
 * Whether the node itself did what an active claim says, from the words before its verb: "I've sent", "sent you",
 * "As requested, sent", "fixed it and attached", "I checked it and attached"; not "Mira sent", "the client has shared"
 * or "your manager checked it and attached". A verb joined by a conjunction has the subject of the clause before it.
 */
function nodeDid(lead: string): boolean {
  const { clause, before, conjunction } = lastClause(lead);
  const words = cleaned(clause);
  if (words.length) return words.length === 1 && SELF.test(words[0]!);
  if (!conjunction) return true;
  const earlier = cleaned(lastClause(before).clause);
  return !earlier.length || SELF.test(earlier[0]!) || VERB.test(earlier[0]!);
}

/** Words the claim's sentence has besides the claim, not counting who made it ("I've") or the marks it opens with. */
function besides(lead: string, tail: string): number {
  return tokens(lead).filter((word) => !SELF.test(word) && !FILLER.test(word)).length + words(tail);
}

/** The delivery claims a reply makes, one per sentence, in the order written. */
export function deliveryClaims(text: string): DeliveryClaim[] {
  const plain = unquoted(text);
  const found = new Map<number, DeliveryClaim>();
  for (const { kind, list } of PATTERNS) {
    for (const { pattern, acts } of list) {
      for (const match of plain.matchAll(pattern)) {
        const { start, end } = sentenceAt(plain, match.index);
        if (found.has(start) || match.index + match[0].length > end) continue;
        const sentence = plain.slice(start, end).trim();
        if (!sentence || sentence.endsWith("?") || NEGATED.test(sentence) || CONDITIONAL.test(sentence) || THEIRS.test(sentence)) continue;
        // "here is the screenshot" names its own place; anything else may name another one ("attached it to the task").
        if (!/^here/i.test(match[0]) && elsewhere(plain.slice(match.index, end))) continue;
        // Only the node's own word counts: never what someone else did or said.
        const lead = plain.slice(start, match.index);
        if (acts ? !nodeDid(lead) : REPORTED.test(lastClause(lead).clause)) continue;
        const whole = besides(text.slice(start, match.index), text.slice(match.index + match[0].length, end)) <= 4;
        found.set(start, { kind, noun: match.groups!.noun!, sentence: text.slice(start, end).trim(), start, end, whole });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.start - b.start);
}

/** Captures a turn's tools kept but held for the owner's preview card: they reach the owner there (a tool result's `data.evidence`). */
export function heldCaptures(results: readonly unknown[]): Array<{ kind: string }> {
  const held: Array<{ kind: string }> = [];
  for (const result of results) {
    const list = (result as { data?: { evidence?: unknown } } | null)?.data?.evidence;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const row = (item ?? {}) as { held?: unknown; kind?: unknown };
      if (row.held === true && typeof row.kind === "string") held.push({ kind: row.kind });
    }
  }
  return held;
}

/** What reached the chat: media and held captures by kind; a link to a file in the reply counts as a file. */
export function deliveredWith(media: ReadonlyArray<{ kind: string }>, text: string): Delivered {
  const pictures = media.filter((item) => item.kind === "screenshot" || item.kind === "image").length;
  const videos = media.filter((item) => item.kind === "video").length;
  const links = /ensemble:\/\/file\/[0-9a-f-]{36}|\]\(\s*(?:https?:\/\/|ensemble:\/\/|\/)[^)\s]+\)/i.test(text) ? 1 : 0;
  return { pictures, videos, files: media.length + links };
}

function backed(kind: ClaimKind, delivered: Delivered): boolean {
  if (kind === "video") return delivered.videos > 0;
  if (kind === "file") return delivered.files > 0;
  return delivered.pictures > 0;
}

const NOTE: Record<ClaimKind, string> = {
  screenshot: "No screenshot was attached.",
  picture: "No picture was attached.",
  video: "No video was attached.",
  file: "No file was attached.",
};

const named = (noun: string) => (/\.\w+$/.test(noun) ? noun : `the ${noun.toLowerCase()}`);

/** The feedback for the one round that may fix it: what the reply said, and what to do. */
export function claimFeedback(claims: readonly DeliveryClaim[]): string {
  const nouns = [...new Set(claims.map((claim) => named(claim.noun)))];
  const plural = nouns.length > 1 || /s$/i.test(claims[0]!.noun) && !/\.\w+$/.test(claims[0]!.noun);
  const what = nouns.length > 1 ? `${nouns.slice(0, -1).join(", ")} and ${nouns.at(-1)}` : nouns[0]!;
  return `You said ${what} ${plural ? "are" : "is"} attached, but nothing reached the chat. Attach ${plural ? "them" : "it"} with the right tool, or correct your reply.`;
}

/**
 * The reply without its false claims: a sentence that only made the claim goes, with its emphasis and, alone on its
 * line, with its line and bullet; any other stays. A plain note says what was not attached.
 */
export function withoutClaims(text: string, claims: readonly DeliveryClaim[]): string {
  let kept = text;
  for (const claim of claims.filter((row) => row.whole).sort((a, b) => b.start - a.start)) {
    let before = kept.slice(0, claim.start);
    let after = kept.slice(claim.end);
    // The emphasis the sentence opens with ("**Here is the screenshot.**") goes with it; when it holds more than the
    // sentence ("**Here is the screenshot. Prices are in.**"), what is left keeps it.
    const opened = /^\s*(?:[-*+]\s+|\d{1,3}[.)]\s+)?([*_~]+)(?=\S)/.exec(kept.slice(claim.start, claim.end))?.[1];
    if (opened) {
      const closing = [...opened].reverse().join("");
      after = after.startsWith(closing) ? after.slice(closing.length) : `${opened}${after.replace(/^[ \t]+/, "")}`;
    }
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineBreak = after.indexOf("\n");
    const line = `${before.slice(lineStart)}${lineBreak < 0 ? after : after.slice(0, lineBreak)}`;
    if (/^[ \t]*(?:[-*+]|\d{1,3}[.)])?[ \t]*$/.test(line)) {
      // Nothing else on its line but a list bullet: the line goes.
      before = before.slice(0, lineStart);
      after = lineBreak < 0 ? "" : after.slice(lineBreak + 1);
      if (before.endsWith("\n\n") && after.startsWith("\n")) after = after.replace(/^\n+/, "");
    } else if (/^[ \t]*(?:[-*+]\s+|\d{1,3}[.)]\s+)?$/.test(before.slice(lineStart))) {
      // The claim began its line (after any bullet): the rest of the line moves up.
      after = after.replace(/^[ \t]+/, "");
    } else {
      // Within a line: what stays on either side, one space apart (a closing mark or stop needs none).
      before = before.replace(/[ \t]+$/, "");
      after = after.replace(/^[ \t]+/, "");
      if (after && !/^[\n.,;:!?)*_~]/.test(after)) after = ` ${after}`;
    }
    kept = `${before}${after}`;
  }
  kept = kept.trim();
  const notes = [...new Set(claims.map((claim) => NOTE[claim.kind]))].join(" ");
  return kept ? `${kept}\n\n${notes}` : notes;
}

export type DeliveryCheck = { count: number; feedback: string; corrected: string };

/** The reply's delivery claims that nothing backs: null when every one holds. */
export function checkDelivery(text: string, delivered: Delivered): DeliveryCheck | null {
  const wrong = deliveryClaims(text).filter((claim) => !backed(claim.kind, delivered));
  if (!wrong.length) return null;
  return { count: wrong.length, feedback: claimFeedback(wrong), corrected: withoutClaims(text, wrong) };
}
