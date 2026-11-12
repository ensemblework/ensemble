/**
 * A file from Ensemble as MCP content (ensemble_get_file, docs/CONTEXT_BRIDGE.md §5): a picture as an
 * `image` block, a text file as text, any other file (PDF, Word, PowerPoint, Excel…) as an embedded
 * resource, and, on the editor's own computer, the original saved into the working folder (`saveTo`).
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Pictures a model reads as an image block, up to this size; a larger one comes as a resource. */
export const IMAGE_INLINE_MAX = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** A text file goes as text up to this many characters; past that, read it in parts or save it. */
export const TEXT_INLINE_MAX = 200_000;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A file's id from its id, `ensemble://file/<id>`, or a Hub link (`/files/<id>`). */
export function fileIdOf(value: string): string | null {
  const text = value.trim();
  const found = /^ensemble:\/\/(?:file|document)\/([0-9a-f-]{36})/i.exec(text) ?? /(?:^|\/)files\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(text) ?? (/^[0-9a-f-]{36}$/i.test(text) ? [text, text] : null);
  const id = found?.[1];
  return id && UUID.test(id) ? id.toLowerCase() : null;
}

export interface FileAnswer {
  file: Record<string, unknown> & { id: string; filename: string; mediaType?: string; textual?: boolean; byteSize?: number };
  text?: Record<string, unknown>;
  original?: { base64?: string; mediaType?: string; byteSize?: number; omitted?: boolean; note?: string };
  notes?: string;
}

type Block = CallToolResult["content"][number];

/** The answer of GET /api/bridge/files/:id as MCP content: the details as JSON, then the file itself. */
export function fileContent(answer: FileAnswer): CallToolResult {
  const { original, ...rest } = answer;
  const blocks: Block[] = [];
  let sent: Record<string, unknown> | undefined;
  if (original?.base64) {
    const mediaType = original.mediaType ?? answer.file.mediaType ?? "application/octet-stream";
    const size = original.byteSize ?? Buffer.byteLength(original.base64, "base64");
    if (IMAGE_TYPES.has(mediaType) && size <= IMAGE_INLINE_MAX) {
      blocks.push({ type: "image", data: original.base64, mimeType: mediaType });
      sent = { mediaType, byteSize: size, as: "image" };
    } else if (answer.file.textual) {
      const text = Buffer.from(original.base64, "base64").toString("utf8");
      if (text.length <= TEXT_INLINE_MAX) {
        blocks.push({ type: "text", text });
        sent = { mediaType, byteSize: size, as: "text" };
      } else {
        sent = { mediaType, byteSize: size, as: "none", note: `It is ${text.length} characters, too long to send at once: read it in parts with text (offset, limit), or save it with saveTo through the Ensemble CLI's MCP server.` };
      }
    } else {
      blocks.push({ type: "resource", resource: { uri: `ensemble://file/${answer.file.id}`, mimeType: mediaType, blob: original.base64 } });
      sent = { mediaType, byteSize: size, as: "resource" };
    }
  } else if (original) {
    sent = { as: "none", ...(original.note ? { note: original.note } : {}) };
  }
  const details: Record<string, unknown> = { ...rest, ...(sent ? { original: sent } : {}) };
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }, ...blocks],
    structuredContent: details,
  };
}

const fail = (message: string) => new Error(message);

/**
 * Where `saveTo` writes: a path inside the working folder (relative, or absolute under it), never
 * through `..`, never through or onto a symbolic link, and onto an existing file only with overwrite.
 */
export async function savePath(cwd: string, wanted: string, overwrite: boolean): Promise<{ root: string; target: string; rel: string }> {
  const raw = wanted.trim();
  if (!raw) throw fail("saveTo is empty: name a file inside the working folder.");
  if (raw.split(/[\\/]+/).includes("..")) throw fail("saveTo cannot use ..: name a path inside the working folder.");
  const root = await realpath(cwd);
  // An absolute path may name the working folder as it was opened, before links in it were resolved.
  const rel = [root, resolvePath(cwd)].map((base) => relative(base, resolvePath(base, raw))).find((candidate) => candidate && !candidate.startsWith("..") && !isAbsolute(candidate));
  if (!rel) throw fail(`saveTo must name a file inside the working folder (${root}).`);
  const target = join(root, rel);
  let at = root;
  for (const part of rel.split(sep).slice(0, -1)) {
    at = join(at, part);
    const info = await lstat(at).catch(() => null);
    if (!info) break;
    if (info.isSymbolicLink()) throw fail(`${relative(root, at)} is a symbolic link; saveTo does not follow links.`);
    if (!info.isDirectory()) throw fail(`${relative(root, at)} is not a folder.`);
  }
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink()) throw fail(`${rel} is a symbolic link; saveTo does not follow links.`);
  if (existing?.isDirectory()) throw fail(`${rel} is a folder: name a file.`);
  if (existing && !overwrite) throw fail(`${rel} already exists: pass overwrite: true to replace it.`);
  return { root, target, rel };
}

const NO_FOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** Writes the bytes at a path savePath checked, creating its folders; the final file is never followed through a link. */
export async function writeSaved(root: string, target: string, bytes: Uint8Array, overwrite: boolean): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const folder = relative(root, await realpath(dirname(target)));
  if (folder.startsWith("..") || isAbsolute(folder)) throw fail("saveTo must name a file inside the working folder.");
  const flags = constants.O_WRONLY | constants.O_CREAT | (overwrite ? constants.O_TRUNC : constants.O_EXCL) | NO_FOLLOW;
  let handle;
  try {
    handle = await open(target, flags, 0o644);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EEXIST") throw fail(`${relative(root, target)} already exists: pass overwrite: true to replace it.`);
    if (code === "ELOOP") throw fail(`${relative(root, target)} is a symbolic link; saveTo does not follow links.`);
    throw error;
  }
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}
