/**
 * The same steps for every meeting-notes vendor (docs/03 §2.3):
 * transcript → Artifact(transcript); people from attendees and speakers;
 * calendar event match; MeetingNote with the vendor's summary, decisions and
 * action items; my action items → proposed todos that cite the meeting;
 * everyone else's → "waiting on" lines on the note.
 * Re-running a sync updates in place and never proposes the same item twice.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { normalisedName } from "../../people/identity.js";
import { upsertArtifact, upsertPerson } from "../ingest.js";
import type { Proposal, SyncContext, SyncResult } from "../types.js";
import { decisionsFromMarkdown, dueDate, isMine, itemKey, meFrom, transcriptText, type Me } from "./actions.js";
import { matchEvent } from "./match.js";
import { VENDOR_LABEL, type MeetingRecord, type MeetingVendor } from "./types.js";

const SUMMARY_CAP = 12_000;

export interface NoteExtraction {
  via: MeetingVendor;
  summary: string;
  decisions: string[];
  actionItems: Array<{
    text: string;
    owner: { name: string | null; email: string | null } | null;
    mine: boolean;
    completed: boolean;
    due: string | null;
    at: string | null;
    url: string | null;
    sourceRef: string | null;
  }>;
  /** Other people's action items: what I am waiting on. */
  waitingOn: Array<{ text: string; owner: { name: string | null; email: string | null } }>;
  eventMatch: { reason: string; score: number };
}

export async function whoAmI(userId: string, settingsEmail: string, extra: ReadonlyArray<string | null | undefined> = []): Promise<Me> {
  const [user, tokens] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } }),
    prisma.authToken.findMany({ where: { userId }, select: { account: true } }),
  ]);
  const fromAccounts = tokens.flatMap((row) => (row.account ?? "").match(/[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}/gi) ?? []);
  return meFrom([user?.email, settingsEmail, ...extra, ...fromAccounts], [user?.name]);
}

const dateLabel = (value: Date) => value.toISOString().slice(0, 10);

async function namedPerson(userId: string, name: string): Promise<string | null> {
  const wanted = normalisedName(name);
  if (!wanted.includes(" ")) return null;
  const rows = await prisma.person.findMany({ where: { userId, deletedAt: null, name: { equals: name.trim(), mode: "insensitive" } }, select: { id: true }, take: 2 });
  return rows.length === 1 ? rows[0]!.id : null;
}

