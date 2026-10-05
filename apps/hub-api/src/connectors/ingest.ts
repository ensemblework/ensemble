/**
 * Normalize → link → upsert (docs/03 §4.1). Every connector writes through
 * here so redaction, suppression and people linking happen exactly once.
 */
import type { ArtifactKind, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
  /\b(AIza[0-9A-Za-z_-]{30,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(lin_api_[A-Za-z0-9]{20,})\b/g,
  /(password|passwd|secret|token)\s*[:=]\s*\S{6,}/gi,
];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, "[redacted]"), text);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export interface ArtifactInput {
  kind: ArtifactKind;
  externalId: string;
  url?: string | null;
  ts: Date;
  title: string;
  text: string;
  threadId?: string | null;
  participants?: Array<{ name?: string | null; email?: string | null; handle?: string | null }>;
  metadata?: Record<string, unknown>;
  authoredByMe?: boolean;
  repoId?: string | null;
  actorId?: string | null;
}

export interface StoredArtifact {
  id: string;
  created: boolean;
  input: ArtifactInput;
}

export async function upsertArtifact(userId: string, input: ArtifactInput): Promise<StoredArtifact> {
  const data = {
    url: input.url ?? null,
    ts: input.ts,
    title: redact(input.title).slice(0, 500),
    text: redact(input.text).slice(0, 20_000),
    threadId: input.threadId ?? null,
    participants: (input.participants ?? []) as Prisma.InputJsonValue,
    metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    authoredByMe: input.authoredByMe ?? false,
    repoId: input.repoId ?? null,
    actorId: input.actorId ?? null,
  };
  const existing = await prisma.artifact.findUnique({
    where: { userId_kind_externalId: { userId, kind: input.kind, externalId: input.externalId } },
    select: { id: true },
  });
  if (existing) {
    await prisma.artifact.update({ where: { id: existing.id }, data: { ...data, deletedAt: null } });
    return { id: existing.id, created: false, input };
  }
  const row = await prisma.artifact.create({ data: { userId, kind: input.kind, externalId: input.externalId, ...data } });
  return { id: row.id, created: true, input };
}

const suppressedCache = new Map<string, Set<string>>();
const SUPPRESSED_MAX = 64;

async function suppressed(userId: string, kind: string): Promise<Set<string>> {
  const key = `${userId}:${kind}`;
  let set = suppressedCache.get(key);
  if (set) {
    suppressedCache.delete(key);
    suppressedCache.set(key, set);
    return set;
  }
  const rows = await prisma.contextSuppression.findMany({ where: { userId, kind }, select: { key: true } });
  set = new Set(rows.map((row) => row.key.toLowerCase()));
  suppressedCache.set(key, set);
  while (suppressedCache.size > SUPPRESSED_MAX) {
    const oldest = suppressedCache.keys().next().value;
    if (oldest === undefined) break;
    suppressedCache.delete(oldest);
  }
  setTimeout(() => suppressedCache.delete(key), 60_000).unref();
  return set;
}

const AUTOMATED = /(no-?reply|notifications?|mailer-daemon|bounce|donotreply|calendar-notification|@github\.com$)/i;

/** Upserts a person the engineer interacts with. Skips suppressed, automated and self addresses. */
export async function upsertPerson(
  userId: string,
  input: { email?: string | null; name?: string | null; handle?: string | null; at: Date; evidence: string },
  self: Array<string | null | undefined>,
): Promise<string | null> {
  const upn = (input.email ?? input.handle ?? "").trim().toLowerCase();
  if (!upn || AUTOMATED.test(upn)) return null;
  if (self.some((value) => value && value.toLowerCase() === upn)) return null;
  if ((await suppressed(userId, "person")).has(upn)) return null;
  const name = (input.name ?? "").replace(/^"|"$/g, "").trim() || upn.split("@")[0]!;
  const existing = await prisma.person.findUnique({ where: { userId_upn: { userId, upn } } });
  if (existing) {
    if (existing.deletedAt) return null;
    const newer = !existing.lastInteraction || existing.lastInteraction < input.at;
    await prisma.person.update({
      where: { id: existing.id },
      data: {
        lastInteraction: newer ? input.at : undefined,
        relationshipWeight: Math.min(1, existing.relationshipWeight + 0.02),
        evidence: existing.evidence.includes(input.evidence) ? undefined : [...existing.evidence.slice(-19), input.evidence],
      },
    });
    return existing.id;
  }
  const row = await prisma.person.create({
    data: {
      userId,
      upn,
      name,
      email: input.email ?? null,
      lastInteraction: input.at,
      relationshipWeight: 0.1,
      evidence: [input.evidence],
      confidence: 0.6,
    },
  });
  return row.id;
}

export async function upsertRepo(
  userId: string,
  input: { fullName: string; url?: string; description?: string | null; defaultBranch?: string | null; language?: string | null },
): Promise<string | null> {
  if ((await suppressed(userId, "repo")).has(input.fullName.toLowerCase())) return null;
  const row = await prisma.repo.upsert({
    where: { userId_fullName: { userId, fullName: input.fullName } },
    create: {
      userId,
      fullName: input.fullName,
      provider: "github",
      url: input.url ?? `https://github.com/${input.fullName}`,
      description: input.description ?? null,
      defaultBranch: input.defaultBranch ?? null,
      languages: input.language ? [input.language] : [],
      tracked: true,
      evidence: ["github sync"],
      confidence: 0.8,
      lastSyncedAt: new Date(),
    },
    update: { lastSyncedAt: new Date(), ...(input.description ? { description: input.description } : {}) },
  });
  return row.deletedAt ? null : row.id;
}

export function parseAddress(value: string): { name: string | null; email: string | null } {
  const match = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1]!.trim() || null, email: match[2]!.trim().toLowerCase() };
  const bare = value.trim().toLowerCase();
  return { name: null, email: bare.includes("@") ? bare : null };
}

export function parseAddressList(value: string | undefined): Array<{ name: string | null; email: string | null }> {
  if (!value) return [];
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map(parseAddress)
    .filter((row) => row.email);
}
