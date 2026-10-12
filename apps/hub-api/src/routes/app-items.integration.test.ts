/**
 * Items in connected apps over HTTP: which apps can be searched, search with a
 * failing app beside a working one, attach to a task (and only your own), refresh
 * and remove, an issue as a task, people from an app, and posting an update back.
 * Every vendor call is answered by a mocked fetch.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { appItemRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

const originalEnv = { ...process.env };
process.env.NODE_ENV = "test";
process.env.HUB_WEB_ORIGIN = "http://hub.example.test";
process.env.HUB_API_PUBLIC_URL = "http://api.example.test";

const harness: HttpHarness = await createHttpHarness();
const { saveAccount } = await import("../connectors/accounts.js");
const covered = new Map<string, Set<RouteCheck>>();

type Call = { url: string; init?: RequestInit };
const calls: Call[] = [];
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const handlers: Array<{ match: (url: string) => boolean; reply: Handler }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return realFetch(input, init);
  calls.push({ url, init });
  const handler = handlers.find((row) => row.match(url));
  if (!handler) return new Response(JSON.stringify({ message: `unmocked ${url}` }), { status: 599 });
  return handler.reply(url, init);
}) as typeof fetch;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mock(prefix: string, reply: Handler): void {
  handlers.unshift({ match: (url) => url.startsWith(prefix), reply });
}

function resetMocks(): void {
  handlers.length = 0;
  calls.length = 0;
}

after(async () => {
  try {
    for (const [route, checks] of Object.entries(appItemRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted app-item coverage claim: ${check} ${route}`);
    }
  } finally {
    globalThis.fetch = realFetch;
    await harness.close();
    process.env = originalEnv;
  }
});

async function call(user: HttpUser, method: InjectOptions["method"], url: string, route: string, check: RouteCheck, payload?: unknown) {
  const response = await user.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as InjectOptions["payload"] }) });
  const key = `${method} ${route}`;
  const checks = covered.get(key) ?? new Set<RouteCheck>();
  checks.add(check);
  covered.set(key, checks);
  return response;
}

async function verified(email: string): Promise<HttpUser> {
  const user = await harness.asUser(email);
  await harness.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  return user;
}

const LATER = new Date(Date.now() + 30 * 86_400_000);

async function connectGithub(user: HttpUser) {
  await saveAccount(user.id, "github", { accessToken: "gho_mira_secret_token_0123456789", expiresAt: LATER, scopes: ["repo", "read:user", "read:org"], account: "mira-chen", meta: { via: "oauth" } });
}

const REPO = {
  full_name: "fieldnote/atlas",
  html_url: "https://github.com/fieldnote/atlas",
  description: "Field notes for every site visit",
  private: true,
  default_branch: "main",
  language: "TypeScript",
  pushed_at: "2026-10-10T09:00:00Z",
  open_issues_count: 4,
};
const ISSUE = {
  number: 42,
  title: "Offline mode drops photos",
  html_url: "https://github.com/fieldnote/atlas/issues/42",
  repository_url: "https://api.github.com/repos/fieldnote/atlas",
  state: "open",
  body: "Photos taken offline never upload.",
  user: { login: "arjun-rao" },
  assignees: [{ login: "mira-chen" }],
  labels: [{ name: "bug" }],
  milestone: { title: "October", due_on: "2026-10-31T00:00:00Z" },
  updated_at: "2026-10-11T10:00:00Z",
  comments: 1,
};

/** Later mocks win, so the most specific addresses come last. */
function mockGithub() {
  mock("https://api.github.com/repos/fieldnote/atlas", () => json(REPO));
  mock("https://api.github.com/repos/fieldnote/atlas/readme", () => new Response("# Atlas\nOffline-first field notes.", { status: 200 }));
  mock("https://api.github.com/repos/fieldnote/atlas/issues/42", () => json(ISSUE));
  mock("https://api.github.com/repos/fieldnote/atlas/issues/42/comments", (_url, init) =>
    init?.method === "POST" ? json({ html_url: "https://github.com/fieldnote/atlas/issues/42#issuecomment-1" }, 201) : json([{ user: { login: "arjun-rao" }, body: "Seen on iOS too.", created_at: "2026-10-11T11:00:00Z" }]),
  );
  mock("https://api.github.com/user/repos", () => json([REPO]));
  mock("https://api.github.com/search/issues", () => json({ items: [ISSUE] }));
  mock("https://api.github.com/user/orgs", () => json([{ login: "fieldnote" }]));
  mock("https://api.github.com/orgs/fieldnote/members", () => json([{ login: "arjun-rao" }, { login: "lena-park" }, { login: "deploy-bot", type: "Bot" }]));
}

