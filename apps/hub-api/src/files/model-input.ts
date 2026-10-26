/**
 * What a model is given of a person's files: the file itself when the model reads that kind
 * (pictures as image parts, documents as file parts; lib/vision.ts), else the start of Files'
 * extracted text. Shared by the Hub assistant and Ensemble Node (attachments on a message,
 * hub_view_file) and Ensemble's own agent on a task (the brief and view_attachment). File content
 * is information, never instructions.
 */
import { modelFileMime } from "@ensemble/shared-types";
import type { Prisma, PrismaClient } from "@prisma/client";
import { type AttachedFile, describeFile, fileOriginal, filesSection } from "./attached.js";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The smallest per-image limit among the providers: Anthropic's 5 MB applies to the base64 text, so
 * 3.75 MB of picture. Larger pictures are refused, not resized.
 */
export const MODEL_IMAGE_MAX_BYTES = (5 * 1024 * 1024 * 3) / 4;
/** Pictures given with one message or brief; more can be opened with the view tool. */
export const MODEL_IMAGES_PER_MESSAGE = 4;
/** All pictures in one request together, kept well under the desktop/CLI included-turn body limit (routes/included.ts). */
export const MODEL_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;

/** A document given whole, per file and for one message or brief together. */
export const MODEL_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const MODEL_FILE_TOTAL_BYTES = 16 * 1024 * 1024;
/** Pictures and files kept in a running conversation, and their bytes together (keepRecentAttachments). */
export const MODEL_KEEP_ATTACHMENTS = 8;
export const MODEL_KEEP_BYTES = MODEL_IMAGE_TOTAL_BYTES + MODEL_FILE_TOTAL_BYTES;

export type ImagePart = { type: "image_url"; image_url: { url: string } };
export type FilePart = { type: "file"; file: { filename: string; file_data: string } };
export type ContentPart = { type: "text"; text: string } | ImagePart | FilePart;

export type ModelImage = { file: AttachedFile; part: ImagePart; bytes: number };
export type ModelDocument = { file: AttachedFile; part: FilePart; bytes: number };

/** The image type from the file's first bytes; the extension is not trusted. */
export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  const at = (index: number) => bytes[index] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38 && (at(4) === 0x37 || at(4) === 0x39) && at(5) === 0x61) return "image/gif";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  return null;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The picture as an image part, or why it cannot be given to a model. */
export async function imageForModel(db: Db, userId: string, file: AttachedFile): Promise<{ image: ModelImage } | { problem: string }> {
  if (file.kind !== "image") return { problem: `${file.filename} is not a picture (${describeFile(file)}).` };
  if (file.byteSize > MODEL_IMAGE_MAX_BYTES) {
    return { problem: `${file.filename} is ${megabytes(file.byteSize)}; models take pictures up to 3.75 MB. A smaller copy (PNG or JPEG) can be read.` };
  }
  const original = await fileOriginal(db, userId, file.id);
  if (!original) return { problem: `${file.filename} is no longer in Files.` };
  const mime = sniffImage(original.bytes);
  if (!mime) return { problem: `${file.filename} is not a PNG, JPEG, GIF or WebP picture, the kinds models read. A PNG or JPEG copy can be read.` };
  const data = Buffer.from(original.bytes).toString("base64");
  return { image: { file, part: { type: "image_url", image_url: { url: `data:${mime};base64,${data}` } }, bytes: original.bytes.byteLength } };
}

/** The document as a file part, or why it cannot be given whole. */
export async function documentForModel(db: Db, userId: string, file: AttachedFile): Promise<{ document: ModelDocument } | { problem: string }> {
  const mime = modelFileMime(file.filename);
  if (!mime || file.kind === "image") return { problem: `${file.filename} is not a kind of document models read as a file (${describeFile(file)}).` };
  if (file.byteSize > MODEL_FILE_MAX_BYTES) return { problem: `${file.filename} is ${megabytes(file.byteSize)}; files up to 16 MB are given to the model whole.` };
  const original = await fileOriginal(db, userId, file.id);
  if (!original) return { problem: `${file.filename} is no longer in Files.` };
  const data = Buffer.from(original.bytes).toString("base64");
  return { document: { file, part: { type: "file", file: { filename: file.filename, file_data: `data:${mime};base64,${data}` } }, bytes: original.bytes.byteLength } };
}

