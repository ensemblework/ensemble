/**
 * Text of a stored file for agents and search: the file Artifact's text, the character
 * and page counts, and plain warnings when agents cannot read it. Runs after a file is
 * saved, without holding up the response. PDF and Office files are read in a worker
 * thread (extract-worker.ts) with a memory cap and a time limit, two at a time.
 */
import { Worker } from "node:worker_threads";
import { fileFormat, type FileFormat, type FileTextStatus, type SheetPatch } from "@ensemble/shared-types";
import { Prisma, type PrismaClient } from "@prisma/client";
import { redact } from "../connectors/ingest.js";
import { sseHub } from "../lib/sse.js";
import type { WorkerJob, WorkerReply, WorkerText } from "./extract-worker.js";
import { ORIGINAL_SELECT, originalBytes } from "./originals.js";

export const MAX_TEXT_CHARS = 400_000;
const WORKER_TIMEOUT_MS = 30_000;
const WORKER_MEMORY_MB = 256;
const CELLS_MEMORY_MB = 512;
const MAX_WORKERS = 2;
export const PARSER_VERSION = "ensemble-files/1";

type Binary = "pdf" | "docx" | "pptx" | "xlsx";

export type FileText = {
  status: Exclude<FileTextStatus, "queued">;
  text: string;
  pageCount: number | null;
  warnings: string[];
};

const NO_TEXT_KINDS = new Set(["image", "audio", "video", "other"]);

const CANNOT_READ: Partial<Record<string, string>> = {
  document: "Agents can read text from .docx Word files only. Save this one as .docx so they can read it.",
  slides: "Agents can read text from .pptx presentations only. Save this one as .pptx so they can read it.",
  sheet: "Agents can read text from .xlsx and .csv spreadsheets only. Make an .xlsx copy so they can read it.",
};

/** How a format's text is read: decoded here, read in the worker, or not at all. */
export function textRoute(format: FileFormat): "inline" | Binary | "none" {
  if (format.kind === "text" || format.kind === "code" || format.ext === "csv" || format.ext === "tsv") return "inline";
  if (format.ext === "pdf") return "pdf";
  if (format.ext === "docx") return "docx";
  if (format.ext === "pptx") return "pptx";
  if (format.ext === "xlsx" || format.ext === "xlsm") return "xlsx";
  return "none";
}

/** UTF-8 unless a byte order mark says UTF-16. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}

/** The text agents read: secrets redacted, cut at MAX_TEXT_CHARS with a warning. */
export function finishText(raw: string, warnings: string[] = []): { text: string; warnings: string[] } {
  const cleaned = raw.replace(/\u0000/g, "");
  if (cleaned.length <= MAX_TEXT_CHARS) return { text: redact(cleaned), warnings };
  return { text: redact(cleaned.slice(0, MAX_TEXT_CHARS)), warnings: [...warnings, `Agents can read the first ${MAX_TEXT_CHARS.toLocaleString("en-US")} characters of this file.`] };
}

/** The start of a text file: enough bytes for `chars` characters in any encoding, so a large file is never decoded whole. */
export function decodeStart(bytes: Uint8Array, chars: number): { text: string; partial: boolean } {
  const partial = bytes.byteLength > chars * 4;
  return { text: decodeText(partial ? bytes.subarray(0, chars * 4) : bytes), partial };
}

/** Text formats are cheap to decode, so they are ready as soon as the file is saved. */
export function inlineText(filename: string, bytes: Uint8Array): FileText | null {
  if (textRoute(fileFormat(filename)) !== "inline") return null;
  const done = finishText(decodeStart(bytes, MAX_TEXT_CHARS).text);
  return { status: "ready", text: done.text, pageCount: null, warnings: done.warnings };
}

// ── the worker pool ─────────────────────────────────────────────────────────

let active = 0;
const waiting: Array<() => void> = [];

/** Runs `work` when one of the MAX_WORKERS slots is free; a finished job hands its slot to the next in line. */
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_WORKERS) await new Promise<void>((resolve) => waiting.push(resolve));
  else active += 1;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}

