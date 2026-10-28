import assert from "node:assert/strict";
import test from "node:test";
import { handleFrom, parseMentions, resolveMentions, uniqueHandle } from "./mentions.js";
import { MAX_BOT_DEPTH, MAX_BOT_STREAK, botStreak, parseRelevance, whoSpeaks, type RouteMessage, type RouteNode } from "./router.js";
import { cleanReply } from "./reply.js";
import { CREW_TEMPLATES, NODE_TEMPLATES } from "./templates.js";
import { mirrorNeedsMe, nodeChannel } from "./events.js";
import { sseHub, type Frame } from "../lib/sse.js";

test("mentions skip emails and code, and resolve against the room", () => {
  assert.deepEqual(
    parseMentions("@manager ask mira@example.com and `@tester` then (@docs-, @Everyone").map((row) => row.handle),
    ["manager", "docs", "everyone"],
  );
  assert.deepEqual(parseMentions("```\n@manager\n```"), []);
  const directory = [
    { handle: "manager", kind: "node" as const, id: "n1" },
    { handle: "mira", kind: "human" as const, id: "a1" },
  ];
  assert.deepEqual(resolveMentions("@manager and @mira and @nobody", directory), { mentions: [{ kind: "node", id: "n1" }, { kind: "human", id: "a1" }], allNodes: false });
  assert.equal(resolveMentions("@nodes go", directory).allNodes, true);
});

test("handles are lowercase, unique in the room, and never a special mention", () => {
  assert.equal(handleFrom("Mira Chen"), "mira-chen");
  assert.equal(handleFrom("asha@example.com"), "asha");
  assert.equal(handleFrom("!!!"), "member");
  assert.equal(uniqueHandle("manager", new Set(["manager", "manager-2"])), "manager-3");
  assert.equal(uniqueHandle("everyone", new Set()), "everyone-2");
});

const message = (patch: Partial<RouteMessage> = {}): RouteMessage => ({ kind: "text", authorKind: "human", authorNodeId: null, visibleTo: [], mentions: [], botDepth: 0, ...patch });
const node = (id: string, ownerId: string, patch: Partial<RouteNode> = {}): RouteNode => ({ id, ownerId, active: true, representative: false, role: "assistant", ...patch });

test("a DM's node answers its person; in a crew one node answers: the one mentioned, else the lead", () => {
  assert.deepEqual(whoSpeaks(message(), { kind: "dm", leadNodeIds: [] }, [node("n1", "mira")], 0), { reason: "dm", nodeIds: ["n1"] });
  const crew = [node("n1", "mira"), node("n2", "mira", { role: "manager" }), node("n3", "mira")];
  assert.deepEqual(whoSpeaks(message(), { kind: "crew", leadNodeIds: [] }, crew, 0), { reason: "lead", nodeIds: ["n2"] });
  assert.deepEqual(whoSpeaks(message(), { kind: "crew", leadNodeIds: ["n3"] }, crew, 0), { reason: "lead", nodeIds: ["n3"] });
  assert.deepEqual(whoSpeaks(message({ mentions: [{ kind: "node", id: "n1" }] }), { kind: "crew", leadNodeIds: ["n3"] }, crew, 0), { reason: "mentioned", nodeIds: ["n1"] });
  const several = message({ mentions: [{ kind: "node", id: "n1" }, { kind: "node", id: "n2" }, { kind: "node", id: "n3" }] });
  assert.deepEqual(whoSpeaks(several, { kind: "crew", leadNodeIds: ["n3"] }, crew, 0), { reason: "lead", nodeIds: ["n3"] }, "several named: only the lead answers, and plans for the rest");
  assert.deepEqual(whoSpeaks(message({ mentions: [{ kind: "human", id: "asha" }] }), { kind: "crew", leadNodeIds: ["n3"] }, crew, 0).reason, "none", "talking to a person wakes no node");
  assert.deepEqual(whoSpeaks(message(), { kind: "crew", leadNodeIds: [] }, [node("n1", "mira", { active: false })], 0).reason, "none", "a paused node is never woken");
});

test("a private message wakes only its people's nodes, even when another node is mentioned", () => {
  const nodes = [node("mine", "mira", { representative: true }), node("bens", "ben", { representative: true })];
  const result = whoSpeaks(message({ visibleTo: ["mira"], mentions: [{ kind: "node", id: "bens" }] }), { kind: "room", leadNodeIds: [] }, nodes, 0);
  assert.deepEqual(result, { reason: "none", nodeIds: [] });
  assert.deepEqual(whoSpeaks(message({ visibleTo: ["mira"] }), { kind: "room", leadNodeIds: [] }, nodes, 0), { reason: "lead", nodeIds: ["mine"] });
});

