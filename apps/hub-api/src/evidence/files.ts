/**
 * Evidence on the computer (docs/32 §7): each run has one evidence folder in Ensemble's data folder,
 * never in the repository. A file the worker attaches is read here once, by descriptor, and copied in:
 * no link is followed, only a regular file with one name is read, the path is checked again after it
 * is opened (so a file swapped between the check and the read is caught), and key, certificate,
 * credential and `.env` files, shell histories, Ensemble's own data, the browser profile and any file
 * holding a saved secret value are refused. What is copied is exactly what was checked.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { JobEvidence, PrismaClient } from "@prisma/client";
import { desktopDataDir } from "@ensemble/shared-types/desktop-discovery";
import { expandHome, GuardError, outsideRefusal, within } from "../workspace/guard.js";
import { stateDir } from "../remote/store.js";
import { isEnsembleData } from "../workspace/data-denies.js";
import type { EvidenceKind } from "../remote/contract.js";
import { credentialPathReason, evidenceLimit, evidenceName, kindMismatch, MAX_EVIDENCE_PER_JOB, sha256Hex, sniffMime } from "./limits.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Evidence folders of runs that ended this long ago are removed. */
export const EVIDENCE_KEEP_MS = 30 * 86_400_000;

export class EvidenceError extends GuardError {}

/** Where every run's evidence folder lives: Ensemble's data folder on this computer. */
export function evidenceRoot(): string {
  return join(stateDir(), "evidence");
}

/** One run's evidence folder. */
export function evidenceDir(jobId: string): string {
  if (!UUID.test(jobId)) throw new EvidenceError("That run has no evidence folder.");
  return join(evidenceRoot(), jobId);
}

const OPERATION = /^node:[A-Za-z0-9-]{1,64}:[A-Za-z0-9:_-]{1,200}$/;

/** A node's tool operation, as the server names it: `node:<nodeId>:<mission>`. */
export function isNodeOperation(operation: string): boolean {
  return OPERATION.test(operation);
}

/** Where a node's own captures for one tool operation go (no job): inside the evidence root, named by a digest. */
export function operationEvidenceDir(operation: string): string {
  if (!isNodeOperation(operation)) throw new EvidenceError("That is not a node's tool operation.");
  return join(evidenceRoot(), "node", createHash("sha256").update(operation).digest("hex").slice(0, 32));
}

/** The folder a recorded file lies in: its run's, or its node operation's. */
export function evidenceFolderOf(row: Pick<JobEvidence, "jobId" | "operation">): string {
  if (row.jobId) return evidenceDir(row.jobId);
  if (row.operation) return operationEvidenceDir(row.operation);
  throw new EvidenceError("That evidence has no folder.");
}

/**
 * The browser broker's profiles (B10): saved sign-ins and cookies. Kept here so every rule that keeps
 * agents out of it (evidence, the node's commands) names the same folder.
 */
export function browserProfileDir(): string {
  return join(stateDir(), "browser");
}

/** Folders no evidence comes from and no node command reaches: Ensemble's data (its database and run secrets) and the browser profile. */
export function protectedDeviceFolders(home = homedir()): string[] {
  return [...new Set([stateDir(), desktopDataDir({ platform: process.platform, home }), browserProfileDir()])];
}

let lastSweep = 0;

