/**
 * The person's AI activity log (docs/07 §1.4): what their AI work sent and got back, kept 30 days so
 * Ensemble can look into how it served them. Each model call with its prompt and answer, each tool
 * call (Ensemble's and the agent's own) with its input and output, errors with their stack, and the
 * warnings and errors the server and their computers logged while working for them.
 *
 * Writing never slows or fails the work: entries queue here and go to the database in batches. On a
 * paired computer they go to Ensemble on the web instead (`setAiActivitySink`, remote/loop.ts), which
 * stores them on the account the computer is paired with. Keys and known secret shapes are removed,
 * pictures and files become a short note, and long text is cut before anything is queued.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma, PrismaClient } from "@prisma/client";
import { env } from "../config.js";
import { currentScope, isVisitor, keysFor } from "../sharing/context.js";
import { prisma } from "./prisma.js";
import { redactText } from "./redact.js";

export const AI_ACTIVITY_RETENTION_DAYS = 30;
export const AI_ACTIVITY_KINDS = ["model.call", "tool.call", "agent.tool", "error", "server.log", "runner.log"] as const;
export type AiActivityKind = (typeof AI_ACTIVITY_KINDS)[number];

/** What an entry belongs to, by id: the chat, the agent turn and session, the run, the page… */
export type AiRefs = Record<string, string>;

export type AiActivityEntry = {
  kind: AiActivityKind;
  /** The account it is for. Defaults to the surrounding work (`withAiContext`) or request. */
  userId?: string;
  purpose?: string | null;
  app?: string | null;
  model?: string | null;
  /** A tool's name, or a log line's level. */
  name?: string | null;
  ok?: boolean | null;
  durationMs?: number | null;
  input?: unknown;
  output?: unknown;
  /** An Error keeps its message and stack. */
  error?: unknown;
  stack?: string | null;
  refs?: AiRefs;
  meta?: Record<string, unknown>;
};

/** One stored entry, as queued and as a computer sends it to the web. */
export type AiActivityRow = {
  userId: string;
  ts: Date;
  kind: AiActivityKind;
  purpose?: string;
  app?: string;
  model?: string;
  name?: string;
  ok?: boolean;
  durationMs?: number;
  input?: Prisma.InputJsonValue;
  output?: Prisma.InputJsonValue;
  error?: string;
  stack?: string;
  refs: Prisma.InputJsonValue;
  meta: Prisma.InputJsonValue;
};

/** Text kept from one string, one input or output as a whole, and one stack. */
export const AI_ACTIVITY_LIMITS = { string: 16_000, field: 64_000, stack: 16_000, label: 200 } as const;
const QUEUE_MAX = 2_000;
const BATCH = 200;
/** Server and computer log lines kept a minute, and how long the same line is counted, not stored again. */
const LOG_LINES_PER_MINUTE = 300;
const REPEAT_MS = 60_000;

type Context = { userId?: string; purpose?: string; refs: AiRefs };
const context = new AsyncLocalStorage<Context>();

/** Runs `work` with these defaults for the entries it logs: whose work it is, what for, and what it belongs to. */
export function withAiContext<T>(next: { userId?: string; purpose?: string; refs?: Record<string, string | null | undefined> }, work: () => T): T {
  const parent = context.getStore();
  const refs: AiRefs = { ...(parent?.refs ?? {}) };
  for (const [key, value] of Object.entries(next.refs ?? {})) if (value) refs[key] = value.slice(0, AI_ACTIVITY_LIMITS.label);
  return context.run({ userId: next.userId ?? parent?.userId, purpose: next.purpose ?? parent?.purpose, refs }, work);
}

/**
 * `fn` run later with the AI context it was made in: a call that arrives as another request (an
 * agent's tool call relayed from a computer, its hook's question) still belongs to its turn.
 */
export function bindAiContext<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const saved = context.getStore();
  return saved ? (...args: A) => context.run(saved, () => fn(...args)) : fn;
}

/**
 * Off in this repository's own tests unless one turns it on (ENSEMBLE_AI_ACTIVITY=on), so a test's
 * database holds only what it wrote; ENSEMBLE_AI_ACTIVITY=off turns it off anywhere.
 */
function enabled(): boolean {
  const setting = process.env.ENSEMBLE_AI_ACTIVITY;
  if (setting === "off") return false;
  return setting === "on" || !process.env.NODE_TEST_CONTEXT;
}

const onComputer = () => process.env.ENSEMBLE_DESKTOP === "1";

