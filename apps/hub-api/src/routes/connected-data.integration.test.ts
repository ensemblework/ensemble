/**
 * Connected data over HTTP: people identities and merges, project links applied
 * at ingest, and every meeting-notes connector end to end (pasted key → explicit import
 * → transcript, meeting note, calendar match, proposed todos), with isolation
 * between accounts. Every vendor call is answered by a mocked fetch; the people
 * and companies are fictional (Mira Chen at Fieldnote).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { connectedDataRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

const originalEnv = { ...process.env };
process.env.NODE_ENV = "test";
process.env.ENSEMBLE_MEETING_PACE_MS = "0";

const harness: HttpHarness = await createHttpHarness();
const { upsertArtifact, upsertPerson } = await import("../connectors/ingest.js");
const { importRequestedMeetings } = await import("../connectors/meetings/requested-import.js");
const { createProposals } = await import("./../connectors/triage.js");
const { rememberImportLink, linkedProject } = await import("../projects/links.js");
const db = harness.prisma;
const covered = new Map<string, Set<RouteCheck>>();

/** A sync's write; these tests never remove an item, so there is always a row. */
async function stored(...args: Parameters<typeof upsertArtifact>) {
  const row = await upsertArtifact(...args);
  assert.ok(row, "the artifact was stored");
  return row;
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const handlers: Array<{ match: (url: string) => boolean; reply: Handler }> = [];
const calls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return realFetch(input, init);
  calls.push(url);
  const handler = handlers.find((row) => row.match(url));
  if (!handler) return new Response(JSON.stringify({ error: `unmocked ${url}` }), { status: 599 });
  return handler.reply(url, init);
}) as typeof fetch;

function mock(prefix: string, reply: Handler): void {
  handlers.unshift({ match: (url) => url.startsWith(prefix), reply });
}

function resetMocks(): void {
  handlers.length = 0;
  calls.length = 0;
}

