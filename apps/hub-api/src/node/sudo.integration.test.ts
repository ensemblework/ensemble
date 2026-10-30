/**
 * A node runs a command as the administrator (node/sudo.ts, nodeTools 2), end to end from the server's
 * side: the node's call puts the exact command on an owner-only card in the chat and waits; the owner's
 * browser reads the computer's pinned key and seals the password for it (the Hub's and Node's module,
 * `sealFor`); the API relays the box once, from memory, with the command and its hash, and the call
 * returns what the command printed. A canary password is in no table, log line, Redis write or model
 * input. No on the card is heard as no; the hard floor refuses a catastrophic command before any card;
 * an older computer is asked to update; a turn not answered in time parks, a later answer runs it from
 * the route and wakes the node with how it went, and a card nobody answers expires. The computer is
 * simulated: it hears frames on its event stream, opens the box with its own key, and answers.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import type { HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

// The computer's own folder: its key and remote.json (never the real data folder).
const deviceData = mkdtempSync(join(homedir(), ".ensemble-sudo-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = deviceData;
process.env.ENSEMBLE_SECRET_KEY = randomBytes(32).toString("base64");
process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS = "60000";

const logged: string[] = [];
const logStream = new Writable({
  write(chunk, _encoding, done) {
    logged.push(String(chunk));
    done();
  },
});

const { createHttpHarness } = await import("../test/http.js");
const h = await createHttpHarness({ logger: { level: "trace", stream: logStream } });
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { sseHub } = await import("../lib/sse.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile, sealFor } = await import("@ensemble/shared-types");
const { updateSettings } = await import("../remote/store.js");
const { makeSealKey, saveSealKey, loadSealKey } = await import("../credentials/seal-key.js");
const { checkAad, openSealed } = await import("../credentials/seal.js");
const { expireSudo } = await import("./sudo.js");

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
/** Everything every model call was given. */
const modelInputs: string[] = [];
setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  modelInputs.push(JSON.stringify(messages));
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
const waitSetting = process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS;
afterEach(async () => {
  await settleTurns();
  script = () => ({ text: "ok" });
  transcripts.length = 0;
  process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS = waitSetting;
});

const json = (response: LightMyRequestResponse) => response.json() as any;
const NODE_SITE = "https://node.ensemblework.com";
const INSTALL = "apt-get install -y xvfb";
const hashOf = (command: string) => createHash("sha256").update(command).digest("hex");

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

/** A computer paired with this server, new enough for sudo, its key pinned on the web. */
async function pairedComputer(user: HttpUser) {
  const key = await h.asToken(user, "device");
  const capabilities = { folders: ["app"], engines: ["claude-code"], nodeTools: 2, secrets: 2 };
  const laptop = await h.prisma.device.create({ data: { userId: user.id, name: "Mira's laptop", platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: capabilities as never } });
  const sealKey = makeSealKey();
  saveSealKey(sealKey, laptop.id);
  updateSettings({ deviceId: laptop.id, apiBase: "https://api.ensemblework.com", pairedAt: new Date().toISOString() });
  const beat = await key.inject({ method: "POST", url: "/api/devices/self/heartbeat", payload: { capabilities: { ...capabilities, sealKey: loadSealKey()!.info } } });
  assert.equal(beat.statusCode, 200, beat.body);
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "main", name: "Main", engine: "claude-code", mode: "ask", deviceId: laptop.id })], defaultRunProfileId: "main" });
  return { laptop, key, sealKey };
}