let queue: AiActivityRow[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;
let sink: ((rows: AiActivityRow[]) => Promise<boolean>) | null = null;
let complained = 0;

/**
 * Where a paired computer's entries go: Ensemble on the web. False from the sink (a server without
 * the route) or no sink: this computer's own database.
 */
export function setAiActivitySink(next: ((rows: AiActivityRow[]) => Promise<boolean>) | null): void {
  sink = next;
}

/** Queues one entry. Never throws. */
export function logAi(entry: AiActivityEntry): void {
  if (!enabled()) return;
  try {
    const row = rowFor(entry);
    if (!row) return;
    queue.push(row);
    if (queue.length > QUEUE_MAX) queue = queue.slice(queue.length - QUEUE_MAX);
    if (queue.length >= BATCH) void flushAiActivity();
    else schedule();
  } catch {
    // The log never breaks the work it records.
  }
}

function rowFor(entry: AiActivityEntry): AiActivityRow | null {
  const around = context.getStore();
  const owner = entry.userId ?? around?.userId ?? currentScope()?.accountId ?? (onComputer() ? env.ENSEMBLE_DEV_USER_ID : undefined);
  if (!owner || isVisitor(owner)) return null;
  const error = entry.error instanceof Error ? entry.error : null;
  const message = error ? error.message : typeof entry.error === "string" ? entry.error : entry.error == null ? "" : String(entry.error);
  const stack = entry.stack ?? error?.stack ?? "";
  const refs: AiRefs = { ...(around?.refs ?? {}) };
  for (const [key, value] of Object.entries(entry.refs ?? {})) if (value) refs[key] = String(value).slice(0, AI_ACTIVITY_LIMITS.label);
  const purpose = entry.purpose ?? around?.purpose;
  return {
    userId: keysFor(owner),
    ts: new Date(),
    kind: entry.kind,
    ...label("purpose", purpose),
    ...label("app", entry.app),
    ...label("model", entry.model),
    ...label("name", entry.name),
    ...(typeof entry.ok === "boolean" ? { ok: entry.ok } : {}),
    ...(typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) ? { durationMs: Math.min(2_147_483_647, Math.max(0, Math.round(entry.durationMs))) } : {}),
    ...(entry.input === undefined ? {} : { input: forLog(entry.input) }),
    ...(entry.output === undefined ? {} : { output: forLog(entry.output) }),
    ...(message ? { error: clip(redactText(message), AI_ACTIVITY_LIMITS.string) } : {}),
    ...(stack ? { stack: clip(redactText(stack), AI_ACTIVITY_LIMITS.stack) } : {}),
    refs,
    meta: entry.meta ? forLog(entry.meta) : {},
  };
}

function label<K extends string>(key: K, value: string | null | undefined): Partial<Record<K, string>> {
  return value ? ({ [key]: String(value).slice(0, AI_ACTIVITY_LIMITS.label) } as Record<K, string>) : {};
}

function schedule(): void {
  if (timer) return;
  // A computer sends a batch every few seconds; the web writes its own each second.
  timer = setTimeout(() => {
    timer = null;
    void flushAiActivity();
  }, onComputer() ? 5_000 : 1_000);
  timer.unref();
}

/** Writes (or sends) what is queued. Used on shutdown and by tests. */
export async function flushAiActivity(): Promise<void> {
  while (flushing) await flushing;
  if (!queue.length) return;
  flushing = (async () => {
    while (queue.length) {
      const batch = queue.splice(0, BATCH);
      try {
        const sent = sink ? await sink(batch).catch(() => false) : false;
        if (!sent) await save(batch);
      } catch (error) {
        complain(error);
      }
    }
  })().finally(() => {
    flushing = null;
  });
  await flushing;
}

/** A batch at once; when an account in it is gone (its rows refused), the others one by one. */
async function saveRows(rows: AiActivityRow[]): Promise<void> {
  try {
    await prisma.aiActivity.createMany({ data: rows });
  } catch (error) {
    if ((error as { code?: string }).code !== "P2003") throw error;
    for (const row of rows) await prisma.aiActivity.create({ data: row }).catch(() => undefined);
  }
}

let save = saveRows;

/** Tests: where rows are saved, instead of the database. */
export function saveAiActivityForTests(next: ((rows: AiActivityRow[]) => Promise<void>) | null): void {
  save = next ?? saveRows;
}

