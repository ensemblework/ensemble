import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./api.js";
import { describeLoadFailure, loadFailureKind } from "./load-failure.js";

test("a load failure tells offline from a server error", () => {
  assert.equal(loadFailureKind(new ApiError("Ensemble can't reach its server right now.", 0)), "offline");
  assert.equal(loadFailureKind(new ApiError("Ensemble can't reach its server right now.", 503)), "offline");
  assert.equal(loadFailureKind(new ApiError("Something went wrong on the Hub.", 500)), "server");
  assert.equal(loadFailureKind(new ApiError("Page not found.", 404)), "missing");
  assert.equal(loadFailureKind(new ApiError("No.", 403)), "denied");
  assert.equal(loadFailureKind(new TypeError("Failed to fetch")), "offline");
  assert.equal(loadFailureKind(new Error("odd")), "other");
});

test("the message names what failed and keeps the server's own words for other errors", () => {
  assert.deepEqual(describeLoadFailure(new ApiError("Something went wrong on the Hub.", 500), "the board").title, "Couldn't load the board");
  assert.match(describeLoadFailure(new ApiError("x", 0), "the board").title, /Can't reach Ensemble/);
  assert.equal(describeLoadFailure(new ApiError("That feature is off.", 404), "plots").detail, "That feature is off.");
});