/** The computer: hears sudo requests, opens a sealed password with its own key (bound to the card and the command), and answers. */
function listen(deviceId: string, key: { inject: HttpUser["inject"] }) {
  const heard: Array<Record<string, unknown>> = [];
  const frames: string[] = [];
  const passwords: string[] = [];
  const problems: string[] = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${deviceId}`) return;
    frames.push(JSON.stringify(frame));
    if (frame.event !== "node.tool.request") return;
    const data = frame.data as Record<string, unknown> & { id: string; command: string; commandHash: string; cardId: string; sealed?: never };
    heard.push(data);
    let answer: { status: number; body: Record<string, unknown> } = { status: 200, body: { exitCode: 0, output: `Setting up ${data.command.split(" ").at(-1)} ...\n`, ms: 1200 } };
    try {
      if (data.sealed) {
        const own = loadSealKey()!;
        const opened = openSealed(data.sealed, { kid: own.info.kid, privateKey: own.privateKey });
        checkAad(opened.aad, { purpose: "sudo", kid: own.info.kid, deviceId, decisionId: data.cardId, name: data.commandHash, origins: [NODE_SITE] });
        if (createHash("sha256").update(data.command).digest("hex") !== data.commandHash) throw new Error("the box is for another command");
        passwords.push(String((JSON.parse(opened.plaintext.toString("utf8")) as { password: string }).password));
      } else answer = { status: 200, body: { exitCode: 1, output: "sudo: a password is required\n" } };
    } catch (error) {
      problems.push(String(error));
      answer = { status: 400, body: { error: String(error) } };
    }
    setTimeout(() => void key.inject({ method: "POST", url: `/api/devices/self/code-requests/${data.id}`, payload: answer }), 5);
  });
  return { heard, frames, passwords, problems, stop };
}

async function createNode(user: HttpUser) {
  const response = await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  assert.equal(response.statusCode, 201, response.body);
  return json(response) as { node: { id: string; slug: string }; room: { id: string } };
}

async function post(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
}

type Row = { id: string; kind: string; body: string; private: boolean; authorNodeId: string | null; data: Record<string, any> };
const rows = async (user: HttpUser, roomId: string) => json(await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` })).messages as Row[];

async function until<T>(check: () => Promise<T | null | undefined | false>, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sudoCard = (user: HttpUser, roomId: string, command = INSTALL) => until(async () => (await rows(user, roomId)).find((row) => row.kind === "approval" && row.data.type === "sudo" && row.data.command === command && row.data.status === "pending"), "the sudo card");

/** Every row of every table in the API's database, as JSON text. */
async function everyTable(): Promise<string> {
  const tables = (await h.prisma.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)) as Array<{ table_name: string }>;
  const parts: string[] = [];
  for (const { table_name } of tables) {
    const found = (await h.prisma.$queryRawUnsafe(`SELECT row_to_json(t)::text AS row FROM "${table_name}" t`)) as Array<{ row: string }>;
    parts.push(...found.map((item) => item.row));
  }
  return parts.join("\n");
}

const install = (command = INSTALL): Step => ({ calls: [{ name: "computer_sudo", arguments: { command, reason: "To install Xvfb so apps can be captured." } }], then: "Installed." });

