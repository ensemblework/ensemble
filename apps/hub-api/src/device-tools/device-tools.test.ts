/**
 * A node's tools on this computer (device-tools/*): the policy (first use per folder asks once,
 * answers for once, this mission or always, unattended runs, a weak sandbox asks per mission), the
 * hard floor, loopback-only http with every redirect checked, file changes that never follow a link,
 * and commands: output inline or streamed, a long one in the background with a wake-up at its end,
 * named secrets in that command only and redacted, and the OS sandbox keeping keys, Ensemble's data
 * and the browser profile out of reach. The home folder is a stand-in, so no real key is ever read.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// A stand-in home folder outside Ensemble's own checkout, holding a fake key; everything else lives in it.
const base = mkdtempSync(join(homedir(), ".ensemble-node-tools-"));
const home = join(base, "home");
const data = join(home, ".local", "share", "com.ensemblework.cli.testing");
const work = join(home, "projects", "app");
mkdirSync(join(home, ".ssh"), { recursive: true });
mkdirSync(join(data, "browser"), { recursive: true });
mkdirSync(join(data, "pglite"), { recursive: true });
mkdirSync(work, { recursive: true });
writeFileSync(join(home, ".ssh", "id_ed25519"), "FAKE-KEY-FOR-THE-TEST\n");
writeFileSync(join(data, "browser", "Cookies"), "FAKE-COOKIE-FOR-THE-TEST\n");
writeFileSync(join(data, "pglite", "base"), "FAKE-DATABASE-FOR-THE-TEST\n");
writeFileSync(join(work, "package.json"), "{}\n");
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DATABASE_URL ??= "postgresql://localhost/unused";
process.env.ENSEMBLE_REMOTE_STATE_DIR = data;
process.env.ENSEMBLE_DATA_DIR = join(data, "pglite");
process.env.ENSEMBLE_WORKSPACE_ROOT = join(home, "ensemble-workspace");
process.env.ENSEMBLE_SECRET_KEY = randomBytes(32).toString("base64");

const { decide } = await import("./policy.js");
const { checkTarget, fetchLoopback, loopbackAddress, publicAddress, publicWebAddress, setResolverForTests } = await import("./http.js");
const { gitArgv } = await import("./git.js");
const { runNodeFiles } = await import("./files.js");
const { runNodeCommand, setForegroundMsForTests } = await import("./run.js");
const { deviceCodesIn, DeviceCodeWatch } = await import("./device-codes.js");
const { loopbackReturn, setCliPageOpenerForTests } = await import("./cli-logins.js");
const { nodeToolAnswerFor } = await import("./answer.js");
const { nodeToolDenies, ownToolFolder, resolveToolFolder } = await import("./folders.js");
const { shareKind } = await import("./share.js");
const { archiveProblem, crc32, zipEntries, ZipWriter } = await import("./zip.js");
const { sniffMime } = await import("../evidence/limits.js");
const { updateSettings } = await import("../remote/store.js");
const { encrypt } = await import("../lib/secrets.js");
const { setLocalPort } = await import("../workspace/engines/registry.js");
const { prepareSandbox } = await import("../workspace/sandbox/spawn.js");
const { runCommand } = await import("../workspace/runner.js");
const { rememberSecretValues } = await import("../lib/redact.js");

after(() => rmSync(base, { recursive: true, force: true }));

/** The rules table and secrets in memory, as the policy and the command runner use them. */
function memoryDb(secrets: Record<string, string> = {}) {
  const rules: Array<{ userId: string; source: string; toolName: string; pattern: string; decision: string; sessionId: string | null }> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const matches = (rule: (typeof rules)[number], where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => (rule as Record<string, unknown>)[key] === value);
  return {
    rules,
    decisionRule: {
      async findFirst({ where }: { where: Record<string, unknown> }) {
        return rules.find((rule) => matches(rule, where)) ?? null;
      },
      async findMany({ where }: { where: Record<string, unknown> }) {
        return rules.filter((rule) => matches(rule, where));
      },
      async create({ data: row }: { data: (typeof rules)[number] }) {
        rules.push({ ...row, sessionId: row.sessionId ?? null });
        return row;
      },
    },
    runSecret: {
      async findMany() {
        return Object.entries(secrets).map(([name, value]) => ({ name, value: encrypt(value) }));
      },
    },
    auditLedger: {},
    evidence,
    jobEvidence: {
      count: async ({ where }: { where: Record<string, unknown> }) => evidence.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)).length,
      findFirst: async ({ where }: { where: Record<string, unknown> }) => evidence.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null,
      create: async ({ data: row }: { data: Record<string, unknown> }) => {
        const full = { jobId: null, nodeId: null, operation: null, held: false, holdReason: null, variantOf: null, variant: null, details: null, caption: null, requirementId: null, createdAt: new Date(), ...row };
        evidence.push(full);
        return full;
      },
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
  };
}

/** A computer's client that records what it sends back; `files` are what the web hands out by download id. */
function fakeClient(files: Record<string, Uint8Array> = {}) {
  const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
  const chunks: Array<{ seq: number; text: string; done: boolean; exitCode: number | null; wake?: boolean }> = [];
  const uploads: Array<{ uploadId: string; meta: Record<string, unknown>; bytes: Uint8Array }> = [];
  const downloads: string[] = [];
  const codes: Array<Record<string, unknown>> = [];
  return {
    answers,
    chunks,
    uploads,
    downloads,
    output: () => chunks.map((chunk) => chunk.text).join(""),
    client: {
      async uploadEvidenceFile(uploadId: string, meta: Record<string, unknown>, bytes: Uint8Array) {
        uploads.push({ uploadId, meta, bytes });
        return { result: "stored" as const };
      },
      async downloadNodeFile(downloadId: string) {
        downloads.push(downloadId);
        const bytes = files[downloadId];
        if (!bytes) throw new Error("Nobody asked this computer for that file.");
        return bytes;
      },
      async toolOutput(_runId: string, chunk: (typeof chunks)[number]) {
        chunks.push(chunk);
        return true;
      },
      async answerCode(_id: string, answer: { status: number; body?: unknown }) {
        answers.push({ status: answer.status, body: (answer.body ?? {}) as Record<string, unknown> });
      },
      async nodeDeviceCode(body: Record<string, unknown>) {
        codes.push(body);
        return true;
      },
    },
    codes,
  };
}

const target = { capability: "git" as const, target: work, label: "app", scope: "folder" as const };

