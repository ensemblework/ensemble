/**
 * A turn the web relays to the owner's computer when that computer restarts, or its connection drops
 * (docs/25 §4.9, docs/35 §5.8), through Ensemble's real routes on an in-memory database. The computer is
 * simulated by its requests (each runtime with its own instance id and event stream), or is the real
 * computer-side code (remote/assistant.ts) talking HTTP to this API through a link that loses answers, or
 * runs as processes of its own (the runtime and its agent, a stand-in Claude Code) that the test kills.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import { makeTestDirectory } from "../test/temporary.js";

const h = await createHttpHarness();
const { sseHub } = await import("../lib/sse.js");
const relay = await import("./relay.js");
const { settleTurns, setTurnRetryDelaysForTests } = await import("../node/queue.js");
const { turnJournal } = await import("../node/journal.js");
const computerSide = await import("../remote/assistant.js");
const { hostedClient } = await import("../remote/client.js");

await h.app.listen({ host: "127.0.0.1", port: 0 });
const base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
after(() => h.close());

const json = (response: LightMyRequestResponse) => response.json() as any;
const COPILOT = { id: "copilot-cli", via: "cli", version: "1.0.200", signedIn: true, models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }], typedModels: true };

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

async function until<T>(probe: () => Promise<T | null | undefined | false | "">, what: string, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

type Key = Awaited<ReturnType<typeof h.asToken>>;
type Spec = { prompt: string; session?: { key: string; resume?: string } | null; relay?: number };

/** A node on its owner's GitHub Copilot plan, on one paired computer (`capabilities` added to a current Ensemble's). */
async function onPlan(name: string, capabilities: Record<string, unknown> = {}) {
  const owner = await person(name);
  const key = await h.asToken(owner, "device");
  const laptop = await h.prisma.device.create({
    data: { userId: owner.id, name: `${name}'s laptop`, platform: "linux", appVersion: "cli-0.9.0", tokenId: key.id, lastSeenAt: new Date(), capabilities: { assistantTurns: 6, agents: [{ ...COPILOT, checkedAt: new Date().toISOString() }], ...capabilities } },
  });
  const made = await owner.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  assert.equal(made.statusCode, 201, made.body);
  const { node, room } = json(made) as { node: { id: string; slug: string }; room: { id: string } };
  await h.prisma.nodeAgent.update({ where: { id: node.id }, data: { provider: "copilot-cli", model: "gpt-6.1-sol" } });
  return { owner, key, laptop, node, room };
}

