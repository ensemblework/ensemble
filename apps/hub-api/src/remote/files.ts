/**
 * This computer's side of seeing a task's files from Ensemble on the web (protocol 3): the text of
 * the files a run changed, sent before the run completes, and answers to `files.request` (one
 * folder's entries or one file's text, read when the person opens it). Both read only the task's own
 * folder, through folder-read.ts (no git internals, no secrets files, text only, capped, redacted),
 * and both stop when the person turns off "Show task files on the web" (`browseFiles`).
 */
import { realpath } from "node:fs/promises";
import type { WorkspaceJob } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { sliceBytes } from "../lib/text.js";
import { GuardError, within, workspaceRoot } from "../workspace/guard.js";
import { listFolder, readFolderFile, refusedPath } from "../workspace/folder-read.js";
import type { HostedClient } from "./client.js";
import { FileRequest, UPLOAD_FILE_BYTES, UPLOAD_FILES_MAX, UPLOAD_TOTAL_BYTES, type FileAnswer, type UploadedFile } from "./contract.js";
import { scrubOutgoing } from "./policy.js";
import { loadHeld, loadSettings, type HeldJob } from "./store.js";

const BATCH_BYTES = 1_000_000;
const BATCH_FILES = 25;
/** A finished task's folder is offered this long, like its copies on the server. */
const OFFER_DAYS = 30;
const INT32 = 2_147_483_647;

/**
 * The folder a task may be read from: its own run folder under Ensemble's workspace, or a folder this
 * computer shares now. A folder it stopped sharing is not read, whatever task used it.
 */
async function offeredRoot(root: string): Promise<string | null> {
  const real = await realpath(root).catch(() => null);
  if (!real) return null;
  if (within(await workspaceRoot(), real)) return real;
  for (const folder of loadSettings().folders) {
    const shared = await realpath(folder.path).catch(() => null);
    if (shared && within(shared, real)) return real;
  }
  return null;
}

function folderOf(local: Pick<WorkspaceJob, "externalRoot" | "repoPath">): string | null {
  return local.externalRoot || local.repoPath || null;
}

function reason(error: unknown): string {
  if (error instanceof GuardError) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "That is no longer in the task's folder.";
  if (code === "EACCES" || code === "EPERM") return "This computer may not read that.";
  return "This computer could not read that.";
}

async function answerFor(app: FastifyInstance, request: FileRequest): Promise<FileAnswer> {
  if (!loadSettings().browseFiles) return { error: "Showing task files on the web is turned off on this computer." };
  const held = loadHeld()[request.jobId];
  const local = held?.localJobId
    ? await app.prisma.workspaceJob.findUnique({ where: { id: held.localJobId }, select: { externalRoot: true, repoPath: true, finishedAt: true } })
    : null;
  const folder = local ? folderOf(local) : null;
  if (!local || !folder) return { error: "This task has no folder on this computer." };
  if (local.finishedAt && Date.now() - local.finishedAt.getTime() > OFFER_DAYS * 86_400_000) return { error: `This task finished more than ${OFFER_DAYS} days ago; its folder is no longer shown.` };
  const root = await offeredRoot(folder);
  if (!root) return { error: "This task's folder is no longer shared from this computer." };
  // Each read from the web is recorded here, on this computer.
  await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "system", action: request.kind === "tree" ? "remote.folder_listed" : "remote.file_read", payload: { hostedJobId: request.jobId, path: request.path.slice(0, 300) } }).catch(() => undefined);
  try {
    if (request.kind === "tree") {
      const listing = await listFolder(root, request.path);
      return { listing: { ...listing, entries: listing.entries.map((entry) => ({ ...entry, name: entry.name.slice(0, 500) })) } };
    }
    const file = await readFolderFile(root, request.path);
    return { file: { ...file, size: Math.min(file.size, INT32), content: file.content == null ? null : sliceBytes(scrubOutgoing(file.content), 600 * 1024) } };
  } catch (error) {
    return { error: reason(error) };
  }
}

/** A `files.request` frame from the event stream: read, then answer. A bad frame is ignored. */
export async function answerFileRequest(app: FastifyInstance, client: HostedClient, data: unknown): Promise<void> {
  const parsed = FileRequest.safeParse(data);
  if (!parsed.success) return;
  await client.answerFiles(parsed.data.id, await answerFor(app, parsed.data));
}

type EvidenceFile = { path?: unknown; status?: unknown; binary?: unknown };

/** The files a run changed, with their text where it may go: what `uploadChangedFiles` sends. */
export async function changedFileUploads(root: string, evidence: unknown): Promise<UploadedFile[]> {
  const list = ((evidence && typeof evidence === "object" && Array.isArray((evidence as { files?: unknown }).files) ? (evidence as { files: EvidenceFile[] }).files : []) as EvidenceFile[])
    .filter((file): file is EvidenceFile & { path: string } => typeof file.path === "string" && file.path.length > 0)
    .slice(0, UPLOAD_FILES_MAX);
  const files: UploadedFile[] = [];
  let total = 0;
  for (const file of list) {
    const status = file.status === "added" || file.status === "deleted" ? file.status : "modified";
    const base = { path: scrubOutgoing(file.path).slice(0, 500), status, size: 0, binary: file.binary === true, truncated: false } as const;
    if (status === "deleted" || file.binary === true) {
      files.push({ ...base, content: null });
      continue;
    }
    const refused = refusedPath(file.path);
    if (refused) {
      files.push({ ...base, content: null, skipped: refused });
      continue;
    }
    if (total >= UPLOAD_TOTAL_BYTES) {
      files.push({ ...base, content: null, skipped: "Past what one run sends; open it from the folder." });
      continue;
    }
    try {
      const read = await readFolderFile(root, file.path, Math.min(UPLOAD_FILE_BYTES, UPLOAD_TOTAL_BYTES - total));
      const scrubbed = read.content == null ? null : scrubOutgoing(read.content);
      const content = scrubbed == null ? null : sliceBytes(scrubbed, UPLOAD_FILE_BYTES);
      total += Buffer.byteLength(content ?? "");
      files.push({ ...base, size: Math.min(read.size, INT32), binary: read.binary, truncated: read.truncated || (scrubbed != null && content !== scrubbed), content });
    } catch (error) {
      files.push({ ...base, content: null, skipped: reason(error) });
    }
  }
  return files;
}

/** Before complete (protocol 3): the changed files' text, in batches of about 1 MB. */
export async function uploadChangedFiles(client: HostedClient, job: HeldJob, local: WorkspaceJob): Promise<void> {
  if ((job.protocol ?? 1) < 3 || !loadSettings().browseFiles) return;
  const folder = folderOf(local);
  const root = folder ? await offeredRoot(folder) : null;
  if (!root) return;
  const files = await changedFileUploads(root, local.evidence);
  let batch: UploadedFile[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.content ?? "") + file.path.length + 100;
    if (batch.length && (batch.length >= BATCH_FILES || bytes + size > BATCH_BYTES)) {
      await client.uploadFiles(job.hostedId, job.leaseToken, batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += size;
  }
  if (batch.length) await client.uploadFiles(job.hostedId, job.leaseToken, batch);
}