/** Once in a while on stderr, never through the logger: a log line about the log would be logged again. */
function complain(error: unknown): void {
  const now = Date.now();
  if (now - complained < 10 * 60_000) return;
  complained = now;
  process.stderr.write(`Ensemble could not save AI activity: ${redactText(error instanceof Error ? error.message : String(error)).slice(0, 300)}\n`);
}

/** What a paired computer sent (remote/contract.ts `ActivityPost`), as its owner's rows: cut and cleaned again here. */
export type DeviceActivity = {
  ts: string;
  kind: AiActivityKind;
  purpose?: string;
  app?: string;
  model?: string;
  name?: string;
  ok?: boolean;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  stack?: string;
  refs: Record<string, string>;
  meta?: unknown;
};

export async function storeDeviceActivity(db: Pick<PrismaClient, "aiActivity" | "workspaceJob">, device: { id: string; userId: string; name: string }, entries: DeviceActivity[]): Promise<number> {
  if (!entries.length) return 0;
  // A job named by the computer is kept only when it is its owner's, with its task.
  const named = [...new Set(entries.map((entry) => entry.refs.job).filter((id): id is string => Boolean(id)))];
  const jobs = named.length ? await db.workspaceJob.findMany({ where: { id: { in: named }, userId: device.userId }, select: { id: true, taskId: true } }) : [];
  const tasks = new Map(jobs.map((job) => [job.id, job.taskId]));
  const now = Date.now();
  const rows: AiActivityRow[] = entries.map((entry) => {
    const at = Date.parse(entry.ts);
    const refs: AiRefs = {};
    for (const [key, value] of Object.entries(entry.refs).slice(0, 20)) if (value && key !== "device") refs[key.slice(0, 40)] = value.slice(0, AI_ACTIVITY_LIMITS.label);
    if (refs.job && !tasks.has(refs.job)) delete refs.job;
    const task = refs.job ? tasks.get(refs.job) : null;
    if (task) refs.task = task;
    refs.device = device.id;
    const meta = entry.meta && typeof entry.meta === "object" && !Array.isArray(entry.meta) ? (entry.meta as Record<string, unknown>) : {};
    return {
      userId: device.userId,
      ts: new Date(Number.isFinite(at) ? Math.min(now, Math.max(now - AI_ACTIVITY_RETENTION_DAYS * 86_400_000, at)) : now),
      kind: entry.kind === "server.log" ? "runner.log" : entry.kind,
      ...label("purpose", entry.purpose),
      ...label("app", entry.app),
      ...label("model", entry.model),
      ...label("name", entry.name),
      ...(typeof entry.ok === "boolean" ? { ok: entry.ok } : {}),
      ...(typeof entry.durationMs === "number" ? { durationMs: entry.durationMs } : {}),
      ...(entry.input === undefined ? {} : { input: forLog(entry.input) }),
      ...(entry.output === undefined ? {} : { output: forLog(entry.output) }),
      ...(entry.error ? { error: clip(redactText(entry.error), AI_ACTIVITY_LIMITS.string) } : {}),
      ...(entry.stack ? { stack: clip(redactText(entry.stack), AI_ACTIVITY_LIMITS.stack) } : {}),
      refs,
      meta: forLog({ ...meta, computer: device.name }),
    };
  });
  return (await db.aiActivity.createMany({ data: rows })).count;
}

/** Deletes this account's entries older than `cutoff`, a batch at a time. */
export async function deleteOldAiActivity(db: Pick<PrismaClient, "aiActivity">, userId: string, cutoff: Date, batchSize = 1_000): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = await db.aiActivity.findMany({ where: { userId, ts: { lt: cutoff } }, select: { id: true }, orderBy: { ts: "asc" }, take: batchSize });
    if (!rows.length) return deleted;
    deleted += (await db.aiActivity.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })).count;
    if (rows.length < batchSize) return deleted;
  }
}

/* What is kept of a value: secrets out, pictures and files as a note, long text cut. */

const SECRET_KEY = /^(?:secret|password|passwd|passwordhash|clientsecret|token|accesstoken|refreshtoken|idtoken|apikey|apitoken|tokenhash|codeverifier|nonce|credentials?|pat|authorization|cookie|privatekey|sessiontoken)$/;

export function forLog(value: unknown): Prisma.InputJsonValue {
  const kept = clean(value, 0);
  const json = JSON.stringify(kept) ?? "null";
  if (json.length <= AI_ACTIVITY_LIMITS.field) return (kept ?? null) as Prisma.InputJsonValue;
  return { clipped: json.length, text: json.slice(0, AI_ACTIVITY_LIMITS.field) };
}

