/**
 * Meeting transcripts people download or copy from meeting apps, read without a model
 * (docs/03 §2.4). The format is detected from the content: WebVTT (Teams `<v Speaker>` voice
 * tags, Zoom "Speaker: text" cues), SubRip, Teams .docx and transcript-panel copies
 * ("Name  0:03"), Zoom saved transcripts ("[Name] 00:00:01"), Otter and Google Meet exports,
 * "Speaker: text" lines, and JSON sentence arrays (Fireflies, tl;dv and similar). Consecutive
 * lines by one speaker are merged; title, date, attendees and any written summary, decisions
 * and next steps in the file come along.
 */
import { actionItemsFromMarkdown, decisionsFromMarkdown, parseActionItemsText } from "./actions.js";
import { clock, type ActionItemInput, type TranscriptLine } from "./types.js";

export type TranscriptFormat =
  | "teams-vtt"
  | "zoom-vtt"
  | "vtt"
  | "srt"
  | "teams-docx"
  | "teams-copy"
  | "zoom-txt"
  | "otter"
  | "google-meet"
  | "speaker-lines"
  | "fireflies-json"
  | "tldv-json"
  | "json"
  | "plain";

export const FORMAT_LABEL: Record<TranscriptFormat, string> = {
  "teams-vtt": "Microsoft Teams transcript (.vtt)",
  "zoom-vtt": "Zoom transcript (.vtt)",
  vtt: "WebVTT captions",
  srt: "SubRip captions (.srt)",
  "teams-docx": "Microsoft Teams transcript (.docx)",
  "teams-copy": "Copied from a Teams transcript",
  "zoom-txt": "Zoom saved transcript",
  otter: "Otter.ai export",
  "google-meet": "Google Meet transcript",
  "speaker-lines": "Speaker lines",
  "fireflies-json": "Fireflies.ai export (JSON)",
  "tldv-json": "tl;dv export (JSON)",
  json: "Transcript (JSON)",
  plain: "Plain text",
};

/** A meeting time as written in the file. `zone` is set only when the file names one. */
export interface WrittenTime {
  date: string;
  time: string | null;
  zone: string | null;
}

export interface ParsedTranscript {
  format: TranscriptFormat;
  title: string | null;
  when: WrittenTime | null;
  /** An instant the file states outright (epoch or ISO with a zone). Wins over `when`. */
  startedAt: Date | null;
  durationSeconds: number | null;
  /** Names a header lists (Meet "Attendees", Otter "SPEAKERS"), speakers or not. */
  attendees: string[];
  lines: TranscriptLine[];
  summary: string;
  decisions: string[];
  actionItems: ActionItemInput[];
  /** True when decisions and action items were found by phrases in what was said, not written by a tool. */
  suggested: boolean;
  truncated: boolean;
  warnings: string[];
}

/** The most transcript text kept per meeting (the same bound as a file's text, docs/32). */
export const MAX_TRANSCRIPT_CHARS = 400_000;
/** One merged turn is split past this length so long monologues stay readable. */
const MAX_TURN_CHARS = 2_400;

const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
const CUE_TIMING = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
const HEADER_LINE = new RegExp(String.raw`^(.{1,80}?)\s+(${TIME})\s*$`);
const HEADER_INLINE = new RegExp(String.raw`^(.{1,80}?)\s{2,}(${TIME})\s+(\S.*)$`);
const ZOOM_HEADER = new RegExp(String.raw`^\[([^\]]{1,80})\]\s+(${TIME})\s*(.*)$`);
const TIME_FIRST = new RegExp(String.raw`^\[?(${TIME})\]?\s+(.{1,80}?)\s*:\s+(\S.*)$`);
const BARE_TIME = new RegExp(String.raw`^\[?(${TIME})\]?$`);
const SPEAKER_TEXT = /^([^:\n]{1,60}?)\s*:\s+(\S.*)$/;
const NOT_A_NAME = /^(https?|www|note|notes|summary|agenda|action items?|next steps?|decisions?|todo|q|a|re|fw|fwd|subject|date|time|title|attendees|participants|speakers|transcript|meeting|location|duration|from|to|cc|bcc)$/i;
const NOISE = [
  /^(.{1,80}) (started|stopped) transcription$/i,
  /^this editable transcript was computer generated/i,
  /^transcribed by https?:\/\/otter\.ai/i,
  /^transcription ended after/i,
  /^meeting ended after/i,
  /^-+\s*$/,
];

