import assert from "node:assert/strict";
import test from "node:test";
import { redactRequestUrl, redactText } from "./redact.js";

test("event tickets and oauth codes are not logged in the url", () => {
  assert.equal(redactRequestUrl("/api/events?ticket=abc123"), "/api/events?ticket=[redacted]");
  assert.equal(
    redactRequestUrl("/api/connectors/google/callback?code=secret-code&state=ok"),
    "/api/connectors/google/callback?code=[redacted]&state=ok",
  );
});

test("bearer tokens, internal tokens, and shaped keys are redacted", () => {
  const line = redactText('failed Authorization: Bearer ens_abc12345 and x-ensemble-internal: dev-internal-token sk-livekeyvalue AIzaSyabcdefghijklmnopqrstuvwxyz12');
  assert.equal(line.includes("ens_abc12345"), false);
  assert.equal(line.includes("dev-internal-token"), false);
  assert.equal(line.includes("sk-livekeyvalue"), false);
  assert.equal(line.includes("AIzaSyabcdefghijklmnopqrstuvwxyz12"), false);
  assert.match(line, /Bearer \[redacted\]/);
  assert.match(line, /x-ensemble-internal: \[redacted\]/);
});
