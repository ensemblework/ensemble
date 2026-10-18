import "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LinkifiedText } from "./linkified-text.js";
import { HumanDescription } from "./pages/human-description.js";

// next/link schedules its prefetch with self.requestIdleCallback; mention chips are links.
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

async function render(node: React.ReactNode): Promise<{ root: Root; host: HTMLDivElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { root, host };
}

async function unmount(mounted: { root: Root; host: HTMLDivElement }) {
  await act(async () => mounted.root.unmount());
  mounted.host.remove();
}

test("log text keeps its exact characters, with addresses as new-tab links and emails as mailto", async () => {
  const log = "$ curl https://api.example.com/v1?x=1\n200 OK (see https://example.com/docs).\nmail ops@fieldnote.example\njavascript:alert(1)";
  const mounted = await render(<pre><LinkifiedText text={log} /></pre>);
  const pre = mounted.host.querySelector("pre")!;
  assert.equal(pre.textContent, log, "nothing is added or lost");
  const anchors = [...pre.querySelectorAll("a")];
  assert.deepEqual(anchors.map((anchor) => [anchor.textContent, anchor.getAttribute("href"), anchor.getAttribute("target")]), [
    ["https://api.example.com/v1?x=1", "https://api.example.com/v1?x=1", "_blank"],
    ["https://example.com/docs", "https://example.com/docs", "_blank"],
    ["ops@fieldnote.example", "mailto:ops@fieldnote.example", null],
  ]);
  assert.equal(anchors[0]!.getAttribute("rel"), "noopener noreferrer");
  await unmount(mounted);
});

test("a link inside something clickable opens only the link", async () => {
  let rowClicks = 0;
  const mounted = await render(
    <div onClick={() => (rowClicks += 1)}>
      <LinkifiedText text="Open https://example.com now" />
    </div>,
  );
  const anchor = mounted.host.querySelector("a")!;
  const opened: string[] = [];
  anchor.addEventListener("click", (event) => {
    opened.push(anchor.href);
    event.preventDefault();
  });
  await act(async () => anchor.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })));
  assert.deepEqual(opened, ["https://example.com/"]);
  assert.equal(rowClicks, 0);
  await unmount(mounted);
});

test("mentions become chips only for their exact saved label", async () => {
  const mounted = await render(
    <LinkifiedText text="Ask @people:Mira Chen and @people:Ben Ito about @date:2026-10-20" mentions={[{ kind: "people", id: "p-mira", label: "Mira Chen" }, { kind: "date", id: "2026-10-20", label: "Oct 20, 2026" }]} />,
  );
  const chips = [...mounted.host.querySelectorAll<HTMLElement>(".mention")];
  assert.deepEqual(chips.map((chip) => [chip.tagName, chip.dataset.kind, chip.textContent]), [
    ["A", "people", "@Mira Chen"],
    ["SPAN", "date", "@Oct 20, 2026"],
  ]);
  assert.match(mounted.host.textContent ?? "", /@people:Ben Ito/);
  await unmount(mounted);
});

test("a link in a task's short description opens without starting an edit", async () => {
  const edits: boolean[] = [];
  const mounted = await render(<HumanDescription value={"Spec: https://example.com/spec"} editing={false} onEditing={(value) => edits.push(value)} onSave={() => undefined} />);
  const anchor = mounted.host.querySelector("a")!;
  anchor.addEventListener("click", (event) => event.preventDefault());
  await act(async () => anchor.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })));
  await act(async () => anchor.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  assert.deepEqual(edits, []);
  const field = mounted.host.querySelector<HTMLElement>("[aria-label='Edit short description']")!;
  await act(async () => field.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })));
  assert.deepEqual(edits, [true], "a click on the text itself still edits");
  await unmount(mounted);
});