test("attended, the first use of a folder asks; an answer covers once, the mission or always; unattended runs", async () => {
  const db = memoryDb();
  const ask = await decide(db as never, "local", { ...target, mission: "m1", attended: true, grants: [] }, { weak: false, acceptWeb: true });
  assert.equal(ask.kind, "ask");
  // Once: this call only, nothing kept.
  const once = await decide(db as never, "local", { ...target, mission: "m1", attended: true, grants: [{ id: "d1", scope: "once", target: work }] }, { weak: false, acceptWeb: true });
  assert.deepEqual(once, { kind: "allow", grantsUsed: ["d1"] });
  assert.equal(db.rules.length, 0);
  assert.equal((await decide(db as never, "local", { ...target, mission: "m1", attended: true, grants: [] }, { weak: false, acceptWeb: true })).kind, "ask");
  // This mission: kept for m1 only.
  await decide(db as never, "local", { ...target, mission: "m1", attended: true, grants: [{ id: "d2", scope: "mission", target: work }] }, { weak: false, acceptWeb: true });
  assert.equal((await decide(db as never, "local", { ...target, mission: "m1", attended: true, grants: [] }, { weak: false, acceptWeb: true })).kind, "allow");
  assert.equal((await decide(db as never, "local", { ...target, mission: "m2", attended: true, grants: [] }, { weak: false, acceptWeb: true })).kind, "ask");
  // An answer for another folder is not used here.
  const elsewhere = await decide(db as never, "local", { ...target, mission: "m2", attended: true, grants: [{ id: "d3", scope: "always", target: "/other" }] }, { weak: false, acceptWeb: true });
  assert.equal(elsewhere.kind, "ask");
  assert.deepEqual(elsewhere.grantsUsed, []);
  // Always: every mission, every tool in the folder.
  await decide(db as never, "local", { ...target, mission: "m2", attended: true, grants: [{ id: "d4", scope: "always", target: work }] }, { weak: false, acceptWeb: true });
  assert.equal((await decide(db as never, "local", { ...target, capability: "run", mission: "m9", attended: true, grants: [] }, { weak: false, acceptWeb: true })).kind, "allow");
  // Unattended: runs without asking.
  assert.equal((await decide(memoryDb() as never, "local", { ...target, mission: "m1", attended: false, grants: [] }, { weak: false, acceptWeb: true })).kind, "allow");
});

test("with a weak sandbox, always does not cover commands: they ask once per mission", async () => {
  const db = memoryDb();
  const asked = await decide(db as never, "local", { ...target, capability: "run", mission: "m1", attended: true, grants: [] }, { weak: true, acceptWeb: true });
  assert.equal(asked.kind === "ask" && asked.ask.weak, true);
  await decide(db as never, "local", { ...target, capability: "run", mission: "m1", attended: true, grants: [{ id: "d1", scope: "always", target: work }] }, { weak: true, acceptWeb: true });
  assert.equal(db.rules[0]!.sessionId, "m1", "kept for the mission only");
  assert.equal((await decide(db as never, "local", { ...target, capability: "run", mission: "m2", attended: true, grants: [] }, { weak: true, acceptWeb: true })).kind, "ask");
  assert.equal((await decide(db as never, "local", { ...target, capability: "git", mission: "m2", attended: true, grants: [] }, { weak: true, acceptWeb: false })).kind, "refuse", "without web approvals nothing can be approved");
});

test("the hard floor: no home folder, no data folder, no link; a shared folder by its label", async () => {
  await assert.rejects(resolveToolFolder(home), /too broad/);
  await assert.rejects(resolveToolFolder(join(home, ".ssh")), /keys|settings/);
  await assert.rejects(resolveToolFolder(data), /off limits|Ensemble/);
  symlinkSync(work, join(home, "app-link"));
  await assert.rejects(resolveToolFolder(join(home, "app-link")), /link/);
  updateSettings({ folders: [{ label: "app", path: work, kind: "folder", access: "read-write" }] });
  assert.deepEqual(await resolveToolFolder("app"), { path: work, label: "app" });
  assert.deepEqual(await resolveToolFolder(work), { path: work, label: "~/projects/app" });
  const denies = await nodeToolDenies();
  for (const path of [join(home, ".ssh"), data]) assert.ok(denies.some((deny) => path.startsWith(deny) || deny.startsWith(path)), path);
});

