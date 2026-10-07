/**
 * Apply for connected-app writes, against the real database: the outside
 * write runs after the Hub transaction, is ledgered as apps.<tool>, and returns
 * its link. Vendor calls are mocked. Skips when Postgres is not reachable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import "../config.js";
import { DEFAULT_SETTINGS, type Settings } from "@ensemble/shared-types";
import Fastify, { type FastifyInstance } from "fastify";
import { ConnectorNotConnectedError } from "../connectors/tokens.js";
import { prisma } from "../lib/prisma.js";
import { NOT_ATTEMPTED, applyHeldCalls } from "./apply.js";
import { resolveTool } from "./apps.js";
import { AppRequestError, setAppTokenResolverForTests } from "./tools/apps-common.js";
import type { ToolContext } from "./types.js";

const G = "https://www.googleapis.com/auth/";
const SCOPES = [`${G}gmail.readonly`, `${G}calendar.events`, `${G}drive.file`];
const TOKEN = "ya29.integration-token";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function settingsWith(extra: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, timezone: "Asia/Kolkata", ...extra, assistant: { ...DEFAULT_SETTINGS.assistant, writePolicy: "immediate" } };
}

test("Apply runs connected-app writes after the Hub transaction, ledgers them, and returns the link", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not reachable");
    return;
  }
  const stamp = Date.now().toString(36);
  const owner = await prisma.user.create({ data: { email: `apply-apps-${stamp}@fieldnote.example`, name: "Mira Chen" } });
  await prisma.authToken.create({
    data: { userId: owner.id, provider: "google", accessToken: "unused-in-this-test", expiresAt: new Date(Date.now() + 3_600_000), scopes: SCOPES, account: "mira@fieldnote.example" },
  });
  const app = { prisma, log: { error() {}, info() {}, warn() {} } } as unknown as FastifyInstance;
  const fetches: Array<{ method: string; url: string; auth: string | null }> = [];
  let respond: (url: string) => Response = () => new Response("{}");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetches.push({ method: init?.method ?? "GET", url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return respond(String(input));
  }) as typeof fetch;
  setAppTokenResolverForTests(async () => ({ token: TOKEN, account: "mira@fieldnote.example", scopes: SCOPES }));
  const base = (settings: Settings): Omit<ToolContext, "tx"> => ({ app, prisma, userId: owner.id, actor: "agent", conversationId: undefined, settings });
  try {
    const event = await resolveTool({ prisma, userId: owner.id }, "calendar_create_event");
    assert.ok(event?.isWrite && event.area === "apps");
    respond = () =>
      new Response(JSON.stringify({ id: "evt-int", htmlLink: "https://www.google.com/calendar/event?eid=evt-int" }), { headers: { "content-type": "application/json" } });
    const input = event.input.parse({ title: "Design review", start: "2026-10-14T15:00", attendees: ["sam@fieldnote.example"] });
    const applied = await applyHeldCalls(app, base(settingsWith()), [{ tool: event, input }]);
    assert.equal(applied.undoEntryId, null, "an outside write has no undo entry");
    assert.equal(applied.partial, false);
    const only = applied.outcomes[0];
    assert.ok(only?.ok);
    assert.equal(only.result.href, "https://www.google.com/calendar/event?eid=evt-int");
    assert.match(only.result.summary, /^Created “Design review” Wed 14 Oct 15:00–15:30 IST in Google Calendar; invites sent to sam@fieldnote.example\.$/);
    assert.deepEqual(fetches.map((row) => [row.method, row.auth]), [["POST", `Bearer ${TOKEN}`]]);
    const ledger = await prisma.auditLedger.findFirst({ where: { userId: owner.id, action: "apps.calendar_create_event" } });
    assert.ok(ledger, "the applied outside write is ledgered");
    const payload = ledger.payload as Record<string, unknown>;
    assert.equal(payload.tool, "calendar_create_event");
    assert.equal(payload.provider, "google");
    assert.equal(payload.href, "https://www.google.com/calendar/event?eid=evt-int");
    assert.equal(payload.id, "evt-int");
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(TOKEN));

    // Hub write first (it commits), then the app writes in order; after the first failure the rest are not sent.
    const project = await resolveTool({ prisma, userId: owner.id }, "hub_create_project");
    const docs = await resolveTool({ prisma, userId: owner.id }, "docs_create");
    assert.ok(project && docs);
    respond = () => new Response(JSON.stringify({ error: { code: 500, message: "Backend error" } }), { status: 500 });
    fetches.length = 0;
    const docInput = docs.input.parse({ title: "Launch brief", markdown: "# Launch" });
    const mixed = await applyHeldCalls(app, base(settingsWith()), [
      { tool: docs, input: docInput },
      { tool: project, input: project.input.parse({ name: `Launch ${stamp}` }) },
      { tool: event, input },
    ]);
    assert.equal(mixed.partial, true);
    assert.ok(mixed.undoEntryId, "the Hub write has its undo entry");
    assert.deepEqual(
      mixed.outcomes.map((outcome) => (outcome.ok ? "ok" : `${outcome.attempted ? "failed" : "skipped"}: ${outcome.error}`)),
      ["failed: Google Docs refused the request (HTTP 500): Backend error.", "ok", `skipped: ${NOT_ATTEMPTED}`],
    );
    assert.equal(fetches.length, 1, "the calendar write after the failure was not sent");
    assert.ok(await prisma.project.findFirst({ where: { userId: owner.id, name: `Launch ${stamp}` } }), "the Hub write committed");
    // When nothing has landed, Apply throws so the same batch can be retried.
    await assert.rejects(() => applyHeldCalls(app, base(settingsWith()), [{ tool: docs, input: docInput }]), AppRequestError);
    assert.equal(await prisma.auditLedger.count({ where: { userId: owner.id, action: "apps.docs_create" } }), 0, "a failed outside write is not ledgered as applied");

    // A product switched off after the proposal is refused at Apply, before anything is sent.
    fetches.length = 0;
    const off = settingsWith({ connectorProducts: { google_workspace: { calendar: false } } });
    await assert.rejects(
      () => applyHeldCalls(app, base(off), [{ tool: event, input }]),
      (error: unknown) => error instanceof ConnectorNotConnectedError && /Google Calendar is switched off for Google Workspace/.test(error.message),
    );
    assert.equal(fetches.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    setAppTokenResolverForTests(null);
    await prisma.undoEntry.deleteMany({ where: { userId: owner.id } });
    await prisma.project.deleteMany({ where: { userId: owner.id } });
    await prisma.auditLedger.deleteMany({ where: { userId: owner.id } });
    await prisma.authToken.deleteMany({ where: { userId: owner.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  }
});

test("a partly failed Apply records what landed, and pressing Apply again never repeats it", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not reachable");
    return;
  }
  const { assistantRoutes } = await import("../routes/assistant.js");
  const stamp = Date.now().toString(36);
  const owner = await prisma.user.create({ data: { email: `apply-partial-${stamp}@fieldnote.example`, name: "Mira Chen" } });
  await prisma.authToken.create({
    data: { userId: owner.id, provider: "google", accessToken: "unused-in-this-test", expiresAt: new Date(Date.now() + 3_600_000), scopes: SCOPES, account: "mira@fieldnote.example" },
  });
  const conversation = await prisma.assistantConversation.create({ data: { userId: owner.id, title: "Launch" } });
  const locks = new Map<string, string>();
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", {
    set: async (key: string, value: string) => (locks.has(key) ? null : (locks.set(key, value), "OK")),
    del: async (...keys: string[]) => keys.filter((key) => locks.delete(key)).length,
  } as never);
  app.addHook("onRequest", async (request) => {
    request.userId = owner.id;
    request.modules = null;
  });
  await app.register(assistantRoutes);
  const sent: string[] = [];
  let docsFails = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/calendar/v3/")) {
      sent.push("calendar");
      return json({ id: "evt-partial", htmlLink: "https://www.google.com/calendar/event?eid=evt-partial" });
    }
    if (url.includes("/upload/drive/v3/files")) {
      sent.push("docs");
      return docsFails ? json({ error: { code: 500, message: "Backend error" } }, 500) : json({ id: "doc-partial", webViewLink: "https://docs.google.com/document/d/doc-partial/edit" });
    }
    return json({ error: { message: "unexpected" } }, 500);
  }) as typeof fetch;
  setAppTokenResolverForTests(async () => ({ token: TOKEN, account: "mira@fieldnote.example", scopes: SCOPES }));
  const calls = [
    { id: "call-project", name: "hub_create_project", input: { name: `Launch ${stamp}` }, summary: `Create project “Launch ${stamp}”` },
    { id: "call-event", name: "calendar_create_event", input: { title: "Design review", start: "2026-10-14T15:00", attendees: ["sam@fieldnote.example"] }, summary: "Create event “Design review”" },
    { id: "call-doc", name: "docs_create", input: { title: "Launch brief", markdown: "# Launch" }, summary: "Create Google Doc “Launch brief”" },
  ];
  const message = await prisma.assistantMessage.create({
    data: {
      conversationId: conversation.id,
      userId: owner.id,
      role: "assistant",
      content: "Ready to apply: the project, the invite and the brief.\n\nNothing has changed yet — press Apply.",
      toolCalls: calls.map((call) => ({ ...call, state: "awaiting_approval", isWrite: true })),
    },
  });
  const press = () =>
    app.inject({
      method: "POST",
      url: "/api/assistant/apply",
      payload: { conversationId: conversation.id, calls: calls.map((call) => ({ name: call.name, input: call.input, callId: call.id })) },
    });
  const lockFor = (callId: string) => `ensemble:apply:${owner.id}:${conversation.id}:${callId}`;
  const stored = async () => {
    const row = await prisma.assistantMessage.findUnique({ where: { id: message.id } });
    return { content: row?.content ?? "", calls: (row?.toolCalls ?? []) as Array<Record<string, unknown>> };
  };
  try {
    const first = await press();
    assert.equal(first.statusCode, 200, first.body);
    const body = first.json() as { summary: string; partial?: boolean; undoEntryId: string | null; failed?: Array<Record<string, unknown>> };
    assert.equal(body.partial, true);
    assert.deepEqual(body.failed, [{ callId: "call-doc", name: "docs_create", error: "Google Docs refused the request (HTTP 500): Backend error.", attempted: true }]);
    assert.match(body.summary, new RegExp(`Created “Launch ${stamp}”\\.`));
    assert.match(body.summary, /Created “Design review”/);
    assert.equal(typeof body.undoEntryId, "string");

    const after = await stored();
    const [project, event, doc] = after.calls;
    assert.equal(project?.state, "ok");
    assert.equal(project?.undoEntryId, body.undoEntryId);
    assert.equal(event?.state, "ok");
    assert.equal(event?.undoEntryId, null, "an outside write offers no undo");
    assert.equal(event?.href, "https://www.google.com/calendar/event?eid=evt-partial");
    assert.equal(doc?.state, "failed");
    assert.equal(doc?.error, "Google Docs refused the request (HTTP 500): Backend error.");
    assert.equal(after.content.includes("Nothing has changed yet"), false);
    assert.match(after.content, /Applied\. /);
    assert.match(after.content, /Not applied: Google Docs refused the request \(HTTP 500\): Backend error\.$/);

    const ledger = await prisma.auditLedger.findFirst({ where: { userId: owner.id, action: "assistant.apply" } });
    const payload = ledger?.payload as { tool?: string; partial?: boolean; failed?: Array<{ tool: string }> } | undefined;
    assert.equal(payload?.tool, "hub_create_project,calendar_create_event");
    assert.equal(payload?.partial, true);
    assert.equal(payload?.failed?.[0]?.tool, "docs_create");
    assert.equal(await prisma.auditLedger.count({ where: { userId: owner.id, action: "apps.calendar_create_event" } }), 1);
    assert.equal(locks.has(lockFor("call-doc")), false, "the failed call's lock is released");
    assert.ok(locks.has(lockFor("call-project")) && locks.has(lockFor("call-event")));
    assert.deepEqual(sent, ["calendar", "docs"]);

    // The locks expire; pressing Apply again must still not repeat what landed.
    locks.clear();
    docsFails = false;
    const second = await press();
    assert.equal(second.statusCode, 200, second.body);
    const secondBody = second.json() as { summary: string; partial?: boolean; href: string | null };
    assert.equal(secondBody.partial, undefined);
    assert.equal(secondBody.summary, "Created the Google Doc “Launch brief”.");
    assert.equal(secondBody.href, "https://docs.google.com/document/d/doc-partial/edit");
    assert.deepEqual(sent, ["calendar", "docs", "docs"], "only the failed call ran again");
    assert.equal(await prisma.project.count({ where: { userId: owner.id, name: `Launch ${stamp}` } }), 1);
    const final = await stored();
    assert.deepEqual(final.calls.map((call) => call.state), ["ok", "ok", "ok"]);
    assert.equal(final.content.includes("Not applied"), false);

    const third = await press();
    assert.equal(third.statusCode, 200, third.body);
    assert.equal((third.json() as { already?: boolean }).already, true);
    assert.equal(sent.length, 3);
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    setAppTokenResolverForTests(null);
    await prisma.undoEntry.deleteMany({ where: { userId: owner.id } });
    await prisma.project.deleteMany({ where: { userId: owner.id } });
    await prisma.auditLedger.deleteMany({ where: { userId: owner.id } });
    await prisma.assistantConversation.delete({ where: { id: conversation.id } });
    await prisma.authToken.deleteMany({ where: { userId: owner.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  }
});
