import assert from "node:assert/strict";
import test from "node:test";
import { avatarBackground, avatarFace, avatarIds, isAvatarId, parseAvatar, withAvatarBackground } from "./avatars.js";

test("avatar ids: ten faces a group, an optional background, nothing else", () => {
  assert.deepEqual(parseAvatar("lawyer.f.3"), { role: "lawyer", gender: "f", n: 3, background: null });
  assert.deepEqual(parseAvatar("lawyer.f.10.mint"), { role: "lawyer", gender: "f", n: 10, background: "mint" });
  for (const bad of ["lawyer.f.11", "lawyer.f.0", "lawyer.f.3.purple", "lawyer.f.3.mint.x", "lawyer.f", "pilot.f.1", "lawyer.x.1", "lawyer.f.1e0"]) {
    assert.equal(isAvatarId(bad), false, bad);
  }
  assert.equal(avatarIds("teacher", "n").length, 10);
  assert.deepEqual(avatarIds("teacher", "n", "sky").slice(0, 2), ["teacher.n.1.sky", "teacher.n.2.sky"]);
});

test("a background is written only when it differs from the profession's own colour", () => {
  assert.equal(withAvatarBackground("vibe.m.4", "slate"), "vibe.m.4.slate");
  assert.equal(withAvatarBackground("vibe.m.4.slate", "rose"), "vibe.m.4", "rose is the Maker colour");
  assert.equal(avatarBackground(parseAvatar("vibe.m.4")!), "rose");
  assert.equal(avatarBackground(parseAvatar("engineer.m.4.peach")!), "peach");
  assert.equal(avatarFace("engineer.m.4.peach"), "engineer.m.4");
  assert.ok(avatarIds("vibe", "f", "rose").every((id) => id.split(".").length === 3));
});
