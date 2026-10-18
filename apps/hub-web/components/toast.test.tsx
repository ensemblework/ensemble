import "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { emitToast, TOAST_MS } from "@/lib/toast-bus";
import { ToastProvider } from "./toast.js";

(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const pointer = (target: Element, type: "pointerover" | "pointerout") =>
  act(() => {
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, relatedTarget: document.body }));
  });

test("toasts close themselves; the bar runs for that long; pointing pauses both; X closes at once", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const toast = () => host.querySelector<HTMLElement>('[role="status"]');
  try {
    await act(async () => root.render(<ToastProvider>{null}</ToastProvider>));
    assert.equal(TOAST_MS, 3000);
    act(() => emitToast("Removed Mira Chen."));
    assert.equal(toast()!.querySelector<HTMLElement>(".m-drain")!.style.animationDuration, "3000ms");
    act(() => toast()!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
    assert.equal(toast(), null, "the close button clears it at once");

    act(() => emitToast("Saved.", { durationMs: 1500 }));
    await wait(1000);
    pointer(toast()!, "pointerover");
    assert.equal(toast()!.querySelector<HTMLElement>(".m-drain")!.style.animationPlayState, "paused");
    await wait(1200);
    assert.ok(toast(), "still there while pointed at");
    pointer(toast()!, "pointerout");
    await wait(250);
    assert.ok(toast(), "the remaining half second is kept, not lost");
    await wait(450);
    assert.equal(toast(), null, "and then it closes");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

test("motion CSS never gives an animation two timing functions (the whole rule would be dropped and the toast bar would not run)", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("./motion/suite.css", import.meta.url), "utf8");
  const timing = /\b(linear|ease(-in|-out|-in-out)?|step-start|step-end)\b|cubic-bezier\(|steps\(|var\(--m-ease-[a-z]+\)/g;
  const offenders = [...css.matchAll(/animation:\s*([^;]+);/g)].map((match) => match[1]!).filter((value) => value.split(",").some((layer) => (layer.match(timing) ?? []).length > 1));
  assert.deepEqual(offenders, []);
  assert.match(css, /\.m-toast \.m-drain \{[^}]*animation: m-drain linear forwards;/);
});