after(async () => {
  try {
    for (const [route, checks] of Object.entries(connectedDataRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted coverage claim: ${check} ${route}`);
    }
  } finally {
    globalThis.fetch = realFetch;
    await harness.close();
    process.env = originalEnv;
  }
});

async function call(user: HttpUser, method: InjectOptions["method"], url: string, route: string, check: RouteCheck, payload?: unknown) {
  const response = await user.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as InjectOptions["payload"] }) });
  const key = `${String(method)} ${route}`;
  covered.set(key, (covered.get(key) ?? new Set<RouteCheck>()).add(check));
  return response;
}

async function mira(tag: string): Promise<HttpUser> {
  const user = await harness.asUser(`mira.${tag}.${randomUUID().slice(0, 8)}@fieldnote.example`);
  await db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(), name: "Mira Chen" } });
  return user;
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

// ── people ──────────────────────────────────────────────────────────────────

test("people are found by any identity, email first, and a clash becomes a suggestion, never a merge", async () => {
  const user = await mira("people");
  const self = [user.email];
  const at = hoursAgo(5);
  const arjun = await upsertPerson(user.id, { email: "Arjun@Fieldnote.example", name: "Arjun Rao", at, evidence: "gmail:t1" }, self);
  assert.ok(arjun);
  // Slack later sees the same address with a handle: same person, handle recorded.
  const again = await upsertPerson(user.id, { email: "arjun@fieldnote.example", name: "Arjun Rao", handle: "slack:U0ARJUN", at, evidence: "slack:C1" }, self);
  assert.equal(again, arjun);
  const byHandle = await upsertPerson(user.id, { name: "Arjun", handle: "slack:U0ARJUN", at, evidence: "slack:C2" }, self);
  assert.equal(byHandle, arjun, "the Slack handle alone resolves to the same person");
  const identities = await db.personIdentity.findMany({ where: { personId: arjun! }, orderBy: { kind: "asc" } });
  assert.deepEqual(identities.map((row) => `${row.kind}:${row.value}`), ["email:arjun@fieldnote.example", "slack:u0arjun"]);

  // An unverified imported pair is a suggestion; only a provider-confirmed pair can merge automatically.
  const teamsSam = await upsertPerson(user.id, { name: "Sam R", handle: "teams:sam-guid", at, evidence: "teams:chat-1" }, self);
  const sam = await upsertPerson(user.id, { email: "sam@fieldnote.example", name: "Sam Rivera", at, evidence: "gmail:t2" }, self);
  const paired = await upsertPerson(user.id, { email: "sam@fieldnote.example", name: "Sam Rivera", handle: "teams:sam-guid", at, evidence: "import:chat-2" }, self);
  assert.equal(paired, sam, "email wins");
  assert.notEqual(teamsSam, sam);
  assert.equal(await db.person.count({ where: { userId: user.id, id: { in: [sam!, teamsSam!] }, deletedAt: null } }), 2, "nothing merged on its own");
  assert.equal(await upsertPerson(user.id, { email: user.email, name: "Mira Chen", at, evidence: "gmail:t3" }, self), null, "never myself");
  assert.equal(await upsertPerson(user.id, { email: "noreply@fieldnote.example", at, evidence: "gmail:t4" }, self), null);

  const other = await mira("people-other");
  const listed = await call(user, "GET", "/api/people/identity-suggestions", "/api/people/identity-suggestions", "happy-path");
  assert.equal(listed.statusCode, 200, listed.body);
  const suggestion = listed.json<{ suggestions: Array<{ reason: string; question: string; people: Array<{ id: string }> }> }>().suggestions.find((row) => row.reason === "seen-together");
  assert.ok(suggestion, listed.body);
  assert.deepEqual(new Set(suggestion.people.map((row) => row.id)), new Set([sam, teamsSam]));
  assert.match(suggestion.question, /sam@fieldnote\.example/);
  const foreign = await call(other, "GET", "/api/people/identity-suggestions", "/api/people/identity-suggestions", "isolation");
  assert.deepEqual(foreign.json<{ suggestions: unknown[] }>().suggestions, []);

  // Merge: everything that pointed at the Teams-only person now points at Sam.
  const project = await db.project.create({ data: { userId: user.id, name: "Atlas" } });
  await db.projectPerson.create({ data: { projectId: project.id, personId: teamsSam! } });
  const task = await db.task.create({ data: { userId: user.id, title: "Reply to Sam", people: [teamsSam!, "Sam R"] } });
  const note = await db.meetingNote.create({ data: { userId: user.id, title: "Sync", personIds: [teamsSam!, sam!] } });
  const session = await db.meetingSession.create({ data: { userId: user.id, title: "Live", personIds: [teamsSam!] } });
  const artifact = await db.artifact.create({ data: { userId: user.id, kind: "chat_msg", externalId: "teams:m1", ts: at, actorId: teamsSam } });

  const isolated = await call(other, "POST", `/api/people/${sam}/merge`, "/api/people/:id/merge", "isolation", { otherId: teamsSam });
  assert.equal(isolated.statusCode, 404, isolated.body);
  const unknown = await call(user, "POST", `/api/people/${randomUUID()}/merge`, "/api/people/:id/merge", "unknown-id", { otherId: teamsSam });
  assert.equal(unknown.statusCode, 404, unknown.body);
  const invalid = await call(user, "POST", `/api/people/${sam}/merge`, "/api/people/:id/merge", "invalid-input", {});
  assert.equal(invalid.statusCode, 400, invalid.body);
  const same = await call(user, "POST", `/api/people/${sam}/merge`, "/api/people/:id/merge", "invalid-input", { otherId: sam });
  assert.equal(same.statusCode, 400, same.body);
  const merged = await call(user, "POST", `/api/people/${sam}/merge`, "/api/people/:id/merge", "happy-path", { otherId: teamsSam });
  assert.equal(merged.statusCode, 200, merged.body);
  assert.equal(await db.person.findUnique({ where: { id: teamsSam! } }), null);
  assert.deepEqual((await db.task.findUnique({ where: { id: task.id } }))!.people, [sam]);
  assert.deepEqual((await db.meetingNote.findUnique({ where: { id: note.id } }))!.personIds, [sam]);
  assert.deepEqual((await db.meetingSession.findUnique({ where: { id: session.id } }))!.personIds, [sam]);
  assert.equal((await db.artifact.findUnique({ where: { id: artifact.id } }))!.actorId, sam);
  assert.ok(await db.projectPerson.findUnique({ where: { projectId_personId: { projectId: project.id, personId: sam! } } }));
  const samIds = await db.personIdentity.findMany({ where: { personId: sam! } });
  assert.ok(samIds.some((row) => row.kind === "teams" && row.value === "sam-guid" && row.suggestedPersonId === null));
  assert.equal(await upsertPerson(user.id, { name: "Sam", handle: "teams:sam-guid", at, evidence: "teams:chat-3" }, self), sam, "the moved handle keeps resolving");
});

test("suggestions can be dismissed and stay dismissed", async () => {
  const user = await mira("dismiss");
  const other = await mira("dismiss-other");
  const at = hoursAgo(2);
  const a = await upsertPerson(user.id, { email: "lee.park@fieldnote.example", name: "Lee Park", at, evidence: "gmail:1" }, [user.email]);
  const b = await upsertPerson(user.id, { email: "lee@personal.example", name: "Lee Park", at, evidence: "gmail:2" }, [user.email]);
  const before = (await call(user, "GET", "/api/people/identity-suggestions", "/api/people/identity-suggestions", "happy-path")).json<{ suggestions: Array<{ reason: string }> }>();
  assert.ok(before.suggestions.some((row) => row.reason === "same-name"));
  const bad = await call(user, "POST", "/api/people/identity-suggestions/dismiss", "/api/people/identity-suggestions/dismiss", "invalid-input", { personId: a });
  assert.equal(bad.statusCode, 400, bad.body);
  const foreign = await call(other, "POST", "/api/people/identity-suggestions/dismiss", "/api/people/identity-suggestions/dismiss", "isolation", { personId: a, otherId: b });
  assert.equal(foreign.statusCode, 404, foreign.body);
  const ok = await call(user, "POST", "/api/people/identity-suggestions/dismiss", "/api/people/identity-suggestions/dismiss", "happy-path", { personId: b, otherId: a });
  assert.equal(ok.statusCode, 200, ok.body);
  const after = (await user.inject({ method: "GET", url: "/api/people/identity-suggestions" })).json<{ suggestions: unknown[] }>();
  assert.deepEqual(after.suggestions, []);
});

// ── project links ──────────────────────────────────────────────────────────

test("project links: set once, applied to new artifacts and proposals at ingest, and to what arrived before", async () => {
  const user = await mira("links");
  const other = await mira("links-other");
  const atlas = await db.project.create({ data: { userId: user.id, name: "Project Atlas" } });
  const foreignProject = await db.project.create({ data: { userId: other.id, name: "Not yours" } });

  // A #design message arrived before the link.
  const early = await stored(user.id, {
    kind: "channel_msg",
    externalId: "C0DESIGN:1",
    ts: hoursAgo(3),
    title: "#design · Arjun Rao",
    text: "Can you review the mockups?",
    containers: [{ source: "slack", id: "C0DESIGN", name: "#design" }],
  });
  assert.equal(early.projectId, null);
  await createProposals(user.id, [{ sourceRef: "slack:thread:C0DESIGN:1", sourceKind: "slack", title: "Review the mockups", description: "", priority: "p1", artifactId: early.id, rationale: "asked" }], "heuristic");
  await upsertArtifact(user.id, { kind: "pr", externalId: "fieldnote/atlas#7", ts: hoursAgo(1), title: "Add importer", text: "", containers: [{ source: "github", id: "fieldnote/atlas", name: "Fieldnote/Atlas" }] });
  await upsertArtifact(other.id, { kind: "channel_msg", externalId: "C0SECRET:1", ts: hoursAgo(1), title: "#secret", text: "", containers: [{ source: "slack", id: "C0SECRET", name: "#secret" }] });

  const containers = await call(user, "GET", "/api/project-links/containers?source=slack", "/api/project-links/containers", "happy-path");
  assert.equal(containers.statusCode, 200, containers.body);
  const listed = containers.json<{ containers: Array<{ id: string; name: string; count: number; projectId: string | null }> }>().containers;
  assert.deepEqual(listed.map((row) => [row.id, row.name, row.count, row.projectId]), [["C0DESIGN", "#design", 1, null]]);
  const all = (await call(user, "GET", "/api/project-links/containers", "/api/project-links/containers", "isolation")).json<{ containers: Array<{ id: string }> }>();
  assert.ok(!all.containers.some((row) => row.id === "C0SECRET"), "another account's channels never show");
  assert.ok(all.containers.some((row) => row.id === "fieldnote/atlas"));
  const badSource = await call(user, "GET", "/api/project-links/containers?source=myspace", "/api/project-links/containers", "invalid-input");
  assert.equal(badSource.statusCode, 400, badSource.body);

  const invalid = await call(user, "POST", "/api/project-links", "/api/project-links", "invalid-input", { projectId: atlas.id, source: "myspace", containerId: "x" });
  assert.equal(invalid.statusCode, 400, invalid.body);
  const crossed = await call(user, "POST", "/api/project-links", "/api/project-links", "relation-isolation", { projectId: foreignProject.id, source: "slack", containerId: "C0DESIGN" });
  assert.equal(crossed.statusCode, 404, crossed.body);
  const created = await call(user, "POST", "/api/project-links", "/api/project-links", "happy-path", { projectId: atlas.id, source: "slack", containerId: "C0DESIGN", containerName: "#design" });
  assert.equal(created.statusCode, 201, created.body);
  const link = created.json<{ link: { id: string; containerName: string }; applied: { artifacts: number; tasks: number } }>();
  assert.deepEqual(link.applied, { artifacts: 1, tasks: 1 });
  assert.equal((await db.artifact.findUnique({ where: { id: early.id } }))!.projectId, atlas.id);
  assert.equal((await db.task.findFirst({ where: { userId: user.id, sourceRef: "slack:thread:C0DESIGN:1" } }))!.projectId, atlas.id);
  // GitHub names are case-insensitive and an import's "repo:" prefix is dropped.
  const repo = await call(user, "POST", "/api/project-links", "/api/project-links", "happy-path", { projectId: atlas.id, source: "github", containerId: "repo:Fieldnote/Atlas" });
  assert.equal(repo.statusCode, 201, repo.body);

  // New items from linked containers land in the project, and so do their proposals.
  const later = await stored(user.id, { kind: "channel_msg", externalId: "C0DESIGN:2", ts: new Date(), title: "#design", text: "Ship it?", containers: [{ source: "slack", id: "C0DESIGN", name: "#design" }] });
  assert.equal(later.projectId, atlas.id);
  const pr = await stored(user.id, { kind: "pr", externalId: "fieldnote/atlas#8", ts: new Date(), title: "Fix", text: "", containers: [{ source: "github", id: "fieldnote/atlas", name: "Fieldnote/Atlas" }] });
  assert.equal(pr.projectId, atlas.id);
  await createProposals(user.id, [{ sourceRef: "github:fieldnote/atlas#8:reviewer", sourceKind: "github", title: "Review #8", description: "", priority: "p1", artifactId: pr.id, rationale: "review" }], "connector");
  assert.equal((await db.task.findFirst({ where: { userId: user.id, sourceRef: "github:fieldnote/atlas#8:reviewer" } }))!.projectId, atlas.id);

  const mine = await call(user, "GET", `/api/project-links?projectId=${atlas.id}`, "/api/project-links", "happy-path");
  assert.deepEqual(mine.json<{ links: Array<{ source: string; containerId: string }> }>().links.map((row) => `${row.source}:${row.containerId}`).sort(), ["github:fieldnote/atlas", "slack:C0DESIGN"]);
  const theirs = await call(other, "GET", "/api/project-links", "/api/project-links", "isolation");
  assert.deepEqual(theirs.json<{ links: unknown[] }>().links, []);

  const foreignDelete = await call(other, "DELETE", `/api/project-links/${link.link.id}`, "/api/project-links/:id", "isolation");
  assert.equal(foreignDelete.statusCode, 404, foreignDelete.body);
  const unknownDelete = await call(user, "DELETE", `/api/project-links/${randomUUID()}`, "/api/project-links/:id", "unknown-id");
  assert.equal(unknownDelete.statusCode, 404, unknownDelete.body);
  const removed = await call(user, "DELETE", `/api/project-links/${link.link.id}`, "/api/project-links/:id", "happy-path");
  assert.equal(removed.statusCode, 204, removed.body);
  const unlinked = await stored(user.id, { kind: "channel_msg", externalId: "C0DESIGN:3", ts: new Date(), title: "#design", text: "x", containers: [{ source: "slack", id: "C0DESIGN" }] });
  assert.equal(unlinked.projectId, null);

  // Imports remember the container a project came from; a later import of the same board reuses the linked project.
  await rememberImportLink(db, user.id, atlas.id, "trello", "board-123", "Atlas board");
  assert.equal(await linkedProject(db, user.id, "trello", "board-123"), atlas.id);
  await rememberImportLink(db, user.id, randomUUID(), "csv", "x", "ignored");
  assert.equal(await db.projectLink.count({ where: { userId: user.id, source: "csv" } }), 0);
});

// ── meeting-notes connectors ───────────────────────────────────────────────

type Fixture = {
  vendor: "fireflies" | "fathom" | "granola" | "tldv" | "krisp" | "jamie" | "otter";
  key: string;
  /** `me` is the account's own address, as the vendor would report it. */
  install: (me: string) => void;
  meetingId: string;
};

const START = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 26 * 3_600_000);
const iso = (offsetMin: number) => new Date(START.getTime() + offsetMin * 60_000).toISOString();
const ARJUN = { name: "Arjun Rao", email: "arjun@fieldnote.example" };

const FIXTURES: Fixture[] = [
  {
    vendor: "fireflies",
    key: "ff-key-0123456789",
    meetingId: "ff-meeting-1",
    install: (me) => {
      mock("https://api.fireflies.ai/graphql", async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("user {")) return Response.json({ data: { user: { user_id: "u1", email: me, name: "Mira Chen" } } });
        return Response.json({
          data: {
            transcripts: [
              {
                id: "ff-meeting-1",
                title: "Atlas design review",
                date: START.getTime() + 60_000,
                duration: 29,
                transcript_url: "https://app.fireflies.ai/view/ff-meeting-1",
                organizer_email: me,
                participants: ["arjun@fieldnote.example"],
                meeting_attendees: [{ displayName: "Arjun Rao", email: "arjun@fieldnote.example" }],
                sentences: [{ speaker_name: "Arjun Rao", text: "The importer is ready.", start_time: 30 }],
                summary: { overview: "Reviewed the importer.\n\n## Decisions\n- Ship the importer Friday", action_items: "**Mira Chen**\nSend the release note (10:00)\n\n**Arjun Rao**\nFix the CSV edge case (12:00)" },
              },
            ],
          },
        });
      });
    },
  },
  {
    vendor: "fathom",
    key: "fathom-key-0123456789",
    meetingId: "987654",
    install: (me) => {
      mock("https://api.fathom.ai/external/v1/meetings", () =>
        Response.json({
          next_cursor: null,
          items: [
            {
              title: "Fathom recording",
              meeting_title: "Atlas design review",
              recording_id: 987654,
              url: "https://fathom.video/calls/987654",
              share_url: "https://fathom.video/share/987654",
              recording_start_time: iso(2),
              recording_end_time: iso(30),
              calendar_invitees: [ARJUN],
              recorded_by: { name: "Mira Chen", email: me },
              transcript: [{ speaker: { display_name: "Arjun Rao", matched_calendar_invitee_email: "arjun@fieldnote.example" }, text: "Ready.", timestamp: "00:00:30" }],
              default_summary: { markdown_formatted: "## Summary\nReviewed the importer." },
              action_items: [
                { description: "Send the release note", completed: false, recording_timestamp: "00:10:00", recording_playback_url: "https://fathom.video/calls/987654?timestamp=600", assignee: { name: "Mira Chen", email: me } },
                { description: "Fix the CSV edge case", completed: false, recording_timestamp: "00:12:00", recording_playback_url: "https://fathom.video/calls/987654?timestamp=720", assignee: ARJUN },
              ],
            },
          ],
        }),
      );
    },
  },
  {
    vendor: "granola",
    key: "grn_key_0123456789",
    meetingId: "not_atlasreview01",
    install: (me) => {
      mock("https://public-api.granola.ai/v1/notes?", (url) =>
        url.includes("page_size=1&") || url.endsWith("page_size=1")
          ? Response.json({ notes: [{ id: "not_atlasreview01", owner: { name: "Mira Chen", email: me } }], hasMore: false, cursor: null })
          : Response.json({ notes: [{ id: "not_atlasreview01", deleted_at: null }], hasMore: false, cursor: null }),
      );
      mock("https://public-api.granola.ai/v1/notes/not_atlasreview01", () =>
        Response.json({
          id: "not_atlasreview01",
          title: "Atlas design review",
          owner: { name: "Mira Chen", email: me },
          created_at: iso(0),
          web_url: "https://notes.granola.ai/d/not_atlasreview01",
          calendar_event: { event_title: "Atlas design review", invitees: [{ email: "arjun@fieldnote.example" }], organiser: me, calendar_event_id: "evt-granola-elsewhere", scheduled_start_time: iso(0), scheduled_end_time: iso(30) },
          attendees: [ARJUN],
          summary_markdown: "## Next steps\n- Mira Chen: send the release note\n- Arjun Rao: fix the CSV edge case",
          transcript: [{ speaker: { source: "speaker", attribution: "them" }, text: "Ready.", start_time: iso(1) }],
        }),
      );
    },
  },
  {
    vendor: "tldv",
    key: "tldv-key-0123456789",
    meetingId: "tldv-meeting-1",
    install: (me) => {
      mock("https://pasta.tldv.io/v1alpha1/meetings?", () =>
        Response.json({ page: 1, pages: 1, total: 1, results: [{ id: "tldv-meeting-1", name: "Atlas design review", happenedAt: iso(0), url: "https://tldv.io/app/meetings/tldv-meeting-1", duration: 1800, organizer: { name: "Mira Chen", email: me }, invitees: [ARJUN] }] }),
      );
      mock("https://pasta.tldv.io/v1alpha1/meetings/tldv-meeting-1/transcript", () => Response.json({ id: "t1", meetingId: "tldv-meeting-1", data: [{ speaker: "Arjun Rao", text: "Ready.", startTime: 30, endTime: 32 }] }));
      mock("https://pasta.tldv.io/v1alpha1/meetings/tldv-meeting-1/notes", () => Response.json({ markdownContent: "## Action items\n- Mira Chen: send the release note\n- Arjun Rao: fix the CSV edge case", structuredNotes: [], topics: [] }));
    },
  },
  {
    vendor: "krisp",
    key: "krsp_u_0123456789abcdef",
    meetingId: "019a-atlas",
    install: (me) => {
      mock("https://meeting-api.krisp.ai/v1/me", () => Response.json({ id: 1, email: me, first_name: "Mira", last_name: "Chen" }));
      mock("https://meeting-api.krisp.ai/v1/meetings?", () => Response.json({ total: 1, next_cursor: null, meetings: [{ id: "019a-atlas", title: "Atlas design review", started_at: iso(0) }] }));
      mock("https://meeting-api.krisp.ai/v1/meetings/019a-atlas", () =>
        Response.json({
          id: "019a-atlas",
          title: "Atlas design review",
          started_at: iso(0),
          duration: 1800,
          participants: [{ email: "arjun@fieldnote.example", first_name: "Arjun", last_name: "Rao" }],
          transcript: { speakers: { "1": { email: "arjun@fieldnote.example", first_name: "Arjun", last_name: "Rao" } }, segments: [{ speaker: 1, text: "Ready.", start: 30 }] },
          notes: { blocks: [{ type: "action_items", children: [{ type: "action_item", text: "Send the release note", completed: false, assignee: { email: me } }, { type: "action_item", text: "Fix the CSV edge case", completed: false, assignee: { first_name: "Arjun", last_name: "Rao" } }] }] },
        }),
      );
    },
  },
  {
    vendor: "jamie",
    key: "jk_personal_0123456789",
    meetingId: "7893456789012345678",
    install: (me) => {
      mock("https://beta-api.meetjamie.ai/v1/me/meetings.list", () => Response.json({ result: { data: { json: { meetings: [{ id: "7893456789012345678", title: "Atlas design review", startTime: iso(0) }], nextCursor: null } } } }));
      mock("https://beta-api.meetjamie.ai/v1/me/meetings.get", () =>
        Response.json({
          result: {
            data: {
              json: {
                id: "7893456789012345678",
                title: "Atlas design review",
                startTime: iso(0),
                endTime: iso(30),
                summary: { markdown: "# Summary\nReviewed the importer." },
                transcript: "**Arjun Rao**\nReady.",
                participants: [ARJUN],
                tasks: [{ content: "Send the release note", completed: false, assignee: { name: "Mira Chen", email: null } }, { content: "Fix the CSV edge case", completed: false, assignee: ARJUN }],
                event: { externalId: null, title: "Atlas design review", attendees: [ARJUN] },
              },
            },
          },
        }),
      );
    },
  },
  {
    vendor: "otter",
    key: "otter-key-0123456789",
    meetingId: "otter-conv-1",
    install: (me) => {
      mock("https://api.otter.ai/v1/conversations?", () => Response.json({ meta: { has_more: false }, data: [{ id: "otter-conv-1", created_at: iso(0), owner: { name: "Mira Chen", email: me } }] }));
      mock("https://api.otter.ai/v1/conversations/otter-conv-1", () =>
        Response.json({
          data: {
            id: "otter-conv-1",
            title: "Atlas design review",
            url: "https://otter.ai/u/otter-conv-1",
            owner: { name: "Mira Chen", email: me },
            created_at: iso(0),
            calendar_guests: [ARJUN],
            abstract_summary: "Reviewed the importer.",
            relationships: {
              action_items: [{ id: "a1", text: "Send the release note", assignee: { name: "Mira Chen", email: me } }, { id: "a2", text: "Fix the CSV edge case", assignee: ARJUN }],
              transcript: { content: "Arjun Rao  00:30\nReady.", format: "txt" },
            },
          },
        }),
      );
    },
  },
];

async function calendarEvent(userId: string, externalId: string, title: string) {
  return db.artifact.create({
    data: {
      userId,
      kind: "event",
      externalId,
      ts: START,
      title,
      url: `https://calendar.google.com/event?eid=${externalId}`,
      participants: [{ name: "Arjun Rao", email: "arjun@fieldnote.example" }],
      metadata: { source: "google", end: iso(30) },
    },
  });
}

async function requestedImport(user: HttpUser, source: string) {
  const result = await importRequestedMeetings(user.id, source as import("../connectors/meetings/types.js").MeetingVendor, new Date(0), true);
  return { statusCode: 200, body: JSON.stringify(result), json: <T,>() => result as T };
}

for (const fixture of FIXTURES) {
  test(`${fixture.vendor}: pasted key, explicit import, matched meeting note, requested action item proposed once`, async () => {
    resetMocks();
    const user = await mira(fixture.vendor);
    fixture.install(user.email);
    const review = await calendarEvent(user.id, `evt-${fixture.vendor}`, "Atlas design review");
    // A same-time event with no shared attendees and a different title must not win.
    await db.artifact.create({ data: { userId: user.id, kind: "event", externalId: `evt-focus-${fixture.vendor}`, ts: START, title: "Focus time", metadata: { source: "google", end: iso(60) } } });

    const connected = await user.inject({ method: "POST", url: `/api/connectors/${fixture.vendor}/token`, payload: { token: fixture.key } });
    assert.equal(connected.statusCode, 200, connected.body);
    const contacts = await user.inject({ method: "POST", url: `/api/connections/${fixture.vendor}/sync` });
    assert.equal(contacts.json().items,0); assert.equal(await db.meetingNote.count({where:{userId:user.id}}),0);
    const synced = await requestedImport(user,fixture.vendor);
    assert.equal(synced.statusCode, 200, synced.body);
    const outcome = synced.json<{ ok: boolean; message: string; proposed?: number }>();
    assert.equal(outcome.ok, true, outcome.message);
    assert.equal(outcome.proposed, 1, outcome.message);

    const note = await db.meetingNote.findFirst({ where: { userId: user.id, externalSource: fixture.vendor, externalId: fixture.meetingId } });
    assert.ok(note, `meeting note for ${fixture.vendor}`);
    assert.equal(note.source, "connector");
    assert.equal(note.title, "Atlas design review");
    assert.equal(note.eventArtifactId, review.id, `${fixture.vendor} matched the calendar event`);
    const transcript = await db.artifact.findFirst({ where: { userId: user.id, kind: "transcript", externalId: `${fixture.vendor}:${fixture.meetingId}` } });
    assert.ok(transcript);
    assert.equal(note.transcriptArtifactId, transcript.id);
    const arjun = await db.person.findFirst({ where: { userId: user.id, email: "arjun@fieldnote.example" } });
    assert.ok(arjun && note.personIds.includes(arjun.id), "attendees resolve to people");
    const extraction = note.extraction as { actionItems: Array<{ text: string; mine: boolean }>; waitingOn: Array<{ text: string; owner: { name: string | null } }> };
    assert.deepEqual(extraction.actionItems.map((item) => item.mine), [true, false]);
    assert.equal(extraction.waitingOn.length, 1);
    assert.match(extraction.waitingOn[0]!.text, /csv edge case/i);

    const tasks = await db.task.findMany({ where: { userId: user.id, meetingNoteId: note.id } });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.status, "proposed");
    assert.equal(tasks[0]!.sourceKind, "meeting");
    assert.match(tasks[0]!.title, /send the release note/i);
    assert.ok(tasks[0]!.excerpt);
    assert.ok(tasks[0]!.sourceUrl);

    // Sync again: updated in place, nothing proposed twice.
    const again = await requestedImport(user,fixture.vendor);
    assert.equal(again.json<{ ok: boolean }>().ok, true, again.body);
    assert.equal(await db.task.count({ where: { userId: user.id, meetingNoteId: note.id } }), 1);
    assert.equal(await db.meetingNote.count({ where: { userId: user.id, externalSource: fixture.vendor } }), 1);
    assert.equal(await db.artifact.count({ where: { userId: user.id, kind: "transcript" } }), 1);
  });
}