const clean = (value: string): string => value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();

/** "1:02:03.450" or "02:03" → seconds. */
export function seconds(stamp: string): number | null {
  const parts = stamp.trim().replace(/[.,]\d+$/, "").split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

const stampOf = (stamp: string | null | undefined): string | null => {
  if (!stamp) return null;
  const value = seconds(stamp);
  return value === null ? null : clock(value);
};

/** A speaker label a person would recognise: a name, "Speaker 2", or an email. */
export function nameLike(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.length > 80 || NOT_A_NAME.test(value)) return false;
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(value)) return true;
  if (/[.?!,;"“”]$/.test(value) || /https?:|[{}<>=|\\/]/.test(value)) return false;
  const words = value.split(/\s+/);
  if (words.length > 6) return false;
  if (/^(speaker|participant|guest|unknown speaker)\s*[\w-]{0,4}$/i.test(value)) return true;
  // Most words of a name start with a capital (or a non-Latin letter); sentences do not.
  const capitalised = words.filter((word) => /^[\p{Lu}\p{Lo}]/u.test(word) || /^\(.*\)$/.test(word)).length;
  return capitalised >= Math.ceil(words.length / 2) && /\p{L}/u.test(value);
}

// ── merging ─────────────────────────────────────────────────────────────────

class Builder {
  lines: TranscriptLine[] = [];
  chars = 0;
  truncated = false;

  add(speaker: string, text: string, at: string | null): void {
    const body = clean(text);
    if (!body || this.truncated) return;
    const who = clean(speaker).replace(/:+$/, "");
    const last = this.lines[this.lines.length - 1];
    if (last && last.speaker === who && last.text.length + body.length < MAX_TURN_CHARS) {
      last.text = `${last.text} ${body}`;
    } else {
      this.lines.push({ speaker: who, text: body, at });
    }
    this.chars += body.length + 1;
    if (this.chars > MAX_TRANSCRIPT_CHARS) {
      this.truncated = true;
      const over = this.chars - MAX_TRANSCRIPT_CHARS;
      const tail = this.lines[this.lines.length - 1]!;
      tail.text = tail.text.slice(0, Math.max(0, tail.text.length - over)).trim();
      if (!tail.text) this.lines.pop();
    }
  }
}

// ── captions: WebVTT and SubRip ─────────────────────────────────────────────

const decodeEntities = (text: string): string =>
  text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");

function parseCaptions(text: string): { format: TranscriptFormat; builder: Builder; title: string | null } {
  const builder = new Builder();
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  const isVtt = /^\s*WEBVTT/.test(text);
  let voiceTags = 0;
  let prefixed = 0;
  let numbered = 0;
  let cues = 0;
  let title: string | null = null;
  for (const block of blocks) {
    const rows = block.split("\n").map((row) => row.trimEnd());
    const timing = rows.findIndex((row) => CUE_TIMING.test(row));
    if (timing < 0) {
      const note = /^NOTE\s+(?:Title|Meeting):\s*(.+)$/i.exec(rows[0]?.trim() ?? "");
      if (note && !title) title = clean(note[1]!);
      continue;
    }
    cues += 1;
    if (timing > 0 && /^\d+$/.test(rows[timing - 1]!.trim())) numbered += 1;
    const start = CUE_TIMING.exec(rows[timing]!)![1]!;
    let speaker = "";
    const said: string[] = [];
    for (const row of rows.slice(timing + 1)) {
      let line = row.trim();
      if (!line) continue;
      const voice = /<v(?:\.[\w.-]+)?\s+([^>]+)>/.exec(line);
      if (voice) {
        speaker = clean(voice[1]!);
        voiceTags += 1;
      }
      line = decodeEntities(line.replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "")).trim();
      if (!line) continue;
      if (!voice && !said.length) {
        const prefix = /^(?:-\s*)?([^:]{1,60}?):\s+(\S.*)$/.exec(line) ?? /^>>\s*([^:]{1,60}?):\s*(\S.*)$/.exec(line);
        if (prefix && nameLike(prefix[1]!)) {
          speaker = clean(prefix[1]!);
          line = prefix[2]!;
          prefixed += 1;
        }
      }
      said.push(line);
    }
    builder.add(speaker, said.join(" "), stampOf(start));
  }
  const format: TranscriptFormat = !isVtt ? "srt" : voiceTags >= Math.max(1, cues / 3) ? "teams-vtt" : prefixed && numbered >= cues / 2 ? "zoom-vtt" : "vtt";
  return { format, builder, title };
}