test("sources list only this person's connected apps", async () => {
  resetMocks();
  const mira = await verified("mira.items@fieldnote.example");
  const arjun = await verified("arjun.items@fieldnote.example");
  await connectGithub(mira);
  await saveAccount(mira.id, "notion", { accessToken: "ntn_mira_notion_secret_0123456789", account: "Fieldnote", meta: { via: "token" } });

  const mine = await call(mira, "GET", "/api/app-items/sources", "/api/app-items/sources", "happy-path");
  assert.equal(mine.statusCode, 200, mine.body);
  const sources = mine.json<{ sources: Array<{ id: string; kinds: string[]; comments: boolean; people: boolean; logo: string }> }>().sources;
  assert.deepEqual(sources.map((row) => row.id).sort(), ["github", "notion"]);
  const github = sources.find((row) => row.id === "github")!;
  assert.deepEqual(github.kinds, ["repo", "issue", "pull_request"]);
  assert.equal(github.comments, true);
  assert.equal(github.logo, "github");

  const theirs = await call(arjun, "GET", "/api/app-items/sources", "/api/app-items/sources", "isolation");
  assert.deepEqual(theirs.json<{ sources: unknown[] }>().sources, []);
  assert.equal(calls.length, 0, "listing sources never calls an app");
});

test("search answers from the apps that work and names the one that failed", async () => {
  resetMocks();
  mockGithub();
  mock("https://api.notion.com/v1/search", () => json({ message: "Notion is down" }, 500));
  const mira = await verified("mira.search@fieldnote.example");
  await connectGithub(mira);
  await saveAccount(mira.id, "notion", { accessToken: "ntn_mira_notion_secret_0123456789", account: "Fieldnote", meta: { via: "token" } });

  const found = await call(mira, "GET", "/api/app-items/search?q=atlas", "/api/app-items/search", "happy-path");
  assert.equal(found.statusCode, 200, found.body);
  const body = found.json<{ items: Array<{ source: string; kind: string; id: string; title: string }>; errors: Array<{ source: string; message: string }> }>();
  assert.ok(body.items.some((item) => item.kind === "repo" && item.id === "fieldnote/atlas"));
  assert.ok(body.items.some((item) => item.kind === "issue" && item.id === "fieldnote/atlas#42"));
  assert.deepEqual(body.errors.map((row) => row.source), ["notion"]);
  assert.doesNotMatch(found.body, /gho_mira|ntn_mira/);
  const searched = calls.find((row) => row.url.startsWith("https://api.github.com/search/issues"))!;
  assert.match(decodeURIComponent(searched.url), /involves:mira-chen/);
  assert.equal(new Headers(searched.init?.headers).get("authorization"), "Bearer gho_mira_secret_token_0123456789");

  const link = await call(mira, "GET", `/api/app-items/search?source=github&q=${encodeURIComponent("https://github.com/fieldnote/atlas/issues/42")}`, "/api/app-items/search", "happy-path");
  assert.deepEqual(link.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id), ["fieldnote/atlas#42"]);

  const badKind = await call(mira, "GET", "/api/app-items/search?kind=spaceship", "/api/app-items/search", "invalid-input");
  assert.equal(badKind.statusCode, 400, badKind.body);
  const notConnected = await call(mira, "GET", "/api/app-items/search?source=linear&q=x", "/api/app-items/search", "invalid-input");
  assert.equal(notConnected.statusCode, 409, notConnected.body);
  assert.match(notConnected.json<{ error: string }>().error, /Linear is not connected/);

  const read = await call(mira, "POST", "/api/app-items/read", "/api/app-items/read", "happy-path", { source: "github", kind: "repo", id: "fieldnote/atlas" });
  assert.equal(read.statusCode, 200, read.body);
  assert.match(read.json<{ item: { text: string } }>().item.text, /Offline-first field notes/);
  const badRead = await call(mira, "POST", "/api/app-items/read", "/api/app-items/read", "invalid-input", { source: "github", kind: "repo", id: "../../etc" });
  assert.equal(badRead.statusCode, 400, badRead.body);
});

