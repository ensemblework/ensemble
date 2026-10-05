import assert from "node:assert/strict";
import test from "node:test";
import { peopleCards } from "./people-view.js";

const rao = {
  id: "rao",
  name: "Sunita Rao",
  email: null,
  role: "Client",
  team: null,
  lastInteraction: null,
  confidence: 1,
  projects: [{ id: "matter", name: "Rao v. Sunrise Hospital" }],
};

test("people cards count open tasks and the latest activity", () => {
  const cards = peopleCards({
    people: [rao],
    tasks: [
      { title: "Read the draft", status: "todo", people: ["Sunita Rao"], updatedAt: "2026-10-01T08:00:00.000Z" },
      { title: "Send the question", status: "done", people: ["rao"], updatedAt: "2026-10-02T08:00:00.000Z" },
    ],
    notes: [{ title: "Conference with Sunita Rao", personIds: ["rao"], askedAt: "2026-10-03T08:00:00.000Z" }],
    sessions: [],
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.openTasks, 1);
  assert.equal(cards[0]?.recentTitle, "Conference with Sunita Rao");
  assert.equal(cards[0]?.role, "Client");
});

test("a role-less Client placeholder is dropped and unknown assignees are derived", () => {
  const cards = peopleCards({
    people: [{ ...rao, id: "blank", name: "Client", role: null, projects: [{ id: "m", name: "Matter" }] }],
    tasks: [{ title: "List the dates", status: "todo", people: ["Suresh Yadav"], updatedAt: "2026-10-01T08:00:00.000Z" }],
    notes: [],
    sessions: [],
  });
  assert.equal(cards.some((card) => card.name === "Client"), false);
  assert.equal(cards[0]?.name, "Suresh Yadav");
  assert.equal(cards[0]?.role, "Assignee");
  assert.equal(cards[0]?.openTasks, 1);
  assert.equal(cards[0]?.derived, true);
});