test("computer_http reaches only this computer, and every redirect is checked", async () => {
  assert.equal(loopbackAddress("127.0.0.1"), true);
  assert.equal(loopbackAddress("127.8.0.1"), true);
  assert.equal(loopbackAddress("::1"), true);
  assert.equal(loopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(loopbackAddress("10.0.0.1"), false);
  assert.equal(loopbackAddress("::ffff:10.0.0.1"), false);
  setResolverForTests(async (host) => (host === "localhost" ? ["127.0.0.1", "::1"] : host === "rebind.test" ? ["127.0.0.1", "93.184.216.34"] : ["93.184.216.34"]));
  const servers: Server[] = [];
  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<number>((resolve) => {
      const server = createServer(handler);
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
  try {
    const app = await listen((request, response) => {
      if (request.url === "/away") return void response.writeHead(302, { location: "http://example.com/steal" }).end();
      if (request.url === "/home") return void response.writeHead(301, { location: `http://localhost:${appPort}/ok` }).end();
      response.writeHead(200, { "content-type": "text/plain" }).end(`ok ${request.method} token=ghp_abcdefghijklmnopqrstuvwxyz0123`);
    });
    const appPort = app;
    const ok = await fetchLoopback({ url: `http://127.0.0.1:${app}/ok`, method: "GET" });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /^ok GET/);
    assert.doesNotMatch(ok.body, /ghp_abcdefghijklmnopqrstuvwxyz0123/, "redacted");
    const followed = await fetchLoopback({ url: `http://127.0.0.1:${app}/home`, method: "GET" });
    assert.equal(followed.status, 200);
    assert.equal(followed.redirects, 1);
    await assert.rejects(fetchLoopback({ url: `http://127.0.0.1:${app}/away`, method: "GET" }), /redirect was refused.*93\.184\.216\.34/);
    await assert.rejects(checkTarget("http://example.com/"), /only development servers/);
    await assert.rejects(checkTarget("http://rebind.test/"), /only development servers/, "every address must be loopback");
    await assert.rejects(checkTarget("http://10.0.0.1/"), /only development servers/);
    await assert.rejects(checkTarget("file:///etc/passwd"), /http and https/);
    await assert.rejects(checkTarget("ftp://localhost/"), /http and https/);
    await assert.rejects(checkTarget(`http://me:pw@127.0.0.1:${app}/`), /user name or password/);
    setLocalPort(app);
    await assert.rejects(checkTarget(`http://localhost:${app}/api/settings`), /Ensemble's own local API/);
  } finally {
    setResolverForTests(null);
    for (const server of servers) server.close();
  }
});

test("computer_git reads only", () => {
  assert.deepEqual(gitArgv({ op: "status", args: [] }), ["git", "status", "--short", "--branch"]);
  assert.deepEqual(gitArgv({ op: "log", args: ["-n", "5"] }), ["git", "log", "--no-ext-diff", "--no-textconv", "-n", "5"]);
  assert.throws(() => gitArgv({ op: "diff", args: ["--output=/tmp/x"] }), /not a read/);
  assert.throws(() => gitArgv({ op: "diff", args: ["--no-index", "/etc/passwd", "/dev/null"] }), /not a read/);
  assert.throws(() => gitArgv({ op: "diff", args: ["--ext-diff"] }), /not a read/);
  assert.throws(() => gitArgv({ op: "branch", args: ["new-feature"] }), /only lists/);
});

test("file changes stay in the folder and never go through a link, a hard link or git's files", async () => {
  const folder = { path: work, label: "app" };
  const call = (action: "write" | "move" | "delete", path: string, extra: Record<string, unknown> = {}) =>
    runNodeFiles({ id: randomUUID(), tool: "files", action, folder: "app", path, nodeId: "n", mission: "m", attended: false, grants: [], ...extra } as never, folder);
  assert.equal((await call("write", "src/notes.md", { content: "# Notes\n" })).body.created, true);
  assert.equal(readFileSync(join(work, "src", "notes.md"), "utf8"), "# Notes\n");
  assert.equal((await call("write", "src/notes.md", { content: "# Notes v2\n" })).body.created, false);
  assert.equal(readFileSync(join(work, "src", "notes.md"), "utf8"), "# Notes v2\n");
  await assert.rejects(call("write", ".env", { content: "X=1" }), /secrets|never attached|keys/);
  await assert.rejects(call("write", ".git/config", { content: "[core]" }), /Git's own files/);
  await assert.rejects(call("write", "../escape.txt", { content: "x" }), /outside/);
  symlinkSync(join(home, ".ssh", "id_ed25519"), join(work, "key-link.txt"));
  await assert.rejects(call("write", "key-link.txt", { content: "overwritten" }), /link/);
  assert.equal(readFileSync(join(home, ".ssh", "id_ed25519"), "utf8"), "FAKE-KEY-FOR-THE-TEST\n", "the link's target is untouched");
  writeFileSync(join(home, "outside.txt"), "outside\n");
  linkSync(join(home, "outside.txt"), join(work, "hard.txt"));
  await assert.rejects(call("write", "hard.txt", { content: "x" }), /hard link/);
  assert.equal(readFileSync(join(home, "outside.txt"), "utf8"), "outside\n");
  assert.deepEqual((await call("move", "src/notes.md", { to: "docs/notes.md" })).body, { path: "src/notes.md", to: "docs/notes.md" });
  writeFileSync(join(work, "keep.md"), "keep\n");
  await assert.rejects(call("move", "docs/notes.md", { to: "keep.md" }), /never replaces/);
  await call("delete", "docs/notes.md");
  assert.equal(existsSync(join(work, "docs", "notes.md")), false);
  await assert.rejects(call("delete", "docs"), /not a file/);
});

test("a command answers inline, streams long output, goes on in the background and wakes its node at the end", async () => {
  const folder = { path: work, label: "app" };
  const db = memoryDb({ STRIPE_KEY: "sk_live_teststripevalue123" });
  const run = async (command: string, extra: Record<string, unknown> = {}) => {
    const fake = fakeClient();
    await runNodeCommand({ prisma: db } as never, fake.client as never, { id: randomUUID(), tool: "run", folder: "app", command, timeoutSec: 60, background: false, secrets: [], runId: randomUUID(), delivery: "local", network: false, nodeId: "n", mission: "m", attended: false, grants: [], ...extra } as never, folder, (answer) => fake.client.answerCode("x", answer));
    return fake;
  };
  const quick = await run(`node -e "console.log('hello from the node')"`);
  assert.deepEqual(quick.answers.map((row) => [row.status, row.body.exitCode, row.body.output]), [[200, 0, "hello from the node\n"]]);
  assert.equal(quick.chunks.length, 0, "a short output stays in the answer");

  // Named secrets reach that command only, and never come back as their values.
  const secret = await run(`node -e "console.log(process.env.STRIPE_KEY || 'none')"`, { secrets: ["STRIPE_KEY"] });
  assert.match(String(secret.answers[0]!.body.output), /\[redacted secret\]/);
  assert.doesNotMatch(String(secret.answers[0]!.body.output), /sk_live_teststripevalue123/);
  const without = await run(`node -e "console.log(process.env.STRIPE_KEY || 'none')"`);
  assert.equal(without.answers[0]!.body.output, "none\n");
  await assert.rejects(run(`node -e "1"`, { secrets: ["NOT_SAVED"] }), /not saved on this computer/);
  rememberSecretValues(["sk_live_teststripevalue123"]);

  const long = await run(`node -e "process.stdout.write('x'.repeat(100000) + 'END')"`);
  assert.equal(long.answers[0]!.status, 200);
  assert.equal(long.answers[0]!.body.clipped, true);
  assert.ok(Buffer.byteLength(String(long.answers[0]!.body.output)) <= 64 * 1024);
  assert.equal(long.chunks.at(-1)!.done, true);
  assert.equal(long.chunks.at(-1)!.wake, false, "the node already has the result");
  assert.ok(long.output().endsWith("END"), "the whole output is kept");

  setForegroundMsForTests(300);
  try {
    const slow = await run(`node -e "console.log('started'); setTimeout(() => console.log('finished'), 1200)"`);
    assert.equal(slow.answers[0]!.status, 202, "still going after the foreground time: it goes on in the background");
    assert.equal(slow.answers[0]!.body.background, true);
    const last = slow.chunks.at(-1)!;
    assert.deepEqual([last.done, last.exitCode, last.wake], [true, 0, true], "its end wakes the node, once");
    assert.equal(slow.chunks.filter((chunk) => chunk.done).length, 1);
    assert.match(slow.output(), /started[\s\S]*finished/);
  } finally {
    setForegroundMsForTests(null);
  }
  const background = await run(`node -e "setTimeout(() => console.log('served'), 200)"`, { background: true });
  assert.equal(background.answers[0]!.status, 202);
  assert.equal(background.chunks.at(-1)!.wake, true);
  await assert.rejects(run("sudo ls"), /not run by agents/);
  await assert.rejects(run("git push"), /may not push/, "the git ceiling of the node's run profile");
  await assert.rejects(run("git push", { delivery: "push" }), /sign-in/);
});

test("the policy is applied on the computer: asks first in attended mode, then runs with the owner's answer", async () => {
  updateSettings({ acceptWebApprovals: true, folders: [{ label: "app", path: work, kind: "folder", access: "read-write" }] });
  const db = memoryDb();
  const call = async (extra: Record<string, unknown>) => {
    const fake = fakeClient();
    const request = { id: randomUUID(), tool: "git", folder: "app", op: "status", args: [], nodeId: "n", mission: "m1", attended: true, grants: [], ...extra };
    await nodeToolAnswerFor({ prisma: db } as never, fake.client as never, request as never, (reply) => fake.client.answerCode("x", reply));
    return fake.answers[0]!;
  };
  const first = await call({});
  assert.equal(first.status, 428);
  assert.deepEqual((first.body.ask as Record<string, unknown>).target, work);
  const granted = await call({ grants: [{ id: "decision-1", scope: "mission", target: work }] });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.deepEqual(granted.body.grantsUsed, ["decision-1"]);
  assert.equal((await call({})).status, 200, "the mission's answer is kept here");
  assert.equal((await call({ folder: home })).status, 403, "the hard floor needs no answer: it is refused");
  assert.equal((await call({ tool: "http", url: "http://10.0.0.1/", method: "GET" })).status, 403);
});

test("under the OS sandbox a node's command cannot read keys, Ensemble's data or the browser profile", { timeout: 120_000 }, async (t) => {
  const caps = await prepareSandbox();
  if (!caps.osSandbox) return t.skip(`no OS sandbox here: ${caps.reason}`);
  const folder = { path: work, label: "app" };
  const db = memoryDb();
  writeFileSync(join(work, "visible.txt"), "inside the folder\n");
  const cat = async (path: string) => {
    const fake = fakeClient();
    await runNodeCommand({ prisma: db } as never, fake.client as never, { id: randomUUID(), tool: "run", folder: "app", command: `cat ${path}`, timeoutSec: 30, background: false, secrets: [], runId: randomUUID(), delivery: "local", network: false, nodeId: "n", mission: "m", attended: false, grants: [] } as never, folder, (answer) => fake.client.answerCode("x", answer));
    return fake.answers[0]!.body as { exitCode: number; output: string };
  };
  assert.equal((await cat("visible.txt")).exitCode, 0);
  for (const path of [join(home, ".ssh", "id_ed25519"), join(data, "browser", "Cookies"), join(data, "pglite", "base")]) {
    const result = await cat(path);
    assert.notEqual(result.exitCode, 0, path);
    assert.doesNotMatch(result.output, /FAKE-(KEY|COOKIE|DATABASE)-FOR-THE-TEST/, path);
  }
  // A denied place inside a granted folder stays closed too.
  mkdirSync(join(work, "closed"), { recursive: true });
  writeFileSync(join(work, "closed", "secret.txt"), "FAKE-CLOSED-FOR-THE-TEST\n");
  const closed = await runCommand({ argv: ["cat", join(work, "closed", "secret.txt")], cwd: work, root: work, sandboxed: true, network: false, useCredentials: false, who: "agent", readWrite: [work], deny: [...(await nodeToolDenies()), join(work, "closed")], timeoutMs: 30_000 });
  assert.notEqual(closed.exitCode, 0);
  assert.doesNotMatch(closed.output, /FAKE-CLOSED-FOR-THE-TEST/);
});

const NODE = "0d0e0f10-1112-4314-8516-171819202122";
/** One call as the server sends it, answered by this computer. */
async function ask(db: ReturnType<typeof memoryDb>, request: Record<string, unknown>, files: Record<string, Uint8Array> = {}) {
  const fake = fakeClient(files);
  await nodeToolAnswerFor({ prisma: db } as never, fake.client as never, { id: randomUUID(), nodeId: NODE, mission: "m1", attended: true, grants: [], ...request } as never, (reply) => fake.client.answerCode("x", reply));
  return { ...fake.answers[0]!, uploads: fake.uploads, downloads: fake.downloads };
}

test("a call that names no folder works in the node's own folder: made on first use, for this account only, never asked about", async () => {
  updateSettings({ acceptWebApprovals: true });
  const own = await ownToolFolder({ nodeId: NODE, nodeSlug: "helper" });
  assert.deepEqual(own, { path: join(home, "ensemble-workspace", "nodes", "helper"), label: "@helper's folder", own: true });
  assert.equal(statSync(own.path).mode & 0o777, 0o700);
  assert.equal((await ownToolFolder({ nodeId: NODE })).path, join(home, "ensemble-workspace", "nodes", "0d0e0f10"), "without a handle: the start of its id");
  const db = memoryDb();
  const wrote = await ask(db, { tool: "files", action: "write", path: "notes/plan.md", content: "# Plan\n", nodeSlug: "helper" });
  assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
  assert.equal(readFileSync(join(own.path, "notes", "plan.md"), "utf8"), "# Plan\n");
  assert.equal(db.rules.length, 0, "nothing asked, nothing kept");
  // A link planted where the folder goes is never followed.
  symlinkSync(join(home, ".ssh"), join(home, "ensemble-workspace", "nodes", "intruder"));
  await assert.rejects(ownToolFolder({ nodeId: NODE, nodeSlug: "intruder" }), /link or a file/);
  const named = await ask(db, { tool: "files", action: "write", folder: work, path: "x.txt", content: "x" });
  assert.equal(named.status, 428, "another folder still asks once");
});

test("Ensemble's own run and node folders count as the node's own: no answer asked, the floor still applies", async () => {
  updateSettings({ acceptWebApprovals: true });
  const workspace = join(home, "ensemble-workspace");
  const run = join(workspace, "runs", "job-1");
  const other = join(workspace, "nodes", "other-node");
  mkdirSync(join(run, "src"), { recursive: true });
  mkdirSync(other, { recursive: true });
  for (const folder of [run, join(run, "src"), other]) assert.equal((await resolveToolFolder(folder)).own, true, folder);
  assert.equal((await resolveToolFolder(join(workspace, "runs"))).own, undefined, "all the runs at once are not one run's folder");
  assert.equal((await resolveToolFolder(work)).own, undefined, "a project folder still asks once");
  const db = memoryDb();
  const wrote = await ask(db, { tool: "files", action: "write", folder: run, path: "notes.md", content: "# Notes\n" });
  assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
  assert.equal(readFileSync(join(run, "notes.md"), "utf8"), "# Notes\n");
  assert.equal(db.rules.length, 0, "nothing asked, nothing kept");
  // The floor still holds inside them: a link planted there is refused.
  symlinkSync(join(home, ".ssh"), join(workspace, "runs", "planted"));
  await assert.rejects(resolveToolFolder(join(workspace, "runs", "planted")), /link/);
});

test("the policy: the node's own folder needs no answer (commands ask per mission where the sandbox is weak); public pages open without asking", async () => {
  const own = { capability: "run" as const, target: "/w/nodes/helper", label: "@helper's folder", scope: "folder" as const, own: true, mission: "m1", attended: true, grants: [] };
  assert.equal((await decide(memoryDb() as never, "local", own, { weak: false, acceptWeb: true })).kind, "allow");
  assert.equal((await decide(memoryDb() as never, "local", own, { weak: false, acceptWeb: false })).kind, "allow", "nothing to approve, so approvals from the web do not matter");
  assert.equal((await decide(memoryDb() as never, "local", { ...own, capability: "files" }, { weak: true, acceptWeb: true })).kind, "allow");
  assert.equal((await decide(memoryDb() as never, "local", own, { weak: true, acceptWeb: true })).kind, "ask", "commands outside an OS sandbox still ask once per mission");
  const page = { capability: "browse" as const, target: "https://www.walmart.com", label: "https://www.walmart.com", scope: "origin" as const, mission: "m1", attended: true, grants: [{ id: "old", scope: "once" as const, target: "https://www.walmart.com" }] };
  assert.deepEqual(await decide(memoryDb() as never, "local", { ...page, publicWeb: true }, { weak: false, acceptWeb: true }), { kind: "allow", grantsUsed: ["old"] }, "an answer from before is used up");
  assert.equal((await decide(memoryDb() as never, "local", { ...page, publicWeb: true, grants: [] }, { weak: false, acceptWeb: true, askBeforeBrowsing: true })).kind, "ask", "the owner asked to be asked");
  assert.equal((await decide(memoryDb() as never, "local", { ...page, target: "http://192.168.1.1", publicWeb: false, grants: [] }, { weak: false, acceptWeb: true })).kind, "ask", "this computer's network asks");
});

test("a public web page: a public name and address; never this computer, its network, a local name or a name that resolves there", async () => {
  setResolverForTests(async (host) => ({ "example.com": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"], "rebind.example.org": ["93.184.216.34", "10.0.0.5"] })[host] ?? []);
  try {
    assert.equal(await publicWebAddress("https://example.com/shop"), true);
    assert.equal(await publicWebAddress("https://93.184.216.34/"), true);
    assert.equal(await publicWebAddress("https://[2606:4700:4700::1111]/"), true);
    for (const url of ["http://localhost:3000", "http://127.0.0.1/", "http://192.168.1.1/", "http://10.0.0.1/", "http://172.20.0.2/", "http://100.100.1.1/", "http://169.254.169.254/", "http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://nas.local/", "http://router.lan/", "http://intranet/", "http://app.internal/", "https://rebind.example.org/", "https://unknown.example.net/", "ftp://example.com/", "not a url"]) {
      assert.equal(await publicWebAddress(url), false, url);
    }
    assert.equal(publicAddress("::ffff:10.0.0.1"), false);
    assert.equal(publicAddress("8.8.8.8"), true);
  } finally {
    setResolverForTests(null);
  }
});

test("a public page opens without asking, unless the owner asked to be asked here or on the web", async () => {
  updateSettings({ acceptWebApprovals: true, askBeforeBrowsing: false });
  setResolverForTests(async (host) => ({ "example.com": ["93.184.216.34"] })[host] ?? []);
  try {
    const open = { tool: "browser", name: "browser_open", input: { url: "https://example.com/" }, operation: `node:${NODE}:own`, uploadId: "u1" };
    assert.equal((await ask(memoryDb(), { ...open, askBeforeBrowsing: true })).status, 428, "the owner's choice on the web");
    updateSettings({ askBeforeBrowsing: true });
    assert.equal((await ask(memoryDb(), open)).status, 428, "this computer's own choice");
  } finally {
    updateSettings({ askBeforeBrowsing: false });
    setResolverForTests(null);
  }
});

test("browser_shop asks only for a shop on this computer's network; the web tools that take an address are judged like browser_open", async () => {
  const { captureScope } = await import("./capture.js");
  setResolverForTests(async (host) => ({ "www.amazon.com": ["93.184.216.34"], "www.walmart.com": ["93.184.216.35"] })[host] ?? []);
  try {
    const request = (name: string, input: Record<string, unknown>) => ({ tool: "browser" as const, name, input, operation: `node:${NODE}:own`, uploadId: "u1", network: true, id: randomUUID(), nodeId: NODE, mission: "m1", attended: true, grants: [] });
    assert.equal(await captureScope(request("browser_shop", { query: "ps5" })), null, "the known stores are public sites");
    assert.equal(await captureScope(request("browser_shop", { query: "ps5", stores: ["amazon", "walmart"] })), null);
    const lan = await captureScope(request("browser_shop", { query: "ps5", stores: ["amazon", "http://192.168.1.5/find?q={query}"] }));
    assert.deepEqual([lan?.input.capability, lan?.input.target, lan?.input.publicWeb], ["browse", "http://192.168.1.5", false]);
    const view = await captureScope(request("browser_view", { url: "http://localhost:3000/app" }));
    assert.deepEqual([view?.input.target, view?.input.publicWeb], ["http://localhost:3000", false]);
    assert.equal((await captureScope(request("browser_fetch", { url: "https://www.amazon.com/paper.pdf" })))?.input.publicWeb, true);
    assert.equal((await captureScope(request("browser_extract", { url: "https://www.walmart.com/ip/1" })))?.input.target, "https://www.walmart.com");
    assert.equal(await captureScope(request("browser_extract", { tab: "t1" })), null, "a tab of its own asks nothing");
  } finally {
    setResolverForTests(null);
  }
});

test("the hard floor's dangerous commands are refused on this computer for every tool that starts one, whatever was answered", async () => {
  const db = memoryDb();
  const refused = async (request: Record<string, unknown>) => {
    const answer = await ask(db, { attended: false, grants: [{ id: "g", scope: "always", target: work }], ...request });
    assert.equal(answer.status, 403, JSON.stringify(request));
    assert.match(String(answer.body.error), /hard floor/);
  };
  await refused({ tool: "run", folder: "app", command: "rm -rf ~", runId: randomUUID() });
  await refused({ tool: "terminal", command: "shutdown -h now", operation: `node:${NODE}:m1`, uploadId: "u" });
  await refused({ tool: "sudo", command: "passwd root", commandHash: "0".repeat(64), cardId: "card", runId: randomUUID() });
  await refused({ tool: "capture", name: "capture_app_start", input: { cwd: work, command: "mkfs.ext4 /dev/sda1" }, operation: `node:${NODE}:m1`, uploadId: "u" });
});

test("a file shared from a folder becomes the node's evidence: kept by kind, with its caption and type; keys and secrets never", async () => {
  updateSettings({ acceptWebApprovals: true, folders: [{ label: "app", path: work, kind: "folder", access: "read-write" }] });
  const db = memoryDb({ STRIPE_KEY: "sk_live_sharedsecretvalue1" });
  const own = await ownToolFolder({ nodeId: NODE, nodeSlug: "helper" });
  writeFileSync(join(own.path, "report.md"), "# Prices\n\n| Shop | Price |\n");
  const share = { tool: "files", action: "share", operation: `node:${NODE}:conversation:share`, uploadId: "upload-9", nodeSlug: "helper" };
  const shared = await ask(db, { ...share, path: "report.md", caption: "The price table" });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  assert.equal(shared.body.ok, true);
  assert.deepEqual((shared.body.evidence as Array<Record<string, unknown>>).map((row) => [row.name, row.kind]), [["report.md", "report"]]);
  assert.deepEqual([shared.uploads[0]!.uploadId, shared.uploads[0]!.meta.mime, shared.uploads[0]!.meta.caption], ["upload-9", "text/markdown", "The price table"]);
  assert.equal(Buffer.from(shared.uploads[0]!.bytes).toString("utf8"), "# Prices\n\n| Shop | Price |\n");
  assert.equal(db.evidence[0]!.operation, share.operation);
  writeFileSync(join(own.path, ".env"), "X=1\n");
  assert.equal((await ask(db, { ...share, path: ".env" })).status, 403);
  writeFileSync(join(own.path, "leak.txt"), "key sk_live_sharedsecretvalue1\n");
  assert.match(String((await ask(db, { ...share, path: "leak.txt" })).body.error), /saved secret/);
  writeFileSync(join(own.path, "fake.png"), "not an image\n");
  assert.match(String((await ask(db, { ...share, path: "fake.png" })).body.error), /must be an image/);
  assert.equal((await ask(db, { ...share, path: "../../../.ssh/id_ed25519" })).status, 403);
  // Another folder: reading it to share asks once, like any folder.
  writeFileSync(join(work, "out.log"), "done\n");
  const other = await ask(db, { ...share, folder: "app", path: "out.log" });
  assert.equal(other.status, 428);
  assert.equal((other.body.ask as Record<string, unknown>).capability, "read");
  assert.deepEqual(["notes.md", "a.CSV", "x.pdf", "shot.png", "clip.mov", "data.bin", "photo.jpeg"].map(shareKind), ["report", "report", "report", "image", "video", "file", "image"]);
});

/** What a ZIP holds, read back with its own directory: each entry's name and bytes, its CRC checked. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const buffer = Buffer.from(bytes);
  const out = new Map<string, string>();
  for (const entry of zipEntries(buffer) ?? assert.fail("not a zip")) {
    const start = entry.offset + 30 + buffer.readUInt16LE(entry.offset + 26) + buffer.readUInt16LE(entry.offset + 28);
    const data = buffer.subarray(start, start + entry.compressed);
    const plain = entry.method === 8 ? inflateRawSync(data) : data;
    assert.equal(crc32(plain), buffer.readUInt32LE(entry.offset + 14), `${entry.name}: its CRC`);
    out.set(entry.name, plain.toString("utf8"));
  }
  return out;
}

test("a folder is shared as one zip: every file checked, text redacted, keys, links, dependencies and secrets left out", async () => {
  updateSettings({ acceptWebApprovals: true, folders: [{ label: "app", path: work, kind: "folder", access: "read-write" }] });
  const db = memoryDb({ STRIPE_KEY: "sk_live_zippedsecretvalue1" });
  const own = await ownToolFolder({ nodeId: NODE, nodeSlug: "helper" });
  const results = join(own.path, "results");
  mkdirSync(join(results, "charts"), { recursive: true });
  mkdirSync(join(results, "node_modules", "left-pad"), { recursive: true });
  mkdirSync(join(results, ".git"), { recursive: true });
  writeFileSync(join(results, "summary.md"), "# Results\n\nAPI_KEY=supersecretvalue123\nall green\n");
  writeFileSync(join(results, "charts", "plot.py"), "import matplotlib\nprint('ok')\n");
  writeFileSync(join(results, "charts", "chart.png"), Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  writeFileSync(join(results, ".env"), "TOKEN=1\n");
  writeFileSync(join(results, "leak.txt"), "the key is sk_live_zippedsecretvalue1\n");
  writeFileSync(join(results, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(results, ".git", "config"), "[core]\n");
  symlinkSync(join(home, ".ssh", "id_ed25519"), join(results, "key-link"));
  const share = { tool: "files", action: "share", operation: `node:${NODE}:conversation:share`, uploadId: "upload-zip", nodeSlug: "helper" };

  const shared = await ask(db, { ...share, path: "results", caption: "The run's results" });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  const upload = shared.uploads[0]!;
  assert.deepEqual([upload.meta.name, upload.meta.kind, upload.meta.mime, upload.meta.caption], ["results.zip", "file", "application/zip", "The run's results"]);
  const inside = unzip(upload.bytes);
  assert.deepEqual([...inside.keys()].sort(), ["results/charts/chart.png", "results/charts/plot.py", "results/summary.md"]);
  assert.match(inside.get("results/summary.md")!, /API_KEY=\[redacted\]\nall green/, "text is redacted as a shared text file is");
  assert.equal(inside.get("results/charts/plot.py"), "import matplotlib\nprint('ok')\n");
  const summary = String(shared.body.summary);
  assert.match(summary, /Shared results from @helper's folder as results\.zip \(3 files, /);
  for (const left of [".env", ".git", "key-link", "leak.txt", "node_modules"]) assert.ok(summary.includes(left), `${left} is named as left out: ${summary}`);
  assert.doesNotMatch(summary, new RegExp(own.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no full paths in what the node reads");

  // The whole folder: `.`, named after it.
  const whole = await ask(db, { ...share, path: "." });
  assert.equal(whole.status, 200, JSON.stringify(whole.body));
  assert.equal(whole.uploads[0]!.meta.name, "helper.zip");
  assert.ok(unzip(whole.uploads[0]!.bytes).has("helper/results/summary.md"));

  // Nothing left to share, and a folder of keys, are refused.
  mkdirSync(join(own.path, "only-keys"), { recursive: true });
  writeFileSync(join(own.path, "only-keys", "server.pem"), "-----BEGIN PRIVATE KEY-----\n");
  assert.match(String((await ask(db, { ...share, path: "only-keys" })).body.error), /Nothing in it could be shared: server\.pem/);
  mkdirSync(join(own.path, ".ssh"), { recursive: true });
  assert.equal((await ask(db, { ...share, path: ".ssh" })).status, 403);
  // Another folder asks once before it is read, as a file there does.
  mkdirSync(join(work, "out"), { recursive: true });
  writeFileSync(join(work, "out", "a.txt"), "a\n");
  assert.equal((await ask(db, { ...share, folder: "app", path: "out" })).status, 428);
});

test("an archive already on disk is shared by what it holds: keys or a saved secret inside refuse it; Office files keep their type; 100 MB per file", async () => {
  const db = memoryDb({ STRIPE_KEY: "sk_live_archivedsecretvalue" });
  const own = await ownToolFolder({ nodeId: NODE, nodeSlug: "helper" });
  const share = { tool: "files", action: "share", operation: `node:${NODE}:conversation:share`, uploadId: "upload-archive", nodeSlug: "helper" };
  const make = async (name: string, entries: Record<string, string>) => {
    const zip = await ZipWriter.create(join(own.path, name), 1024 * 1024);
    for (const [entry, text] of Object.entries(entries)) await zip.add(entry, Buffer.from(text), new Date());
    await zip.finish();
  };
  await make("site.zip", { "site/index.html": "<p>hi</p>", "site/.env": "X=1" });
  assert.match(String((await ask(db, { ...share, path: "site.zip" })).body.error), /site\.zip is not shared\. It holds site\/\.env/);
  await make("logs.zip", { "logs/run.log": "used sk_live_archivedsecretvalue here\n".repeat(40) });
  assert.match(String((await ask(db, { ...share, path: "logs.zip" })).body.error), /saved secret \(in logs\/run\.log\)/);
  await make("report.docx", { "[Content_Types].xml": "<Types/>", "word/document.xml": "<w:document/>" });
  const docx = await ask(db, { ...share, path: "report.docx" });
  assert.equal(docx.status, 200, JSON.stringify(docx.body));
  assert.deepEqual([docx.uploads[0]!.meta.kind, docx.uploads[0]!.meta.mime], ["file", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
  // A tar with a key in it, read by its headers.
  const header = Buffer.alloc(512);
  header.write("backup/id_ed25519", 0);
  header.write("0000644\0", 100);
  header.write("00000000004\0", 124);
  header.write("ustar\u000000", 257, "latin1");
  const tar = Buffer.concat([header, Buffer.from("KEY!"), Buffer.alloc(508), Buffer.alloc(1024)]);
  assert.equal(sniffMime(tar, "backup.tar"), "application/x-tar");
  assert.match(archiveProblem(tar, "application/x-tar", []) ?? "", /It holds backup\/id_ed25519/);

  // Any kind up to 100 MB (a 25 MB data file goes); past that, refused before it is read.
  writeFileSync(join(own.path, "data.bin"), Buffer.alloc(25 * 1024 * 1024, 7));
  const big = await ask(db, { ...share, path: "data.bin" });
  assert.equal(big.status, 200, JSON.stringify(big.body));
  assert.equal(big.uploads[0]!.bytes.length, 25 * 1024 * 1024);
  writeFileSync(join(own.path, "huge.bin"), "x");
  truncateSync(join(own.path, "huge.bin"), 100 * 1024 * 1024 + 1);
  assert.match(String((await ask(db, { ...share, path: "huge.bin" })).body.error), /at most 100 MB/);
  rmSync(join(own.path, "huge.bin"));
  rmSync(join(own.path, "data.bin"));
});

test("a file the owner attached is saved into a folder: fetched by its download id, never over a file unasked, never as a key", async () => {
  updateSettings({ acceptWebApprovals: true, folders: [{ label: "app", path: work, kind: "folder", access: "read-write" }] });
  const db = memoryDb();
  const own = await ownToolFolder({ nodeId: NODE, nodeSlug: "helper" });
  const csv = Buffer.from("region,sales\nnorth,10\n");
  const sha256 = createHash("sha256").update(csv).digest("hex");
  const files = { "dl-1": csv };
  const save = { tool: "files", action: "save", nodeSlug: "helper", downloadId: "dl-1", size: csv.length, sha256 };

  const saved = await ask(db, { ...save, path: "data/sales.csv" }, files);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.path, saved.body.bytes, saved.body.created], ["data/sales.csv", csv.length, true]);
  assert.equal(readFileSync(join(own.path, "data", "sales.csv"), "utf8"), csv.toString());
  assert.deepEqual(saved.downloads, ["dl-1"]);

  // Already there: not replaced unless asked, and nothing is fetched to find that out.
  const again = await ask(db, { ...save, path: "data/sales.csv" }, files);
  assert.equal(again.status, 409);
  assert.match(String(again.body.error), /already exists\. To replace it, call again with overwrite: true/);
  assert.deepEqual(again.downloads, []);
  writeFileSync(join(own.path, "data", "sales.csv"), "old\n");
  const replaced = await ask(db, { ...save, path: "data/sales.csv", overwrite: true }, files);
  assert.equal(replaced.body.replaced, true);
  assert.equal(readFileSync(join(own.path, "data", "sales.csv"), "utf8"), csv.toString());
  assert.equal((await ask(db, { ...save, path: "data" }, files)).status, 409, "a folder is not a file's path");

  // What arrives must be what was named; keys, git's files, links and other folders' outsides are refused.
  assert.match(String((await ask(db, { ...save, path: "short.csv", size: csv.length + 1 }, files)).body.error), /did not arrive whole/);
  assert.match(String((await ask(db, { ...save, path: "other.csv", sha256: "0".repeat(64) }, files)).body.error), /changed on the way/);
  assert.equal(existsSync(join(own.path, "other.csv")), false);
  assert.equal((await ask(db, { ...save, path: ".env" }, files)).status, 403);
  assert.equal((await ask(db, { ...save, path: ".git/hooks/pre-commit" }, files)).status, 403);
  assert.equal((await ask(db, { ...save, path: "../../../.ssh/authorized_keys" }, files)).status, 403);
  symlinkSync(join(home, ".ssh", "id_ed25519"), join(own.path, "linked.csv"));
  assert.equal((await ask(db, { ...save, path: "linked.csv", overwrite: true }, files)).status, 403);
  assert.equal(readFileSync(join(home, ".ssh", "id_ed25519"), "utf8"), "FAKE-KEY-FOR-THE-TEST\n");
  // Another folder: writing there asks once, as computer_files_write does.
  const other = await ask(db, { ...save, folder: "app", path: "sales.csv" }, files);
  assert.equal(other.status, 428);
  assert.equal((other.body.ask as Record<string, unknown>).capability, "files");
});

test("sign-in codes in a command's output: Microsoft, GitHub, AWS SSO, Google and any “open … and enter the code”; prose and pages without a code are not codes", () => {
  const found = (text: string) => deviceCodesIn(text).map((item) => [item.url, item.code]);
  assert.deepEqual(found("To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code FWQZ8N3XP to authenticate."), [["https://microsoft.com/devicelogin", "FWQZ8N3XP"]]);
  assert.deepEqual(found("WARNING: To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code A1B2C3D4E to authenticate."), [["https://login.microsoft.com/device", "A1B2C3D4E"]]);
  assert.deepEqual(found("\u001b[0;33m!\u001b[0m First copy your one-time code: \u001b[1m3F2A-9C1B\u001b[0m\nPress Enter to open https://github.com/login/device in your browser..."), [["https://github.com/login/device", "3F2A-9C1B"]]);
  assert.deepEqual(found("If the browser does not open, open the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n\nThen enter the code:\n\nWDDD-HLQF\n"), [["https://device.sso.us-east-1.amazonaws.com/", "WDDD-HLQF"]]);
  assert.deepEqual(found("https://device.sso.eu-west-1.amazonaws.com/?user_code=QWER-TYUI"), [["https://device.sso.eu-west-1.amazonaws.com/?user_code=QWER-TYUI", "QWER-TYUI"]]);
  assert.deepEqual(found("Go to https://www.google.com/device and enter code ABCD-EFGH-IJKL"), [["https://www.google.com/device", "ABCD-EFGH-IJKL"]]);
  const generic = deviceCodesIn("Please visit https://auth.example.com/activate and enter the code: XK9P-2LMQ to continue. The code expires in 10 minutes.");
  assert.deepEqual([generic[0]?.code, generic[0]?.expiresInMs], ["XK9P-2LMQ", 600_000]);
  for (const prose of ["Enter the code from your authenticator app.", "Open https://example.com/docs to read more, then enter the code below.", "Opening https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=04b07795&redirect_uri=http%3A%2F%2Flocalhost%3A8400", "run `npm test` and enter the code review", "open the page http://localhost:3000/device and enter the code ABCD1234"]) assert.deepEqual(deviceCodesIn(prose), [], prose);
  // Split across the output's pieces, each code once.
  const watch = new DeviceCodeWatch();
  assert.deepEqual(watch.feed("First copy your one-time code: 3F2A-9C1B\n"), []);
  assert.equal(watch.feed("Open this URL to continue in your web browser: https://github.com/login/device\n")[0]?.code, "3F2A-9C1B");
  assert.deepEqual(watch.feed("one-time code: 3F2A-9C1B https://github.com/login/device"), []);
  assert.equal(loopbackReturn("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A8400&state=s"), "http://localhost:8400/**");
  assert.equal(loopbackReturn("https://idp.example.com/authorize?redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb"), null);
});

test("a command's sign-in: its code goes to the owner's card at once and the answer says so, the card follows its end; a page it opens is handed to Ensemble through BROWSER and the openers", async () => {
  const folder = { path: work, label: "app" };
  const db = memoryDb();
  const run = async (command: string, extra: Record<string, unknown> = {}) => {
    const fake = fakeClient();
    const runId = randomUUID();
    const started = Date.now();
    await runNodeCommand({ prisma: db } as never, fake.client as never, { id: randomUUID(), tool: "run", folder: "app", command, timeoutSec: 60, background: false, secrets: [], runId, delivery: "local", network: false, nodeId: "n1", mission: "m", attended: false, grants: [], operationId: "turn:1", ...extra } as never, folder, (answer) => fake.client.answerCode("x", answer));
    return { ...fake, runId, ms: Date.now() - started };
  };
  const prompt = "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code FWQZ8N3XP to authenticate.";
  // In the foreground: it waits for the owner, so it answers as soon as the code is out and goes on in the background.
  const foreground = await run(`node -e "console.log('${prompt}'); setTimeout(() => process.exit(0), 2500)"`);
  assert.equal(foreground.answers[0]!.status, 202, "answered once the code was out");
  assert.deepEqual(foreground.answers[0]!.body.deviceCodes, [{ url: "https://microsoft.com/devicelogin", code: "FWQZ8N3XP" }]);
  assert.match(String(foreground.answers[0]!.body.output), /FWQZ8N3XP/, "the owner's code is not hidden from them");
  assert.deepEqual(
    foreground.codes.map((post) => [post.status, post.nodeId, post.operation, post.url, post.code, post.command, post.operationId]),
    [
      ["pending", "n1", foreground.runId, "https://microsoft.com/devicelogin", "FWQZ8N3XP", `node -e "console.log('${prompt}'); setTimeout(() => process.exit(0), 2500)"`.slice(0, 200), "turn:1"],
      ["done", "n1", foreground.runId, "https://microsoft.com/devicelogin", "FWQZ8N3XP", `node -e "console.log('${prompt}'); setTimeout(() => process.exit(0), 2500)"`.slice(0, 200), "turn:1"],
    ],
  );
  // In the background, a sign-in command waits a moment for its prompt; one that fails leaves its code expired.
  const background = await run(`node -e "/* aws sso login */ setTimeout(() => console.log('Then enter the code: WDDD-HLQF at https://device.sso.us-east-1.amazonaws.com/'), 300); setTimeout(() => process.exit(3), 900)"`, { background: true });
  assert.equal(background.answers[0]!.status, 202);
  assert.deepEqual(background.answers[0]!.body.deviceCodes, [{ url: "https://device.sso.us-east-1.amazonaws.com/", code: "WDDD-HLQF" }]);
  assert.deepEqual(background.codes.map((post) => post.status), ["pending", "expired"]);

  // A page the command opens goes to Ensemble, through $BROWSER or xdg-open; other arguments go to the real program.
  const pages: string[] = [];
  setCliPageOpenerForTests(async (url) => void pages.push(url));
  try {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const opened = await run(`node -e "const { execFileSync } = require('node:child_process'); execFileSync(process.env.BROWSER, ['https://login.example.test/authorize?redirect_uri=http://localhost:8400/']); execFileSync('${opener}', ['https://github.com/login/device']); console.log('opened')"`);
    assert.equal(opened.answers[0]!.status, 200, JSON.stringify(opened.answers[0]));
    assert.match(String(opened.answers[0]!.body.output), /opened/);
    assert.deepEqual(pages, ["https://login.example.test/authorize?redirect_uri=http://localhost:8400/", "https://github.com/login/device"]);
  } finally {
    setCliPageOpenerForTests(null);
  }
  const plain = await run(`node -e "console.log(Boolean(process.env.BROWSER))"`);
  assert.equal(plain.answers[0]!.body.output, process.platform === "win32" ? "false\n" : "true\n");
});