/** The turns the web hands this computer, in order, and the frames it stops. */
function handed(deviceId: string) {
  const turns: string[] = [];
  const stopped: string[] = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${deviceId}`) return;
    if (frame.event === "assistant.turn") turns.push(String((frame.data as { id: string }).id));
    if (frame.event === "assistant.stop") stopped.push(String((frame.data as { id: string }).id));
  });
  return { turns, stopped, stop };
}

/** One runtime process of the computer: its event stream, open until it closes (the process ends, or its link drops). */
async function runtime(key: Key, instance: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/devices/self/events`, { headers: { authorization: `Bearer ${key.token}`, accept: "text/event-stream", "x-ensemble-instance": instance }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  await reader.read();
  return {
    close() {
      controller.abort();
      void reader.cancel().catch(() => undefined);
    },
  };
}

/** The computer's requests about one turn, as runtime `instance`. */
function as(key: Key, instance: string, turnId: string) {
  const url = `/api/devices/self/assistant-turns/${turnId}`;
  const headers = { "x-ensemble-instance": instance };
  return {
    async read(): Promise<Spec> {
      const response = await key.inject({ method: "GET", url, headers });
      assert.equal(response.statusCode, 200, response.body);
      return json(response).spec as Spec;
    },
    async tool(name: string, input: unknown, callId?: string) {
      const response = await key.inject({ method: "POST", url: `${url}/tool`, headers, payload: { name, input, ...(callId ? { callId } : {}) } });
      return { status: response.statusCode, text: String(json(response).text ?? ""), isError: json(response).isError === true };
    },
    stream: (body: Record<string, unknown>) => key.inject({ method: "POST", url: `${url}/stream`, headers, payload: body }),
    done: (text: string) => key.inject({ method: "POST", url: `${url}/done`, headers, payload: { result: { text, model: "gpt-6.1-sol", tokensIn: 10, tokensOut: 2, costUsd: null, resumed: true } } }),
  };
}

async function replies(owner: HttpUser, roomId: string, nodeId: string) {
  const response = await owner.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` });
  assert.equal(response.statusCode, 200, response.body);
  return (json(response).messages as Array<{ kind: string; body: string; authorNodeId: string | null }>).filter((row) => row.authorNodeId === nodeId);
}

const post = (owner: HttpUser, roomId: string, body: string) => owner.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });

test("a computer that restarts mid-turn: the node's turn is cut off at once, and resumed in the same session, told what may have run", async () => {
  const plan = await onPlan("Akash");
  const frames = handed(plan.laptop.id);
  const [first, second] = [randomUUID(), randomUUID()];
  const before = await runtime(plan.key, first);
  try {
    assert.equal((await post(plan.owner, plan.room.id, "book the venue, then run the ledger script")).statusCode, 201);
    const cutId = await until(async () => frames.turns[0], "the turn handed to the computer");
    const old = as(plan.key, first, cutId);
    const spec = await old.read();
    assert.match((await old.tool("hub_create_tasks", { tasks: [{ title: "Book the venue" }] })).text, /Book the venue/);
    // A call whose answer never came back before the computer went down, and the agent's own command, started and never ended.
    const cut = await h.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: plan.node.id, status: "running" } });
    const started = await turnJournal(h.app, cut).begin({ name: "hub_create_tasks", arguments: JSON.stringify({ tasks: [{ title: "Pay the deposit" }] }), sideEffect: true });
    assert.ok("ticket" in started);
    await started.ticket.dispatched();
    assert.equal((await old.stream({ seq: 1, text: "", tools: [{ id: "own-1", name: "shell", summary: "node ledger.js", phase: "start", acts: true }] })).statusCode, 200);

    // The computer restarts: the old runtime's stream ends, a new runtime opens one.
    before.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const restartedAt = Date.now();
    const after = await runtime(plan.key, second);
    try {
      const resumedId = await until(async () => frames.turns[1], "the resumed turn handed to the computer", 3_000);
      assert.ok(Date.now() - restartedAt < 3_000, "at once, not after ten minutes of silence");
      assert.ok(frames.stopped.includes(cutId), "the old runtime, should it still run, is told to stop");
      const fresh = as(plan.key, second, resumedId);
      const resumedSpec = await fresh.read();
      assert.equal(resumedSpec.session?.key, spec.session?.key, "the same session of the agent");
      assert.match(resumedSpec.prompt, /restarted[\s\S]*may already have happened[\s\S]*hub_create_tasks \{"tasks":\[\{"title":"Pay the deposit"\}\]\}/);
      assert.match(resumedSpec.prompt, /shell: node ledger\.js/, "the agent's own command that never ended is named too");
      assert.match((await fresh.tool("hub_create_tasks", { tasks: [{ title: "Pay the deposit" }] })).text, /may already have happened[\s\S]*not run again/);
      assert.equal((await fresh.done("The venue is booked. The deposit and the ledger script may have run before the restart: I checked before doing anything again.")).statusCode, 200);
      await settleTurns();
    } finally {
      after.close();
    }

    const turn = await h.prisma.nodeTurn.findUniqueOrThrow({ where: { id: cut.id } });
    assert.equal(turn.outcome, "interrupted");
    assert.match(turn.error ?? "", /restarted/);
    const resumed = await h.prisma.nodeTurn.findFirstOrThrow({ where: { originTurnId: cut.id } });
    assert.equal(resumed.outcome, "done");
    assert.equal(await h.prisma.task.count({ where: { userId: plan.owner.id, title: "Book the venue" } }), 1);
    assert.equal(await h.prisma.task.count({ where: { userId: plan.owner.id, title: "Pay the deposit" } }), 0, "a call that may have run is never run again blindly");
    assert.equal((await h.prisma.nodeToolJournal.findFirstOrThrow({ where: { turnId: cut.id, label: { contains: "Pay the deposit" } } })).state, "uncertain");
    const said = await replies(plan.owner, plan.room.id, plan.node.id);
    assert.deepEqual(said.map((row) => row.kind), ["text"], "one reply, no error");
    assert.match(said[0]!.body, /may have run before the restart/);
  } finally {
    frames.stop();
    before.close();
    relay.stopComputerTurns(plan.laptop.id);
    await settleTurns();
  }
});

test("a computer that restarts before the turn did anything: the same turn runs again from the start", async () => {
  const plan = await onPlan("Mira");
  const frames = handed(plan.laptop.id);
  const [first, second] = [randomUUID(), randomUUID()];
  const before = await runtime(plan.key, first);
  try {
    assert.equal((await post(plan.owner, plan.room.id, "what is on my list?")).statusCode, 201);
    const firstId = await until(async () => frames.turns[0], "the turn handed to the computer");
    const spec = await as(plan.key, first, firstId).read();
    before.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await runtime(plan.key, second);
    try {
      const againId = await until(async () => frames.turns[1], "the turn handed to the computer again", 3_000);
      const again = as(plan.key, second, againId);
      const respec = await again.read();
      assert.equal(respec.prompt, spec.prompt, "the same message, with no note: nothing had happened");
      assert.equal((await again.done("Nothing is on your list.")).statusCode, 200);
      await settleTurns();
    } finally {
      after.close();
    }
    const turns = await h.prisma.nodeTurn.findMany({ where: { nodeId: plan.node.id } });
    assert.deepEqual(turns.map((row) => [row.outcome, row.originTurnId]), [["done", null]], "one turn, run again");
    assert.deepEqual((await replies(plan.owner, plan.room.id, plan.node.id)).map((row) => row.body), ["Nothing is on your list."]);
  } finally {
    frames.stop();
    before.close();
    relay.stopComputerTurns(plan.laptop.id);
    await settleTurns();
  }
});

test("an agent that exits with nothing said before anything acted: the turn runs once more, quietly; a second exit is the turn's error", async () => {
  const plan = await onPlan("Lena");
  const frames = handed(plan.laptop.id);
  const instance = randomUUID();
  const live = await runtime(plan.key, instance);
  setTurnRetryDelaysForTests([5, 5, 5]);
  const exited = (turnId: string) => plan.key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${turnId}/done`, headers: { "x-ensemble-instance": instance }, payload: { error: { problem: "exited", message: "GitHub Copilot stopped: exit 1" } } });
  try {
    assert.equal((await post(plan.owner, plan.room.id, "when does Acme renew?")).statusCode, 201);
    const firstId = await until(async () => frames.turns[0], "the turn handed to the computer");
    const spec = await as(plan.key, instance, firstId).read();
    assert.equal((await exited(firstId)).statusCode, 200);
    const againId = await until(async () => frames.turns[1], "the turn handed to the computer again", 3_000);
    const again = as(plan.key, instance, againId);
    assert.equal((await again.read()).prompt, spec.prompt, "the same message, with no note: nothing had acted");
    assert.equal((await again.done("Acme renews on 15 March 2027.")).statusCode, 200);
    await settleTurns();
    assert.deepEqual((await replies(plan.owner, plan.room.id, plan.node.id)).map((row) => [row.kind, row.body]), [["text", "Acme renews on 15 March 2027."]], "one answer, no error");

    assert.equal((await post(plan.owner, plan.room.id, "and Globex?")).statusCode, 201);
    const thirdId = await until(async () => frames.turns[2], "the next turn handed to the computer");
    await as(plan.key, instance, thirdId).read();
    assert.equal((await exited(thirdId)).statusCode, 200);
    const fourthId = await until(async () => frames.turns[3], "that turn handed to the computer again", 3_000);
    await as(plan.key, instance, fourthId).read();
    assert.equal((await exited(fourthId)).statusCode, 200);
    await settleTurns();
    assert.equal(frames.turns.length, 4, "tried once more, not again");
    const said = await replies(plan.owner, plan.room.id, plan.node.id);
    assert.equal(said.length, 2);
    assert.match(said[1]!.body, /GitHub Copilot stopped: exit 1/);
  } finally {
    setTurnRetryDelaysForTests(null);
    frames.stop();
    live.close();
    relay.stopComputerTurns(plan.laptop.id);
    await settleTurns();
  }
});

