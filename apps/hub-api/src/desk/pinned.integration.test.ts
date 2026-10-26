import assert from "node:assert/strict";
import test from "node:test";
import { createHttpHarness } from "../test/http.js";

test("Today pins survive the recent-task limit and exclude completed, deleted, snoozed and other-account work", async () => {
  const h = await createHttpHarness();
  try {
    const user = await h.asUser();
    const other = await h.asUser();
    const pin = await h.prisma.task.create({ data: { userId: user.id, title: "Keep this old task on Today", todayFocus: "keep", updatedAt: new Date("2020-01-01") } });
    await h.prisma.task.createMany({ data: Array.from({ length: 50 }, (_, index) => ({ userId: user.id, title: `Recent ${index}` })) });
    await h.prisma.task.createMany({ data: [
      { userId: user.id, title: "Done", status: "done", todayFocus: "keep" },
      { userId: user.id, title: "Deleted", deletedAt: new Date(), todayFocus: "keep" },
      { userId: user.id, title: "Snoozed", snoozedUntil: new Date(Date.now() + 86_400_000), todayFocus: "keep" },
      { userId: other.id, title: "Other account", todayFocus: "keep" },
    ] });
    const response = await user.inject({ method: "GET", url: "/api/desk/live" });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().pinnedTasks, [{ id: pin.id, title: pin.title }]);
    await user.inject({ method: "PATCH", url: `/api/tasks/${pin.id}`, payload: { todayFocus: "auto" } });
    const unpinned = await user.inject({ method: "GET", url: "/api/desk/live" });
    assert.deepEqual(unpinned.json().pinnedTasks, []);
  } finally { await h.close(); }
});
