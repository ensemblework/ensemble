import assert from "node:assert/strict";
import test from "node:test";
import { addFavourite, cycleFavourite, removeFavourite, replaceFavourite } from "./favourites.js";
import type { ThemeFavourite } from "./types.js";

const fav = (id: string): ThemeFavourite => ({ id, label: id, kind: "dark", source: "builtin" });

test("a fourth favourite is refused and can replace an existing one", () => {
  let list: ThemeFavourite[] = [];
  for (const id of ["one", "two", "three"]) {
    const added = addFavourite(list, fav(id));
    assert.equal(added.ok, true);
    if (added.ok) list = added.favourites;
  }
  const blocked = addFavourite(list, fav("four"));
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, "limit");
  assert.deepEqual(blocked.favourites.map((item) => item.id), ["one", "two", "three"]);

  list = replaceFavourite(list, "two", fav("four"));
  assert.deepEqual(list.map((item) => item.id), ["one", "three", "four"]);
  assert.equal(addFavourite(list, fav("four")).ok, true);
});

test("cycling favourites wraps and does nothing when none are starred", () => {
  assert.equal(cycleFavourite([], "one"), null);
  const list = [fav("one"), fav("two"), fav("three")];
  assert.equal(cycleFavourite(list, "one"), "two");
  assert.equal(cycleFavourite(list, "three"), "one");
  assert.equal(cycleFavourite(list, "missing", -1), "three");
  assert.deepEqual(removeFavourite(list, "two").map((item) => item.id), ["one", "three"]);
});
