/**
 * The rules an attached file meets on the computer (evidence/files.ts, limits.ts): a link to a key,
 * a hard link, a credential file, a file swapped between the check and the open, a file holding a saved
 * secret and one past its size limit are refused; a file outside the run's evidence folder is copied in
 * exactly as checked. No database: the rows go to an in-memory stand-in.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const root = mkdtempSync(join(tmpdir(), "ensemble-evidence-"));
process.env.DATABASE_URL ??= "postgresql://localhost/unused";
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "data");
const { attachEvidence, evidenceDir, readEvidenceFile, setSwapHookForTests, storedEvidence } = await import("./files.js");
const { credentialPathReason, evidenceLimit, isActiveMime, kindMismatch, sniffMime } = await import("./limits.js");
after(() => rmSync(root, { recursive: true, force: true }));

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ffff3f0005fe02fea7d6a4a40000000049454e44ae426082", "hex");
const home = join(root, "home");
const work = join(root, "work");
mkdirSync(join(home, ".ssh"), { recursive: true });
mkdirSync(work, { recursive: true });
writeFileSync(join(home, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n-----END OPENSSH PRIVATE KEY-----\n");
const read = (path: string, kind: "screenshot" | "log" | "file" = "screenshot", secrets: string[] = []) => readEvidenceFile(path, { kind, secrets, home });

/** Rows in memory, enough for attachEvidence and storedEvidence. */
function memoryDb() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    jobEvidence: {
      async count({ where }: { where: { jobId: string } }) {
        return rows.filter((row) => row.jobId === where.jobId).length;
      },
      async findFirst({ where }: { where: { jobId: string; storageKey: string } }) {
        return rows.find((row) => row.jobId === where.jobId && row.storageKey === where.storageKey) ?? null;
      },
      async create({ data }: { data: Record<string, unknown> }) {
        const row = { ...data, createdAt: new Date() };
        rows.push(row);
        return row;
      },
    },
    workspaceJob: { async findMany() { return []; } },
  };
}

test("a link to a key, a hard link and credential files are refused; a plain screenshot is read", async () => {
  writeFileSync(join(work, "shot.png"), PNG);
  const checked = await read(join(work, "shot.png"));
  assert.equal(checked.mime, "image/png");
  assert.equal(checked.size, PNG.length);
  assert.deepEqual(checked.bytes, PNG);

  symlinkSync(join(home, ".ssh", "id_ed25519"), join(work, "innocent.png"));
  await assert.rejects(read(join(work, "innocent.png")), /is a link/);
  // A folder link into ~/.ssh: the file opened is judged where it really is.
  symlinkSync(join(home, ".ssh"), join(work, "keys"));
  await assert.rejects(read(join(work, "keys", "id_ed25519"), "file"), /never attached/);

  writeFileSync(join(work, "a.png"), PNG);
  linkSync(join(work, "a.png"), join(work, "b.png"));
  await assert.rejects(read(join(work, "b.png")), /hard link/);

  for (const name of [".env", ".env.local", "deploy.pem", "server.key", "id_rsa.bak", ".bash_history", ".zsh_history"]) {
    writeFileSync(join(work, name), "x=1\n");
    await assert.rejects(read(join(work, name), "file"), /never attached/, name);
  }
  assert.equal(credentialPathReason("/repo/.ssh/notes.txt") !== null, true, "anything in a folder of keys");
  assert.equal(credentialPathReason("/repo/report.json"), null);
  assert.equal(credentialPathReason("C:\\Users\\me\\screens\\shot.png"), null);
});

test("a file swapped between the check and the open is refused", async () => {
  writeFileSync(join(work, "result.png"), PNG);
  writeFileSync(join(work, "other.png"), Buffer.concat([PNG, Buffer.from("tail")]));
  setSwapHookForTests(async (path) => {
    if (path.endsWith("result.png")) renameSync(join(work, "other.png"), path);
  });
  try {
    await assert.rejects(read(join(work, "result.png")), /changed while it was being checked/);
  } finally {
    setSwapHookForTests(null);
  }
  writeFileSync(join(work, "late.png"), PNG);
  setSwapHookForTests(async (path) => {
    if (!path.endsWith("late.png")) return;
    rmSync(path);
    symlinkSync(join(home, ".ssh", "id_ed25519"), path);
  });
  try {
    await assert.rejects(read(join(work, "late.png")), /link/);
  } finally {
    setSwapHookForTests(null);
  }
});

