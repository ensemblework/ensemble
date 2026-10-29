/**
 * Evidence leaving this computer (docs/25 §4.11): the files a web run's worker attached go to
 * `ROUTES.evidence` while the run holds its lease, before complete. Each is read again from the run's
 * evidence folder by the same rules (no links, one name, no saved secret value, unchanged since it
 * was attached), text is redacted, and the server checks it all once more. With evidence upload off
 * here (`ensemble evidence off`) only the name, kind and size go: the web shows the file as on this
 * computer, not uploaded. A capture held for the owner's preview goes the same way, saying so
 * (protocol 7): its bytes stay here until the owner releases it (evidence/requests.ts).
 */
import type { FastifyInstance } from "fastify";
import type { JobEvidence, WorkspaceJob } from "@prisma/client";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { redactText } from "../lib/redact.js";
import { savedSecretValues } from "../lib/run-secrets.js";
import type { HostedClient } from "../remote/client.js";
import { EvidenceDetails, type EvidenceKind, type EvidenceMeta } from "../remote/contract.js";
import { loadSettings, type HeldJob } from "../remote/store.js";
import { storedEvidence } from "./files.js";
import { isTextMime, sha256Hex } from "./limits.js";

/** The server's device protocol that knows held files, variants and details. */
const CAPTURE_PROTOCOL = 7;

export type EvidencePayload = { meta: EvidenceMeta; bytes: Uint8Array; withheld?: string };

/**
 * What one recorded file sends: its description, and its bytes unless it stays here (upload off, held
 * for the owner's preview, or no longer what was recorded). `release`: the owner released a held file,
 * so its bytes go. Servers before protocol 7 get no held, variant or details fields.
 */
export async function evidencePayload(
  row: JobEvidence,
  options: { upload: boolean; protocol: number; secrets: readonly string[]; release?: boolean },
): Promise<EvidencePayload> {
  const current = options.protocol >= CAPTURE_PROTOCOL;
  const details = current ? EvidenceDetails.safeParse(row.details ?? undefined) : null;
  const base = {
    id: row.id,
    kind: row.kind as EvidenceKind,
    name: row.name,
    caption: row.caption,
    requirementId: row.requirementId,
    mime: row.mime,
    ...(current && row.variantOf ? { variantOf: row.variantOf, variant: row.variant === "preview" ? ("preview" as const) : ("poster" as const) } : {}),
    ...(details?.success && row.details ? { details: details.data } : {}),
  };
  const held = row.held && !options.release;
  if (held || !options.upload) {
    return { meta: { ...base, size: row.size, sha256: row.sha256, local: true, ...(held && current ? { held: true, holdReason: row.holdReason } : {}) }, bytes: new Uint8Array() };
  }
  try {
    const checked = await storedEvidence(row, options.secrets);
    const out = isTextMime(checked.mime) ? Buffer.from(redactText(checked.bytes.toString("utf8")), "utf8") : checked.bytes;
    return { meta: { ...base, mime: checked.mime, size: out.length, sha256: sha256Hex(out), local: false }, bytes: out };
  } catch (error) {
    // The copy changed, went, or now holds a saved secret: it never leaves; the web shows it as kept here.
    return { meta: { ...base, size: row.size, sha256: row.sha256, local: true }, bytes: new Uint8Array(), withheld: error instanceof Error ? error.message.slice(0, 300) : "refused" };
  }
}

/** Sends the run's attached files not sent yet. Returns how many went. */
export async function sendEvidence(app: Pick<FastifyInstance, "prisma">, client: HostedClient, job: HeldJob, local: Pick<WorkspaceJob, "id">): Promise<number> {
  if ((job.protocol ?? 1) < 6 || !client.uploadEvidence || job.evidenceUnsupported) return 0;
  const sent = new Set(job.evidenceSent ?? []);
  // A video before its poster and preview, so the web knows what they belong to.
  const rows = (await app.prisma.jobEvidence.findMany({ where: { jobId: local.id }, orderBy: { createdAt: "asc" } })).filter((row) => !sent.has(row.id));
  if (!rows.length) return 0;
  const upload = loadSettings().evidenceUpload;
  const secrets = upload ? await savedSecretValues(app.prisma, env.ENSEMBLE_DEV_USER_ID).catch(() => [] as string[]) : [];
  let count = 0;
  for (const row of rows) {
    // A server that does not know held files gets none: a held capture shows nowhere until it can be previewed.
    if (row.held && (job.protocol ?? 1) < CAPTURE_PROTOCOL) {
      sent.add(row.id);
      job.evidenceSent = [...sent];
      continue;
    }
    const payload = await evidencePayload(row, { upload, protocol: job.protocol ?? 1, secrets });
    if (payload.withheld) {
      await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "system", action: "evidence.withheld", payload: { jobId: local.id, evidenceId: row.id, reason: payload.withheld } }).catch(() => undefined);
    }
    const result = await client.uploadEvidence(job.hostedId, job.leaseToken, payload.meta, payload.bytes);
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
