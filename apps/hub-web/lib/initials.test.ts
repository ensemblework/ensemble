import assert from "node:assert/strict";
import test from "node:test";
import { distinctInitials, personInitials } from "./initials";

test("initials are the first character of the first and last words, digits included", () => {
  assert.equal(personInitials("Test One"), "TO");
  assert.equal(personInitials("Test 3"), "T3");
  assert.equal(personInitials("Test 4"), "T4");
  assert.equal(personInitials("Test Five"), "TF");
  assert.equal(personInitials("Test Six"), "TS");
  assert.equal(personInitials("Mira Chen Lopez"), "ML");
  assert.equal(personInitials("  akash   sharma "), "AS");
});

test("punctuation never becomes an initial, and accents stay whole", () => {
  assert.equal(personInitials("Mary-Jane O'Neil"), "MO");
  assert.equal(personInitials("Dr. Who"), "DW");
  assert.equal(personInitials("Émile Zola"), "ÉZ");
  assert.equal(personInitials("( ) Ben"), "BE");
});

test("one word gives its first two characters; no name falls back to the email", () => {
  assert.equal(personInitials("Akash"), "AK");
  assert.equal(personInitials("", "mira.chen@example.com"), "MC");
  assert.equal(personInitials(null, "ben_okafor+work@example.com"), "BO");
  assert.equal(personInitials(undefined, "ben2024@example.com"), "BE");
  assert.equal(personInitials("", ""), "");
});

test("people in one row keep their initials unless two different names would read the same", () => {
  assert.deepEqual(distinctInitials([{ name: "Test One" }, { name: "Test 3" }, { name: "Test Five" }, { name: "Test Six" }]), ["TO", "T3", "TF", "TS"]);
  assert.deepEqual(distinctInitials([{ name: "Test Two" }, { name: "Test Three" }, { name: "Mira Chen" }]), ["TTw", "TTh", "MC"]);
  assert.deepEqual(distinctInitials([{ name: "Test Two" }, { name: "Test Two" }]), ["TT", "TT"]);
  assert.deepEqual(distinctInitials([{ name: "Test", initials: "TE" }, { name: "Tess" }]), ["TE", "TE"]);
  assert.deepEqual(distinctInitials([{ name: "mira.chen", initials: "MC" }, { name: "Max Cole" }]), ["MC", "MCo"]);
});
