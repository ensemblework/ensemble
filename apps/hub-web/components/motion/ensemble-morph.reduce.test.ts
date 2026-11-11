import "../ui-test-dom.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { MORPH_DELAY_MS, MORPH_LOOP_MS, MORPH_ONCE_MS, MORPH_SETTLE_MS } from "./brand-morph";
import type { MorphController, MorphKind } from "@ensemble/brand/motion";
const require = createRequire(import.meta.url);
const morph = require("@ensemble/brand/motion") as typeof import("@ensemble/brand/motion");

function setup(reduce = false) {
  const names = ["performance", "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "matchMedia", "IntersectionObserver"];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const originalWindowMedia = window.matchMedia;
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
  let now = 0, serial = 0, hidden = false;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { at: number; run: () => void }>();
  const changes = new Set<() => void>();
  const observers = new Set<{ notify: (visible: boolean) => void; disconnect: () => void }>();
  const controllers: MorphController[] = [];
  const media = { matches: reduce, addEventListener(_name: string, callback: () => void) { changes.add(callback); }, removeEventListener(_name: string, callback: () => void) { changes.delete(callback); } };
  const put = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  put("performance", { now: () => now });
  put("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++serial, callback); return serial; });
  put("cancelAnimationFrame", (id: number) => frames.delete(id));
  put("setTimeout", (run: () => void, delay = 0) => { timers.set(++serial, { at: now + delay, run }); return serial; });
  put("clearTimeout", (id: number) => timers.delete(id));
  put("matchMedia", () => media);
  window.matchMedia = globalThis.matchMedia;
  put("IntersectionObserver", class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observers.add(this); }
    observe() {}
    notify(visible: boolean) { this.callback([{ isIntersecting: visible }]); }
    disconnect() { observers.delete(this); }
  });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.documentElement.dataset.reduceMotion = String(reduce);
  const container = document.createElement("div");
  document.body.append(container);
  function add(kind: MorphKind = "infinity", size = 40) {
    const el = document.createElement("span");
    container.append(el);
    const ctl = morph.mount(el, { kind, size });
    controllers.push(ctl);
    return { el, ctl };
  }
  function advance(time: number) {
    assert.ok(time >= now, "fake time must move forward");
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= time).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].run();
    }
    now = time;
    const batch = [...frames.values()];
    frames.clear();
    for (const frame of batch) frame(now);
  }
  return {
    add, advance, frames, timers, changes, observers,
    setHidden(value: boolean) { hidden = value; document.dispatchEvent(new Event("visibilitychange")); },
    setVisible(value: boolean) { for (const observer of observers) observer.notify(value); },
    setReduced(value: boolean) { media.matches = value; for (const change of changes) change(); },
    cleanup() {
      for (const ctl of controllers) ctl.destroy();
      container.remove();
      for (const [name, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      window.matchMedia = originalWindowMedia;
      if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
      else Reflect.deleteProperty(document, "hidden");
      document.documentElement.dataset.reduceMotion = "false";
    }
  };
}
const painted = (el: HTMLElement) => [el.querySelector('.wm-a')!.getAttribute('d'), el.querySelector('.wm-b')!.getAttribute('d'), (el.querySelector('.wm-rest') as HTMLElement).style.opacity];

test("timings come from the shared loading roles", () => {
  assert.equal(MORPH_ONCE_MS, morph.BASE.once * 1000);
  assert.equal(MORPH_LOOP_MS, morph.BASE.loop * 1000);
  assert.equal(MORPH_SETTLE_MS, morph.BASE.settle * 1000);
  assert.equal(MORPH_DELAY_MS, 350);
  assert.deepEqual(Object.keys(morph.kinds), ["unfurl", "infinity", "relay", "threadline", "beacon"]);
  assert.equal(morph.kinds.beacon.loop, 8600);
});

test("reduced motion keeps the exact still logo without scheduling frames or cadence timers", async () => {
  const h = setup(true);
  try {
    const { el, ctl } = h.add();
    const rest = el.querySelector('.wm-rest')!.innerHTML;
    await ctl.once();
    ctl.loop();
    ctl.seek('loop', 2);
    assert.equal(h.frames.size, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(el.dataset.pose, 'logo');
    assert.equal(el.querySelector('.wm-rest')!.innerHTML, rest);
    await ctl.settle();
    assert.equal(ctl.state, 'idle');
  } finally { h.cleanup(); }
});

test("the delay cancels on fast completion and destroyed controllers cannot restart", async () => {
  const h = setup();
  try {
    const { el, ctl } = h.add();
    ctl.loop({ delay: 350 });
    assert.equal(ctl.state, 'pending');
    assert.equal(el.dataset.running, undefined);
    h.advance(200);
    await ctl.settle();
    assert.equal(h.frames.size + h.timers.size, 0);
    ctl.loop({ delay: 350 });
    ctl.destroy();
    ctl.loop();
    await ctl.once();
    await ctl.settle();
    ctl.seek('loop', 2);
    ctl.idle();
    h.advance(1000);
    assert.equal(h.frames.size + h.timers.size, 0);
    assert.equal(el.innerHTML, '');
    assert.equal(h.observers.size, 0);
    assert.equal(h.changes.size, 0);
  } finally { h.cleanup(); }
});

test("a delayed operation shows its still mark only when the delay expires", () => {
  const h = setup();
  try {
    const { el, ctl } = h.add();
    ctl.loop({ delay: 350 });
    h.advance(349);
    assert.equal(ctl.state, 'pending');
    assert.equal(el.dataset.running, undefined);
    h.advance(350);
    assert.equal(ctl.state, 'loop');
    assert.equal(el.dataset.running, 'true');
    assert.equal(el.dataset.pose, 'logo');
    h.advance(1400);
    assert.equal(el.dataset.pose, 'infinity');
    ctl.idle();
    assert.equal(h.frames.size + h.timers.size, 0);
  } finally { h.cleanup(); }
});

test("peripheral activity sleeps through its still interval without path writes or animation frames", () => {
  const h = setup();
  try {
    const { el, ctl } = h.add('beacon', 24);
    let writes = 0;
    for (const node of el.querySelectorAll('.wm-a, .wm-b')) {
      const set = node.setAttribute.bind(node);
      node.setAttribute = (name, value) => { if (name === 'd') writes++; set(name, value); };
    }
    ctl.loop();
    assert.equal(h.frames.size, 0);
    h.advance(1500);
    assert.equal(el.dataset.pose, 'beacon');
    h.advance(3200);
    assert.equal(el.dataset.pose, 'logo');
    const before = writes;
    assert.equal(h.frames.size, 0);
    assert.equal(h.timers.size, 1);
    h.advance(9000);
    assert.equal(writes, before);
    assert.equal(h.frames.size, 0);
    h.advance(9300);
    assert.ok(writes > before);
  } finally { h.cleanup(); }
});

test("live playback and scrubbing use the same poses for every role", () => {
  for (const kind of ['infinity', 'relay', 'threadline', 'beacon'] as const) {
    const h = setup();
    try {
      const live = h.add(kind), sample = h.add(kind);
      live.ctl.loop();
      for (const time of [900, 1500, 2200, 2950, 4800, 5500]) {
        h.advance(time);
        sample.ctl.seek('loop', time / 1000);
        // Invisible live paths retain their last geometry during still intervals.
        if (live.el.dataset.pose !== 'logo') assert.deepEqual(painted(live.el), painted(sample.el));
        assert.equal(live.el.dataset.pose, sample.el.dataset.pose);
        assert.equal((live.el.querySelector('.wm-rest') as HTMLElement).style.opacity, (sample.el.querySelector('.wm-rest') as HTMLElement).style.opacity);
      }
    } finally { h.cleanup(); }
  }
});

test("interrupted work settles directly from its current shape and releases its promise", async () => {
  const h = setup();
  try {
    const { el, ctl } = h.add('relay');
    ctl.loop();
    h.advance(1600);
    const before = painted(el);
    const settled = ctl.settle();
    assert.deepEqual(painted(el), before);
    h.advance(1600 + MORPH_SETTLE_MS);
    await settled;
    assert.equal(ctl.state, 'idle');
    assert.equal(el.dataset.pose, 'logo');
    assert.equal(h.frames.size + h.timers.size, 0);
  } finally { h.cleanup(); }
});

test("hidden and offscreen activity stops all cadence work and resumes without changing pose immediately", () => {
  const h = setup();
  try {
    const { el, ctl } = h.add();
    ctl.loop();
    h.advance(1500);
    const before = painted(el);
    h.setHidden(true);
    assert.equal(h.frames.size + h.timers.size, 0);
    h.advance(20000);
    assert.deepEqual(painted(el), before);
    h.setHidden(false);
    assert.deepEqual(painted(el), before);
    assert.equal(h.frames.size, 1);
    h.setVisible(false);
    assert.equal(h.frames.size + h.timers.size, 0);
    h.advance(40000);
    assert.deepEqual(painted(el), before);
    h.setVisible(true);
    assert.equal(h.frames.size, 1);
    h.advance(40050);
    assert.notDeepEqual(painted(el), before);
  } finally { h.cleanup(); }
});

test("OS and app reduced-motion changes stop running activity and resume from a still interval", async () => {
  const h = setup();
  try {
    const { el, ctl } = h.add();
    ctl.loop();
    h.advance(1500);
    h.setReduced(true);
    assert.equal(el.dataset.pose, 'logo');
    assert.equal(h.frames.size + h.timers.size, 0);
    h.setReduced(false);
    assert.equal(el.dataset.pose, 'logo');
    assert.equal(h.frames.size, 0);
    assert.equal(h.timers.size, 1);
    h.advance(2500);
    assert.equal(el.dataset.pose, 'infinity');
    document.documentElement.dataset.reduceMotion = 'true';
    await Promise.resolve();
    assert.equal(el.dataset.pose, 'logo');
    assert.equal(h.frames.size + h.timers.size, 0);
    document.documentElement.dataset.reduceMotion = 'false';
    await Promise.resolve();
    assert.equal(h.frames.size, 0);
    assert.equal(h.timers.size, 1);
  } finally { h.cleanup(); }
});

test("all visible marks share one frame request and own unique gradients", () => {
  const h = setup();
  try {
    const marks = ['infinity', 'relay', 'threadline', 'beacon'].map(kind => h.add(kind as MorphKind));
    for (const mark of marks) mark.ctl.loop();
    assert.equal(h.timers.size, 1);
    h.advance(1500);
    assert.equal(h.frames.size, 1);
    const ids = [...document.querySelectorAll('svg [id]')].map(el => el.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const mark of marks) mark.ctl.destroy();
    assert.equal(h.frames.size + h.timers.size, 0);
    assert.equal(h.changes.size, 0);
  } finally { h.cleanup(); }
});

test("changing an active role preserves the currently painted pose until its handoff starts", () => {
  const h = setup();
  try {
    const { el, ctl } = h.add();
    ctl.loop();
    h.advance(1700);
    const before = painted(el);
    ctl.loop({ kind: 'relay' });
    assert.deepEqual(painted(el), before);
    h.advance(2100);
    assert.equal(el.dataset.pose, 'relay');
    assert.notDeepEqual(painted(el), before);
  } finally { h.cleanup(); }
});

test("one-shot playback matches scrubbing and resolves if hidden or destroyed", async () => {
  const h = setup();
  try {
    const live = h.add(), sample = h.add();
    const done = live.ctl.once();
    h.advance(300);
    sample.ctl.seek('once', .3);
    assert.deepEqual(painted(live.el), painted(sample.el));
    h.setHidden(true);
    await done;
    assert.equal(live.ctl.state, 'idle');
    assert.equal(h.frames.size + h.timers.size, 0);
    h.setHidden(false);
    const cancelled = live.ctl.once();
    live.ctl.destroy();
    await cancelled;
    assert.equal(h.frames.size + h.timers.size, 0);
  } finally { h.cleanup(); }
});

test("reduced motion still honors the show delay without starting a cadence", () => {
  const h = setup(true);
  try {
    const { el, ctl } = h.add();
    ctl.loop({ delay: 350 });
    assert.equal(h.frames.size, 0);
    h.advance(350);
    assert.equal(el.dataset.running, 'true');
    assert.equal(el.dataset.pose, 'logo');
    assert.equal(h.frames.size + h.timers.size, 0);
  } finally { h.cleanup(); }
});