test("the owner approves the exact command with their password, sealed for the computer; the call waits and gets the output; the password is nowhere", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await pairedComputer(mira);
  const computer = listen(laptop.id, key);
  const { node, room } = await createNode(mira);
  try {
    script = (transcript) => (transcript.includes("install xvfb") ? install() : { text: "ok" });
    await post(mira, room.id, "install xvfb please");
    const card = await sudoCard(mira, room.id);
    assert.equal(card.body, `@${node.slug} wants to run as administrator on Mira's laptop: ${INSTALL}`);
    assert.equal(card.private, true);
    assert.deepEqual((await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: card.id } })).visibleTo, [mira.id], "only the owner sees it");
    assert.deepEqual(
      [card.data.status, card.data.command, card.data.commandHash, card.data.reason, card.data.deviceId, card.data.deviceName, card.data.folder, card.data.exitCode, card.data.answeredAt],
      ["pending", INSTALL, hashOf(INSTALL), "To install Xvfb so apps can be captured.", laptop.id, "Mira's laptop", null, null, null],
    );
    assert.equal(computer.heard.length, 0, "nothing runs before the owner answers");

    // Answered only in the Node chat: not in the Hub's Needs me or the CLI; Node's activity keeps it.
    assert.ok(!(json(await mira.inject({ method: "GET", url: "/api/node/approvals" })).approvals as Array<{ id: string }>).some((row) => row.id === card.id));
    assert.equal(json(await mira.inject({ method: "GET", url: "/api/shell" })).nodeApprovals, 0);
    assert.ok((json(await mira.inject({ method: "GET", url: "/api/node/activity" })).approvals as Array<{ id: string }>).some((row) => row.id === card.id));

    const target = json(await mira.inject({ method: "GET", url: `/api/node/sudo/${card.id}` }));
    assert.deepEqual([target.command, target.commandHash, target.deviceName, target.route.mode], [INSTALL, hashOf(INSTALL), "Mira's laptop", "sealed"]);
    assert.equal(target.route.sealKey.kid, loadSealKey()!.info.kid);
    const ben = await person("Ben");
    assert.equal((await ben.inject({ method: "GET", url: `/api/node/sudo/${card.id}` })).statusCode, 404, "only its owner");
    assert.equal((await ben.inject({ method: "POST", url: `/api/node/sudo/${card.id}`, payload: { action: "deny" } })).statusCode, 404);

    const CANARY = `pw-CANARY-${randomBytes(12).toString("hex")}`;
    const box = (over: Partial<{ decisionId: string; name: string; origin: string }> = {}) => sealFor(target.route.sealKey, { purpose: "sudo", deviceId: laptop.id, decisionId: card.id, name: hashOf(INSTALL), origin: NODE_SITE, ...over }, { password: CANARY });
    const answer = (body: Record<string, unknown>, origin = NODE_SITE) => mira.inject({ method: "POST", url: `/api/node/sudo/${card.id}`, headers: { origin }, payload: body });
    // A box for another card, another command or another site is refused before anything is sent.
    for (const [over, why] of [[{ decisionId: "another-card" }, /another request/], [{ name: hashOf("rm -rf ~/tmp") }, /another request/], [{ origin: "https://evil.example" }, /another site/]] as const) {
      const refused = await answer({ action: "run", sealed: (await box(over)).sealed });
      assert.equal(refused.statusCode, 400, refused.body);
      assert.match(json(refused).error, why);
    }
    assert.equal(computer.heard.length, 0);

    const sealed = await box();
    const ran = await answer({ action: "run", sealed: sealed.sealed });
    assert.equal(ran.statusCode, 200, ran.body);
    assert.equal(json(ran).message.data.status, "running");
    await settleTurns();
    assert.equal(computer.heard.length, 1);
    const relayed = computer.heard[0]!;
    assert.deepEqual([relayed.tool, relayed.command, relayed.commandHash, relayed.cardId, relayed.nodeSlug], ["sudo", INSTALL, hashOf(INSTALL), card.id, node.slug]);
    assert.deepEqual(computer.problems, []);
    assert.deepEqual(computer.passwords, [CANARY], "the computer opened it, once");
    const done = (await rows(mira, room.id)).find((row) => row.id === card.id)!;
    assert.deepEqual([done.data.status, done.data.exitCode], ["done", 0]);
    const reply = (await rows(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind === "text").at(-1)!;
    assert.equal(reply.body, "Installed.");
    assert.match(reply.data.tools[0].summary, /Ran as administrator on Mira's laptop: exit code 0/);
    assert.equal((await answer({ action: "deny" })).statusCode, 409, "answered once");

    // The password: in no table, log line, Redis write or model input; the box itself is kept nowhere.
    const tables = await everyTable();
    assert.ok(tables.includes(card.id) && tables.includes("node.sudo.answered"), "the search reads the rows this test wrote");
    assert.ok(!tables.includes(sealed.sealed.ct), "not even the box is kept");
    assert.ok(logged.join("").includes(`/api/node/sudo/${card.id}`), "the request logs were captured");
    const everything = [tables, logged.join(""), redisWrites.join("\n"), modelInputs.join("\n")].join("\n");
    for (const form of [CANARY, Buffer.from(CANARY).toString("base64"), Buffer.from(CANARY).toString("base64url"), Buffer.from(CANARY).toString("hex")]) assert.ok(!everything.includes(form), "the password is nowhere");
  } finally {
    computer.stop();
  }
});