// ── JSON exports ────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

const TEXT_KEYS = ["text", "sentence", "raw_text", "content", "transcript", "words", "body", "utterance"];
const SPEAKER_KEYS = ["speaker_name", "speakerName", "speaker", "name", "participant", "participantName", "user", "speaker_label", "speakerLabel", "author"];
const START_KEYS = ["start_time", "startTime", "start", "start_ms", "startMs", "offset", "time", "timestamp", "begin", "startOffset"];
const ARRAY_KEYS = ["sentences", "transcript", "segments", "utterances", "entries", "results", "data", "items", "monologues", "transcript_entries", "captions"];

const isRecord = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const pick = (row: Json, keys: readonly string[]): unknown => keys.map((key) => row[key]).find((value) => value !== undefined && value !== null && value !== "");

function speakerOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return `Speaker ${value}`;
  if (isRecord(value)) {
    const name = pick(value, ["name", "displayName", "display_name", "speaker_name", "label"]);
    return typeof name === "string" ? name : "";
  }
  return "";
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((word) => (typeof word === "string" ? word : isRecord(word) ? String(word.text ?? word.word ?? "") : "")).join(" ");
  return "";
}

const utteranceLike = (value: unknown): value is Json[] =>
  Array.isArray(value) && value.length > 0 && value.slice(0, 5).every((row) => isRecord(row) && textOf(pick(row, TEXT_KEYS)).trim().length > 0);

function findUtterances(value: unknown, depth = 0): { rows: Json[]; parent: Json | null } | null {
  if (utteranceLike(value)) return { rows: value, parent: null };
  if (!isRecord(value) || depth > 4) return null;
  for (const key of ARRAY_KEYS) {
    const child = value[key];
    if (utteranceLike(child)) return { rows: child, parent: value };
  }
  for (const child of Object.values(value)) {
    const found = isRecord(child) || Array.isArray(child) ? findUtterances(child, depth + 1) : null;
    if (found) return { rows: found.rows, parent: found.parent ?? value };
  }
  return null;
}

function startStamp(row: Json, milliseconds: boolean): string | null {
  for (const key of START_KEYS) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return clock(milliseconds || /ms$/i.test(key) ? value / 1000 : value);
    if (typeof value === "string" && value.trim()) {
      if (/^\d+(\.\d+)?$/.test(value.trim())) return clock(Number(value) / (milliseconds || /ms$/i.test(key) ? 1000 : 1));
      if (new RegExp(`^${TIME}(?:[.,]\\d+)?$`).test(value.trim())) return stampOf(value);
    }
  }
  return null;
}

function epochOrIso(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value > 1e12 ? value : value * 1000);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function parseJson(data: unknown): ParsedTranscript | null {
  const found = findUtterances(data);
  if (!found) return null;
  const meta: Json = found.parent ?? (isRecord(data) ? data : {});
  const numbers = found.rows.flatMap((row) => START_KEYS.map((key) => row[key]).filter((value): value is number => typeof value === "number"));
  // A two-hour meeting is 7,200 seconds; offsets far past ten hours are milliseconds.
  const milliseconds = numbers.length > 0 && numbers.every(Number.isInteger) && Math.max(...numbers) > 36_000;
  const builder = new Builder();
  let fireflies = false;
  let tldv = false;
  for (const row of found.rows) {
    if ("speaker_name" in row || "raw_text" in row) fireflies = true;
    if ("startTime" in row && "speaker" in row && !("speaker_name" in row)) tldv = true;
    builder.add(speakerOf(pick(row, SPEAKER_KEYS)), textOf(pick(row, TEXT_KEYS)), startStamp(row, milliseconds));
  }
  const title = pick(meta, ["title", "meeting_title", "meetingTitle", "name", "topic", "subject"]);
  const started = epochOrIso(pick(meta, ["date", "start_time", "startTime", "started_at", "startedAt", "happenedAt", "meeting_date", "created_at", "createdAt"]));
  const durationRaw = pick(meta, ["duration", "durationSeconds", "duration_seconds"]);
  const summaryRecord = isRecord(meta.summary) ? (meta.summary as Json) : null;
  const summary = typeof meta.summary === "string" ? meta.summary : typeof summaryRecord?.overview === "string" ? summaryRecord.overview : "";
  const actionText = typeof summaryRecord?.action_items === "string" ? summaryRecord.action_items : "";
  return finish({
    format: fireflies ? "fireflies-json" : tldv ? "tldv-json" : "json",
    title: typeof title === "string" ? clean(title) || null : null,
    when: null,
    startedAt: started,
    durationSeconds: typeof durationRaw === "number" && durationRaw > 0 ? Math.round(durationRaw > 86_400 ? durationRaw / 1000 : fireflies && durationRaw < 600 ? durationRaw * 60 : durationRaw) : null,
    attendees: [],
    lines: builder.lines,
    summary: summary.trim(),
    decisions: decisionsFromMarkdown(summary),
    actionItems: actionText ? parseActionItemsText(actionText) : actionItemsFromMarkdown(summary),
    suggested: false,
    truncated: builder.truncated,
    warnings: [],
  });
}

