/**
 * Captures as evidence (docs/35 §8.16, docs/32 §7): every file the browser and capture tools write is
 * evidence of the work that made it, with no separate attach step. A run's captures belong to its job
 * (its evidence folder, `<data>/evidence/<job>`); a node's own captures belong to its tool operation
 * (`<data>/evidence/node/<digest>`), with no job. Each file is checked where it lies, like an attached
 * file (`readEvidenceFile`: one name, no link, the size for its kind, its type sniffed, no saved secret
 * value in its bytes); one that fails is deleted. A capture the computer holds (a secret or key on
 * screen, a desktop app's window, a site the owner previews first) is recorded `held`: it goes nowhere
 * and reaches no model until the owner previews and releases it. A video's poster and small preview
 * are recorded as its variants.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { JobEvidence, Prisma, PrismaClient } from "@prisma/client";
import type { MediaFile, StillFile } from "../capture/media.js";
import type { EvidenceKind } from "../remote/contract.js";
import { within } from "../workspace/guard.js";
import { evidenceDir, evidenceRoot, operationEvidenceDir, readEvidenceFile } from "./files.js";
import { kindFor, MAX_EVIDENCE_PER_JOB } from "./limits.js";

/** Who the captures belong to: a run (its job), or a node's tool operation. */
export type CaptureOwner = { userId: string; jobId: string } | { userId: string; nodeId: string; operation: string };

export type CapturedFile = {
  path: string;
  kind: EvidenceKind;
  held: boolean;
  reason?: string;
  details?: Record<string, number | string>;
  variants?: Array<{ path: string; variant: "poster" | "preview" }>;
  /** One line for the owner, what the file is (a file a node shares). */
  caption?: string;
};

function details(file: MediaFile | StillFile): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const key of ["width", "height", "durationMs", "fps", "frames"] as const) {
    const value = (file as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = Math.round(value);
  }
  const codec = (file as { codec?: unknown }).codec;
  if (typeof codec === "string" && codec.length <= 40) out.codec = codec;
  return out;
}

const KIND: Record<MediaFile["kind"], EvidenceKind> = { image: "screenshot", video: "video", trace: "trace", html: "report", file: "file" };

function isMedia(value: unknown): value is MediaFile {
  const file = value as Partial<MediaFile> | null;
  return Boolean(file && typeof file.path === "string" && typeof file.kind === "string" && typeof file.held === "boolean" && file.kind in KIND);
}

/** The files a browser or capture tool's result names: a capture (with a video's poster and preview), a recording, a download. */
export function capturedFiles(result: unknown): CapturedFile[] {
  const media = isMedia(result) ? result : isMedia((result as { file?: unknown } | null)?.file) ? (result as { file: MediaFile }).file : null;
  if (media) {
    const variants: CapturedFile["variants"] = [];
    if (media.poster?.path) variants.push({ path: media.poster.path, variant: "poster" });
    if (media.preview?.path) variants.push({ path: media.preview.path, variant: "preview" });
    return [{ path: media.path, kind: KIND[media.kind], held: media.held, ...(media.reason ? { reason: media.reason } : {}), details: details(media), variants }];
  }
  const download = result as { path?: unknown; mime?: unknown; name?: unknown } | null;
  if (download && typeof download.path === "string" && typeof download.mime === "string" && typeof download.name === "string") {
    return [{ path: download.path, kind: kindFor(download.mime), held: false }];
  }
  return [];
}

/** Files recordings left behind when their tab closed (`BrowserBroker.takeFinished`), as captured files. */
export function finishedFiles(files: readonly MediaFile[]): CapturedFile[] {
  return files.flatMap((file) => capturedFiles(file));
}

let lastSweep = 0;

export type Recorded = { rows: JobEvidence[]; refused: Array<{ name: string; reason: string }> };

/**
 * Records captured files as evidence of their owner, each checked where it lies in that owner's
 * evidence folder. A file that fails the checks (or lies elsewhere) is deleted, with why.
 */
