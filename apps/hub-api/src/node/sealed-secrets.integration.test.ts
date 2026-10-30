/**
 * Encrypted entry of a node's secret request, end to end (B12, docs/35 §8.7): the computer reports its
 * key and the web pins it; the owner's browser seals the value for that key (the Hub's and Node's
 * module, `sealFor`); the hosted API relays only the ciphertext to the computer, whose own code opens
 * it once (credentials/seal.ts, remote/secrets.ts). A canary value is searched for in every table, every
 * log line, every Redis write and every frame the API sent: it is in none of them. Boxes replayed, made
 * for another computer, expired or typed on a site the computer does not trust are refused; a computer
 * too old for a key keeps the TLS path, and a computer whose key changed is asked to pair again.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import type { HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

// The computer's own folder: its key, its replay set and remote.json (never the real data folder).
const deviceData = mkdtempSync(join(homedir(), ".ensemble-sealed-secrets-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = deviceData;
process.env.ENSEMBLE_SECRET_KEY = randomBytes(32).toString("base64");

// Everything the API logs, at the most verbose level, and everything printed.
const logged: string[] = [];
const logStream = new Writable({
  write(chunk, _encoding, done) {
    logged.push(String(chunk));
    done();
  },
});
for (const stream of [process.stdout, process.stderr] as const) {
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    logged.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return write(chunk, ...rest);
  }) as typeof stream.write;
}

const { createHttpHarness } = await import("../test/http.js");
const h = await createHttpHarness({ logger: { level: "trace", stream: logStream } });
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { sseHub } = await import("../lib/sse.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile, sealFor } = await import("@ensemble/shared-types");
const { updateSettings } = await import("../remote/store.js");
const { makeSealKey, saveSealKey, loadSealKey } = await import("../credentials/seal-key.js");
const { secretSaveAnswer } = await import("../remote/secrets.js");
const { decrypt } = await import("../lib/secrets.js");

// Every Redis write the API makes (the relay keeps requests and answers there for a moment).
const redisWrites: string[] = [];
for (const name of ["set", "setex", "publish", "rpush", "lpush", "hset", "sadd"]) {
  const redis = h.app.redis as unknown as Record<string, unknown>;
  const original = redis[name];
  if (typeof original !== "function") continue;
  redis[name] = (...args: unknown[]) => {
    redisWrites.push(JSON.stringify(args));
    return (original as (...a: unknown[]) => unknown).apply(redis, args);
  };
}

after(async () => {
  await h.close();
  rmSync(deviceData, { recursive: true, force: true });
});

type Step = { calls?: Array<{ name: string; arguments: Record<string, unknown> }>; text?: string; then?: string };
let script: (transcript: string) => Step = () => ({ text: "ok" });
const transcripts: string[] = [];
setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  if (!second) transcripts.push(transcript);
  const step = script(transcript);
  const calls = second ? [] : (step.calls ?? []);
  const text = second ? (step.then ?? "Done.") : calls.length ? "" : (step.text ?? "ok");
  const turn: RuntimeTurn = { text, toolCalls: calls.map((call, index) => ({ id: `call-${randomBytes(4).toString("hex")}-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })), model: "test-model", credits: 0, tokensIn: 1, tokensOut: 1, reasoning: "", raw: {}, finishReason: "stop", cutOff: false };
  if (text) args.onDelta?.(text);
  return turn;
});
afterEach(async () => {
  await settleTurns();
  script = () => ({ text: "ok" });
});

const json = (response: LightMyRequestResponse) => response.json() as any;
const NODE_SITE = "https://node.ensemblework.com";

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

/** A computer paired with this server: its key and remote.json live in `deviceData`, as on a real computer. */
async function pairedComputer(user: HttpUser, capabilities: Record<string, unknown>) {
  const key = await h.asToken(user, "device");
  const laptop = await h.prisma.device.create({ data: { userId: user.id, name: "Mira's laptop", platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: { folders: ["app"], engines: ["claude-code"], ...capabilities } as never } });
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "main", name: "Main", engine: "claude-code", deviceId: laptop.id })], defaultRunProfileId: "main" });
  return { laptop, key };
}

