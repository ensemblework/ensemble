/**
 * Two Ensemble runtimes on one computer with one pairing (docs/25 §4.9, docs/26 §4): the web hands an
 * assistant turn, and a relayed request that changes something there, to one of them only, and keeps
 * only the newer one's event stream. Through Ensemble's real routes on an in-memory database.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import type { Prisma } from "@prisma/client";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { runtimeClaimRouteCoverage, type RouteCheck } from "../test/route-coverage.js";

let harness: HttpHarness;
// Loaded after the harness: they read the configuration, and the harness sets Redis to memory first.
let sseHub: (typeof import("../lib/sse.js"))["sseHub"];
let relay: typeof import("../subscriptions/relay.js");
let files: typeof import("./file-relay.js");
let notify: typeof import("./revoke-notify.js");
let activity: typeof import("../lib/ai-activity.js");

before(async () => {
  harness = await createHttpHarness();
  ({ sseHub } = await import("../lib/sse.js"));
  relay = await import("../subscriptions/relay.js");
  files = await import("./file-relay.js");
  notify = await import("./revoke-notify.js");
  activity = await import("../lib/ai-activity.js");
});

const covered = new Map<string, Set<RouteCheck>>();
function claim(route: string, ...checks: RouteCheck[]): void {
  const set = covered.get(route) ?? new Set<RouteCheck>();
  for (const check of checks) set.add(check);
  covered.set(route, set);
}

after(async () => {
  try {
    for (const [route, checks] of Object.entries(runtimeClaimRouteCoverage)) {
      for (const check of checks) assert.ok(covered.get(route)?.has(check), `Unexecuted coverage claim: ${check} ${route}`);
    }
  } finally {
    await harness?.close();
  }
});

const SERVICE = "c0ffee00-1111-4222-8333-000000000001";
const TERMINAL = "c0ffee00-1111-4222-8333-000000000002";
const id = (instance?: string): Record<string, string> => (instance ? { "x-ensemble-instance": instance } : {});

async function pairedComputer(user: HttpUser, name: string, capabilities: Record<string, unknown>) {
  await harness.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  const key = await harness.asToken(user, "device");
  const device = await harness.prisma.device.create({ data: { userId: user.id, name, platform: "macos", appVersion: "cli-0.7.18", tokenId: key.id, lastSeenAt: new Date(), capabilities: capabilities as Prisma.InputJsonValue } });
  return { key, device };
}

async function until<T>(read: () => T | null | undefined | "" | false, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the second runtime to read an assistant turn is refused, and only the one that took it answers it", async () => {
  const person = await harness.asUser();
  const { key, device } = await pairedComputer(person, "Studio Mac", { assistantTurns: 3 });
  let turnId = "";
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId === `device:${device.id}` && frame.event === "assistant.turn") turnId = String((frame.data as { id: string }).id);
  });
  const deltas: string[] = [];
  try {
    const answered = relay.runOnComputer({
      device,
      spec: { agent: "claude-code", model: "haiku", effort: null, system: "You are the Ensemble assistant.", prompt: "hello", tools: [], maxTurns: 8 },
      call: async () => ({ text: "{}" }),
      onDelta: (text) => deltas.push(text),
      signal: new AbortController().signal,
    });
    const turn = `/api/devices/self/assistant-turns/${await until(() => turnId, "the turn's frame")}`;

    const first = await key.inject({ method: "GET", url: turn, headers: id(SERVICE) });
    assert.equal(first.statusCode, 200, first.body);
    const second = await key.inject({ method: "GET", url: turn, headers: id(TERMINAL) });
    assert.equal(second.statusCode, 409, "a second runtime of the same computer never gets the turn");
    assert.deepEqual(second.json(), { error: "This turn was picked up by another Ensemble on this computer." });
    const older = await key.inject({ method: "GET", url: turn });
    assert.equal(older.statusCode, 409, "nor does an older runtime that sends no id");
    const again = await key.inject({ method: "GET", url: turn, headers: id(SERVICE) });
    assert.equal(again.statusCode, 200, "the runtime that took it may read it again");

    const tool = await key.inject({ method: "POST", url: `${turn}/tool`, headers: id(TERMINAL), payload: { name: "hub_list_tasks", input: {} } });
    assert.equal(tool.statusCode, 409);
    assert.equal(tool.json().isError, true);
    const stream = await key.inject({ method: "POST", url: `${turn}/stream`, headers: id(TERMINAL), payload: { seq: 1, text: "twice" } });
    assert.equal(stream.statusCode, 409);
    assert.deepEqual(stream.json(), { stop: true });
    const failed = await key.inject({ method: "POST", url: `${turn}/done`, headers: id(TERMINAL), payload: { error: { problem: "failed", message: "Session is in use by another Copilot process." } } });
    assert.equal(failed.statusCode, 409, "the other runtime's error is not the answer");
    const fileRead = await key.inject({ method: "GET", url: `${turn}/files/any`, headers: id(TERMINAL) });
    assert.equal(fileRead.statusCode, 409);

    const streamed = await key.inject({ method: "POST", url: `${turn}/stream`, headers: id(SERVICE), payload: { seq: 1, text: "Hello" } });
    assert.equal(streamed.statusCode, 200, streamed.body);
    const done = await key.inject({ method: "POST", url: `${turn}/done`, headers: id(SERVICE), payload: { result: { text: "Hello", model: "claude-haiku-5-5", tokensIn: 1, tokensOut: 1, costUsd: null } } });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal((await answered).text, "Hello");
    assert.deepEqual(deltas, ["Hello"], "one runtime's reply, once");
  } finally {
    stop();
  }
});

test("an older runtime that reads a turn without an id keeps working on it", async () => {
  const person = await harness.asUser();
  const { key, device } = await pairedComputer(person, "Old Mac", { assistantTurns: 3 });
  let turnId = "";
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId === `device:${device.id}` && frame.event === "assistant.turn") turnId = String((frame.data as { id: string }).id);
  });
  try {
    const answered = relay.runOnComputer({
      device,
      spec: { agent: "claude-code", model: "haiku", effort: null, system: "s", prompt: "hello", tools: [], maxTurns: 8 },
      call: async () => ({ text: "{}" }),
      onDelta: () => undefined,
      signal: new AbortController().signal,
    });
    const turn = `/api/devices/self/assistant-turns/${await until(() => turnId, "the turn's frame")}`;
    assert.equal((await key.inject({ method: "GET", url: turn })).statusCode, 200);
    assert.equal((await key.inject({ method: "GET", url: turn, headers: id(SERVICE) })).statusCode, 409, "a second read is refused whoever asks");
    const done = await key.inject({ method: "POST", url: `${turn}/done`, payload: { result: { text: "Hi", model: null, tokensIn: null, tokensOut: null, costUsd: null } } });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal((await answered).text, "Hi");
  } finally {
    stop();
  }
});

test("a request that changes something on the computer is acted on by the runtime that claims it first", async () => {
  const CLAIM = "POST /api/devices/self/code-requests/:id/claim";
  const ANSWER = "POST /api/devices/self/code-requests/:id";
  const person = await harness.asUser();
  const stranger = await harness.asUser();
  const { key, device } = await pairedComputer(person, "Studio Mac", { code: true, codeApi: 4, projectDelete: 1 });
  const theirs = await pairedComputer(stranger, "Their Mac", { code: true, codeApi: 4, projectDelete: 1 });
  let requestId = "";
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId === `device:${device.id}` && frame.event === "project.delete") requestId = String((frame.data as { id: string }).id);
  });
  try {
    const asked = files.askDeviceFor(harness.app.redis, { deviceId: device.id, event: "project.delete", data: { projectId: randomUUID() } }, 10_000);
    const url = `/api/devices/self/code-requests/${await until(() => requestId, "the request's frame")}`;

    const taken = await key.inject({ method: "POST", url: `${url}/claim`, headers: id(SERVICE), payload: {} });
    assert.equal(taken.statusCode, 200, taken.body);
    assert.deepEqual(taken.json(), { claimed: true });
    claim(CLAIM, "happy-path");
    const second = await key.inject({ method: "POST", url: `${url}/claim`, headers: id(TERMINAL), payload: {} });
    assert.equal(second.statusCode, 409, "another runtime of the computer does not act on it");
    assert.deepEqual(second.json(), { error: "This request was picked up by another Ensemble on this computer." });
    assert.equal((await key.inject({ method: "POST", url: `${url}/claim`, headers: id(SERVICE), payload: {} })).statusCode, 200, "the runtime that took it keeps it");
    const anonymous = await key.inject({ method: "POST", url: `${url}/claim`, payload: {} });
    assert.equal(anonymous.statusCode, 400, "a claim says which runtime makes it");
    claim(CLAIM, "invalid-input");
    const unknown = await key.inject({ method: "POST", url: `/api/devices/self/code-requests/${randomUUID()}/claim`, headers: id(SERVICE), payload: {} });
    assert.equal(unknown.statusCode, 410);
    claim(CLAIM, "unknown-id");
    const stolen = await theirs.key.inject({ method: "POST", url: `${url}/claim`, headers: id(TERMINAL), payload: {} });
    assert.equal(stolen.statusCode, 410, "another person's computer cannot claim it");
    claim(CLAIM, "isolation");

    const twice = await key.inject({ method: "POST", url, headers: id(TERMINAL), payload: { status: 200, body: { deleted: true, found: 0, owed: false } } });
    assert.equal(twice.statusCode, 409, "an answer from the runtime that did not take it is refused");
    claim(ANSWER, "isolation");
    const answered = await key.inject({ method: "POST", url, headers: id(SERVICE), payload: { status: 200, body: { deleted: true, found: 1, owed: false } } });
    assert.equal(answered.statusCode, 200, answered.body);
    claim(ANSWER, "happy-path");
    assert.deepEqual(await asked, { status: 200, body: { deleted: true, found: 1, owed: false } });
    const late = await key.inject({ method: "POST", url, headers: id(SERVICE), payload: { status: 200, body: {} } });
    assert.equal(late.statusCode, 410, "nobody waits once it was answered");
    claim(ANSWER, "unknown-id");

    // A read is answered by whichever runtime answers, as before.
    requestId = "";
    const read = files.askDeviceFor(harness.app.redis, { deviceId: device.id, event: "project.delete", data: { projectId: randomUUID() } }, 10_000);
    const readUrl = `/api/devices/self/code-requests/${await until(() => requestId, "the second request's frame")}`;
    assert.equal((await key.inject({ method: "POST", url: readUrl, payload: { status: 200, body: { deleted: true, found: 0, owed: false } } })).statusCode, 200);
    assert.deepEqual(await read, { status: 200, body: { deleted: true, found: 0, owed: false } });
  } finally {
    stop();
  }
});

test("when two runtimes of one computer open event streams, the older is told and closed, and the owner's AI activity says so", async () => {
  const person = await harness.asUser();
  const { key, device } = await pairedComputer(person, "Studio Mac", { assistantTurns: 3 });
  const saved: Array<{ kind: string; userId: string; output?: unknown; name?: string; refs: unknown }> = [];
  const previous = process.env.ENSEMBLE_AI_ACTIVITY;
  process.env.ENSEMBLE_AI_ACTIVITY = "on";
  activity.saveAiActivityForTests(async (rows) => void saved.push(...rows));
  await harness.app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = harness.app.server.address() as AddressInfo;
  const opened: AbortController[] = [];
  const decoder = new TextDecoder();
  async function open(instance?: string) {
    const controller = new AbortController();
    opened.push(controller);
    const response = await fetch(`http://127.0.0.1:${port}/api/devices/self/events`, { headers: { authorization: `Bearer ${key.token}`, accept: "text/event-stream", ...id(instance) }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let text = "";
    const stream = {
      async until(wanted: string): Promise<void> {
        const deadline = Date.now() + 5_000;
        while (!text.includes(wanted)) {
          const next = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no ${wanted} in ${JSON.stringify(text)}`)), Math.max(1, deadline - Date.now())))]);
          if (next.done) throw new Error(`stream ended before ${wanted}: ${JSON.stringify(text)}`);
          text += decoder.decode(next.value, { stream: true });
        }
      },
      async ended(): Promise<boolean> {
        const next = await Promise.race([reader.read(), new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 2_000))]);
        return next.done === true;
      },
    };
    await stream.until(":\n\n");
    return stream;
  }
  try {
    const service = await open(SERVICE);
    const older = await open();
    const terminal = await open(TERMINAL);
    await service.until("event: device.replaced");
    assert.equal(await service.ended(), true, "the older runtime's stream ends");
    notify.publishDeviceFrame(device.id, "job.queued", {});
    await terminal.until("event: job.queued");
    await older.until("event: job.queued");
    assert.equal(sseHub.listeners(`device:${device.id}`), 2, "the newer runtime's stream stays, and an older runtime that sends no id is left alone");

    // The first runtime connects again, newer now: the other one is told.
    const back = await open(SERVICE);
    await terminal.until("event: device.replaced");
    notify.publishDeviceFrame(device.id, "job.queued", { again: true });
    await back.until("event: job.queued");

    await activity.flushAiActivity();
    const warnings = saved.filter((row) => row.kind === "server.log" && row.userId === person.id);
    assert.equal(warnings.length, 2, "each replacement is in the owner's AI activity");
    assert.equal(warnings[0]!.name, "warn");
    assert.match(String(warnings[0]!.output), /Another Ensemble runtime on Studio Mac connected with the same pairing/);
    assert.deepEqual(warnings[0]!.refs, { device: device.id });
  } finally {
    for (const controller of opened) controller.abort();
    activity.saveAiActivityForTests(null);
    if (previous === undefined) delete process.env.ENSEMBLE_AI_ACTIVITY;
    else process.env.ENSEMBLE_AI_ACTIVITY = previous;
  }
});
