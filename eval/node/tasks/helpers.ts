/**
 * Helpers the tasks share: the owner's dates and the node they talk to, what counts as looking
 * something up, the files, pictures and videos that reached the chat, test runs in a fixture project,
 * an index read back from a page, and the conditions timed messages wait for.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHATTER, check, norm, okTool, run } from "../lib/grade.js";
import { localDay, localMinutes } from "../lib/fixtures.js";
import type { Check, Evidence, TaskContext } from "../lib/types.js";

/** "Friday 27 November" for a date, in the owner's words. */
export function spoken(date: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(new Date(`${date}T12:00:00Z`));
}

/** The calendar date an instant falls on in a time zone. */
export const dateIn = (iso: string | null, timeZone: string): string | null => (iso ? new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)) : null);
export const timeIn = (iso: string, timeZone: string): string => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
/** "09:30" for minutes after midnight. */
export const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export const newTasks = (ev: Evidence) => ev.tasks.filter((task) => !task.seeded);
export const newPages = (ev: Evidence) => ev.pages.filter((page) => !page.seeded && !page.taskId);
/** The node most tasks talk to: one made from the Assistant template, in a DM. */
export const assistant = async (ctx: TaskContext) => void (await ctx.makeNode("assistant", "assistant"));
export const noChatter = (ev: Evidence): Check => check("no approval or password chatter", !CHATTER.test(ev.replies.join("\n")), "reply");

/**
 * Three meetings still ahead today, whenever the eval runs, so a day plan has the rest of the day to
 * fill: spread out when the day allows, closer and shorter late in the day. Refuses after about 22:00.
 */
export function meetingsAhead(timeZone: string): Array<{ uid: string; title: string; start: Date; end: Date; at: string }> {
  const today = localDay(timeZone);
  const end = 23 * 60 + 55;
  const first = Math.ceil((localMinutes(timeZone) + 45) / 15) * 15;
  const gap = first + 240 <= 23 * 60 + 30 ? 105 : Math.floor((end - first - 20) / 10) * 5;
  if (gap < 25) throw new Error("A day plan needs a few hours of the day left: run it before 22:00 local time.");
  const minutes = Math.min(30, gap - 5, end - (first + 2 * gap));
  return [
    { uid: "standup@eval", title: "Standup", start: first, minutes: 15 },
    { uid: "design@eval", title: "Design review", start: first + gap, minutes },
    { uid: "theo@eval", title: "1:1 with Theo", start: first + 2 * gap, minutes },
  ].map((row) => ({ uid: row.uid, title: row.title, start: today.at(clock(row.start)), end: today.at(clock(row.start + row.minutes)), at: clock(row.start) }));
}

/** The agent's own web tools, or Ensemble's web and browser tools, ran. */
export function webLookup(ev: Evidence): boolean {
  return ev.agentTools.some((call) => /(^|[-_.])(web_search|web_fetch|fetch|search|browser_navigate)$/i.test(call.name) && !/ensemble/i.test(call.name)) || okTool(ev, /^(hub_web_search|web_search|hub_read_web_page|browser_[a-z_]+|web_task)$/);
}

/**
 * The HTTP status a link answers with after redirects, 0 when nothing answers. curl first: some sites
 * never finish a TLS handshake with Node's fetch, and a link is not dead because of that.
 */
