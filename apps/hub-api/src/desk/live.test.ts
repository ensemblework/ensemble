import assert from "node:assert/strict";
import test from "node:test";
import { withDated } from "./live.js";

const row = (id: string, due: string | null = null) => ({ id, due: due ? new Date(`${due}T00:00:00.000Z`) : null });

test("overdue work stays in the desk payload when it was not touched recently", () => {
  const recent = [row("a"), row("b", "2026-10-20"), row("c"), row("d")];
  const dated = [row("old", "2025-01-01"), row("b", "2026-10-20")];
  const out = withDated(recent, dated, 4);
  assert.deepEqual(out.map((r) => r.id), ["a", "b", "c", "old"], "the least recent undated row makes room");
  assert.deepEqual(withDated(recent, [row("b", "2026-10-20")], 4).map((r) => r.id), ["a", "b", "c", "d"]);
  assert.equal(withDated(recent, dated, 3).length, 3);
});
