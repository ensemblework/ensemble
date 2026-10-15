import assert from "node:assert/strict";
import test from "node:test";
import { isEmailAddress, passwordProblem, timeZoneName } from "./account.js";

test("a new password needs eight characters that are not just spaces at the ends", () => {
  assert.equal(passwordProblem("test-password-only-123"), null);
  assert.equal(passwordProblem("correct horse"), null);
  assert.equal(passwordProblem("  padded password  "), null);
  assert.match(passwordProblem("        ")!, /only spaces/);
  assert.match(passwordProblem("\t \n    ")!, /only spaces/);
  assert.match(passwordProblem("  abc   ")!, /not counting spaces/);
  assert.match(passwordProblem("short")!, /at least 8/);
  assert.match(passwordProblem("")!, /at least 8/);
  assert.match(passwordProblem("x".repeat(257))!, /at most 256/);
});

test("emails need one @, no spaces and a dot in the domain", () => {
  for (const good of ["mira@fieldnote.example", "you@ensemble.local", " ben.okafor+work@example.co.uk "]) assert.equal(isEmailAddress(good), true, good);
  for (const bad of ["", "mira", "mira@", "@example.com", "mira@example", "mira@@example.com", "mira chen@example.com", "mira@.com", "mira@example..com"]) assert.equal(isEmailAddress(bad), false, bad);
});

test("time zones are IANA names, given back in their usual spelling", () => {
  assert.equal(timeZoneName("Europe/London"), "Europe/London");
  assert.equal(timeZoneName(" europe/london "), "Europe/London");
  assert.equal(timeZoneName("Asia/Kolkata"), "Asia/Kolkata", "an alias the browser knows by its older name stays as given");
  assert.equal(timeZoneName("America/New_York"), "America/New_York");
  assert.equal(timeZoneName("UTC"), "UTC");
  for (const bad of ["Mars/Olympus_1", "", "+05:30", "-0800", "Not a zone"]) assert.equal(timeZoneName(bad), null, bad);
});
