/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AVATAR_CHARACTERS, AVATAR_SCENERIES, avatarId } from "@ensemble/shared-types";
import { PersonaAvatar } from "./persona";
import { avatarScenery } from "./pixel-art";

test("all profile pictures are circle-clipped and contain the selected dots and scenery", () => {
  document.body.innerHTML = renderToStaticMarkup(<><PersonaAvatar id="dots.9.blue.grove" size={24} title="Mira" /><PersonaAvatar id="lawyer.f.9.sky" size={64} /></>);
  const portraits = [...document.querySelectorAll("svg")];
  assert.equal(portraits.length, 2);
  const clips = [...document.querySelectorAll("clipPath")].map(node => node.id);
  assert.equal(new Set(clips).size, 2, "repeated avatars must not share SVG clipping ids");
  for (const portrait of portraits) {
    assert.equal(portrait.style.borderRadius, "50%");
    assert.ok(portrait.querySelector('clipPath circle[cx="36"][cy="36"][r="36"]'));
    assert.equal(portrait.querySelectorAll('[data-avatar-character="9"] circle').length, 28);
    assert.equal(portrait.querySelectorAll('[data-accent="true"]').length, 1);
  }
  assert.equal(portraits[0]!.getAttribute("width"), "24");
  assert.ok(portraits[0]!.querySelector('[data-avatar-scenery="grove"] rect'));
  assert.equal(portraits[1]!.getAttribute("data-persona-avatar"), "dots.9.blue.hills");
  document.body.innerHTML = renderToStaticMarkup(<PersonaAvatar id="dots.9.blue.none" />);
  assert.equal(document.querySelectorAll('[data-avatar-scenery] rect').length, 0);
  document.body.innerHTML = "";
});

test("every landscape keeps the elephant legs and other protected gaps clear", () => {
  for (const character of AVATAR_CHARACTERS) for (const scenery of AVATAR_SCENERIES) {
    for (const pixel of avatarScenery(character.id, scenery.id)) {
      const cx = pixel.x + 3, cy = pixel.y + 3;
      assert.ok(!character.voids.some(([col, row, width, height]) => cx >= 12 + col * 6 && cx < 12 + (col + width) * 6 && cy >= 12 + row * 6 && cy < 12 + (row + height) * 6), `${avatarId({ character: character.id, palette: "blue", scenery: scenery.id })}: no scenery in silhouette gaps`);
    }
  }
});