function clean(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return `[${value.byteLength} bytes]`;
  if (value instanceof Error) return { error: redactText(value.message), ...(value.stack ? { stack: clip(redactText(value.stack), AI_ACTIVITY_LIMITS.stack) } : {}) };
  if (typeof value !== "object") return null;
  if (depth >= 10) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 300).map((item) => clean(item, depth + 1));
    if (value.length > 300) items.push(`[${value.length - 300} more]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 300)) {
    if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
    out[key] = SECRET_KEY.test(key.replace(/[_-]/g, "").toLowerCase()) && item !== null && typeof item !== "boolean" ? "[redacted]" : clean(item, depth + 1);
  }
  return out;
}

/** A picture or file sent inline (a data URL, or a long run of base64) becomes what it was and how big. */
function cleanText(text: string): string {
  if (text.length > 512 && text.startsWith("data:")) return `[${/^data:([^;,]+)/.exec(text)?.[1] ?? "data"}, ${text.length} characters]`;
  if (text.length > 4_096 && /^[A-Za-z0-9+/=_-]+$/.test(text.slice(0, 4_096))) return `[base64, ${text.length} characters]`;
  const max = AI_ACTIVITY_LIMITS.string;
  if (text.length <= max) return redactText(text);
  // Cut first, with room for a key across the cut, so a long text is not searched past what is kept.
  return `${redactText(text.slice(0, max + 512)).slice(0, max)}… [${text.length - max} more characters]`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`;
}

/**
 * A model call's messages, without repeating what an earlier step of the same turn already logged:
 * the turn's message list is one array that grows step by step.
 */
const loggedUpTo = new WeakMap<object, number>();
export function newMessages(messages: readonly unknown[]): { from?: number; messages: unknown[] } {
  const before = loggedUpTo.get(messages) ?? 0;
  const from = before <= messages.length ? before : 0;
  loggedUpTo.set(messages, messages.length);
  return { ...(from ? { from } : {}), messages: messages.slice(from) };
}

/* The server's own warnings and errors, and a computer's (pino's logMethod hook, app.ts). */

const LEVELS: Record<number, string> = { 40: "warn", 50: "error", 60: "fatal" };
const repeats = new Map<string, { at: number; count: number }>();
let minute = 0;
let linesThisMinute = 0;

/**
 * One log line at warn or above. On the web it is kept for the account whose request (or work) logged
 * it; on a computer every line is its owner's. The same line again within a minute is counted on the
 * next one kept instead of stored again.
 */
export function captureLogLine(level: number, args: readonly unknown[], bindings?: Record<string, unknown>): void {
  if (level < 40 || !enabled()) return;
  try {
    const first = args[0];
    const fields = first && typeof first === "object" && !(first instanceof Error) ? (first as Record<string, unknown>) : {};
    const err = first instanceof Error ? first : [fields.err, fields.error].find((value): value is Error => value instanceof Error) ?? null;
    const text = [args[0], args[1]].find((value): value is string => typeof value === "string") ?? err?.message ?? "";
    const computer = onComputer();
    const owner = computer ? undefined : currentScope()?.accountId ?? (typeof fields.userId === "string" ? fields.userId : undefined);
    if (!computer && !owner) return;
    const now = Date.now();
    if (now - minute >= 60_000) {
      minute = now;
      linesThisMinute = 0;
    }
    const key = `${owner ?? ""}\u0000${level}\u0000${text}\u0000${err?.message ?? ""}`;
    const seen = repeats.get(key);
    if (seen && now - seen.at < REPEAT_MS) {
      seen.count += 1;
      return;
    }
    if (linesThisMinute >= LOG_LINES_PER_MINUTE) return;
    linesThisMinute += 1;
    if (repeats.size > 1_000) repeats.clear();
    repeats.set(key, { at: now, count: 0 });
    const { err: _err, error: _error, req: _req, res: _res, ...rest } = fields;
    logAi({
      kind: computer ? "runner.log" : "server.log",
      ...(owner ? { userId: owner } : {}),
      app: computer ? "computer" : "server",
      name: LEVELS[level] ?? String(level),
      ok: false,
      output: redactText(text),
      ...(err ? { error: err } : {}),
      meta: { ...rest, ...(bindings?.reqId ? { reqId: bindings.reqId } : {}), ...(seen?.count ? { repeated: seen.count } : {}) },
    });
  } catch {
    // A log line is never lost to its own capture.
  }
}