test("an agent that exits with nothing said after a call that may have run: the turn resumes once, told to check first", async () => {
  const plan = await onPlan("Omar");
  const frames = handed(plan.laptop.id);
  const instance = randomUUID();
  const live = await runtime(plan.key, instance);
  try {
    assert.equal((await post(plan.owner, plan.room.id, "add the deposit task")).statusCode, 201);
    const firstId = await until(async () => frames.turns[0], "the turn handed to the computer");
    await as(plan.key, instance, firstId).read();
    const cut = await h.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: plan.node.id, status: "running" } });
    const started = await turnJournal(h.app, cut).begin({ name: "hub_create_tasks", arguments: JSON.stringify({ tasks: [{ title: "Pay the deposit" }] }), sideEffect: true });
    assert.ok("ticket" in started);
    await started.ticket.dispatched();
    const ended = await plan.key.inject({ method: "POST", url: `/api/devices/self/assistant-turns/${firstId}/done`, headers: { "x-ensemble-instance": instance }, payload: { error: { problem: "exited", message: "GitHub Copilot stopped: exit 1" } } });
    assert.equal(ended.statusCode, 200);
    const resumedId = await until(async () => frames.turns[1], "the resumed turn handed to the computer", 3_000);
    const resumed = as(plan.key, instance, resumedId);
    assert.match((await resumed.read()).prompt, /cut off when its agent stopped \(GitHub Copilot stopped: exit 1\)[\s\S]*check first[\s\S]*may already have happened[\s\S]*Pay the deposit/);
    assert.equal((await resumed.done("The deposit task may have been added before the agent stopped: I checked, and it is not there.")).statusCode, 200);
    await settleTurns();
    assert.equal((await h.prisma.nodeTurn.findUniqueOrThrow({ where: { id: cut.id } })).outcome, "interrupted");
    assert.deepEqual((await replies(plan.owner, plan.room.id, plan.node.id)).map((row) => row.kind), ["text"], "one reply, no error");
  } finally {
    frames.stop();
    live.close();
    relay.stopComputerTurns(plan.laptop.id);
    await settleTurns();
  }
});

