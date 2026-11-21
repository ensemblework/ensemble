import assert from "node:assert/strict";
import test from "node:test";
import { handleFrom, parseMentions, resolveMentions, uniqueHandle } from "./mentions.js";
import { MAX_BOT_DEPTH, MAX_BOT_STREAK, botStreak, leadsStatus, loopBrake, routeRecord, whoSpeaks, type RouteDecision, type RouteMessage, type RouteNode } from "./router.js";
import { activeHeuristics, DEFAULT_NODE_HEURISTICS, heuristicsVersion, resetHeuristicsCache } from "./heuristics.js";
import { cleanReply } from "./reply.js";
import { CREW_TEMPLATES, NODE_TEMPLATES, charterOf, nodeTemplate, paletteAvatar } from "./templates.js";
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

test("a room's steward answers whoever names it, in public; without a steward the node's person's lead answers", () => {
  const nodes = [node("mira-lead", "mira", { representative: true, handle: "lead" }), node("mira-scribe", "mira", { handle: "scribe" }), node("ben-lead", "ben", { representative: true, handle: "ben-lead" })];
  const named = (authorId: string) => message({ authorId, mentions: [{ kind: "node", id: "mira-scribe" }] });
  const stewarded = { kind: "room" as const, leadNodeIds: ["mira-scribe"] };
  assert.deepEqual(targetsOf(whoSpeaks(named("ben"), stewarded, nodes, 0)), [{ nodeId: "mira-scribe", private: false, audience: "room" }], "for Ben, in public");
  assert.deepEqual(targetsOf(whoSpeaks(named("mira"), stewarded, nodes, 0)), [{ nodeId: "mira-scribe", private: false, audience: "room" }], "for its sponsor too");
  assert.deepEqual(targetsOf(whoSpeaks(named("ben"), { kind: "room", leadNodeIds: [] }, nodes, 0))?.map((row) => row.nodeId), ["mira-lead"], "no steward: Mira's lead answers for her node");
  assert.deepEqual(targetsOf(whoSpeaks(message({ authorId: "mira", mentions: [{ kind: "node", id: "mira-scribe" }], visibleTo: ["mira"] }), stewarded, nodes, 0)), [{ nodeId: "mira-scribe", private: true, audience: "owner" }], "in My crew it is its sponsor's own node");
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

test("the brakes and fan-outs come from the heuristics config, and a decision records what it read and chose", () => {
  const nodes = [node("a", "mira"), node("b", "mira"), node("c", "mira"), node("d", "ben", { active: false })];
  const tight = { ...DEFAULT_NODE_HEURISTICS.router, botStreak: 2, botDepth: 3, humanFanout: 2, nodeFanout: 1 };
  const dm = { kind: "dm" as const, leadNodeIds: [] };
  const fromNode = message({ authorKind: "node", authorNodeId: "a", mentions: [{ kind: "node", id: "b" }, { kind: "node", id: "c" }] });
  assert.deepEqual(whoSpeaks(fromNode, dm, nodes, 2, tight), { reason: "none", nodeIds: [], brake: "streak" });
  assert.deepEqual(whoSpeaks({ ...fromNode, botDepth: 3 }, dm, nodes, 0, tight), { reason: "none", nodeIds: [], brake: "depth" });
  assert.deepEqual(whoSpeaks(fromNode, dm, nodes, 1, tight), { reason: "mentioned", nodeIds: ["b"], capped: 1 }, "a node's message wakes one, and says how many it left out");
  const three = message({ authorId: "mira", mentions: ["a", "b", "c"].map((id) => ({ kind: "node" as const, id })) });
  assert.deepEqual(whoSpeaks(three, dm, nodes, 0, tight), { reason: "mentioned", nodeIds: ["a", "b"], capped: 1 });
  assert.deepEqual(whoSpeaks(three, dm, nodes, 0), { reason: "mentioned", nodeIds: ["a", "b", "c"] }, "the defaults let all three answer");

  const routed = { ...three, id: "m1", roomId: "r1", text: "secret plans for the launch", replyTo: { id: "m0", seq: 4, authorKind: "node", excerpt: "earlier words" } };
  const record = routeRecord(routed, dm, nodes, 0, tight, whoSpeaks(routed, dm, nodes, 0, tight));
  assert.deepEqual(record.inputs, {
    messageId: "m1",
    roomId: "r1",
    roomKind: "dm",
    author: { kind: "human" },
    private: false,
    mentions: [{ kind: "node", id: "a" }, { kind: "node", id: "b" }, { kind: "node", id: "c" }],
    replyTo: { id: "m0", seq: 4, authorKind: "node" },
    leadNodeIds: [],
    mode: "coordinated",
    nodes: [{ id: "a", active: true, authorsOwn: true }, { id: "b", active: true, authorsOwn: true }, { id: "c", active: true, authorsOwn: true }, { id: "d", active: false }],
    brakes: { streak: 0, depth: 0, botStreak: 2, botDepth: 3, humanFanout: 2, nodeFanout: 1, loopWindow: 12 },
  });
  assert.deepEqual(record.choice, { reason: "mentioned", capped: 1, woken: [{ nodeId: "a", private: false, audience: "owner" }, { nodeId: "b", private: false, audience: "owner" }] });
  assert.ok(!JSON.stringify(record).includes("secret plans") && !JSON.stringify(record).includes("earlier words"), "never the message's words");
  const braked = routeRecord({ ...fromNode, id: "m2", roomId: "r1" }, dm, nodes, 2, tight, whoSpeaks(fromNode, dm, nodes, 2, tight));
  assert.deepEqual(braked.choice, { reason: "none", brake: "streak", woken: [] });
});

test("independent views: a message naming several nodes has each answer, and names who brings the answers together", () => {
  const nodes = [node("lead", "mira"), node("a", "mira"), node("b", "mira"), node("ben-lead", "ben", { representative: true }), node("mira-lead", "mira", { representative: true }), node("steward", "ben")];
  const crew = { kind: "crew" as const, leadNodeIds: ["lead"] };
  const both = message({ authorId: "mira", mentions: [{ kind: "node", id: "a" }, { kind: "node", id: "b" }] });
  assert.deepEqual(whoSpeaks(both, crew, nodes, 0), { reason: "lead", nodeIds: ["lead"] }, "coordinated (the default): the lead answers and coordinates");
  assert.deepEqual(whoSpeaks(both, { ...crew, mode: "independent" }, nodes, 0), { reason: "mentioned", nodeIds: ["a", "b"], independent: { synthesizerId: "lead" } });
  assert.deepEqual(whoSpeaks(message({ authorId: "mira", mentions: [{ kind: "node", id: "a" }] }), { ...crew, mode: "independent" }, nodes, 0), { reason: "mentioned", nodeIds: ["a"] }, "one node named: no round");
  assert.deepEqual(whoSpeaks(both, { kind: "crew", leadNodeIds: [], mode: "independent" }, nodes, 0), { reason: "mentioned", nodeIds: ["a", "b"], independent: { synthesizerId: "a" } }, "no lead: the first named");
  const leads = message({ authorId: "mira", mentions: [{ kind: "node", id: "ben-lead" }, { kind: "node", id: "mira-lead" }] });
  const room = { kind: "room" as const, leadNodeIds: [] as string[], mode: "independent" as const };
  assert.equal((whoSpeaks(leads, room, nodes, 0) as { independent?: { synthesizerId: string } }).independent?.synthesizerId, "mira-lead", "in a room: the author's own lead");
  assert.equal((whoSpeaks(leads, { ...room, leadNodeIds: ["steward"] }, nodes, 0) as { independent?: { synthesizerId: string } }).independent?.synthesizerId, "steward", "or the room's steward");
  const record = routeRecord({ ...both, id: "m1", roomId: "r1" }, { ...crew, mode: "independent" }, nodes, 0, DEFAULT_NODE_HEURISTICS.router, whoSpeaks(both, { ...crew, mode: "independent" }, nodes, 0));
  assert.equal(record.inputs.mode, "independent");
  assert.deepEqual([record.choice.independent, record.choice.synthesizerId], [true, "lead"]);
});

test("the loop brakes: a node saying again what it said since the last person's message, alone or back and forth with one other", () => {
  const said = (authorNodeId: string | null, body: string) => ({ authorNodeId, body });
  assert.equal(loopBrake([said("a", "@b can you check?"), said("b", "@a checked"), said("a", "@B Can you check")]), "cycle", "the same words passed back and forth");
  assert.equal(loopBrake([said("a", "@b ship it"), said("a", "@b ship it!")]), "duplicate", "said twice in a row");
  assert.equal(loopBrake([said("a", "@b ship it"), said("b", "@c look"), said("c", "@a done"), said("a", "@b ship it")]), "duplicate", "repeated with more than one other in between");
  assert.equal(loopBrake([said("a", "@b check part 1"), said("b", "@a done"), said("a", "@b check part 2")]), null, "new words go on");
  assert.equal(loopBrake([said("b", "@a ship it"), said("a", "@b ship it")]), null, "another node's words, not its own");
  assert.equal(loopBrake([said("a", "@b")]), null);
});

test("an override of the heuristics config changes only what it names; an invalid one is ignored and logged", () => {
  const warned: string[] = [];
  const log = { warn: (_data: unknown, text: string) => warned.push(text) };
  try {
    process.env.ENSEMBLE_NODE_HEURISTICS_CONFIG = JSON.stringify({ version: "tuned-1", router: { botStreak: 4 } });
    resetHeuristicsCache();
    const tuned = activeHeuristics(log);
    assert.deepEqual(tuned.router, { ...DEFAULT_NODE_HEURISTICS.router, botStreak: 4 });
    assert.match(heuristicsVersion(tuned), /^tuned-1:[0-9a-f]{12}$/);
    assert.notEqual(heuristicsVersion(tuned).split(":")[1], heuristicsVersion(DEFAULT_NODE_HEURISTICS).split(":")[1], "the hash tells the numbers apart");
    process.env.ENSEMBLE_NODE_HEURISTICS_CONFIG = JSON.stringify({ router: { humanFanout: 0 } });
    resetHeuristicsCache();
    assert.deepEqual(activeHeuristics(log), DEFAULT_NODE_HEURISTICS, "out of range: the defaults apply");
    process.env.ENSEMBLE_NODE_HEURISTICS_CONFIG = "/nonexistent/ensemble-node-heuristics.json";
    resetHeuristicsCache();
    assert.deepEqual(activeHeuristics(log), DEFAULT_NODE_HEURISTICS, "a file that cannot be read: the defaults apply");
    assert.equal(warned.length, 2);
  } finally {
    delete process.env.ENSEMBLE_NODE_HEURISTICS_CONFIG;
    resetHeuristicsCache();
  }
  assert.deepEqual(activeHeuristics(), DEFAULT_NODE_HEURISTICS);
});

test("templates name real nodes, and every crew has its lead", () => {
  const ids = new Set(NODE_TEMPLATES.map((row) => row.id));
  assert.equal(ids.size, NODE_TEMPLATES.length);
  assert.equal(new Set(NODE_TEMPLATES.map((row) => row.slug)).size, NODE_TEMPLATES.length);
  for (const crew of CREW_TEMPLATES) {
    assert.ok(crew.nodes.every((id) => ids.has(id)), crew.id);
    assert.ok(crew.nodes.includes(crew.lead), crew.id);
  }
  assert.equal(new Set(NODE_TEMPLATES.map((row) => JSON.stringify(row.avatar))).size, NODE_TEMPLATES.length, "every template looks different");
  for (const row of NODE_TEMPLATES) assert.ok(row.charter.split("\n").length >= 4 && row.charter.split("\n").length <= 6, row.id);
});

test("a retired template resolves to the one that replaced it, and its unedited charter reads as the new one", () => {
  const developer = nodeTemplate("developer")!;
  const retired = nodeTemplate("feature-engineer")!;
  assert.deepEqual([retired.id, retired.slug, retired.name, retired.charter], ["developer", "builder", "Feature engineer", developer.charter]);
  assert.equal(nodeTemplate("docs-writer")?.id, "writer");
  const old = [
    "You implement features and fixes on your owner's computer, through their own coding agent.",
    "- Run the work in an agent session: node_session_start for new work, node_session_send to build on a session that already worked on the same repository. Give the agent a precise brief: the repository or folder, the change, how to check it.",
    "- When a run is going the wrong way or your owner changes their mind, steer it (delivery steer) rather than starting over.",
    "- When the run ends, report the result, the branch or commit, and anything that needs a decision.",
  ].join("\n");
  assert.equal(charterOf({ charter: old, templateId: "feature-engineer" }), developer.charter);
  assert.equal(charterOf({ charter: `${old}\n- Use pnpm.`, templateId: "feature-engineer" }), `${old}\n- Use pnpm.`, "an edited charter stays its owner's");
  assert.doesNotMatch(nodeTemplate("manager")!.charter, /@|feature engineer|docs writer/, "the manager names roles, not nodes");
  assert.notDeepEqual(paletteAvatar(0), paletteAvatar(1));
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
