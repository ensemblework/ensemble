/**
 * Images placed in pages are ordinary Files rows (`saveFile`); the page's `image` node names the
 * file in `attrs.fileId`. This holds what the server enforces for them, whatever the client did:
 * the 2 MiB limit, the format and size read from the bytes (`checkPageImage` in shared-types), and
 * on page writes, no new `data:` image over the limit and no new image of a file that could not be
 * one. Docs: docs/32_FILES.md §6.
 */
import {
  PAGE_IMAGE_MAX_BYTES,
  PAGE_IMAGE_MAX_LABEL,
  PAGE_IMAGE_TYPES,
  checkPageImage,
  dataUrlBytes,
  pageImageTooLarge,
  type PageImageFormat,
} from "@ensemble/shared-types";
import type { Prisma, PrismaClient } from "@prisma/client";
import { FileError } from "./store.js";

/** A page write refused for an image it would add. */
export class PageImageError extends Error {
  readonly expose = true;
  readonly code = "PAGE_IMAGE_REFUSED";
  constructor(message: string, readonly statusCode: 413 | 415) {
    super(message);
  }
}

export type CheckedPageImage = { filename: string; mediaType: string; format: PageImageFormat; width: number; height: number };

/** A page-image upload as it will be kept, or a FileError saying why not. */
export function assertPageImage(filename: string, mediaType: string, bytes: Uint8Array): CheckedPageImage {
  const result = checkPageImage({ filename, mediaType, bytes, strict: true });
  if (!result.ok) throw new FileError(result.message, result.status);
  return { filename: result.filename, mediaType: result.mime, format: result.format, width: result.width, height: result.height };
}

type Found = { dataSources: Set<string>; fileIds: Set<string>; dataImages: Array<{ src: string; alt: string }> };

function imagesIn(content: unknown): Found {
  const found: Found = { dataSources: new Set(), fileIds: new Set(), dataImages: [] };
  const stack: unknown[] = [content];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    const { type, attrs, content: children } = node as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown };
    if (type === "image" && attrs) {
      if (typeof attrs.fileId === "string" && attrs.fileId) found.fileIds.add(attrs.fileId);
      if (typeof attrs.src === "string" && /^data:/i.test(attrs.src)) {
        found.dataSources.add(attrs.src);
        found.dataImages.push({ src: attrs.src, alt: typeof attrs.alt === "string" ? attrs.alt : "" });
      }
    }
    if (Array.isArray(children)) stack.push(...children);
  }
  return found;
}

const PAGE_IMAGE_EXTS = new Set(Object.values(PAGE_IMAGE_TYPES).flatMap((type) => [...type.exts]));

/**
 * Refuses images a write would add to a page: a `data:` image over 2 MiB, or an image of a file in
 * this space that is over 2 MiB or not a PNG, JPEG, GIF or WebP. Images the page already held (in
 * `previous`) are kept as they are, so old pages still save. A file id that is not in this space
 * is left alone: it shows as "Image unavailable" and gives nobody access to anything.
 */
export async function assertNewPageImages(db: PrismaClient | Prisma.TransactionClient, userId: string, next: unknown, previous: unknown): Promise<void> {
  const added = imagesIn(next);
  if (!added.fileIds.size && !added.dataImages.length) return;
  const before = imagesIn(previous);
  for (const image of added.dataImages) {
    if (before.dataSources.has(image.src)) continue;
    const bytes = dataUrlBytes(image.src) ?? 0;
    if (bytes > PAGE_IMAGE_MAX_BYTES) throw new PageImageError(pageImageTooLarge(image.alt.trim() || "This pasted image", bytes), 413);
  }
  const ids = [...added.fileIds].filter((id) => !before.fileIds.has(id));
  if (!ids.length) return;
  const rows = await db.document.findMany({ where: { userId, id: { in: ids } }, select: { id: true, filename: true, format: true, byteSize: true } });
  for (const row of rows) {
    const attach = `Attach it as a file instead: [@${row.filename}](ensemble://file/${row.id}).`;
    if (row.byteSize > PAGE_IMAGE_MAX_BYTES) {
      throw new PageImageError(`${row.filename} is ${(row.byteSize / (1024 * 1024)).toFixed(1)} MB, over the ${PAGE_IMAGE_MAX_LABEL} limit for images in pages. ${attach}`, 413);
    }
    if (!PAGE_IMAGE_EXTS.has(row.format)) throw new PageImageError(`${row.filename} isn't a PNG, JPEG, GIF or WebP image, so it can't show as an image in a page. ${attach}`, 415);
  }
}
