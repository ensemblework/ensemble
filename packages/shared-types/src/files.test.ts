import assert from "node:assert/strict";
import test from "node:test";
import { fileTypeProblem } from "./files.js";

test("programs and raw binaries are refused; names that end in a domain are not", () => {
  for (const name of ["setup.exe", "Installer.MSI", "firmware.bin", "tool.dmg"]) assert.ok(fileTypeProblem(name), name);
  for (const name of ["Invoice from acme.com", "notes for my.app", "archive.zip", "Plan.md", "README"]) assert.equal(fileTypeProblem(name), null, name);
});

test("an import keeps a mail attachment its app could not type, but not a program", () => {
  assert.equal(fileTypeProblem("ATT00001.bin", { imported: true }), null);
  assert.ok(fileTypeProblem("ATT00001.bin"));
  assert.ok(fileTypeProblem("payload.exe", { imported: true }));
});