test("a rejected key is not stored; deleting a meeting note keeps it deleted on the next sync", async () => {
  resetMocks();
  const user = await mira("rejected");
  mock("https://api.fathom.ai/external/v1/meetings", () => new Response(JSON.stringify({ error: "nope" }), { status: 401 }));
  const refused = await user.inject({ method: "POST", url: "/api/connectors/fathom/token", payload: { token: "fathom-bad-0123456789" } });
  assert.equal(refused.statusCode, 400, refused.body);
  assert.match(refused.json<{ error: string }>().error, /Fathom rejected that key/);
  assert.equal(await db.authToken.count({ where: { userId: user.id, provider: "fathom" } }), 0);

  resetMocks();
  FIXTURES.find((row) => row.vendor === "fireflies")!.install(user.email);
  await user.inject({ method: "POST", url: "/api/connectors/fireflies/token", payload: { token: "ff-key-0123456789" } });
  await requestedImport(user,"fireflies");
  const note = await db.meetingNote.findFirstOrThrow({ where: { userId: user.id, externalSource: "fireflies" } });
  assert.equal(note.eventArtifactId, null, "no calendar event to match");
  const task = await db.task.findFirstOrThrow({ where: { userId: user.id, meetingNoteId: note.id } });
  await db.task.update({ where: { id: task.id }, data: { deletedAt: new Date() } });
  await db.meetingNote.update({ where: { id: note.id }, data: { deletedAt: new Date() } });
  await db.syncState.deleteMany({ where: { userId: user.id } });
  const again = await requestedImport(user,"fireflies");
  assert.equal(again.json<{ ok: boolean }>().ok, true, again.body);
  assert.ok((await db.meetingNote.findUniqueOrThrow({ where: { id: note.id } })).deletedAt, "still deleted");
  assert.equal(await db.task.count({ where: { userId: user.id, deletedAt: null } }), 0, "a dismissed action item is not proposed again");

  // Disconnect with "delete what was read" removes transcripts and meeting notes; the todo stays.
  const removed = await user.inject({ method: "DELETE", url: "/api/connectors/fireflies?deleteData=1" });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(await db.meetingNote.count({ where: { userId: user.id } }), 0);
  assert.equal(await db.artifact.count({ where: { userId: user.id, kind: "transcript" } }), 0);
  assert.equal(await db.task.count({ where: { userId: user.id } }), 1);
});