export async function recordCaptures(prisma: Pick<PrismaClient, "jobEvidence">, owner: CaptureOwner, files: readonly CapturedFile[], secrets: readonly string[]): Promise<Recorded> {
  // Now and then, node operations' folders nobody touched for 30 days go (runs' folders have their own sweep).
  if (Date.now() - lastSweep > 86_400_000) {
    lastSweep = Date.now();
    void sweepOperationFolders(prisma).catch(() => undefined);
  }
  const folder = "jobId" in owner ? evidenceDir(owner.jobId) : operationEvidenceDir(owner.operation);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const realFolder = await realpath(folder);
  const where = "jobId" in owner ? { jobId: owner.jobId } : { operation: owner.operation, jobId: null };
  const recorded: Recorded = { rows: [], refused: [] };
  const one = async (path: string, kind: EvidenceKind, extra: Partial<Prisma.JobEvidenceUncheckedCreateInput>): Promise<JobEvidence | null> => {
    try {
      if ((await prisma.jobEvidence.count({ where })) >= MAX_EVIDENCE_PER_JOB) throw new Error(`This work keeps at most ${MAX_EVIDENCE_PER_JOB} files.`);
      const checked = await readEvidenceFile(path, { kind, secrets });
      if (!within(realFolder, checked.real, false) || dirname(checked.real) !== realFolder) throw new Error("It is not in this work's evidence folder.");
      const known = await prisma.jobEvidence.findFirst({ where: { ...where, storageKey: basename(checked.real) } });
      if (known) return known;
      return await prisma.jobEvidence.create({
        data: {
          id: randomUUID(),
          userId: owner.userId,
          ...("jobId" in owner ? { jobId: owner.jobId } : { nodeId: owner.nodeId, operation: owner.operation }),
          kind,
          name: checked.name,
          mime: checked.mime,
          size: checked.size,
          sha256: checked.sha256,
          storageKey: basename(checked.real),
          ...extra,
        },
      });
    } catch (error) {
      // What fails the checks (a saved secret's value in it, too large) is not kept anywhere.
      await rm(path, { force: true }).catch(() => undefined);
      recorded.refused.push({ name: basename(path), reason: error instanceof Error ? error.message.slice(0, 300) : "refused" });
      return null;
    }
  };
  for (const file of files) {
    const hold = file.held ? { held: true, holdReason: (file.reason ?? "The computer could not check it.").slice(0, 300) } : {};
    const caption = file.caption?.trim().slice(0, 300);
    const row = await one(file.path, file.kind, { ...hold, ...(file.details && Object.keys(file.details).length ? { details: file.details } : {}), ...(caption ? { caption } : {}) });
    if (!row) {
      for (const variant of file.variants ?? []) await rm(variant.path, { force: true }).catch(() => undefined);
      continue;
    }
    recorded.rows.push(row);
    for (const variant of file.variants ?? []) {
      const image = await one(variant.path, "image", { ...hold, variantOf: row.id, variant: variant.variant });
      if (image) recorded.rows.push(image);
    }
  }
  return recorded;
}

/** How the work's agent or node reads what was kept: ids to name in a report, and what waits for the owner. */
export function recordedNote(recorded: Recorded): string {
  const main = recorded.rows.filter((row) => !row.variantOf);
  const lines: string[] = [];
  const kept = main.filter((row) => !row.held);
  const held = main.filter((row) => row.held);
  if (kept.length) lines.push(`Kept as evidence: ${kept.map((row) => `${row.kind} “${row.name}” [${row.id}]`).join("; ")}. Check it with capture_check, then name its id in your report.`);
  if (held.length) lines.push(`Held for your owner to preview first (nothing is sent until they release it): ${held.map((row) => `${row.kind} “${row.name}” [${row.id}]: ${row.holdReason ?? "not checked"}`).join("; ")}.`);
  if (recorded.refused.length) lines.push(`Not kept: ${recorded.refused.map((item) => `“${item.name}”: ${item.reason}`).join("; ")}`);
  return lines.join("\n");
}

/** Node operations' evidence folders unchanged for this long are removed, with their rows. */
const KEEP_MS = 30 * 86_400_000;

/** Removes node operations' evidence folders (and their rows here) not changed for 30 days. */
export async function sweepOperationFolders(prisma: Pick<PrismaClient, "jobEvidence">, now = Date.now()): Promise<number> {
  const root = join(evidenceRoot(), "node");
  const names = await readdir(root).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{32}$/.test(name)) continue;
    const dir = join(root, name);
    const info = await lstat(dir).catch(() => null);
    if (!info?.isDirectory()) continue;
    const files = await readdir(dir).catch(() => [] as string[]);
    const newest = Math.max(info.mtimeMs, ...(await Promise.all(files.map((file) => stat(join(dir, file)).then((row) => row.mtimeMs, () => 0)))));
    if (now - newest < KEEP_MS) continue;
    const rows = await prisma.jobEvidence.findMany({ where: { jobId: null, operation: { not: null } }, select: { id: true, operation: true } });
    const gone = rows.filter((row) => row.operation && operationEvidenceDir(row.operation) === dir).map((row) => row.id);
    if (gone.length) await prisma.jobEvidence.deleteMany({ where: { id: { in: gone } } });
    await rm(dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