export class FileWorkError extends Error {
  readonly expose = true;
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

const workerUrl = new URL(import.meta.url.endsWith(".ts") ? "./extract-worker.ts" : "./extract-worker.js", import.meta.url);

/** One job in its own worker thread: memory-capped, stopped after the time limit. */
function runWorker(job: WorkerJob, memoryMb: number): Promise<WorkerReply> {
  return slot(
    () =>
      new Promise<WorkerReply>((resolve) => {
        let settled = false;
        const finish = (reply: WorkerReply) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          void worker.terminate();
          resolve(reply);
        };
        const worker = new Worker(workerUrl, { workerData: job, resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: 32 }, stdout: true, stderr: true });
        // Parser chatter (font warnings and the like) is not worth a log line.
        worker.stdout.resume();
        worker.stderr.resume();
        const timer = setTimeout(() => finish({ ok: false, reason: "timeout", message: "The file reader ran out of time." }), WORKER_TIMEOUT_MS);
        timer.unref();
        worker.once("message", (reply: WorkerReply) => finish(reply));
        worker.once("error", (error: Error & { code?: string }) =>
          finish({ ok: false, reason: error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "crash", message: error.message }),
        );
        worker.once("exit", () => finish({ ok: false, reason: "crash", message: "The file reader stopped early." }));
      }),
  );
}

/** Reads text from a PDF or Office file in a worker thread. */
export async function binaryText(kind: Binary, bytes: Uint8Array): Promise<FileText> {
  const reply = await runWorker({ task: "text", kind, bytes: new Uint8Array(bytes), maxChars: MAX_TEXT_CHARS }, WORKER_MEMORY_MB);
  if (!reply.ok) {
    const warning =
      reply.reason === "exposed"
        ? reply.message
        : reply.reason === "timeout"
          ? "Reading this file took too long, so agents cannot read it."
          : reply.reason === "memory"
            ? "This file is too large or complex to read here, so agents cannot read it."
            : "This file could not be read (it may be damaged), so agents cannot read it.";
    return { status: "failed", text: "", pageCount: null, warnings: [warning] };
  }
  const result = reply.text as WorkerText;
  const done = finishText(result.text, result.warnings);
  return { status: done.text.trim() ? "ready" : "none", text: done.text, pageCount: result.pageCount, warnings: done.warnings };
}

/** Saves cell edits into an .xlsx in a worker thread and returns the new bytes. */
export async function patchWorkbook(bytes: Uint8Array, patch: SheetPatch): Promise<Uint8Array> {
  const reply = await runWorker({ task: "cells", bytes: new Uint8Array(bytes), patch }, CELLS_MEMORY_MB);
  if (!reply.ok) {
    if (reply.reason === "exposed") throw new FileWorkError(reply.message, 400);
    if (reply.reason === "timeout" || reply.reason === "memory") throw new FileWorkError("This workbook is too large or complex to edit here. Edit it in Excel and upload it again.", 413);
    throw new FileWorkError("Ensemble could not save these cells into the workbook.", 500);
  }
  return reply.bytes!;
}

/** The text known without a worker: decoded text formats, and formats agents cannot read. Null for PDF and Office files. */
export function immediateText(filename: string, bytes: Uint8Array): FileText | null {
  const format = fileFormat(filename);
  const route = textRoute(format);
  if (route === "inline") return inlineText(filename, bytes);
  if (route !== "none") return null;
  const note = NO_TEXT_KINDS.has(format.kind) ? undefined : CANNOT_READ[format.kind];
  return { status: "none", text: "", pageCount: null, warnings: note ? [note] : [] };
}

/** The text of any stored file. Images, audio, video and unknown formats have none. */
export async function readFileText(filename: string, bytes: Uint8Array): Promise<FileText> {
  const route = textRoute(fileFormat(filename));
  return route === "pdf" || route === "docx" || route === "pptx" || route === "xlsx" ? binaryText(route, bytes) : immediateText(filename, bytes)!;
}

// ── after a save ────────────────────────────────────────────────────────────

type Hooks = { summarize?: (id: string) => void; onError?: (error: unknown, id: string) => void };
let hooks: Hooks = {};

/** routes/files.ts wires the summary worker and the log in here. */
export function configureFileText(next: Hooks): void {
  hooks = next;
}

/** Starts the summary of a file whose text is ready. */
export function summarizeFile(id: string): void {
  hooks.summarize?.(id);
}

const inflight = new Map<string, Promise<void>>();