test("in a group, one representative answers; several go to the relevance call", () => {
  const one = [node("mine", "mira", { representative: true }), node("worker", "mira")];
  assert.deepEqual(whoSpeaks(message(), { kind: "room", leadNodeIds: [] }, one, 0), { reason: "lead", nodeIds: ["mine"] });
  const two = [node("mine", "mira", { representative: true }), node("bens", "ben", { representative: true })];
  assert.deepEqual(whoSpeaks(message(), { kind: "room", leadNodeIds: [] }, two, 0), { reason: "relevance", nodeIds: [], candidates: ["mine", "bens"] });
  const candidates = [
    { id: "mine", handle: "manager", owner: "Mira", role: "manager", focus: "backend" },
    { id: "bens", handle: "ben-manager", owner: "Ben", role: "manager", focus: "frontend" },
  ];
  assert.deepEqual(parseRelevance({ nodes: ["@Ben-Manager", "stranger"] }, candidates), ["bens"]);
  assert.deepEqual(parseRelevance("not json", candidates), []);
});

test("node messages wake only mentioned nodes, under the streak and depth brakes, and none in a crew", () => {
  const nodes = [node("a", "mira"), node("b", "mira"), node("c", "ben")];
  const fromNode = message({ authorKind: "node", authorNodeId: "a", mentions: [{ kind: "node", id: "b" }, { kind: "node", id: "a" }] });
  assert.deepEqual(whoSpeaks(fromNode, { kind: "room", leadNodeIds: ["a"] }, nodes, 1), { reason: "mentioned", nodeIds: ["b"] }, "never itself");
  assert.deepEqual(whoSpeaks(message({ authorKind: "node", authorNodeId: "a" }), { kind: "room", leadNodeIds: ["b"] }, nodes, 1).reason, "none", "no lead fallback for nodes");
  assert.deepEqual(whoSpeaks(fromNode, { kind: "room", leadNodeIds: [] }, nodes, MAX_BOT_STREAK), { reason: "none", nodeIds: [], brake: "streak" });
  assert.deepEqual(whoSpeaks({ ...fromNode, botDepth: MAX_BOT_DEPTH }, { kind: "room", leadNodeIds: [] }, nodes, 1), { reason: "none", nodeIds: [], brake: "depth" });
  assert.deepEqual(whoSpeaks(fromNode, { kind: "crew", leadNodeIds: ["a"] }, nodes, 1), { reason: "none", nodeIds: [] }, "in a crew nodes never wake each other: they work through plans");
  assert.equal(whoSpeaks(message({ kind: "approval" }), { kind: "dm", leadNodeIds: [] }, nodes, 0).reason, "none", "cards never wake anyone");
  assert.equal(botStreak([{ authorKind: "node", kind: "text" }, { authorKind: "node", kind: "run" }, { authorKind: "node", kind: "text" }, { authorKind: "human", kind: "text" }, { authorKind: "node", kind: "text" }]), 2);
});

test("templates name real nodes, and every crew has its lead", () => {
  const ids = new Set(NODE_TEMPLATES.map((row) => row.id));
  assert.equal(ids.size, NODE_TEMPLATES.length);
  assert.equal(new Set(NODE_TEMPLATES.map((row) => row.slug)).size, NODE_TEMPLATES.length);
  for (const crew of CREW_TEMPLATES) {
    assert.ok(crew.nodes.every((id) => ids.has(id)), crew.id);
    assert.ok(crew.nodes.includes(crew.lead), crew.id);
  }
});

test("a posted reply drops the outcome lines that its tool chips already show, never the whole reply", async () => {
  const reply = "Added it.\n\nDone: Added 1 task(s): “Write the README” (id).\n\nNothing has changed yet — press Apply.";
  assert.equal(cleanReply(reply, true), "Added it.");
  assert.equal(cleanReply(reply, false), "Added it.\n\nDone: Added 1 task(s): “Write the README” (id).");
  assert.equal(cleanReply("Done: Added 1 task(s): “A”.", true), "Done: Added 1 task(s): “A”.", "only facts: they stay");
});

test("Needs me changes on the person's channel nudge their Node stream, without the card's content", () => {
  const seen: Array<{ userId: string; frame: Frame }> = [];
  const stop = sseHub.onFrame((event) => seen.push(event));
  try {
    mirrorNeedsMe();
    mirrorNeedsMe();
    sseHub.publish("acct-1", { event: "decision", data: { id: "d1", title: "Run npm test?" } });
    sseHub.publish("acct-1", { event: "task", data: { id: "t1" } });
    sseHub.publish("acct-1", { event: "decision", data: { id: "d2" }, to: "someone-else" });
    const nudges = seen.filter((row) => row.userId === nodeChannel("acct-1"));
    assert.deepEqual(nudges.map((row) => row.frame), [{ event: "node.needs", data: { kind: "decision" } }], "once, for the decision only, with no title");
  } finally {
    stop();
  }
});
