/**
 * A file's original over HTTP, for Files (`GET /api/documents/:id/original`) and editors' keys
 * (`GET /api/bridge/files/:id/original`): the bytes as an inert attachment, with an ETag and byte ranges.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { fileFormat } from "@ensemble/shared-types";
import { ORIGINAL_SELECT, originalBytes } from "./originals.js";

/** `attachment` with an ASCII name for old clients and the real one (RFC 5987) for the rest. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return false;
  return value.split(",").some((part) => {
    const tag = part.trim().replace(/^W\//, "");
    return tag === "*" || tag === etag;
  });
}

/** The media type a file's original is served as: its format's own, or a plain download. */
export function servedMediaType(filename: string): string {
  const format = fileFormat(filename);
  return format.kind === "other" ? "application/octet-stream" : format.mime;
}

/** Sends one file's original from `userId`'s Files; 404 with `missing` when it is not there or is in Trash. */
export async function sendOriginal(db: PrismaClient, request: FastifyRequest, reply: FastifyReply, userId: string, id: string, missing: string): Promise<FastifyReply> {
  const owned = { id, userId, deletedAt: null };
  const head = await db.document.findFirst({ where: owned, select: { filename: true, sha256: true } });
  if (!head) return reply.code(404).send({ error: missing });
  const etag = `"${head.sha256}"`;
  reply
    .header("ETag", etag)
    .header("Cache-Control", "private, no-cache")
    .header("X-Content-Type-Options", "nosniff")
    // Opened directly, an SVG or HTML file stays inert: no scripts, no requests.
    .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    .header("Accept-Ranges", "bytes");
  if (etagMatches(request.headers["if-none-match"], etag)) return reply.code(304).send();
  const row = await db.document.findFirst({ where: owned, select: ORIGINAL_SELECT });
  if (!row) return reply.code(404).send({ error: missing });
  const bytes = await originalBytes(row);
  reply.header("Content-Type", servedMediaType(head.filename)).header("Content-Disposition", contentDisposition(head.filename));
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? "").trim());
  if (range && (range[1] || range[2])) {
    const size = bytes.byteLength;
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return reply.code(416).header("Content-Range", `bytes */${size}`).send();
    return reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`).send(bytes.subarray(start, end + 1));
  }
  return reply.send(bytes);
}