test("meeting routes list imported notes with decisions, action items and the matched event, per account", async () => {
  resetMocks();
  const user = await mira("routes");
  const other = await mira("routes-other");
  FIXTURES.find((row) => row.vendor === "fireflies")!.install(user.email);
  const review = await calendarEvent(user.id, "evt-routes", "Atlas design review");
  await user.inject({ method: "POST", url: "/api/connectors/fireflies/token", payload: { token: "ff-key-0123456789" } });
  await requestedImport(user,"fireflies");

  const listed = await call(user, "GET", "/api/meetings/imported", "/api/meetings/imported", "happy-path");
  assert.equal(listed.statusCode, 200, listed.body);
  const [note] = listed.json<{ notes: Array<{ id: string; sourceLabel: string; decisions: string[]; actionItems: Array<{ mine: boolean }>; waitingOn: Array<{ owner: { name: string } }>; event: { id: string } | null; tasks: Array<{ id: string }> }> }>().notes;
  assert.ok(note);
  assert.equal(note.sourceLabel, "Fireflies.ai");
  assert.deepEqual(note.decisions, ["Ship the importer Friday"]);
  assert.equal(note.event?.id, review.id);
  assert.equal(note.waitingOn[0]?.owner.name, "Arjun Rao");
  assert.equal(note.tasks.length, 1);
  const foreignList = await call(other, "GET", "/api/meetings/imported", "/api/meetings/imported", "isolation");
  assert.deepEqual(foreignList.json<{ notes: unknown[] }>().notes, []);

  const one = await call(user, "GET", `/api/meetings/notes/${note.id}`, "/api/meetings/notes/:id", "happy-path");
  assert.equal(one.statusCode, 200, one.body);
  assert.equal(one.json<{ note: { id: string } }>().note.id, note.id);
  const foreignOne = await call(other, "GET", `/api/meetings/notes/${note.id}`, "/api/meetings/notes/:id", "isolation");
  assert.equal(foreignOne.statusCode, 404, foreignOne.body);
  const unknown = await call(user, "GET", `/api/meetings/notes/${randomUUID()}`, "/api/meetings/notes/:id", "unknown-id");
  assert.equal(unknown.statusCode, 404, unknown.body);

  // The task carries the meeting it came from.
  const task = await user.inject({ method: "GET", url: `/api/tasks/${note.tasks[0]!.id}` });
  assert.equal(task.json<{ task: { meetingNoteId: string } }>().task.meetingNoteId, note.id);
});

