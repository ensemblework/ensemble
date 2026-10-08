import assert from "node:assert/strict";
import test from "node:test";
import { CYCLE_FAVOURITE_THEMES, applyShortcutOverrides, chordFromEvent, customChordProblem, eventMatchesChord, formatBinding, isCycleFavouriteThemesShortcut, matchShortcut, SHORTCUTS, shortcutProblems } from "./shortcuts.js";

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

test("people can rebind global actions without taking browser or system chords", () => {
  const press = (key: string, extra: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
  assert.deepEqual(chordFromEvent(press("Meta", { metaKey: true }), true), null);
  const optionP = chordFromEvent(press("π", { code: "KeyP", altKey: true, shiftKey: true }), true);
  assert.deepEqual(optionP, { key: "p", alt: true, shift: true });
  assert.equal(customChordProblem("new-page", optionP!, SHORTCUTS, true), null);
  assert.match(customChordProblem("new-page", { key: "p", mod: true }, SHORTCUTS, true) ?? "", /browser/);
  assert.match(customChordProblem("new-page", { key: "t", mod: true, shift: true }, SHORTCUTS, false) ?? "", /browser/);
  assert.match(customChordProblem("new-page", { key: "p" }, SHORTCUTS, true) ?? "", /Command or Option/);
  assert.match(customChordProblem("new-page", { key: "k", mod: true }, SHORTCUTS, true) ?? "", /Command palette/);
  assert.match(customChordProblem("undo", { key: "u", alt: true }, SHORTCUTS, true) ?? "", /cannot be changed/);
  // Mac Control is Ctrl elsewhere, where Ctrl is the main modifier.
  assert.match(customChordProblem("new-page", { key: "k", ctrl: true }, SHORTCUTS, true) ?? "", /Command palette/);
  assert.match(customChordProblem("new-page", { key: "t", ctrl: true }, SHORTCUTS, true) ?? "", /browser/);
  assert.equal(customChordProblem("new-page", { key: "y", ctrl: true, shift: true }, SHORTCUTS, true), null);
  const bindings = applyShortcutOverrides({ "new-page": optionP, undo: { key: "u", alt: true } });
  const page = bindings.find((binding) => binding.id === "new-page")!;
  assert.deepEqual(page.sequence, ["n", "p"]);
  assert.deepEqual(page.mac, { key: "p", alt: true, shift: true });
  assert.deepEqual(bindings.find((binding) => binding.id === "undo")!.mac, { key: "z", mod: true });
  assert.equal(matchShortcut(press("π", { code: "KeyP", altKey: true, shiftKey: true }), true, false, bindings)?.id, "new-page");
  assert.equal(eventMatchesChord(press("Π", { code: "KeyP", altKey: true, shiftKey: true }), page.mac!, true), true);
  assert.deepEqual(shortcutProblems(bindings), []);
});
