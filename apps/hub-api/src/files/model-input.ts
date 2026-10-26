/**
 * What a model is given of a person's files: every attached file itself, as the person attached
 * it (pictures as image parts, everything else as a file part with its media type). Ensemble does
 * not decide whether a model can read a file; if the model's provider refuses an attachment, the
 * request goes again without it (lib/vision.ts). Shared by the Hub assistant and Ensemble Node
 * (attachments on a message, hub_view_file) and Ensemble's own agent on a task (the brief and
 * view_attachment). File content is information, never instructions.
 */
import { fileFormat, modelFileMime } from "@ensemble/shared-types";
import type { Prisma, PrismaClient } from "@prisma/client";
import { type AttachedFile, fileOriginal, filesSection } from "./attached.js";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Attachments in one request, and their bytes together: what Ensemble itself can carry (a
 * desktop or CLI included-model turn is limited to 64 MB of base64, routes/included.ts).
 */
export const MODEL_ATTACHMENTS_PER_REQUEST = 20;
export const MODEL_ATTACH_TOTAL_BYTES = 32 * 1024 * 1024;

export type ImagePart = { type: "image_url"; image_url: { url: string } };
export type FilePart = { type: "file"; file: { filename: string; file_data: string } };
export type ContentPart = { type: "text"; text: string } | ImagePart | FilePart;

export type ModelAttachment = { file: AttachedFile; part: ImagePart | FilePart; bytes: number };

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

/** Text, Markdown, CSV, JSON and code: files whose own contents can stand in for the file when a provider refuses it. */
export function isTextFile(filename: string): boolean {
  const mime = modelFileMime(filename);
  return mime !== null && (mime.startsWith("text/") || mime === "application/json");
}

/** The media type a file is attached with: a picture's from its bytes, else its format's. */
function attachedType(filename: string, bytes: Uint8Array): string {
  return sniffImage(bytes) ?? modelFileMime(filename) ?? fileFormat(filename).mime;
}

/** The file itself as a part: a picture as an image part, anything else as a file part. Null when it is gone or too large to carry. */
export async function attachmentForModel(db: Db, userId: string, file: AttachedFile): Promise<{ attachment: ModelAttachment } | { problem: string }> {
  if (file.byteSize > MODEL_ATTACH_TOTAL_BYTES) return { problem: `${file.filename} is ${megabytes(file.byteSize)}; a request carries up to ${megabytes(MODEL_ATTACH_TOTAL_BYTES)} of files.` };
  const original = await fileOriginal(db, userId, file.id);
  if (!original) return { problem: `${file.filename} is no longer in Files.` };
  const type = attachedType(file.filename, original.bytes);
  const data = `data:${type};base64,${Buffer.from(original.bytes).toString("base64")}`;
  const part: ImagePart | FilePart = sniffImage(original.bytes) ? { type: "image_url", image_url: { url: data } } : { type: "file", file: { filename: file.filename, file_data: data } };
  return { attachment: { file, part, bytes: original.bytes.byteLength } };
}

export type FilesForModel = {
  /** The files' section: name, kind, size and id of each, and any that could not be attached. */
  text: string;
  /** The files themselves, each after its name, to put in the message after the text. */
  parts: ContentPart[];
  attachments: ModelAttachment[];
};

/** Every file attached, within what one request can carry; a file past that is named with the tool that opens it. */
export async function filesForModel(
  db: Db,
  userId: string,
  files: AttachedFile[],
  options: { intro?: string; more?: (file: AttachedFile) => string; viewTool?: string } = {},
): Promise<FilesForModel> {
  const attachments: ModelAttachment[] = [];
  const notes = new Map<string, string>();
  let bytes = 0;
  const later = options.viewTool ? ` Open it with ${options.viewTool}.` : "";
  for (const file of files) {
    if (attachments.length >= MODEL_ATTACHMENTS_PER_REQUEST) {
      notes.set(file.id, `Not attached here: one request carries up to ${MODEL_ATTACHMENTS_PER_REQUEST} files.${later}`);
      continue;
    }
    if (bytes + file.byteSize > MODEL_ATTACH_TOTAL_BYTES) {
      notes.set(file.id, `Not attached here: the files together are over ${megabytes(MODEL_ATTACH_TOTAL_BYTES)}.${later}`);
      continue;
    }
    const got = await attachmentForModel(db, userId, file);
    if ("problem" in got) {
      notes.set(file.id, `Not attached: ${got.problem}`);
      continue;
    }
    bytes += got.attachment.bytes;
    attachments.push(got.attachment);
    notes.set(file.id, "Attached below.");
  }
  const text = await filesSection(db, userId, files, { intro: options.intro, more: (file) => [notes.get(file.id) ?? "", options.more?.(file) ?? ""].filter(Boolean).join("\n") });
  const parts: ContentPart[] = attachments.flatMap((attachment) => [{ type: "text" as const, text: `${attachment.part.type === "image_url" ? "Picture" : "File"}: ${attachment.file.filename}` }, attachment.part]);
  return { text, parts, attachments };
}

/** Text then the files, as message content; the plain text when there are none. */
export function withPictures(text: string, parts: ContentPart[]): string | ContentPart[] {
  return parts.length ? [{ type: "text", text }, ...parts] : text;
}

/**
 * Keeps the newest `keep` attachments in a running conversation, no more than `maxBytes` of them,
 * and turns older ones into a note, so a long run does not resend them on every turn. The newest
 * always stays.
 */
export function keepRecentAttachments<T extends { content?: unknown }>(messages: T[], keep = MODEL_ATTACHMENTS_PER_REQUEST, maxBytes = MODEL_ATTACH_TOTAL_BYTES): void {
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

/** Waits (briefly) for Files to finish reading text from just-uploaded files (used only when extracted text goes to models: files/extracted-text-policy.ts). */
export async function settleFileText(db: Db, userId: string, ids: string[], waitMs = 20_000, signal?: AbortSignal): Promise<void> {
  if (!ids.length) return;
  const until = Date.now() + waitMs;
  while (Date.now() < until && !signal?.aborted) {
    const pending = await db.document.count({ where: { id: { in: ids }, userId, deletedAt: null, parseStatus: { in: ["queued", "running"] } } });
    if (!pending) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