/** The computer's own run_secrets table, kept apart from the API's database. */
function computerStore() {
  const rows = new Map<string, { id: string; userId: string; name: string; value: string; allow: unknown }>();
  return {
    rows,
    runSecret: {
      async findUnique({ where }: { where: { userId_name: { name: string } } }) {
        return rows.get(where.userId_name.name) ?? null;
      },
      async count() {
        return rows.size;
      },
      async upsert({ where, create, update }: { where: { userId_name: { name: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) {
        const existing = rows.get(where.userId_name.name);
        const row = existing ? { ...existing, ...update } : ({ id: randomBytes(4).toString("hex"), ...create } as never);
        rows.set(where.userId_name.name, row);
        return row;
      },
    },
  };
}

/** The computer: hears `secret.save` on its stream, answers with its own code. Every frame is kept. */
function listen(deviceId: string, key: { inject: HttpUser["inject"] }, handle: (data: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>) {
  const frames: string[] = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${deviceId}`) return;
    frames.push(JSON.stringify(frame));
    if (frame.event !== "secret.save") return;
    const data = frame.data as Record<string, unknown>;
    setTimeout(() => void handle(data).then((answer) => key.inject({ method: "POST", url: `/api/devices/self/code-requests/${String(data.id)}`, payload: answer })), 5);
  });
  return { frames, stop };
}

async function askForSecret(user: HttpUser, roomId: string, name: string, allow?: string[]) {
  script = (transcript) => (transcript.includes(`need ${name}`) ? { calls: [{ name: "node_secret_request", arguments: { name, why: "To call the payments API in the tests.", ...(allow ? { allow } : {}) } }], then: "Type it in the box." } : { text: "ok" });
  const posted = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body: `I need ${name}` } });
  assert.equal(posted.statusCode, 201, posted.body);
  await settleTurns();
  const messages = json(await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` })).messages as Array<{ id: string; kind: string; data: any }>;
  return messages.filter((row) => row.kind === "approval" && row.data.type === "secret" && row.data.name === name).at(-1)!;
}

/** Every row of every table in the API's database, as JSON text (bytes as hex). */
async function everyTable(): Promise<string> {
  const tables = (await h.prisma.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)) as Array<{ table_name: string }>;
  assert.ok(tables.length > 50, "every table is searched");
  const parts: string[] = [];
  for (const { table_name } of tables) {
    const rows = (await h.prisma.$queryRawUnsafe(`SELECT row_to_json(t)::text AS row FROM "${table_name}" t`)) as Array<{ row: string }>;
    parts.push(...rows.map((item) => item.row));
  }
  return parts.join("\n");
}

