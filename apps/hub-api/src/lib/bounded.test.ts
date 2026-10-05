import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dropWhere, readLru, remember } from "./bounded.js";

describe("bounded maps", () => {
  it("evicts the least recently used key", () => {
    const map = new Map<string, number>();
    remember(map, "a", 1, 2);
    remember(map, "b", 2, 2);
    assert.equal(readLru(map, "a"), 1);
    remember(map, "c", 3, 2);
    assert.deepEqual([...map.keys()], ["a", "c"]);
  });

  it("drops expired entries and keeps the rest", () => {
    const map = new Map<string, { at: number }>([
      ["old", { at: 1 }],
      ["new", { at: 50 }],
    ]);
    dropWhere(map, (value) => value.at < 10);
    assert.deepEqual([...map.keys()], ["new"]);
  });
});
