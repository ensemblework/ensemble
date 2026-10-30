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
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
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
const { checkTarget, fetchLoopback, loopbackAddress, setResolverForTests } = await import("./http.js");
const { gitArgv } = await import("./git.js");
const { runNodeFiles } = await import("./files.js");
const { runNodeCommand, setForegroundMsForTests } = await import("./run.js");
const { nodeToolAnswerFor } = await import("./answer.js");
const { nodeToolDenies, resolveToolFolder } = await import("./folders.js");
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
  };
}

/** A computer's client that records what it sends back. */
function fakeClient() {
  const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
  const chunks: Array<{ seq: number; text: string; done: boolean; exitCode: number | null; wake?: boolean }> = [];
  return {
    answers,
    chunks,
    output: () => chunks.map((chunk) => chunk.text).join(""),
    client: {
      async toolOutput(_runId: string, chunk: (typeof chunks)[number]) {
        chunks.push(chunk);
        return true;
      },
      async answerCode(_id: string, answer: { status: number; body?: unknown }) {
        answers.push({ status: answer.status, body: (answer.body ?? {}) as Record<string, unknown> });
      },
    },
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