test("a secret typed on the web reaches the computer sealed: the API relays only ciphertext and never logs or stores the canary", async () => {
  const mira = await person("Mira");
  const sealKey = makeSealKey();
  const { laptop, key } = await pairedComputer(mira, { secrets: 2, secretHttp: 1 });
  saveSealKey(sealKey, laptop.id);
  updateSettings({ deviceId: laptop.id, apiBase: "https://api.ensemblework.com", pairedAt: new Date().toISOString() });

  // The computer reports its key; the web pins it, and works its id and fingerprint out from the key itself.
  const beat = await key.inject({ method: "POST", url: "/api/devices/self/heartbeat", payload: { capabilities: { secrets: 2, secretHttp: 1, sealKey: loadSealKey()!.info } } });
  assert.equal(beat.statusCode, 200, beat.body);
  const listed = (json(await mira.inject({ method: "GET", url: "/api/devices" })).devices as Array<{ id: string; sealKey: { kid: string; fingerprint: string } | null; sealKeyMismatch: boolean }>).find((row) => row.id === laptop.id)!;
  assert.equal(listed.sealKey?.kid, sealKey.info.kid);
  assert.equal(listed.sealKey?.fingerprint, sealKey.info.fingerprint, "the computer's details show the fingerprint to compare");
  assert.equal(listed.sealKeyMismatch, false);

  const node = json(await mira.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } }));
  const card = await askForSecret(mira, node.room.id, "STRIPE_KEY", ["https://api.stripe.com"]);
  assert.deepEqual(card.data.allow, ["https://api.stripe.com"], "the node's suggestion is on the card for the owner to decide");

  const target = json(await mira.inject({ method: "GET", url: `/api/node/secrets/${card.id}` }));
  assert.equal(target.route.mode, "sealed");
  assert.equal(target.route.sealKey.kid, sealKey.info.kid);
  assert.equal(target.computer.id, laptop.id);

  const CANARY = `sk_live_CANARY_${randomBytes(16).toString("hex")}`;
  const store = computerStore();
  const computer = listen(laptop.id, key, (data) => secretSaveAnswer(data, store as never));
  const sealed = await sealFor(target.route.sealKey, { purpose: "secret", deviceId: laptop.id, decisionId: card.id, name: "STRIPE_KEY", origin: NODE_SITE }, { value: CANARY, allow: ["https://api.stripe.com"] });
  assert.equal(sealed.fingerprint, sealKey.info.fingerprint);
  script = (transcript) => (transcript.includes("saved STRIPE_KEY") ? { text: "Saved; I'll use it by reference." } : { text: "ok" });
  try {
    // A plaintext value is refused for a computer with a key: never relayed.
    const plain = await mira.inject({ method: "POST", url: `/api/node/secrets/${card.id}`, payload: { value: "plain-should-not-go" } });
    assert.equal(plain.statusCode, 400);
    assert.equal(json(plain).code, "seal_required");
    assert.equal(computer.frames.length, 0, "nothing went to the computer");

    const saved = await mira.inject({ method: "POST", url: `/api/node/secrets/${card.id}`, headers: { origin: NODE_SITE }, payload: { sealed: sealed.sealed } });
    assert.equal(saved.statusCode, 200, saved.body);
    await settleTurns();
    assert.equal(json(saved).message.data.status, "saved");
    assert.equal(json(saved).message.data.sealed, true);
    assert.deepEqual(json(saved).message.data.allow, ["https://api.stripe.com"]);
  } finally {
    computer.stop();
  }

  // The computer has it: encrypted with its own key, kept for use by reference to the allowed origin.
  const row = store.rows.get("STRIPE_KEY")!;
  assert.equal(decrypt(row.value), CANARY, "the value arrived on the computer");
  assert.deepEqual(row.allow, ["https://api.stripe.com"]);
  // The API relayed the box as it came, and only the box.
  assert.equal(computer.frames.length, 1);
  assert.ok(computer.frames[0]!.includes(sealed.sealed.ct), "the ciphertext was relayed");
  assert.ok(transcripts.some((text) => /saved STRIPE_KEY on Mira's laptop/.test(text) && /by reference only/.test(text)), "the node hears how runs use it");

  const tables = await everyTable();
  assert.ok(tables.includes(card.id) && tables.includes("node.secret_saved"), "the search reads the rows this test wrote");
  assert.ok(!tables.includes(sealed.sealed.ct), "not even the box is kept");
  assert.ok(logged.join("").includes(`/api/node/secrets/${card.id}`), "the request logs were captured");
  const everything = [tables, logged.join(""), redisWrites.join("\n"), computer.frames.join("\n"), transcripts.join("\n")].join("\n");
  assert.ok(redisWrites.length > 0, "Redis writes were captured");
  assert.ok(!everything.includes(CANARY), "the canary is in no table, log line, Redis write, frame or model input");
  for (const encoded of [Buffer.from(CANARY).toString("base64"), Buffer.from(CANARY).toString("base64url"), Buffer.from(CANARY).toString("hex"), encodeURIComponent(CANARY)]) {
    assert.ok(!everything.includes(encoded), "nor encoded");
  }
});

