import assert from "node:assert/strict";
import test from "node:test";
import { enrichOne, settleSummary, type SummaryOutcome, type SummaryRow, type SummaryStore } from "./summarize.js";

function memoryStore(row: SummaryRow & { status: string }): SummaryStore & { status: string; outcome: SummaryOutcome | null; claims: number } {
  const box = { status: row.status, outcome: null as SummaryOutcome | null, claims: 0, text: row.text, filename: row.filename, id: row.id };
  return {
    get status() {
      return box.status;
    },
    get outcome() {
      return box.outcome;
    },
    get claims() {
      return box.claims;
    },
    async claim(id: string) {
      if (id !== box.id || box.status !== "queued") return null;
      box.status = "running";
      box.claims += 1;
      return { id: box.id, filename: box.filename, text: box.text };
    },
    async finish(_id, outcome) {
      box.status = outcome.status;
      box.outcome = outcome;
    },
  };
}

test("a queued summary is marked done", async () => {
  const store = memoryStore({ id: "doc", filename: "notes.txt", text: "The launch is Friday.", status: "queued" });
  const outcome = await enrichOne(store, "doc", async () => "Launch is Friday.");
  assert.deepEqual(outcome, { status: "done", summary: "Launch is Friday." });
  assert.equal(store.status, "done");
});

test("a model error is stored as failed instead of staying queued", async () => {
  const store = memoryStore({ id: "doc", filename: "notes.txt", text: "hello", status: "queued" });
  const outcome = await enrichOne(store, "doc", async () => {
    throw new Error("The model runtime is not running.");
  });
  assert.equal(outcome?.status, "failed");
  assert.match(outcome && outcome.status === "failed" ? outcome.message : "", /not running/);
  assert.equal(store.status, "failed");
  assert.equal(await enrichOne(store, "doc", async () => "again"), null);
});

test("a file with no extracted text fails instead of staying queued", async () => {
  const store = memoryStore({ id: "doc", filename: "slide.pptx", text: "  ", status: "queued" });
  const outcome = await enrichOne(store, "doc", async () => {
    throw new Error("should not be called");
  });
  assert.deepEqual(outcome, { status: "failed", message: "There is no extracted text to summarize." });
});

test("an empty model reply is a failure", () => {
  const outcome = settleSummary({ id: "doc", filename: "a.txt", text: "body" }, "  ", null);
  assert.equal(outcome.status, "failed");
});
