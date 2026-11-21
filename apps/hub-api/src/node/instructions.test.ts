/**
 * Which instruction sections a node turn gets (node/instructions.ts): every row of the routing table
 * reaches the model under the same condition, as its own section, and the stable tier stays the same
 * byte for byte while only the room, the skills or the memories change.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { renderSection, sectionText, type SectionName } from "@ensemble/prompts";
import { assembleNode, NODE_BUDGETS, packetSections, type NodeFacts } from "./instructions.js";
import { StepReport } from "./report.js";
import { NODE_TEMPLATES } from "./templates.js";

const charterOf = (id: string) => NODE_TEMPLATES.find((row) => row.id === id)!.charter;

function facts(over: Partial<NodeFacts> = {}): NodeFacts {
  return {
    owner: "Mira",
    name: "Assistant",
    slug: "assistant",
    role: "assistant",
    charter: charterOf("assistant"),
    room: { title: "Assistant", kind: "dm" },
    roster: ["- @mira: Mira (your owner)", "- @assistant: you"],
    step: false,
    fromNonOwner: false,
    ownerOnly: true,
    ownLoop: false,
    ownWeb: false,
    runProfile: "GitHub Copilot · gpt-6.1-sol · medium thinking · 1M context (the run profile “Copilot”)",
    computerFiles: false,
    computerWorkAsks: false,
    leadsHere: false,
    lead: "@manager",
    crewOutside: ["@researcher (researcher)"],
    crewTitle: "Software team",
    crewMates: ["@developer (developer)"],
    crewOthers: ["@researcher (researcher)"],
    helpers: ["@assistant-auditor"],
    rooms: ["“Assistant” [r1] (dm)", "“Launch” [r2] (room)"],
    origin: "your owner in “Assistant”",
    skills: "Research and facts:\n- One search per part.",
    memories: ["Mira prefers Copilot."],
    helper: null,
    ...over,
  };
}

const names = (input: NodeFacts) => new Set(assembleNode(input).sections.map((row) => row.name));

type Row = { row: string; when: (f: NodeFacts) => boolean; sections: SectionName[] };
const hands = (f: NodeFacts) => f.ownerOnly && !f.fromNonOwner;
const kind = (f: NodeFacts, ...kinds: string[]) => kinds.includes(f.room.kind);
const factsRow = (f: NodeFacts, own: boolean, withHands: boolean) => hands(f) === withHands && f.ownWeb === own;

/** The rows of the old persona (research/14 §2.2), each with its condition and the section that carries it now. */
const ROWS: Row[] = [
  { row: "148 identity", when: () => true, sections: ["node/00-role"] },
  { row: "149 charter", when: (f) => Boolean(f.charter), sections: ["node/01-charter"] },
  { row: "151 hands", when: hands, sections: ["node/03-hands"] },
  { row: "155 a DM and its members", when: (f) => kind(f, "dm"), sections: ["node/51-room-dm"] },
  { row: "155 a crew and its members", when: (f) => kind(f, "crew"), sections: ["node/51-room-crew"] },
  { row: "155 a helper's room and its members", when: (f) => kind(f, "task"), sections: ["node/51-room-task"] },
  { row: "155 a room with people and its members", when: (f) => kind(f, "room"), sections: ["node/51-room-people"] },
  { row: "157 the helper's room", when: (f) => kind(f, "task"), sections: ["node/27-task-room", "node/52-origin"] },
  { row: "160 crew outside", when: (f) => !f.step && !f.fromNonOwner && kind(f, "crew") && f.leadsHere, sections: ["node/53-crew-outside"] },
  { row: "160 crew mates", when: (f) => !f.step && !f.fromNonOwner && kind(f, "dm", "room"), sections: ["node/53-crew-mates", "node/53-crew-others"] },
  { row: "161 helpers", when: () => true, sections: ["node/54-helpers"] },
  { row: "162 rooms", when: () => true, sections: ["node/55-rooms"] },
  { row: "165 facts", when: (f) => factsRow(f, false, false), sections: ["node/10-facts"] },
  { row: "166 facts with hands", when: (f) => factsRow(f, false, true), sections: ["node/10-facts-hands"] },
  { row: "165 facts, own web search", when: (f) => factsRow(f, true, false), sections: ["node/10-facts-own-web"] },
  { row: "166 facts with hands, own web search", when: (f) => factsRow(f, true, true), sections: ["node/10-facts-hands-own-web"] },
  { row: "168 the owner's work", when: () => true, sections: ["node/11-owner-work"] },
  { row: "169 hands", when: hands, sections: ["node/12-hands-work"] },
  { row: "169 web_task", when: (f) => hands(f) && !f.ownLoop, sections: ["node/13-web-task"] },
  { row: "169 the browser on the owner's plan", when: (f) => hands(f) && f.ownLoop, sections: ["node/13-web-task-own-loop"] },
  { row: "171 live terminal", when: (f) => hands(f) && kind(f, "dm"), sections: ["node/14-live"] },
  { row: "172 CLI sign-in", when: (f) => hands(f) && kind(f, "dm"), sections: ["node/15-cli-sign-in"] },
  { row: "173 papers", when: (f) => !f.fromNonOwner, sections: ["node/16-papers"] },
  { row: "174 coding", when: () => true, sections: ["node/17-coding"] },
  { row: "178 own work and helpers", when: (f) => !f.step && !f.fromNonOwner, sections: ["node/18-own-work"] },
  { row: "180 routines and new nodes", when: (f) => !f.step && !f.fromNonOwner && f.ownerOnly, sections: ["node/19-create"] },
  { row: "182 step", when: (f) => f.step, sections: ["node/20-step", "node/21-step-rules"] },
  { row: "184 the lead plans", when: (f) => !f.step && f.leadsHere, sections: ["node/22-lead"] },
  { row: "186 delegate", when: (f) => !f.step && !f.fromNonOwner && kind(f, "dm", "room"), sections: ["node/23-delegate"] },
  { row: "187 crew add", when: (f) => !f.step && !f.fromNonOwner && (f.leadsHere || kind(f, "dm", "room")), sections: ["node/24-crew-add"] },
  { row: "190 a crew member", when: (f) => !f.step && kind(f, "crew") && !f.leadsHere, sections: ["node/25-crew-member"] },
  { row: "191 answer the node that asked", when: (f) => !f.step && kind(f, "room"), sections: ["node/26-answer-nodes"] },
  { row: "193 only the owner instructs; only tool calls act", when: () => true, sections: ["node/30-messages", "constitution/01-authority", "constitution/03-acting"] },
  { row: "196 someone else started it", when: (f) => f.fromNonOwner, sections: ["node/31-not-owner"] },
  { row: "197 the reply is posted", when: (f) => !f.step, sections: ["node/32-reply"] },
  { row: "198 speak with a result", when: () => true, sections: ["node/33-speak", "constitution/11-communication"] },
  { row: "199 captures", when: (f) => hands(f) && !f.step, sections: ["node/34-captures"] },
  { row: "200 tables", when: () => true, sections: ["constitution/11-communication"] },
  { row: "201 waiting cards", when: (f) => !f.step, sections: ["node/35-cards"] },
  { row: "202 privacy and secrets", when: () => true, sections: ["node/36-privacy"] },
  { row: "204 work board", when: (f) => !f.step, sections: ["node/37-board"] },
  { row: "205 remember", when: () => true, sections: ["node/38-remember"] },
  { row: "206 computer files", when: (f) => f.computerFiles, sections: ["node/39-computer-files"] },
  { row: "207 sessions, someone else's turn", when: (f) => f.fromNonOwner, sections: ["node/44-sessions-not-owner"] },
  { row: "207 sessions", when: (f) => !f.fromNonOwner, sections: ["node/40-sessions"] },
  { row: "207 sessions, outside a step", when: (f) => !f.fromNonOwner && !f.step, sections: ["node/41-sessions-said"] },
  { row: "207 sessions, others read", when: (f) => !f.fromNonOwner && !f.ownerOnly, sections: ["node/42-sessions-others-read"] },
  { row: "207 sessions, ask first", when: (f) => !f.fromNonOwner && f.ownerOnly && f.computerWorkAsks, sections: ["node/43-sessions-ask"] },
  { row: "208 no reply", when: () => true, sections: ["node/45-no-reply"] },
  { row: "209 skills", when: () => true, sections: ["node/56-skills"] },
  { row: "210 memories", when: () => true, sections: ["node/57-memories"] },
];

