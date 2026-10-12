/**
 * Items from connected apps over HTTP, as Files → From your apps uses them: list them without
 * uploaded files, a page at a time; read one; remove one so no reader shows it and a later sync
 * does not bring it back; attach it again to restore it. Someone the space is shared with reads
 * the shared kinds and cannot remove anything. Fictional data: Mira Chen at Fieldnote.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import type { FileRecord } from "@ensemble/shared-types";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { artifactRouteCoverage, type RouteCheck } from "../test/route-coverage.js";
import { MISSING_ID } from "../lib/route-inventory.js";

const originalEnv = { ...process.env };
process.env.NODE_ENV = "test";
process.env.HUB_WEB_ORIGIN = "http://hub.example.test";
process.env.HUB_API_PUBLIC_URL = "http://api.example.test";

const harness: HttpHarness = await createHttpHarness();
const db = harness.prisma;
const { upsertArtifact } = await import("../connectors/ingest.js");
const { saveAccount } = await import("../connectors/accounts.js");
const { fileTextSettled } = await import("../files/extract.js");
const bridge = await import("../bridge/service.js");

const covered = new Map<string, Set<RouteCheck>>();
function claim(route: string, ...checks: RouteCheck[]): void {
  const set = covered.get(route) ?? new Set<RouteCheck>();
  for (const check of checks) set.add(check);
  covered.set(route, set);
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const handlers: Array<{ match: (url: string) => boolean; reply: Handler }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return realFetch(input, init);
  const handler = handlers.find((row) => row.match(url));
  if (!handler) return new Response(JSON.stringify({ message: `unmocked ${url}` }), { status: 599 });
  return handler.reply(url, init);
}) as typeof fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Later mocks win, so the most specific addresses come last. */
function mock(prefix: string, reply: Handler): void {
  handlers.unshift({ match: (url) => url.startsWith(prefix), reply });
}

