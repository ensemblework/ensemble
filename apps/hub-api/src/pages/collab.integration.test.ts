/**
 * Live co-editing over HTTP (pages/collab.ts, routes/collab.ts): two people on a shared page post
 * steps at once, the one behind rebases, everything is written back, the share's role holds, and
 * writes from elsewhere (an older tab's whole-page save, an agent's block) land without
 * overwriting what was typed.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { InjectOptions } from "fastify";
import { Mapping, Step, Transform } from "prosemirror-transform";
import type { Node } from "prosemirror-model";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { pageDoc, pageSchema } from "./schema.js";

const harness: HttpHarness = await createHttpHarness();
const db = harness.prisma;
const { sseHub, delivers } = await import("../lib/sse.js");
const { collabHub } = await import("../routes/collab.js");
const { writeAgentBlock } = await import("./markdown.js");

after(async () => {
  await harness.close();
});

async function person(name: string): Promise<HttpUser> {
  const user = await harness.asUser();
  await db.user.update({ where: { id: user.id }, data: { name, onboardingRole: "student", onboardingCompletedAt: new Date(), emailVerifiedAt: new Date() } });
  return user;
}

function as(user: HttpUser, request: InjectOptions, share?: string) {
  return harness.app.inject({ ...request, headers: { ...(request.headers as Record<string, string>), cookie: user.cookie, ...(share ? { "x-ensemble-share": share } : {}) } });
}

async function ok<T>(response: Promise<{ statusCode: number; body: string; json: () => unknown }>, status = 200): Promise<T> {
  const done = await response;
  assert.equal(done.statusCode, status, done.body);
  return (status === 204 ? undefined : done.json()) as T;
}

type Joined = { epoch: string; version: number; doc: unknown; revision: number; saved: number; clientID: string; token: string };
type Batch = { epoch: string; from: number; version: number; steps: unknown[]; clientIDs: string[]; revision?: number; code?: string };

const textOf = (doc: unknown) => pageDoc(doc).textBetween(0, pageDoc(doc).content.size, "\n");
const endOfFirst = (doc: Node) => doc.child(0).nodeSize - 1;

function typed(doc: Node, pos: number, text: string): Transform {
  return new Transform(doc).insert(pos, pageSchema.text(text));
}

function rebased(mine: Transform, missed: Batch): unknown[] {
  const mapping = new Mapping();
  for (const json of missed.steps) mapping.appendMap(Step.fromJSON(pageSchema, json).getMap());
  return mine.steps.map((step) => step.map(mapping)!.toJSON());
}

test("two people type into a shared page at once: one rebases, both land, the share's role holds", async () => {
  const mira = await person("Mira Chen");
  const cara = await person("Cara Diaz");
  const vic = await person("Vic Ward");
  const dev = await person("Dev Patel");
  const page = (await ok<{ page: { id: string } }>(as(mira, { method: "POST", url: "/api/pages" }), 201)).page.id;
  const url = `/api/pages/${page}/collab`;
  await ok(as(mira, { method: "PUT", url: `/api/pages/${page}`, payload: { revision: 1, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Plan" }] }] } } }));
  const share = async (who: HttpUser, role: "view" | "edit") =>
    (await ok<{ shares: Array<{ id: string; person: { id: string } }> }>(as(mira, { method: "POST", url: "/api/sharing/items", payload: { kind: "page", resourceId: page, personId: who.id, role } }), 201)).shares.find((row) => row.person.id === who.id)!.id;
  const caraShare = await share(cara, "edit");
  const vicShare = await share(vic, "view");

  const frames: Array<{ event: string; data: Batch & { id?: string; kind?: string; by?: string; revision?: number } }> = [];
  const stop = sseHub.onFrame(({ frame }) => frames.push(frame as (typeof frames)[number]));
  try {
    const miraJoin = await ok<Joined>(as(mira, { method: "GET", url }));
    const caraJoin = await ok<Joined>(as(cara, { method: "GET", url }, caraShare));
    const miraTab = miraJoin.clientID;
    const caraTab = caraJoin.clientID;
    assert.ok(miraTab.startsWith(`${mira.id}/`) && caraTab.startsWith(`${cara.id}/`), "client ids are issued per account");
    const spoofed = await as(cara, { method: "POST", url, payload: { epoch: caraJoin.epoch, version: 0, clientID: miraTab, token: caraJoin.token, steps: [] } }, caraShare);
    assert.equal(spoofed.statusCode, 410, "one person cannot send as another's tab");
    assert.equal((spoofed.json() as { code?: string }).code, "COLLAB_REJOIN");
    const untokened = await as(mira, { method: "POST", url, payload: { epoch: miraJoin.epoch, version: 0, clientID: miraTab, steps: [] } });
    assert.equal((untokened.json() as { code?: string }).code, "COLLAB_REJOIN", "the client id alone is not enough: it is public on the stream");
    assert.equal(caraJoin.epoch, miraJoin.epoch);
    assert.equal(caraJoin.version, 0);
    assert.equal(miraJoin.revision, 2);
    assert.equal(textOf(miraJoin.doc), "Plan");

    const start = pageDoc(miraJoin.doc);
    const miraEdit = typed(start, endOfFirst(start), " the launch");
    const caraEdit = typed(start, endOfFirst(start), " next week");
    const [first, second] = await Promise.all([
      as(mira, { method: "POST", url, payload: { epoch: miraJoin.epoch, version: 0, clientID: miraTab, token: miraJoin.token, steps: miraEdit.steps.map((step) => step.toJSON()) } }),
      as(cara, { method: "POST", url, payload: { epoch: caraJoin.epoch, version: 0, clientID: caraTab, token: caraJoin.token, steps: caraEdit.steps.map((step) => step.toJSON()) } }, caraShare),
    ]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 409, "the second post was made against a version that moved on");
    const missed = second.json() as Batch;
    assert.equal(missed.code, "COLLAB_BEHIND");
    assert.deepEqual(missed.clientIDs, [miraTab]);
    const confirmed = await ok<Batch>(as(cara, { method: "POST", url, payload: { epoch: caraJoin.epoch, version: missed.version, clientID: caraTab, token: caraJoin.token, steps: rebased(caraEdit, missed) } }, caraShare));
    assert.equal(confirmed.version, 2);
    assert.deepEqual(confirmed.clientIDs, [caraTab]);
    const steps = frames.filter((frame) => frame.event === "page.steps" && frame.data.id === page);
    assert.deepEqual(steps.map((frame) => [frame.data.from, frame.data.clientIDs]), [[0, [miraTab]], [1, [caraTab]]]);

    // Catching up after a gap.
    const gap = await ok<Batch>(as(mira, { method: "GET", url: `${url}?epoch=${miraJoin.epoch}&version=1` }));
    assert.deepEqual(gap.clientIDs, [caraTab]);
    const reset = await as(mira, { method: "GET", url: `${url}?epoch=stale&version=1` });
    assert.equal(reset.statusCode, 410);

    // A viewer follows along but cannot type; someone with no share sees nothing.
    assert.equal(textOf((await ok<Joined>(as(vic, { method: "GET", url }, vicShare))).doc), "Plan the launch next week");
    const refused = await as(vic, { method: "POST", url, payload: { epoch: miraJoin.epoch, version: 2, clientID: `${vic.id}/tab`, steps: [] } }, vicShare);
    assert.equal(refused.statusCode, 403);
    assert.equal((await as(dev, { method: "GET", url })).statusCode, 404);
    assert.equal((await as(dev, { method: "GET", url }, caraShare)).statusCode, 404, "someone else's share is not yours");

    // Flush writes it back and answers with the stored revision.
    const flushed = await ok<Batch>(as(cara, { method: "POST", url, payload: { epoch: caraJoin.epoch, version: 2, clientID: caraTab, token: caraJoin.token, steps: [], flush: true } }, caraShare));
    const stored = await ok<{ revision: number; content: unknown }>(as(mira, { method: "GET", url: `/api/pages/${page}` }));
    assert.equal(stored.revision, flushed.revision);
    assert.equal(textOf(stored.content), "Plan the launch next week");
    assert.ok(frames.some((frame) => frame.event === "page" && frame.data.id === page && frame.data.by === "collab" && frame.data.revision === stored.revision));

    // An older tab that still saves whole pages: its save is taken into the live page, with live typing kept.
    const live = pageDoc((await ok<Joined>(as(mira, { method: "GET", url }))).doc);
    await ok(as(mira, { method: "POST", url, payload: { epoch: miraJoin.epoch, version: 2, clientID: miraTab, token: miraJoin.token, steps: typed(live, 1, "Draft: ").steps.map((step) => step.toJSON()) } }));
    const old = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Plan the launch next week" }] }, { type: "paragraph", content: [{ type: "text", text: "From the old tab" }] }] };
    await ok(as(cara, { method: "PUT", url: `/api/pages/${page}`, payload: { revision: stored.revision, content: old } }, caraShare));
    let now = "";
    for (let tries = 0; tries < 50 && !now.includes("old tab"); tries += 1) {
      now = textOf((await ok<Joined>(as(mira, { method: "GET", url }))).doc);
      if (!now.includes("old tab")) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(now, "Draft: Plan the launch next week\nFrom the old tab");
    await collabHub.flush({ space: mira.id, kind: "page", id: page });
    assert.equal(textOf((await ok<{ content: unknown }>(as(mira, { method: "GET", url: `/api/pages/${page}` }))).content), "Draft: Plan the launch next week\nFrom the old tab");
  } finally {
    stop();
  }

  // The share is removed while Cara has the page open: her next steps are refused, and she is told why.
  await ok(as(mira, { method: "DELETE", url: `/api/sharing/items/${caraShare}` }), 204);
  const late = await as(cara, { method: "POST", url, payload: { epoch: "any", version: 0, clientID: `${cara.id}/tab`, steps: [] } }, caraShare);
  assert.equal(late.statusCode, 404);
  assert.equal((late.json() as { code?: string }).code, "SHARE_GONE");
});

test("a task page edited live through a task share takes in an agent's block without losing the typing", async () => {
  const mira = await person("Mira Chen");
  const cara = await person("Cara Diaz");
  const task = (await ok<{ task: { id: string } }>(as(mira, { method: "POST", url: "/api/tasks", payload: { title: "Launch", notes: "First line\nSecond line" } }), 201)).task.id;
  const url = `/api/tasks/${task}/page/collab`;
  const share = (await ok<{ shares: Array<{ id: string }> }>(as(mira, { method: "POST", url: "/api/sharing/items", payload: { kind: "task", resourceId: task, personId: cara.id, role: "edit" } }), 201)).shares[0]!.id;

  const joined = await ok<Joined>(as(cara, { method: "GET", url }, share));
  assert.equal(joined.revision, 0, "never written: the page shows the task's notes");
  assert.equal(textOf(joined.doc), "First line\nSecond line");
  const start = pageDoc(joined.doc);
  await ok(as(cara, { method: "POST", url, payload: { epoch: joined.epoch, version: 0, clientID: joined.clientID, token: joined.token, steps: typed(start, endOfFirst(start), " (edited)").steps.map((step) => step.toJSON()) } }, share));

  // The agent writes from the stored copy, which does not have Cara's typing yet.
  await writeAgentBlock(db, mira.id, task, "Agent result", { jobId: "job-1", runId: null, model: "fixture" });
  let text = "";
  for (let tries = 0; tries < 50 && !text.includes("Agent result"); tries += 1) {
    text = textOf((await ok<Joined>(as(cara, { method: "GET", url }, share))).doc);
    if (!text.includes("Agent result")) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(text, /First line \(edited\)/);
  assert.match(text, /Agent result/);
  await collabHub.flush({ space: mira.id, kind: "task", id: task });
  const stored = await ok<{ content: unknown; revision: number }>(as(mira, { method: "GET", url: `/api/tasks/${task}/page` }));
  assert.match(textOf(stored.content), /First line \(edited\)[\s\S]*Agent result/);
});

test("live steps reach the people on that page or task, and nobody else's single shared item", () => {
  const frame = { event: "page.steps", data: { kind: "task", id: "task-1", taskId: "task-1", from: 0, version: 1, steps: [], clientIDs: [] } };
  const pageFrame = { event: "page.steps", data: { kind: "page", id: "page-1", from: 0, version: 1, steps: [], clientIDs: [] } };
  assert.equal(delivers({ accountId: "a", owner: false, share: { kind: "task", resourceId: "task-1" } }, frame, undefined), true);
  assert.equal(delivers({ accountId: "a", owner: false, share: { kind: "board", resourceId: "space" } }, frame, undefined), true);
  assert.equal(delivers({ accountId: "a", owner: false, share: { kind: "page", resourceId: "page-1" } }, frame, undefined), false);
  assert.equal(delivers({ accountId: "a", owner: false, share: { kind: "page", resourceId: "page-1" } }, pageFrame, undefined), true);
  assert.equal(delivers({ accountId: "a", owner: false, share: { kind: "board", resourceId: "space" } }, pageFrame, undefined), false);
  assert.equal(delivers({ accountId: "a", owner: false, share: { kind: "diagram", resourceId: "page-1" } }, pageFrame, undefined), false);
  assert.equal(delivers({ accountId: "m", owner: false }, pageFrame, undefined), true, "a whole-space member sees every page");
});

test("over HTTP: steps the store cannot keep are refused with a code, and typing survives Trash", async () => {
  const { trashStandalonePage } = await import("./store.js");
  const mira = await person("Mira Chen");
  const page = (await ok<{ page: { id: string } }>(as(mira, { method: "POST", url: "/api/pages" }), 201)).page.id;
  const url = `/api/pages/${page}/collab`;
  const joined = await ok<Joined>(as(mira, { method: "GET", url }));
  const post = (version: number, steps: unknown[], extra: Record<string, unknown> = {}) => as(mira, { method: "POST", url, payload: { epoch: joined.epoch, version, clientID: joined.clientID, token: joined.token, steps, ...extra } });
  const insert = (content: unknown) => ({ stepType: "replace", from: 1, to: 1, slice: { content: [content] } });

  const unknownKind = await post(0, [insert({ type: "mention", attrs: { kind: "nope", id: "x", label: "X" } })]);
  assert.equal(unknownKind.statusCode, 400);
  assert.equal((unknownKind.json() as { code?: string }).code, "COLLAB_REJECTED");
  const nul = await post(0, [insert({ type: "text", text: "a\u0000b" })]);
  assert.equal((nul.json() as { code?: string }).code, "COLLAB_REJECTED");
  const many = await post(0, Array.from({ length: 1001 }, () => insert({ type: "text", text: "x" })));
  assert.equal(many.statusCode, 413);
  assert.equal((many.json() as { code?: string }).code, "COLLAB_TOO_LARGE");
  // The page still saves after the refusals.
  const typed = await ok<Joined & { version: number; saved: number }>(post(0, [insert({ type: "text", text: "Kept " })], { flush: true }));
  assert.equal(typed.saved, 1, "flush answers with the version now stored");

  // Typing not yet written back when the page goes to Trash (as the assistant's delete does, without a flush first).
  await ok(post(1, [{ stepType: "replace", from: 6, to: 6, slice: { content: [{ type: "text", text: "and more" }] } }]));
  await db.$transaction((tx) => trashStandalonePage(tx, mira.id, page));
  sseHub.publish(mira.id, { event: "page", data: { id: page, action: "delete" } });
  let stored = "";
  for (let tries = 0; tries < 100 && !stored.includes("and more"); tries += 1) {
    const row = await db.taskPage.findUniqueOrThrow({ where: { id: page } });
    stored = JSON.stringify(row.content);
    if (!stored.includes("and more")) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(stored, /Kept and more/);
  const inTrash = await as(mira, { method: "GET", url });
  assert.equal(inTrash.statusCode, 404);
  assert.equal((inTrash.json() as { code?: string }).code, "PAGE_IN_TRASH");
  assert.ok((await db.taskPage.findUniqueOrThrow({ where: { id: page } })).deletedAt, "still in Trash");
});

test("a write published before its transaction commits still reaches the live page", async () => {
  const { writePageContent } = await import("./store.js");
  const mira = await person("Mira Chen");
  const page = (await ok<{ page: { id: string } }>(as(mira, { method: "POST", url: "/api/pages" }), 201)).page.id;
  const url = `/api/pages/${page}/collab`;
  await ok<Joined>(as(mira, { method: "GET", url }));
  await db.$transaction(async (tx) => {
    await writePageContent(tx, mira.id, { pageId: page }, () => ({ content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Written by the assistant" }] }] } }), "agent");
    // As a tool inside a held batch does: the event goes out before the batch commits.
    sseHub.publish(mira.id, { event: "page", data: { id: page, action: "save", by: "agent" } });
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  let text = "";
  for (let tries = 0; tries < 300 && !text.includes("assistant"); tries += 1) {
    text = textOf((await ok<Joined>(as(mira, { method: "GET", url }))).doc);
    if (!text.includes("assistant")) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(text, "Written by the assistant");
});

test("deleting a page or task, or converting one, writes back typing first", async () => {
  const mira = await person("Mira Chen");
  const task = (await ok<{ task: { id: string } }>(as(mira, { method: "POST", url: "/api/tasks", payload: { title: "Plan", notes: "Notes" } }), 201)).task.id;
  const url = `/api/tasks/${task}/page/collab`;
  const joined = await ok<Joined>(as(mira, { method: "GET", url }));
  await ok(as(mira, { method: "POST", url, payload: { epoch: joined.epoch, version: 0, clientID: joined.clientID, token: joined.token, steps: [{ stepType: "replace", from: 1, to: 1, slice: { content: [{ type: "text", text: "Typed " }] } }] } }));
  await ok(as(mira, { method: "DELETE", url: `/api/tasks/${task}` }));
  const row = await db.taskPage.findFirstOrThrow({ where: { taskId: task } });
  assert.match(JSON.stringify(row.content), /Typed Notes/);
});

test("the stored copy remembers the live authority that wrote it, until something else writes", async () => {
  const { readCollabPage, writeCollabPage } = await import("./store.js");
  const mira = await person("Mira Chen");
  const page = (await ok<{ page: { id: string } }>(as(mira, { method: "POST", url: "/api/pages" }), 201)).page.id;
  const doc = { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Live" }] }] };
  const written = await writeCollabPage(db, mira.id, { pageId: page }, () => ({ content: doc, marker: { epoch: "epoch-1", version: 7 } }));
  assert.deepEqual((await readCollabPage(db, mira.id, { pageId: page }))?.marker, { epoch: "epoch-1", version: 7 });
  await ok(as(mira, { method: "PUT", url: `/api/pages/${page}`, payload: { revision: written!.revision, content: doc } }));
  assert.equal((await readCollabPage(db, mira.id, { pageId: page }))?.marker, undefined, "a whole-page save since: no longer known");
});

test("half a character is refused with the step that has it, and a whole-page save stores it mended", async () => {
  const mira = await person("Mira Chen");
  const page = (await ok<{ page: { id: string } }>(as(mira, { method: "POST", url: "/api/pages" }), 201)).page.id;
  const url = `/api/pages/${page}/collab`;
  const joined = await ok<Joined>(as(mira, { method: "GET", url }));
  const insert = (text: string) => ({ stepType: "replace", from: 1, to: 1, slice: { content: [{ type: "text", text }] } });
  const half = await as(mira, { method: "POST", url, payload: { epoch: joined.epoch, version: 0, clientID: joined.clientID, token: joined.token, steps: [insert("ok "), insert("\ud83d")] } });
  assert.equal(half.statusCode, 400);
  assert.deepEqual([(half.json() as { code?: string }).code, (half.json() as { step?: number }).step], ["COLLAB_REJECTED", 1]);
  const saved = await ok<{ revision: number }>(as(mira, { method: "POST", url, payload: { epoch: joined.epoch, version: 0, clientID: joined.clientID, token: joined.token, steps: [insert("Still saves ")], flush: true } }));
  assert.equal(saved.revision, 2);
  // An older tab's whole-page save with a NUL and half a character: stored, mended.
  const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a\u0000b \ud83d c" }] }] };
  const put = await ok<{ content: { content: Array<{ content: Array<{ text: string }> }> } }>(as(mira, { method: "PUT", url: `/api/pages/${page}`, payload: { revision: 2, content } }));
  assert.equal(put.content.content[0]!.content[0]!.text, "ab � c");
});

test("typing written back into a page in Trash leaves Undo of the delete working", async () => {
  const { trashStandalonePage } = await import("./store.js");
  const mira = await person("Mira Chen");
  const page = (await ok<{ page: { id: string } }>(as(mira, { method: "POST", url: "/api/pages" }), 201)).page.id;
  const url = `/api/pages/${page}/collab`;
  const joined = await ok<Joined>(as(mira, { method: "GET", url }));
  await ok(as(mira, { method: "POST", url, payload: { epoch: joined.epoch, version: 0, clientID: joined.clientID, token: joined.token, steps: [{ stepType: "replace", from: 1, to: 1, slice: { content: [{ type: "text", text: "Typed before Trash" }] } }] } }));
  // The assistant's delete: no flush first; the write-back lands in the page in Trash.
  await db.$transaction((tx) => trashStandalonePage(tx, mira.id, page));
  sseHub.publish(mira.id, { event: "page", data: { id: page, action: "delete" } });
  let stored = "";
  for (let tries = 0; tries < 100 && !stored.includes("Typed"); tries += 1) {
    stored = JSON.stringify((await db.taskPage.findUniqueOrThrow({ where: { id: page } })).content);
    if (!stored.includes("Typed")) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(stored, /Typed before Trash/);
  const undone = await as(mira, { method: "POST", url: "/api/undo", payload: {} });
  assert.equal(undone.statusCode, 200, undone.body);
  const back = await ok<{ content: unknown }>(as(mira, { method: "GET", url: `/api/pages/${page}` }));
  assert.match(JSON.stringify(back.content), /Typed before Trash/);
});

test("a request of steps over 4 MiB (one large paste of CJK text) is taken, not refused by the body limit", async () => {
  const mira = await person("Mira Chen");
  const page = (await ok<{ page: { id: string } }>(as(mira, { method: "POST", url: "/api/pages" }), 201)).page.id;
  const url = `/api/pages/${page}/collab`;
  const joined = await ok<Joined>(as(mira, { method: "GET", url }));
  // 600,000 characters of 3-byte text: under the 1,000,000-character step limit, 1.8 MB a step.
  const text = "漢".repeat(600_000);
  const insert = (at: number) => ({ stepType: "replace", from: at, to: at, slice: { content: [{ type: "text", text }] } });
  const payload = JSON.stringify({ epoch: joined.epoch, version: 0, clientID: joined.clientID, token: joined.token, steps: [insert(1), insert(1), insert(1)] });
  assert.ok(Buffer.byteLength(payload) > 4 * 1024 * 1024);
  const sent = await as(mira, { method: "POST", url, payload, headers: { "content-type": "application/json" } });
  assert.equal(sent.statusCode, 200, sent.body.slice(0, 200));
  assert.equal((sent.json() as Batch).version, 3);
});
