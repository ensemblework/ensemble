/**
 * Action items, decisions and transcript text from what a meeting-notes vendor
 * returns. Vendors that give action items as one block of text (Fireflies) or
 * only a Markdown summary (Granola, tl;dv) are parsed here; owners come from
 * "**Name**" groups, "Name:" prefixes or "@Name".
 */
import { createHash } from "node:crypto";
import { normalisedName } from "../../people/identity.js";
import type { ActionItemInput, MeetingPerson, TranscriptLine } from "./types.js";

const BULLET = /^\s*(?:[-*•]|\d+[.)]|\[[ xX]?\])\s+/;
const TIMESTAMP = /\s*[([]?\b(\d{1,2}:\d{2}(?::\d{2})?)\b[)\]]?\s*$/;
const INLINE_MARK = /\{\{\d{1,2}:\d{2}(?::\d{2})?\}\}/g;

function cleanLine(raw: string): string {
  return raw.replace(INLINE_MARK, "").replace(BULLET, "").replace(/^\[[ xX]?\]\s*/, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

/** "Mira Chen: send the deck" → owner Mira Chen. Only short, name-like prefixes count. */
function ownerPrefix(text: string): { owner: string; rest: string } | null {
  const match = /^@?([A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.-]*){0,3})\s*:\s+(.+)$/u.exec(text);
  if (!match) return null;
  if (/^(note|next steps?|action items?|todo|follow[- ]?up|decision|summary|owner|due)$/i.test(match[1]!)) return null;
  return { owner: match[1]!.trim(), rest: match[2]!.trim() };
}

/**
 * A block of action items as text:
 *   **Mira Chen**
 *   Send the onboarding deck to Arjun (05:12)
 *   - Arjun Rao: review the API draft
 */
export function parseActionItemsText(text: string | null | undefined): ActionItemInput[] {
  if (!text?.trim()) return [];
  const items: ActionItemInput[] = [];
  let owner: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^(?:#{1,6}\s*)?\*\*(.+?)\*\*\s*:?\s*$/.exec(line) ?? /^#{1,6}\s+(.+?)\s*:?\s*$/.exec(line);
    if (heading) {
      const name = heading[1]!.trim();
      owner = /^(unassigned|everyone|team|all|action items?|next steps?)$/i.test(name) ? null : name;
      continue;
    }
    let body = cleanLine(line);
    const time = TIMESTAMP.exec(body);
    const at = time ? time[1]! : null;
    if (time) body = body.slice(0, time.index).trim();
    if (!body || body.length < 3) continue;
    const prefixed = ownerPrefix(body);
    items.push({ text: prefixed ? prefixed.rest : body, assignee: prefixed ? { name: prefixed.owner } : owner ? { name: owner } : null, at });
  }
  return items;
}

/** Bullets under Markdown headings whose title matches. Nested headings end the section. */
export function markdownSection(markdown: string | null | undefined, title: RegExp): string[] {
  if (!markdown?.trim()) return [];
  const out: string[] = [];
  let inside = false;
  let level = 0;
  for (const raw of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw.trim()) ?? (/^\*\*(.+?)\*\*\s*:?\s*$/.test(raw.trim()) ? ["", "######", raw.trim().replace(/\*\*/g, "").replace(/:$/, "")] : null);
    if (heading) {
      const depth = heading[1]!.length;
      if (title.test(heading[2]!)) {
        inside = true;
        level = depth;
        continue;
      }
      if (inside && depth <= level) inside = false;
      if (inside && depth > level) continue;
      continue;
    }
    if (!inside) continue;
    const line = raw.trim();
    if (line) out.push(line);
  }
  return out;
}

const ACTION_HEADINGS = /\b(action items?|next steps?|to-?dos?|follow[- ]?ups?|tasks?|assignments?)\b/i;
const DECISION_HEADINGS = /\b(decisions?|decided|agreements?|agreed|outcomes?)\b/i;

export function actionItemsFromMarkdown(markdown: string | null | undefined): ActionItemInput[] {
  const lines = markdownSection(markdown, ACTION_HEADINGS);
  return parseActionItemsText(lines.join("\n"));
}

export function decisionsFromMarkdown(markdown: string | null | undefined): string[] {
  return markdownSection(markdown, DECISION_HEADINGS)
    .map(cleanLine)
    .filter((line) => line.length >= 3)
    .slice(0, 30);
}

/** Speaker blocks such as "**Sarah Johnson**\ntext" (Jamie) or "Jane Doe  00:07\ntext" (Otter). */
export function parseSpeakerBlocks(text: string | null | undefined): TranscriptLine[] {
  if (!text?.trim()) return [];
  const lines: TranscriptLine[] = [];
  let speaker = "";
  let at: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    const body = buffer.join(" ").replace(/\s+/g, " ").trim();
    if (body) lines.push({ speaker: speaker || "Speaker", text: body, at });
    buffer = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const bold = /^\*\*(.+?)\*\*\s*:?\s*(.*)$/.exec(line);
    const stamped = /^(.{1,80}?)\s{2,}(\d{1,2}:\d{2}(?::\d{2})?)$/.exec(line);
    if (bold) {
      flush();
      speaker = bold[1]!.trim();
      at = null;
      if (bold[2]) buffer.push(bold[2]);
    } else if (stamped) {
      flush();
      speaker = stamped[1]!.trim();
      at = stamped[2]!;
    } else if (line) {
      buffer.push(line);
    } else {
      flush();
    }
  }
  flush();
  return lines;
}

/** Transcript text kept on the artifact. Search and briefs need the gist, not hours of audio. */
export const TRANSCRIPT_CAP = 18_000;

export function transcriptText(lines: readonly TranscriptLine[], vendorLabel: string): string {
  let out = "";
  for (const line of lines) {
    const row = `${line.at ? `[${line.at}] ` : ""}${line.speaker}: ${line.text.replace(/\s+/g, " ").trim()}\n`;
    if (out.length + row.length > TRANSCRIPT_CAP) {
      out += `[Transcript trimmed. Open it in ${vendorLabel} for the rest.]\n`;
      break;
    }
    out += row;
  }
  return out.trim();
}

// ── whose item is it ────────────────────────────────────────────────────────

export interface Me {
  emails: Set<string>;
  names: Set<string>;
  firstNames: Set<string>;
}

export function meFrom(emails: ReadonlyArray<string | null | undefined>, names: ReadonlyArray<string | null | undefined>): Me {
  const cleanEmails = emails.map((value) => value?.trim().toLowerCase()).filter((value): value is string => Boolean(value && value.includes("@") && value !== "you@ensemble.local"));
  const cleanNames = names.map((value) => normalisedName(value ?? "")).filter(Boolean);
  return {
    emails: new Set(cleanEmails),
    names: new Set(cleanNames),
    firstNames: new Set(cleanNames.map((name) => name.split(" ")[0]!).filter((name) => name.length >= 2)),
  };
}

/** Mine when the assignee's email is one of mine, or the name is my full name (or my first name, given alone). */
export function isMine(assignee: MeetingPerson | null | undefined, me: Me): boolean {
  if (!assignee) return false;
  const email = assignee.email?.trim().toLowerCase();
  if (email) return me.emails.has(email);
  const name = normalisedName(assignee.name ?? "");
  if (!name) return false;
  if (me.names.has(name)) return true;
  return !name.includes(" ") && me.firstNames.has(name);
}

export function itemKey(text: string): string {
  return createHash("sha1").update(normalisedName(text)).digest("hex").slice(0, 12);
}

/** A due date the vendor gave, as an instant. Date-only values are 17:00 UTC that day. */
export function dueDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T17:00:00Z`) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
