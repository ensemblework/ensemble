import "./test-env.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { encrypt } from "../lib/secrets.js";
import { enforceHostedRequest, requireHostTerminal, setHostedUserResolverForTests } from "../lib/hosted-access.js";
import { listCredentials, resolveCredential, setCredentialStoreForTests } from "./credentials.js";
import { endpoint, listModels, setRuntimeFetchForTests } from "./models.js";
import { runPlot, setPlotRunnerForTests } from "./plots-python.js";
import { runCommand } from "../workspace/runner.js";
import { runTrustedGit } from "../workspace/git-gate.js";
import { beginOAuth } from "../connectors/oauth.js";

function hosted(t: TestContext) {
  const before = { ...process.env };
  process.env.NODE_ENV = "production";
  process.env.ENSEMBLE_DESKTOP = "0";
  process.env.ENSEMBLE_OPERATOR_EMAILS = "operator@example.test";
  process.env.OPENAI_API_KEY = "host-key-never-shared";
  process.env.GITHUB_TOKEN = "host-github-never-shared";
  delete process.env.ENSEMBLE_TERMINAL;
  setHostedUserResolverForTests(async (id) => id === "missing" ? null : {
    email: id === "operator" ? "operator@example.test" : "member@example.test",
    emailVerifiedAt: id === "unverified" ? null : new Date(),
  });
  setCredentialStoreForTests({
    read: async (id, provider) => id === "byok" && provider === "openai" ? { secret: encrypt("own-key"), baseUrl: null } : null,
    list: async (id) => id === "byok" ? [{ provider: "openai", hint: "own", updatedAt: new Date() }] : [],
    upsert: async () => undefined,
    remove: async () => undefined,
  });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    setHostedUserResolverForTests(null);
    setCredentialStoreForTests(null);
    setRuntimeFetchForTests(null);
    setPlotRunnerForTests(null);
  });
}

test("host keys stay operator-only while verified BYOK resolves its own key", async (t) => {
  hosted(t);
  assert.equal((await resolveCredential("operator", "openai")).source, "env");
  assert.equal((await resolveCredential("byok", "openai")).secret, "own-key");
  for (const provider of ["openai", "copilot"]) {
    assert.equal((await resolveCredential("member", provider)).source, "none");
  }
  await assert.rejects(resolveCredential(null, "openai"), { statusCode: 403 });
  await assert.rejects(resolveCredential("unverified", "openai"), { statusCode: 403 });
  await assert.rejects(resolveCredential("missing", "openai"), { statusCode: 403 });
  const list = await listCredentials("member");
  assert.ok(list.every((row) => row.source === "none" && row.hint === null));
  assert.equal((await listCredentials("byok")).find((row) => row.provider === "openai")?.source, "you");
});

test("credential DB failures cannot fall through to server environment keys", async (t) => {
  hosted(t);
  setCredentialStoreForTests({
    read: async () => { throw new Error("database unavailable"); },
    list: async () => { throw new Error("database unavailable"); },
    upsert: async () => undefined,
    remove: async () => undefined,
  });
  await assert.rejects(resolveCredential("operator", "openai"), /database unavailable/);
  await assert.rejects(listCredentials("member"), /database unavailable/);
});

test("factory pre-SSE hook denies unverified model turns without gating core CRUD", async (t) => {
  hosted(t);
  await assert.rejects(enforceHostedRequest({ userId: "unverified", method: "POST" }, "/api/assistant/turn"), { statusCode: 403 });
  await assert.rejects(enforceHostedRequest({ method: "POST" }, "/api/assistant/turn"), { statusCode: 403 });
  await enforceHostedRequest({ userId: "member", method: "POST" }, "/api/assistant/turn");
  for (const path of ["/api/tasks", "/api/people", "/api/assistant/conversations", "/api/settings"]) {
    await enforceHostedRequest({ userId: "unverified", method: "POST" }, path);
  }
});

test("host Ollama, custom proxies, OAuth and commands reject members before IO", async (t) => {
  hosted(t);
  let requests = 0;
  setRuntimeFetchForTests(async () => { requests++; throw new Error("must not fetch"); });
  await assert.rejects(endpoint("ollama", "member", "http://localhost:11434"), { statusCode: 403 });
  await assert.rejects(listModels("ollama", "member", "http://localhost:11434"), { statusCode: 403 });
  setCredentialStoreForTests({
    read: async () => ({ secret: encrypt("own-key"), baseUrl: "http://127.0.0.1:4000" }),
    list: async () => [], upsert: async () => undefined, remove: async () => undefined,
  });
  await assert.rejects(endpoint("openai", "member", null), { statusCode: 403 });
  // Connector OAuth is open to verified members; it still refuses unverified accounts.
  await assert.rejects(beginOAuth("unverified", "google", "/settings"), { statusCode: 403 });
  await assert.rejects(runTrustedGit({ userId: "member", cwd: "/", args: ["status"] }), { statusCode: 403 });
  await assert.rejects(runCommand({ userId: "member", argv: ["pwd"], cwd: "/", root: "/", sandboxed: false, network: false, useCredentials: false, who: "agent", timeoutMs: 100 }), { statusCode: 403 });
  assert.equal(requests, 0);
});

test("host terminal is opt-in, off wins, and even on requires operator", async (t) => {
  hosted(t);
  await assert.rejects(requireHostTerminal("operator"), { statusCode: 403 });
  process.env.ENSEMBLE_TERMINAL = "on";
  await requireHostTerminal("operator");
  await assert.rejects(requireHostTerminal("member"), { statusCode: 403 });
  process.env.ENSEMBLE_TERMINAL = "off";
  await assert.rejects(requireHostTerminal("operator"), { statusCode: 403 });
  process.env.NODE_ENV = "development";
  await assert.rejects(requireHostTerminal("operator"), { statusCode: 403 });
  delete process.env.ENSEMBLE_TERMINAL;
  await requireHostTerminal("member");
});

test("reusable Python plot entry point denies members and unknown identity before worker", async (t) => {
  hosted(t);
  let runs = 0;
  setPlotRunnerForTests(async () => { runs++; return { stdout: "", stderr: "", png: "image" }; });
  await assert.rejects(runPlot("print('no')", [], "png", 200, "member"), { statusCode: 403 });
  await assert.rejects(runPlot("print('no')", []), { statusCode: 403 });
  assert.equal(runs, 0);
  assert.equal((await runPlot("print('ok')", [], "png", 200, "operator")).png, "image");
  assert.equal(runs, 1);
});