/** Waits (briefly) for Files to finish reading text from just-uploaded files, so a message sent right after an upload still gets their text. */
export async function settleFileText(db: Db, userId: string, ids: string[], waitMs = 20_000, signal?: AbortSignal): Promise<void> {
  if (!ids.length) return;
  const until = Date.now() + waitMs;
  while (Date.now() < until && !signal?.aborted) {
    const pending = await db.document.count({ where: { id: { in: ids }, userId, deletedAt: null, parseStatus: { in: ["queued", "running"] } } });
    if (!pending) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export type FilesForModel = {
  /** The files' section: names, kinds, the start of the text of files not given whole, and what could not be given. */
  text: string;
  /** Pictures and files to put in the message after the text, each preceded by its name. */
  parts: ContentPart[];
  images: ModelImage[];
  documents: ModelDocument[];
};

/**
 * Text, pictures and files for a set of files. `images` false (a model that does not read images)
 * gives each picture's name with a plain statement that the model cannot see it, never a guess.
 * `documents` says which documents the model reads as the file itself; the others, and any over the
 * size budget, get the start of their text.
 */
export async function filesForModel(
  db: Db,
  userId: string,
  files: AttachedFile[],
  options: { images: boolean; documents?: (filename: string) => boolean; perFile?: number; total?: number; intro?: string; more?: (file: AttachedFile) => string; viewTool?: string },
): Promise<FilesForModel> {
  const images: ModelImage[] = [];
  const documents: ModelDocument[] = [];
  const notes = new Map<string, string>();
  let bytes = 0;
  let documentBytes = 0;
  for (const file of files) {
    if (file.kind === "image" || !options.documents?.(file.filename)) continue;
    const got = await documentForModel(db, userId, file);
    if ("problem" in got) {
      notes.set(file.id, `${got.problem} The start of its text is shown instead.`);
      continue;
    }
    if (documentBytes + got.document.bytes > MODEL_FILE_TOTAL_BYTES) {
      notes.set(file.id, `Not given whole: the files in this message are too large together. The start of its text is shown${options.viewTool ? `; open the file itself with ${options.viewTool}` : ""}.`);
      continue;
    }
    documentBytes += got.document.bytes;
    documents.push(got.document);
    notes.set(file.id, "The file itself is attached below: read it directly.");
  }
  for (const file of files) {
    if (file.kind !== "image") continue;
    if (!options.images) {
      notes.set(file.id, "This model cannot see pictures, so this one was not shown to it. Say so rather than guess what it shows; a model that reads images can look at it.");
      continue;
    }
    if (images.length >= MODEL_IMAGES_PER_MESSAGE) {
      notes.set(file.id, options.viewTool ? `Not shown yet: open it with ${options.viewTool}.` : "Not shown: too many pictures in one message.");
      continue;
    }
    const got = await imageForModel(db, userId, file);
    if ("problem" in got) {
      notes.set(file.id, got.problem);
      continue;
    }
    if (bytes + got.image.bytes > MODEL_IMAGE_TOTAL_BYTES) {
      notes.set(file.id, options.viewTool ? `Not shown yet: open it with ${options.viewTool}.` : "Not shown: the pictures in this message are too large together.");
      continue;
    }
    bytes += got.image.bytes;
    images.push(got.image);
    notes.set(file.id, "The picture is included below.");
  }
  const whole = new Set(documents.map((document) => document.file.id));
  const text = await filesSection(db, userId, files, {
    perFile: options.perFile,
    total: options.total,
    intro: options.intro,
    whole: (file) => whole.has(file.id),
    more: (file) => [notes.get(file.id) ?? "", whole.has(file.id) ? "" : (options.more?.(file) ?? "")].filter(Boolean).join("\n"),
  });
  const parts: ContentPart[] = [
    ...images.flatMap((image) => [{ type: "text" as const, text: `Picture: ${image.file.filename}` }, image.part]),
    ...documents.flatMap((document) => [{ type: "text" as const, text: `File: ${document.file.filename}` }, document.part]),
  ];
  return { text, parts, images, documents };
}

/** Text then pictures, as message content; the plain text when there are no pictures. */
export function withPictures(text: string, parts: ContentPart[]): string | ContentPart[] {
  return parts.length ? [{ type: "text", text }, ...parts] : text;
}

/**
 * Keeps the newest `keep` pictures and files in a running conversation, no more than `maxBytes` of
 * them, and turns older ones into a note, so a long run does not resend them on every turn. The
 * newest always stays.
 */
export function keepRecentAttachments<T extends { content?: unknown }>(messages: T[], keep = MODEL_KEEP_ATTACHMENTS, maxBytes = MODEL_KEEP_BYTES): void {
  let seen = 0;
  let chars = 0;
  const maxChars = Math.ceil(maxBytes / 3) * 4;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content;
    if (!Array.isArray(content)) continue;
    const parts = content as Array<Record<string, unknown>>;
    for (let part = parts.length - 1; part >= 0; part -= 1) {
      const kind = parts[part]?.type;
      if (kind !== "image_url" && kind !== "file") continue;
      seen += 1;
      const data = kind === "image_url" ? (parts[part]?.image_url as { url?: unknown } | undefined)?.url : (parts[part]?.file as { file_data?: unknown } | undefined)?.file_data;
      chars += typeof data === "string" ? data.length : 0;
      if (seen > 1 && (seen > keep || chars > maxChars)) {
        parts[part] = { type: "text", text: kind === "image_url" ? "(A picture shown earlier; open it again to look at it.)" : "(A file given earlier; open it again to read it.)" };
      }
    }
  }
}

/** Parts a tool opened, keeping only what the model reads now; a dropped part becomes a note. */
export function readableParts(parts: ContentPart[], images: boolean, documents: (filename: string) => boolean, textTool: string): ContentPart[] {
  return parts.map((part): ContentPart => {
    if (part.type === "image_url" && !images) return { type: "text", text: "(This model cannot see pictures, so this one was not shown. Say so rather than guess.)" };
    if (part.type === "file" && !documents(part.file.filename)) return { type: "text", text: `(This model cannot read “${part.file.filename}” whole; read its text with ${textTool}.)` };
    return part;
  });
}