/** Makes the run's evidence folder (only the owner reads it), and now and then removes old ones. */
export async function prepareEvidenceDir(prisma: Pick<PrismaClient, "workspaceJob">, jobId: string): Promise<string> {
  const dir = evidenceDir(jobId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (Date.now() - lastSweep > 86_400_000) {
    lastSweep = Date.now();
    void sweepEvidenceFolders(prisma).catch(() => undefined);
  }
  return dir;
}

/**
 * Removes the evidence folders of runs that ended more than `EVIDENCE_KEEP_MS` ago, and of runs no
 * longer known here whose folder has not changed for as long.
 */
export async function sweepEvidenceFolders(prisma: Pick<PrismaClient, "workspaceJob">, now = Date.now()): Promise<number> {
  const names = await readdir(evidenceRoot()).catch(() => [] as string[]);
  const ids = names.filter((name) => UUID.test(name));
  if (!ids.length) return 0;
  const jobs = await prisma.workspaceJob.findMany({ where: { id: { in: ids } }, select: { id: true, finishedAt: true } });
  const known = new Map(jobs.map((job) => [job.id, job.finishedAt]));
  let removed = 0;
  for (const id of ids) {
    const dir = join(evidenceRoot(), id);
    const finished = known.get(id);
    const old = known.has(id) ? Boolean(finished && now - finished.getTime() >= EVIDENCE_KEEP_MS) : now - ((await lstat(dir).catch(() => null))?.mtimeMs ?? now) >= EVIDENCE_KEEP_MS;
    if (!old) continue;
    await rm(dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Why a file at this real path is never attached, or null. A file already in the evidence root is
 * judged by its name only (it is in Ensemble's data folder because Ensemble copied it there).
 */
export function evidenceFloor(real: string, home = homedir()): string | null {
  const named = credentialPathReason(real);
  if (named) return named;
  if (within(evidenceRoot(), real)) return null;
  if (within(browserProfileDir(), real)) return "The browser's profile (cookies and saved sign-ins) is never attached.";
  if (isEnsembleData(real, { home })) return "Ensemble's own data is never attached.";
  return outsideRefusal(real, false, home);
}

export type CheckedFile = { bytes: Buffer; size: number; sha256: string; real: string; name: string; mime: string };

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

/** Tests swap a file between the check and the open, as an attacker would. */
let betweenCheckAndOpen: ((path: string) => Promise<void>) | null = null;
export function setSwapHookForTests(hook: ((path: string) => Promise<void>) | null): void {
  betweenCheckAndOpen = hook;
}

/**
 * Reads one file for evidence, by descriptor: refused unless it is a regular file with one name, under
 * the kind's size limit, not a credential file or in a protected folder, and free of every saved
 * secret value. `secrets`: the saved values (lib/run-secrets.ts `savedSecretValues`).
 */
export async function readEvidenceFile(path: string, input: { kind: EvidenceKind; secrets: readonly string[]; home?: string; limit?: number }): Promise<CheckedFile> {
  const home = input.home ?? homedir();
  const full = resolve(expandHome(path));
  const named = credentialPathReason(full);
  if (named) throw new EvidenceError(named);
  const before = await lstat(full).catch(() => null);
  if (!before) throw new EvidenceError(`${path} does not exist.`);
  if (before.isSymbolicLink()) throw new EvidenceError(`${path} is a link. Attach the file itself.`);
  if (!before.isFile()) throw new EvidenceError(`${path} is not a regular file.`);
  const limit = input.limit ?? evidenceLimit(input.kind);
  await betweenCheckAndOpen?.(full);
  let handle;
  try {
    handle = await open(full, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new EvidenceError(code === "ELOOP" || code === "EMLINK" ? `${path} is a link. Attach the file itself.` : `${path} could not be opened (${code ?? "error"}).`);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new EvidenceError(`${path} is not a regular file.`);
    if (opened.nlink > 1) throw new EvidenceError(`${path} has more than one name (a hard link), so it is not attached.`);
    // The path checked is the file opened: a folder or file swapped for a link in between is caught here.
    const real = await realpath(full).catch(() => "");
    const now = real ? await lstat(real).catch(() => null) : null;
    if (!now || now.ino !== opened.ino || now.dev !== opened.dev || now.ino !== before.ino || now.dev !== before.dev) {
      throw new EvidenceError(`${path} changed while it was being checked, so it was not attached.`);
    }
    const floor = evidenceFloor(real, home);
    if (floor) throw new EvidenceError(floor);
    if (opened.size > limit) throw new EvidenceError(`${path} is ${Math.ceil(opened.size / 1024 / 1024)} MB; a ${input.kind} can be at most ${limit / 1024 / 1024} MB.`);
    const buffer = Buffer.alloc(Math.min(opened.size, limit) + 1);
    let read = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
      if (read >= buffer.length) break;
    }
    // It grew while it was read: past the limit is refused, otherwise only what was checked is kept.
    if (read > limit) throw new EvidenceError(`${path} grew past ${limit / 1024 / 1024} MB while it was read.`);
    const bytes = buffer.subarray(0, Math.min(read, opened.size));
    for (const secret of input.secrets) {
      if (secret.length >= 6 && bytes.includes(Buffer.from(secret))) throw new EvidenceError(`${path} holds the value of a saved secret, so it is not attached.`);
    }
    const name = evidenceName(real);
    const mime = sniffMime(bytes, name);
    const mismatch = kindMismatch(input.kind, mime);
    if (mismatch) throw new EvidenceError(mismatch);
    return { bytes, size: bytes.length, sha256: sha256Hex(bytes), real, name, mime };
  } finally {
    await handle.close();
  }
}

/** A name not yet used in the folder: `shot.png`, then `shot-2.png`, … */
export async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = index === 1 ? name : `${stem}-${index}${ext}`;
    if (!(await lstat(join(dir, candidate)).catch(() => null))) return candidate;
  }
  return `${stem}-${randomUUID()}${ext}`;
}

export type AttachInput = { path: string; kind: EvidenceKind; caption?: string | null; requirementId?: string | null };

/**
 * Attaches one file to a run on this computer: checked and copied into the run's evidence folder (a
 * file already there is checked in place), then recorded. `cwd` resolves a relative path.
 */
export async function attachEvidence(
  prisma: Pick<PrismaClient, "jobEvidence" | "workspaceJob">,
  run: { userId: string; jobId: string; cwd: string; secrets: readonly string[] },
  input: AttachInput,
): Promise<JobEvidence> {
  const count = await prisma.jobEvidence.count({ where: { jobId: run.jobId } });
  if (count >= MAX_EVIDENCE_PER_JOB) throw new EvidenceError(`A run attaches at most ${MAX_EVIDENCE_PER_JOB} files.`);
  const dir = await prepareEvidenceDir(prisma, run.jobId);
  const source = isAbsolute(expandHome(input.path)) ? resolve(expandHome(input.path)) : resolve(run.cwd, input.path);
  const checked = await readEvidenceFile(source, { kind: input.kind, secrets: run.secrets });
  const realDir = await realpath(dir);
  let file: string;
  if (within(realDir, checked.real, false) && checked.real.slice(realDir.length + 1).split(/[\\/]/).length === 1) {
    file = checked.real.slice(realDir.length + 1);
    const known = await prisma.jobEvidence.findFirst({ where: { jobId: run.jobId, storageKey: file } });
    if (known) return known;
  } else {
    file = await freeName(dir, checked.name);
    await writeFile(join(dir, file), checked.bytes, { flag: "wx", mode: 0o600 });
  }
  return prisma.jobEvidence.create({
    data: {
      id: randomUUID(),
      userId: run.userId,
      jobId: run.jobId,
      kind: input.kind,
      name: checked.name,
      mime: checked.mime,
      size: checked.size,
      sha256: checked.sha256,
      storageKey: file,
      caption: input.caption?.trim().slice(0, 300) || null,
      requirementId: input.requirementId?.trim().slice(0, 80) || null,
    },
  });
}

/**
 * A recorded file's bytes, read again from the evidence folder by the same rules and refused when
 * they are no longer what was recorded (something changed the copy).
 */
export async function storedEvidence(row: Pick<JobEvidence, "jobId" | "operation" | "storageKey" | "kind" | "sha256">, secrets: readonly string[]): Promise<CheckedFile> {
  if (!row.storageKey || /[\\/]/.test(row.storageKey) || row.storageKey === "." || row.storageKey === "..") throw new EvidenceError("That evidence is not in the run's folder.");
  const checked = await readEvidenceFile(join(evidenceFolderOf(row), row.storageKey), { kind: row.kind as EvidenceKind, secrets });
  if (checked.sha256 !== row.sha256) throw new EvidenceError(`${row.storageKey} changed after it was attached, so it is not sent.`);
  return checked;
}

/** Files placed straight into the run's evidence folder, not yet recorded: the fallback for a worker without the attach tool. */
export async function unrecordedEvidence(prisma: Pick<PrismaClient, "jobEvidence">, jobId: string): Promise<string[]> {
  const dir = evidenceDir(jobId);
  const names = await readdir(dir).catch(() => [] as string[]);
  if (!names.length) return [];
  const known = new Set((await prisma.jobEvidence.findMany({ where: { jobId }, select: { storageKey: true } })).map((row) => row.storageKey));
  const files: string[] = [];
  for (const name of names.sort()) {
    if (known.has(name)) continue;
    const info = await lstat(join(dir, name)).catch(() => null);
    if (info?.isFile()) files.push(join(dir, name));
  }
  return files;
}

/** Removes the run's evidence folder when it holds nothing, so runs without evidence leave no folder. */
export async function dropEmptyEvidenceDir(jobId: string): Promise<void> {
  const dir = evidenceDir(jobId);
  const names = await readdir(dir).catch(() => null);
  if (names && !names.length) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