test("a box is taken once, only for its computer and request, only from a trusted site and before it expires", async () => {
  const mira = await person("Mira");
  const sealKey = makeSealKey();
  const { laptop, key } = await pairedComputer(mira, { secrets: 2 });
  saveSealKey(sealKey, laptop.id);
  updateSettings({ deviceId: laptop.id, apiBase: "https://api.ensemblework.com", pairedAt: new Date().toISOString() });
  await key.inject({ method: "POST", url: "/api/devices/self/heartbeat", payload: { capabilities: { secrets: 2, sealKey: sealKey.info } } });
  const node = json(await mira.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } }));
  const card = await askForSecret(mira, node.room.id, "PAYMENTS_API_KEY");
  const store = computerStore();
  const box = (over: Partial<{ deviceId: string; decisionId: string; name: string; origin: string }> = {}, now?: number) =>
    sealFor(sealKey.info, { purpose: "secret", deviceId: laptop.id, decisionId: card.id, name: "PAYMENTS_API_KEY", origin: NODE_SITE, ...over }, { value: "v-1" }, now ? { now } : {});
  const frame = async (over: Parameters<typeof box>[0] = {}, now?: number) => ({ id: randomBytes(8).toString("hex"), name: "PAYMENTS_API_KEY", decisionId: card.id, sealed: (await box(over, now)).sealed });

  // The API refuses a box bound to something else before it goes anywhere.
  const post = async (sealed: unknown, origin = NODE_SITE) => mira.inject({ method: "POST", url: `/api/node/secrets/${card.id}`, headers: { origin }, payload: { sealed } });
  for (const [over, why] of [
    [{ deviceId: "another-computer" }, /another computer/],
    [{ decisionId: "another-card" }, /another request/],
    [{ name: "OTHER_KEY" }, /another secret/],
  ] as const) {
    const refused = await post((await box(over)).sealed);
    assert.equal(refused.statusCode, 400);
    assert.match(json(refused).error, why);
  }
  assert.match(json(await post((await box({}, Date.now() - 11 * 60_000)).sealed)).error, /expired/);
  assert.match(json(await post((await box()).sealed, "https://evil.example")).error, /another site/, "the box must name the page that sent it");

  // The computer checks for itself, whatever the relay says.
  const refusedHere = async (data: Record<string, unknown>) => {
    const answer = await secretSaveAnswer(data, store as never);
    assert.ok(answer.status >= 400, JSON.stringify(answer));
    return String(answer.body.code);
  };
  assert.equal(await refusedHere(await frame({ deviceId: "another-computer" })), "seal_device");
  assert.equal(await refusedHere(await frame({ origin: "https://evil.example" })), "seal_origin", "a site this computer does not trust");
  assert.equal(await refusedHere(await frame({}, Date.now() - 11 * 60_000)), "seal_expired");
  assert.equal(await refusedHere({ ...(await frame()), decisionId: "another-card" }), "seal_decision");
  assert.equal(await refusedHere({ ...(await frame()), name: "OTHER_KEY" }), "seal_name");
  const tampered = await frame();
  const aad = JSON.parse(Buffer.from(tampered.sealed.aad, "base64url").toString("utf8"));
  assert.equal(await refusedHere({ ...tampered, sealed: { ...tampered.sealed, aad: Buffer.from(JSON.stringify({ ...aad, expiresAt: new Date(Date.now() + 9 * 60_000).toISOString() })).toString("base64url") } }), "seal_open", "a rewritten expiry breaks the box");
  assert.equal(store.rows.size, 0, "nothing was saved");

  // A good box once; the same box again, or a new one for the same request, is refused.
  const good = await frame();
  assert.equal((await secretSaveAnswer(good, store as never)).status, 200);
  assert.equal(await refusedHere(good), "seal_replay");
  assert.equal(await refusedHere(await frame()), "seal_replay", "the request was already answered here");
  assert.equal(decrypt(store.rows.get("PAYMENTS_API_KEY")!.value), "v-1");
  assert.equal(store.rows.get("PAYMENTS_API_KEY")!.allow, undefined, "no destinations: an environment secret");
});