test("a runtime whose stream ends and that sends nothing more is cut off after a short grace; one that keeps talking is not", async () => {
  relay.setRelayTimingForTests({ presenceMs: 300 });
  try {
    // Still talking: its stream ended (a blip), its calls go on, and it finishes.
    const talking = await onPlan("Ben");
    const kept = handed(talking.laptop.id);
    const instance = randomUUID();
    const stream = await runtime(talking.key, instance);
    try {
      assert.equal((await post(talking.owner, talking.room.id, "what is due?")).statusCode, 201);
      const id = await until(async () => kept.turns[0], "the turn handed to the computer");
      const it = as(talking.key, instance, id);
      await it.read();
      stream.close();
      for (let i = 0; i < 6; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal((await it.stream({ seq: i + 1, text: "." })).statusCode, 200, "still its turn");
      }
      assert.equal((await it.done("Nothing is due.")).statusCode, 200);
      await settleTurns();
      assert.deepEqual((await replies(talking.owner, talking.room.id, talking.node.id)).map((row) => row.body), ["Nothing is due."]);
    } finally {
      kept.stop();
      stream.close();
      relay.stopComputerTurns(talking.laptop.id);
      await settleTurns();
    }

    // Gone: its stream ended and it sends nothing. The turn is cut off once the grace is over, and resumed when the computer is back.
    const silent = await onPlan("Ana");
    const frames = handed(silent.laptop.id);
    const gone = randomUUID();
    const link = await runtime(silent.key, gone);
    try {
      assert.equal((await post(silent.owner, silent.room.id, "add a task to call the bank")).statusCode, 201);
      const id = await until(async () => frames.turns[0], "the turn handed to the computer");
      const it = as(silent.key, gone, id);
      await it.read();
      await it.tool("hub_create_tasks", { tasks: [{ title: "Call the bank" }] });
      link.close();
      const resumedId = await until(async () => frames.turns[1], "the resumed turn", 3_000);
      const cut = await h.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: silent.node.id, originTurnId: null } });
      assert.equal(cut.outcome, "interrupted");
      assert.match(cut.error ?? "", /lost touch/);
      const back = await runtime(silent.key, gone);
      try {
        const resumed = as(silent.key, gone, resumedId);
        assert.match((await resumed.read()).prompt, /lost touch[\s\S]*Do not repeat what it already did/);
        assert.equal((await resumed.done("The task to call the bank is on your list.")).statusCode, 200);
        await settleTurns();
      } finally {
        back.close();
      }
      assert.equal(await h.prisma.task.count({ where: { userId: silent.owner.id, title: "Call the bank" } }), 1);
      assert.deepEqual((await replies(silent.owner, silent.room.id, silent.node.id)).map((row) => row.body), ["The task to call the bank is on your list."]);
    } finally {
      frames.stop();
      link.close();
      relay.stopComputerTurns(silent.laptop.id);
      await settleTurns();
    }
  } finally {
    relay.setRelayTimingForTests(null);
  }
});

