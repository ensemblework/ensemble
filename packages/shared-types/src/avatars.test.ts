import assert from "node:assert/strict";
import test from "node:test";
import { AVATAR_CHARACTERS, AVATAR_PALETTES, AVATAR_SCENERIES, avatarId, isAvatarId, parseAvatar } from "./avatars.js";

test("every character, palette and scenery combination round-trips without a profile or gender", () => {
  const ids = new Set<string>();
  for (const character of AVATAR_CHARACTERS) for (const palette of AVATAR_PALETTES) for (const scenery of AVATAR_SCENERIES) {
    const parts = { character: character.id, palette: palette.id, scenery: scenery.id };
    const id = avatarId(parts);
    assert.ok(isAvatarId(id));
    assert.ok(id.length <= 40);
    assert.deepEqual(parseAvatar(id), parts);
    ids.add(id);
  }
  assert.equal(ids.size, 360);
  for (const bad of ["dots.0.blue.none", "dots.13.blue.none", "dots.01.blue.none", "dots.1e0.blue.none", "dots.2.purple.hills", "dots.2.blue.forest", "dots.2.blue", "dots.2.blue.none.more", "__proto__.f.1", "engineer.f.2.__proto__", null, undefined, {}, 5]) assert.equal(isAvatarId(bad), false, String(bad));
});

test("saved portrait ids resolve to the new collection, with no gender-specific choices", () => {
  for (const role of ["engineer", "student", "teacher", "lawyer", "manager", "vibe"]) for (const gender of ["f", "m", "n"]) {
    assert.deepEqual(parseAvatar(`${role}.${gender}.9.mint`), { character: 9, palette: "teal", scenery: "hills" });
  }
  assert.equal(parseAvatar("vibe.f.2")?.palette, "lilac");
  assert.equal(parseAvatar("engineer.m.4.peach")?.palette, "apricot");
  for (const bad of ["lawyer.f.11", "lawyer.f.0", "lawyer.f.3.purple", "lawyer.f.3.mint.x", "lawyer.f", "pilot.f.1", "lawyer.x.1", "lawyer.f.1e0"]) assert.equal(isAvatarId(bad), false, bad);
});

test("the approved collection keeps its category balance, one accent and open silhouette gaps", () => {
  assert.deepEqual(AVATAR_CHARACTERS.reduce<Record<string, number>>((counts, row) => { counts[row.kind] = (counts[row.kind] ?? 0) + 1; return counts; }, {}), { human: 5, humanoid: 3, animal: 4 });
  assert.deepEqual(AVATAR_CHARACTERS.filter(row => row.kind === "animal").map(row => row.label), ["Elephant", "Dog", "Cat", "Bird"]);
  for (const character of AVATAR_CHARACTERS) {
    assert.equal(character.rows.length, 8);
    assert.ok(character.rows.every(row => row.length === 8 && /^[.xoa]+$/.test(row)));
    assert.equal(character.rows.join("").split("a").length - 1, 1);
    for (const [col, row, width, height] of character.voids) for (let y = row; y < row + height; y++) for (let x = col; x < col + width; x++) assert.equal(character.rows[y]![x], ".", `${character.label}: preserve its silhouette gap`);
  }
});
