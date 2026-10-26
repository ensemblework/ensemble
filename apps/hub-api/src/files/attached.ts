/**
 * Files attached to work, for agents: the files mentioned on a task's page and on its
 * project's page (or on a standalone page), plus files tagged with the task. Each with
 * what an agent needs to decide how to read it, and its text in pages. Everything is
 * scoped to the owner. Used by Ensemble's agent, the engines, paired computers, the Hub
 * assistant and the Context Bridge.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileFormat, type FileKind, type FileTextStatus } from "@ensemble/shared-types";
import type { Prisma, PrismaClient } from "@prisma/client";
import { clip } from "../lib/office/text.js";
import { ORIGINAL_SELECT, originalBytes } from "./originals.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface AttachedFile {
  id: string;
  filename: string;
  format: string;
  kind: FileKind;
  byteSize: number;
  textCharacters: number;
  pageCount: number | null;
  textStatus: FileTextStatus;
}

export interface FileText extends AttachedFile {
  text: string;
  offset: number;
  total: number;
  /** Set when there is more; pass it back as offset. */
  nextOffset?: number;
  /** Why there is no text, when there is none. */
  note?: string;
}

const MAX_FILES = 100;
const NO_TEXT: ReadonlySet<FileKind> = new Set(["image", "audio", "video"]);

const FILE_FIELDS = { id: true, filename: true, byteSize: true, textCharacters: true, pageCount: true, parseStatus: true } satisfies Prisma.DocumentSelect;

type FileRow = Prisma.DocumentGetPayload<{ select: typeof FILE_FIELDS }>;

function attached(row: FileRow): AttachedFile {
  const format = fileFormat(row.filename);
  const textStatus: FileTextStatus = NO_TEXT.has(format.kind) || row.parseStatus === "none" ? "none" : row.parseStatus === "ready" ? "ready" : row.parseStatus === "failed" ? "failed" : "queued";
  return { id: row.id, filename: row.filename, format: format.ext, kind: format.kind, byteSize: row.byteSize, textCharacters: row.textCharacters, pageCount: row.pageCount, textStatus };
}

/** File ids placed in a page document, in page order: @ mentions of a file, and blocks that embed one (`attrs.fileId`). */
export function mentionedFileIds(content: unknown): string[] {
  const ids: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const { type, attrs, content: children } = node as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown };
    if (type === "mention" && attrs?.kind === "file" && typeof attrs.id === "string" && attrs.id) ids.push(attrs.id);
    else if (typeof attrs?.fileId === "string" && attrs.fileId) ids.push(attrs.fileId);
    if (Array.isArray(children)) children.forEach(walk);
  };
  walk(content);
  return [...new Set(ids)];
}

/** These files, in the order given, leaving out any that are gone or not this person's. */
export async function filesByIds(db: Db, userId: string, ids: string[]): Promise<AttachedFile[]> {
  const unique = [...new Set(ids)].slice(0, MAX_FILES);
  if (!unique.length) return [];
  const rows = await db.document.findMany({ where: { id: { in: unique }, userId, deletedAt: null }, select: FILE_FIELDS });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return unique.flatMap((id) => (byId.has(id) ? [attached(byId.get(id)!)] : []));
}

/** Files on a task: mentioned on its page, then on its project's page, then tagged with the task. */
export async function filesOnTask(db: Db, userId: string, taskId: string): Promise<AttachedFile[]> {
  const task = await db.task.findFirst({
    where: { id: taskId, userId, deletedAt: null },
    select: { page: { select: { content: true, deletedAt: true, sourceFileId: true } }, project: { select: { content: true, deletedAt: true } } },
  });
  if (!task) return [];
  const tagged = await db.document.findMany({ where: { userId, deletedAt: null, taskIds: { has: taskId } }, orderBy: { createdAt: "asc" }, take: MAX_FILES, select: { id: true } });
  return filesByIds(db, userId, [
    ...(task.page && !task.page.deletedAt ? [...mentionedFileIds(task.page.content), ...(task.page.sourceFileId ? [task.page.sourceFileId] : [])] : []),
    ...(task.project && !task.project.deletedAt ? mentionedFileIds(task.project.content) : []),
    ...tagged.map((row) => row.id),
  ]);
}

/** Files on a page: a task's page counts as its task; a standalone page has the files it mentions. */
export async function filesOnPage(db: Db, userId: string, pageId: string): Promise<AttachedFile[]> {
  const page = await db.taskPage.findFirst({ where: { id: pageId, userId, deletedAt: null }, select: { taskId: true, content: true, sourceFileId: true } });
  if (!page) return [];
  if (page.taskId) return filesOnTask(db, userId, page.taskId);
  return filesByIds(db, userId, [...mentionedFileIds(page.content), ...(page.sourceFileId ? [page.sourceFileId] : [])]);
}