// ── transcripts: files, pastes, Teams, Google Meet ─────────────────────────

const { saveAccount } = await import("../connectors/accounts.js");

const ATLAS_VTT = `WEBVTT

a1/1-0
00:00:03.000 --> 00:00:06.000
<v Mira Chen>Let's review the Atlas launch.</v>

a1/2-0
00:00:07.000 --> 00:00:11.000
<v Arjun Rao>The CSV fix is on staging. I'll send the release note tomorrow.</v>
`;

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

async function teamsEvent(userId: string, joinUrl: string) {
  return db.artifact.create({
    data: {
      userId,
      kind: "event",
      externalId: `outlook:evt-${randomUUID().slice(0, 8)}`,
      ts: START,
      title: "Atlas launch review",
      participants: [{ name: "Arjun Rao", email: "arjun@fieldnote.example" }],
      metadata: { source: "outlook", end: iso(30), joinUrl },
    },
  });
}

type NoteJson = {
  id: string;
  source: string;
  sourceLabel: string;
  title: string;
  event: { id: string } | null;
  people: Array<{ id: string; name: string }>;
  speakers: string[];
  lineCount: number;
  suggested: boolean;
  actionItems: Array<{ text: string; owner: { name: string | null } | null; taskId: string | null }>;
  transcript?: Array<{ speaker: string; text: string; at: string | null }>;
};

