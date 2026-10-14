import "../ui-test-dom.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { MORPH_DELAY_MS, MORPH_LOOP_MS, MORPH_ONCE_MS, MORPH_SETTLE_MS } from "./brand-morph";
import type { MorphController } from "@ensemble/brand/motion";
const require = createRequire(import.meta.url);
const morph = require("@ensemble/brand/motion") as typeof import("@ensemble/brand/motion");
let now = 0;
let next = 0;
const frames = new Map<number, FrameRequestCallback>();
function setup(reduce = false) {
  now = 0; frames.clear();
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now } });
  globalThis.requestAnimationFrame = cb => { frames.set(++next, cb); return next; };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  const media = () => ({ matches: reduce, addEventListener() {}, removeEventListener() {} });
  globalThis.matchMedia = media as unknown as typeof matchMedia;
  window.matchMedia = globalThis.matchMedia;
  document.documentElement.dataset.reduceMotion = String(reduce);
  const el = document.createElement("span"); document.body.append(el);
  const ctl = morph.mount(el, { size: 40 });
  return { el, ctl, cleanup() { ctl.destroy(); el.remove(); } };
}
function advance(time: number) { now = time; const batch = [...frames.values()]; frames.clear(); for (const f of batch) f(now); }

test("timings come from the shared Woven Chorus controller", () => {
  assert.equal(MORPH_ONCE_MS, morph.BASE.once * 1000);
  assert.equal(MORPH_LOOP_MS, morph.BASE.loop * 1000);
  assert.equal(MORPH_SETTLE_MS, morph.BASE.settle * 1000);
  assert.equal(MORPH_DELAY_MS, 180);
  assert.deepEqual(Object.keys(morph.kinds), ["unfurl", "infinity", "relay", "threadline", "beacon"]);
});

test("reduced motion keeps the exact still logo without scheduling frames", async () => {
  const h = setup(true);
  try {
    const rest = h.el.querySelector('.wm-rest')!.innerHTML;
    await h.ctl.once(); h.ctl.loop();
    assert.equal(frames.size, 0);
    assert.equal(h.el.dataset.pose, 'logo');
    assert.equal(h.el.querySelector('.wm-rest')!.innerHTML, rest);
    await h.ctl.settle();
    assert.equal(h.ctl.state, 'idle');
  } finally { h.cleanup(); }
});

test("an interrupted loop settles promptly and stops its scheduler", async () => {
  const h = setup();
  try {
    h.ctl.loop({ kind: 'relay' }); advance(1200);
    assert.equal(h.el.dataset.pose, 'relay');
    const settled = h.ctl.settle(); advance(1200 + MORPH_SETTLE_MS); await settled;
    assert.equal(h.ctl.state, 'idle');
    assert.equal(h.el.dataset.pose, 'logo');
    assert.equal(frames.size, 0);
  } finally { h.cleanup(); }
});

test("fast completion cancels a pending loader, including after destruction", async () => {
  const h = setup();
  h.ctl.loop({ delay: 20 });
  assert.equal(h.ctl.state, 'pending');
  await h.ctl.settle(); h.cleanup();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(frames.size, 0);
  assert.equal(h.el.innerHTML, '');
});

test("all five roles differ and inline SVG gradient IDs never collide", () => {
  const h = setup();
  const other = document.createElement('span'); document.body.append(other);
  const second = morph.mount(other, { size: 40 });
  try {
    const ids = [...document.querySelectorAll('svg [id]')].map(el => el.id);
    assert.equal(new Set(ids).size, ids.length);
    const shapes = new Set<string>();
    for (const kind of ['infinity', 'relay', 'threadline', 'beacon'] as const) {
      h.ctl.loop({ kind }); advance(now + 1200); shapes.add(h.el.querySelector('.wm-a')!.getAttribute('d')!);
    }
    assert.equal(shapes.size, 4);
  } finally { h.cleanup(); second.destroy(); other.remove(); }
});

test("turning reduced motion on during activity freezes immediately", async () => {
  const h = setup();
  try {
    h.ctl.loop(); advance(1000);
    document.documentElement.dataset.reduceMotion = 'true';
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.el.dataset.pose, 'logo'); assert.equal(frames.size, 0);
    document.documentElement.dataset.reduceMotion = 'false';
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(frames.size, 1);
  } finally { h.cleanup(); }
});