export async function ingestMeetings(ctx: SyncContext, vendor: MeetingVendor, records: readonly MeetingRecord[], account: string | null): Promise<SyncResult> {
  const label = VENDOR_LABEL[vendor];
  const me = await whoAmI(ctx.userId, ctx.settings.email, [account]);
  const self = [...me.emails];
  const result: SyncResult = { items: 0, stored: [], proposals: [], triage: [], account };

  for (const record of records) {
    const existing = await prisma.meetingNote.findUnique({
      where: { userId_externalSource_externalId: { userId: ctx.userId, externalSource: vendor, externalId: record.id } },
      select: { id: true, deletedAt: true, projectId: true, eventArtifactId: true },
    });
    // A note the person deleted stays deleted, and its action items are not proposed again.
    if (existing?.deletedAt) continue;

    const evidence = `${vendor}:${record.id}`;
    const personIds: string[] = [];
    const seen = new Set<string>();
    for (const person of [...record.attendees, ...(record.speakers ?? [])]) {
      const email = person.email?.trim().toLowerCase() || null;
      const key = email ?? normalisedName(person.name ?? "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const id = email
        ? await upsertPerson(
            ctx.userId,
            { email, name: person.name, identities: person.name ? [{ kind: "name", value: person.name }] : [], at: record.start, evidence },
            self,
          )
        : person.name && !isMine(person, me)
          ? await namedPerson(ctx.userId, person.name)
          : null;
      if (id && !personIds.includes(id)) personIds.push(id);
    }

    const emails = record.attendees.map((row) => row.email?.trim().toLowerCase()).filter((value): value is string => Boolean(value));
    const duration = record.end ? Math.round((record.end.getTime() - record.start.getTime()) / 60_000) : null;
    const summary = record.summary.trim().slice(0, SUMMARY_CAP);
    const lines = record.transcript ?? [];
    const stored = await upsertArtifact(ctx.userId, {
      kind: "transcript",
      externalId: `${vendor}:${record.id}`,
      url: record.url,
      ts: record.start,
      title: record.title,
      text: lines.length ? transcriptText(lines, label) : summary,
      participants: record.attendees.map((row) => ({ name: row.name ?? null, email: row.email?.toLowerCase() ?? null })),
      authoredByMe: Boolean(record.organizer && me.emails.has(record.organizer.toLowerCase())),
      metadata: {
        source: vendor,
        meetingId: record.id,
        end: record.end?.toISOString() ?? null,
        durationMinutes: duration,
        calendarEventId: record.calendarEventId ?? null,
        summary: summary.slice(0, 4000),
        actionItems: record.actionItems.slice(0, 50).map((item) => ({ text: item.text, assignee: item.assignee ?? null })),
        ...(record.extra ?? {}),
      },
    });
    result.items += 1;
    result.stored.push(stored);

    const match = await matchEvent(ctx.userId, { start: record.start, end: record.end, title: record.title, emails, calendarEventId: record.calendarEventId }, me.emails);
    const eventArtifactId = match.event?.id ?? existing?.eventArtifactId ?? null;
    const projectId = existing?.projectId ?? match.event?.projectId ?? stored.projectId ?? null;

    const items = record.actionItems
      .filter((item) => item.text.trim().length >= 3)
      .slice(0, 50)
      .map((item) => {
        const mine = isMine(item.assignee, me);
        return {
          text: item.text.trim().slice(0, 500),
          owner: item.assignee && (item.assignee.name || item.assignee.email) ? { name: item.assignee.name?.trim() || null, email: item.assignee.email?.trim().toLowerCase() || null } : null,
          mine,
          completed: Boolean(item.completed),
          due: dueDate(item.due)?.toISOString() ?? null,
          at: item.at ?? null,
          url: item.url ?? null,
          sourceRef: mine ? `meeting:${vendor}:${record.id}:${itemKey(item.text)}` : null,
        };
      });
    const extraction: NoteExtraction = {
      via: vendor,
      summary,
      decisions: [...new Set([...(record.decisions ?? []), ...decisionsFromMarkdown(summary)])].slice(0, 30),
      actionItems: items,
      waitingOn: items.filter((item) => !item.mine && item.owner && !item.completed).map((item) => ({ text: item.text, owner: item.owner! })),
      eventMatch: { reason: match.reason, score: Math.round(match.score * 100) / 100 },
    };
    const data = {
      title: record.title.slice(0, 300) || `${label} meeting`,
      titleSource: "connector",
      answer: summary,
      occurredAt: record.start,
      personIds,
      source: "connector",
      status: "ready",
      error: null,
      extraction: extraction as unknown as Prisma.InputJsonValue,
      extractedAt: new Date(),
      eventArtifactId,
      artifactId: eventArtifactId,
      transcriptArtifactId: stored.id,
      projectId,
    };
    const note = existing
      ? await prisma.meetingNote.update({ where: { id: existing.id }, data, select: { id: true } })
      : await prisma.meetingNote.create({ data: { userId: ctx.userId, externalSource: vendor, externalId: record.id, prompt: "", ...data }, select: { id: true } });

    for (const item of items) {
      if (!item.mine || item.completed || !item.sourceRef) continue;
      const proposal: Proposal = {
        sourceRef: item.sourceRef,
        sourceKind: "meeting",
        title: item.text.replace(/[.\s]+$/, "").slice(0, 200),
        description: `Action item from "${data.title}" (${dateLabel(record.start)}), recorded in ${label}.${summary ? `\n\n${summary.slice(0, 1200)}` : ""}`,
        // Vendors without a web link for the meeting (Krisp, Jamie) point at the calendar event instead.
        sourceUrl: item.url ?? record.url ?? match.event?.url ?? null,
        excerpt: item.text,
        priority: "p1",
        due: item.due ? new Date(item.due) : null,
        people: [],
        artifactId: stored.id,
        linkArtifact: false,
        meetingNoteId: note.id,
        projectId,
        rationale: `${label} listed this as yours in "${data.title}".`,
      };
      result.proposals.push(proposal);
    }
  }

  await rematchRecent(ctx.userId, vendor, me);
  return result;
}

/** Notes synced before their calendar event was: try the match again once the calendar has caught up. */
export async function rematchRecent(userId: string, vendor: MeetingVendor, me: Me): Promise<number> {
  const notes = await prisma.meetingNote.findMany({
    where: { userId, externalSource: vendor, eventArtifactId: null, deletedAt: null, occurredAt: { gte: new Date(Date.now() - 14 * 86_400_000) } },
    select: { id: true, title: true, occurredAt: true, extraction: true, transcriptArtifact: { select: { participants: true, metadata: true } } },
    take: 20,
  });
  let matched = 0;
  for (const note of notes) {
    if (!note.occurredAt) continue;
    const metadata = (note.transcriptArtifact?.metadata ?? {}) as Record<string, unknown>;
    const participants = Array.isArray(note.transcriptArtifact?.participants) ? (note.transcriptArtifact!.participants as Array<{ email?: string | null }>) : [];
    const end = typeof metadata.end === "string" ? new Date(metadata.end) : null;
    const match = await matchEvent(
      userId,
      {
        start: note.occurredAt,
        end,
        title: note.title,
        emails: participants.map((row) => row.email ?? "").filter(Boolean),
        calendarEventId: typeof metadata.calendarEventId === "string" ? metadata.calendarEventId : null,
      },
      me.emails,
    );
    if (!match.event) continue;
    const extraction = (note.extraction && typeof note.extraction === "object" ? note.extraction : {}) as Record<string, unknown>;
    await prisma.meetingNote.update({
      where: { id: note.id },
      data: {
        eventArtifactId: match.event.id,
        artifactId: match.event.id,
        extraction: { ...extraction, eventMatch: { reason: match.reason, score: Math.round(match.score * 100) / 100 } } as Prisma.InputJsonValue,
      },
    });
    matched += 1;
  }
  return matched;
}
