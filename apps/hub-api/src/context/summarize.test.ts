import assert from "node:assert/strict";
import test from "node:test";
import { capSummary, couldNotOpen, enrichOne, planTakesFile, settleSummary, SUMMARY_WORDS, type SummaryOutcome, type SummaryRow, type SummaryStore } from "./summarize.js";

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

test("the summarizer's reason is kept when a file cannot be summarized", async () => {
  const store = memoryStore({ id: "doc", filename: "voice.m4a", text: "", status: "queued" });
  const outcome = await enrichOne(store, "doc", async () => {
    throw new Error("Ensemble does not summarize audio.");
  });
  assert.deepEqual(outcome, { status: "failed", message: "Ensemble does not summarize audio." });
});

test("a picture with no text is summarized from the file itself", async () => {
  const store = memoryStore({ id: "doc", filename: "screenshot.png", text: "", status: "queued" });
  let given: SummaryRow | null = null;
  const outcome = await enrichOne(store, "doc", async (row) => {
    given = row;
    return "A screenshot of the Settings page.";
  });
  assert.deepEqual(outcome, { status: "done", summary: "A screenshot of the Settings page." });
  assert.equal((given as SummaryRow | null)?.filename, "screenshot.png");
});

test("a summary is at most 250 words, ended at a whole sentence when one fits", () => {
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
  const short = "A quarterly report on Fieldnote's revenue, with charts for Q1 to Q3.";
  assert.equal(capSummary(short), short);
  // 30 sentences of 10 words: cut back to the 25th sentence's end.
  const long = Array.from({ length: 30 }, (_, index) => `Sentence ${index + 1} names Mira Chen, Fieldnote and the Q3 "plan."`).join(" ");
  const capped = settleSummary(long, null);
  assert.equal(capped.status, "done");
  const kept = (capped as { summary: string }).summary;
  assert.equal(SUMMARY_WORDS, 250);
  assert.ok(words(kept) <= SUMMARY_WORDS, `${words(kept)} words`);
  assert.match(kept, /Sentence 25 names Mira Chen, Fieldnote and the Q3 "plan\."$/, "the closing quote stays with its sentence");
  // No sentence ends in the kept part: whole words, marked as cut.
  const run = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
  const cut = capSummary(run);
  assert.equal(words(cut), SUMMARY_WORDS);
  assert.match(cut, /word249…$/);
});

test("an empty model reply is a failure", () => {
  assert.equal(settleSummary("  ", null).status, "failed");
});

test("a reply that only says the file could not be opened is not a summary", () => {
  assert.equal(couldNotOpen("I can't open the attached file, it was not included in the message."), true);
  assert.equal(couldNotOpen("I'm unable to read this PDF."), true);
  assert.equal(couldNotOpen("A quarterly report on Fieldnote's revenue, with charts for Q1 to Q3 and a forecast."), false);
});

test("an own-plan agent gets the file only in a form its message carries", () => {
  const pdf = { filename: "scan.pdf", format: "pdf", byteSize: 2_000_000 };
  const png = { filename: "shot.png", format: "png", byteSize: 200_000 };
  const docx = { filename: "brief.docx", format: "docx", byteSize: 50_000 };
  const md = { filename: "notes.md", format: "md", byteSize: 2_000 };
  assert.equal(planTakesFile("claude-code", pdf), true);
  assert.equal(planTakesFile("claude-code", { ...png, byteSize: 5_000_000 }), false);
  assert.equal(planTakesFile("codex", pdf), false);
  assert.equal(planTakesFile("codex", png), true);
  assert.equal(planTakesFile("copilot-cli", docx), false);
  assert.equal(planTakesFile("antigravity", pdf), true);
  for (const agent of ["claude-code", "codex", "copilot-cli", "cursor-agent"] as const) assert.equal(planTakesFile(agent, md), true);
});