test("a computer too old for a key keeps the TLS path and the card says so; a computer whose key changed must be paired again", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await pairedComputer(mira, { secrets: 1 });
  const node = json(await mira.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } }));
  const card = await askForSecret(mira, node.room.id, "LEGACY_TOKEN");
  const target = json(await mira.inject({ method: "GET", url: `/api/node/secrets/${card.id}` }));
  assert.equal(target.route.mode, "tls", "no key: the value goes over HTTPS through the server");

  const heard: Array<Record<string, unknown>> = [];
  const old = listen(laptop.id, key, async (data) => {
    heard.push(data);
    return { status: 200, body: { saved: true, name: data.name } };
  });
  try {
    const someKey = makeSealKey();
    const sealed = await sealFor(someKey.info, { purpose: "secret", deviceId: laptop.id, decisionId: card.id, name: "LEGACY_TOKEN", origin: NODE_SITE }, { value: "x" });
    const refused = await mira.inject({ method: "POST", url: `/api/node/secrets/${card.id}`, payload: { sealed: sealed.sealed } });
    assert.equal(refused.statusCode, 409);
    assert.equal(json(refused).code, "seal_unsupported");
    const LEGACY = `legacy_CANARY_${randomBytes(12).toString("hex")}`;
    const saved = await mira.inject({ method: "POST", url: `/api/node/secrets/${card.id}`, payload: { value: LEGACY } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(json(saved).message.data.sealed, false, "the card records it was not end to end");
    assert.deepEqual(heard.map((row) => [row.name, row.value]), [["LEGACY_TOKEN", LEGACY]]);
    // Over TLS the server sees the value and passes it on; it still keeps and logs none of it.
    assert.ok(!(await everyTable()).includes(LEGACY) && !logged.join("").includes(LEGACY), "relayed, never kept or logged");
  } finally {
    old.stop();
  }

  // The computer is updated: it reports a key, which is pinned. Then it reports another: nothing is sent until it is paired again.
  const first = makeSealKey();
  await key.inject({ method: "POST", url: "/api/devices/self/heartbeat", payload: { capabilities: { secrets: 2, sealKey: first.info } } });
  const second = makeSealKey();
  await key.inject({ method: "POST", url: "/api/devices/self/heartbeat", payload: { capabilities: { secrets: 2, sealKey: second.info } } });
  const row = await h.prisma.device.findUniqueOrThrow({ where: { id: laptop.id } });
  assert.equal((row.sealKey as { kid: string }).kid, first.info.kid, "the first key stays pinned");
  const listed = (json(await mira.inject({ method: "GET", url: "/api/devices" })).devices as Array<{ id: string; sealKeyMismatch: boolean }>).find((item) => item.id === laptop.id)!;
  assert.equal(listed.sealKeyMismatch, true);
  const card2 = await askForSecret(mira, node.room.id, "NEXT_TOKEN");
  assert.equal(json(await mira.inject({ method: "GET", url: `/api/node/secrets/${card2.id}` })).route.mode, "pair_again");
  const stolen = await sealFor(second.info, { purpose: "secret", deviceId: laptop.id, decisionId: card2.id, name: "NEXT_TOKEN", origin: NODE_SITE }, { value: "x" });
  const blocked = await mira.inject({ method: "POST", url: `/api/node/secrets/${card2.id}`, payload: { sealed: stolen.sealed } });
  assert.equal(blocked.statusCode, 409);
  assert.equal(json(blocked).code, "pair_again");
  assert.ok(await h.prisma.auditLedger.findFirst({ where: { userId: mira.id, action: "device.seal_key_mismatch" } }), "the change is in the ledger");

  // A key that is not a P-256 key, or whose id is not its own hash, is never pinned.
  const other = await pairedComputer(mira, { secrets: 2 });
  await other.key.inject({ method: "POST", url: "/api/devices/self/heartbeat", payload: { capabilities: { secrets: 2, sealKey: { ...first.info, kid: "0000000000000000" } } } });
  assert.equal((await h.prisma.device.findUniqueOrThrow({ where: { id: other.laptop.id } })).sealKey, null);

  // Unpaired: the web stops offering it.
  await mira.inject({ method: "DELETE", url: `/api/devices/${laptop.id}` });
  assert.equal((await mira.inject({ method: "GET", url: `/api/node/secrets/${card2.id}` })).statusCode, 409);
});