// ── line formats ────────────────────────────────────────────────────────────

const ZONES: Record<string, string> = { PST: "-08:00", PDT: "-07:00", MST: "-07:00", MDT: "-06:00", CST: "-06:00", CDT: "-05:00", EST: "-05:00", EDT: "-04:00", BST: "+01:00", CET: "+01:00", CEST: "+02:00", IST: "+05:30" };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (value: number | string) => String(value).padStart(2, "0");

function time24(hours: string, minutes: string, meridiem: string | undefined): string {
  let hour = Number(hours) % 24;
  const marker = meridiem?.toLowerCase();
  if (marker === "pm" && hour < 12) hour += 12;
  if (marker === "am" && hour === 12) hour = 0;
  return `${pad(hour)}:${pad(minutes)}`;
}

/** Dates as meeting apps write them: "January 15, 2024, 3:03PM", "Mon, Jan 15, 2024 10:03AM", "2024/01/15 10:00 PST", "2024-01-15 10:00 GMT-05:00". */
export function writtenTime(line: string): WrittenTime | null {
  const text = line.replace(/\s+/g, " ");
  const zone = /\b(GMT|UTC)\s?([+-]\d{1,2}(?::?\d{2})?)?\b/i.exec(text);
  const named = /\b(PST|PDT|MST|MDT|CST|CDT|EST|EDT|BST|CET|CEST|IST)\b/.exec(text);
  const zoneText = zone ? `${zone[1]!.toUpperCase()}${zone[2] ?? ""}` : named ? `GMT${ZONES[named[1]!]}` : null;
  const clockAt = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s?(am|pm)?\b/i.exec(text.replace(/\b\d{4}[-/]\d{2}[-/]\d{2}\b/, ""));
  const at = clockAt ? time24(clockAt[1]!, clockAt[2]!, clockAt[3]) : null;
  const iso = /\b(\d{4})[-/](\d{2})[-/](\d{2})\b/.exec(text);
  if (iso) return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, time: at, zone: zoneText };
  const monthFirst = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(text);
  if (monthFirst) return { date: `${monthFirst[3]}-${pad(MONTHS.indexOf(monthFirst[1]!.toLowerCase()) + 1)}-${pad(monthFirst[2]!)}`, time: at, zone: zoneText };
  const dayFirst = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/i.exec(text);
  if (dayFirst) return { date: `${dayFirst[3]}-${pad(MONTHS.indexOf(dayFirst[2]!.toLowerCase()) + 1)}-${pad(dayFirst[1]!)}`, time: at, zone: zoneText };
  return null;
}

/** "32m 15s", "1h 2m", "• 32:15" after an Otter date, "Duration: 45 minutes". */
function writtenDuration(line: string): number | null {
  const units = /^(?:duration:?\s*)?(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?)?)?\s*)?(?:(\d+)\s*s(?:ec(?:onds?)?)?)?$/i.exec(line.trim());
  if (units && (units[1] || units[2] || units[3])) return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  const bullet = new RegExp(`[•·]\\s*(${TIME})\\s*$`).exec(line);
  return bullet ? seconds(bullet[1]!) : null;
}