test("no is heard as no; the hard floor refuses before any card; an older computer is asked to update", async () => {
  const mira = await person("Mira");
  const { laptop, key } = await pairedComputer(mira);
  const computer = listen(laptop.id, key);
  const { node, room } = await createNode(mira);
  try {
    script = (transcript) => (transcript.includes("restart nginx") ? install("systemctl restart nginx") : { text: "ok" });
    await post(mira, room.id, "restart nginx");
    const card = await sudoCard(mira, room.id, "systemctl restart nginx");
    const denied = await mira.inject({ method: "POST", url: `/api/node/sudo/${card.id}`, payload: { action: "deny" } });
    assert.equal(denied.statusCode, 200, denied.body);
    await settleTurns();
    assert.equal(json(denied).message.data.status, "denied");
    assert.equal(computer.heard.length, 0);
    const reply = (await rows(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind === "text").at(-1)!;
    assert.match(reply.data.tools[0].summary, /Your owner chose not to run `systemctl restart nginx` as administrator on Mira's laptop/);

    const cards = (await rows(mira, room.id)).filter((row) => row.data.type === "sudo").length;
    script = (transcript) => (transcript.includes("wipe") ? install("rm -rf /") : { text: "ok" });
    await post(mira, room.id, "wipe it all");
    await settleTurns();
    assert.equal((await rows(mira, room.id)).filter((row) => row.data.type === "sudo").length, cards, "no card for a command nobody may run");
    assert.match((await rows(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind === "text").at(-1)!.data.tools[0].summary, /Refused by Ensemble's hard floor/);

    await h.prisma.device.update({ where: { id: laptop.id }, data: { capabilities: { folders: ["app"], engines: ["claude-code"], nodeTools: 1 } } });
    script = (transcript) => (transcript.includes("install xvfb") ? install() : { text: "ok" });
    await post(mira, room.id, "install xvfb");
    await settleTurns();
    assert.match((await rows(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind === "text").at(-1)!.data.tools[0].summary, /Update Ensemble on Mira's laptop \(`ensemble update`, or the desktop app's update\) to run commands as the administrator there/);
    assert.equal(computer.heard.length, 0);
  } finally {
    computer.stop();
  }
});

test("not answered in time: the turn parks; a later answer runs it from the route and wakes the node; a card nobody answers expires", async () => {
  process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS = "300";
  const mira = await person("Mira");
  const { laptop, key } = await pairedComputer(mira);
  const computer = listen(laptop.id, key);
  const { node, room } = await createNode(mira);
  try {
    script = (transcript) => (transcript.includes("install xvfb") ? install() : transcript.includes("Your owner approved running") ? { text: "Xvfb could not be installed: it needs your password." } : { text: "ok" });
    await post(mira, room.id, "install xvfb");
    await settleTurns();
    const card = await sudoCard(mira, room.id);
    assert.deepEqual((await rows(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind === "text"), [], "no reply while it waits");
    const conversation = (await h.prisma.nodeRoomMember.findFirstOrThrow({ where: { roomId: room.id, nodeId: node.id } })).conversationId!;
    const note = await h.prisma.assistantMessage.findFirstOrThrow({ where: { conversationId: conversation, role: "assistant" }, orderBy: { createdAt: "desc" } });
    assert.equal(note.content, `Waiting for Mira to answer the card about running \`${INSTALL}\` as administrator on Mira's laptop.`);

    // Run without a password: relayed from the route (sudo -n), and the node hears how it went.
    const ran = await mira.inject({ method: "POST", url: `/api/node/sudo/${card.id}`, payload: { action: "run" } });
    assert.equal(ran.statusCode, 200, ran.body);
    await until(async () => transcripts.some((text) => text.includes("Your owner approved running")), "the node to be woken");
    await settleTurns();
    assert.equal(computer.heard.length, 1);
    assert.equal(computer.heard[0]!.sealed, undefined, "no password: none is sent");
    const woken = transcripts.find((text) => text.includes("Your owner approved running"))!;
    assert.match(woken, /It ended with exit code 1\.\nIts output ends:\nsudo: a password is required/);
    assert.deepEqual([(await rows(mira, room.id)).find((row) => row.id === card.id)!.data.status], ["failed"]);

    // Another card nobody answers: it closes, and the node hears it did not run.
    script = (transcript) => (transcript.includes("restart nginx") ? install("systemctl restart nginx") : transcript.includes("in time") ? { text: "It was not restarted." } : { text: "ok" });
    await post(mira, room.id, "restart nginx");
    await settleTurns();
    const second = await sudoCard(mira, room.id, "systemctl restart nginx");
    await expireSudo(h.app, second.id);
    assert.equal((await rows(mira, room.id)).find((row) => row.id === second.id)!.data.status, "pending", "not before its time");
    const stored = await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: second.id } });
    await h.prisma.nodeMessage.update({ where: { id: second.id }, data: { data: { ...(stored.data as Record<string, unknown>), expiresAt: new Date(Date.now() - 1000).toISOString() } } });
    const late = await mira.inject({ method: "POST", url: `/api/node/sudo/${second.id}`, payload: { action: "run" } });
    assert.equal(late.statusCode, 409);
    assert.equal(json(late).code, "expired");
    await settleTurns();
    assert.equal((await rows(mira, room.id)).find((row) => row.id === second.id)!.data.status, "expired");
    assert.ok(transcripts.some((text) => /did not answer the card about running `systemctl restart nginx` as administrator on Mira's laptop in time/.test(text)), "the node hears it closed");
    assert.equal(computer.heard.length, 1, "it never ran");
  } finally {
    computer.stop();
  }
});