test("a node's secret_http goes to its owner's computer as a call by reference: the name and address, never a value", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await pairedComputer(mira, { secrets: 2, secretHttp: 1, nodeTools: 1 });
  const node = json(await mira.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } }));
  const calls: Array<Record<string, unknown>> = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${laptop.id}` || frame.event !== "node.tool.request") return;
    const data = frame.data as Record<string, unknown>;
    calls.push(data);
    const answer = { status: 200, body: { status: 200, url: data.url, headers: { "content-type": "application/json" }, body: '{"balance":"[STRIPE_KEY] ok"}', truncated: false, binary: false } };
    setTimeout(() => void key.inject({ method: "POST", url: `/api/devices/self/code-requests/${String(data.id)}`, payload: answer }), 5);
  });
  const call = { name: "secret_http", arguments: { ref: "STRIPE_KEY", url: "https://api.stripe.com/v1/balance", headers: { Authorization: "Bearer {{STRIPE_KEY}}" } } };
  try {
    script = (transcript) => (transcript.includes("check my balance") ? { calls: [call], then: "Your balance is fine." } : { text: "ok" });
    await mira.inject({ method: "POST", url: `/api/node/rooms/${node.room.id}/messages`, payload: { body: "check my balance" } });
    await settleTurns();
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0]!.tool, calls[0]!.ref, calls[0]!.url], ["secret_http", "STRIPE_KEY", "https://api.stripe.com/v1/balance"]);
    assert.deepEqual(calls[0]!.headers, { Authorization: "Bearer {{STRIPE_KEY}}" }, "the placeholder travels, the value is put in on the computer");
    const reply = (json(await mira.inject({ method: "GET", url: `/api/node/rooms/${node.room.id}/messages` })).messages as Array<{ body: string; data: any }>).at(-1)!;
    assert.match(reply.body, /balance is fine/);
    assert.ok(await h.prisma.auditLedger.findFirst({ where: { userId: mira.id, action: "node.device_tool.secret_http" } }));

    // An older computer is asked to update; nothing is sent.
    await h.prisma.device.update({ where: { id: laptop.id }, data: { capabilities: { secrets: 2, nodeTools: 1 } } });
    script = (transcript) => (transcript.includes("again please") ? { calls: [call], then: "Could not." } : { text: "ok" });
    await mira.inject({ method: "POST", url: `/api/node/rooms/${node.room.id}/messages`, payload: { body: "again please" } });
    await settleTurns();
    assert.equal(calls.length, 1, "nothing went to the older computer");
    const tools = JSON.stringify((await h.prisma.nodeMessage.findMany({ where: { roomId: node.room.id, authorKind: "node" }, orderBy: { createdAt: "desc" }, take: 1 }))[0]?.data);
    assert.match(tools, /too old to use a saved secret by reference/);
  } finally {
    stop();
  }
});
