import assert from "node:assert/strict";
import test from "node:test";
import { answerFor, formatPending, type PendingDecision } from "./approvals.js";

const question: PendingDecision = {
  id: "d1",
  event: "question",
  toolName: "Question",
  title: "Which database?",
  detail: { options: ["Postgres", "SQLite"], recommended: "Postgres", allowCustom: false, taskTitle: "Add storage" },
};
const push: PendingDecision = { id: "d2", event: "permission", toolName: "git push", title: "Push ensemble/abc/fix", detail: { command: "git push" } };

test("a question takes an option number, its text, or deny", () => {
  assert.deepEqual(answerFor(question, "2"), { decision: "allow", scope: "once", reason: "SQLite" });
  assert.deepEqual(answerFor(question, "postgres"), { decision: "allow", scope: "once", reason: "Postgres" });
  assert.deepEqual(answerFor(question, "deny"), { decision: "deny", scope: "once" });
  assert.throws(() => answerFor(question, "MySQL"), /number from 1 to 2/);
  assert.deepEqual(answerFor({ ...question, detail: { ...question.detail, allowCustom: true } }, "MySQL please"), { decision: "allow", scope: "once", reason: "MySQL please" });
});

test("a permission, including a push, is allowed or denied here", () => {
  assert.deepEqual(answerFor(push, "allow"), { decision: "allow", scope: "once" });
  assert.deepEqual(answerFor(push, "n"), { decision: "deny", scope: "once" });
  assert.throws(() => answerFor(push, "maybe"), /allow or deny/);
});

test("the list numbers questions and marks the recommended option", () => {
  const text = formatPending([question, push]);
  assert.match(text, /^1\. Question: Which database\?  \(Add storage\)/);
  assert.match(text, /1\) Postgres  \(recommended\)/);
  assert.match(text, /2\. Wants to git push: Push ensemble\/abc\/fix/);
  assert.match(text, /ensemble needs answer 2 allow \| deny/);
  assert.equal(formatPending([]), "Nothing is waiting for you on this computer.");
});
