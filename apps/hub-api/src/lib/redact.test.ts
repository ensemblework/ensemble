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

test("cloud keys, private keys, JWTs, URL passwords and .env secret lines are redacted; plain text stays", () => {
  const text = [
    "aws AKIAABCDEFGHIJKLMNOP done",
    "stripe sk_live_abcdefghijklmnop and rk_test_abcdefghijklmnop",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrst",
    "remote https://akash:hunter2secret@github.com/a/b.git",
    "API_KEY=abcd1234efgh",
    "export DB_PASSWORD='p4ssw0rd!'",
    "client_secret: s3cr3tvalue",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
    "TIMEOUT=30 and the README says hello",
  ].join("\n");
  const out = redactText(text);
  for (const secret of ["AKIAABCDEFGHIJKLMNOP", "sk_live_abcdefghijklmnop", "rk_test_abcdefghijklmnop", "eyJhbGciOiJIUzI1NiJ9", "hunter2secret", "abcd1234efgh", "p4ssw0rd!", "s3cr3tvalue", "b3BlbnNzaC1rZXktdjEAAAAA"]) {
    assert.equal(out.includes(secret), false, secret);
  }
  assert.match(out, /https:\/\/akash:\[redacted\]@github\.com/);
  assert.match(out, /API_KEY=\[redacted\]/);
  assert.match(out, /TIMEOUT=30 and the README says hello/);
});