test("a chat on the person's own plan, cut off by its computer's restart, goes on in the same session with what may have run; a computer that cannot take that says so", async () => {
  for (const turns of [6, 3]) {
    const owner = await person(turns === 6 ? "Kofi" : "Lena");
    const key = await h.asToken(owner, "device");
    const laptop = await h.prisma.device.create({
      data: { userId: owner.id, name: "Studio Mac", platform: "macos", appVersion: "cli-0.9.0", tokenId: key.id, lastSeenAt: new Date(), capabilities: { assistantTurns: turns, agents: [{ ...COPILOT, checkedAt: new Date().toISOString() }] } },
    });
    const set = await owner.inject({ method: "PATCH", url: "/api/settings", payload: { models: { medium: { provider: "copilot-cli", model: "gpt-6.1-sol", effort: "default" } }, assistant: { defaultTier: "medium", writePolicy: "immediate" } } });
    assert.equal(set.statusCode, 200, set.body);
    const frames = handed(laptop.id);
    const [first, second] = [randomUUID(), randomUUID()];
    const before = await runtime(key, first);
    let after: Awaited<ReturnType<typeof runtime>> | null = null;
    try {
      const chat = owner.inject({ method: "POST", url: "/api/assistant/turn", payload: { message: "Add a task to renew the lease" } });
      const id = await until(async () => frames.turns[0], "the chat turn handed to the computer");
      const old = as(key, first, id);
      const spec = await old.read();
      await old.tool("hub_create_tasks", { tasks: [{ title: "Renew the lease" }] });
      before.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      after = await runtime(key, second);
      if (turns === 6) {
        const resumedId = await until(async () => frames.turns[1], "the chat's next message in the same session", 3_000);
        const fresh = as(key, second, resumedId);
        const resumedSpec = await fresh.read();
        assert.equal(resumedSpec.session?.key, spec.session?.key);
        assert.equal(resumedSpec.session?.resume, "only", "only in the session that took the turn");
        assert.match(resumedSpec.prompt, /restarted[\s\S]*hub_create_tasks/);
        assert.equal((await fresh.done("The lease renewal is on your list.")).statusCode, 200);
      }
      const body = (await chat).body;
      assert.doesNotMatch(body, /sent nothing for 10 minutes/);
      if (turns === 6) {
        assert.doesNotMatch(body, /event: error/, body);
        assert.match(body, /The lease renewal is on your list\./);
      } else {
        assert.match(body, /Studio Mac restarted while it was answering[\s\S]*may already have happened/, "said honestly, at once");
      }
      assert.equal(await h.prisma.task.count({ where: { userId: owner.id, title: "Renew the lease" } }), 1);
    } finally {
      frames.stop();
      before.close();
      after?.close();
      relay.stopComputerTurns(laptop.id);
      await settleTurns();
    }
  }
});

test("connection lost during a write and at the end: the computer sends the call again with its id and the end again; the result arrives once, and a call whose answer never came is said to have maybe happened", async () => {
  computerSide.setRelayRetryForTests({ delaysMs: [20, 40, 80], toolForMs: 1_500, doneForMs: 3_000 });
  const plan = await onPlan("Ravi", { assistantRelay: 1 });
  const client = hostedClient(base, plan.key.token);
  const realFetch = globalThis.fetch;
  const lost: string[] = [];
  let downUntil = 0;
  // The link drops: a write's answer is lost after Ensemble ran it (once, then for longer than the computer waits), and the turn's first end never gets there.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (/\/assistant-turns\/[^/]+\/done$/.test(url) && !lost.includes("done")) {
      lost.push("done");
      throw new TypeError("fetch failed");
    }
    const response = await realFetch(input, init);
    if (/\/assistant-turns\/[^/]+\/tool$/.test(url) && (!lost.includes("tool") || Date.now() < downUntil)) {
      lost.push("tool");
      await response.text();
      throw new TypeError("fetch failed");
    }
    return response;
  }) as typeof fetch;
  const answers: string[] = [];
  const frames = handed(plan.laptop.id);
  const answering: Array<Promise<unknown>> = [];
  const listen = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${plan.laptop.id}` || frame.event !== "assistant.turn") return;
    answering.push(
      computerSide.answerAssistantTurn(client, frame.data, async (_spec, io) => {
        answers.push((await io.call("hub_create_tasks", { tasks: [{ title: "Call the venue about chairs" }] })).text);
        downUntil = Date.now() + 2_000;
        answers.push((await io.call("hub_create_tasks", { tasks: [{ title: "Order more chairs" }] })).text);
        // Back online, the agent makes the same call again, as told, to see whether it took effect.
        answers.push((await io.call("hub_create_tasks", { tasks: [{ title: "Order more chairs" }] })).text);
        io.onDelta("Added both.");
        return { text: "Added “Call the venue about chairs” and “Order more chairs” to your list.", model: "gpt-6.1-sol", tokensIn: 10, tokensOut: 2, costUsd: null };
      }),
    );
  });
  try {
    assert.equal((await post(plan.owner, plan.room.id, "Add two todos: 'Call the venue about chairs' and 'Order more chairs'.")).statusCode, 201);
    await until(async () => (await h.prisma.nodeTurn.findFirst({ where: { nodeId: plan.node.id, status: "done" } })) ?? null, "the turn to end", 10_000);
    await Promise.all(answering);
    await settleTurns();
    assert.equal(lost[0], "tool");
    assert.ok(lost.includes("done"), "the first end was lost too");
    assert.equal(await h.prisma.task.count({ where: { userId: plan.owner.id, title: "Call the venue about chairs" } }), 1, "the write ran once");
    assert.equal(await h.prisma.task.count({ where: { userId: plan.owner.id, title: "Order more chairs" } }), 1, "and the other once, however often it was sent");
    assert.match(answers[0]!, /Call the venue about chairs/, "the agent got the write's own answer, not an error");
    assert.doesNotMatch(answers[0]!, /may already have happened/);
    assert.match(answers[1]!, /may already have happened\. Check whether it took effect/, "an answer that never came is said to be unknown");
    assert.match(answers[2]!, /Order more chairs/, "the same call again gets the first one's answer");
    const said = await replies(plan.owner, plan.room.id, plan.node.id);
    assert.deepEqual(said.map((row) => [row.kind, row.body]), [["text", "Added “Call the venue about chairs” and “Order more chairs” to your list."]], "posted once");
  } finally {
    globalThis.fetch = realFetch;
    listen();
    frames.stop();
    computerSide.setRelayRetryForTests(null);
    relay.stopComputerTurns(plan.laptop.id);
    await settleTurns();
  }
});

test("a turn whose reading's answer was lost is read again by the same runtime: the reply arrives at once, and once", async () => {
  computerSide.setRelayRetryForTests({ delaysMs: [20, 40, 80], toolForMs: 1_500, doneForMs: 3_000 });
  const plan = await onPlan("Noor", { assistantRelay: 1 });
  const client = hostedClient(base, plan.key.token);
  const realFetch = globalThis.fetch;
  const reads: string[] = [];
  // The link drops: the first reading never gets there, and the second's answer is lost after the web gave the turn to this runtime.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!/\/assistant-turns\/[^/]+$/.test(url) || (init?.method ?? "GET") !== "GET") return realFetch(input, init);
    reads.push(url);
    if (reads.length === 1) throw new TypeError("fetch failed");
    const response = await realFetch(input, init);
    if (reads.length > 2) return response;
    await response.text();
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const answering: Array<Promise<unknown>> = [];
  const listen = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${plan.laptop.id}` || frame.event !== "assistant.turn") return;
    answering.push(computerSide.answerAssistantTurn(client, frame.data, async () => ({ text: "Hello from the laptop.", model: "gpt-6.1-sol", tokensIn: 3, tokensOut: 4, costUsd: null })));
  });
  try {
    assert.equal((await post(plan.owner, plan.room.id, "Say hello.")).statusCode, 201);
    await until(async () => (await h.prisma.nodeTurn.findFirst({ where: { nodeId: plan.node.id, status: "done" } })) ?? null, "the turn to end", 10_000);
    await Promise.all(answering);
    await settleTurns();
    assert.equal(reads.length, 3, "read again until the web's answer arrived");
    assert.equal((await h.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: plan.node.id } })).outcome, "done");
    const said = await replies(plan.owner, plan.room.id, plan.node.id);
    assert.deepEqual(said.map((row) => [row.kind, row.body]), [["text", "Hello from the laptop."]], "answered once, not after ten minutes of silence");
  } finally {
    globalThis.fetch = realFetch;
    listen();
    computerSide.setRelayRetryForTests(null);
    relay.stopComputerTurns(plan.laptop.id);
    await settleTurns();
  }
});

