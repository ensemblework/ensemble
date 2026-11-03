import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { decode, encode, hashOf } from "../lib/code-versions.js";
import { redactKeys } from "../lib/redact.js";
import { readEvidenceFile } from "../evidence/files.js";
import { archiveProblem } from "../device-tools/zip.js";
import { resolveToolFolder, type ToolFolder } from "../device-tools/folders.js";
import { GuardError, jailPath, within, workspaceRoot } from "../workspace/guard.js";
import { listedChanges, outsideListing, refusedPath } from "../workspace/folder-read.js";
import { credentialPathReason } from "../evidence/limits.js";
import { savedSecretValues } from "../lib/run-secrets.js";
import { env } from "../config.js";
import { CODE_ANSWER_BYTES, CODE_EDIT_BYTES, NODE_FILE_MAX_BYTES, type CodeAnswer, type CodeRequest } from "./contract.js";
import { loadHeld, loadSettings, stateDir } from "./store.js";
import { RemoteError, type HostedClient } from "./client.js";

export const OriginalFile = z.object({
  fileId: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().min(1).max(4096),
  folder: z.string().max(4096),
  deleted: z.boolean().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type OriginalFile = z.infer<typeof OriginalFile>;
export const FileChangeReport = z.object({ turnId: z.string().uuid(), nodeId: z.string().uuid(), files: z.array(OriginalFile).min(1).max(500) });
export type FileChangeReport = z.infer<typeof FileChangeReport>;

const Registry = z.object({
  files: z.record(z.object({ root: z.string(), path: z.string() })),
  pending: z.record(FileChangeReport),
});
type Registry = z.infer<typeof Registry>;
let cached: { path: string; value: Registry } | null = null;
function registry(): Registry {
  const path = join(stateDir(), "node-file-sources.json");
  if (cached?.path === path) return cached.value;
  const value = existsSync(path) ? Registry.parse(JSON.parse(readFileSync(path, "utf8"))) : { files: {}, pending: {} };
  cached = { path, value };
  return value;
}
function persist(): void {
  const value = registry();
  const path = join(stateDir(), "node-file-sources.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}
function registerOriginal(folder: ToolFolder, path: string, deleted = false): OriginalFile {
  const fileId = createHash("sha256").update(resolve(folder.path, path)).digest("hex");
  const data = registry();
  if (!data.files[fileId]) data.files[fileId] = { root: folder.path, path };
  return { fileId, path, folder: folder.label, updatedAt: new Date().toISOString(), ...(deleted ? { deleted: true } : {}) };
}
export async function changedFileIdentity(root: string, paths: string[], path: string): Promise<{ fileId: string; modifiedAt: string } | null> {
  try {
    const { changedFileLocation } = await import("../workspace/folder-read.js");
    const target = await changedFileLocation(root, paths, path);
    if (refusedPath(target.path) || credentialPathReason(target.path)) return null;
    const full = await jailPath(target.root, target.path);
    if (full !== resolve(target.root, target.path)) return null;
    const info = await lstat(full);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) return null;
    return { fileId: createHash("sha256").update(full).digest("hex"), modifiedAt: info.mtime.toISOString() };
  } catch (error) {
    if (error instanceof GuardError || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export function originalFile(folder: ToolFolder, path: string, deleted = false): OriginalFile {
  const file = registerOriginal(folder, path, deleted);
  persist();
  return file;
}
let flushing = false;
export async function flushFileChanges(client: Pick<HostedClient, "reportFileChanges">): Promise<void> {
  if (flushing || !client.reportFileChanges) return;
  flushing = true;
  try {
    while (Object.keys(registry().pending).length) for (const [id, report] of Object.entries(registry().pending)) {
      try { await client.reportFileChanges(report); }
      catch (error) {
        if (!(error instanceof RemoteError) || ![404, 410].includes(error.status)) throw error;
        console.warn("An original-file report belongs to a node turn that no longer exists.", report.turnId);
      }
      if (registry().pending[id] === report) { delete registry().pending[id]; persist(); }
    }
  } finally { flushing = false; }
}
export async function reportChangedPaths(client: Pick<HostedClient, "reportFileChanges">, request: { nodeId: string; operationId?: string }, folder: ToolFolder, paths: readonly string[]): Promise<void> {
  const turnId = request.operationId?.split(":")[0];
  if (!turnId || !z.string().uuid().safeParse(turnId).success) return;
  const files: OriginalFile[] = [];
  for (const named of new Set(paths)) {
    const path = named.split(sep).join("/");
    if (!path || refusedPath(path) || credentialPathReason(path)) continue;
    try {
      const full = await jailPath(folder.path, path, false);
      if (full !== resolve(folder.path, path)) continue;
      const info = await lstat(full).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)) continue;
      files.push(registerOriginal(folder, path, !info));
    } catch (error) {
      if (error instanceof GuardError) continue;
      throw error;
    }
  }
  if (!files.length) return;
  let batch: OriginalFile[] = [], size = 0;
  const queue = () => { if (batch.length) registry().pending[randomUUID()] = { turnId, nodeId: request.nodeId, files: batch }; batch = []; size = 0; };
  for (const file of files) {
    const bytes = Buffer.byteLength(JSON.stringify(file)) + 1;
    if (batch.length === 500 || size + bytes > 512 * 1024) queue();
    batch.push(file); size += bytes;
  }
  queue();
  persist();
  await flushFileChanges(client);
}

const ReadQuery = z.object({
  fileId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  jobId: z.string().uuid().optional(),
  path: z.string().max(4096).optional(),
  mode: z.enum(["read", "download", "chunk", "release"]).default("read"),
  token: z.string().uuid().optional(),
  offset: z.coerce.number().int().min(0).default(0),
});
type SourceQuery = z.infer<typeof ReadQuery>;
async function location(app: Pick<FastifyInstance, "prisma">, input: SourceQuery): Promise<{ folder: ToolFolder; path: string; full: string }> {
  let folder: ToolFolder;
  let path: string;
  if (input.fileId) {
    const source = registry().files[input.fileId];
    if (!source) throw Object.assign(new Error("This original file is not recorded on this computer."), { statusCode: 404 });
    folder = await resolveToolFolder(source.root);
    if (folder.path !== source.root) throw new GuardError("The original folder now leads somewhere else.");
    path = source.path;
  } else {
    const held = input.jobId ? loadHeld()[input.jobId] : undefined;
    const job = held?.localJobId ? await app.prisma.workspaceJob.findUnique({ where: { id: held.localJobId }, select: { externalRoot: true, repoPath: true, evidence: true } }) : input.jobId ? await app.prisma.workspaceJob.findFirst({ where: { id: input.jobId, userId: env.ENSEMBLE_DEV_USER_ID }, select: { externalRoot: true, repoPath: true, evidence: true } }) : null;
    if (!job || !input.path || !listedChanges(job.evidence).includes(input.path)) throw new GuardError("That file is not one this run changed.");
    const namedRoot = resolve(job.externalRoot || job.repoPath);
    const root = await realpath(namedRoot);
    if (root !== namedRoot) throw new GuardError("The original run folder now leads somewhere else.");
    if (!within(await workspaceRoot(), root)) {
      const shared = await Promise.all(loadSettings().folders.map(item => realpath(item.path).catch((error: NodeJS.ErrnoException) => {
        if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code ?? "")) return null;
        throw error;
      })));
      if (!shared.some(parent => parent && within(parent, root))) throw new GuardError("This run's folder is no longer shared.");
    }
    folder = await resolveToolFolder(root);
    path = input.path;
    if (outsideListing(path)) {
      const named = path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
      if (await realpath(named) !== named) throw new GuardError("A linked original cannot be edited from the web.");
      const { changedFileLocation } = await import("../workspace/folder-read.js");
      const other = await changedFileLocation(root, listedChanges(job.evidence), path);
      folder = await resolveToolFolder(other.root);
      path = other.path;
    }
  }
  const refusal = refusedPath(path) ?? credentialPathReason(path);
  if (refusal) throw new GuardError(refusal);
  const named = resolve(folder.path, path);
  const full = await jailPath(folder.path, path);
  if (named !== full || !within(folder.path, full, false)) throw new GuardError("A linked file cannot be edited from the web.");
  return { folder, path, full };
}
const BINARY = /\.(?:pdf|docx?|xlsx?|pptx?|zip|gz|tar|7z|png|jpe?g|gif|webp|avif|bmp|heic|mp[34]|wav|ogg|webm|mov|woff2?|ttf|exe|bin)$/i;
const KEY_REASON = "This file contains a key or secret. Edit it on the computer; the hidden text cannot be saved back.";
async function openedFile(full: string, write: boolean) {
  const before = await lstat(full);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1) throw new GuardError("Only a regular file with one name can be opened.");
  const handle = await open(full, (write ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const info = await handle.stat();
  if (!info.isFile() || info.nlink > 1 || info.ino !== before.ino || info.dev !== before.dev || await realpath(full) !== full) { await handle.close(); throw new GuardError("The file changed while it was opened. Try again."); }
  return { handle, info };
}
async function readBytes(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let at = 0;
  while (at < size) {
    const read = await handle.read(bytes, at, size - at, at);
    if (!read.bytesRead) break;
    at += read.bytesRead;
  }
  return bytes.subarray(0, at);
}
const writes = new Map<string, Promise<void>>();
const downloads = new Map<string, { bytes: Buffer; mime: string; name: string; source: string; timer: ReturnType<typeof setTimeout> }>();
function forgetDownload(token: string) { const entry = downloads.get(token); if (entry) clearTimeout(entry.timer); downloads.delete(token); }
function touchDownload(token: string) {
  const entry = downloads.get(token)!;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => forgetDownload(token), 120_000);
  entry.timer.unref();
}

export async function nodeFileAnswer(app: Pick<FastifyInstance, "prisma">, request: CodeRequest): Promise<CodeAnswer> {
  try {
    const settings = loadSettings();
    if (!settings.browseFiles) return { status: 409, body: { error: "Showing files on the web is off. Run `ensemble browse on` on this computer." } };
    const input = ReadQuery.parse(request.method === "PUT" ? request.body : request.query);
    const source = input.fileId ?? `${input.jobId}:${input.path}`;
    if (input.mode === "chunk" || input.mode === "release") {
      const entry = input.token ? downloads.get(input.token) : undefined;
      if (!entry || entry.source !== source) return { status: 410, body: { error: "The download expired. Start it again." } };
      if (input.mode === "release") { forgetDownload(input.token!); return { status: 200, body: { ok: true } }; }
      touchDownload(input.token!);
      return { status: 200, body: { data: entry.bytes.subarray(input.offset, input.offset + 256 * 1024).toString("base64"), size: entry.bytes.length } };
    }
    const target = await location(app, input);
    const secrets = (await savedSecretValues(app.prisma, env.ENSEMBLE_DEV_USER_ID)).filter(value => value.length >= 6);
    if (input.mode === "download") {
      const checked = await readEvidenceFile(target.full, { kind: "file", secrets, limit: NODE_FILE_MAX_BYTES });
      if (redactKeys(checked.bytes.toString("utf8")) !== checked.bytes.toString("utf8")) throw new GuardError(KEY_REASON);
      const problem = archiveProblem(checked.bytes, checked.mime, secrets);
      if (problem) throw new GuardError(problem);
      const total = [...downloads.values()].reduce((sum, item) => sum + item.bytes.length, 0);
      if (total + checked.size > NODE_FILE_MAX_BYTES * 2) return { status: 429, body: { error: "Other downloads are still using this computer's file buffer. Finish one, then retry." } };
      const token = randomUUID();
      const timer = setTimeout(() => forgetDownload(token), 120_000); timer.unref();
      downloads.set(token, { bytes: checked.bytes, mime: checked.mime, name: checked.name, source, timer });
      return { status: 200, body: { token, size: checked.size, mime: checked.mime, name: checked.name } };
    }
    let release: (() => void) | undefined;
    let lock: Promise<void> | undefined;
    if (request.method === "PUT") {
      if (!settings.webEdit) return { status: 409, body: { error: "Editing from the web is off. Run `ensemble web edit on` on this computer." } };
      const previous = writes.get(target.full);
      lock = new Promise<void>(resolve => { release = resolve; });
      writes.set(target.full, lock);
      await previous;
    }
    try {
      const { handle, info } = await openedFile(target.full, request.method === "PUT");
      try {
        const bytes = await readBytes(handle, Math.min(info.size, CODE_EDIT_BYTES));
        const truncated = info.size > CODE_EDIT_BYTES;
        let textBytes = bytes;
        let validUtf8 = true;
        try { textBytes = Buffer.from(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated })); } catch { validUtf8 = false; }
        const decoded = decode(textBytes)!;
        const binary = decoded.binary || BINARY.test(target.path) || !validUtf8;
        const content = binary ? null : secrets.reduce((text, value) => text.split(value).join("[redacted]"), redactKeys(decoded.text));
        const hidden = content !== null && content !== decoded.text;
        const hash = truncated ? null : hashOf(bytes);
        const readOnly = binary ? "This format is previewed or downloaded, not edited as text." : hidden ? KEY_REASON : truncated ? "This file is larger than the web editor's 1 MB buffer. Download it or open it on the computer." : !settings.webEdit ? "Editing from the web is off on this computer." : null;
        if (request.method === "GET") {
          const answer = { status: 200, body: { path: target.path, name: basename(target.path), location: target.full, fileId: createHash("sha256").update(target.full).digest("hex"), modifiedAt: info.mtime.toISOString(), content, hash, size: info.size, binary, truncated, readOnly, eol: decoded.eol, bom: decoded.bom } };
          return Buffer.byteLength(JSON.stringify(answer)) <= CODE_ANSWER_BYTES ? answer : { status: 413, body: { error: "This file's text exceeds the web relay buffer. Download the original to open it on your computer." } };
        }
        const body = z.object({ content: z.string(), expectedHash: z.string().regex(/^[a-f0-9]{40}$/) }).parse(request.body);
        if (readOnly || /\[redacted(?: private key)?\]/.test(body.content) || redactKeys(body.content) !== body.content || secrets.some(value => body.content.includes(value))) throw new GuardError(readOnly ?? KEY_REASON);
        if (Buffer.byteLength(body.content) > CODE_EDIT_BYTES) return { status: 413, body: { error: "This file is larger than the web editor's 1 MB buffer." } };
        if (hash !== body.expectedHash) return { status: 409, body: { error: "The file changed on the computer. Compare the latest version before saving.", code: "FILE_CONFLICT", hash } };
        const next = encode(body.content, decoded);
        if (next.length > CODE_EDIT_BYTES) return { status: 413, body: { error: "The saved file, including its line endings, would exceed the editor's 1 MB buffer." } };
        const current = await lstat(target.full);
        if (current.ino !== info.ino || current.dev !== info.dev || current.nlink !== 1 || await realpath(target.full) !== target.full || hashOf(await readBytes(handle, Math.min(current.size, CODE_EDIT_BYTES + 1))) !== body.expectedHash) {
          return { status: 409, body: { error: "The file changed during saving. Your draft is retained.", code: "FILE_CONFLICT" } };
        }
        const write = async (value: Buffer) => {
          let at = 0;
          while (at < value.length) {
            const result = await handle.write(value, at, value.length - at, at);
            if (!result.bytesWritten) throw new Error("The write stopped before all bytes reached the computer.");
            at += result.bytesWritten;
          }
          await handle.truncate(value.length);
          await handle.sync();
        };
        try {
          await write(next);
        } catch (error) {
          try { await write(bytes); }
          catch {
            return { status: 500, body: { error: "The save failed and the original could not be restored. Your draft is retained; check the file on the computer before retrying.", code: "FILE_SAVE_PARTIAL" } };
          }
          throw Object.assign(new Error("The save failed. The original was restored and your draft is retained."), { cause: error });
        }
        const after = await lstat(target.full);
        if (after.ino !== info.ino || after.dev !== info.dev || after.nlink !== 1 || after.size !== next.length || hashOf(await readBytes(handle, next.length)) !== hashOf(next)) return { status: 409, body: { error: "Another program changed the file during saving. Your draft is retained.", code: "FILE_CONFLICT" } };
        return { status: 200, body: { ok: true, hash: hashOf(next) } };
      } finally { await handle.close(); }
    } finally { release?.(); if (lock && writes.get(target.full) === lock) writes.delete(target.full); }
  } catch (error) {
    if (error instanceof z.ZodError) return { status: 400, body: { error: "The file request is invalid." } };
    if (error instanceof GuardError) return { status: 403, body: { error: error.message } };
    const code = (error as NodeJS.ErrnoException).code;
    return { status: code === "ENOENT" ? 404 : (error as { statusCode?: number }).statusCode ?? 500, body: { error: code === "ENOENT" ? "The original is no longer at this location. It may have been moved or deleted." : error instanceof Error ? error.message : "The file operation failed." } };
  }
}
