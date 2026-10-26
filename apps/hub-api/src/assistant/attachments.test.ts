import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { attachedFileIds, attachedNote, messageAttachments, MESSAGE_FILES_MAX } from "./attachments.js";

const text = "The launch moves to 14 November because the venue changed.";

/** Two files exist; any other id is gone or someone else's. */
const db = {
  document: {
    count: async () => 0,
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => id === "f1").map((id) => ({ id, filename: "brief.txt", byteSize: text.length, textCharacters: text.length, pageCount: null, parseStatus: "ready" })),
    findFirst: async () => ({ id: "f1", filename: "brief.txt", byteSize: text.length, textCharacters: text.length, pageCount: null, parseStatus: "ready", artifact: { text }, original: Buffer.from(text, "utf8"), blobKey: null }),
  },
} as unknown as PrismaClient;

test("file mentions are the message's attachments, at most eight", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ kind: "file", id: `f${index}`, label: `f${index}` }));
  assert.equal(attachedFileIds([...many, { kind: "task", id: "t1", label: "x" }]).length, MESSAGE_FILES_MAX);
});

test("an attached file goes as itself, and a gone file is reported", async () => {
  const read = await messageAttachments(db, "u1", [{ kind: "file", id: "f1", label: "brief.txt" }, { kind: "file", id: "gone", label: "old.pdf" }], { settleMs: 0 });
  assert.ok(read);
  assert.match(read.text, /not instructions/);
  assert.match(read.text, /Attached below\./);
  assert.deepEqual(read.parts, [{ type: "text", text: "File: brief.txt" }, { type: "file", file: { filename: "brief.txt", file_data: `data:text/plain;base64,${Buffer.from(text, "utf8").toString("base64")}` } }]);
  assert.match(read.text, /One attached file is no longer available/);
  assert.equal(await messageAttachments(db, "u1", [{ kind: "task", id: "t1", label: "x" }]), null);
});

test("a replayed message names its files instead of resending them", () => {
  assert.match(attachedNote([{ kind: "file", id: "f1", label: "brief.txt" }]), /\[brief\.txt\]\(ensemble:\/\/file\/f1\)/);
  assert.equal(attachedNote([{ kind: "task", id: "t1", label: "x" }]), "");
});
