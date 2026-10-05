import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MORPH_DELAY_MS, MORPH_LOOP_MS, MORPH_ONCE_MS, MORPH_SETTLE_MS } from "./brand-morph";

const require = createRequire(import.meta.url);
const morph = require("./ensemble-morph.js") as {
  mount: (el: FakeEl, opts?: { size?: number }) => MorphApi;
  staticSVG: (size: number) => string;
  frame: (style: string, mode: string, t: number, g: unknown) => Frame;
  geom: (n: number) => unknown;
  BASE: { once: number; loop: number; loopLarge: number; settle: number };
  TIMING: Record<string, { once: number; loop: number; settle: number }>;
};

type Frame = { o: number[][]; i: number[][] };
type MorphApi = {
  once: () => Promise<void>;
  loop: (opts?: { delay?: number }) => MorphApi;
  settle: () => Promise<void>;
  state: string;
};

type FakeEl = {
  dataset: Record<string, string | undefined>;
  innerHTML: string;
  querySelector: (sel: string) => FakeEl | null;
  querySelectorAll: (sel: string) => FakeEl[];
  closest: (sel: string) => FakeEl | null;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  getAttribute: (name: string) => string | null;
  addEventListener: (type: string, fn: () => void) => void;
  dispatchEvent: (event: Event) => boolean;
  style: Record<string, string>;
  __morph?: MorphApi;
};

class El {
  tag: string;
  attrs = new Map<string, string>();
  children: El[] = [];
  parent: El | null = null;
  style: Record<string, string> = {};
  listeners = new Map<string, Array<() => void>>();
  __morph?: MorphApi;

  constructor(tag: string, attrs: Array<[string, string]> = []) {
    this.tag = tag;
    for (const [name, value] of attrs) this.attrs.set(name, value);
  }

  get dataset(): Record<string, string | undefined> {
    const el = this;
    return new Proxy({} as Record<string, string | undefined>, {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        return el.attrs.get(`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
      },
      set(_target, key, value) {
        if (typeof key !== "string") return false;
        el.attrs.set(`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(value));
        return true;
      },
    });
  }

  set innerHTML(html: string) {
    this.children = parse(html);
    for (const child of this.children) child.parent = this;
  }

  querySelector(sel: string): El | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }

  querySelectorAll(sel: string): El[] {
    const out: El[] = [];
    const walk = (node: El) => {
      if (matches(node, sel)) out.push(node);
      for (const child of node.children) walk(child);
    };
    for (const child of this.children) walk(child);
    return out;
  }

  closest(sel: string): El | null {
    let node: El | null = this;
    while (node) {
      if (matches(node, sel)) return node;
      node = node.parent;
    }
    return null;
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }

  removeAttribute(name: string) {
    this.attrs.delete(name);
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }

  addEventListener(type: string, fn: () => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatchEvent(event: Event) {
    for (const fn of this.listeners.get(event.type) ?? []) fn();
    return true;
  }
}

function matches(node: El, sel: string): boolean {
  const attr = sel.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (attr) {
    const value = node.attrs.get(attr[1]);
    return attr[2] === undefined ? value !== undefined : value === attr[2];
  }
  const [head, ...classes] = sel.split(".");
  if (head && head !== node.tag) return false;
  return classes.every((name) => (node.attrs.get("class") ?? "").split(/\s+/).includes(name));
}

function parse(html: string): El[] {
  const roots: El[] = [];
  const stack: El[] = [];
  const re = /<(\/?)([a-z0-9]+)([^>]*?)(\/?)>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const self = match[4] === "/" || tag === "circle";
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs: Array<[string, string]> = [];
    const attrRe = /([:\w-]+)(?:="([^"]*)")?/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(match[3]))) attrs.push([attr[1], attr[2] ?? ""]);
    const el = new El(tag, attrs);
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(el);
      el.parent = parent;
    } else roots.push(el);
    if (!self) stack.push(el);
  }
  return roots;
}

let now = 0;
const frames: Array<{ id: number; cb: (t: number) => void }> = [];
let nextId = 1;
let rafCalls = 0;

function installClock() {
  now = 0;
  frames.length = 0;
  rafCalls = 0;
  globalThis.requestAnimationFrame = ((cb: (t: number) => void) => {
    rafCalls += 1;
    const id = nextId++;
    frames.push({ id, cb });
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    const index = frames.findIndex((frame) => frame.id === id);
    if (index >= 0) frames.splice(index, 1);
  }) as typeof cancelAnimationFrame;
  const clock = { now: () => now };
  Object.defineProperty(globalThis, "performance", { value: clock, configurable: true });
}

