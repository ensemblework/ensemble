/**
 * This computer's side of a file the owner previews, releases or discards on the web (protocol 7,
 * `evidence.request`; evidence/held.ts on the server). The file is one this computer keeps: held for
 * the owner's preview, or kept here with evidence upload off. A preview or a release reads it again by
 * the same rules as any upload (unchanged since it was recorded, no saved secret value, text redacted)
 * and sends it under the upload id the web gave; a release then marks it released here. A release
 * needs evidence upload on (`ensemble evidence on`). A discard deletes the file and its poster and
 * preview here. The answer goes back like a Code answer.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { savedSecretValues } from "../lib/run-secrets.js";
import type { HostedClient } from "../remote/client.js";
import { EvidenceRequest, PROTOCOL, type CodeAnswer } from "../remote/contract.js";
import { loadSettings } from "../remote/store.js";
import { evidenceFolderOf } from "./files.js";
import { PREVIEW_MAX_BYTES } from "./grants.js";
import { evidencePayload } from "./upload.js";

type App = Pick<FastifyInstance, "prisma">;

const answer = (status: number, body: Record<string, unknown> = {}): CodeAnswer => ({ status, body });

export async function evidenceRequestAnswer(app: App, client: HostedClient, request: EvidenceRequest): Promise<CodeAnswer> {
  const row = await app.prisma.jobEvidence.findUnique({ where: { id: request.evidenceId } });
  if (!row) return answer(404, { error: "That file is not on this computer any more." });
  if (request.action === "discard") {
    const rows = [row, ...(await app.prisma.jobEvidence.findMany({ where: { variantOf: row.id } }))];
    for (const item of rows) {
      if (item.storageKey && !/[\\/]/.test(item.storageKey)) await rm(join(evidenceFolderOf(item), item.storageKey), { force: true }).catch(() => undefined);
    }
    await app.prisma.jobEvidence.deleteMany({ where: { id: { in: rows.map((item) => item.id) } } });
    await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "system", action: "evidence.discard", payload: { evidenceId: row.id, jobId: row.jobId, operation: row.operation } }).catch(() => undefined);
    return answer(200, { discarded: rows.length });
  }
  if (!request.uploadId || !client.uploadEvidenceFile) return answer(400, { error: "No upload id for that file." });
  if (request.action === "release" && !loadSettings().evidenceUpload) {
    return answer(409, { error: "Evidence upload is off on this computer, so the file stays there. `ensemble evidence on` turns it on." });
  }
  if (request.action === "preview" && row.size > PREVIEW_MAX_BYTES) return answer(413, { error: "Too large to preview from the computer." });
  const payload = await evidencePayload(row, { upload: true, protocol: PROTOCOL, secrets: await savedSecretValues(app.prisma, env.ENSEMBLE_DEV_USER_ID).catch(() => []), release: true });
  if (payload.withheld) return answer(409, { error: `It stays on this computer: ${payload.withheld}` });
  const sent = await client.uploadEvidenceFile(request.uploadId, { ...payload.meta, local: false }, payload.bytes);
  if (sent.result !== "stored") return answer(sent.result === "gone" ? 410 : 409, { error: sent.error ?? "The web did not take the file." });
  if (request.action === "release") {
    await app.prisma.jobEvidence.update({ where: { id: row.id }, data: { held: false, holdReason: null } });
    await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "system", action: "evidence.release", payload: { evidenceId: row.id, jobId: row.jobId, operation: row.operation } }).catch(() => undefined);
  }
  return answer(200, { ok: true });
}

/** An `evidence.request` frame from the event stream: answer it once. */
export async function answerEvidenceRequest(app: App, client: HostedClient, data: unknown): Promise<void> {
  const parsed = EvidenceRequest.safeParse(data);
  if (!parsed.success) {
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id) await client.answerCode(id, answer(400, { error: "That request could not be read. Update Ensemble on this computer." }));
    return;
  }
  const reply = await evidenceRequestAnswer(app, client, parsed.data).catch((error: unknown) => answer(500, { error: error instanceof Error ? error.message.slice(0, 300) : "This computer could not do that." }));
  await client.answerCode(parsed.data.id, reply);
}