const SECTION = /^(?:#{1,6}\s*)?(summary(?: keywords)?|keywords|speakers|attendees|participants|transcript|details|notes|outline|action items?|suggested next steps|next steps|decisions?|agenda)\s*:?\s*$/i;

interface Section {
  name: string;
  lines: string[];
}

/** Header lines, written sections (summary, attendees, next steps) and everything else, in order. */
function splitSections(rows: string[]): { head: string[]; sections: Section[]; rest: string[] } {
  const head: string[] = [];
  const sections: Section[] = [];
  const rest: string[] = [];
  let current: Section | null = null;
  let spoken = false;
  rows.forEach((row, index) => {
    const heading = SECTION.exec(row.trim());
    if (heading && heading[1]!.toLowerCase() === "transcript") {
      current = null;
      return;
    }
    if (heading && !spoken) {
      current = { name: heading[1]!.toLowerCase(), lines: [] };
      sections.push(current);
      return;
    }
    // Teams' transcript panel copies the name and the time on lines of their own.
    if (isUtterance(row) || (nameLike(row) && BARE_TIME.test(rows[index + 1]?.trim() ?? ""))) {
      spoken = true;
      current = null;
    }
    if (current) {
      current.lines.push(row);
      return;
    }
    if (!spoken && !sections.length && head.length < 6) head.push(row);
    rest.push(row);
  });
  return { head, sections, rest };
}

function isUtterance(row: string): boolean {
  const line = row.trim();
  if (!line) return false;
  if (ZOOM_HEADER.test(line) || TIME_FIRST.test(line)) return true;
  const header = HEADER_INLINE.exec(line) ?? HEADER_LINE.exec(line);
  if (header && nameLike(header[1]!)) return true;
  const said = SPEAKER_TEXT.exec(line);
  return Boolean(said && nameLike(said[1]!));
}

/** Speaker blocks: Teams .docx and transcript-panel copies, Otter, Zoom "[Name] 00:00:01". */
function parseBlocks(rows: string[]): { builder: Builder; kind: "bracket" | "header" | "stacked" | null } {
  const builder = new Builder();
  const lines = rows.map((row) => row.trim());
  let speaker: string | null = null;
  let at: string | null = null;
  let buffer: string[] = [];
  let kind: "bracket" | "header" | "stacked" | null = null;
  const flush = () => {
    if (speaker !== null && buffer.length) builder.add(speaker, buffer.join(" "), at);
    buffer = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line || NOISE.some((pattern) => pattern.test(line))) continue;
    const bracket = ZOOM_HEADER.exec(line);
    if (bracket) {
      flush();
      speaker = bracket[1]!;
      at = stampOf(bracket[2]);
      kind ??= "bracket";
      if (bracket[3]) buffer.push(bracket[3]);
      continue;
    }
    const inline = HEADER_INLINE.exec(line);
    if (inline && nameLike(inline[1]!)) {
      flush();
      speaker = inline[1]!;
      at = stampOf(inline[2]);
      kind ??= "header";
      buffer.push(inline[3]!);
      continue;
    }
    const header = HEADER_LINE.exec(line);
    if (header && nameLike(header[1]!)) {
      flush();
      speaker = header[1]!;
      at = stampOf(header[2]);
      kind ??= "header";
      continue;
    }
    // Teams' transcript panel copies name, time and words on separate lines.
    const next = lines[index + 1] ?? "";
    if (nameLike(line) && BARE_TIME.test(next) && !SPEAKER_TEXT.test(line)) {
      flush();
      speaker = line;
      at = stampOf(BARE_TIME.exec(next)![1]);
      kind ??= "stacked";
      index += 1;
      continue;
    }
    if (speaker !== null) buffer.push(line);
  }
  flush();
  return { builder, kind };
}

/** "Name: words" lines, with "00:05:00" marks between them (Google Meet) and "00:01:02 Name: words". */
function parseSpeakerLines(rows: string[]): Builder {
  const builder = new Builder();
  let mark: string | null = null;
  let last: TranscriptLine | null = null;
  for (const row of rows) {
    const line = row.trim();
    if (!line || NOISE.some((pattern) => pattern.test(line))) continue;
    const bare = BARE_TIME.exec(line);
    if (bare) {
      mark = stampOf(bare[1]);
      continue;
    }
    const first = TIME_FIRST.exec(line);
    if (first && nameLike(first[2]!)) {
      builder.add(first[2]!, first[3]!, stampOf(first[1]));
      last = builder.lines[builder.lines.length - 1] ?? null;
      continue;
    }
    const said = SPEAKER_TEXT.exec(line);
    if (said && nameLike(said[1]!)) {
      builder.add(said[1]!, said[2]!, mark);
      mark = null;
      last = builder.lines[builder.lines.length - 1] ?? null;
      continue;
    }
    // A wrapped line belongs to whoever spoke last.
    if (last) builder.add(last.speaker, line, last.at ?? null);
  }
  return builder;
}