function flush() {
  const batch = frames.splice(0, frames.length);
  for (const frame of batch) frame.cb(now);
}

function host(reduce = false): El {
  const root = new El("div");
  if (reduce) root.setAttribute("data-reduce-motion", "true");
  const el = new El("span");
  el.parent = root;
  root.children.push(el);
  return el;
}

test("every motion style is the same Expressive morph", () => {
  assert.equal(morph.BASE.once, 1.5);
  assert.equal(morph.BASE.loop, 2.7);
  assert.equal(morph.BASE.loopLarge, morph.BASE.loop);
  assert.equal(morph.BASE.settle, 0.38);
  assert.equal(morph.TIMING.expressive, morph.TIMING["minimal-quiet"]);
  assert.equal(morph.TIMING["minimal-quiet"], morph.TIMING["minimal-dot"]);
  const expressive = morph.frame("expressive", "loop", 1.1, morph.geom(96));
  const quiet = morph.frame("minimal-quiet", "loop", 1.1, morph.geom(96));
  const dot = morph.frame("minimal-dot", "loop", 1.1, morph.geom(96));
  assert.deepEqual(quiet, expressive);
  assert.deepEqual(dot, expressive);
  const large = morph.frame("expressive", "loopLarge", 0.8, morph.geom(96));
  const loop = morph.frame("expressive", "loop", 0.8, morph.geom(96));
  assert.deepEqual(large.o, loop.o);
  assert.deepEqual(large.i, loop.i);
});

test("React timings are the morph constants, not a second copy of the numbers", () => {
  assert.equal(MORPH_ONCE_MS, morph.BASE.once * 1000);
  assert.equal(MORPH_LOOP_MS, morph.BASE.loop * 1000);
  assert.equal(MORPH_SETTLE_MS, Math.round(morph.BASE.settle * 1000));
  assert.equal(MORPH_DELAY_MS, 180);
  const source = readFileSync(new URL("./brand-morph.tsx", import.meta.url), "utf8");
  assert.match(source, /delay: loader \? MORPH_DELAY_MS : 0/);
  const keyframes = JSON.parse(readFileSync(new URL("./brand-morph.keyframes.json", import.meta.url), "utf8")) as {
    delay_ms: number;
    styles: string;
    timing: { once: number; loop: number; settle: number };
    sizes: Record<string, { once: unknown; loop?: unknown; loopLarge?: unknown }>;
  };
  assert.equal(keyframes.delay_ms, MORPH_DELAY_MS);
  assert.equal(keyframes.timing.once, morph.BASE.once);
  assert.equal(keyframes.timing.loop, morph.BASE.loop);
  assert.equal(keyframes.timing.settle, morph.BASE.settle);
  assert.equal(typeof keyframes.styles, "string");
  assert.ok(keyframes.sizes["20"].once);
  assert.ok(keyframes.sizes["20"].loop);
  assert.ok(keyframes.sizes["96"].once);
  assert.ok(keyframes.sizes["96"].loopLarge);
});

test("reduced motion stays on the still mark and does not schedule frames", async () => {
  installClock();
  globalThis.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
  const el = host(true);
  const api = morph.mount(el, { size: 20 });
  await api.once();
  const path = el.querySelector(".u-mo")?.getAttribute("d") ?? "";
  assert.match(path, /A/);
  assert.doesNotMatch(path, /L/);
  const before = rafCalls;
  api.loop();
  assert.equal(rafCalls, before);
  assert.match(el.querySelector(".u-mo")?.getAttribute("d") ?? "", /A/);
});

test("settle returns to the mark in one settle duration from the middle of a loop", async () => {
  installClock();
  globalThis.matchMedia = (() => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
  const el = host(false);
  let idle = 0;
  el.addEventListener("ensemble:morph-idle", () => {
    idle += 1;
  });
  const api = morph.mount(el, { size: 40 });
  api.loop();
  now = 1200;
  flush();
  const moving = el.querySelector(".u-mo")?.getAttribute("d") ?? "";
  assert.match(moving, /L/);
  const settled = api.settle();
  now = 1200 + MORPH_SETTLE_MS;
  flush();
  await settled;
  assert.equal(api.state, "idle");
  assert.equal(idle, 1);
  const rest = el.querySelector(".u-mo")?.getAttribute("d") ?? "";
  assert.match(rest, /A/);
  assert.ok(now - 1200 < morph.BASE.loop * 1000);
});