const CLAUDE = { id: "claude-code", via: "cli", version: "2.1.0", signedIn: true, models: [{ id: "haiku", label: "Haiku" }], typedModels: true };

/**
 * The computer's runtime as a process of its own: its event stream, and each turn the web hands it answered by
 * remote/assistant.ts with the agent's real turn (subscriptions/agents.ts) on the stand-in Claude Code below.
 */
const RUNTIME = `const [client, assistant, registry] = await Promise.all(${JSON.stringify(["../remote/client.ts", "../remote/assistant.ts", "../workspace/engines/registry.ts"].map((path) => new URL(path, import.meta.url).href))}.map((url) => import(url)));
// The stand-in never calls Ensemble's tools.
registry.setLocalPort(1);
setInterval(() => undefined, 60_000);
const hosted = client.hostedClient(process.env.STANDIN_API, process.env.STANDIN_TOKEN);
await hosted.events((event, data) => {
  if (event === "assistant.turn") void assistant.answerAssistantTurn(hosted, data).catch((error) => process.stderr.write(String(error?.stack ?? error) + "\\n"));
  if (event === "assistant.stop") assistant.stopAssistantTurn(data);
}, new AbortController().signal);
`;

/**
 * Claude Code's session handling as the runtime sees it: a new session with the id it is given, an earlier one by
 * \`--resume\` (refused once its transcript is gone), each message added to the session's transcript. Every run is
 * noted in \`runs.jsonl\`. With a \`hold\` file there, it takes the next message into the session and works on it
 * until the test ends it (\`held\` says which session and process).
 */
