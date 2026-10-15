/**
 * Storing files: caps (hosted accounts only), the original bytes on the
 * Document row, and its text on a file Artifact for agents and search.
 * Every way a file arrives (upload, import from an app) goes through saveFile.
 */
import { createHash, randomUUID } from "node:crypto";
import { fileFormat, fileTypeProblem, type FileRecord, type FileStyleProfile, type FileTextStatus, type FileUsage } from "@ensemble/shared-types";
import { Prisma, type PrismaClient } from "@prisma/client";
import { isHosted } from "../lib/hosted-access.js";
import { assertFileRoom, createCappedDocument, hostedLimits, quotaScope, sizeLabel, withHostedUserLock } from "../lib/hosted-limits.js";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { immediateText, PARSER_VERSION, queueFileText, summarizeFile, writeFileText } from "./extract.js";

const MIB = 1024 * 1024;
export const HOSTED_MAX_FILE_BYTES = 25 * MIB;
export const LOCAL_MAX_FILE_BYTES = 100 * MIB;

/** Largest single file this server accepts. */
export function maxFileBytes(): number {
  return isHosted() ? HOSTED_MAX_FILE_BYTES : LOCAL_MAX_FILE_BYTES;
}

export class FileError extends Error {
  readonly expose = true;
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export interface NewFile {
  filename: string;
  /** What the sender said; Ensemble prefers the format's own media type. */
  mediaType: string;
  bytes: Uint8Array;
  /** Set when the file came from a connected app. */
  source?: { app: string; label: string; url?: string; externalId?: string };
}

export interface SaveFileOptions {
  /** Ask for a one-paragraph summary once the text is read. Default true. */
  summarize?: boolean;
  tags?: { projectIds?: string[]; personIds?: string[]; repoIds?: string[]; taskIds?: string[] };
}

export const FILE_SELECT = {
  id: true,
  filename: true,
  mediaType: true,
  byteSize: true,
  format: true,
  sha256: true,
  parseStatus: true,
  textCharacters: true,
  pageCount: true,
  warnings: true,
  summary: true,
  source: true,
  style: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DocumentSelect;

export type FileRow = Prisma.DocumentGetPayload<{ select: typeof FILE_SELECT }>;

const TEXT_STATUS: Record<string, FileTextStatus> = { ready: "ready", failed: "failed", none: "none", queued: "queued", running: "queued" };

export function fileRecord(row: FileRow): FileRecord {
  const format = fileFormat(row.filename);
  const source = row.source && typeof row.source === "object" && !Array.isArray(row.source) ? (row.source as Record<string, unknown>) : null;
  return {
    id: row.id,
    filename: row.filename,
    mediaType: row.mediaType,
    byteSize: row.byteSize,
    format: format.ext,
    kind: format.kind,
    sha256: row.sha256,
    textStatus: TEXT_STATUS[row.parseStatus] ?? "queued",
    textCharacters: row.textCharacters,
    pageCount: row.pageCount,
    warnings: row.warnings,
    summary: row.summary,
    source:
      source && typeof source.app === "string" && typeof source.label === "string"
        ? { app: source.app, label: source.label, ...(typeof source.url === "string" ? { url: source.url } : {}) }
        : null,
    hasStyle: Boolean(row.style),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** "PDF · 2.1 MB", for pickers and @ mentions. */
export function fileDetail(filename: string, byteSize: number): string {
  return `${fileFormat(filename).label} · ${sizeLabel(byteSize)}`;
}

/** Files and bytes this account keeps, against its caps. Hosted caps are per account, over every space. */
export async function fileUsage(db: PrismaClient | Prisma.TransactionClient, userId: string): Promise<FileUsage> {
  const hosted = isHosted();
  const ids = hosted ? (await quotaScope(db, userId)).ids : [userId];
  const kept = await db.document.aggregate({ where: { userId: { in: ids }, deletedAt: null }, _count: true, _sum: { byteSize: true } });
  const limits = hosted ? hostedLimits() : null;
  return {
    count: kept._count,
    bytes: kept._sum.byteSize ?? 0,
    maxCount: limits?.documents ?? null,
    maxBytes: limits?.documentBytes ?? null,
    maxFileBytes: maxFileBytes(),
  };
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why a file name cannot be used, or null when it can. */
export function filenameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the file a name.";
  if (trimmed.length > 255) return "File names can be up to 255 characters.";
  if (/[\\/]/.test(trimmed)) return "File names cannot contain / or \\.";
  if (CONTROL.test(trimmed)) return "File names cannot contain control characters.";
  if (trimmed === "." || trimmed === "..") return "That is not a file name.";
  if (RESERVED.test(trimmed)) return `“${trimmed}” is a name Windows keeps for itself. Rename the file and try again.`;
  return null;
}

/** A usable name for a file from another app, whose names may hold slashes or control characters. */
export function safeFilename(name: string): string {
  let clean = name.replace(new RegExp(CONTROL.source, "g"), "").replace(/[\\/]/g, "-").trim();
  if (clean.length > 255) {
    const dot = clean.lastIndexOf(".");
    const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
    clean = `${clean.slice(0, 255 - ext.length).trimEnd()}${ext}`;
  }
  if (!clean || clean === "." || clean === "..") return "file";
  return RESERVED.test(clean) ? `_${clean}` : clean;
}

/** The format's own media type; for unknown formats a clean copy of what the sender said. */
export function mediaTypeFor(filename: string, given: string | undefined): string {
  const format = fileFormat(filename);
  if (format.kind !== "other") return format.mime;
  const value = (given ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(value) ? value : "application/octet-stream";
}

/** The refusal for a file over the size limit, also sent when an upload's body is too large to read. */
export function fileTooLarge(): FileError {
  const max = maxFileBytes();
  return new FileError(isHosted() ? `Files can be up to ${sizeLabel(max)} on the hosted plan.` : `Files can be up to ${sizeLabel(max)}.`, 413);
}

function assertSize(bytes: number): void {
  if (bytes > maxFileBytes()) throw fileTooLarge();
}

/**
 * A file someone brings in (an upload, a drop, an import from an app) must have something in it
 * and must not be a program. Copies of files already kept, such as a paired computer's task
 * attachments, are not asked again.
 */
export function assertNewFile(filename: string, bytes: number): void {
  const kind = fileTypeProblem(filename);
  if (kind) throw new FileError(kind, 415);
  if (bytes === 0) throw new FileError("This file is empty, so there is nothing to keep.", 400);
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Saves a new file for this person, refusing it when a hosted cap would be passed. Text extraction runs after. */
export async function saveFile(db: PrismaClient, userId: string, file: NewFile, options: SaveFileOptions = {}): Promise<FileRecord> {
  const filename = safeFilename(file.filename);
  assertSize(file.bytes.byteLength);
  const format = fileFormat(filename);
  const original = Buffer.from(file.bytes.buffer as ArrayBuffer, file.bytes.byteOffset, file.bytes.byteLength);
  const known = immediateText(filename, original);
  const id = randomUUID();
  const summarize = options.summarize ?? true;
  const enrichmentStatus = !summarize ? "skipped" : known ? (known.text.trim() ? "queued" : "skipped") : "waiting";
  const tags = {
    projectIds: options.tags?.projectIds ?? [],
    personIds: options.tags?.personIds ?? [],
    repoIds: options.tags?.repoIds ?? [],
    taskIds: options.tags?.taskIds ?? [],
  };
  const row = await createCappedDocument(db, userId, {
    data: {
      id,
      userId,
      filename,
      mediaType: mediaTypeFor(filename, file.mediaType),
      byteSize: original.byteLength,
      sha256: sha256(original),
      original,
      format: format.ext,
      parseStatus: known?.status ?? "queued",
      parserVersion: PARSER_VERSION,
      textCharacters: known?.text.length ?? 0,
      pageCount: known?.pageCount ?? null,
      warnings: known?.warnings ?? [],
      parsedAt: known ? new Date() : null,
      enrichmentStatus,
      ...(file.source ? { source: file.source } : {}),
      ...tags,
      manualTags: tags,
      artifact: known?.text
        ? {
            create: {
              userId,
              kind: "file",
              externalId: `file:${id}`,
              ts: new Date(),
              url: file.source?.url ?? null,
              title: filename,
              text: known.text,
              metadata: { documentId: id, format: format.ext, byteSize: original.byteLength },
              authoredByMe: true,
            },
          }
        : undefined,
    },
    select: FILE_SELECT,
  });
  await appendLedger({
    userId,
    actor: "me",
    action: file.source ? "document.import" : "document.upload",
    payload: { id, filename, bytes: original.byteLength, ...(file.source ? { app: file.source.app } : {}) },
  });
  sseHub.publish(userId, { event: "documents", data: { id } });
  if (!known) void queueFileText(db, id);
  else if (enrichmentStatus === "queued") summarizeFile(id);
  return fileRecord(row);
}

/**
 * Replaces a file's bytes (an edited CSV, cells saved into a workbook, an .xls made into .xlsx),
 * re-checking the hosted caps with the size change and reading its text again. Null when the
 * file is not this person's.
 */
export async function replaceFileBytes(
  db: PrismaClient,
  userId: string,
  id: string,
  input: { bytes: Uint8Array; filename?: string; mediaType?: string },
  action = "document.update",
): Promise<FileRecord | null> {
  const existing = await db.document.findFirst({ where: { id, userId, deletedAt: null }, select: { filename: true, mediaType: true, format: true } });
  if (!existing) return null;
  assertSize(input.bytes.byteLength);
  const filename = input.filename ? safeFilename(input.filename) : existing.filename;
  const format = fileFormat(filename);
  const original = Buffer.from(input.bytes.buffer as ArrayBuffer, input.bytes.byteOffset, input.bytes.byteLength);
  const known = immediateText(filename, original);
  const row = await db.$transaction((tx) =>
    withHostedUserLock(tx, userId, async (inner) => {
      if (!(await inner.document.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true } }))) return null;
      await assertFileRoom(inner, userId, { files: 0, bytes: original.byteLength, replacingId: id });
      const updated = await inner.document.update({
        where: { id },
        data: {
          filename,
          format: format.ext,
          mediaType: input.filename || input.mediaType ? mediaTypeFor(filename, input.mediaType ?? existing.mediaType) : existing.mediaType,
          original,
          byteSize: original.byteLength,
          sha256: sha256(original),
          generation: { increment: 1 },
          parseStatus: "queued",
          warnings: [],
          pageCount: null,
          ...(format.ext !== existing.format ? { style: Prisma.DbNull } : {}),
        },
        select: { generation: true },
      });
      if (known) await writeFileText(inner, id, updated.generation, known);
      return inner.document.findUniqueOrThrow({ where: { id }, select: FILE_SELECT });
    }, false),
  );
  if (!row) return null;
  await appendLedger({ userId, actor: "me", action, payload: { id, filename, bytes: original.byteLength } });
  sseHub.publish(userId, { event: "documents", data: { id } });
  if (!known) void queueFileText(db, id, true);
  return fileRecord(row);
}

/** The formatting saved when a PDF or Word file became a page. */
export function fileStyle(value: unknown): FileStyleProfile | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as FileStyleProfile) : null;
}
