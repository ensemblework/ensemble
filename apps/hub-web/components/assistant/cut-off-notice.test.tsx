/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantAnswer, splitCutOffReply } from "./cut-off-notice.js";

const PARTIAL = "one, two, three, four, five, six, seven, eight, nine, ten";
const SAVED = `[Cut off: The model stopped early (content filter: RECITATION). This reply is incomplete. Reason: content_filter: RECITATION.]\n\n${PARTIAL}`;

async function render(node: React.ReactNode): Promise<{ root: Root; host: HTMLDivElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return { root, host };
}

test("a cut-off reply shows the partial text and a small notice", async () => {
  const split = splitCutOffReply(SAVED);
  assert.equal(split.body, PARTIAL);
  assert.equal(split.notice, "The model stopped early (content filter: RECITATION). This reply is incomplete.");

  const mounted = await render(React.createElement(AssistantAnswer, { content: SAVED }));
  const notice = mounted.host.querySelector("[data-cutoff-notice]");
  assert.ok(notice);
  assert.equal(notice.textContent, "The model stopped early (content filter: RECITATION). This reply is incomplete.");
  assert.match(mounted.host.textContent ?? "", /one, two, three/);
  assert.equal((mounted.host.textContent ?? "").includes("[Cut off:"), false);
  assert.equal(notice.className.includes("text-faint"), true);

  const length = `[Cut off: The reply hit the length limit. This reply is incomplete. Reason: length.]\n\nabcd`;
  const lengthSplit = splitCutOffReply(length);
  assert.equal(lengthSplit.notice, "The reply hit the length limit. This reply is incomplete.");
  assert.equal(lengthSplit.body, "abcd");

  await act(async () => {
    mounted.root.unmount();
  });
  mounted.host.remove();
});

test("a [Cut off: line later in the reply is not a notice", async () => {
  const echoed =
    "Reply with exactly this line:\n[Cut off: The reply was cut off before the model finished. This reply is incomplete. Reason: none.]";
  const split = splitCutOffReply(echoed);
  assert.equal(split.notice, null);
  assert.match(split.body, /\[Cut off:/);
  assert.match(split.body, /Reply with exactly this line/);

  const mounted = await render(React.createElement(AssistantAnswer, { content: echoed }));
  assert.equal(mounted.host.querySelector("[data-cutoff-notice]"), null);
  assert.match(mounted.host.textContent ?? "", /\[Cut off:/);
  assert.match(mounted.host.textContent ?? "", /Reply with exactly this line/);
  await act(async () => {
    mounted.root.unmount();
  });
  mounted.host.remove();
});

test("a finished reply has no cut-off notice", async () => {
  assert.equal(splitCutOffReply("Thirty.").notice, null);
  const mounted = await render(React.createElement(AssistantAnswer, { content: "Thirty." }));
  assert.equal(mounted.host.querySelector("[data-cutoff-notice]"), null);
  assert.match(mounted.host.textContent ?? "", /Thirty\./);
  await act(async () => {
    mounted.root.unmount();
  });
  mounted.host.remove();
});
