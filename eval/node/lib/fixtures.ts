/**
 * Fixtures a task sets up before its first message: tasks and pages on the owner's board, a calendar
 * day, files and a small project on this computer (shared with Ensemble under a name, as an owner
 * shares a folder), and a web page served on 127.0.0.1.
 */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import type { TaskContext } from "./types.js";

const list = (ctx: TaskContext, key: "seededTasks" | "seededPages"): string[] => ((ctx.data[key] ??= []) as string[]);

/** A task on the owner's board, made by the owner. */
export async function seedTask(ctx: TaskContext, input: { title: string; due?: Date | null; status?: string; notes?: string }): Promise<string> {
  const made = await ctx.api<{ task: { id: string } }>("POST", "/api/tasks", {
    title: input.title,
    owner: "me",
    status: input.status ?? "todo",
    ...(input.due ? { due: input.due.toISOString() } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  });
  list(ctx, "seededTasks").push(made.task.id);
  return made.task.id;
}

/** A document from lines: "# " and "## " start headings, "- " bullet items, anything else a paragraph. */
export function pageDoc(lines: string[]): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  const text = (value: string) => (value ? [{ type: "text", text: value }] : []);
  for (const line of lines) {
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) content.push({ type: "heading", attrs: { level: heading[1]!.length }, content: text(heading[2]!) });
    else if (line.startsWith("- ")) {
      const item = { type: "listItem", content: [{ type: "paragraph", content: text(line.slice(2)) }] };
      const last = content.at(-1);
      if (last?.type === "bulletList") (last.content as unknown[]).push(item);
      else content.push({ type: "bulletList", content: [item] });
    } else content.push({ type: "paragraph", content: text(line) });
  }
  return { type: "doc", content };
}

/** A standalone page on the owner's board with these lines. */
export async function seedPage(ctx: TaskContext, title: string, lines: string[]): Promise<string> {
  const made = await ctx.api<{ page: { id: string } }>("POST", "/api/pages", { title });
  const page = await ctx.api<{ revision: number }>("GET", `/api/pages/${made.page.id}`);
  await ctx.api("PUT", `/api/pages/${made.page.id}`, { revision: page.revision, content: pageDoc(lines) });
  list(ctx, "seededPages").push(made.page.id);
  return made.page.id;
}

const icsTime = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** An iCalendar file with these events. */
export function ics(events: Array<{ uid: string; title: string; start: Date; end: Date }>, name = "Work"): string {
  const now = icsTime(new Date());
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ensemble eval//EN",
    `X-WR-CALNAME:${name}`,
    ...events.flatMap((event) => ["BEGIN:VEVENT", `UID:${event.uid}`, `DTSTAMP:${now}`, `DTSTART:${icsTime(event.start)}`, `DTEND:${icsTime(event.end)}`, `SUMMARY:${event.title}`, "END:VEVENT"]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/**
 * Calendar events on the owner's calendar, as a calendar link they added (Settings, Calendar). The
 * feed is served from memory to Ensemble's own feed reader for the moment it is added and read.
 */
export async function seedCalendar(ctx: TaskContext, events: Array<{ uid: string; title: string; start: Date; end: Date }>): Promise<void> {
  const { setCalendarFeedFetchForTests } = await import("../../../apps/hub-api/src/calendar/feeds.js");
  const url = `https://calendar.example.test/${ctx.owner.id}.ics`;
  const body = ics(events);
  setCalendarFeedFetchForTests(async (asked) => {
    if (asked !== url) throw new Error("That calendar is not served here.");
    return body;
  });
  try {
    await ctx.api("POST", "/api/calendar/feeds", { url, name: "Work" });
  } finally {
    setCalendarFeedFetchForTests(null);
  }
}

/** Files under `dir`: text, or a number for a file of that many bytes. */
export function writeFiles(dir: string, files: Record<string, string | number>): void {
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof body === "number" ? Buffer.alloc(body, 120) : body);
  }
}

/**
 * Shares a folder of this computer with Ensemble under a name (what `ensemble folders add` does), and
 * tells the web at once, so the owner's nodes can name it.
 */
export async function shareFolder(ctx: TaskContext, label: string, path: string, access: "read-write" | "review" = "read-write"): Promise<void> {
  await ctx.world.share(label, path, access);
  ctx.onCleanup(() => ctx.world.unshare(label));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const device = await ctx.world.prisma.device.findUnique({ where: { id: ctx.deviceId }, select: { capabilities: true } });
    const folders = ((device?.capabilities ?? {}) as { folders?: unknown }).folders;
    if (JSON.stringify(folders ?? []).includes(`"${label}"`)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The computer did not publish the shared folder "${label}".`);
}

/** Serves these pages on 127.0.0.1 until the run ends; answers the base address. */
export async function serveHtml(ctx: TaskContext, pages: Record<string, string>): Promise<string> {
  const server = createServer((request, response) => {
    const page = pages[(request.url ?? "/").split("?")[0]!];
    response.writeHead(page === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(page ?? "<!doctype html><title>Not found</title><h1>Not found</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  ctx.onCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Today's date in the owner's time zone, and a time on it as an instant. */
/** Minutes since midnight now, in that time zone. */
export function localMinutes(timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === "hour")!.value) * 60 + Number(parts.find((part) => part.type === "minute")!.value);
}

export function localDay(timeZone: string, offsetDays = 0): { date: string; at: (hhmm: string) => Date } {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const at = (hhmm: string) => {
    const [hours, minutes] = hhmm.split(":").map(Number) as [number, number];
    const guess = new Date(`${date}T${hhmm}:00Z`);
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(guess);
    const shown = Number(parts.find((part) => part.type === "hour")!.value) * 60 + Number(parts.find((part) => part.type === "minute")!.value);
    let delta = shown - (hours * 60 + minutes);
    if (delta > 720) delta -= 1440;
    if (delta < -720) delta += 1440;
    return new Date(guess.getTime() - delta * 60_000);
  };
  return { date, at };
}
