/**
 * One person across every source (docs/03 §4.7). A person is found by any
 * address or handle they are known by, email first. Ingest only ever adds
 * identities; two people that already exist are never merged automatically.
 * When ingest sees an identity of one person next to another person's
 * address, it records a suggestion, and the person decides.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const IDENTITY_KINDS = ["email", "slack", "github", "linear", "jira", "teams", "zoom", "phone", "name"] as const;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];
export interface IdentityInput {
  kind: IdentityKind;
  value: string;
}

type Db = PrismaClient | Prisma.TransactionClient;

const KIND_ORDER: Record<IdentityKind, number> = { email: 0, slack: 1, teams: 2, github: 3, linear: 4, jira: 5, zoom: 6, phone: 7, name: 8 };

export const isIdentityKind = (value: string): value is IdentityKind => (IDENTITY_KINDS as readonly string[]).includes(value);

/** Trimmed, lowercase, and shaped for its kind. Null when the value cannot be that kind. */
export function normaliseIdentity(kind: IdentityKind, raw: string | null | undefined): string | null {
  let value = (raw ?? "").trim().toLowerCase();
  if (!value) return null;
  switch (kind) {
    case "email":
      value = value.replace(/^mailto:/, "");
      return /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(value) ? value : null;
    case "github":
      value = value.replace(/^@/, "");
      return /^[a-z0-9](?:[a-z0-9-]{0,38})(?:\[bot\])?$/.test(value) ? value : null;
    case "phone": {
      const digits = value.replace(/[^\d+]/g, "");
      return digits.replace(/\D/g, "").length >= 6 ? digits : null;
    }
    case "name":
      value = value.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
      return value.length >= 2 ? value : null;
    default:
      value = value.replace(/^@/, "");
      return value.length <= 200 ? value : null;
  }
}

/** "slack:U123" → { kind: "slack", value: "u123" }. A bare address becomes an email identity. */
export function parseHandle(handle: string | null | undefined): IdentityInput | null {
  const text = (handle ?? "").trim();
  if (!text) return null;
  const match = /^([a-z]+):(.+)$/i.exec(text);
  if (match && isIdentityKind(match[1]!.toLowerCase())) {
    const kind = match[1]!.toLowerCase() as IdentityKind;
    const value = normaliseIdentity(kind, match[2]);
    return value ? { kind, value } : null;
  }
  const email = normaliseIdentity("email", text);
  return email ? { kind: "email", value: email } : null;
}

