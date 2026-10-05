import assert from "node:assert/strict";
import test from "node:test";
import { statusFor } from "./status-line.js";

test("a Gmail fetch reports the real source", () => {
  assert.equal(statusFor([{ name: "hub_fetch_now", arguments: JSON.stringify({ sources: ["gmail"] }) }]), "Reading Gmail…");
});

test("several sources stay one real status line", () => {
  assert.equal(
    statusFor([{ name: "hub_fetch_now", arguments: JSON.stringify({ sources: ["gmail", "github"] }) }]),
    "Reading Gmail, GitHub…",
  );
});

test("an unnamed fetch and an unknown tool stay generic", () => {
  assert.equal(statusFor([{ name: "hub_fetch_now", arguments: "{}" }]), "Reading your connected sources…");
  assert.equal(statusFor([{ name: "hub_something_else", arguments: "{}" }]), "Working…");
});
