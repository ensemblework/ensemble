/**
 * A node's files `share` (nodeTools 2; a folder with nodeFiles 1): a file or a folder in a folder (its
 * own, or one the owner let it read, capability `read`) becomes the node's evidence, which it shows its
 * owner in the chat. A file meets the floor every attached file meets (evidence/files.ts
 * `readEvidenceFile`): inside the folder, no link or second name, no key, certificate, credential, `.env`
 * or history file and nothing in a folder of keys or git's own, not Ensemble's data or another
 * account's, no saved secret value in it, at most `NODE_FILE_MAX_BYTES`, and bytes that are what its
 * kind says; an archive also by its entries (device-tools/zip.ts `archiveProblem`). A folder is zipped
 * here into `<folder>.zip`, file by file under the same floor (`zipFolder`), leaving out what the
 * floor refuses and dependency and cache folders. What was checked is copied (or zipped) into the
 * operation's evidence folder and kept and sent like a capture (`keepEvidence`).
 */
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { freeName, operationEvidenceDir, readEvidenceFile } from "../evidence/files.js";
import { credentialPathReason } from "../evidence/limits.js";
import { appendLedger } from "../lib/ledger.js";
import { savedSecretValues } from "../lib/run-secrets.js";
import type { HostedClient } from "../remote/client.js";
import { NODE_FILE_MAX_BYTES, type EvidenceKind, type NodeCaptureAnswer, type NodeToolRequest } from "../remote/contract.js";
import { refusedPath } from "../workspace/folder-read.js";
import { GuardError, jailPath } from "../workspace/guard.js";
import { keepEvidence } from "./capture.js";
import type { ToolFolder } from "./folders.js";
import { archiveProblem, describeLeftOut, zipFolder, ZipTooLarge, zipNameFor } from "./zip.js";

type ShareRequest = Extract<NodeToolRequest, { tool: "files" }>;

const REPORT = new Set([".md", ".markdown", ".txt", ".log", ".csv", ".json", ".pdf"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".heic", ".bmp"]);
const VIDEO = new Set([".mp4", ".webm", ".mov", ".m4v"]);

/** What a shared file is kept as, by its name: a report (text, Markdown, data, PDF), an image, a video, or a file. */
export function shareKind(name: string): EvidenceKind {
  const extension = extname(name).toLowerCase();
  if (REPORT.has(extension)) return "report";
  if (IMAGE.has(extension)) return "image";
  if (VIDEO.has(extension)) return "video";
  return "file";
}

const size = (bytes: number) => (bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Checks the file (or zips the folder), puts it in the evidence folder, keeps and sends it, and answers. */
export async function runNodeShare(app: Pick<FastifyInstance, "prisma">, client: HostedClient, request: ShareRequest, folder: ToolFolder): Promise<NodeCaptureAnswer> {
  if (!request.operation || !request.uploadId) throw new GuardError("Sharing a file needs the node's operation and upload id; update Ensemble on the web.");
  const userId = env.ENSEMBLE_DEV_USER_ID;
  const full = await jailPath(folder.path, request.path.trim() || ".", true);
  const rel = relative(folder.path, full).split(sep).join("/");
  const refused = rel ? (refusedPath(rel) ?? credentialPathReason(rel)) : null;
  if (refused) throw new GuardError(refused);
  const secrets = await savedSecretValues(app.prisma, userId).catch(() => [] as string[]);
  const dir = operationEvidenceDir(request.operation);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const caption = request.caption?.trim() ? { caption: request.caption.trim() } : {};
  const info = await lstat(full);

  let copy: string;
  let kind: EvidenceKind;
  let described: { path: string; name: string; kind: EvidenceKind; mime: string; size: number; files?: number; leftOut?: string };
  if (info.isDirectory()) {
    const name = zipNameFor(basename(full));
    copy = join(dir, await freeName(dir, name));
    let zipped;
    try {
      zipped = await zipFolder(full, copy, { prefix: name.replace(/\.zip$/, ""), secrets, maxBytes: NODE_FILE_MAX_BYTES });
    } catch (error) {
      if (error instanceof ZipTooLarge) throw new GuardError(`${rel || folder.label} is too large to share: ${error.message} Share a smaller folder or the files themselves.`);
      throw error;
    }
    kind = "file";
    described = { path: rel || ".", name, kind, mime: "application/zip", size: zipped.size, files: zipped.files, ...(zipped.leftOut.length ? { leftOut: describeLeftOut(zipped.leftOut) } : {}) };
  } else {
    if (!rel) throw new GuardError("Name a file or a folder inside the folder.");
    kind = shareKind(rel);
    const checked = await readEvidenceFile(full, { kind, secrets, limit: NODE_FILE_MAX_BYTES });
    const inside = archiveProblem(checked.bytes, checked.mime, secrets);
    if (inside) throw new GuardError(`${rel} is not shared. ${inside}`);
    copy = join(dir, await freeName(dir, checked.name));
    await writeFile(copy, checked.bytes, { flag: "wx", mode: 0o600 });
    described = { path: rel, name: checked.name, kind, mime: checked.mime, size: checked.size };
  }
  const kept = await keepEvidence(app, client, { nodeId: request.nodeId, operation: request.operation, uploadId: request.uploadId }, [{ path: copy, kind, held: false, ...caption }]);
  await appendLedger({ userId, actor: "agent", action: "node.tool.files.share", payload: { nodeId: request.nodeId, folder: folder.label, path: described.path, kind, size: described.size, ...(described.files ? { zipped: described.files } : {}), files: kept.evidence.length, operationId: request.operationId ?? null } }).catch(() => undefined);
  const shared = kept.evidence.length > 0;
  const what = described.files
    ? `Shared ${described.path === "." ? folder.label : `${described.path} from ${folder.label}`} as ${described.name} (${described.files} file${described.files === 1 ? "" : "s"}, ${size(described.size)})${described.leftOut ? `. Left out: ${described.leftOut}` : ""}.`
    : `Shared ${described.path} from ${folder.label} (${kind}, ${described.mime}, ${size(described.size)}).`;
  return {
    ok: shared,
    ...(shared ? { summary: what } : { error: { code: "refused", message: `${described.path} was not shared: ${kept.refused.map((item) => item.reason).join("; ") || "the web did not take it"}`.slice(0, 2000) } }),
    result: described,
    ...kept,
  };
}
