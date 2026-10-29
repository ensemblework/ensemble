/**
 * Evidence leaving this computer (docs/25 §4.11): the files a web run's worker attached go to
 * `ROUTES.evidence` while the run holds its lease, before complete. Each is read again from the run's
 * evidence folder by the same rules (no links, one name, no saved secret value, unchanged since it
 * was attached), text is redacted, and the server checks it all once more. With evidence upload off
 * here (`ensemble evidence off`) only the name, kind and size go: the web shows the file as on this
 * computer, not uploaded.
 */
import type { FastifyInstance } from "fastify";
import type { WorkspaceJob } from "@prisma/client";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { redactText } from "../lib/redact.js";
import { savedSecretValues } from "../lib/run-secrets.js";
import type { HostedClient } from "../remote/client.js";
import type { EvidenceKind, EvidenceMeta } from "../remote/contract.js";
import { loadSettings, type HeldJob } from "../remote/store.js";
import { storedEvidence } from "./files.js";
import { isTextMime, sha256Hex } from "./limits.js";

/** Sends the run's attached files not sent yet. Returns how many went. */
export async function sendEvidence(app: Pick<FastifyInstance, "prisma">, client: HostedClient, job: HeldJob, local: Pick<WorkspaceJob, "id">): Promise<number> {
  if ((job.protocol ?? 1) < 6 || !client.uploadEvidence || job.evidenceUnsupported) return 0;
  const sent = new Set(job.evidenceSent ?? []);
  const rows = (await app.prisma.jobEvidence.findMany({ where: { jobId: local.id }, orderBy: { createdAt: "asc" } })).filter((row) => !sent.has(row.id));
  if (!rows.length) return 0;
  const upload = loadSettings().evidenceUpload;
  const secrets = upload ? await savedSecretValues(app.prisma, env.ENSEMBLE_DEV_USER_ID).catch(() => [] as string[]) : [];
  let count = 0;
  for (const row of rows) {
    const base = { id: row.id, kind: row.kind as EvidenceKind, name: row.name, caption: row.caption, requirementId: row.requirementId, mime: row.mime };
    let meta: EvidenceMeta;
    let bytes: Uint8Array = new Uint8Array();
    if (!upload) {
      meta = { ...base, size: row.size, sha256: row.sha256, local: true };
    } else {
      try {
        const checked = await storedEvidence(row, secrets);
        const out = isTextMime(checked.mime) ? Buffer.from(redactText(checked.bytes.toString("utf8")), "utf8") : checked.bytes;
        meta = { ...base, mime: checked.mime, size: out.length, sha256: sha256Hex(out), local: false };
        bytes = out;
      } catch (error) {
        // The copy changed, went, or now holds a saved secret: it never leaves; the web shows it as kept here.
        await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "system", action: "evidence.withheld", payload: { jobId: local.id, evidenceId: row.id, reason: error instanceof Error ? error.message.slice(0, 300) : "refused" } }).catch(() => undefined);
        meta = { ...base, size: row.size, sha256: row.sha256, local: true };
      }
    }
    const result = await client.uploadEvidence(job.hostedId, job.leaseToken, meta, bytes);
    if (result.result === "unsupported") {
      job.evidenceUnsupported = true;
      return count;
    }
    if (result.result === "refused") {
      await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "system", action: "evidence.refused", payload: { jobId: local.id, evidenceId: row.id, reason: result.error?.slice(0, 300) ?? null } }).catch(() => undefined);
    } else {
      count += 1;
    }
    sent.add(row.id);
    job.evidenceSent = [...sent];
  }
  return count;
}
