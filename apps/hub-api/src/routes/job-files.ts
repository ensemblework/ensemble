/**
 * A job's files on the web: the files its run changed (their text as the computer sent it when the
 * run ended), and its folder read live, one folder or file at a time: from the paired computer that
 * ran it (devices/file-relay.ts), or from this server's own folder for a run here (operators and
 * the desktop app). Only the person whose computer ran a device job may read its folder live.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deviceOnline } from "../devices/constants.js";
import { askDevice } from "../devices/file-relay.js";
import { currentDevice } from "../devices/successor.js";
import type { Device } from "@prisma/client";
import { canUseHostCredentials } from "../lib/hosted-access.js";
import { actorFor } from "../sharing/context.js";
import { folderPath, listedChanges, listFolder, outsideListing, readChangedFile, refusedPath } from "../workspace/folder-read.js";
import { GuardError } from "../workspace/guard.js";

const JOB_SELECT = {
  id: true,
  userId: true,
  runnerAccountId: true,
  deviceId: true,
  externalRoot: true,
  repoPath: true,
  evidence: true,
  device: true,
} as const;

type JobRow = {
  id: string;
  userId: string;
  runnerAccountId: string | null;
  deviceId: string | null;
  externalRoot: string | null;
  repoPath: string;
  evidence: unknown;
  device: Device | null;
};

type Refusal = { status: number; error: string };

/** A device job's files are its runner's: only the person whose computer ran it sees their text. */
function textRefusal(job: JobRow): Refusal | null {
  if (!job.deviceId) return null;
  if ((job.runnerAccountId ?? null) !== actorFor(job.userId)) return { status: 403, error: "Only the person whose computer ran this task can open its files." };
  const browse = (job.device?.capabilities as { browseFiles?: unknown } | null)?.browseFiles;
  if (browse === false) return { status: 409, error: `Showing task files on the web is turned off on ${job.device?.name ?? "that computer"}. Turn it on there with \`ensemble browse on\`.` };
  return null;
}

/** Why the job's folder cannot be read live right now, or null. */
async function liveRefusal(job: JobRow, userId: string): Promise<Refusal | null> {
  if (job.deviceId) {
    const text = textRefusal(job);
    if (text) return text;
    const device = job.device;
    const name = device?.name ?? "That computer";
    if (!device || device.revokedAt) return { status: 409, error: `${name} is no longer paired.` };
    const browse = (device.capabilities as { browseFiles?: unknown } | null)?.browseFiles;
    if (browse !== true) return { status: 409, error: `Update Ensemble on ${name} to open task folders here (the CLI 0.3.7 or the desktop app 0.3.4).` };
    if (!deviceOnline(device.lastSeenAt)) return { status: 409, error: `${name} is offline. Open Ensemble there to see this task's folder.` };
    return null;
  }
  if (!(await canUseHostCredentials(userId))) return { status: 403, error: "This task ran on the server; its folder is not open to this account." };
  if (!(job.externalRoot || job.repoPath)) return { status: 409, error: "This task has no folder." };
  return null;
}

function failure(error: unknown): Refusal {
  if (error instanceof GuardError) return { status: 422, error: error.message };
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { status: 404, error: "That is no longer in the task's folder." };
  return { status: 500, error: "The folder could not be read." };
}

type EvidenceFile = { path?: unknown; status?: unknown; added?: unknown; removed?: unknown; binary?: unknown };