test("attach to a task, list, refresh and remove; nobody else can attach to it or see it", async () => {
  resetMocks();
  mockGithub();
  const mira = await verified("mira.attach@fieldnote.example");
  const arjun = await verified("arjun.attach@fieldnote.example");
  await connectGithub(mira);
  await connectGithub(arjun);
  const task = await harness.prisma.task.create({ data: { userId: mira.id, title: "Fix offline uploads", status: "todo", owner: "me" } });

  const attached = await call(mira, "POST", "/api/app-items/attach", "/api/app-items/attach", "happy-path", { source: "github", kind: "issue", id: "fieldnote/atlas#42", taskId: task.id });
  assert.equal(attached.statusCode, 200, attached.body);
  const item = attached.json<{ item: { artifactId: string; title: string; taskId: string; chars: number; url: string } }>().item;
  assert.equal(item.taskId, task.id);
  assert.equal(item.url, "https://github.com/fieldnote/atlas/issues/42");
  const artifact = await harness.prisma.artifact.findUniqueOrThrow({ where: { id: item.artifactId } });
  assert.equal(artifact.kind, "issue");
  assert.match(artifact.text, /Photos taken offline never upload/);
  assert.match(artifact.text, /Seen on iOS too/);

  const list = await call(mira, "GET", `/api/app-items/attached?taskId=${task.id}`, "/api/app-items/attached", "happy-path");
  assert.deepEqual(list.json<{ items: Array<{ artifactId: string }> }>().items.map((row) => row.artifactId), [item.artifactId]);
  const peek = await call(arjun, "GET", `/api/app-items/attached?taskId=${task.id}`, "/api/app-items/attached", "isolation");
  assert.deepEqual(peek.json<{ items: unknown[] }>().items, []);
  const noTarget = await call(mira, "GET", "/api/app-items/attached", "/api/app-items/attached", "invalid-input");
  assert.equal(noTarget.statusCode, 400, noTarget.body);

  const intrude = await call(arjun, "POST", "/api/app-items/attach", "/api/app-items/attach", "isolation", { source: "github", kind: "issue", id: "fieldnote/atlas#42", taskId: task.id });
  assert.equal(intrude.statusCode, 404, intrude.body);
  const nowhere = await call(mira, "POST", "/api/app-items/attach", "/api/app-items/attach", "invalid-input", { source: "github", kind: "issue", id: "fieldnote/atlas#42" });
  assert.equal(nowhere.statusCode, 400, nowhere.body);

  const refreshed = await call(mira, "POST", `/api/app-items/attached/${item.artifactId}/refresh`, "/api/app-items/attached/:artifactId/refresh", "happy-path");
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  const theirRefresh = await call(arjun, "POST", `/api/app-items/attached/${item.artifactId}/refresh`, "/api/app-items/attached/:artifactId/refresh", "isolation");
  assert.equal(theirRefresh.statusCode, 404, theirRefresh.body);
  const unknown = await call(mira, "POST", `/api/app-items/attached/00000000-0000-4000-8000-000000000000/refresh`, "/api/app-items/attached/:artifactId/refresh", "unknown-id");
  assert.equal(unknown.statusCode, 404, unknown.body);

  const theirRemove = await call(arjun, "DELETE", `/api/app-items/attached/${item.artifactId}?taskId=${task.id}`, "/api/app-items/attached/:artifactId", "isolation");
  assert.equal(theirRemove.statusCode, 404, theirRemove.body);
  const removed = await call(mira, "DELETE", `/api/app-items/attached/${item.artifactId}?taskId=${task.id}`, "/api/app-items/attached/:artifactId", "happy-path");
  assert.equal(removed.statusCode, 204, removed.body);
  const after = await call(mira, "GET", `/api/app-items/attached?taskId=${task.id}`, "/api/app-items/attached", "happy-path");
  assert.deepEqual(after.json<{ items: unknown[] }>().items, []);
  const gone = await call(mira, "DELETE", `/api/app-items/attached/${item.artifactId}`, "/api/app-items/attached/:artifactId", "unknown-id");
  assert.equal(gone.statusCode, 404, gone.body);
});

