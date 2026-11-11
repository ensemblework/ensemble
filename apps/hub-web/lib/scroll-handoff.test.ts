import assert from "node:assert/strict";
import test from "node:test";
import "../components/ui-test-dom";
import { attachScrollHandoff, HANDOFF_ATTR, LATCH_MS, resetScrollHandoff } from "./scroll-handoff";

/** A page that scrolls, with a preview inside it. jsdom has no layout, so the sizes are stubbed. */
function setup() {
  resetScrollHandoff();
  document.body.innerHTML = '<main id="page" style="overflow-y:auto"><p id="text">Words</p><div id="preview"></div></main>';
  const page = document.getElementById("page")!;
  Object.defineProperty(page, "scrollHeight", { value: 4000, configurable: true });
  Object.defineProperty(page, "clientHeight", { value: 800, configurable: true });
  const preview = document.getElementById("preview")!;
  let clock = 1000;
  const detach = attachScrollHandoff(preview, preview, () => clock);
  const wheel = (target: Element, deltaY: number, extra: WheelEventInit = {}) => {
    const event = new window.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(event);
    return event;
  };
  return { page, preview, text: document.getElementById("text")!, wheel, tick: (ms: number) => (clock += ms), detach };
}

test("a wheel that starts over the preview is left to the preview", () => {
  const { page, preview, wheel } = setup();
  const event = wheel(preview, 100);
  assert.equal(event.defaultPrevented, false);
  assert.equal(page.scrollTop, 0);
  assert.ok(preview.hasAttribute(HANDOFF_ATTR));
});

test("a page scroll that runs over the preview keeps scrolling the page", () => {
  const { page, preview, text, wheel, tick } = setup();
  wheel(text, 60);
  tick(40);
  const over = wheel(preview, 60);
  assert.equal(over.defaultPrevented, true, "the preview does not scroll");
  assert.equal(page.scrollTop, 60, "the page took the wheel instead");
  // Still going: each forwarded wheel keeps the page in charge.
  tick(LATCH_MS - 10);
  assert.equal(wheel(preview, 60).defaultPrevented, true);
  assert.equal(page.scrollTop, 120);
});

test("once the wheel rests, the preview under the pointer takes it", () => {
  const { page, preview, text, wheel, tick } = setup();
  wheel(text, 60);
  tick(LATCH_MS + 1);
  assert.equal(wheel(preview, 60).defaultPrevented, false);
  assert.equal(page.scrollTop, 0);
});

test("pinch-zoom and sideways scrolling stay with the preview, and lines count as 16 px", () => {
  const { page, preview, text, wheel, tick } = setup();
  wheel(text, 60);
  tick(10);
  assert.equal(wheel(preview, 60, { ctrlKey: true }).defaultPrevented, false);
  assert.equal(wheel(preview, 5, { deltaX: 80 }).defaultPrevented, false);
  wheel(preview, 3, { deltaMode: 1 });
  assert.equal(page.scrollTop, 48);
});

test("detaching stops the handoff", () => {
  const { preview, text, wheel, tick, detach } = setup();
  detach();
  wheel(text, 60);
  tick(10);
  assert.equal(wheel(preview, 60).defaultPrevented, false);
});