const STANDIN_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const after = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
if (args.includes('--version')) { process.stdout.write('2.1.0 (Claude Code)\\n'); process.exit(0); }
if (!args.includes('--system-prompt-file')) process.exit(0);
let prompt = '';
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  const home = process.env.STANDIN_HOME;
  const resumed = after('--resume');
  const id = after('--session-id') || resumed;
  fs.appendFileSync(path.join(home, 'runs.jsonl'), JSON.stringify({ id, resumed: Boolean(resumed), prompt }) + '\\n');
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'standin');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  if (resumed && !fs.existsSync(file)) { process.stderr.write('No conversation found with session ID: ' + id + '\\n'); process.exit(1); }
  const line = (value) => fs.appendFileSync(file, JSON.stringify(value) + '\\n');
  const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  line({ type: 'user', entrypoint: 'sdk-cli', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
  say({ type: 'system', subtype: 'init', session_id: id, model: 'claude-haiku-test' });
  if (fs.existsSync(path.join(home, 'hold'))) {
    fs.rmSync(path.join(home, 'hold'));
    fs.writeFileSync(path.join(home, 'held'), JSON.stringify({ id, pid: process.pid }));
    setInterval(() => undefined, 60_000);
    return;
  }
  const reply = resumed ? 'Went on in the same session.' : 'Started.';
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
  say({ type: 'result', subtype: 'success', is_error: false, result: reply, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 2 } });
});
`;

type Run = { id: string; resumed: boolean; prompt: string };

/** The owner's computer with a stand-in Claude Code, whose runtime the test starts, and kills as the computer restarts. */
function computer(name: string, deviceId: string, token: string) {
  const root = makeTestDirectory(`ensemble-restart-${name}-`);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "claude"), STANDIN_CLAUDE);
  chmodSync(join(root, "bin", "claude"), 0o755);
  writeFileSync(join(root, "runtime.mjs"), RUNTIME);
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
    STANDIN_API: base,
    STANDIN_TOKEN: token,
    STANDIN_HOME: root,
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    ENSEMBLE_REMOTE_STATE_DIR: join(root, "state"),
    ENSEMBLE_WORKSPACE_ROOT: join(root, "workspace"),
    XDG_CONFIG_HOME: join(root, "config"),
  };
  const children: ChildProcess[] = [];
  const agents: number[] = [];
  const streams = () => sseHub.listeners(`device:${deviceId}`);
  return {
    runs: (): Run[] => (existsSync(join(root, "runs.jsonl")) ? readFileSync(join(root, "runs.jsonl"), "utf8").trim().split("\n").map((row) => JSON.parse(row) as Run) : []),
    sessions: () => JSON.parse(readFileSync(join(root, "state", "assistant-sessions.json"), "utf8")) as Record<string, { id: string; next?: number; taking?: unknown }>,
    /** The agent takes its next message into the session and is still working on it when the computer restarts. */
    holdNext: () => writeFileSync(join(root, "hold"), ""),
    async held(): Promise<{ id: string; pid: number }> {
      const held = await until(async () => existsSync(join(root, "held")) && (JSON.parse(readFileSync(join(root, "held"), "utf8")) as { id: string; pid: number }), "the agent working on the message", 20_000);
      rmSync(join(root, "held"));
      agents.push(held.pid);
      return held;
    },
    /** A runtime of this computer, once its event stream is open. */
    async start(): Promise<() => void> {
      await until(async () => streams() === 0, "the earlier runtime's stream to end");
      const child = spawn(process.execPath, ["--import", "tsx", join(root, "runtime.mjs")], { env, stdio: ["ignore", "ignore", "inherit"] });
      children.push(child);
      await until(async () => streams() === 1, "the runtime's event stream", 30_000);
      return () => child.kill("SIGKILL");
    },
    /** The computer restarts: its runtime and the agent working on the message end at once, saving nothing more. */
    restart(stop: () => void, agent: { pid: number }) {
      stop();
      process.kill(agent.pid, "SIGKILL");
    },
    close() {
      for (const child of children) child.kill("SIGKILL");
      for (const pid of agents) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** One of the owner's computers, paired, with Claude Code signed in there. */
async function withClaude(name: string) {
  const owner = await person(name);
  const key = await h.asToken(owner, "device");
  const laptop = await h.prisma.device.create({
    data: { userId: owner.id, name: `${name}'s laptop`, platform: "linux", appVersion: "cli-0.9.0", tokenId: key.id, lastSeenAt: new Date(), capabilities: { assistantTurns: 6, assistantRelay: 1, agents: [{ ...CLAUDE, checkedAt: new Date().toISOString() }] } },
  });
  return { owner, key, laptop, pc: computer(name.toLowerCase(), laptop.id, key.token) };
}