function parsePlain(rows: string[]): Builder {
  const builder = new Builder();
  const paragraphs = rows.join("\n").split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const text = paragraph.split("\n").map((row) => row.trim()).filter(Boolean).join(" ");
    if (text) builder.lines.push({ speaker: "", text: clean(text).slice(0, MAX_TURN_CHARS * 2), at: null });
  }
  return builder;
}

const names = (lines: string[]): string[] =>
  lines
    .join(",")
    .split(/[,;\n]| and /)
    .map((value) => clean(value.replace(/^[-*•]\s*/, "")))
    .filter((value) => value && nameLike(value));

/** A meeting title without the date, time and "Transcript" that apps add to it. */
export function tidyTitle(raw: string): string | null {
  const title = raw
    .replace(/^#{1,6}\s*/, "")
    .replace(/-?\d{8}_\d{6}-?/, " ")
    .replace(/\s*\((?:[^)]*\d{4}[^)]*)\)\s*/, " ")
    .replace(/\b\d{4}[-/_]\d{2}[-/_]\d{2}\b(\s+\d{1,2}[-_:]\d{2}(\s*[AP]M)?)?(\s+(?:[A-Z]{2,5}|GMT[+-]\d{1,2}(?::?\d{2})?))?/i, " ")
    .replace(/\b(meeting transcript|meeting recording|transcript|recording|captions|subtitles|notes by gemini)\b/gi, " ")
    .replace(/_+/g, " ")
    .replace(/(\s*[-–—|]\s*)+(?=$)/g, "")
    .replace(/^(\s*[-–—|]\s*)+/g, "")
    .replace(/(\s*[-–—|]\s*){2,}/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
  return title && title.length <= 200 && /[\p{L}\p{N}]/u.test(title) && !/^(untitled|download|file)$/i.test(title) ? title : null;
}