export async function linkStatus(url: string): Promise<number> {
  const curl = await run("curl", ["-s", "-L", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20", "-A", "Mozilla/5.0 (ensemble-node-eval)", url], { cwd: ".", timeoutMs: 30_000 });
  const status = Number(curl.output.trim());
  if (curl.code === 0 && status > 0) return status;
  return fetch(url, { method: "GET", redirect: "follow", headers: { "user-agent": "ensemble-node-eval" }, signal: AbortSignal.timeout(20_000) }).then((response) => response.status, () => 0);
}

/** The last answer (to the owner's last message). */
export const lastAnswer = (ev: Evidence): string => ev.answers.at(-1) ?? ev.replies.at(-1) ?? "";

export type Shared = {
  name: string | null;
  mime: string | null;
  kind: string | null;
  size: number;
  text: string | null;
  image: { format: string; width: number; height: number } | null;
  /** A video's container and length: what capture measured, else what the file says. */
  video: { format: string; durationMs: number | null } | null;
  error?: string;
};

/** A video's container and its length from the file itself: an MP4 or MOV `mvhd` box, or a WebM or Matroska Duration. */
export function videoInfo(bytes: Buffer): { format: string; durationMs: number | null } | null {
  const box = bytes.indexOf("mvhd");
  if (bytes.length > 12 && bytes.toString("ascii", 4, 8) === "ftyp") {
    const v1 = box >= 0 && bytes[box + 4] === 1;
    if (box < 0 || box + (v1 ? 36 : 24) > bytes.length) return { format: "mp4", durationMs: null };
    const scale = bytes.readUInt32BE(box + (v1 ? 24 : 16));
    const length = v1 ? Number(bytes.readBigUInt64BE(box + 28)) : bytes.readUInt32BE(box + 20);
    return { format: "mp4", durationMs: scale ? Math.round((length / scale) * 1000) : null };
  }
  if (bytes.length > 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) {
    const scaleAt = bytes.indexOf(Buffer.from([0x2a, 0xd7, 0xb1]));
    let scale = 1_000_000;
    if (scaleAt >= 0 && (bytes[scaleAt + 3]! & 0x80) !== 0) {
      const size = bytes[scaleAt + 3]! & 0x7f;
      if (size > 0 && size <= 6) scale = bytes.readUIntBE(scaleAt + 4, size);
    }
    for (let at = bytes.indexOf(Buffer.from([0x44, 0x89])); at >= 0; at = bytes.indexOf(Buffer.from([0x44, 0x89]), at + 1)) {
      const size = bytes[at + 2];
      if (size === 0x84 && at + 7 <= bytes.length) return { format: "webm", durationMs: Math.round((bytes.readFloatBE(at + 3) * scale) / 1e6) };
      if (size === 0x88 && at + 11 <= bytes.length) return { format: "webm", durationMs: Math.round((bytes.readDoubleBE(at + 3) * scale) / 1e6) };
    }
    return { format: "webm", durationMs: null };
  }
  return null;
}

/** Width and height of a PNG, JPEG or WebP picture; null for anything else. */
export function imageInfo(bytes: Buffer): Shared["image"] {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) break;
      const marker = bytes[at + 1]!;
      const length = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { format: "jpeg", width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
      at += 2 + length;
    }
    return { format: "jpeg", width: 0, height: 0 };
  }
  if (bytes.length > 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { format: "webp", width: 0, height: 0 };
  return null;
}

/** The files and pictures the nodes put in the chat, read as the owner reads them (the evidence route). */
export async function sharedFiles(ctx: TaskContext, ev: Evidence): Promise<Shared[]> {
  const out: Shared[] = [];
  for (const message of ev.messages.filter((row) => row.author.startsWith("node"))) {
    for (const item of message.media) {
      if (!item.evidenceId) continue;
      const row = await ctx.world.prisma.jobEvidence.findUnique({ where: { id: item.evidenceId }, select: { kind: true, details: true } });
      const measured = typeof (row?.details as { durationMs?: unknown } | null)?.durationMs === "number" ? ((row!.details as { durationMs: number }).durationMs) : null;
      const response = await ctx.owner.inject({ method: "GET", url: `/api/node/evidence/${item.evidenceId}?message=${message.id}` });
      if (response.statusCode >= 300) {
        out.push({ name: item.name, mime: item.mime, kind: row?.kind ?? item.kind, size: item.size ?? 0, text: null, image: null, video: measured !== null ? { format: "unknown", durationMs: measured } : null, error: `${response.statusCode}` });
        continue;
      }
      const bytes = response.rawPayload;
      const image = imageInfo(bytes);
      const fromFile = image ? null : videoInfo(bytes);
      const video = fromFile || measured !== null ? { format: fromFile?.format ?? "unknown", durationMs: measured ?? fromFile?.durationMs ?? null } : null;
      const text = !image && !video && bytes.length < 200_000 && !bytes.subarray(0, 2000).includes(0) ? bytes.toString("utf8").slice(0, 8000) : null;
      out.push({ name: item.name, mime: item.mime ?? response.headers["content-type"]?.toString() ?? null, kind: row?.kind ?? item.kind, size: bytes.length, text, image, video });
    }
  }
  return out;
}

/** Runs `node --test` with these files (or the project's own tests); passes when the run exits 0. */
export async function nodeTests(cwd: string, files: string[] = []): Promise<{ pass: boolean; summary: string }> {
  const result = await run(process.execPath, ["--test", ...files], { cwd, timeoutMs: 120_000 });
  const lines = result.output.split("\n");
  const summary = lines.filter((line) => /^# (tests|pass|fail)\b/.test(line) || /^not ok\b/.test(line)).slice(0, 12).join("; ");
  return { pass: result.code === 0, summary: summary || result.output.slice(-400) };
}

/**
 * Tests the project never saw, written to a folder of their own at grading time, run against the
 * project's module by its path.
 */
export async function hiddenTests(ctx: TaskContext, name: string, source: string): Promise<{ pass: boolean; summary: string }> {
  const folder = join(ctx.world.dirs.root, "hidden", `${ctx.task.id}-${ctx.repeat}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, name), source);
  return nodeTests(folder, [join(folder, name)]);
}

export const sha256 = (path: string): string | null => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);

/** Files under a folder (skipping node_modules and .git), relative paths. */
export function filesIn(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesIn(path, `${prefix}${entry.name}/`);
    return entry.isFile() ? [`${prefix}${entry.name}`] : [];
  });
}

export const readText = (path: string, max = 20_000): string | null => (existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8").slice(0, max) : null);

/** A coding run for the owner that has been running at least `seconds`, so its agent is at work (what a timed message waits for). */
export function codingRunningFor(seconds: number): (ctx: TaskContext) => Promise<string | null> {
  return async (ctx) => {
    const job = await ctx.world.prisma.workspaceJob.findFirst({ where: { userId: ctx.owner.id, status: "running", startedAt: { lte: new Date(Date.now() - seconds * 1000) } }, select: { id: true, provider: true } });
    return job ? `${job.provider} run ${job.id.slice(0, 8)} has been running for ${seconds} s` : null;
  };
}

/** A running turn has finished a tool call (turns record each tool as it ends): the moment to interrupt it. */
export async function firstToolCall(ctx: TaskContext): Promise<string | null> {
  const turns = await ctx.world.prisma.nodeTurn.findMany({ where: { userId: ctx.owner.id, status: "running" }, select: { receipts: true } });
  const done = turns.flatMap((turn) => (Array.isArray(turn.receipts) ? (turn.receipts as Array<{ name?: unknown }>) : []));
  return done.length ? `the running turn finished ${String(done[0]!.name ?? "a tool")}` : null;
}

/**
 * An index read back from a page's text: for each known title, its first line that names it alone,
 * with the first number after the title on that line (else the last one before it), in page order.
 */
export function indexEntries(text: string, titles: string[]): Array<{ title: string; count: number | null }> {
  const wanted = titles.map((title) => ({ title, pattern: new RegExp(`(^|[^a-z0-9])${norm(title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`) }));
  const found = new Map<string, number | null>();
  for (const raw of text.split("\n")) {
    const line = norm(raw);
    const named = wanted.filter((entry) => entry.pattern.test(line));
    if (named.length !== 1) continue;
    const { title } = named[0]!;
    if (found.has(title) && found.get(title) !== null) continue;
    const at = line.indexOf(norm(title));
    const after = /\b(\d+)\b/.exec(line.slice(at + norm(title).length));
    const before = [...line.slice(0, at).matchAll(/\b(\d+)\b/g)].at(-1);
    if (found.has(title)) found.delete(title);
    found.set(title, after ? Number(after[1]) : before ? Number(before[1]) : null);
  }
  return [...found].map(([title, count]) => ({ title, count }));
}

/** Whether the numbers never go up. */
export const nonIncreasing = (values: number[]): boolean => values.every((value, index) => index === 0 || value <= values[index - 1]!);
