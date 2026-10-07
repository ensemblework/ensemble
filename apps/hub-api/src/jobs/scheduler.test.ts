import assert from "node:assert/strict";
import test from "node:test";
import "../runtime/test-env.js";
import { scheduledFetchDue, scheduledFetchEnabled } from "./scheduler.js";

const due = { fetch: { scheduled: true, times: ["09:00", "16:00"] } };

test("scheduled fetching is paused product-wide unless ENSEMBLE_SCHEDULED_FETCH=on", () => {
  assert.equal(scheduledFetchEnabled({}), false);
  assert.equal(scheduledFetchEnabled({ ENSEMBLE_SCHEDULED_FETCH: "off" }), false);
  assert.equal(scheduledFetchEnabled({ ENSEMBLE_SCHEDULED_FETCH: " On " }), true);
  // A person's own "scheduled: true" does not override the pause.
  assert.equal(scheduledFetchDue(due, "09:00", {}), false);
  assert.equal(scheduledFetchDue(due, "09:00", { ENSEMBLE_SCHEDULED_FETCH: "on" }), true);
  assert.equal(scheduledFetchDue(due, "09:01", { ENSEMBLE_SCHEDULED_FETCH: "on" }), false);
  assert.equal(scheduledFetchDue({ fetch: { ...due.fetch, scheduled: false } }, "09:00", { ENSEMBLE_SCHEDULED_FETCH: "on" }), false);
});
