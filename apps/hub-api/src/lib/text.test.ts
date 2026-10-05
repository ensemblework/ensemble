import assert from "node:assert/strict";
import test from "node:test";
import { chunkText, hasLoneSurrogate, persistAssistantText, safePublicError, truncateText } from "./text.js";

const emoji = "😀";

test("a title cut keeps the letters and drops a trailing emoji instead of a lone surrogate", () => {
  const title = `${"a".repeat(79)}${emoji}`;
  assert.equal(title.length, 81);
  const cut = truncateText(title, 80);
  assert.equal(cut, "a".repeat(79));
  assert.equal(hasLoneSurrogate(cut), false);
  assert.equal(hasLoneSurrogate(title.slice(0, 80)), true);
});

test("a model reply cut on an emoji boundary stays valid", () => {
  const reply = `${"a".repeat(3999)}${emoji}`;
  const cut = truncateText(reply, 4000);
  assert.equal(cut, "a".repeat(3999));
  assert.equal(hasLoneSurrogate(cut), false);
  const fitting = truncateText(`${"a".repeat(78)}${emoji}`, 80);
  assert.equal(fitting, `${"a".repeat(78)}${emoji}`);
});

test("chunks do not stop inside an emoji", () => {
  assert.deepEqual(chunkText("a".repeat(50)), ["a".repeat(24), "a".repeat(24), "aa"]);
  const chunks = chunkText(`${"a".repeat(23)}${emoji}b`, 24);
  assert.equal(chunks.some((chunk) => hasLoneSurrogate(chunk)), false);
  assert.equal(chunks.join(""), `${"a".repeat(23)}${emoji}b`);
});

test("a database error is not shown as the assistant reply", async () => {
  const leaked = "Invalid `prisma.assistantMessage.create()` invocation at /workspace/apps/hub-api/src/routes/assistant.ts:282";
  const answer = `Here is the answer ${emoji}`;
  let saved = "";
  const result = await persistAssistantText(
    async (content) => {
      if (content === answer) throw new Error(leaked);
      saved = content;
    },
    answer,
    () => undefined,
  );
  assert.equal(result.shown, answer);
  assert.equal(saved, "The reply could not be saved.");
  assert.equal(result.shown.includes("/workspace"), false);
  assert.equal(safePublicError(new Error(leaked)).includes("prisma"), false);
});
