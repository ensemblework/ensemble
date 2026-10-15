import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { exportSpace } from "./space";

const TASK = {
  id: "t1", title: "Send the draft", description: "", notes: "", owner: "me", status: "todo", priority: "p1", complexity: "easy",
  due: "2026-10-20T12:00:00.000Z", boardOrder: 0, todayFocus: "auto", sourceKind: "manual", sourceRef: "", sourceUrl: null, excerpt: null,
  projectId: null, repoId: null, deliverableId: null, people: [], skillIds: [], snoozedUntil: null, rationale: null, taskType: null,
  createdBy: "me", completedAt: null, createdAt: "2026-10-16T08:35:07.000Z", updatedAt: "2026-10-16T08:35:07.000Z",
};
const SESSION = {
  id: "m1", artifactId: null, title: "Advisor sync", notes: "Talked about chapter two.", recap: "", status: "ended", attachState: "none",
  personIds: [], startedAt: "2026-10-16T09:00:00.000Z", endedAt: "2026-10-16T09:30:00.000Z", href: "/meetings/m1",
};

test("tasks.csv and meeting notes in one download write times the same way, in the person's zone with the offset", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    const body =
      path === "/api/tasks" ? { tasks: [TASK] }
      : path === "/api/tasks/t1/page" ? { content: null, notes: "" }
      : path === "/api/meetings/sessions" ? { sessions: [SESSION], voice: "" }
      : path === "/api/meetings/imported" ? { notes: [{ id: "n1", title: "Committee", sourceLabel: "Zoom", occurredAt: "2026-10-15T18:45:00.000Z", summary: "Fine.", decisions: [], actionItems: [], people: [] }] }
      : null;
    return new Response(JSON.stringify(body ?? { error: "not found" }), { status: body ? 200 : 404, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await exportSpace({ spaceName: "Thesis", sections: ["tasks", "meetings"], timeZone: "Asia/Kolkata" });
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    const csv = strFromU8(files["tasks/tasks.csv"]!);
    assert.match(csv, /2026-10-20T17:30:00\+05:30/, "due");
    assert.match(csv, /2026-10-16T14:05:07\+05:30/, "created");
    assert.doesNotMatch(csv, /Z[,\r]/, "no bare UTC times in the CSV");
    const meeting = strFromU8(files[Object.keys(files).find((name) => name.startsWith("meetings/advisor"))!]!);
    assert.match(meeting, /2026-10-16T14:30:00\+05:30/);
    assert.match(meeting, /2026-10-16T15:00:00\+05:30/);
    const imported = strFromU8(files[Object.keys(files).find((name) => name.startsWith("meetings/imported/"))!]!);
    assert.match(imported, /\*\*When:\*\* 2026-10-16T00:15:00\+05:30/);
    const task = strFromU8(files[Object.keys(files).find((name) => name.startsWith("tasks/todo/"))!]!);
    assert.match(task, /2026-10-20T17:30:00\+05:30/);
    const readme = strFromU8(files["README.md"]!);
    assert.match(readme, /ISO 8601 in Asia\/Kolkata/);
    assert.match(readme, /1 meeting note|2 meeting notes/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
