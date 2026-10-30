/**
 * A node's files `share` (nodeTools 2): a file in a folder (its own, or one the owner let it read,
 * capability `read`) becomes the node's evidence, which it shows its owner in the chat. The file
 * meets the floor every attached file meets (evidence/files.ts `readEvidenceFile`): inside the folder,
 * no link or second name, no key, certificate, credential, `.env` or history file and nothing in a
 * folder of keys or git's own, not Ensemble's data, no saved secret value in it, at most 20 MB (a video
 * 100 MB), and bytes that are what its kind says. What was checked is copied into the operation's
 * evidence folder and kept and sent like a capture (`keepEvidence`).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { freeName, operationEvidenceDir, readEvidenceFile } from "../evidence/files.js";
import { credentialPathReason } from "../evidence/limits.js";
import { appendLedger } from "../lib/ledger.js";
import { savedSecretValues } from "../lib/run-secrets.js";
import type { HostedClient } from "../remote/client.js";
import type { EvidenceKind, NodeCaptureAnswer, NodeToolRequest } from "../remote/contract.js";
import { refusedPath } from "../workspace/folder-read.js";
import { GuardError, jailPath } from "../workspace/guard.js";
import { keepEvidence } from "./capture.js";
import type { ToolFolder } from "./folders.js";

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

/** Checks the file, copies it into the evidence folder, keeps and sends it, and answers. */
export async function runNodeShare(app: Pick<FastifyInstance, "prisma">, client: HostedClient, request: ShareRequest, folder: ToolFolder): Promise<NodeCaptureAnswer> {
  if (!request.operation || !request.uploadId) throw new GuardError("Sharing a file needs the node's operation and upload id; update Ensemble on the web.");
  const userId = env.ENSEMBLE_DEV_USER_ID;
  const full = await jailPath(folder.path, request.path, true);
  const rel = relative(folder.path, full).split(sep).join("/");
  if (!rel || rel === ".") throw new GuardError("Name a file inside the folder.");
  const refused = refusedPath(rel) ?? credentialPathReason(rel);
  if (refused) throw new GuardError(refused);
  const kind = shareKind(rel);
  const secrets = await savedSecretValues(app.prisma, userId).catch(() => [] as string[]);
  const checked = await readEvidenceFile(full, { kind, secrets });
  const dir = operationEvidenceDir(request.operation);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const copy = join(dir, await freeName(dir, checked.name));
  await writeFile(copy, checked.bytes, { flag: "wx", mode: 0o600 });
  const kept = await keepEvidence(app, client, { nodeId: request.nodeId, operation: request.operation, uploadId: request.uploadId }, [{ path: copy, kind, held: false, ...(request.caption?.trim() ? { caption: request.caption.trim() } : {}) }]);
  await appendLedger({ userId, actor: "agent", action: "node.tool.files.share", payload: { nodeId: request.nodeId, folder: folder.label, path: rel, kind, size: checked.size, files: kept.evidence.length, operationId: request.operationId ?? null } }).catch(() => undefined);
  const shared = kept.evidence.length > 0;
  return {
    ok: shared,
    ...(shared ? { summary: `Shared ${rel} from ${folder.label} (${kind}, ${checked.mime}, ${size(checked.size)}).` } : { error: { code: "refused", message: `${rel} was not shared: ${kept.refused.map((item) => item.reason).join("; ") || "the web did not take it"}`.slice(0, 2000) } }),
    result: { path: rel, name: checked.name, kind, mime: checked.mime, size: checked.size },
    ...kept,
  };
}
