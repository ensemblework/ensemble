import assert from "node:assert/strict";
import test from "node:test";
import { handleFrom, parseMentions, resolveMentions, uniqueHandle } from "./mentions.js";
import { MAX_BOT_DEPTH, MAX_BOT_STREAK, botStreak, leadsStatus, whoSpeaks, type RouteDecision, type RouteMessage, type RouteNode } from "./router.js";
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
const targetsOf = (decision: RouteDecision) => ("targets" in decision ? decision.targets : undefined);

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

test("in a room with other people, a private message wakes only its person's nodes, privately: their lead unless they name one of theirs", () => {
  const nodes = [node("mine", "mira", { representative: true }), node("builder", "mira"), node("bens", "ben", { representative: true })];
  const room = { kind: "room" as const, leadNodeIds: [] };
  const mine = { nodeId: "mine", private: true, audience: "owner" };
  assert.deepEqual(whoSpeaks(message({ authorId: "mira", visibleTo: ["mira"], mentions: [{ kind: "node", id: "bens" }] }), room, nodes, 0), { reason: "lead", nodeIds: ["mine"], targets: [mine] }, "another person's node never reads a private message");
  assert.deepEqual(whoSpeaks(message({ authorId: "mira", visibleTo: ["mira"] }), room, nodes, 0), { reason: "lead", nodeIds: ["mine"], targets: [mine] });
  assert.deepEqual(
    whoSpeaks(message({ authorId: "mira", visibleTo: ["mira"], mentions: [{ kind: "node", id: "builder" }] }), room, nodes, 0),
    { reason: "mentioned", nodeIds: ["builder"], targets: [{ nodeId: "builder", private: true, audience: "owner" }] },
  );
  assert.equal(whoSpeaks(message({ authorId: "mira", visibleTo: ["mira"] }), room, [node("mine", "mira", { representative: true, active: false })], 0).reason, "none", "a paused lead is never woken");
});

test("rooms v2: unaddressed messages wake nobody; a mentioned lead answers in public; nodes are answered for by their person's lead", () => {
  const room = { kind: "room" as const, leadNodeIds: [] };
  const nodes = [
    node("mira-lead", "mira", { representative: true, handle: "lead" }),
    node("mira-builder", "mira", { handle: "builder" }),
    node("ben-lead", "ben", { representative: true, handle: "ben-lead" }),
    node("ben-tester", "ben", { handle: "tester" }),
  ];
  const from = (mentions: RouteMessage["mentions"], patch: Partial<RouteMessage> = {}) => message({ authorId: "mira", mentions, ...patch });
  assert.deepEqual(whoSpeaks(from([]), room, nodes, 0), { reason: "none", nodeIds: [] }, "human to human: no node, no suggestion");
  assert.deepEqual(whoSpeaks(from([{ kind: "human", id: "ben" }]), room, nodes, 0).reason, "none");
  assert.deepEqual(whoSpeaks(from([{ kind: "node", id: "ben-lead" }]), room, nodes, 0), {
    reason: "mentioned",
    nodeIds: ["ben-lead"],
    targets: [{ nodeId: "ben-lead", private: false, audience: "room" }],
  });
  assert.deepEqual(
    targetsOf(whoSpeaks(from([{ kind: "node", id: "mira-lead" }]), room, nodes, 0)),
    [{ nodeId: "mira-lead", private: false, audience: "room" }],
    "even the owner's own question in public is answered for the room",
  );
  assert.deepEqual(targetsOf(whoSpeaks(from([{ kind: "node", id: "mira-builder" }]), room, nodes, 0)), [{ nodeId: "mira-builder", private: true, audience: "owner" }], "my own other node answers me in My crew");
  const routed = whoSpeaks(from([{ kind: "node", id: "ben-tester" }]), room, nodes, 0);
  assert.deepEqual(routed.nodeIds, ["ben-lead"], "Ben's tester is answered for by Ben's lead");
  assert.equal(routed.reason === "mentioned" && routed.targets?.[0]?.audience, "room");
  assert.match((routed.reason === "mentioned" && routed.targets?.[0]?.note) || "", /@tester .*Only leads answer in public/);
  assert.deepEqual(whoSpeaks(from([{ kind: "node", id: "ben-lead" }, { kind: "node", id: "ben-tester" }]), room, nodes, 0).nodeIds, ["ben-lead"], "one voice per person");
  const paused = nodes.map((row) => (row.id === "ben-lead" ? { ...row, active: false } : row));
  assert.equal(whoSpeaks(from([{ kind: "node", id: "ben-tester" }]), room, paused, 0).reason, "none", "a paused lead answers nobody");
  const fromNode = message({ authorKind: "node", authorNodeId: "ben-lead", authorId: "ben", mentions: [{ kind: "node", id: "mira-lead" }] });
  assert.deepEqual(whoSpeaks(fromNode, room, nodes, 1), { reason: "none", nodeIds: [] }, "nodes never wake nodes here");
});

