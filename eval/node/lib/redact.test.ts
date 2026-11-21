import assert from "node:assert/strict";
import test from "node:test";
import { cut, redactor } from "./redact.js";

test("redacts keys, tokens, cookies and assignments, keeping the name", () => {
  const { text } = redactor({}, "/home/mira");
  const out = text("key sk-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz1234 Bearer abcdefghijklmnop.qrstu cookie ensemble_session=s3cr3tvalue; password: hunter2hunter2");
  assert.ok(!/sk-abc|ghp_abc|abcdefghijklmnop\.qrstu|s3cr3t|hunter2/.test(out), out);
  assert.match(out, /password: \[redacted\]/);
  assert.match(out, /\[redacted\]/);
});

test("names the home and scratch folders by placeholders, the longest first", () => {
  const { text } = redactor({ "/home/mira/work/run-1": "<work>" }, "/home/mira");
  assert.equal(text("/home/mira/work/run-1/tasks/a and /home/mira/.copilot"), "<work>/tasks/a and ~/.copilot");
});

test("deep redaction walks objects and arrays and cuts long strings", () => {
  const { deep } = redactor({}, "/home/mira");
  const out = deep({ list: ["x".repeat(100), { token: "token=abcdefghij" }], n: 3 }, 60);
  assert.equal(out.n, 3);
  assert.ok((out.list[0] as string).length < 100);
  assert.deepEqual(out.list[1], { token: "token=[redacted]" });
});

test("cut keeps short text and says how much it left out", () => {
  assert.equal(cut("short", 10), "short");
  assert.match(cut("a".repeat(200), 100), /\[… 140 more characters\]$/);
});