test("an issue becomes a task once, and the update goes back to that issue", async () => {
  resetMocks();
  mockGithub();
  const mira = await verified("mira.task@fieldnote.example");
  const arjun = await verified("arjun.task@fieldnote.example");
  await connectGithub(mira);

  const first = await call(mira, "POST", "/api/app-items/task", "/api/app-items/task", "happy-path", { source: "github", kind: "issue", id: "fieldnote/atlas#42" });
  assert.equal(first.statusCode, 200, first.body);
  const { taskId, created } = first.json<{ taskId: string; created: boolean }>();
  assert.equal(created, true);
  const task = await harness.prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  assert.equal(task.title, "Offline mode drops photos");
  assert.equal(task.sourceKind, "github");
  assert.equal(task.sourceUrl, "https://github.com/fieldnote/atlas/issues/42");
  assert.equal(task.status, "todo");
  const again = await call(mira, "POST", "/api/app-items/task", "/api/app-items/task", "happy-path", { source: "github", kind: "issue", id: "fieldnote/atlas#42" });
  assert.deepEqual(again.json<{ taskId: string; created: boolean }>(), { taskId, created: false });
  const notTaskLike = await call(mira, "POST", "/api/app-items/task", "/api/app-items/task", "invalid-input", { source: "github", kind: "repo", id: "fieldnote/atlas" });
  assert.equal(notTaskLike.statusCode, 400, notTaskLike.body);

  const target = await call(mira, "GET", `/api/app-items/update-target?taskId=${taskId}`, "/api/app-items/update-target", "happy-path");
  assert.deepEqual(target.json<{ target: { source: string; kind: string; id: string } }>().target, {
    source: "github",
    kind: "issue",
    id: "fieldnote/atlas#42",
    title: "Offline mode drops photos",
    url: "https://github.com/fieldnote/atlas/issues/42",
  });
  const theirs = await call(arjun, "GET", `/api/app-items/update-target?taskId=${taskId}`, "/api/app-items/update-target", "isolation");
  assert.equal(theirs.statusCode, 404, theirs.body);

  const posted = await call(mira, "POST", "/api/app-items/update", "/api/app-items/update", "happy-path", { taskId, body: "Fixed in fieldnote/atlas#43: uploads retry after reconnecting." });
  assert.equal(posted.statusCode, 200, posted.body);
  assert.deepEqual(posted.json(), { source: "github", url: "https://github.com/fieldnote/atlas/issues/42#issuecomment-1" });
  const comment = calls.find((row) => row.url.endsWith("/issues/42/comments") && row.init?.method === "POST")!;
  assert.deepEqual(JSON.parse(String(comment.init?.body)), { body: "Fixed in fieldnote/atlas#43: uploads retry after reconnecting." });
  const ledger = await harness.prisma.auditLedger.findFirst({ where: { userId: mira.id, action: "apps.post_update" } });
  assert.ok(ledger, "the update is in the ledger");

  const empty = await call(mira, "POST", "/api/app-items/update", "/api/app-items/update", "invalid-input", { taskId, body: "   " });
  assert.equal(empty.statusCode, 400, empty.body);
  const intrude = await call(arjun, "POST", "/api/app-items/update", "/api/app-items/update", "isolation", { taskId, body: "Not my task" });
  assert.equal(intrude.statusCode, 404, intrude.body);
  const plain = await harness.prisma.task.create({ data: { userId: mira.id, title: "Call the venue", status: "todo", owner: "me" } });
  const unlinked = await call(mira, "POST", "/api/app-items/update", "/api/app-items/update", "invalid-input", { taskId: plain.id, body: "Done" });
  assert.equal(unlinked.statusCode, 409, unlinked.body);
});

test("people from an app join People, matched by handle the second time", async () => {
  resetMocks();
  mockGithub();
  const mira = await verified("mira.people@fieldnote.example");
  await connectGithub(mira);

  const first = await call(mira, "POST", "/api/app-items/people", "/api/app-items/people", "happy-path", { source: "github" });
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { seen: 2, added: 2, matched: 0, skipped: 0 });
  const handles = await harness.prisma.personIdentity.findMany({ where: { userId: mira.id, kind: "github" }, select: { value: true } });
  assert.deepEqual(handles.map((row) => row.value).sort(), ["arjun-rao", "lena-park"]);
  const second = await call(mira, "POST", "/api/app-items/people", "/api/app-items/people", "happy-path", { source: "github" });
  assert.deepEqual(second.json(), { seen: 2, added: 0, matched: 2, skipped: 0 });
  const unknown = await call(mira, "POST", "/api/app-items/people", "/api/app-items/people", "invalid-input", { source: "Not An App" });
  assert.equal(unknown.statusCode, 400, unknown.body);
});

test("hosted: unverified people cannot use connected apps", async (t) => {
  resetMocks();
  const unverified = await harness.asUser("new.items@fieldnote.example");
  process.env.NODE_ENV = "production";
  t.after(() => {
    process.env.NODE_ENV = "test";
  });
  for (const [method, url, route, payload] of [
    ["GET", "/api/app-items/sources", "/api/app-items/sources", undefined],
    ["GET", "/api/app-items/search?q=x", "/api/app-items/search", undefined],
    ["POST", "/api/app-items/attach", "/api/app-items/attach", { source: "github", kind: "issue", id: "a/b#1", taskId: "00000000-0000-4000-8000-000000000000" }],
    ["POST", "/api/app-items/people", "/api/app-items/people", { source: "github" }],
    ["POST", "/api/app-items/update", "/api/app-items/update", { taskId: "00000000-0000-4000-8000-000000000000", body: "x" }],
  ] as const) {
    const response = await call(unverified, method, url, route, "hosted-verification", payload);
    assert.equal(response.statusCode, 403, `${method} ${url}: ${response.body}`);
  }
  assert.equal(calls.length, 0);
});