export async function jobFileRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  /** The job, with a computer paired again since standing in for the pairing that ran it (devices/successor.ts). */
  const loadJob = async (id: string, userId: string): Promise<JobRow | null> => {
    const job = (await prisma.workspaceJob.findFirst({ where: { id, userId }, select: JOB_SELECT })) as JobRow | null;
    if (job?.device?.revokedAt) {
      const now = await currentDevice(prisma, job.device);
      if (now) {
        job.device = now;
        job.deviceId = now.id;
      }
    }
    return job;
  };

  /** Ask the device, or read this server's folder. */
  async function readLive(job: JobRow, kind: "tree" | "file", path: string) {
    if (job.deviceId) {
      const answer = await askDevice(app.redis, { deviceId: job.deviceId, hostedJobId: job.id, kind, path });
      const name = job.device?.name ?? "That computer";
      if (!answer) return { refusal: { status: 504, error: `${name} did not answer. It may be asleep or busy; try again.` } };
      if (answer.error) return { refusal: { status: 422, error: answer.error } };
      return kind === "tree" ? { listing: answer.listing } : { file: answer.file };
    }
    const root = job.externalRoot || job.repoPath;
    try {
      return kind === "tree" ? { listing: await listFolder(root, path) } : { file: await readChangedFile(root, listedChanges(job.evidence), path) };
    } catch (error) {
      return { refusal: failure(error) };
    }
  }

  // The files the run changed: names, status and line counts, which ones have their text here, and whether the folder can be read live.
  app.get("/api/agent/jobs/:id/files", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await loadJob(id, request.userId);
    if (!job) return reply.code(404).send({ error: "Job not found." });
    const evidence = (job.evidence && typeof job.evidence === "object" && !Array.isArray(job.evidence) ? job.evidence : {}) as { files?: EvidenceFile[] };
    const stored = await prisma.jobFile.findMany({ where: { jobId: job.id }, select: { path: true, status: true, size: true, binary: true, truncated: true, skipped: true } });
    const byPath = new Map(stored.map((row) => [row.path, row]));
    const files = (Array.isArray(evidence.files) ? evidence.files : [])
      .filter((file): file is EvidenceFile & { path: string } => typeof file.path === "string" && file.path.length > 0)
      .map((file) => {
        const row = byPath.get(file.path);
        byPath.delete(file.path);
        const status = file.status === "added" || file.status === "deleted" ? file.status : row?.status ?? "modified";
        return {
          path: file.path,
          status,
          added: Number(file.added) || 0,
          removed: Number(file.removed) || 0,
          binary: file.binary === true || row?.binary === true,
          stored: Boolean(row && !row.skipped && !row.binary && status !== "deleted"),
          truncated: row?.truncated ?? false,
          skipped: row?.skipped ?? null,
        };
      });
    for (const row of byPath.values()) {
      files.push({ path: row.path, status: row.status, added: 0, removed: 0, binary: row.binary, stored: !row.skipped && !row.binary && row.status !== "deleted", truncated: row.truncated, skipped: row.skipped });
    }
    const refusal = await liveRefusal(job, request.userId);
    // Names and line counts for everyone who sees the job; the text only for its runner.
    const text = textRefusal(job);
    return {
      files: text ? files.map((file) => ({ ...file, stored: false })) : files,
      text: { available: !text, reason: text?.error ?? null },
      live: { available: !refusal, reason: refusal?.error ?? null },
      where: job.deviceId ? "device" : "server",
    };
  });

  // One file: the copy the computer sent when the run ended, or read live (`live=1`, or when there is no copy).
  app.get("/api/agent/jobs/:id/file", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = z.object({ path: z.string().min(1).max(1000), live: z.enum(["0", "1"]).optional() }).parse(request.query);
    const job = await loadJob(id, request.userId);
    if (!job) return reply.code(404).send({ error: "Job not found." });
    // A file the run changed outside its folder is named as the run listed it (`~/…`), and only such a file.
    const outside = outsideListing(query.path);
    if (outside && !listedChanges(job.evidence).includes(query.path)) return reply.code(403).send({ error: "That file is outside the task's folder and is not one this run changed." });
    const path = outside ? query.path : folderPath(query.path);
    const refused = refusedPath(outside ? path.replace(/^~?\//, "") : path);
    if (refused) return reply.code(403).send({ error: refused });
    const notYours = textRefusal(job);
    if (notYours) return reply.code(notYours.status).send({ error: notYours.error });
    if (query.live !== "1") {
      const row = await prisma.jobFile.findUnique({ where: { jobId_path: { jobId: job.id, path } } });
      if (row && !row.skipped && !row.binary && row.content != null) {
        return { source: "stored", file: { path: row.path, size: row.size, content: row.content, binary: row.binary, truncated: row.truncated }, status: row.status, at: row.createdAt.toISOString() };
      }
    }
    const refusal = await liveRefusal(job, request.userId);
    if (refusal) return reply.code(refusal.status).send({ error: refusal.error });
    const read = await readLive(job, "file", path);
    if ("refusal" in read && read.refusal) return reply.code(read.refusal.status).send({ error: read.refusal.error });
    return { source: "live", file: read.file };
  });

  // One folder's entries, read live.
  app.get("/api/agent/jobs/:id/tree", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = z.object({ path: z.string().max(1000).default("") }).parse(request.query);
    const path = folderPath(query.path);
    const job = await loadJob(id, request.userId);
    if (!job) return reply.code(404).send({ error: "Job not found." });
    const refused = path ? refusedPath(path) : null;
    if (refused) return reply.code(403).send({ error: refused });
    const refusal = await liveRefusal(job, request.userId);
    if (refusal) return reply.code(refusal.status).send({ error: refusal.error });
    const read = await readLive(job, "tree", path);
    if ("refusal" in read && read.refusal) return reply.code(read.refusal.status).send({ error: read.refusal.error });
    return { listing: read.listing };
  });
}
