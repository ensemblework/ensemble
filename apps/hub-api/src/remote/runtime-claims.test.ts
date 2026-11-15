/**
 * Two runtimes on one computer with one pairing (docs/25 §4.9): the computer's side. A runtime that
 * finds an assistant turn taken by the other one leaves it, a request that changes something here is
 * acted on only after this runtime took it, and every call says which runtime makes it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const state = mkdtempSync(join(tmpdir(), "remote-claims-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = state;
process.env.REDIS_URL ??= "memory://local";
writeFileSync(join(state, "remote.json"), JSON.stringify({ version: 1, enabled: true, browseFiles: true, webEdit: true }));
after(() => rmSync(state, { recursive: true, force: true }));

const { answerAssistantTurn } = await import("./assistant.js");
const { answerCodeRequest } = await import("./code.js");
const { answerProjectDelete } = await import("./project-delete.js");
const { answerSessionDelete } = await import("./session-delete.js");
const { answerAssistantSessionDelete } = await import("./assistant-session-delete.js");
const { claimedHere, hostedClient, RemoteError, RUNTIME_INSTANCE } = await import("./client.js");
const { INSTANCE_HEADER, runtimeInstanceOf } = await import("./contract.js");
const { classifyRateLimit } = await import("../lib/rate-limit.js");

type Claim = "claimed" | "taken" | "gone";

function fakeClient(claim: Claim) {
  const claims: string[] = [];
  const answers: Array<{ id: string; answer: unknown }> = [];
  return {
    claims,
    answers,
    client: {
      claimRequest: async (id: string) => {
        claims.push(id);
        return claim;
      },
      answerCode: async (id: string, answer: unknown) => void answers.push({ id, answer }),
    },
  };
}

test("a turn another runtime of this computer took is left alone: the agent never runs and nothing is sent", async () => {
  const sent: string[] = [];
  const client = {
    assistantTurn: async () => {
      throw new RemoteError(409, "This turn was picked up by another Ensemble on this computer.");
    },
    assistantStream: async () => {
      sent.push("stream");
      return { stop: false };
    },
    assistantDone: async () => void sent.push("done"),
  } as never;
  let ran = false;
  const outcome = await answerAssistantTurn(client, { id: "turn-taken" }, async () => {
    ran = true;
    return { text: "twice", model: null, tokensIn: null, tokensOut: null, costUsd: null };
  });
  assert.equal(outcome, "taken");
  assert.equal(ran, false, "no second paid run of the same turn");
  assert.deepEqual(sent, []);
});

test("a Code write is made only by the runtime that takes it; reads need no claim", async () => {
  const calls: string[] = [];
  const app = {
    inject: async (options: { method: string; url: string }) => {
      calls.push(`${options.method} ${options.url.split("?")[0]}`);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    },
  } as never;
  const stage = { id: "write-1", method: "POST", path: "/api/code/scm/stage", query: {}, body: { repo: "/r", paths: ["src/a.ts"] } };

  const other = fakeClient("taken");
  await answerCodeRequest(app, other.client, stage);
  assert.deepEqual(other.claims, ["write-1"]);
  assert.deepEqual(calls, [], "the other runtime stages nothing");
  assert.deepEqual(other.answers, [], "and does not answer");

  const mine = fakeClient("claimed");
  await answerCodeRequest(app, mine.client, stage);
  assert.deepEqual(calls, ["POST /api/code/scm/stage"]);
  assert.deepEqual(mine.answers.map((row) => row.id), ["write-1"]);

  const reader = fakeClient("taken");
  await answerCodeRequest(app, reader.client, { id: "read-1", method: "GET", path: "/api/code/scm", query: { repo: "/r" } });
  assert.deepEqual(reader.claims, [], "a read is not claimed");
  assert.deepEqual(reader.answers.map((row) => row.id), ["read-1"]);
});

test("a project or session deletion is done only by the runtime that takes it", async () => {
  const removed: string[] = [];
  const remove = async (projectId: string) => {
    removed.push(projectId);
    return { found: 1, owed: false };
  };
  const project = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
  const other = fakeClient("taken");
  await answerProjectDelete(other.client, { id: "p-1", projectId: project }, remove);
  const gone = fakeClient("gone");
  await answerProjectDelete(gone.client, { id: "p-2", projectId: project }, remove);
  assert.deepEqual(removed, [], "not by a runtime that did not take it, nor for a request nobody waits for");
  assert.deepEqual([...other.answers, ...gone.answers], []);
  const mine = fakeClient("claimed");
  await answerProjectDelete(mine.client, { id: "p-3", projectId: project }, remove);
  assert.deepEqual(removed, [project]);
  assert.deepEqual(mine.answers, [{ id: "p-3", answer: { status: 200, body: { deleted: true, found: 1, owed: false } } }]);

  const sessions = fakeClient("taken");
  await answerSessionDelete({ log: { warn: () => undefined } } as never, sessions.client, { id: "s-1", jobIds: ["0b1c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d"] });
  assert.deepEqual(sessions.claims, ["s-1"]);
  assert.deepEqual(sessions.answers, []);

  const chat = fakeClient("taken");
  await answerAssistantSessionDelete(chat.client, { id: "c-1", key: "taken-chat-0001" });
  assert.deepEqual(chat.claims, ["c-1"]);
  assert.deepEqual(chat.answers, []);
});

test("a claim that cannot be made means not acting; a server without claims means acting as before", async () => {
  assert.equal(await claimedHere({}, "r"), true, "a client without claims (an older server's) acts");
  assert.equal(await claimedHere({ claimRequest: async () => "gone" as const }, "r"), false);
  assert.equal(await claimedHere({ claimRequest: async () => Promise.reject(new RemoteError(0, "Ensemble on the web is not reachable.")) }, "r"), false);
  await assert.rejects(claimedHere({ claimRequest: async () => Promise.reject(new RemoteError(401, "This computer is no longer paired.")) }, "r"), /no longer paired/);
});

test("every call says which runtime makes it, and the server's answer to a claim is read as it means", async () => {
  const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
  const answers: Record<string, number> = { "/api/devices/self/code-requests/mine/claim": 200, "/api/devices/self/code-requests/old-server/claim": 404, "/api/devices/self/code-requests/theirs/claim": 409, "/api/devices/self/code-requests/ended/claim": 410 };
  const server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0]!;
    seen.push({ path, headers: request.headers });
    if (path === "/api/devices/self/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(":\n\n");
      return;
    }
    response.writeHead(answers[path] ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(path.endsWith("/claim") ? { claimed: true } : { spec: null }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = hostedClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "ens_d_test");
    assert.equal(await client.claimRequest!("mine"), "claimed");
    assert.equal(await client.claimRequest!("old-server"), "claimed", "a server without the route: this runtime acts, as before");
    assert.equal(await client.claimRequest!("theirs"), "taken");
    assert.equal(await client.claimRequest!("ended"), "gone");
    await client.assistantTurn("turn-1");
    await client.answerCode("mine", { status: 200, body: {} });
    await client.events(() => undefined, new AbortController().signal);
    assert.ok(seen.length >= 7);
    for (const row of seen) assert.equal(row.headers[INSTANCE_HEADER], RUNTIME_INSTANCE, `${row.path} names this runtime`);
    assert.equal(runtimeInstanceOf({ [INSTANCE_HEADER]: RUNTIME_INSTANCE }), RUNTIME_INSTANCE);
    assert.equal(runtimeInstanceOf({ [INSTANCE_HEADER]: "../../etc" }), null, "only an id-shaped value counts");
    assert.equal(runtimeInstanceOf({}), null);
  } finally {
    server.close();
  }
  assert.equal(classifyRateLimit("POST", "/api/devices/self/code-requests/abc/claim"), "deviceFiles", "claims share the answers' allowance");
});