function* everyTurn(): Generator<NodeFacts> {
  const loops = [
    { ownLoop: false, ownWeb: false },
    { ownLoop: true, ownWeb: false },
    { ownLoop: true, ownWeb: true },
  ];
  for (const roomKind of ["dm", "crew", "task", "room"])
    for (const leadsHere of roomKind === "crew" ? [false, true] : [false])
      for (const step of [false, true])
        for (const fromNonOwner of [false, true])
          for (const ownerOnly of [false, true])
            for (const loop of loops)
              for (const computerFiles of [false, true])
                for (const computerWorkAsks of [false, true])
                  yield facts({ room: { title: "Launch", kind: roomKind }, leadsHere, step, fromNonOwner, ownerOnly, ...loop, computerFiles, computerWorkAsks });
}

test("every row of the routing table reaches the model under its condition, as its own section", () => {
  let turns = 0;
  for (const turn of everyTurn()) {
    turns += 1;
    const got = names(turn);
    for (const row of ROWS) {
      for (const name of row.sections) assert.equal(got.has(name), row.when(turn), `${row.row}: ${name} for ${JSON.stringify({ ...turn, charter: undefined, skills: undefined })}`);
    }
    for (const name of got) if (name.startsWith("node/6")) assert.fail(`${name} is a helper's section`);
  }
  assert.equal(turns, 480);
});

