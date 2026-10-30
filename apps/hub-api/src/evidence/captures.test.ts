/**
 * Captures as evidence on the computer (evidence/captures.ts): what a browser or capture tool wrote is
 * read from its result and recorded as evidence of its work (a run's job, or a node's tool operation),
 * checked where it lies; a held capture stays held, a video's poster and preview are its variants, and a
 * file that fails the checks (a saved secret's value in it, outside the work's folder) is deleted.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const scratch = mkdtempSync(join(homedir(), ".ensemble-captures-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(scratch, "data");
process.env.DATABASE_URL ??= "postgresql://localhost/unused";
const { capturedFiles, recordCaptures, recordedNote, sweepOperationFolders } = await import("./captures.js");
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

/** Evidence rows that answer the filters the brake and the sweep use (a date from, a list, not null). */
function filteredTable(rows: Array<Record<string, unknown>>) {
  const fits = (value: unknown, want: unknown) => {
    if (want && typeof want === "object" && !(want instanceof Date)) {
      const rule = want as { gte?: Date; in?: unknown[]; not?: unknown };
      if (rule.gte) return value instanceof Date && value >= rule.gte;
      if (rule.in) return rule.in.includes(value);
      if ("not" in rule) return value !== rule.not;
    }
    return value === want;
  };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) => Object.entries(where).every(([key, want]) => fits(row[key], want));
  return {
    rows,
    jobEvidence: {
      count: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)).length,
      findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { jobId: null, nodeId: null, operation: null, held: false, variantOf: null, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const gone = rows.filter((row) => matches(row, where));
        for (const row of gone) rows.splice(rows.indexOf(row), 1);
        return { count: gone.length };
      },
    },
  };
}

test("a node's one operation brakes on the files of its last day only, and loses files older than 30 days while it stays in use", async () => {
  const operation = "node:6f1c2b9e-0000-4000-8000-000000000003:own";
  const dir = operationEvidenceDir(operation);
  mkdirSync(dir, { recursive: true });
  const day = 86_400_000;
  const old = Array.from({ length: 100 }, (_, index) => ({ id: randomUUID(), operation, nodeId: "node-1", jobId: null, storageKey: `old-${index}.png`, createdAt: new Date(Date.now() - 2 * day) }));
  const table = filteredTable([...old]);
  writeFileSync(join(dir, "today.png"), PNG);
  const recorded = await recordCaptures(table as never, { userId: "owner", nodeId: "node-1", operation }, [{ path: join(dir, "today.png"), kind: "screenshot", held: false }], []);
  assert.equal(recorded.rows.length, 1, "a hundred files from before today do not stop it");
  for (let index = 0; index < 99; index += 1) table.rows.push({ id: randomUUID(), operation, nodeId: "node-1", jobId: null, storageKey: `new-${index}.png`, createdAt: new Date() });
  writeFileSync(join(dir, "more.png"), PNG);
  const braked = await recordCaptures(table as never, { userId: "owner", nodeId: "node-1", operation }, [{ path: join(dir, "more.png"), kind: "screenshot", held: false }], []);
  assert.equal(braked.rows.length, 0);
  assert.match(braked.refused[0]!.reason, /A node keeps at most 100 new files a day/);

  // The folder is in use (today.png), so it stays; a file from 31 days ago goes, with its row.
  writeFileSync(join(dir, "old-0.png"), PNG);
  const longAgo = new Date(Date.now() - 31 * day);
  utimesSync(join(dir, "old-0.png"), longAgo, longAgo);
  assert.equal(await sweepOperationFolders(table as never), 0, "no folder removed");
  assert.equal(existsSync(join(dir, "old-0.png")), false);
  assert.equal(existsSync(join(dir, "today.png")), true);
  assert.equal(table.rows.some((row) => row.storageKey === "old-0.png"), false);
  assert.equal(table.rows.some((row) => row.storageKey === "today.png"), true);
});
