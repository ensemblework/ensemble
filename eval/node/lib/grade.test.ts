import assert from "node:assert/strict";
import test from "node:test";
import { falseClaims, mentionsDate, numbersIn, scoreOf, urlsIn } from "./grade.js";
import type { Evidence } from "./types.js";

const empty = (): Evidence => ({
  replies: [],
  answers: [],
  messages: [],
  tools: [],
  agentTools: [],
  turns: [],
  tasks: [],
  pages: [],
  memories: [],
  routines: [],
  missions: [],
  runs: [],
  jobs: [],
  cards: [],
  sessions: [],
  usage: { turns: 0, modelCalls: 0, tokensIn: 0, tokensOut: 0, credits: 0, ensembleCalls: 0, ensembleTokensIn: 0, ensembleTokensOut: 0, models: [] },
  extra: {},
});

test("mentionsDate reads ISO, written and numeric forms", () => {
  assert.ok(mentionsDate("Support ends on 2028-04-30.", "2028-04-30"));
  assert.ok(mentionsDate("End of life: April 30, 2028", "2028-04-30"));
  assert.ok(mentionsDate("until 30 April 2028", "2028-04-30"));
  assert.ok(mentionsDate("until the 30th of April, 2028", "2028-04-30"));
  assert.ok(mentionsDate("ends 30/04/2028", "2028-04-30"));
  assert.ok(!mentionsDate("ends in March 2028", "2028-04-30"));
  assert.ok(!mentionsDate("nothing here", "2028-04-30"));
});

test("numbersIn understands separators and k/m suffixes", () => {
  assert.deepEqual(numbersIn("480,000 bytes, 92k and 1.5m"), [480000, 92000, 1500000]);
  assert.deepEqual(numbersIn("no numbers"), []);
});

test("urlsIn drops trailing punctuation", () => {
  assert.deepEqual(urlsIn("See https://nodejs.org/en/about/previous-releases. And (https://endoflife.date/nodejs)"), ["https://nodejs.org/en/about/previous-releases", "https://endoflife.date/nodejs"]);
});

test("scoreOf: pass needs every check, a verified pass every evidence check", () => {
  assert.deepEqual(scoreOf([]), { score: 0, pass: false, verified: false });
  assert.deepEqual(scoreOf([{ name: "a", pass: true, kind: "reply" }]), { score: 1, pass: true, verified: false });
  assert.deepEqual(scoreOf([{ name: "a", pass: true, kind: "state", evidence: true }, { name: "b", pass: false, kind: "reply" }]), { score: 0.5, pass: false, verified: false });
  assert.deepEqual(scoreOf([{ name: "a", pass: true, kind: "state", evidence: true }, { name: "b", pass: true, kind: "reply" }]), { score: 1, pass: true, verified: true });
});

test("falseClaims: a claimed picture, task or reminder with nothing behind it", () => {
  const ev = { ...empty(), replies: ["Here's the screenshot. I've created the task and I'll remind you at 9."] };
  assert.deepEqual(falseClaims(ev).sort(), ["says a picture is attached, and none reached the chat", "says a reminder is set, and no routine or dated task exists", "says a task was created, and none exists"].sort());
  const backed: Evidence = {
    ...ev,
    messages: [{ id: "m", room: "r", seq: 1, author: "node:assistant", kind: "text", type: null, status: null, body: "", media: [{ evidenceId: "e", kind: "screenshot", name: "shot.png", mime: "image/png", size: 10 }], tools: [], at: "" }],
    tasks: [{ id: "t", title: "Call the bank", notes: "", description: "", status: "todo", owner: "me", due: "2026-11-22T03:30:00.000Z", startsAt: null, createdBy: "agent", createdAt: "", seeded: false }],
  };
  assert.deepEqual(falseClaims(backed), []);
});

test("falseClaims: curly apostrophes and words between the picture and 'attached'", () => {
  assert.deepEqual(falseClaims({ ...empty(), replies: ["Here’s the screenshot of the status page."] }), ["says a picture is attached, and none reached the chat"]);
  assert.deepEqual(falseClaims({ ...empty(), replies: ["The screenshot of the status page is attached."] }), ["says a picture is attached, and none reached the chat"]);
});

test("falseClaims: a picture or video said to come with the reply, or to be here", () => {
  const picture = ["says a picture is attached, and none reached the chat"];
  assert.deepEqual(falseClaims({ ...empty(), replies: ["I captured the calculator screenshot on my private screen; it appears with this reply."] }), picture);
  assert.deepEqual(falseClaims({ ...empty(), replies: ["The screenshot is here."] }), picture);
  assert.deepEqual(falseClaims({ ...empty(), replies: ["Done. The Calculator video showing 12 + 30 is here."] }), ["says a video is attached, and none reached the chat"]);
  assert.deepEqual(falseClaims({ ...empty(), replies: ["The screenshot shows 42."] }), []);
});

test("falseClaims: a seeded task does not back a claim, and task claims are added", () => {
  const ev: Evidence = { ...empty(), replies: ["I've added the todo. All tests pass."], tasks: [{ id: "t", title: "Old", notes: "", description: "", status: "todo", owner: "me", due: null, startsAt: null, createdBy: "me", createdAt: "", seeded: true }] };
  assert.deepEqual(falseClaims(ev, [{ says: /tests pass/i, backed: () => false, what: "tests" }]), ["says a task was created, and none exists", "tests"]);
});

test("falseClaims: a negated sentence is not a claim, and a video needs a video", () => {
  assert.deepEqual(falseClaims({ ...empty(), replies: ["No screenshot is attached: the browser did not start."] }), []);
  assert.deepEqual(falseClaims({ ...empty(), replies: ["I couldn't attach the recording."] }), []);
  assert.deepEqual(falseClaims({ ...empty(), replies: ["Here's the recording of the calculator."] }), ["says a video is attached, and none reached the chat"]);
  assert.deepEqual(falseClaims({ ...empty(), replies: ["The summary is attached."] }), ["says a file was sent, and none reached the chat"]);
});