test("a helper's turn: its brief, its parent, its grant, and the agent's own browser on its owner's plan", () => {
  const helper = (over: Partial<NodeFacts>) => facts({ name: "Auditor", slug: "assistant-auditor", role: "auditor", charter: "Check the launch date.", room: { title: "Auditor", kind: "task" }, helper: { parent: "assistant", parentName: "Assistant", grant: "read" }, ...over });
  const reply = assembleNode(helper({}));
  const got = new Set(reply.sections.map((row) => row.name));
  for (const name of ["node/60-helper-role", "node/61-helper-brief", "node/62-helper-messages", "node/63-helper-facts", "node/64-helper-read", "node/65-helper-cards", "node/66-helper-reply", "node/45-no-reply", "node/67-helper-room"] as const) assert.ok(got.has(name), name);
  assert.ok(!["node/00-role", "node/57-memories", "node/56-skills", "node/40-sessions"].some((name) => got.has(name)), "a helper has none of its parent's rows, memories or skills");
  assert.match(reply.tiers.stable, /You are Auditor \(@assistant-auditor\), a temporary helper in Mira's Ensemble Node, made by @assistant \(Assistant\)\. Role: auditor\./);
  assert.match(reply.tiers.context, /Room: “Auditor”, your thread with @assistant\. Mira reads along but does not write here\./);

  const step = new Set(assembleNode(helper({ step: true })).sections.map((row) => row.name));
  assert.ok(step.has("node/62-helper-step") && step.has("node/66-helper-report") && !step.has("node/45-no-reply"));
  const sessions = new Set(assembleNode(helper({ helper: { parent: "assistant", parentName: "Assistant", grant: "sessions" } })).sections.map((row) => row.name));
  assert.ok(sessions.has("node/64-helper-sessions"));
  const computer = assembleNode(helper({ helper: { parent: "assistant", parentName: "Assistant", grant: "computer" } }));
  assert.match(computer.tiers.stable, /several steps on a site: web_task/);
  const ownPlan = assembleNode(helper({ helper: { parent: "assistant", parentName: "Assistant", grant: "computer" }, ownLoop: true, ownWeb: true }));
  assert.doesNotMatch(ownPlan.tiers.stable, /web_task|hub_web_search first/);
  assert.match(ownPlan.tiers.stable, /several steps on a site: drive the browser yourself/);
  assert.match(ownPlan.tiers.stable, /your own web search first \(or hub_web_search\), then read the source page itself/);
});

test("on the owner's AI plan the agent drives the browser itself, and searches the web itself where it can", () => {
  const plan = assembleNode(facts({ ownLoop: true, ownWeb: true })).tiers.stable;
  assert.doesNotMatch(plan, /web_task/);
  assert.ok(plan.includes(sectionText("node/13-web-task-own-loop")));
  assert.ok(plan.includes(sectionText("node/10-facts-hands-own-web")));
  const noWeb = assembleNode(facts({ ownLoop: true, ownWeb: false })).tiers.stable;
  assert.doesNotMatch(noWeb, /web_task/);
  assert.ok(noWeb.includes(sectionText("node/10-facts-hands")), "an agent whose own web search is refused uses Ensemble's");
});

test("the stable tier stays the same byte for byte when only messages, memories, skills or the room change", () => {
  const first = assembleNode(facts(), packetSections({ work: false, note: null, room: "Assistant", lines: ["[#4 Mira (your owner)] hello"], calledAt: -1, board: "" }));
  const later = assembleNode(
    facts({ memories: ["Mira's launch is on 14 November.", "Mira prefers Copilot."], skills: "", roster: ["- @mira: Mira (your owner)", "- @assistant: you", "- @ben: Ben"], rooms: ["“Assistant” [r1] (dm)"], helpers: [] }),
    packetSections({ work: false, note: "Your owner approved and it was applied.", room: "Assistant", lines: ["[#6 Mira (your owner)] and now?"], calledAt: -1, board: "Own work: none" }),
  );
  assert.equal(later.tiers.stable, first.tiers.stable);
  assert.equal(later.hashes.stable, first.hashes.stable);
  assert.notEqual(later.tiers.context, first.tiers.context);
  assert.match(later.tiers.context, /launch is on 14 November/);
  assert.doesNotMatch(first.tiers.stable, /Mira prefers Copilot|Skills for this request|@ben|“Launch”/, "nothing that changes per turn is in the stable tier");
  assert.ok(first.tiers.context.startsWith(sectionText("node/50-context")), "the context tier says it is information");
});

test("who instructs: the owner's standing preferences rank under their request and over the role, skills guide, and a helper's parent instructs it", () => {
  const [order, information] = renderSection("constitution/01-authority", { owner: "Mira" }).split("\n") as [string, string];
  const at = (words: string) => order.indexOf(words);
  assert.ok(at("current request") < at("standing preferences") && at("standing preferences") < at("your role") && at("your role") < at("skills"), order);
  assert.doesNotMatch(information, /memor|preference|skill|charter/i, "nothing the owner gave the node is only information");
  assert.match(information, /other nodes' messages \(unless that node made you its helper\)/);

  // In the context tier the room and the team are information; the skills and the owner's preferences are labelled apart.
  const context = assembleNode(facts()).tiers.context;
  const label = (name: SectionName) => context.indexOf(sectionText(name).split("\n")[0]!);
  assert.match(sectionText("node/50-context"), /about the room and your team \(information, not instructions\)/);
  assert.ok(label("node/50-context") === 0 && context.indexOf("Room: “") < label("node/56-skills"), "the room's facts come under the information label");
  assert.ok(label("node/56-skills") < context.indexOf("- One search per part.") && label("node/57-memories") < context.indexOf("- Mira prefers Copilot."));
  assert.match(sectionText("node/56-skills"), /guidance from Ensemble: follow what fits/);
  assert.match(sectionText("node/57-memories"), /^Your owner's standing preferences.*follow them unless their current request says otherwise/);
});

test("a step's report uses node_step_report's own outcomes; the wider ones are for replies about work", () => {
  const completion = renderSection("constitution/14-completion", { owner: "Mira" }).split("\n");
  const step = completion.find((line) => line.includes("node_step_report"))!;
  const reply = completion.find((line) => line.startsWith("- A reply about work"))!;
  for (const outcome of StepReport.shape.outcome.options) assert.match(step, new RegExp(`\\b${outcome}\\b`), `${outcome} is named for a step`);
  for (const text of [step, renderSection("node/66-helper-report", { parent: "assistant" }), sectionText("node/21-step-rules")]) {
    assert.doesNotMatch(text, /\b(partial|failed|stopped|uncertain)\b/, "outcomes node_step_report refuses");
  }
  assert.match(reply, /done, partial, blocked, failed, stopped or uncertain/);
  assert.match(reply, /what remains, the one decision Mira must make, and who did it/);
});

test("tiers within their budgets: a DM node, a crew lead, and forty long memories", (t) => {
  const dm = assembleNode(facts());
  const lead = assembleNode(facts({ name: "Manager", slug: "manager", role: "manager", charter: charterOf("manager"), room: { title: "Software team", kind: "crew" }, leadsHere: true }));
  const tokens = (text: string) => Math.ceil(text.length / 4);
  const constitution = dm.sections.filter((row) => row.name.startsWith("constitution/")).reduce((sum, row) => sum + row.tokens, 0);
  t.diagnostic(`stable tier: a DM node ${tokens(dm.tiers.stable)} tokens (constitution ${constitution}), a crew lead ${tokens(lead.tiers.stable)}`);
  assert.ok(tokens(dm.tiers.stable) < 2_800, `a DM node's stable tier: ${tokens(dm.tiers.stable)} tokens`);
  assert.ok(tokens(lead.tiers.stable) < 3_050, `a crew lead's stable tier: ${tokens(lead.tiers.stable)} tokens`);
  assert.match(lead.tiers.stable, /node_plan, with this crew's members only/);
  assert.match(lead.tiers.stable, /Match each piece to the member whose role fits: code to a developer/, "the manager template's charter");
  assert.doesNotMatch(lead.tiers.stable, /CLI sign-in/);

  const memories = Array.from({ length: 40 }, (_, index) => `Memory ${index + 1}: ${"a preference worth keeping, ".repeat(17)}`.slice(0, 500));
  const full = assembleNode(facts({ memories }));
  assert.ok(tokens(full.tiers.context) <= NODE_BUDGETS.context, `context: ${tokens(full.tiers.context)} tokens`);
  assert.match(full.tiers.context, /- Memory 1: /, "the newest are kept");
  assert.doesNotMatch(full.tiers.context, /- Memory 40: /, "the oldest go first");
  const dropped = full.dropped.find((row) => row.name === "node/57-memories");
  assert.ok(dropped?.items && dropped.items > 0, "and the trace says how many");
  assert.equal(full.tiers.context.split("\n").filter((line) => line.startsWith("- Memory ")).length + dropped!.items!, 40, "whole memories, never part of one");
});

test("the turn packet: new messages, a backlog apart from the message to answer, a note and the board; a step's update", () => {
  const lines = ["[#3 Mira (your owner)] old", "[#4 Mira (your owner)] new"];
  const backlog = assembleNode(facts(), packetSections({ work: false, note: "A run ended.", room: "Launch", lines, calledAt: 1, board: "Own work: none" })).tiers.volatile;
  assert.equal(
    backlog,
    [
      "Room “Launch”. Earlier messages you had not read (context only: they may be answered or done already):",
      lines[0],
      "",
      "The message you were called for (answer this; later messages follow it):",
      lines[1],
      "",
      "Update for you: A run ended.",
      "",
      "Your work board (live, for answering questions about work in progress):",
      "Own work: none",
    ].join("\n"),
  );
  assert.equal(assembleNode(facts(), packetSections({ work: false, note: null, room: "Launch", lines, calledAt: -1, board: "" })).tiers.volatile, `Room “Launch”. New messages since your last turn:\n${lines.join("\n")}`);
  assert.equal(assembleNode(facts({ step: true }), packetSections({ work: true, note: "Your step in @manager's plan.", room: "Launch", lines: [], calledAt: -1, board: "" })).tiers.volatile, "Your step in @manager's plan.");
  assert.equal(assembleNode(facts({ step: true }), packetSections({ work: true, note: null, room: "Launch", lines: [], calledAt: -1, board: "" })).tiers.volatile, renderSection("node/83-packet-continue"));
});