function headTitle(head: string[]): string | null {
  for (const raw of head) {
    const line = clean(raw.replace(/^#{1,6}\s*/, ""));
    if (!line || (writtenTime(line) && line.replace(/[^a-z]/gi, "").length < 24) || writtenDuration(line) !== null || NOT_A_NAME.test(line)) continue;
    const title = tidyTitle(line);
    if (title) return title;
  }
  return null;
}

function parseLines(text: string): ParsedTranscript {
  const rows = text.replace(/\r\n?/g, "\n").replace(/\t+/g, "  ").split("\n");
  const { head, sections, rest } = splitSections(rows);
  const blocks = parseBlocks(rest);
  const spoken = parseSpeakerLines(rest);
  const blockScore = blocks.kind ? blocks.builder.lines.length : 0;
  const builder = blockScore >= 2 && blockScore >= spoken.lines.length * 0.6 ? blocks.builder : spoken.lines.length >= 2 ? spoken : blockScore ? blocks.builder : parsePlain(rest);
  const section = (pattern: RegExp) => sections.filter((row) => pattern.test(row.name)).flatMap((row) => row.lines);
  const attendees = names(section(/^(attendees|participants|speakers)$/));
  const summaryLines = section(/^(summary|details|notes|outline)$/);
  const nextSteps = section(/^(action items?|suggested next steps|next steps)$/);
  const decisionLines = section(/^decisions?$/);
  const speakers = new Set(builder.lines.map((line) => line.speaker));
  const header = head.filter((line) => !speakers.has(line.trim()) && !BARE_TIME.test(line.trim()));
  const when = header.map(writtenTime).find(Boolean) ?? null;
  const duration = header.map(writtenDuration).find((value) => value !== null) ?? null;
  let format: TranscriptFormat;
  if (builder === blocks.builder && blocks.kind === "bracket") format = "zoom-txt";
  else if (builder === blocks.builder && blocks.kind === "stacked") format = "teams-copy";
  else if (builder === blocks.builder && blocks.kind === "header") {
    format = /SPEAKERS|SUMMARY KEYWORDS|otter\.ai/i.test(text) ? "otter" : /started transcription|\b\d+m \d+s\b/i.test(text) ? "teams-docx" : "teams-copy";
  } else if (builder === spoken) {
    format = /this editable transcript was computer generated|notes by gemini/i.test(text) || (attendees.length > 0 && /^\s*\d{2}:\d{2}:\d{2}\s*$/m.test(text)) ? "google-meet" : "speaker-lines";
  } else format = "plain";
  const summary = summaryLines.join("\n").trim();
  return finish({
    format,
    title: headTitle(header),
    when,
    startedAt: null,
    durationSeconds: duration,
    attendees,
    lines: builder.lines,
    summary,
    decisions: [...decisionLines.map((line) => clean(line.replace(/^[-*•]\s*/, ""))).filter((line) => line.length >= 3), ...decisionsFromMarkdown(summary)],
    // Gemini writes next steps as "[Mira Chen] Send the deck".
    actionItems: nextSteps.length ? parseActionItemsText(nextSteps.map((line) => line.replace(/^\s*(?:[-*•]\s*)?\[([^\]]{2,80})\]\s*/, "- $1: ")).join("\n")) : actionItemsFromMarkdown(summary),
    suggested: false,
    truncated: builder.truncated,
    warnings: builder === blocks.builder || builder === spoken ? [] : ["No speakers were found, so the text is kept as paragraphs."],
  });
}

// ── what was said: commitments and decisions ───────────────────────────────

const COMMITMENT = /\b(?:I(?:'| wi)ll|I'm going to|I am going to|let me)\s+(?:also\s+|go ahead and\s+)?(send|share|follow up|draft|write|update|schedule|review|check|look into|get back|set up|prepare|reach out|email|ping|create|fix|book|put together|circulate|file|open|add|finish|ship|test)\b/i;
const REQUEST = /\b(?:can|could|would) you (?:please )?(send|share|follow up|draft|write|update|schedule|review|check|look into|get back|set up|prepare|reach out|email|ping|create|fix|book|put together|circulate|file|open|add|finish|test)\b/i;
const MARKED = /^(?:action item|action|todo|to-do|next step|follow[- ]up)s?\s*[:-]\s*(.{3,})$/i;
const DECIDED = /\b(?:we(?:'ve| have)? (?:decided|agreed)|(?:the )?decision is|let's go with|we'll go with|we are going with|we're going with|agreed to|final answer is)\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
}

/** Commitments ("I'll send the deck") and decisions ("we agreed to ship Friday") said in the meeting. Bounded and literal. */
export function spokenItems(lines: readonly TranscriptLine[]): { actionItems: ActionItemInput[]; decisions: string[] } {
  const actionItems: ActionItemInput[] = [];
  const decisions: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    for (const sentence of sentences(line.text)) {
      if (sentence.length < 12 || sentence.length > 300) continue;
      const key = sentence.toLowerCase();
      if (seen.has(key)) continue;
      const plain = sentence.replace(/[’‘]/g, "'");
      const marked = MARKED.exec(plain);
      if (marked && actionItems.length < 12) {
        seen.add(key);
        actionItems.push({ text: marked[1]!.trim(), assignee: null, at: line.at ?? null });
      } else if (COMMITMENT.test(plain) && actionItems.length < 12) {
        seen.add(key);
        actionItems.push({ text: sentence, assignee: line.speaker ? { name: line.speaker } : null, at: line.at ?? null });
      } else if (REQUEST.test(plain) && actionItems.length < 12) {
        seen.add(key);
        actionItems.push({ text: sentence, assignee: null, at: line.at ?? null });
      } else if (DECIDED.test(plain) && decisions.length < 10) {
        seen.add(key);
        decisions.push(line.speaker ? `${sentence} (${line.speaker})` : sentence);
      }
    }
  }
  return { actionItems, decisions };
}

function finish(parsed: ParsedTranscript): ParsedTranscript {
  const out = { ...parsed, lines: parsed.lines.filter((line) => line.text) };
  if (!out.durationSeconds) {
    const last = [...out.lines].reverse().find((line) => line.at);
    const end = last?.at ? seconds(last.at) : null;
    if (end && end > 0 && out.format !== "zoom-txt") out.durationSeconds = end;
  }
  if (!out.actionItems.length && !out.decisions.length && out.lines.length) {
    const spoken = spokenItems(out.lines);
    out.actionItems = spoken.actionItems;
    out.decisions = spoken.decisions;
    out.suggested = Boolean(spoken.actionItems.length || spoken.decisions.length);
  }
  out.decisions = [...new Set(out.decisions)].slice(0, 30);
  if (out.truncated) out.warnings = [...out.warnings, `Only the first ${MAX_TRANSCRIPT_CHARS.toLocaleString("en-US")} characters were kept.`];
  if (out.lines.length && out.lines.every((line) => !line.speaker)) out.warnings = [...new Set([...out.warnings, "No speakers were found."])];
  return out;
}

/** Title and date in a downloaded file's name: "Weekly sync-20240115_100302-Meeting Transcript.vtt". */
export function fromFilename(filename: string | null | undefined): { title: string | null; when: WrittenTime | null } {
  if (!filename) return { title: null, when: null };
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.(vtt|srt|txt|docx|json|md|text)$/i, "");
  const stamp = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(base);
  const when = stamp ? { date: `${stamp[1]}-${stamp[2]}-${stamp[3]}`, time: `${stamp[4]}:${stamp[5]}`, zone: null } : writtenTime(base.replace(/_/g, " "));
  return { title: tidyTitle(base), when };
}

