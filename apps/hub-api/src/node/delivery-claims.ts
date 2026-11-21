/**
 * Does a node's reply say it sent something into the chat that did not reach it? (docs/35 §6.1, the
 * delivery check.) "Here is the screenshot", "I've attached the report", "the video is below": each such
 * claim needs a picture, video or file that reaches the chat with this turn (the turn's media, a capture
 * held for its owner's preview card, or a link to a saved file in the reply). English words only, from a
 * short list, no model call. A claim with nothing behind it goes back to the model once; if it stays, it
 * is taken out of the reply and a plain note says what was not attached.
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

/** The claims for one kind of thing: pictures and videos may be "here", a file must be attached or sent. */
function patterns(kind: ClaimKind): RegExp[] {
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
    // "I've attached the report", "sent you the screenshots", "created and shared the summary"
    String.raw`${NOT_YOURS}\b(?:attached|sent|shared|posted|uploaded)\s+(?:you\s+)?(?:${DET}\s+)?${BETWEEN}${noun}\b`,
  ];
  // "here is the screenshot": a picture or video cannot be written in the reply itself; a report or file can.
  if (kind !== "file") list.unshift(String.raw`\bhere(?:['’]s|\s+is|\s+are)\s+(?:${DET}\s+)?${BETWEEN}${noun}\b`);
  return list.map((source) => new RegExp(source, "gi"));
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

/** Whether a sentence ends at `index`: a line break, "!" or "?", or a dot followed by a space or the end (not the dot in "report.md"). */
const stops = (text: string, index: number): boolean => {
  const char = text[index]!;
  return char === "\n" || char === "!" || char === "?" || (char === "." && (index + 1 >= text.length || /[\s)"'’\]*_]/.test(text[index + 1]!)));
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

/** The delivery claims a reply makes, one per sentence, in the order written. */
export function deliveryClaims(text: string): DeliveryClaim[] {
  const found = new Map<number, DeliveryClaim>();
  for (const { kind, list } of PATTERNS) {
    for (const pattern of list) {
      for (const match of text.matchAll(pattern)) {
        const { start, end } = sentenceAt(text, match.index);
        if (found.has(start) || match.index + match[0].length > end) continue;
        const sentence = text.slice(start, end).trim();
        if (!sentence || sentence.endsWith("?") || NEGATED.test(sentence) || CONDITIONAL.test(sentence) || THEIRS.test(sentence)) continue;
        // "here is the screenshot" names its own place; anything else may name another one ("attached it to the task").
        if (!/^here/i.test(match[0]) && elsewhere(text.slice(match.index, end))) continue;
        const rest = `${text.slice(start, match.index)} ${text.slice(match.index + match[0].length, end)}`;
        found.set(start, { kind, noun: match.groups!.noun!, sentence, start, end, whole: words(rest) <= 4 });
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

/** The reply without its false claims: a sentence that only made the claim goes, any other stays; a plain note says what was not attached. */
export function withoutClaims(text: string, claims: readonly DeliveryClaim[]): string {
  let kept = text;
  for (const claim of claims.filter((row) => row.whole).sort((a, b) => b.start - a.start)) {
    let before = kept.slice(0, claim.start);
    let after = kept.slice(claim.end);
    if (/(?:^|\n)[ \t]*$/.test(before)) {
      // The claim began its line: the rest of the line moves up, and a line left empty goes.
      after = after.replace(/^[ \t]+/, "");
      if (!after || after.startsWith("\n")) before = before.replace(/\n?[ \t]*$/, "");
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