test("on the computer's own runtime and agent: a chat cut off by its computer's restart goes on in the agent session that took it, for its first message and a later one", async () => {
  const { owner, laptop, pc } = await withClaude("Tomas");
  const set = await owner.inject({ method: "PATCH", url: "/api/settings", payload: { models: { medium: { provider: "claude-code", model: "haiku", effort: "default" } }, assistant: { defaultTier: "medium", writePolicy: "immediate" } } });
  assert.equal(set.statusCode, 200, set.body);
  let stop = await pc.start();
  try {
    // The chat's first message: the agent starts its session, and the computer restarts while it works.
    pc.holdNext();
    const first = owner.inject({ method: "POST", url: "/api/assistant/turn", payload: { message: "Plan my week around the venue visit." } });
    const session = await pc.held();
    pc.restart(stop, session);
    stop = await pc.start();
    const firstBody = (await first).body;
    assert.doesNotMatch(firstBody, /event: error/, firstBody);
    assert.match(firstBody, /Went on in the same session\./);
    const conversation = await h.prisma.assistantConversation.findFirstOrThrow({ where: { userId: owner.id }, orderBy: { createdAt: "desc" } });

    // A later message, in that session: cut off the same way, it goes on there too.
    pc.holdNext();
    const second = owner.inject({ method: "POST", url: "/api/assistant/turn", payload: { message: "Now add the catering call.", conversationId: conversation.id } });
    pc.restart(stop, await pc.held());
    stop = await pc.start();
    const secondBody = (await second).body;
    assert.doesNotMatch(secondBody, /event: error/, secondBody);
    assert.match(secondBody, /Went on in the same session\./);

    const runs = pc.runs();
    assert.deepEqual(runs.map((run) => [run.id, run.resumed]), [[session.id, false], [session.id, true], [session.id, true], [session.id, true]], "one agent session throughout");
    assert.match(runs[1]!.prompt, /Your answer was cut off when Tomas's laptop restarted/);
    assert.match(runs[3]!.prompt, /Your answer was cut off when Tomas's laptop restarted/);
    const kept = pc.sessions()[conversation.id]!;
    assert.equal(kept.id, session.id);
    assert.equal(kept.next, 4, "the chat's two messages and their replies");
    assert.equal(kept.taking, undefined);
  } finally {
    stop();
    pc.close();
    relay.stopComputerTurns(laptop.id);
    await settleTurns();
  }
});

test("on the computer's own runtime and agent: a node's turn cut off by its computer's restart resumes in the agent session that took it", async () => {
  const { owner, laptop, pc } = await withClaude("Imani");
  const made = await owner.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  assert.equal(made.statusCode, 201, made.body);
  const { node, room } = json(made) as { node: { id: string }; room: { id: string } };
  await h.prisma.nodeAgent.update({ where: { id: node.id }, data: { provider: "claude-code", model: "haiku" } });
  let stop = await pc.start();
  try {
    assert.equal((await post(owner, room.id, "Say hello.")).statusCode, 201);
    await until(async () => (await replies(owner, room.id, node.id)).length === 1, "the node's first reply", 20_000);
    const [session] = pc.runs();

    // The next turn goes on in that session; the computer restarts after the turn began acting.
    pc.holdNext();
    assert.equal((await post(owner, room.id, "Draft a short note about the venue visit.")).statusCode, 201);
    const agent = await pc.held();
    const cut = await h.prisma.nodeTurn.findFirstOrThrow({ where: { nodeId: node.id, status: "running" } });
    const started = await turnJournal(h.app, cut).begin({ name: "hub_create_tasks", arguments: JSON.stringify({ tasks: [{ title: "Confirm the venue" }] }), sideEffect: true });
    assert.ok("ticket" in started);
    await started.ticket.dispatched();
    pc.restart(stop, agent);
    stop = await pc.start();
    await until(async () => (await replies(owner, room.id, node.id)).length === 2, "the resumed turn's reply", 20_000);
    await settleTurns();

    const runs = pc.runs();
    assert.deepEqual(runs.map((run) => [run.id, run.resumed]), [[session!.id, false], [session!.id, true], [session!.id, true]], "the resumed turn went on in the session that took the cut one");
    assert.match(runs[2]!.prompt, /Your previous turn was cut off when Imani's laptop restarted[\s\S]*hub_create_tasks/);
    assert.equal((await h.prisma.nodeTurn.findUniqueOrThrow({ where: { id: cut.id } })).outcome, "interrupted");
    assert.equal((await h.prisma.nodeTurn.findFirstOrThrow({ where: { originTurnId: cut.id } })).outcome, "done");
    assert.deepEqual((await replies(owner, room.id, node.id)).map((row) => [row.kind, row.body]), [["text", "Started."], ["text", "Went on in the same session."]]);
    const conversation = Object.entries(pc.sessions()).find(([, entry]) => entry.id === session!.id);
    assert.ok(conversation, "the chat keeps that session");
    assert.equal(conversation[1].taking, undefined);
  } finally {
    stop();
    pc.close();
    relay.stopComputerTurns(laptop.id);
    await settleTurns();
  }
});
