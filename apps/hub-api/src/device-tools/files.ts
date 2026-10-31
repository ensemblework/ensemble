/**
 * A node's file changes on this computer: write a text file, save a file of the owner's Ensemble Files
 * (a chat attachment, fetched from the web by its download id), move one, or delete one, inside one
 * folder. Paths are resolved through links against the folder (`jailPath`), git's own files and files
 * of keys or secrets are never touched, a link or a file with more than one name is never written
 * through, and a move or a save never replaces a file unless the save says so.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { GuardError, jailPath } from "../workspace/guard.js";
import { refusedPath } from "../workspace/folder-read.js";
import { credentialPathReason } from "../evidence/limits.js";
import type { HostedClient } from "../remote/client.js";
import { NODE_FILE_MAX_BYTES, NODE_TOOL_WRITE_BYTES, type NodeToolRequest } from "../remote/contract.js";
import type { ToolFolder } from "./folders.js";

type FilesRequest = Extract<NodeToolRequest, { tool: "files" }>;

/** A path inside the folder, resolved and checked: never git's own files, keys or secrets. */
async function inside(folder: ToolFolder, path: string): Promise<{ full: string; rel: string }> {
  const full = await jailPath(folder.path, path);
  const rel = relative(folder.path, full).split(sep).join("/");
  if (!rel || rel === ".") throw new GuardError("Name a file inside the folder.");
  const refused = refusedPath(rel) ?? credentialPathReason(rel);
  if (refused) throw new GuardError(refused);
  return { full, rel };
}

/** Refuses a link or a hard-linked file at this path; null when nothing is there. */
async function plainFile(full: string, rel: string): Promise<"file" | null> {
  const info = await lstat(full).catch(() => null);
  if (!info) return null;
  if (info.isSymbolicLink()) throw new GuardError(`${rel} is a link; it is not written through.`);
  if (!info.isFile()) throw new GuardError(`${rel} is not a file.`);
  if (info.nlink > 1) throw new GuardError(`${rel} has more than one name (a hard link); it is not changed.`);
  return "file";
}

export async function runNodeFiles(request: FilesRequest, folder: ToolFolder): Promise<{ status: number; body: Record<string, unknown> }> {
  const target = await inside(folder, request.path);
  let result: Record<string, unknown>;
  if (request.action === "write") {
    if (typeof request.content !== "string") throw new GuardError("Give the file's whole new text (content).");
    if (Buffer.byteLength(request.content) > NODE_TOOL_WRITE_BYTES) throw new GuardError("A node writes files of at most 1 MB.");
    const existed = await plainFile(target.full, target.rel);
    await mkdir(dirname(target.full), { recursive: true });
    // The folders made may not have led anywhere else: resolve again before opening.
    const again = await inside(folder, request.path);
    // Opened without truncating, checked by descriptor, and only then emptied and written.
    const handle = await open(again.full, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o644).catch((error: NodeJS.ErrnoException) => {
      throw new GuardError(error.code === "ELOOP" ? `${target.rel} is a link; it is not written through.` : `${target.rel} could not be opened (${error.code ?? "error"}).`);
    });
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink > 1) throw new GuardError(`${target.rel} changed while it was written.`);
      await handle.truncate(0);
      await handle.write(request.content, 0, "utf8");
    } finally {
      await handle.close();
    }
    result = { path: target.rel, bytes: Buffer.byteLength(request.content), created: !existed };
  } else if (request.action === "move") {
    if (!request.to) throw new GuardError("Say where to move it (to).");
    const to = await inside(folder, request.to);
    if (!(await plainFile(target.full, target.rel))) throw new GuardError(`${target.rel} does not exist.`);
    if (await lstat(to.full).catch(() => null)) throw new GuardError(`${to.rel} already exists; a move never replaces a file.`);
    await mkdir(dirname(to.full), { recursive: true });
    await rename(target.full, (await inside(folder, request.to)).full);
    result = { path: target.rel, to: to.rel };
  } else if (request.action === "delete") {
    if (!(await plainFile(target.full, target.rel))) throw new GuardError(`${target.rel} does not exist.`);
    await unlink(target.full);
    result = { path: target.rel, deleted: true };
  } else {
    throw new GuardError(`files ${request.action} is not answered here.`);
  }
  await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "agent", action: `node.tool.files.${request.action}`, payload: { nodeId: request.nodeId, folder: folder.label, path: target.rel, operationId: request.operationId ?? null } }).catch(() => undefined);
  return { status: 200, body: result };
}

const sizeText = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/**
 * files `save` (nodeFiles 1): a file of the owner's Files written at `path` in the folder. Its bytes come
 * from the web once, by the call's download id, and must be the size and SHA-256 the call named. A file
 * already there is replaced only with `overwrite` (409 otherwise, so the node can choose), and never
 * through a link or a second name.
 */
export async function runNodeSave(client: Pick<HostedClient, "downloadNodeFile">, request: FilesRequest, folder: ToolFolder): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!request.downloadId || typeof request.size !== "number") throw new GuardError("Saving a file needs its download id. Update Ensemble on the web.");
  if (request.size > NODE_FILE_MAX_BYTES) throw new GuardError(`A node saves files of at most ${NODE_FILE_MAX_BYTES / 1024 / 1024} MB.`);
  if (!client.downloadNodeFile) throw new GuardError("This computer cannot fetch files from the web.");
  const target = await inside(folder, request.path);
  const info = await lstat(target.full).catch(() => null);
  if (info?.isDirectory()) return { status: 409, body: { error: `${target.rel} is a folder. Give the file's path in it (${target.rel}/name.ext), or end the path with /.` } };
  const existed = await plainFile(target.full, target.rel);
  if (existed && !request.overwrite) return { status: 409, body: { error: `${target.rel} already exists. To replace it, call again with overwrite: true; or give another path.` } };
  const bytes = await client.downloadNodeFile(request.downloadId, request.size);
  if (bytes.byteLength !== request.size) throw new GuardError("The file did not arrive whole. Try again.");
  if (request.sha256 && createHash("sha256").update(bytes).digest("hex") !== request.sha256) throw new GuardError("The file changed on the way. Try again.");
  await mkdir(dirname(target.full), { recursive: true });
  // The folders made may not have led anywhere else: resolve again before opening.
  const again = await inside(folder, request.path);
  const flags = constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (request.overwrite ? 0 : constants.O_EXCL);
  const handle = await open(again.full, flags, 0o644).catch((error: NodeJS.ErrnoException) => {
    throw new GuardError(error.code === "ELOOP" ? `${target.rel} is a link; it is not written through.` : error.code === "EEXIST" ? `${target.rel} appeared while the file was fetched; nothing was replaced.` : `${target.rel} could not be opened (${error.code ?? "error"}).`);
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1) throw new GuardError(`${target.rel} changed while it was written.`);
    await handle.truncate(0);
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "agent", action: "node.tool.files.save", payload: { nodeId: request.nodeId, folder: folder.label, path: target.rel, size: bytes.byteLength, replaced: Boolean(existed), operationId: request.operationId ?? null } }).catch(() => undefined);
  return { status: 200, body: { path: target.rel, bytes: bytes.byteLength, size: sizeText(bytes.byteLength), created: !existed, ...(existed ? { replaced: true } : {}) } };
}