/** Settles when the file's text is written (tests and callers that need the text now). */
export function fileTextSettled(id: string): Promise<void> {
  return inflight.get(id) ?? Promise.resolve();
}

export function fileTextRunning(id: string): boolean {
  return inflight.has(id);
}

/** Stores the text on the file's Artifact, keeping one Artifact per file. Skips when the bytes changed meanwhile. */
export async function writeFileText(db: PrismaClient | Prisma.TransactionClient, id: string, generation: number, result: FileText): Promise<boolean> {
  const write = async (tx: Prisma.TransactionClient) => {
    const row = await tx.document.findFirst({
      where: { id, generation, deletedAt: null },
      select: { userId: true, filename: true, format: true, byteSize: true, artifactId: true, enrichmentStatus: true, source: true },
    });
    if (!row) return false;
    let artifactId = row.artifactId;
    const source = row.source as { url?: string } | null;
    const fields = { title: row.filename, text: result.text, metadata: { documentId: id, format: row.format, byteSize: row.byteSize } };
    if (artifactId) {
      await tx.artifact.update({ where: { id: artifactId }, data: fields });
    } else if (result.text) {
      const artifact = await tx.artifact.upsert({
        where: { userId_kind_externalId: { userId: row.userId, kind: "file", externalId: `file:${id}` } },
        create: { userId: row.userId, kind: "file", externalId: `file:${id}`, ts: new Date(), url: source?.url ?? null, authoredByMe: true, ...fields },
        update: { ...fields, deletedAt: null },
      });
      artifactId = artifact.id;
    }
    const summarize = row.enrichmentStatus === "waiting";
    await tx.document.update({
      where: { id },
      data: {
        artifactId,
        parseStatus: result.status,
        parserVersion: PARSER_VERSION,
        parseError: result.status === "failed" ? { message: result.warnings[0] ?? "Could not read the file." } : Prisma.DbNull,
        textCharacters: result.text.length,
        pageCount: result.pageCount,
        warnings: result.warnings,
        parsedAt: new Date(),
        parseAttempts: { increment: 1 },
        ...(summarize ? { enrichmentStatus: result.text.trim() ? "queued" : "skipped" } : {}),
      },
    });
    return summarize && Boolean(result.text.trim());
  };
  return "$transaction" in db && typeof db.$transaction === "function" ? (db as PrismaClient).$transaction(write) : write(db as Prisma.TransactionClient);
}

/**
 * Reads the file's text in the background. A second call while one runs shares it, unless
 * `again` says the bytes changed: then it runs once more after the current one.
 */
export function queueFileText(db: PrismaClient, id: string, again = false): Promise<void> {
  const running = inflight.get(id);
  if (running && !again) return running;
  const job: Promise<void> = (async () => {
    if (running) await running;
    const row = await db.document.findFirst({ where: { id, deletedAt: null }, select: { userId: true, filename: true, generation: true, ...ORIGINAL_SELECT } });
    if (!row) return;
    // Outside the try: storage that cannot be reached leaves the file queued, and listing Files queues it again.
    const bytes = await originalBytes(row);
    let result: FileText;
    try {
      result = await readFileText(row.filename, bytes);
    } catch (error) {
      hooks.onError?.(error, id);
      result = { status: "failed", text: "", pageCount: null, warnings: ["This file could not be read, so agents cannot read it."] };
    }
    const summarize = await writeFileText(db, id, row.generation, result);
    sseHub.publish(row.userId, { event: "documents", data: { id } });
    if (summarize) hooks.summarize?.(id);
  })()
    .catch((error: unknown) => hooks.onError?.(error, id))
    .finally(() => {
      if (inflight.get(id) === job) inflight.delete(id);
    });
  inflight.set(id, job);
  return job;
}

/** Edit Office text with the same worker memory/time limits as spreadsheet changes. */
export async function patchOfficeText(bytes: Uint8Array, kind: "docx" | "pptx", find: string, replacement: string): Promise<Uint8Array> {
  const reply = await runWorker({ task: "office-edit", bytes: new Uint8Array(bytes), kind, find, replacement }, CELLS_MEMORY_MB);
  if (!reply.ok) throw new FileWorkError(reply.reason === "exposed" ? reply.message : "This Office file is too large, complex or damaged to edit here.", reply.reason === "exposed" ? 400 : 413);
  return reply.bytes!;
}
