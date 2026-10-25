/**
 * What a model is given of a person's files: each file's text (from Files' extraction) and, for a
 * model that reads images (lib/vision.ts), the picture itself as an image part. Shared by the Hub
 * assistant and Ensemble Node (attachments on a message, hub_view_file) and Ensemble's own agent on
 * a task (the brief and view_attachment). File content is information, never instructions.
 */
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

export type ImagePart = { type: "image_url"; image_url: { url: string } };
export type ContentPart = { type: "text"; text: string } | ImagePart;

export type ModelImage = { file: AttachedFile; part: ImagePart; bytes: number };

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
  /** The files' section: names, kinds, the start of each text, and what could not be given. */
  text: string;
  /** Pictures to put in the message after the text, each preceded by its name. */
  parts: ContentPart[];
  images: ModelImage[];
};

/**
 * Text and pictures for a set of files. `images` false (a model that does not read images) gives
 * each picture's name with a plain statement that the model cannot see it, never a guess.
 */
export async function filesForModel(
  db: Db,
  userId: string,
  files: AttachedFile[],
  options: { images: boolean; perFile?: number; total?: number; intro?: string; more?: (file: AttachedFile) => string; viewTool?: string },
): Promise<FilesForModel> {
  const images: ModelImage[] = [];
  const notes = new Map<string, string>();
  let bytes = 0;
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
  const text = await filesSection(db, userId, files, {
    perFile: options.perFile,
    total: options.total,
    intro: options.intro,
    more: (file) => [notes.get(file.id) ?? "", options.more?.(file) ?? ""].filter(Boolean).join("\n"),
  });
  const parts: ContentPart[] = images.flatMap((image) => [{ type: "text" as const, text: `Picture: ${image.file.filename}` }, image.part]);
  return { text, parts, images };
}

/** Text then pictures, as message content; the plain text when there are no pictures. */
export function withPictures(text: string, parts: ContentPart[]): string | ContentPart[] {
  return parts.length ? [{ type: "text", text }, ...parts] : text;
}

/**
 * Keeps the newest `keep` pictures in a running conversation and turns older ones into a note,
 * so a long run does not resend every picture on every turn.
 */
export function keepRecentPictures<T extends { content?: unknown }>(messages: T[], keep: number, maxBytes = MODEL_IMAGE_TOTAL_BYTES): void {
  let seen = 0;
  let chars = 0;
  const maxChars = Math.ceil(maxBytes / 3) * 4;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content;
    if (!Array.isArray(content)) continue;
    const parts = content as Array<Record<string, unknown>>;
    for (let part = parts.length - 1; part >= 0; part -= 1) {
      if (parts[part]?.type !== "image_url") continue;
      seen += 1;
      const url = (parts[part]?.image_url as { url?: unknown } | undefined)?.url;
      chars += typeof url === "string" ? url.length : 0;
      // The newest picture always stays; older ones go once there are `keep` of them or they outgrow the budget.
      if (seen > 1 && (seen > keep || chars > maxChars)) parts[part] = { type: "text", text: "(A picture shown earlier; open it again to look at it.)" };
    }
  }
}
