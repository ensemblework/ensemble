/**
 * Items Ensemble synced or attached from connected apps (Artifact rows), as Files → From your
 * apps shows them: where each came from, and the person's own removals.
 *
 * A removal soft-deletes the row and records a ContextSuppression (kind "artifact", key
 * "<artifact kind>:<externalId>"), so a later sync does not bring the item back. Attaching the
 * same item again on purpose (connectors/items) clears it.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { CONNECTOR_CATALOG } from "@ensemble/shared-types";
import { isMeetingVendor, VENDOR_LABEL } from "../connectors/meetings/types.js";

export const ARTIFACT_SUPPRESSION = "artifact";

type Db = PrismaClient | Prisma.TransactionClient;

export function artifactSuppressionKey(kind: string, externalId: string): string {
  return `${kind}:${externalId}`;
}

/** True when the person removed this item; syncs then leave it alone. */
export async function removedByPerson(db: Db, userId: string, kind: string, externalId: string): Promise<boolean> {
  const row = await db.contextSuppression.findUnique({
    where: { userId_kind_key: { userId, kind: ARTIFACT_SUPPRESSION, key: artifactSuppressionKey(kind, externalId) } },
    select: { id: true },
  });
  return Boolean(row);
}

/** The person brought the item back on purpose (attached it again). */
export async function forgetRemoval(db: Db, userId: string, kind: string, externalId: string): Promise<void> {
  await db.contextSuppression.deleteMany({ where: { userId, kind: ARTIFACT_SUPPRESSION, key: artifactSuppressionKey(kind, externalId) } });
}

/** Uploaded files keep their text on an Artifact too; Files lists those as files, not as app items. */
export const NOT_UPLOADED: Prisma.ArtifactWhereInput = { document: { is: null }, NOT: { kind: "file", externalId: { startsWith: "file:" } } };

export type ArtifactOrigin = { app: string | null; label: string };

/** Parts of a suite, by the item kind attached from it. */
const SUITE_PARTS: Record<string, Record<string, ArtifactOrigin>> = {
  google_workspace: {
    file: { app: "google_drive", label: "Google Drive" },
    conversation: { app: "gmail", label: "Gmail" },
    attachment: { app: "gmail", label: "Gmail" },
  },
  microsoft_365: {
    file: { app: "onedrive", label: "OneDrive" },
    conversation: { app: "outlook", label: "Outlook" },
    attachment: { app: "outlook", label: "Outlook" },
  },
};

/** metadata.source values the syncs write (connectors/*.ts). */
const SYNC_SOURCES: Record<string, ArtifactOrigin> = {
  gmail: { app: "gmail", label: "Gmail" },
  google: { app: "google_calendar", label: "Google Calendar" },
  teams: { app: "teams", label: "Microsoft Teams" },
  linear: { app: "linear", label: "Linear" },
};

function catalogOrigin(id: string): ArtifactOrigin | null {
  const entry = CONNECTOR_CATALOG.find((row) => row.id === id || row.logo === id);
  return entry ? { app: entry.logo, label: entry.name } : null;
}

/**
 * Which app an item came from: `app` is a logo key for the web's BrandLogo, `label` its name.
 * Null when nothing on the row says.
 */
export function artifactOrigin(row: { kind: string; externalId: string; url: string | null; metadata: unknown }): ArtifactOrigin | null {
  const meta = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? (row.metadata as Record<string, unknown>) : {};
  const source = typeof meta.source === "string" ? meta.source.trim() : "";
  if (meta.via === "app-item" && source) {
    return SUITE_PARTS[source]?.[String(meta.itemKind ?? "")] ?? catalogOrigin(source) ?? { app: source, label: source };
  }
  if (row.externalId.startsWith("mkt:")) return { app: null, label: "Sample" };
  if (source === "outlook") return { app: "outlook", label: row.kind === "event" ? "Outlook calendar" : "Outlook" };
  if (SYNC_SOURCES[source]) return SYNC_SOURCES[source]!;
  if (isMeetingVendor(source)) return { app: source, label: VENDOR_LABEL[source] };
  const url = row.url ?? "";
  if (url.startsWith("https://mail.google.com/")) return SYNC_SOURCES.gmail!;
  if (url.startsWith("https://github.com/")) return { app: "github", label: "GitHub" };
  if (url.includes(".slack.com/archives/")) return { app: "slack", label: "Slack" };
  if (row.externalId.startsWith("teams:")) return SYNC_SOURCES.teams!;
  if (row.externalId.startsWith("linear:")) return SYNC_SOURCES.linear!;
  return source ? (catalogOrigin(source) ?? { app: source, label: source }) : null;
}