test("a Teams .vtt upload becomes a meeting note: preview, speakers as people, the calendar event, the whole transcript", async () => {
  resetMocks();
  const user = await mira("transcript-file");
  const other = await mira("transcript-file-other");
  const event = await teamsEvent(user.id, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_atlas%40thread.v2/0");
  const file = { filename: "Atlas launch review-20261103_150302-Meeting Transcript.vtt", dataBase64: b64(ATLAS_VTT) };

  const preview = await call(user, "POST", "/api/meetings/transcripts/preview", "/api/meetings/transcripts/preview", "happy-path", file);
  assert.equal(preview.statusCode, 200, preview.body);
  const shown = preview.json<{ preview: { format: string; title: string; lineCount: number; speakers: Array<{ name: string; me: boolean }> } }>().preview;
  assert.equal(shown.format, "teams-vtt");
  assert.equal(shown.title, "Atlas launch review");
  assert.deepEqual(shown.speakers.map((row) => [row.name, row.me]), [["Mira Chen", true], ["Arjun Rao", false]]);
  const wrongType = await call(user, "POST", "/api/meetings/transcripts/preview", "/api/meetings/transcripts/preview", "invalid-input", { filename: "atlas.mp4", dataBase64: b64("x") });
  assert.equal(wrongType.statusCode, 400, wrongType.body);
  assert.match(wrongType.json<{ error: string }>().error, /\.vtt, \.srt, \.txt, \.docx or \.json/);

  const imported = await call(user, "POST", "/api/meetings/transcripts", "/api/meetings/transcripts", "happy-path", { ...file, eventId: event.id });
  assert.equal(imported.statusCode, 201, imported.body);
  const note = imported.json<{ note: NoteJson }>().note;
  assert.equal(note.source, "transcript");
  assert.equal(note.sourceLabel, "Microsoft Teams transcript (.vtt)");
  assert.equal(note.event?.id, event.id);
  assert.deepEqual(note.speakers, ["Mira Chen", "Arjun Rao"]);
  assert.deepEqual(note.people.map((row) => row.name), ["Arjun Rao"], "Arjun is the event's attendee; Mira is me");
  assert.equal(note.suggested, true);
  assert.deepEqual(note.actionItems.map((item) => [item.text, item.owner?.name]), [["I'll send the release note tomorrow.", "Arjun Rao"]]);
  const stored = await db.meetingNote.findUniqueOrThrow({ where: { id: note.id } });
  assert.equal(stored.source, "upload");
  const arjun = await db.person.findFirstOrThrow({ where: { userId: user.id, email: "arjun@fieldnote.example" } });
  assert.deepEqual(stored.personIds, [arjun.id]);

  const again = await user.inject({ method: "POST", url: "/api/meetings/transcripts", payload: file });
  assert.equal(again.json<{ note: { id: string } }>().note.id, note.id, "the same file updates its note");
  const foreignEvent = await call(other, "POST", "/api/meetings/transcripts", "/api/meetings/transcripts", "relation-isolation", { ...file, eventId: event.id });
  assert.equal(foreignEvent.statusCode, 404, foreignEvent.body);
  const empty = await call(user, "POST", "/api/meetings/transcripts", "/api/meetings/transcripts", "invalid-input", { text: "   " });
  assert.equal(empty.statusCode, 400, empty.body);

  const read = await user.inject({ method: "GET", url: `/api/meetings/notes/${note.id}` });
  assert.deepEqual(read.json<{ note: NoteJson }>().note.transcript, [
    { speaker: "Mira Chen", text: "Let's review the Atlas launch.", at: "00:03" },
    { speaker: "Arjun Rao", text: "The CSV fix is on staging. I'll send the release note tomorrow.", at: "00:07" },
  ]);
});

test("a pasted Teams transcript: action items become tasks once, and the note can be deleted and restored", async () => {
  resetMocks();
  const user = await mira("transcript-paste");
  const other = await mira("transcript-paste-other");
  const pasted = await user.inject({
    method: "POST",
    url: "/api/meetings/transcripts",
    payload: { text: "Arjun Rao  0:03 Could you review the migration plan?\nMira Chen  0:09 Yes. We agreed to keep Postgres.\n", title: "Migration sync", occurredAt: iso(0), addPeople: ["Arjun Rao"] },
  });
  assert.equal(pasted.statusCode, 201, pasted.body);
  const note = pasted.json<{ note: NoteJson }>().note;
  assert.equal(note.title, "Migration sync");
  assert.equal(note.sourceLabel, "Copied from a Teams transcript");
  assert.deepEqual(note.people.map((row) => row.name), ["Arjun Rao"], "added to People when asked");
  assert.equal((await db.meetingNote.findUniqueOrThrow({ where: { id: note.id } })).source, "paste");

  const item = note.actionItems[0]!;
  const made = await call(user, "POST", `/api/meetings/notes/${note.id}/tasks`, "/api/meetings/notes/:id/tasks", "happy-path", { text: item.text });
  assert.equal(made.statusCode, 201, made.body);
  const task = made.json<{ task: { id: string; title: string; status: string } }>().task;
  assert.equal(task.title, "Could you review the migration plan?");
  assert.equal(task.status, "todo");
  const row = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(row.meetingNoteId, note.id);
  assert.equal(row.sourceKind, "meeting");
  const twice = await user.inject({ method: "POST", url: `/api/meetings/notes/${note.id}/tasks`, payload: { text: item.text } });
  assert.equal(twice.json<{ task: { id: string }; created: boolean }>().task.id, task.id);
  assert.equal(twice.json<{ created: boolean }>().created, false);
  const linked = await user.inject({ method: "GET", url: `/api/meetings/notes/${note.id}` });
  assert.equal(linked.json<{ note: NoteJson }>().note.actionItems[0]!.taskId, task.id);
  const foreignTask = await call(other, "POST", `/api/meetings/notes/${note.id}/tasks`, "/api/meetings/notes/:id/tasks", "isolation", { text: item.text });
  assert.equal(foreignTask.statusCode, 404, foreignTask.body);
  const tooShort = await call(user, "POST", `/api/meetings/notes/${note.id}/tasks`, "/api/meetings/notes/:id/tasks", "invalid-input", { text: "x" });
  assert.equal(tooShort.statusCode, 400, tooShort.body);
  const unknownTask = await call(user, "POST", `/api/meetings/notes/${randomUUID()}/tasks`, "/api/meetings/notes/:id/tasks", "unknown-id", { text: item.text });
  assert.equal(unknownTask.statusCode, 404, unknownTask.body);

  const foreignDelete = await call(other, "DELETE", `/api/meetings/notes/${note.id}`, "/api/meetings/notes/:id", "isolation");
  assert.equal(foreignDelete.statusCode, 404, foreignDelete.body);
  const deleted = await call(user, "DELETE", `/api/meetings/notes/${note.id}`, "/api/meetings/notes/:id", "happy-path");
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal((await user.inject({ method: "GET", url: "/api/meetings/imported" })).json<{ notes: unknown[] }>().notes.length, 0);
  const unknownDelete = await call(user, "DELETE", `/api/meetings/notes/${randomUUID()}`, "/api/meetings/notes/:id", "unknown-id");
  assert.equal(unknownDelete.statusCode, 404);
  const foreignRestore = await call(other, "POST", `/api/meetings/notes/${note.id}/restore`, "/api/meetings/notes/:id/restore", "isolation");
  assert.equal(foreignRestore.statusCode, 404);
  const restored = await call(user, "POST", `/api/meetings/notes/${note.id}/restore`, "/api/meetings/notes/:id/restore", "happy-path");
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal((await user.inject({ method: "GET", url: "/api/meetings/imported" })).json<{ notes: unknown[] }>().notes.length, 1);
  const unknownRestore = await call(user, "POST", `/api/meetings/notes/${randomUUID()}/restore`, "/api/meetings/notes/:id/restore", "unknown-id");
  assert.equal(unknownRestore.statusCode, 404);
});

const GRAPH_ME = "graph-user-mira";
const JOIN = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_review%40thread.v2/0?context=%7b%7d";

async function microsoft(user: HttpUser, scopes: string[]) {
  await saveAccount(user.id, "microsoft", { accessToken: "ms-token", scopes, account: user.email, meta: { graphUserId: GRAPH_ME } });
}

function graphMeeting(organizerId: string) {
  mock("https://graph.microsoft.com/v1.0/me/onlineMeetings?", (url) => {
    assert.match(decodeURIComponent(url), /JoinWebUrl eq 'https:\/\/teams\.microsoft\.com\/l\/meetup-join/);
    return Response.json({
      value: [
        {
          id: "MSo-review",
          subject: "Atlas launch review",
          startDateTime: iso(0),
          endDateTime: iso(30),
          joinWebUrl: JOIN,
          participants: {
            organizer: { upn: organizerId === GRAPH_ME ? "mira@fieldnote.example" : "lena@fieldnote.example", identity: { user: { id: organizerId, displayName: organizerId === GRAPH_ME ? "Mira Chen" : "Lena Ortiz" } } },
            attendees: [{ upn: "arjun@fieldnote.example", identity: { user: { id: "graph-arjun", displayName: "Arjun Rao" } } }],
          },
        },
      ],
    });
  });
}

test("Teams: Get transcript on a calendar meeting imports the organizer's transcript; attendees, missing access and blocked tenants get next steps", async () => {
  resetMocks();
  const user = await mira("teams");
  const other = await mira("teams-other");
  const event = await teamsEvent(user.id, JOIN);

  const notConnected = await call(user, "POST", `/api/meetings/events/${event.id}/transcript`, "/api/meetings/events/:id/transcript", "happy-path");
  assert.equal(notConnected.json<{ problem: { code: string } }>().problem.code, "not_connected");

  await microsoft(user, ["User.Read", "Calendars.ReadWrite"]);
  const access = await user.inject({ method: "POST", url: `/api/meetings/events/${event.id}/transcript` });
  const needs = access.json<{ ok: boolean; problem: { code: string; actions: Array<{ kind: string; connector?: string; product?: string }> } }>();
  assert.equal(needs.ok, false);
  assert.equal(needs.problem.code, "needs_access");
  assert.deepEqual(needs.problem.actions[0], { kind: "connect", label: "Turn on and approve", connector: "microsoft_365", product: "teams_meetings" });

  await microsoft(user, ["User.Read", "Calendars.ReadWrite", "OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"]);
  graphMeeting(GRAPH_ME);
  mock("https://graph.microsoft.com/v1.0/me/onlineMeetings/MSo-review/transcripts", (url) =>
    url.includes("/content") ? new Response(ATLAS_VTT, { headers: { "content-type": "text/vtt" } }) : Response.json({ value: [{ id: "tr-1", createdDateTime: iso(1) }] }),
  );
  const fetched = await user.inject({ method: "POST", url: `/api/meetings/events/${event.id}/transcript` });
  const ok = fetched.json<{ ok: boolean; note: NoteJson }>();
  assert.equal(ok.ok, true, fetched.body);
  assert.equal(ok.note.source, "teams");
  assert.equal(ok.note.sourceLabel, "Microsoft Teams");
  assert.equal(ok.note.event?.id, event.id);
  assert.equal(ok.note.lineCount, 2);
  assert.ok(calls.some((url) => url.includes("/transcripts/tr-1/content?$format=text/vtt")));
  const foreign = await call(other, "POST", `/api/meetings/events/${event.id}/transcript`, "/api/meetings/events/:id/transcript", "isolation");
  assert.equal(foreign.statusCode, 404);
  const unknown = await call(user, "POST", `/api/meetings/events/${randomUUID()}/transcript`, "/api/meetings/events/:id/transcript", "unknown-id");
  assert.equal(unknown.statusCode, 404);

  // An attendee: Graph refuses, and the answer offers the organizer, Teams and pasting.
  resetMocks();
  graphMeeting("graph-lena");
  mock("https://graph.microsoft.com/v1.0/me/onlineMeetings/MSo-review/transcripts", () => Response.json({ error: { code: "Forbidden", message: "Forbidden" } }, { status: 403 }));
  const attendee = await call(user, "POST", "/api/meetings/remote/teams/import", "/api/meetings/remote/:provider/import", "happy-path", { ref: JOIN, title: "Atlas launch review" });
  const refused = attendee.json<{ ok: boolean; problem: { code: string; actions: Array<{ kind: string; email?: string; url?: string }> } }>();
  assert.equal(refused.problem.code, "not_organizer");
  assert.deepEqual(refused.problem.actions.map((action) => action.kind), ["ask_organizer", "open", "paste"]);
  assert.equal(refused.problem.actions[0]!.email, "lena@fieldnote.example");
  assert.equal(refused.problem.actions[1]!.url, JOIN);

  resetMocks();
  graphMeeting(GRAPH_ME);
  mock("https://graph.microsoft.com/v1.0/me/onlineMeetings/MSo-review/transcripts", () =>
    Response.json({ error: { code: "Forbidden", message: "Graph API access to transcripts is disabled for this tenant.", innerError: { code: "GraphAccessToTranscriptsDisabled" } } }, { status: 403 }),
  );
  const blocked = await user.inject({ method: "POST", url: "/api/meetings/remote/teams/import", payload: { ref: JOIN } });
  assert.equal(blocked.json<{ problem: { code: string } }>().problem.code, "admin_blocked");

  resetMocks();
  graphMeeting(GRAPH_ME);
  mock("https://graph.microsoft.com/v1.0/me/onlineMeetings/MSo-review/transcripts", () => Response.json({ value: [] }));
  const none = await user.inject({ method: "POST", url: "/api/meetings/remote/teams/import", payload: { ref: JOIN } });
  assert.equal(none.json<{ problem: { code: string } }>().problem.code, "no_transcript");
  const badBody = await call(user, "POST", "/api/meetings/remote/teams/import", "/api/meetings/remote/:provider/import", "invalid-input", {});
  assert.equal(badBody.statusCode, 400);

  // The list: Outlook calendar's Teams meetings, with the one already imported.
  resetMocks();
  mock("https://graph.microsoft.com/v1.0/me/calendarView?", () =>
    Response.json({ value: [{ id: "evt-graph", subject: "Atlas launch review", start: { dateTime: iso(0).replace("Z", "") }, end: { dateTime: iso(30).replace("Z", "") }, isOrganizer: true, onlineMeeting: { joinUrl: JOIN }, organizer: { emailAddress: { name: "Mira Chen" } } }] }),
  );
  const listed = await call(user, "GET", "/api/meetings/remote/teams", "/api/meetings/remote/:provider", "happy-path");
  const meetings = listed.json<{ meetings: Array<{ ref: string; eventId: string | null; noteId: string | null }> }>().meetings;
  assert.equal(meetings.length, 1, listed.body);
  assert.equal(meetings[0]!.eventId, event.id);
  assert.equal(meetings[0]!.noteId, ok.note.id);
  const otherList = await call(other, "GET", "/api/meetings/remote/teams", "/api/meetings/remote/:provider", "isolation");
  assert.equal(otherList.json<{ problem: { code: string } }>().problem.code, "not_connected");
});

test("Google Meet: a call's transcript entries become a note; no transcript and recordings say so", async () => {
  resetMocks();
  const user = await mira("meet");
  const join = "https://meet.google.com/abc-mnop-xyz";
  const event = await db.artifact.create({
    data: { userId: user.id, kind: "event", externalId: "meet-evt-1", ts: START, title: "Atlas weekly sync", participants: [{ name: "Arjun Rao", email: "arjun@fieldnote.example" }], metadata: { source: "google", end: iso(30), joinUrl: join } },
  });
  await saveAccount(user.id, "google", { accessToken: "g-token", scopes: ["openid", "email", "https://www.googleapis.com/auth/meetings.space.readonly"], account: user.email });
  const record = "conferenceRecords/rec-1";
  mock("https://meet.googleapis.com/v2/conferenceRecords?", (url) => {
    assert.match(decodeURIComponent(url), /space\.meeting_code = "abc-mnop-xyz"/);
    return Response.json({ conferenceRecords: [{ name: record, startTime: iso(1), endTime: iso(31), space: "spaces/s1" }] });
  });
  mock(`https://meet.googleapis.com/v2/${record}/transcripts?`, () => Response.json({ transcripts: [{ name: `${record}/transcripts/t1`, state: "FILE_GENERATED", docsDestination: { exportUri: "https://docs.google.com/document/d/doc1/view" } }] }));
  mock(`https://meet.googleapis.com/v2/${record}/participants`, () => Response.json({ participants: [{ name: `${record}/participants/p1`, signedinUser: { user: "users/1", displayName: "Mira Chen" } }, { name: `${record}/participants/p2`, signedinUser: { user: "users/2", displayName: "Arjun Rao" } }] }));
  mock(`https://meet.googleapis.com/v2/${record}/transcripts/t1/entries`, () =>
    Response.json({
      transcriptEntries: [
        { participant: `${record}/participants/p2`, text: "The import is done.", startTime: new Date(START.getTime() + 75_000).toISOString() },
        { participant: `${record}/participants/p1`, text: "Great, let's ship Friday.", startTime: new Date(START.getTime() + 125_000).toISOString() },
      ],
    }),
  );
  const fetched = await user.inject({ method: "POST", url: `/api/meetings/events/${event.id}/transcript` });
  const body = fetched.json<{ ok: boolean; note: NoteJson }>();
  assert.equal(body.ok, true, fetched.body);
  assert.equal(body.note.source, "google_meet");
  assert.equal(body.note.event?.id, event.id);
  const read = await user.inject({ method: "GET", url: `/api/meetings/notes/${body.note.id}` });
  assert.deepEqual(read.json<{ note: NoteJson }>().note.transcript, [
    { speaker: "Arjun Rao", text: "The import is done.", at: "00:15" },
    { speaker: "Mira Chen", text: "Great, let's ship Friday.", at: "01:05" },
  ]);

  resetMocks();
  mock("https://meet.googleapis.com/v2/conferenceRecords?", () => Response.json({ conferenceRecords: [{ name: record, startTime: iso(1), endTime: iso(31) }] }));
  mock(`https://meet.googleapis.com/v2/${record}/transcripts?`, () => Response.json({}));
  mock(`https://meet.googleapis.com/v2/${record}/recordings`, () => Response.json({ recordings: [{ name: `${record}/recordings/r1` }] }));
  const recorded = await user.inject({ method: "POST", url: `/api/meetings/events/${event.id}/transcript` });
  assert.equal(recorded.json<{ problem: { code: string } }>().problem.code, "recording_only");

  resetMocks();
  mock("https://meet.googleapis.com/v2/conferenceRecords?", () => Response.json({}));
  const missing = await user.inject({ method: "POST", url: `/api/meetings/events/${event.id}/transcript` });
  assert.equal(missing.json<{ problem: { code: string } }>().problem.code, "not_found");
});

test("meeting sources: apps, meeting-notes vendors and their state; vendor imports need a connection", async () => {
  resetMocks();
  const user = await mira("sources");
  await saveAccount(user.id, "microsoft", { accessToken: "ms-token", scopes: ["User.Read", "Calendars.ReadWrite"], account: user.email, meta: { graphUserId: GRAPH_ME } });
  const sources = await call(user, "GET", "/api/meetings/sources", "/api/meetings/sources", "happy-path");
  assert.equal(sources.statusCode, 200, sources.body);
  const body = sources.json<{ apps: Array<{ id: string; state: string }>; vendors: Array<{ id: string; connected: boolean }>; calendar: boolean }>();
  assert.deepEqual(Object.fromEntries(body.apps.map((row) => [row.id, row.state])), { teams: "needs_access", google_meet: "not_connected", zoom: "not_connected" });
  assert.ok(body.vendors.some((row) => row.id === "granola" && !row.connected));
  assert.equal(body.calendar, true);
  const other = await mira("sources-other");
  const foreign = await call(other, "GET", "/api/meetings/sources", "/api/meetings/sources", "isolation");
  assert.equal(foreign.json<{ apps: Array<{ state: string }> }>().apps[0]!.state, "not_connected");

  const notConnected = await call(user, "POST", "/api/meetings/vendors/fireflies/import", "/api/meetings/vendors/:vendor/import", "happy-path", {});
  assert.equal(notConnected.statusCode, 409, notConnected.body);
  assert.match(notConnected.json<{ error: string }>().error, /Fireflies is not connected/);
  const unknown = await call(user, "POST", "/api/meetings/vendors/notes-app/import", "/api/meetings/vendors/:vendor/import", "invalid-input", {});
  assert.equal(unknown.statusCode, 404);
  FIXTURES.find((row) => row.vendor === "fireflies")!.install(other.email);
  await other.inject({ method: "POST", url: "/api/connectors/fireflies/token", payload: { token: "ff-key-0123456789" } });
  const imported = await call(other, "POST", "/api/meetings/vendors/fireflies/import", "/api/meetings/vendors/:vendor/import", "isolation", { days: 90 });
  assert.equal(imported.json<{ items: number }>().items, 1, imported.body);
  assert.equal(await db.meetingNote.count({ where: { userId: user.id, externalSource: "fireflies" } }), 0);
});