/** Normalised, de-duplicated, email first. */
export function cleanIdentities(list: ReadonlyArray<IdentityInput | null | undefined>): IdentityInput[] {
  const seen = new Set<string>();
  const out: IdentityInput[] = [];
  for (const row of list) {
    if (!row) continue;
    const value = normaliseIdentity(row.kind, row.value);
    if (!value) continue;
    const key = `${row.kind}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: row.kind, value });
  }
  return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

export interface Resolved {
  personId: string;
  deleted: boolean;
  /** The identity that found the person. */
  via: IdentityInput;
}

/** The person any of these identities belongs to. Email wins over handles, handles over names. */
export async function resolvePerson(userId: string, identities: ReadonlyArray<IdentityInput>, db: Db = prisma): Promise<Resolved | null> {
  const list = cleanIdentities(identities);
  if (!list.length) return null;
  const rows = await db.personIdentity.findMany({
    where: { userId, OR: list.map((row) => ({ kind: row.kind, value: row.value })) },
    select: { kind: true, value: true, personId: true, person: { select: { deletedAt: true } } },
  });
  for (const wanted of list) {
    const hit = rows.find((row) => row.kind === wanted.kind && row.value === wanted.value);
    if (hit) return { personId: hit.personId, deleted: Boolean(hit.person.deletedAt), via: wanted };
  }
  return null;
}

/**
 * Adds identities to a person. An identity that already belongs to someone
 * else stays where it is and is marked as a suggestion pointing at this person.
 * Returns the number of suggestions recorded.
 */
export async function recordIdentities(
  userId: string,
  personId: string,
  identities: ReadonlyArray<IdentityInput>,
  source: string,
  db: Db = prisma,
): Promise<number> {
  const list = cleanIdentities(identities);
  if (!list.length) return 0;
  const existing = await db.personIdentity.findMany({
    where: { userId, OR: list.map((row) => ({ kind: row.kind, value: row.value })) },
    select: { id: true, kind: true, value: true, personId: true, suggestedPersonId: true, person: { select: { deletedAt: true } } },
  });
  let suggestions = 0;
  for (const identity of list) {
    const found = existing.find((row) => row.kind === identity.kind && row.value === identity.value);
    if (!found) {
      try {
        await db.personIdentity.create({ data: { userId, personId, kind: identity.kind, value: identity.value, source: source.slice(0, 60) } });
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
      }
      continue;
    }
    if (found.personId === personId || found.person.deletedAt) continue;
    // Real people share names far more often than addresses; a name never becomes a suggestion on its own.
    if (identity.kind === "name") continue;
    if (found.suggestedPersonId !== personId) {
      await db.personIdentity.update({ where: { id: found.id }, data: { suggestedPersonId: personId } });
      suggestions += 1;
    }
  }
  return suggestions;
}

// ── suggestions ─────────────────────────────────────────────────────────────

export const MERGE_DISMISS_KIND = "person-merge";

export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

const compact = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

export function normalisedName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SuggestionPerson {
  id: string;
  name: string;
  email: string | null;
  identities: Array<{ kind: string; value: string }>;
}

export interface IdentitySuggestion {
  key: string;
  people: [SuggestionPerson, SuggestionPerson];
  reason: "seen-together" | "same-name" | "handle-matches-email";
  /** Plain words for the card, e.g. "Is sam@fieldnote.example the same person as slack u0abc (Sam Rivera)?" */
  question: string;
  evidence: string;
}

type PersonRow = {
  id: string;
  name: string;
  email: string | null;
  identities: Array<{ kind: string; value: string; suggestedPersonId: string | null; source: string }>;
};

/** Pairs that are probably one person. Computed on read; a dismissed pair stays dismissed. */
export async function identitySuggestions(userId: string, db: Db = prisma, limit = 50): Promise<IdentitySuggestion[]> {
  const [people, dismissed] = await Promise.all([
    db.person.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, name: true, email: true, identities: { select: { kind: true, value: true, suggestedPersonId: true, source: true } } },
      orderBy: { relationshipWeight: "desc" },
      take: 2000,
    }) as Promise<PersonRow[]>,
    db.contextSuppression.findMany({ where: { userId, kind: MERGE_DISMISS_KIND }, select: { key: true } }),
  ]);
  const skip = new Set(dismissed.map((row) => row.key));
  const byId = new Map(people.map((person) => [person.id, person]));
  const out = new Map<string, IdentitySuggestion>();
  const view = (person: PersonRow): SuggestionPerson => ({
    id: person.id,
    name: person.name,
    email: person.email,
    identities: person.identities.map((row) => ({ kind: row.kind, value: row.value })),
  });
  const label = (person: PersonRow): string => person.email ?? person.identities.find((row) => row.kind !== "name")?.value ?? person.name;
  const add = (a: PersonRow, b: PersonRow, reason: IdentitySuggestion["reason"], evidence: string, question?: string) => {
    if (a.id === b.id) return;
    const key = pairKey(a.id, b.id);
    if (skip.has(key) || out.has(key)) return;
    const [first, second] = a.id < b.id ? [a, b] : [b, a];
    out.set(key, {
      key,
      people: [view(first), view(second)],
      reason,
      question: question ?? `Is ${first.name} (${label(first)}) the same person as ${second.name} (${label(second)})?`,
      evidence,
    });
  };

  for (const person of people) {
    for (const identity of person.identities) {
      const other = identity.suggestedPersonId ? byId.get(identity.suggestedPersonId) : undefined;
      if (!other) continue;
      add(
        person,
        other,
        "seen-together",
        `${identity.source} showed ${identity.kind} ${identity.value} together with ${label(other)}.`,
        `Is ${label(other)} the same person as ${identity.kind} ${identity.value} (${person.name})?`,
      );
    }
  }

  const byName = new Map<string, PersonRow[]>();
  for (const person of people) {
    const name = normalisedName(person.name);
    if (!name.includes(" ")) continue;
    byName.set(name, [...(byName.get(name) ?? []), person]);
  }
  for (const group of byName.values()) {
    if (group.length < 2 || group.length > 4) continue;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        add(group[i]!, group[j]!, "same-name", `Both are called ${group[i]!.name}.`);
      }
    }
  }

  const byLocal = new Map<string, PersonRow>();
  for (const person of people) {
    for (const identity of person.identities) {
      if (identity.kind !== "email") continue;
      const local = compact(identity.value.split("@")[0] ?? "");
      if (local.length >= 4 && !byLocal.has(local)) byLocal.set(local, person);
    }
  }
  for (const person of people) {
    if (person.email || person.identities.some((row) => row.kind === "email")) continue;
    for (const identity of person.identities) {
      if (identity.kind === "name" || identity.kind === "phone") continue;
      const owner = byLocal.get(compact(identity.value));
      if (owner) add(owner, person, "handle-matches-email", `${identity.kind} ${identity.value} matches the address ${label(owner)}.`);
    }
  }
  return [...out.values()].slice(0, limit);
}

export async function dismissSuggestion(userId: string, personId: string, otherId: string, db: Db = prisma): Promise<void> {
  const key = pairKey(personId, otherId);
  await db.contextSuppression.upsert({
    where: { userId_kind_key: { userId, kind: MERGE_DISMISS_KIND, key } },
    create: { userId, kind: MERGE_DISMISS_KIND, key, label: "not the same person", reason: "dismissed merge suggestion" },
    update: {},
  });
  await db.personIdentity.updateMany({
    where: { userId, OR: [{ personId, suggestedPersonId: otherId }, { personId: otherId, suggestedPersonId: personId }] },
    data: { suggestedPersonId: null },
  });
}

// ── merge ───────────────────────────────────────────────────────────────────

export class MergeError extends Error {
  readonly expose = true;
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function replaceIds(list: readonly string[], from: readonly string[], to: string): string[] {
  const lowered = new Set(from.map((value) => value.toLowerCase()));
  const out: string[] = [];
  for (const value of list) {
    const next = lowered.has(value.toLowerCase()) ? to : value;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

export interface MergeResult {
  keptId: string;
  removedId: string;
  moved: { identities: number; tasks: number; meetingNotes: number; meetingSessions: number; documents: number; projects: number; artifacts: number; attendance: number };
}

/**
 * Folds `otherId` into `keepId` in one transaction: identities, task people,
 * meeting people, document tags, project membership, artifact authors and
 * attendance move across, then `otherId` is removed.
 */
export async function mergePeople(db: PrismaClient, userId: string, keepId: string, otherId: string): Promise<MergeResult> {
  if (keepId === otherId) throw new MergeError(400, "Pick two different people to merge.");
  return db.$transaction(async (tx) => {
    const [keep, other] = await Promise.all([
      tx.person.findFirst({ where: { id: keepId, userId, deletedAt: null } }),
      tx.person.findFirst({ where: { id: otherId, userId, deletedAt: null } }),
    ]);
    if (!keep || !other) throw new MergeError(404, "Person not found.");
    const moved: MergeResult["moved"] = { identities: 0, tasks: 0, meetingNotes: 0, meetingSessions: 0, documents: 0, projects: 0, artifacts: 0, attendance: 0 };

    moved.identities = (await tx.personIdentity.updateMany({ where: { userId, personId: otherId }, data: { personId: keepId } })).count;
    // The removed person's legacy keys must keep resolving to the person that stays.
    const legacy = cleanIdentities([parseHandle(other.upn), other.email ? { kind: "email", value: other.email } : null]);
    for (const identity of legacy) {
      await tx.personIdentity.upsert({
        where: { userId_kind_value: { userId, kind: identity.kind, value: identity.value } },
        create: { userId, personId: keepId, kind: identity.kind, value: identity.value, source: "merge", verified: true },
        update: { personId: keepId },
      });
    }
    await tx.personIdentity.updateMany({ where: { userId, personId: keepId, suggestedPersonId: { in: [keepId, otherId] } }, data: { suggestedPersonId: null } });
    await tx.personIdentity.updateMany({ where: { userId, suggestedPersonId: otherId }, data: { suggestedPersonId: keepId } });

    // Task people hold person ids, and plain names on older rows.
    const aliases = [otherId, ...(other.name.trim() && normalisedName(other.name) !== normalisedName(keep.name) ? [other.name.trim()] : [])];
    const tasks = await tx.task.findMany({ where: { userId, people: { hasSome: aliases } }, select: { id: true, people: true } });
    for (const task of tasks) await tx.task.update({ where: { id: task.id }, data: { people: replaceIds(task.people, aliases, keepId) } });
    moved.tasks = tasks.length;

    const notes = await tx.meetingNote.findMany({ where: { userId, personIds: { has: otherId } }, select: { id: true, personIds: true } });
    for (const note of notes) await tx.meetingNote.update({ where: { id: note.id }, data: { personIds: replaceIds(note.personIds, [otherId], keepId) } });
    moved.meetingNotes = notes.length;

    const sessions = await tx.meetingSession.findMany({ where: { userId, personIds: { has: otherId } }, select: { id: true, personIds: true } });
    for (const session of sessions) {
      await tx.meetingSession.update({ where: { id: session.id }, data: { personIds: replaceIds(session.personIds, [otherId], keepId) } });
    }
    moved.meetingSessions = sessions.length;

    const documents = await tx.document.findMany({ where: { userId, personIds: { has: otherId } }, select: { id: true, personIds: true } });
    for (const document of documents) {
      await tx.document.update({ where: { id: document.id }, data: { personIds: replaceIds(document.personIds, [otherId], keepId) } });
    }
    moved.documents = documents.length;

    const memberships = await tx.projectPerson.findMany({ where: { personId: otherId } });
    for (const row of memberships) {
      const already = await tx.projectPerson.findUnique({ where: { projectId_personId: { projectId: row.projectId, personId: keepId } } });
      await tx.projectPerson.delete({ where: { projectId_personId: { projectId: row.projectId, personId: otherId } } });
      if (!already) {
        await tx.projectPerson.create({ data: { projectId: row.projectId, personId: keepId, role: row.role, addedBy: row.addedBy, createdAt: row.createdAt } });
        moved.projects += 1;
      }
    }

    moved.artifacts = (await tx.artifact.updateMany({ where: { userId, actorId: otherId }, data: { actorId: keepId } })).count;
    moved.attendance = (await tx.attendanceMark.updateMany({ where: { userId, personId: otherId }, data: { personId: keepId } })).count;

    const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);
    await tx.person.delete({ where: { id: otherId } });
    await tx.person.update({
      where: { id: keepId },
      data: {
        email: keep.email ?? other.email,
        role: keep.role ?? other.role,
        team: keep.team ?? other.team,
        lastInteraction: later(keep.lastInteraction, other.lastInteraction),
        relationshipWeight: Math.min(1, Math.max(keep.relationshipWeight, other.relationshipWeight) + 0.05),
        confidence: Math.max(keep.confidence, other.confidence),
        evidence: [...new Set([...keep.evidence, ...other.evidence])].slice(-20),
        capacityHours: keep.capacityHours ?? other.capacityHours,
        oneOnOneDays: keep.oneOnOneDays ?? other.oneOnOneDays,
      },
    });
    await tx.contextSuppression.deleteMany({ where: { userId, kind: MERGE_DISMISS_KIND, key: pairKey(keepId, otherId) } });
    return { keptId: keepId, removedId: otherId, moved };
  });
}