test("a file holding a saved secret, a file past its size and a kind that does not match are refused", async () => {
  writeFileSync(join(work, "run.log"), "calling the API with sk_live_example_value_123\n");
  await assert.rejects(read(join(work, "run.log"), "log", ["sk_live_example_value_123"]), /saved secret/);
  assert.equal((await read(join(work, "run.log"), "log", ["something-else"])).mime, "text/plain");

  writeFileSync(join(work, "big.png"), PNG);
  truncateSync(join(work, "big.png"), evidenceLimit("screenshot") + 1);
  await assert.rejects(read(join(work, "big.png")), /at most 100 MB/);

  writeFileSync(join(work, "notes.png"), "just text\n");
  await assert.rejects(read(join(work, "notes.png")), /must be an image/);
  assert.equal(kindMismatch("video", "video/mp4"), null);
  assert.equal(kindMismatch("report", "text/html"), null);
});

test("a file outside the run's evidence folder is copied in as checked, and read again only while unchanged", async () => {
  const db = memoryDb();
  const jobId = randomUUID();
  writeFileSync(join(work, "home-page.png"), PNG);
  const row = (await attachEvidence(db as never, { userId: "local", jobId, cwd: work, secrets: [] }, { path: "home-page.png", kind: "screenshot", caption: "The home page" })) as { storageKey: string; name: string; sha256: string; kind: string; jobId: string; caption: string };
  assert.equal(row.name, "home-page.png");
  assert.equal(row.caption, "The home page");
  const copy = join(evidenceDir(jobId), row.storageKey);
  assert.deepEqual(readFileSync(copy), PNG, "the copy is the checked bytes");
  // The same name again gets its own copy; the original stays where it was.
  const again = (await attachEvidence(db as never, { userId: "local", jobId, cwd: work, secrets: [] }, { path: join(work, "home-page.png"), kind: "screenshot" })) as { storageKey: string };
  assert.equal(again.storageKey, "home-page-2.png");
  assert.equal((await storedEvidence(row as never, [])).sha256, row.sha256);
  writeFileSync(copy, Buffer.concat([PNG, Buffer.from("changed")]));
  await assert.rejects(storedEvidence(row as never, []), /changed after it was attached/);
  // A file already in the evidence folder is recorded where it is.
  writeFileSync(join(evidenceDir(jobId), "trace.png"), PNG);
  const inPlace = (await attachEvidence(db as never, { userId: "local", jobId, cwd: work, secrets: [] }, { path: join(evidenceDir(jobId), "trace.png"), kind: "image" })) as { storageKey: string };
  assert.equal(inPlace.storageKey, "trace.png");
  assert.equal(db.rows.length, 3);
});

test("types come from the bytes, and active formats are marked", () => {
  assert.equal(sniffMime(PNG, "x.txt"), "image/png");
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), "image/jpeg");
  assert.equal(sniffMime(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"), "logo.png"), "image/svg+xml");
  assert.equal(sniffMime(Buffer.from("<!doctype html><title>x</title>"), "report.txt"), "text/html");
  assert.equal(sniffMime(Buffer.from("plain words then <script>alert(1)</script>"), "notes.txt"), "text/html");
  assert.equal(sniffMime(Buffer.from('{"passed": 3}'), "results.json"), "application/json");
  assert.equal(sniffMime(Buffer.from("console.log(1)"), "app.js"), "text/javascript");
  assert.equal(sniffMime(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42")])), "video/mp4");
  assert.equal(sniffMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2])), "application/zip");
  // ZIP and compound files inside: the name picks among their own types; other archives and audio by their bytes.
  assert.equal(sniffMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]), "Budget.XLSX"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(sniffMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]), "notes.txt"), "application/zip");
  assert.equal(sniffMime(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), "old.doc"), "application/msword");
  assert.equal(sniffMime(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4])), "application/x-7z-compressed");
  assert.equal(sniffMime(Buffer.concat([Buffer.from("ID3"), Buffer.from([4, 0, 0, 0])]), "song.mp3"), "audio/mpeg");
  assert.equal(sniffMime(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A ")])), "audio/mp4");
  for (const mime of ["text/html", "image/svg+xml", "application/xml", "text/javascript"]) assert.equal(isActiveMime(mime), true, mime);
  for (const mime of ["image/png", "text/plain", "application/json", "video/mp4"]) assert.equal(isActiveMime(mime), false, mime);
});
