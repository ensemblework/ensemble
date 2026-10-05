import assert from "node:assert/strict";
import test from "node:test";
import { CYCLE_FAVOURITE_THEMES, formatBinding, isCycleFavouriteThemesShortcut, SHORTCUTS, shortcutProblems } from "./shortcuts.js";

test("the favourite-theme shortcut does not use Ctrl, Cmd, or the Linux terminal chord", () => {
  assert.equal(CYCLE_FAVOURITE_THEMES.ctrl, false);
  assert.equal(CYCLE_FAVOURITE_THEMES.meta, false);
  assert.equal(CYCLE_FAVOURITE_THEMES.alt, true);
  assert.equal(CYCLE_FAVOURITE_THEMES.shift, true);
  assert.equal(isCycleFavouriteThemesShortcut({ key: "T", altKey: true, shiftKey: true, ctrlKey: false, metaKey: false }), true);
  assert.equal(isCycleFavouriteThemesShortcut({ key: "t", altKey: true, shiftKey: true, ctrlKey: true, metaKey: false }), false);
  assert.equal(isCycleFavouriteThemesShortcut({ key: "t", altKey: true, shiftKey: false, ctrlKey: false, metaKey: false }), false);
});

test("Alt+Shift+T sits in the shared registry and does not collide with other chords", () => {
  assert.deepEqual(shortcutProblems(SHORTCUTS), []);
  const theme = SHORTCUTS.find((binding) => binding.id === CYCLE_FAVOURITE_THEMES.id);
  const ask = SHORTCUTS.find((binding) => binding.id === "ask");
  const palette = SHORTCUTS.find((binding) => binding.id === "palette");
  assert.equal(theme?.mac?.key, "t");
  assert.equal(theme?.mac?.alt, true);
  assert.equal(theme?.mac?.shift, true);
  assert.equal(formatBinding(theme!, false), "Alt+Shift+T");
  assert.equal(ask?.mac?.key, "a");
  assert.equal(ask?.mac?.alt, true);
  assert.equal(ask?.mac?.shift, undefined);
  assert.equal(palette?.mac?.key, "k");
  assert.equal(palette?.mac?.mod, true);
});