/** The person's files, newest first, matched by name or text. */
export async function listFiles(db: Db, userId: string, input: { query?: string; limit?: number } = {}): Promise<AttachedFile[]> {
  const query = input.query?.trim();
  const rows = await db.document.findMany({
    where: {
      userId,
      deletedAt: null,
      ...(query ? { OR: [{ filename: { contains: query, mode: "insensitive" } }, { artifact: { text: { contains: query, mode: "insensitive" } } }] } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(Math.floor(input.limit ?? 20), 1), MAX_FILES),
    select: FILE_FIELDS,
  });
  return rows.map(attached);
}

/** "PDF · 1.2 MB · 12 pages". */
export function describeFile(file: Pick<AttachedFile, "filename" | "byteSize" | "pageCount">): string {
  const format = fileFormat(file.filename);
  const size = file.byteSize < 1024 ? `${file.byteSize} B` : file.byteSize < 1024 * 1024 ? `${Math.round(file.byteSize / 1024)} KB` : `${(file.byteSize / (1024 * 1024)).toFixed(1)} MB`;
  const unit = format.kind === "slides" ? "slides" : format.kind === "sheet" ? "sheets" : "pages";
  return [format.label, size, file.pageCount ? `${file.pageCount} ${file.pageCount === 1 ? unit.replace(/s$/, "") : unit}` : null].filter(Boolean).join(" · ");
}

function noTextNote(file: AttachedFile): string | undefined {
  if (file.textStatus === "none") return `${file.filename} is ${NO_TEXT.has(file.kind) ? `${file.kind === "image" ? "an image" : file.kind === "audio" ? "audio" : "a video"}` : "a file"} with no text to read (${describeFile(file)}).`;
  if (file.textStatus === "queued") return "Ensemble is still reading this file's text. Try again in a minute.";
  if (file.textStatus === "failed") return "Ensemble could not read text from this file.";
  if (!file.textCharacters) return "No text was found in this file; a scanned page or a picture has none.";
  return undefined;
}

/** One window of a file's text, with what it is. Null when the file is not this person's. */
export async function fileText(db: Db, userId: string, id: string, offset = 0, limit = 6000): Promise<FileText | null> {
  const row = await db.document.findFirst({ where: { id, userId, deletedAt: null }, select: { ...FILE_FIELDS, artifact: { select: { text: true } } } });
  if (!row) return null;
  const file = attached(row);
  const text = row.artifact?.text ?? "";
  const part = clip(text, offset, Math.max(200, Math.min(limit, 20_000)));
  const note = text ? undefined : (noTextNote({ ...file, textCharacters: 0 }) ?? "This file has no text.");
  return { ...file, text: part.text, offset: part.offset, total: part.total, ...(part.nextOffset !== undefined ? { nextOffset: part.nextOffset } : {}), ...(note ? { note } : {}) };
}

/** A file named by id or by its exact name (case does not matter), among the given files first, then all of the person's. */
export async function findFile(db: Db, userId: string, ref: string, among: AttachedFile[] = []): Promise<AttachedFile | null> {
  const wanted = ref.trim();
  if (!wanted) return null;
  const named = among.find((file) => file.id === wanted) ?? among.find((file) => file.filename.toLowerCase() === wanted.toLowerCase());
  if (named) return named;
  const row = /^[0-9a-f-]{36}$/i.test(wanted)
    ? await db.document.findFirst({ where: { id: wanted, userId, deletedAt: null }, select: FILE_FIELDS })
    : await db.document.findFirst({ where: { userId, deletedAt: null, filename: { equals: wanted, mode: "insensitive" } }, orderBy: { createdAt: "desc" }, select: FILE_FIELDS });
  return row ? attached(row) : null;
}

/** The original bytes. Null when the file is not this person's. */
export async function fileOriginal(db: Db, userId: string, id: string): Promise<{ filename: string; bytes: Uint8Array } | null> {
  const row = await db.document.findFirst({ where: { id, userId, deletedAt: null }, select: { filename: true, ...ORIGINAL_SELECT } });
  return row ? { filename: row.filename, bytes: await originalBytes(row) } : null;
}

/** A name that is safe as one path segment on every system. */
export function diskName(filename: string): string {
  const clean = filename
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/[\s.]+$/, "")
    .trim();
  return !clean || /^\.+$/.test(clean) ? "file" : clean.slice(0, 200);
}

/** Writes each file's original into `dir` (which must be fresh), named after the file; two files with one name get " (2)". */
export async function copyOriginals(db: Db, userId: string, files: AttachedFile[], dir: string): Promise<Map<string, string>> {
  await mkdir(dir, { recursive: true });
  const paths = new Map<string, string>();
  const used = new Set<string>();
  for (const file of files) {
    const original = await fileOriginal(db, userId, file.id);
    if (!original) continue;
    const name = diskName(original.filename);
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${stem} (${n})${ext}`;
    used.add(candidate.toLowerCase());
    const path = join(dir, candidate);
    await writeFile(path, original.bytes, { flag: "wx" });
    paths.set(file.id, path);
  }
  return paths;
}

/**
 * The prompt section listing attached files: name, kind, size and id, with the start of each
 * file's text (capped per file and in total), and how to read more (`more`: a tool, or the
 * copied originals' paths).
 */
export async function filesSection(
  db: Db,
  userId: string,
  files: AttachedFile[],
  options: { perFile?: number; total?: number; more: (file: AttachedFile) => string; intro?: string },
): Promise<string> {
  if (!files.length) return "";
  const perFile = options.perFile ?? 2000;
  let left = options.total ?? 10_000;
  const parts: string[] = [];
  for (const file of files) {
    const head = `### ${file.filename} (${describeFile(file)}, id ${file.id})`;
    let body = "";
    if (left > 200 && file.textStatus === "ready") {
      const read = await fileText(db, userId, file.id, 0, Math.min(perFile, left));
      const excerpt = read?.text.trim() ?? "";
      if (excerpt) {
        body = `${excerpt}${read?.nextOffset !== undefined ? `\n… (${(read.total - read.offset - read.text.length).toLocaleString("en-US")} more characters)` : ""}`;
        left -= excerpt.length;
      }
    }
    if (!body) body = noTextNote(file) ?? `(Its ${file.textCharacters.toLocaleString("en-US")} characters of text are not shown here.)`;
    parts.push([head, body, options.more(file)].filter(Boolean).join("\n"));
  }
  return [options.intro ?? "", ...parts].filter(Boolean).join("\n\n");
}
