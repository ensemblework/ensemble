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

type Joined = { epoch: string; version: number; doc: unknown; revision: number };
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
    assert.equal(caraJoin.epoch, miraJoin.epoch);
    assert.equal(caraJoin.version, 0);
    assert.equal(miraJoin.revision, 2);
    assert.equal(textOf(miraJoin.doc), "Plan");

    const start = pageDoc(miraJoin.doc);
    const miraEdit = typed(start, endOfFirst(start), " the launch");
    const caraEdit = typed(start, endOfFirst(start), " next week");
    const [first, second] = await Promise.all([
      as(mira, { method: "POST", url, payload: { epoch: miraJoin.epoch, version: 0, clientID: "mira-tab", steps: miraEdit.steps.map((step) => step.toJSON()) } }),
      as(cara, { method: "POST", url, payload: { epoch: caraJoin.epoch, version: 0, clientID: "cara-tab", steps: caraEdit.steps.map((step) => step.toJSON()) } }, caraShare),
    ]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 409, "the second post was made against a version that moved on");
    const missed = second.json() as Batch;
    assert.equal(missed.code, "COLLAB_BEHIND");
    assert.deepEqual(missed.clientIDs, ["mira-tab"]);
    const confirmed = await ok<Batch>(as(cara, { method: "POST", url, payload: { epoch: caraJoin.epoch, version: missed.version, clientID: "cara-tab", steps: rebased(caraEdit, missed) } }, caraShare));
    assert.equal(confirmed.version, 2);
    assert.deepEqual(confirmed.clientIDs, ["cara-tab"]);
    const steps = frames.filter((frame) => frame.event === "page.steps" && frame.data.id === page);
    assert.deepEqual(steps.map((frame) => [frame.data.from, frame.data.clientIDs]), [[0, ["mira-tab"]], [1, ["cara-tab"]]]);

    // Catching up after a gap.
    const gap = await ok<Batch>(as(mira, { method: "GET", url: `${url}?epoch=${miraJoin.epoch}&version=1` }));
    assert.deepEqual(gap.clientIDs, ["cara-tab"]);
    const reset = await as(mira, { method: "GET", url: `${url}?epoch=stale&version=1` });
    assert.equal(reset.statusCode, 410);

    // A viewer follows along but cannot type; someone with no share sees nothing.
    assert.equal(textOf((await ok<Joined>(as(vic, { method: "GET", url }, vicShare))).doc), "Plan the launch next week");
    const refused = await as(vic, { method: "POST", url, payload: { epoch: miraJoin.epoch, version: 2, clientID: "vic", steps: [] } }, vicShare);
    assert.equal(refused.statusCode, 403);
    assert.equal((await as(dev, { method: "GET", url })).statusCode, 404);
    assert.equal((await as(dev, { method: "GET", url }, caraShare)).statusCode, 404, "someone else's share is not yours");

    // Flush writes it back and answers with the stored revision.
    const flushed = await ok<Batch>(as(cara, { method: "POST", url, payload: { epoch: caraJoin.epoch, version: 2, clientID: "cara-tab", steps: [], flush: true } }, caraShare));
    const stored = await ok<{ revision: number; content: unknown }>(as(mira, { method: "GET", url: `/api/pages/${page}` }));
    assert.equal(stored.revision, flushed.revision);
    assert.equal(textOf(stored.content), "Plan the launch next week");
    assert.ok(frames.some((frame) => frame.event === "page" && frame.data.id === page && frame.data.by === "collab" && frame.data.revision === stored.revision));

    // An older tab that still saves whole pages: its save is taken into the live page, with live typing kept.
    const live = pageDoc((await ok<Joined>(as(mira, { method: "GET", url }))).doc);
    await ok(as(mira, { method: "POST", url, payload: { epoch: miraJoin.epoch, version: 2, clientID: "mira-tab", steps: typed(live, 1, "Draft: ").steps.map((step) => step.toJSON()) } }));
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
  const late = await as(cara, { method: "POST", url, payload: { epoch: "any", version: 0, clientID: "cara-tab", steps: [] } }, caraShare);
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
  await ok(as(cara, { method: "POST", url, payload: { epoch: joined.epoch, version: 0, clientID: "cara", steps: typed(start, endOfFirst(start), " (edited)").steps.map((step) => step.toJSON()) } }, share));

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
