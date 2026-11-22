import assert from "node:assert/strict";
import test from "node:test";
import { indexEntries, nonIncreasing, videoInfo } from "./helpers.js";
import { MEETINGS, MEMORIES, NOTES } from "./hard.js";

test("indexEntries reads each title's count from its own line, in page order", () => {
  const titles = ["Amber ledger", "Birch outline", "Cobalt sketch", "Dune review"];
  const page = ["Notes index", "45 files in total.", "| # | Title | TODOs |", "| 1 | Amber ledger | 7 |", "| 2 | Cobalt sketch | 5 |", "3. Birch outline: 2 TODO markers", "0 · Dune review", "Amber ledger is the busiest."].join("\n");
  assert.deepEqual(indexEntries(page, titles), [
    { title: "Amber ledger", count: 7 },
    { title: "Cobalt sketch", count: 5 },
    { title: "Birch outline", count: 2 },
    { title: "Dune review", count: 0 },
  ]);
  assert.ok(nonIncreasing([7, 5, 5, 2, 0]));
  assert.ok(!nonIncreasing([7, 2, 5]));
});

test("videoInfo reads an MP4's length from mvhd and a WebM's from its Duration", () => {
  const mvhd = Buffer.alloc(32);
  mvhd.write("mvhd", 4, "ascii");
  mvhd.writeUInt32BE(1000, 4 + 16);
  mvhd.writeUInt32BE(2500, 4 + 20);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypisom"), Buffer.alloc(4), mvhd]);
  assert.deepEqual(videoInfo(mp4), { format: "mp4", durationMs: 2500 });
  const duration = Buffer.alloc(4);
  duration.writeFloatBE(3000);
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]), Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]), Buffer.from([0x44, 0x89, 0x84]), duration]);
  assert.deepEqual(videoInfo(webm), { format: "webm", durationMs: 3000 });
  assert.equal(videoInfo(Buffer.from("hello")), null);
});

test("the hard fixtures hold what their checks assume", () => {
  assert.equal(NOTES.length, 45);
  assert.equal(new Set(NOTES.map((note) => note.title)).size, 45);
  for (const note of NOTES) {
    assert.equal((note.body.match(/TODO/g) ?? []).length, note.todos, note.path);
    assert.equal(/^#{1,2} (.+)$/m.exec(note.body)?.[1], note.title, note.path);
    assert.ok(!/\d/.test(note.path), note.path);
  }
  assert.equal(MEMORIES.length, 60);
  assert.ok(MEMORIES.slice(-40).every((memory) => !/aisle|akasa|airline|seat/i.test(memory)));
  assert.equal(MEETINGS.length, 25);
  assert.equal(MEETINGS.filter((meeting) => meeting.decisions.some((line) => /chose postgres/i.test(line))).length, 1);
});