/** Reads a transcript the person uploaded or pasted. Never throws on odd input; an empty `lines` means nothing usable was found. */
export function parseTranscript(raw: string, filename?: string | null): ParsedTranscript {
  const text = raw.replace(/^\uFEFF/, "").replace(/\u0000/g, "");
  const trimmed = text.trim();
  let parsed: ParsedTranscript | null = null;
  if (/^[[{]/.test(trimmed)) {
    try {
      parsed = parseJson(JSON.parse(trimmed));
    } catch {
      parsed = null;
    }
  }
  if (!parsed && (/^\s*WEBVTT/.test(trimmed) || CUE_TIMING.test(trimmed.split("\n").slice(0, 6).join("\n")) || /\n\s*\d{1,2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(trimmed.slice(0, 4000)))) {
    const captions = parseCaptions(trimmed);
    parsed = finish({
      format: captions.format,
      title: captions.title,
      when: null,
      startedAt: null,
      durationSeconds: null,
      attendees: [],
      lines: captions.builder.lines,
      summary: "",
      decisions: [],
      actionItems: [],
      suggested: false,
      truncated: captions.builder.truncated,
      warnings: [],
    });
  }
  parsed ??= parseLines(trimmed);
  const named = fromFilename(filename);
  if (/\.docx$/i.test(filename ?? "") && (parsed.format === "teams-copy" || parsed.format === "teams-docx")) parsed.format = /SPEAKERS|otter\.ai/i.test(trimmed) ? "otter" : "teams-docx";
  return { ...parsed, title: parsed.title ?? named.title, when: parsed.when ?? named.when };
}

/** Utterances an API returned (Google Meet entries), merged and read like a file. */
export function transcriptFromLines(format: TranscriptFormat, rows: readonly TranscriptLine[], meta: Partial<Pick<ParsedTranscript, "title" | "startedAt" | "durationSeconds" | "attendees">> = {}): ParsedTranscript {
  const builder = new Builder();
  for (const row of rows) builder.add(row.speaker, row.text, row.at ?? null);
  return finish({
    format,
    title: meta.title ?? null,
    when: null,
    startedAt: meta.startedAt ?? null,
    durationSeconds: meta.durationSeconds ?? null,
    attendees: meta.attendees ?? [],
    lines: builder.lines,
    summary: "",
    decisions: [],
    actionItems: [],
    suggested: false,
    truncated: builder.truncated,
    warnings: [],
  });
}

/** Distinct speakers in order of first appearance, with how many turns each took. */
export function speakersOf(lines: readonly TranscriptLine[]): Array<{ name: string; turns: number }> {
  const counts = new Map<string, number>();
  for (const line of lines) if (line.speaker) counts.set(line.speaker, (counts.get(line.speaker) ?? 0) + 1);
  return [...counts].map(([name, turns]) => ({ name, turns }));
}

/** The transcript as text: "[mm:ss] Speaker: words", one turn per line. `readTranscript` reads it back. */
export function transcriptDocument(lines: readonly TranscriptLine[]): string {
  return lines
    .map((line) => {
      const speaker = line.speaker.replace(/[:\n]/g, " ").trim();
      const body = line.text.replace(/\s+/g, " ").trim();
      return `${line.at ? `[${line.at}] ` : ""}${speaker ? `${speaker}: ` : ""}${body}`;
    })
    .join("\n");
}

export function readTranscript(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const row of text.split("\n")) {
    if (!row.trim()) continue;
    const match = /^(?:\[([\d:]{4,8})\] )?(?:([^:\n]{1,120}?): )?(.*)$/.exec(row)!;
    const speaker = match[2]?.trim() ?? "";
    if (speaker && !nameLike(speaker)) out.push({ at: match[1] ?? null, speaker: "", text: `${speaker}: ${match[3]!}`.trim() });
    else out.push({ at: match[1] ?? null, speaker, text: match[3]!.trim() });
  }
  return out;
}
