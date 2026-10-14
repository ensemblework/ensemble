import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { ReviewEditor, type ChunkCounts, type ReviewEditorHandle } from "./review-editor.js";

(globalThis as { React?: typeof React }).React = React;

// A changed line next to another change, or separated from it only by an empty line, is one change.
const START = ["export function add(a, b) {", "  return a + b;", "}", "", "export const name = 'old';", "export const kept = true;", "// end", ""].join("\n");
const AGENT = ["export function add(a: number, b: number) {", "  return a + b;", "}", "", "export const name = 'new';", "export const kept = true;", "// end", ""].join("\n");

async function mount(props: { value: string; original?: string }) {
  const host = document.createElement("div");
  host.style.height = "400px";
  document.body.appendChild(host);
  const root = createRoot(host);
  const ref = createRef<ReviewEditorHandle>();
  const seen = { text: props.value, original: props.original ?? START, counts: { agent: -1, yours: -1 } as ChunkCounts, edges: [] as number[] };
  await act(async () => {
    root.render(
      <ReviewEditor
        ref={ref}
        path="src/math.ts"
        original={props.original ?? START}
        value={props.value}
        start={START}
        agent={AGENT}
        kind="review"
        mode="changes"
        readOnly={false}
        fontSize={13}
        onChange={(text) => (seen.text = text)}
        onAccept={(original) => (seen.original = original)}
        onCursor={() => {}}
        onSave={() => {}}
        onEdge={(direction) => seen.edges.push(direction)}
        onCounts={(counts) => (seen.counts = counts)}
      />,
    );
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return {
    host,
    ref,
    seen,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("the agent's changes have Accept and Reject; an edit of yours is blue with Revert", async () => {
  const yours = AGENT.replace("// end", "// end, checked by me");
  const view = await mount({ value: yours });
  try {
    assert.deepEqual(view.seen.counts, { agent: 2, yours: 1 });
    const bars = [...view.host.querySelectorAll(".cm-chunkBar")];
    assert.equal(bars.length, 3);
    assert.equal(bars.filter((bar) => bar.classList.contains("cm-chunkBar-agent")).length, 2);
    const mine = bars.find((bar) => bar.classList.contains("cm-chunkBar-yours"));
    assert.ok(mine?.textContent?.includes("Your edit"));
    assert.ok(mine?.querySelector(".cm-chunkBar-reject"), "Revert");
    assert.equal(mine?.querySelector(".cm-chunkBar-accept"), null, "your edit is never accepted: it is already yours");
    assert.ok(view.host.querySelector(".cm-yoursLine"), "your lines are marked");
  } finally {
    await view.done();
  }
});

test("accepting keeps the file as it is and moves the change into what it is compared against; rejecting puts the old lines back", async () => {
  const view = await mount({ value: AGENT });
  try {
    const accept = view.host.querySelector(".cm-chunkBar-agent .cm-chunkBar-accept") as HTMLElement;
    await act(async () => {
      accept.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    assert.equal(view.seen.text, AGENT, "nothing on disk changes");
    assert.match(view.seen.original, /a: number, b: number/, "the accepted change is now part of the baseline");
    assert.deepEqual(view.seen.counts, { agent: 1, yours: 0 });
    const reject = view.host.querySelector(".cm-chunkBar-agent .cm-chunkBar-reject") as HTMLElement;
    await act(async () => {
      reject.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    assert.match(view.seen.text, /name = 'old'/, "the old line is back in the file");
    assert.deepEqual(view.seen.counts, { agent: 0, yours: 0 });
  } finally {
    await view.done();
  }
});
