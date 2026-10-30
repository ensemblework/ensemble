/**
 * Captures as evidence on the computer (evidence/captures.ts): what a browser or capture tool wrote is
 * read from its result and recorded as evidence of its work (a run's job, or a node's tool operation),
 * checked where it lies; a held capture stays held, a video's poster and preview are its variants, and a
 * file that fails the checks (a saved secret's value in it, outside the work's folder) is deleted.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const scratch = mkdtempSync(join(homedir(), ".ensemble-captures-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(scratch, "data");
process.env.DATABASE_URL ??= "postgresql://localhost/unused";
const { capturedFiles, recordCaptures, recordedNote } = await import("./captures.js");
const { evidenceDir, operationEvidenceDir, isNodeOperation } = await import("./files.js");
after(() => rmSync(scratch, { recursive: true, force: true }));

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ffff3f0005fe02fea7d6a4a40000000049454e44ae426082", "hex");
const WEBM = Buffer.concat([Buffer.from("1a45dfa3", "hex"), Buffer.alloc(60, 1)]);

/** A table of evidence rows in memory, as the computer's database keeps them. */
function evidenceTable() {
  const rows: Array<Record<string, unknown>> = [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key] === value);
  return {
    rows,
    jobEvidence: {
      count: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)).length,
      findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { jobId: null, nodeId: null, operation: null, held: false, holdReason: null, variantOf: null, variant: null, details: null, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
    },
  };
}

test("tool results name their files: a capture with a video's poster and preview, a recording, a download", () => {
  const video = { path: "/e/clip.webm", kind: "video", mime: "video/webm", size: 9, width: 1280, height: 720, durationMs: 2000, fps: 30, frames: 60, codec: "vp9", held: false, poster: { path: "/e/clip.poster.jpg", mime: "image/jpeg", size: 1, width: 1, height: 1 }, preview: { path: "/e/clip.preview.jpg", mime: "image/jpeg", size: 1, width: 1, height: 1 } };
  assert.deepEqual(capturedFiles(video), [
    { path: "/e/clip.webm", kind: "video", held: false, details: { width: 1280, height: 720, durationMs: 2000, fps: 30, frames: 60, codec: "vp9" }, variants: [{ path: "/e/clip.poster.jpg", variant: "poster" }, { path: "/e/clip.preview.jpg", variant: "preview" }] },
  ]);
  assert.equal(capturedFiles({ tab: "t1", recording: null, file: { path: "/e/t.zip", kind: "trace", mime: "application/zip", size: 3, held: true, reason: "It shows a key." } })[0]!.kind, "trace");
  assert.deepEqual(capturedFiles({ tab: "t1", path: "/e/report.pdf", name: "report.pdf", size: 3, mime: "application/pdf", url: "x" }), [{ path: "/e/report.pdf", kind: "report", held: false }]);
  assert.deepEqual(capturedFiles({ tab: "t1", url: "http://x/" }), [], "a result without a file");
  assert.equal(isNodeOperation("node:6f1c2b9e-0000-4000-8000-000000000001:conversation:room:shared"), true);
  assert.equal(isNodeOperation("node:../../etc:x"), false);
});

test("a run's captures are its evidence: kept, held, with variants; a file with a saved secret is deleted", async () => {
  const jobId = randomUUID();
  const dir = evidenceDir(jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "page.png"), PNG);
  writeFileSync(join(dir, "clip.webm"), WEBM);
  writeFileSync(join(dir, "clip.poster.png"), PNG);
  writeFileSync(join(dir, "secret.html"), "<p>sk_live_value_1234</p>");
  const table = evidenceTable();
  const recorded = await recordCaptures(
    table as never,
    { userId: "owner", jobId },
    [
      { path: join(dir, "page.png"), kind: "screenshot", held: false, details: { width: 1, height: 1 } },
      { path: join(dir, "clip.webm"), kind: "video", held: true, reason: "The owner asked to see captures of this site before they are sent.", variants: [{ path: join(dir, "clip.poster.png"), variant: "poster" }] },
      { path: join(dir, "secret.html"), kind: "report", held: false },
    ],
    ["sk_live_value_1234"],
  );
  const [page, clip, poster] = recorded.rows;
  assert.equal(recorded.rows.length, 3);
  assert.deepEqual([page!.kind, page!.storageKey, page!.held, page!.jobId], ["screenshot", "page.png", false, jobId]);
  assert.deepEqual([clip!.kind, clip!.held, clip!.holdReason], ["video", true, "The owner asked to see captures of this site before they are sent."]);
  assert.deepEqual([poster!.variantOf, poster!.variant, poster!.held], [clip!.id, "poster", true], "a held video's poster is held with it");
  assert.equal(recorded.refused.length, 1);
  assert.match(recorded.refused[0]!.reason, /saved secret/);
  assert.equal(existsSync(join(dir, "secret.html")), false, "a capture that fails the checks is not kept anywhere");
  const note = recordedNote(recorded);
  assert.match(note, new RegExp(`Kept as evidence: screenshot “page.png” \\[${page!.id}\\]`));
  assert.match(note, /Held for your owner to preview first/);
  assert.match(note, /Not kept: “secret.html”/);
  // Recording the same file again finds the same row.
  const again = await recordCaptures(table as never, { userId: "owner", jobId }, [{ path: join(dir, "page.png"), kind: "screenshot", held: false }], []);
  assert.equal(again.rows[0]!.id, page!.id);
});

test("a node's own captures belong to its tool operation; a file outside that folder is refused", async () => {
  const operation = "node:6f1c2b9e-0000-4000-8000-000000000002:conversation:room-1:shared";
  const dir = operationEvidenceDir(operation);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "localhost.png"), PNG);
  const elsewhere = join(scratch, "elsewhere.png");
  writeFileSync(elsewhere, PNG);
  const table = evidenceTable();
  const recorded = await recordCaptures(table as never, { userId: "owner", nodeId: "node-1", operation }, [{ path: join(dir, "localhost.png"), kind: "screenshot", held: false }, { path: elsewhere, kind: "screenshot", held: false }], []);
  assert.equal(recorded.rows.length, 1);
  assert.deepEqual([recorded.rows[0]!.jobId, recorded.rows[0]!.nodeId, recorded.rows[0]!.operation], [null, "node-1", operation]);
  assert.match(recorded.refused[0]!.reason, /not in this work's evidence folder/);
});
