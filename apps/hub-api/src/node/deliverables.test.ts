/**
 * The checklist a node's turn gets from its owner's words, and what the answer check finds missing
 * (node/deliverables.ts). No database.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantToolCall } from "@ensemble/shared-types";
import { asksForSomething, checklistFrom, feedbackFor, mergeChecklists, parseModelChecklist, placeIn, problemsWith, type Evidence } from "./deliverables.js";
import type { Media } from "./media.js";

test("the rules find what the owner's requests ask for", () => {
  assert.deepEqual(checklistFrom("compare the PS5 prices for Wisconsin at Amazon, Walmart and Best Buy, with screenshots of each store and a table"), [
    { kind: "screenshots", count: 3, names: ["amazon", "walmart", "bestbuy"], exact: true },
    { kind: "table" },
    { kind: "location", place: "Wisconsin" },
  ]);
  assert.deepEqual(checklistFrom("screenshot of the Google stock chart"), [{ kind: "screenshots", count: 1, exact: false }]);
  assert.deepEqual(checklistFrom("send me a screenshot of example.com"), [{ kind: "screenshots", count: 1, exact: true }]);
  assert.deepEqual(checklistFrom("4 screenshots: Microsoft, Amazon, Nvidia, Apple stock"), [{ kind: "screenshots", count: 4, exact: true, names: ["Microsoft", "Amazon", "Nvidia", "Apple stock"] }]);
  assert.deepEqual(checklistFrom("screenshots of example.com, example.org and example.net"), [{ kind: "screenshots", count: 3, names: ["example.com", "example.org", "example.net"], exact: true }]);
  assert.deepEqual(checklistFrom("fetch the BMD-45 CVPR paper from CVF and add it to my Ensemble files"), [{ kind: "save_file" }]);
  assert.deepEqual(checklistFrom("put the PDF in my files"), [{ kind: "save_file" }]);
  assert.deepEqual(checklistFrom("write a short report, save it as capabilities.md on my computer and send me the file here"), [{ kind: "file_in_chat" }]);
  assert.deepEqual(checklistFrom("what's new with the Fed? include sources"), [{ kind: "links" }]);
  assert.deepEqual(checklistFrom("log in to my Azure console and check yesterday's resource usage"), []);
  assert.deepEqual(checklistFrom("add yourself to the SWE crew"), []);
  assert.deepEqual(checklistFrom("how much is a dining table at IKEA?"), [], "a table to buy is not a table to write");
  assert.deepEqual(checklistFrom("save the log to the files folder on my computer"), []);
  assert.equal(placeIn("cheapest PS5 near 53703"), "53703");
  assert.equal(placeIn("PS5 deals in Madison, WI"), "Madison, WI");
  assert.equal(placeIn("iPhone price in India"), "India");
  assert.equal(placeIn("my sister lives in Wisconsin"), null, "a place matters only for prices and the like");
});

test("the model's checklist is strict JSON over the fixed kinds, and only adds to the rules", () => {
  assert.deepEqual(parseModelChecklist('```json\n{"checks":[{"kind":"screenshots","count":12},{"kind":"table"},{"kind":"weather"},{"kind":"table"}]}\n```'), [{ kind: "screenshots", count: 8 }, { kind: "table" }]);
  assert.equal(parseModelChecklist("I think they want a table."), null);
  assert.equal(parseModelChecklist('{"items": []}'), null);
  assert.deepEqual(mergeChecklists([{ kind: "screenshots", count: 1, exact: false }], [{ kind: "screenshots", count: 3 }, { kind: "links" }]), [{ kind: "screenshots", count: 3, exact: false }, { kind: "links" }]);
  assert.deepEqual(mergeChecklists([{ kind: "screenshots", count: 2, exact: true }], [{ kind: "screenshots", count: 5 }]), [{ kind: "screenshots", count: 2, exact: true }], "an exact count stands");
  assert.ok(asksForSomething("grab pictures of the two tallest buildings"));
  assert.ok(!asksForSomething("thanks!"));
  assert.ok(!asksForSomething("ok"));
});

const call = (name: string, state: AssistantToolCall["state"] = "ok", input: Record<string, unknown> = {}): AssistantToolCall => ({ id: name, name, area: "tasks", input, state, isWrite: false });
const shot: Media = { evidenceId: "e1", kind: "screenshot", name: "a.png", mime: "image/png", caption: null, size: 3 };
const evidence = (value: Partial<Evidence>): Evidence => ({ text: "", calls: [], media: [], savedFiles: 0, brokenLinks: [], round: 0, ...value });

test("the answer check: counts, places, claims, and a shortfall the reply explains", () => {
  const four = [{ kind: "screenshots" as const, count: 4 }];
  assert.deepEqual(problemsWith(four, evidence({ text: "Here they are.", media: [shot, shot, shot] })), ["4 screenshots were asked for and 3 will show with your reply"]);
  assert.deepEqual(problemsWith(four, evidence({ text: "Here they are.", media: [shot, shot, shot, shot] })), []);
  // Held for the owner's preview: they reach the owner on the card.
  const held = { call: call("browser_screenshot"), result: { ok: true, data: { evidence: [{ id: "e9", kind: "screenshot", held: true }] } } };
  assert.deepEqual(problemsWith([{ kind: "screenshots", count: 1 }], evidence({ text: "Taken.", calls: [held] })), []);
  // A failure the reply explains stands; without a failure it is asked once.
  const failed = { call: call("browser_view", "failed"), result: { error: "blocked" } };
  assert.deepEqual(problemsWith(four, evidence({ text: "Apple's page could not load (blocked), so 3 are here.", media: [shot, shot, shot], calls: [failed] })), []);
  assert.equal(problemsWith(four, evidence({ text: "Apple's page could not load, so 3 are here.", media: [shot, shot, shot] })).length, 1);
  assert.deepEqual(problemsWith(four, evidence({ text: "Apple's page could not load, so 3 are here.", media: [shot, shot, shot], round: 1 })), []);
  // A question to the owner is pushed once to act, then stands.
  assert.equal(problemsWith(four, evidence({ text: "Which four companies do you mean?" })).length, 1);
  assert.deepEqual(problemsWith(four, evidence({ text: "Which four companies do you mean?", round: 1 })), []);
  // The place given to a tool.
  const place = [{ kind: "location" as const, place: "Wisconsin" }];
  assert.equal(problemsWith(place, evidence({ text: "Prices.", calls: [{ call: call("browser_shop", "ok", { query: "PS5" }), result: {} }] })).length, 1);
  assert.deepEqual(problemsWith(place, evidence({ text: "Prices.", calls: [{ call: call("browser_shop", "ok", { query: "PS5", location: "Wisconsin" }), result: {} }] })), []);
  assert.deepEqual(problemsWith(place, evidence({ text: "Prices.", calls: [{ call: call("hub_web_search", "ok", { query: "PS5 price wisconsin" }), result: {} }] })), []);
  // Claims need tool results behind them, whatever the checklist.
  assert.match(problemsWith([], evidence({ text: "I've attached the screenshot." }))[0]!, /says something is attached or shown/);
  assert.deepEqual(problemsWith([], evidence({ text: "The PDF you attached says 42." })), [], "the owner's own attachment is not a claim");
  assert.match(problemsWith([], evidence({ text: "Added it to your Ensemble Files." }))[0]!, /no hub_save_file call saved it/);
  assert.deepEqual(problemsWith([], evidence({ text: "Added it to your Ensemble Files.", savedFiles: 1 })), []);
  const links = [{ kind: "links" as const }];
  assert.equal(problemsWith(links, evidence({ text: "The Fed held rates." })).length, 1);
  assert.deepEqual(problemsWith(links, evidence({ text: "The Fed held rates ([Reuters](https://www.reuters.com/x))." })), []);
  assert.deepEqual(problemsWith(links, evidence({ text: "Here: [notes.md](ensemble://file/1)" })), [], "a link to a saved file counts");
  // Work handed on (a plan, a session, background work) delivers later.
  assert.deepEqual(problemsWith(four, evidence({ text: "Started.", calls: [{ call: call("node_work_start"), result: {} }] })), []);
  assert.equal(feedbackFor([]), null);
  assert.equal(feedbackFor(["a", "b"]), "Not done yet: a; b. Do it now with your tools, or say plainly what could not be done and why.");
});
