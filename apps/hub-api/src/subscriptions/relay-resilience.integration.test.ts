/**
 * A turn the web relays to the owner's computer when that computer restarts, or its connection drops
 * (docs/25 §4.9, docs/35 §5.8), through Ensemble's real routes on an in-memory database. The computer is
 * simulated by its requests (each runtime with its own instance id and event stream), or is the real
 * computer-side code (remote/assistant.ts) talking HTTP to this API through a link that loses answers.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";

const h = await createHttpHarness();
const { sseHub } = await import("../lib/sse.js");
const relay = await import("./relay.js");
const { settleTurns } = await import("../node/queue.js");
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
