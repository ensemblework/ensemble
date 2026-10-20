/**
 * Reading a run's folder for the person looking at it, the changed-file list a run reports, and the
 * relay that asks a paired computer for one folder or file: what is shown, what never is, and the caps.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentChanges, parseNumstat, parseRaw, parseStatus } from "./changed-files.js";
import { folderPath, listFolder, readFolderFile, refusedPath } from "./folder-read.js";

process.env.REDIS_URL ??= "memory://local";
const { changedFileUploads, uploadChangedFiles } = await import("../remote/files.js");
const { askDevice, storeAnswer } = await import("../devices/file-relay.js");
const { sseHub } = await import("../lib/sse.js");
const { memoryRedis } = await import("../lib/memory-redis.js");

function folder(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "run-folder-")));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  writeFileSync(join(root, "src", "app.ts"), "export const key = 'sk-abcdefghijklmnop12345';\n");
  writeFileSync(join(root, "usage.md"), "# Usage\n");
  writeFileSync(join(root, ".env"), "TOKEN=1\n");
  writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
  return root;
}

test("a folder lists folders first, never git's own folder or secrets files, and stays inside", async () => {
  const root = folder();
  const listing = await listFolder(root);
  assert.deepEqual(listing.entries.map((entry) => `${entry.kind}:${entry.name}`), ["dir:src", "file:logo.png", "file:usage.md"]);
  assert.equal(listing.hidden, 2, ".git and .env are left out");
  await assert.rejects(listFolder(root, ".git"), /Git's own files/);
  await assert.rejects(listFolder(root, "../"), /outside/);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
  writeFileSync(join(outside, "secret.txt"), "no");
  symlinkSync(outside, join(root, "escape"));
  await assert.rejects(readFolderFile(root, "escape/secret.txt"), /outside|link/);
});

test("a file is text, redacted and capped; binaries and secrets files have no content", async () => {
  const root = folder();
  const app = await readFolderFile(root, "src/app.ts");
  assert.equal(app.binary, false);
  assert.doesNotMatch(app.content ?? "", /sk-abcdefghijklmnop12345/, "known secret shapes are redacted");
  const png = await readFolderFile(root, "logo.png");
  assert.equal(png.binary, true);
  assert.equal(png.content, null);
  await assert.rejects(readFolderFile(root, ".env"), /keys or secrets/);
  await assert.rejects(readFolderFile(root, ".git/config"), /Git's own files/);
  writeFileSync(join(root, "big.txt"), "x".repeat(2000));
  const big = await readFolderFile(root, "big.txt", 100);
  assert.equal(big.content?.length, 100);
  assert.equal(big.truncated, true);
  assert.equal(folderPath("./src//app.ts"), "src/app.ts");
  assert.equal(refusedPath("deploy/id_rsa"), "Files that hold keys or secrets are not shown.");
  assert.equal(refusedPath("src/environment.ts"), null);
  for (const sneaky of [".GIT/config", ".git./config", "sub/.Git /hooks/pre-commit", ".ENV", ".env.", "notes.txt:hidden", "a/../../etc/passwd"]) {
    assert.notEqual(refusedPath(sneaky), null, sneaky);
  }
});

test("links and hard links never reach git's files, secrets or anything outside", async () => {
  const root = folder();
  symlinkSync(".env", join(root, "notes.md"));
  symlinkSync(".git", join(root, "g"));
  linkSync(join(root, ".env"), join(root, "copy.txt"));
  mkdirSync(join(root, ".ssh"));
  writeFileSync(join(root, ".ssh", "config"), "Host x\n");
  writeFileSync(join(root, ".envrc"), "export A=1\n");
  writeFileSync(join(root, "prod.env"), "A=1\n");
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
  symlinkSync(outside, join(root, "elsewhere"));
  symlinkSync("src", join(root, "source"));
  await assert.rejects(readFolderFile(root, "notes.md"), /keys or secrets/, "a link to .env is .env");
  await assert.rejects(listFolder(root, "g"), /Git's own files/, "a link to .git is .git");
  await assert.rejects(readFolderFile(root, "g/config"), /Git's own files/);
  await assert.rejects(readFolderFile(root, "copy.txt"), /hard link/);
  await assert.rejects(readFolderFile(root, ".ssh/config"), /keys and sign-ins/);
  await assert.rejects(readFolderFile(root, ".envrc"), /keys or secrets/);
  await assert.rejects(readFolderFile(root, "prod.env"), /keys or secrets/);
  const listing = await listFolder(root);
  const shown = Object.fromEntries(listing.entries.map((entry) => [entry.name, entry.kind]));
  assert.equal(shown["notes.md"], undefined, "a link to a secrets file is hidden");
  assert.equal(shown["g"], undefined);
  assert.equal(shown[".ssh"], undefined);
  assert.equal(shown["elsewhere"], "link", "a link outside is shown as a link, not opened");
  assert.equal(shown["source"], "dir", "a link to a folder inside opens as a folder");
  assert.equal((await readFolderFile(root, "source/app.ts")).binary, false);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
}

function snapshot(root: string): string {
  const index = join(root, "..", `index-${Math.random()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync("git", ["read-tree", "HEAD"], { cwd: root, env });
  execFileSync("git", ["add", "-A"], { cwd: root, env, stdio: "ignore" });
  return execFileSync("git", ["write-tree"], { cwd: root, env, encoding: "utf8" }).trim();
}

test("a run's changes: files it wrote, not a repository it cloned, but its edits inside one", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "changes-")));
  const upstream = join(base, "upstream");
  mkdirSync(upstream);
  git(upstream, "init", "-q");
  writeFileSync(join(upstream, "README.md"), "hello\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", "init");
  const root = join(base, "run");
  mkdirSync(root);
  git(root, "init", "-q");
  writeFileSync(join(root, "old.txt"), "one\ntwo\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "start");
  const start = snapshot(root);
  // The run: writes usage.md, edits old.txt, clones a repository and edits a file inside it.
  writeFileSync(join(root, "usage.md"), "a\nb\nc\n");
  writeFileSync(join(root, "old.txt"), "one\n");
  git(root, "clone", "-q", upstream, "rea");
  writeFileSync(join(root, "rea", "README.md"), "hello\nworld\n");
  writeFileSync(join(root, "rea", "NOTES.md"), "n\n");
  const end = snapshot(root);
  const run = async (args: string[], cwd: string) => {
    try {
      return { exitCode: 0, output: execFileSync("git", args, { cwd, encoding: "utf8" }) };
    } catch (error) {
      return { exitCode: 1, output: String((error as Error).message) };
    }
  };
  const { files, nested } = await agentChanges(run, root, start, end);
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
  assert.deepEqual(nested, ["rea"]);
  assert.equal(byPath["rea"], undefined, "the clone itself is not a change");
  assert.deepEqual([byPath["usage.md"]?.status, byPath["usage.md"]?.added], ["added", 3]);
  assert.deepEqual([byPath["old.txt"]?.status, byPath["old.txt"]?.removed], ["modified", 1]);
  assert.deepEqual([byPath["rea/README.md"]?.status, byPath["rea/README.md"]?.added], ["modified", 1]);
  assert.deepEqual([byPath["rea/NOTES.md"]?.status, byPath["rea/NOTES.md"]?.added], ["added", 1]);

  // What a computer sends when the run ends: the text of what it wrote, nothing for secrets files.
  writeFileSync(join(root, ".env"), "TOKEN=1\n");
  const uploads = await changedFileUploads(root, { files: [...files, { path: ".env", status: "added" }, { path: "gone.txt", status: "deleted" }] });
  const sent = Object.fromEntries(uploads.map((file) => [file.path, file]));
  assert.equal(sent["usage.md"]?.content, "a\nb\nc\n");
  assert.equal(sent["rea/NOTES.md"]?.content, "n\n");
  assert.equal(sent[".env"]?.content, null);
  assert.match(sent[".env"]?.skipped ?? "", /secrets/);
  assert.equal(sent["gone.txt"]?.content, null);
});

test("a computer sends no file text to a server that keeps none (Ensemble on the web)", async () => {
  let calls = 0;
  const client = { uploadFiles: async () => void (calls += 1) } as unknown as Parameters<typeof uploadChangedFiles>[0];
  const job = { hostedId: "job", leaseToken: "lease", protocol: 4, keepsFileText: false } as unknown as Parameters<typeof uploadChangedFiles>[1];
  await uploadChangedFiles(client, job, {} as Parameters<typeof uploadChangedFiles>[2]);
  assert.equal(calls, 0);
});

test("a rename is a deletion and an addition; a clone whose git config runs programs is not read; links do not hang the count", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "changes-edge-")));
  const root = join(base, "run");
  mkdirSync(root);
  git(root, "init", "-q");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "start");
  const start = snapshot(root);
  execFileSync("git", ["mv", "a.txt", "z.txt"], { cwd: root });
  writeFileSync(join(root, "b.txt"), "b\n");
  writeFileSync(join(root, "c.txt"), "c\n");
  const nested = join(root, "evil");
  mkdirSync(nested);
  git(nested, "init", "-q");
  writeFileSync(join(nested, "x.txt"), "x\n");
  git(nested, "add", "-A");
  git(nested, "commit", "-qm", "x");
  writeFileSync(join(nested, ".git", "config"), "[core]\n\tbare = false\n[filter \"lfs\"]\n\tclean = touch /tmp/pwned\n");
  writeFileSync(join(nested, "y.txt"), "y\n");
  const quiet = join(root, "quiet");
  mkdirSync(quiet);
  git(quiet, "init", "-q");
  writeFileSync(join(quiet, "q.txt"), "q\n");
  git(quiet, "add", "-A");
  git(quiet, "commit", "-qm", "q");
  symlinkSync("/dev/zero", join(quiet, "zero"));
  const end = snapshot(root);
  const run = async (args: string[], cwd: string) => {
    try {
      return { exitCode: 0, output: execFileSync("git", args, { cwd, encoding: "utf8" }) };
    } catch (error) {
      return { exitCode: 1, output: String((error as Error).message) };
    }
  };
  const { files } = await agentChanges(run, root, start, end);
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.status]));
  assert.deepEqual([byPath["a.txt"], byPath["z.txt"], byPath["b.txt"], byPath["c.txt"]], ["deleted", "added", "added", "added"]);
  assert.equal(Object.keys(byPath).some((path) => path.startsWith("evil/")), false, "a clone with a filter in its config is not read");
  assert.equal(byPath["quiet/zero"], "added", "a link to /dev/zero is listed without reading it");
});

test("git's machine output is read as written", () => {
  assert.deepEqual(parseRaw(":000000 100644 0000000 abc1234 A\0new file.md\0:160000 160000 1111111 2222222 M\0rea\0"), [
    { oldMode: "000000", newMode: "100644", status: "A", path: "new file.md" },
    { oldMode: "160000", newMode: "160000", status: "M", path: "rea" },
  ]);
  assert.deepEqual([...parseNumstat("3\t0\tusage.md\0-\t-\tlogo.png\0").entries()], [
    ["usage.md", { added: 3, removed: 0, binary: false }],
    ["logo.png", { added: 0, removed: 0, binary: true }],
  ]);
  assert.deepEqual(parseStatus(" M README.md\0?? NOTES.md\0"), [
    { code: " M", path: "README.md" },
    { code: "??", path: "NOTES.md" },
  ]);
});

test("the relay sends files.request to the device's stream and returns its answer; others' answers are refused", async () => {
  const redis = memoryRedis() as unknown as import("ioredis").Redis;
  const frames: Array<{ userId: string; event: string; data: Record<string, unknown> }> = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    frames.push({ userId, event: frame.event, data: frame.data as Record<string, unknown> });
    const data = frame.data as { id: string; kind: string; path: string };
    if (frame.event !== "files.request") return;
    setTimeout(() => {
      void storeAnswer(redis, "other-device", data.id, { error: "not mine" }).then((result) => assert.equal(result, "unknown"));
      void storeAnswer(redis, "device-1", data.id, { file: { path: data.path, size: 3, content: "hi\n", binary: false, truncated: false } });
    }, 20);
  });
  try {
    const answer = await askDevice(redis, { deviceId: "device-1", hostedJobId: "job-1", kind: "file", path: "usage.md" }, 3000);
    assert.equal(answer?.file?.content, "hi\n");
    assert.deepEqual(frames.map((frame) => [frame.userId, frame.event, frame.data.jobId, frame.data.kind]), [["device:device-1", "files.request", "job-1", "file"]]);
    const silent = await askDevice(redis, { deviceId: "device-2", hostedJobId: "job-2", kind: "tree", path: "" }, 300);
    assert.equal(silent, null, "no answer in time");
    assert.equal(await storeAnswer(redis, "device-1", "never-asked", { error: "x" }), "unknown");
  } finally {
    stop();
  }
});
