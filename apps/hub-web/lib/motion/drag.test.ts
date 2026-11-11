import assert from "node:assert/strict";
import test from "node:test";
import { flipOffset, measureBoxes, motionReduced, perFrame, playFlip } from "./drag";

function frames() {
  const queue = new Map<number, () => void>();
  let next = 1;
  return {
    schedule: (run: () => void) => {
      const id = next++;
      queue.set(id, run);
      return id;
    },
    unschedule: (id: number) => void queue.delete(id),
    tick: () => {
      const runs = [...queue.values()];
      queue.clear();
      for (const run of runs) run();
    },
    pending: () => queue.size,
  };
}

test("perFrame runs once a frame with the latest arguments", () => {
  const clock = frames();
  const seen: number[] = [];
  const call = perFrame((value: number) => seen.push(value), clock.schedule, clock.unschedule);
  call(1);
  call(2);
  call(3);
  assert.equal(clock.pending(), 1);
  assert.deepEqual(seen, []);
  clock.tick();
  assert.deepEqual(seen, [3]);
  clock.tick();
  assert.deepEqual(seen, [3]);
});

test("perFrame flush runs the pending call now, cancel drops it", () => {
  const clock = frames();
  const seen: number[] = [];
  const call = perFrame((value: number) => seen.push(value), clock.schedule, clock.unschedule);
  call(4);
  call.flush();
  assert.deepEqual(seen, [4]);
  assert.equal(clock.pending(), 0);
  call(5);
  call.cancel();
  clock.tick();
  assert.deepEqual(seen, [4]);
  call.flush();
  assert.deepEqual(seen, [4]);
});

test("flipOffset is where it was relative to where it is, and ignores sub-pixel moves", () => {
  const box = (left: number, top: number) => ({ left, top, width: 10, height: 10 });
  assert.deepEqual(flipOffset(box(10, 40), box(110, 20)), { x: -100, y: 20 });
  assert.equal(flipOffset(box(10, 40), box(10.4, 40.6)), null);
});

function element(key: string, rect: { left: number; top: number }) {
  const played: Keyframe[][] = [];
  return {
    dataset: { key },
    played,
    getBoundingClientRect: () => ({ ...rect, width: 20, height: 20 }),
    animate: (frames: Keyframe[]) => {
      played.push(frames);
      return {} as Animation;
    },
  };
}

test("playFlip plays only the elements that moved, from their old place", () => {
  const moved = element("a", { left: 100, top: 0 });
  const still = element("b", { left: 0, top: 50 });
  const fresh = element("c", { left: 0, top: 90 });
  const all = [moved, still, fresh] as unknown as HTMLElement[];
  const before = measureBoxes([element("a", { left: 0, top: 0 }), element("b", { left: 0, top: 50 })] as unknown as HTMLElement[], (node) => node.dataset.key);
  const played = playFlip(all, (node) => node.dataset.key, before, { reduced: false });
  assert.equal(played.length, 1);
  assert.equal(moved.played[0]?.[0]?.transform, "translate3d(-100px, 0px, 0)");
  assert.equal(still.played.length, 0);
  assert.equal(fresh.played.length, 0);
  assert.equal(playFlip(all, (node) => node.dataset.key, before, { reduced: true }).length, 0);
});

test("motionReduced follows the app setting and the OS setting", () => {
  const doc = (reduce: string | undefined, os: boolean) =>
    ({ documentElement: { dataset: { reduceMotion: reduce } }, defaultView: { matchMedia: () => ({ matches: os }) } }) as unknown as Document;
  assert.equal(motionReduced(doc("true", false)), true);
  assert.equal(motionReduced(doc(undefined, true)), true);
  assert.equal(motionReduced(doc("false", false)), false);
});