after(async () => {
  try {
    for (const [route, checks] of Object.entries(artifactRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted artifact coverage claim: ${check} ${route}`);
    }
  } finally {
    globalThis.fetch = realFetch;
    await harness.close();
    process.env = originalEnv;
  }
});

async function person(name: string): Promise<HttpUser> {
  const user = await harness.asUser();
  await db.user.update({ where: { id: user.id }, data: { name, onboardingRole: "student", onboardingCompletedAt: new Date(), emailVerifiedAt: new Date() } });
  return user;
}

/** A request as `user`, inside someone else's space when `space` is set. */
function as(user: HttpUser, request: InjectOptions, space?: string) {
  const cookie = space ? `${user.cookie}; ensemble_space=${space}` : user.cookie;
  return harness.app.inject({ ...request, headers: { ...(request.headers as Record<string, string>), cookie } });
}

async function ok<T>(res: Promise<{ statusCode: number; body: string; json: () => unknown }>, status = 200): Promise<T> {
  const done = await res;
  assert.equal(done.statusCode, status, done.body);
  return (status === 204 ? undefined : done.json()) as T;
}

type Origin = { app: string | null; label: string } | null;
type Listed = { id: string; kind: string; title: string; url: string | null; ts: string; origin: Origin };
type Page = { artifacts: Listed[]; counts: Array<{ kind: string; count: number }>; nextCursor: string | null };
type Detail = Listed & { text: string; participants: Array<{ name?: string; email?: string }>; documentId: string | null };

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

const EMAIL = {
  kind: "email",
  externalId: "msg-fieldnote-photos",
  threadId: "thr-fieldnote-photos",
  url: "https://mail.google.com/mail/u/0/#all/thr-fieldnote-photos",
  ts: hoursAgo(1),
  title: "Site visit photos",
  text: "Hi Mira, the photos from the Fieldnote site visit are in the shared folder.",
  participants: [{ name: "Arjun Rao", email: "arjun@fieldnote.example" }],
  metadata: { source: "gmail", from: "Arjun Rao <arjun@fieldnote.example>" },
} as const;
const EVENT = {
  kind: "event",
  externalId: "evt-fieldnote-standup",
  url: "https://calendar.google.com/calendar/event?eid=standup",
  ts: hoursAgo(2),
  title: "Fieldnote standup",
  text: "Daily check-in.",
  participants: [{ name: "Lena Park", email: "lena@fieldnote.example" }],
  metadata: { source: "google", allDay: false },
} as const;
const PR = {
  kind: "pr",
  externalId: "fieldnote/atlas#7",
  url: "https://github.com/fieldnote/atlas/pull/7",
  ts: hoursAgo(3),
  title: "Add the offline photo queue",
  text: "Queues photos taken offline and uploads them later.",
  metadata: { repo: "fieldnote/atlas", number: 7 },
} as const;

async function synced(userId: string, input: Parameters<typeof upsertArtifact>[1]): Promise<string> {
  const row = await upsertArtifact(userId, input);
  assert.ok(row, `${input.title} was stored`);
  return row.id;
}

const mira = await person("Mira Chen");
const dev = await person("Dev Patel");
const ids = {
  email: await synced(mira.id, { ...EMAIL, participants: [...EMAIL.participants] }),
  event: await synced(mira.id, { ...EVENT, participants: [...EVENT.participants] }),
  pr: await synced(mira.id, PR),
};
await synced(dev.id, { ...EMAIL, title: "Dev's own mail", participants: [] });
const upload = await ok<{ file: FileRecord }>(
  mira.inject({ method: "POST", url: "/api/documents", payload: { filename: "Visit notes.md", mediaType: "text/markdown", dataBase64: Buffer.from("# Visit\n\nNotes from the Fieldnote visit.").toString("base64"), summarize: false } }),
  201,
);
await fileTextSettled(upload.file.id);
const uploadArtifact = (await db.document.findUniqueOrThrow({ where: { id: upload.file.id }, select: { artifactId: true } })).artifactId!;
assert.ok(uploadArtifact, "the uploaded file keeps its text on an artifact");

test("From your apps lists synced items without uploaded files, newest first, a page at a time", async () => {
  const apps = await ok<Page>(mira.inject({ method: "GET", url: "/api/artifacts?exclude=uploads" }));
  assert.deepEqual(apps.artifacts.map((row) => row.id), [ids.email, ids.event, ids.pr]);
  assert.deepEqual(
    apps.artifacts.map((row) => row.origin),
    [
      { app: "gmail", label: "Gmail" },
      { app: "google_calendar", label: "Google Calendar" },
      { app: "github", label: "GitHub" },
    ],
  );
  assert.ok(!apps.counts.some((row) => row.kind === "file"), "counts leave uploads out too");
  assert.equal(apps.nextCursor, null);
  claim("GET /api/artifacts", "happy-path");

  const everything = await ok<Page>(mira.inject({ method: "GET", url: "/api/artifacts" }));
  assert.ok(everything.artifacts.some((row) => row.id === uploadArtifact), "callers that do not ask still get every kind");

  const first = await ok<Page>(mira.inject({ method: "GET", url: "/api/artifacts?exclude=uploads&take=2" }));
  assert.deepEqual(first.artifacts.map((row) => row.id), [ids.email, ids.event]);
  assert.ok(first.nextCursor);
  const second = await ok<Page>(mira.inject({ method: "GET", url: `/api/artifacts?exclude=uploads&take=2&before=${encodeURIComponent(first.nextCursor!)}` }));
  assert.deepEqual(second.artifacts.map((row) => row.id), [ids.pr]);
  assert.equal(second.nextCursor, null);

  const prs = await ok<Page>(mira.inject({ method: "GET", url: "/api/artifacts?exclude=uploads&kind=pr" }));
  assert.deepEqual(prs.artifacts.map((row) => row.id), [ids.pr]);
  const photos = await ok<Page>(mira.inject({ method: "GET", url: "/api/artifacts?exclude=uploads&q=SITE%20VISIT" }));
  assert.deepEqual(photos.artifacts.map((row) => row.id), [ids.email]);

  assert.equal((await mira.inject({ method: "GET", url: "/api/artifacts?before=yesterday" })).statusCode, 400);
  assert.equal((await mira.inject({ method: "GET", url: "/api/artifacts?kind=spaceship" })).statusCode, 400);
  claim("GET /api/artifacts", "invalid-input");

  const theirs = await ok<Page>(dev.inject({ method: "GET", url: "/api/artifacts?exclude=uploads" }));
  assert.deepEqual(theirs.artifacts.map((row) => row.title), ["Dev's own mail"]);
  claim("GET /api/artifacts", "isolation");
});

test("one item reads in full; an uploaded file's text points at the file", async () => {
  const { artifact } = await ok<{ artifact: Detail }>(mira.inject({ method: "GET", url: `/api/artifacts/${ids.email}` }));
  assert.equal(artifact.title, "Site visit photos");
  assert.match(artifact.text, /photos from the Fieldnote site visit/);
  assert.deepEqual(artifact.participants, [{ name: "Arjun Rao", email: "arjun@fieldnote.example" }]);
  assert.deepEqual(artifact.origin, { app: "gmail", label: "Gmail" });
  assert.equal(artifact.documentId, null);
  claim("GET /api/artifacts/:id", "happy-path");

  const file = await ok<{ artifact: Detail }>(mira.inject({ method: "GET", url: `/api/artifacts/${uploadArtifact}` }));
  assert.equal(file.artifact.documentId, upload.file.id);

  assert.equal((await dev.inject({ method: "GET", url: `/api/artifacts/${ids.email}` })).statusCode, 404);
  claim("GET /api/artifacts/:id", "isolation");
  assert.equal((await mira.inject({ method: "GET", url: `/api/artifacts/${MISSING_ID}` })).statusCode, 404);
  claim("GET /api/artifacts/:id", "unknown-id");
});

test("a removed item leaves every reader, and a later sync does not bring it back", async () => {
  assert.equal((await dev.inject({ method: "DELETE", url: `/api/artifacts/${ids.email}` })).statusCode, 404, "another person's item is not theirs to remove");
  claim("DELETE /api/artifacts/:id", "isolation");

  await ok(mira.inject({ method: "DELETE", url: `/api/artifacts/${ids.email}` }), 204);
  claim("DELETE /api/artifacts/:id", "happy-path");

  const listed = await ok<Page>(mira.inject({ method: "GET", url: "/api/artifacts" }));
  assert.ok(!listed.artifacts.some((row) => row.id === ids.email));
  assert.ok(!listed.counts.some((row) => row.kind === "email"));
  assert.equal((await mira.inject({ method: "GET", url: `/api/artifacts/${ids.email}` })).statusCode, 404);
  const graph = await ok<{ nodes: Array<{ id: string }> }>(mira.inject({ method: "GET", url: "/api/context/graph" }));
  assert.ok(graph.nodes.some((node) => node.id === ids.pr), "the graph still has the other items");
  assert.ok(!graph.nodes.some((node) => node.id === ids.email));
  const live = await ok<{ artifacts: Array<{ id: string }> }>(mira.inject({ method: "GET", url: "/api/desk/live" }));
  assert.ok(live.artifacts.some((row) => row.id === ids.pr));
  assert.ok(!live.artifacts.some((row) => row.id === ids.email));
  assert.doesNotMatch(JSON.stringify(await bridge.searchHub(db, mira.id, "site visit", 20)), new RegExp(ids.email));
  assert.deepEqual(await bridge.readItem(db, mira.id, "artifact", ids.email, 0, 4000), { found: false });

  const ledger = await db.auditLedger.findFirst({ where: { userId: mira.id, action: "artifact.remove" } });
  assert.deepEqual(ledger?.payload, { id: ids.email, kind: "email" });
  const suppression = await db.contextSuppression.findFirst({ where: { userId: mira.id, kind: "artifact" } });
  assert.equal(suppression?.key, `email:${EMAIL.externalId}`);

  assert.equal((await mira.inject({ method: "DELETE", url: `/api/artifacts/${ids.email}` })).statusCode, 404, "already removed");
  assert.equal((await mira.inject({ method: "DELETE", url: `/api/artifacts/${MISSING_ID}` })).statusCode, 404);
  claim("DELETE /api/artifacts/:id", "unknown-id");

  assert.equal(await upsertArtifact(mira.id, { ...EMAIL, participants: [...EMAIL.participants] }), null, "a sync skips what the person removed");
  assert.ok((await db.artifact.findUniqueOrThrow({ where: { id: ids.email } })).deletedAt, "and leaves it removed");

  // A calendar sync hides events that left the window; seeing one again restores it, unlike a removal.
  await db.artifact.update({ where: { id: ids.event }, data: { deletedAt: new Date() } });
  assert.equal(await synced(mira.id, { ...EVENT, participants: [...EVENT.participants] }), ids.event);
  assert.equal((await db.artifact.findUniqueOrThrow({ where: { id: ids.event } })).deletedAt, null);

  // Retention purges removed rows for good; the removal still holds.
  await db.artifact.delete({ where: { id: ids.email } });
  assert.equal(await upsertArtifact(mira.id, { ...EMAIL, participants: [...EMAIL.participants] }), null);
  assert.equal(await db.artifact.count({ where: { userId: mira.id, kind: "email", externalId: EMAIL.externalId } }), 0);

  const refused = await mira.inject({ method: "DELETE", url: `/api/artifacts/${uploadArtifact}` });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.match(refused.json<{ error: string }>().error, /DELETE \/api\/documents\/:id/);
  assert.equal(refused.json<{ documentId: string }>().documentId, upload.file.id);
  claim("DELETE /api/artifacts/:id", "invalid-input");
  assert.ok((await ok<Page>(mira.inject({ method: "GET", url: "/api/artifacts" }))).artifacts.some((row) => row.id === uploadArtifact), "the file's text stays");
});

test("attaching a removed item again brings it back", async () => {
  mock("https://api.github.com/repos/fieldnote/atlas/issues/42", () =>
    json({ number: 42, title: "Offline mode drops photos", html_url: "https://github.com/fieldnote/atlas/issues/42", state: "open", body: "Photos taken offline never upload.", user: { login: "arjun-rao" }, labels: [], updated_at: "2026-10-11T10:00:00Z", comments: 0 }),
  );
  mock("https://api.github.com/repos/fieldnote/atlas/issues/42/comments", () => json([]));
  await saveAccount(mira.id, "github", { accessToken: "gho_mira_secret_token_0123456789", expiresAt: new Date(Date.now() + 30 * 86_400_000), scopes: ["repo", "read:user"], account: "mira-chen", meta: { via: "oauth" } });
  const task = await db.task.create({ data: { userId: mira.id, title: "Fix offline uploads", status: "todo", owner: "me" } });
  const attach = () => ok<{ item: { artifactId: string } }>(mira.inject({ method: "POST", url: "/api/app-items/attach", payload: { source: "github", kind: "issue", id: "fieldnote/atlas#42", taskId: task.id } }));

  const { item } = await attach();
  const listed = await ok<Page>(mira.inject({ method: "GET", url: "/api/artifacts?exclude=uploads&kind=issue" }));
  assert.deepEqual(listed.artifacts.map((row) => [row.id, row.origin?.label]), [[item.artifactId, "GitHub"]]);

  await ok(mira.inject({ method: "DELETE", url: `/api/artifacts/${item.artifactId}` }), 204);
  const onTask = await ok<{ items: unknown[] }>(mira.inject({ method: "GET", url: `/api/app-items/attached?taskId=${task.id}` }));
  assert.deepEqual(onTask.items, [], "it leaves the task too");

  const again = await attach();
  assert.equal(again.item.artifactId, item.artifactId);
  assert.equal((await db.artifact.findUniqueOrThrow({ where: { id: item.artifactId } })).deletedAt, null);
  assert.equal(await db.contextSuppression.count({ where: { userId: mira.id, kind: "artifact", key: { startsWith: "issue:" } } }), 0);
  const back = await ok<Page>(mira.inject({ method: "GET", url: "/api/artifacts?exclude=uploads&kind=issue" }));
  assert.deepEqual(back.artifacts.map((row) => row.id), [item.artifactId]);
});

test("someone the space is shared with reads its work items but cannot remove anything", async () => {
  const ben = await person("Ben Ortiz");
  await ok(as(mira, { method: "POST", url: `/api/sharing/spaces/${mira.id}/members`, payload: { personId: ben.id, role: "editor" } }), 201);

  const shared = await ok<Page>(as(ben, { method: "GET", url: "/api/artifacts?exclude=uploads" }, mira.id));
  assert.ok(shared.artifacts.some((row) => row.id === ids.pr));
  assert.ok(!shared.artifacts.some((row) => row.kind === "event"), "the owner's calendar stays private");
  await ok(as(ben, { method: "GET", url: `/api/artifacts/${ids.pr}` }, mira.id));
  assert.equal((await as(ben, { method: "GET", url: `/api/artifacts/${ids.event}` }, mira.id)).statusCode, 404);

  const refused = await as(ben, { method: "DELETE", url: `/api/artifacts/${ids.pr}` }, mira.id);
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal((await db.artifact.findUniqueOrThrow({ where: { id: ids.pr } })).deletedAt, null);
});