test("`@leads status` (and only that) is answered by code", () => {
  for (const text of ["@leads status", "@leads, status?", "@Leads: status!", "  @leads — status ", "@leads status??"]) assert.equal(leadsStatus(text), true, text);
  for (const text of ["@leads status of billing?", "status @leads", "@leads what's up", "@lead status", "leads status"]) assert.equal(leadsStatus(text), false, text);
  assert.deepEqual(whoSpeaks(message({ authorId: "mira", text: "@leads, status?" }), { kind: "room", leadNodeIds: [] }, [node("a", "mira", { representative: true })], 0), { reason: "status", nodeIds: [] });
  assert.equal(whoSpeaks(message({ authorId: "mira", text: "@leads status" }), { kind: "crew", leadNodeIds: ["a"] }, [node("a", "mira")], 0).reason, "lead", "only rooms with other people have status cards");
});

test("node messages wake only mentioned nodes, under the streak and depth brakes; none in a crew or a room with other people", () => {
  const nodes = [node("a", "mira"), node("b", "mira"), node("c", "ben")];
  const fromNode = message({ authorKind: "node", authorNodeId: "a", mentions: [{ kind: "node", id: "b" }, { kind: "node", id: "a" }] });
  const task = { kind: "task" as const, leadNodeIds: [] };
  assert.deepEqual(whoSpeaks(fromNode, task, nodes, 1), { reason: "mentioned", nodeIds: ["b"] }, "never itself");
  assert.deepEqual(whoSpeaks(message({ authorKind: "node", authorNodeId: "a" }), { kind: "dm", leadNodeIds: ["b"] }, nodes, 1).reason, "none", "no lead fallback for nodes");
  assert.deepEqual(whoSpeaks(fromNode, { kind: "dm", leadNodeIds: [] }, nodes, MAX_BOT_STREAK), { reason: "none", nodeIds: [], brake: "streak" });
  assert.deepEqual(whoSpeaks(fromNode, task, nodes, MAX_BOT_STREAK), { reason: "mentioned", nodeIds: ["b"] }, "a helper's room has no streak brake");
  assert.deepEqual(whoSpeaks({ ...fromNode, botDepth: MAX_BOT_DEPTH }, task, nodes, 1), { reason: "none", nodeIds: [], brake: "depth" });
  assert.deepEqual(whoSpeaks(fromNode, { kind: "crew", leadNodeIds: ["a"] }, nodes, 1), { reason: "none", nodeIds: [] }, "in a crew nodes never wake each other: they work through plans");
  assert.deepEqual(whoSpeaks(fromNode, { kind: "room", leadNodeIds: ["a"] }, nodes, 1), { reason: "none", nodeIds: [] }, "nor in a room with other people");
  assert.equal(whoSpeaks(message({ kind: "approval" }), { kind: "dm", leadNodeIds: [] }, nodes, 0).reason, "none", "cards never wake anyone");
  assert.equal(whoSpeaks(message({ kind: "request", authorId: "mira", text: "@leads status" }), { kind: "room", leadNodeIds: [] }, nodes, 0).reason, "none", "nor do request cards");
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
