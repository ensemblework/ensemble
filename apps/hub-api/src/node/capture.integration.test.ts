/**
 * A node's browser and capture tools, end to end (docs/35 §8.16): the node calls them in its owner's
 * DM, each goes to the owner's computer as `node.tool.request`, and the computer answers with the real
 * tool layer (a headless Chromium against a local server) and its real answer and evidence code, over
 * a simulated event stream and the real device routes. What it captures is the node's own evidence:
 * the owner opens it, and it comes with the node's reply (or what `node_show` chose). A capture the computer holds (a site the owner previews
 * first) waits on an owner-only card: previewed from the computer, released (uploaded, then usable) or
 * discarded (gone on both sides). A run's held capture gets the same card where its run is followed,
 * and a run's live view reaches its owner only. Plan reports show only media a passing check names
 * when the requirement asks for pictures. Browser parts skip without a Chromium.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const scratch = mkdtempSync(join(homedir(), ".ensemble-node-capture-"));
// The simulated computer's own data folder: its evidence folders and settings.
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(scratch, "computer");
const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
const { sseHub } = await import("../lib/sse.js");
const { answerNodeToolRequest } = await import("../device-tools/answer.js");
const { answerEvidenceRequest } = await import("../evidence/requests.js");
const { configureBrowser, browserBroker, shutdownBrowser } = await import("../browser/index.js");
const { shutdownCapture } = await import("../capture/index.js");
const { missionMedia } = await import("./media.js");
const { operationEvidenceDir } = await import("../evidence/files.js");

const privacy: { previewFirst: string[] } = { previewFirst: [] };
configureBrowser({ privacy: async () => ({ previewFirst: privacy.previewFirst }) });
const chromium = browserBroker().chromium(true);
const noBrowser = chromium ? false : "no Chromium on this computer (`ensemble capture setup` installs one)";

const site = createServer((request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(`<!doctype html><title>Sign up</title><body style="background:#fff"><h1>Create your account</h1><label>Email <input name="email"></label><button>Sign up</button></body>`);
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

after(async () => {
  await shutdownCapture().catch(() => undefined);
  await shutdownBrowser().catch(() => undefined);
  site.close();
  await h.close();
  rmSync(scratch, { recursive: true, force: true });
});

type Call = { name: string; arguments: Record<string, unknown> };
type Seen = { transcript: string; tools: string[] };
let script: (turn: Seen) => { calls?: Call[]; text?: string; then?: string } = () => ({ text: "ok" });
const seen: Seen[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const current: Seen = { transcript, tools: ((args.chatTools ?? []) as Array<{ function: { name: string } }>).map((spec) => spec.function.name) };
  if (!second) seen.push(current);
  const step = script(current);
  const calls = second ? [] : (step.calls ?? []);
  const text = second ? (step.then ?? "Done.") : calls.length ? "" : (step.text ?? "ok");
  const turn: RuntimeTurn = {
    text,
    toolCalls: calls.map((call, index) => ({ id: `call-${randomBytes(4).toString("hex")}-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })),
    model: "test-model",
    credits: 0,
    tokensIn: 10,
    tokensOut: 5,
    reasoning: "",
    raw: {},
    finishReason: "stop",
    cutOff: false,
  };
  if (text) args.onDelta?.(text);
  return turn;
});

afterEach(async () => {
  await settleTurns();
  seen.length = 0;
  script = () => ({ text: "ok" });
  privacy.previewFirst = [];
});

const json = (response: LightMyRequestResponse) => response.json() as any;

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

/** Evidence rows as the computer's own database keeps them, in memory. */
function computerDatabase() {
  const evidence: Array<Record<string, unknown>> = [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => (value && typeof value === "object" && "in" in (value as object) ? ((value as { in: unknown[] }).in).includes(row[key]) : row[key] === value));
  return {
    evidence,
    jobEvidence: {
      count: async ({ where }: { where: Record<string, unknown> }) => evidence.filter((row) => matches(row, where)).length,
      findFirst: async ({ where }: { where: Record<string, unknown> }) => evidence.find((row) => matches(row, where)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => evidence.find((row) => row.id === where.id) ?? null,
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => evidence.filter((row) => matches(row, where ?? {})),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { jobId: null, nodeId: null, operation: null, held: false, holdReason: null, variantOf: null, variant: null, details: null, caption: null, requirementId: null, local: false, createdAt: new Date(), ...data };
        evidence.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(evidence.find((row) => row.id === where.id)!, data),
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const gone = evidence.filter((row) => matches(row, where));
        for (const row of gone) evidence.splice(evidence.indexOf(row), 1);
        return { count: gone.length };
      },
    },
    decisionRule: { findFirst: async () => null, create: async ({ data }: { data: unknown }) => data, findMany: async () => [] },
    runSecret: { findMany: async () => [] },
  };
}

/**
 * Mira's computer: it hears its event stream and answers with the real device code (the tool layer, the
 * answer and evidence modules), posting back through the real device routes with its device key.
 */
async function computerFor(user: HttpUser, capabilities: Record<string, unknown> = { nodeTools: 1, browser: 1, capture: { browser: true } }) {
  const key = await h.asToken(user, "device");
  const laptop = await h.prisma.device.create({ data: { userId: user.id, name: "Mira's laptop", platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: { folders: ["app"], engines: ["claude-code"], ...capabilities } as never } });
  await saveSettings(h.prisma, user.id, { runProfiles: [RunProfile.parse({ id: "main", name: "Main", engine: "claude-code", mode: "unattended", delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "main" });
  const db = computerDatabase();
  const heard: Array<{ event: string; data: Record<string, unknown> }> = [];
  const client = {
    answerCode: async (id: string, answer: unknown) => {
      await key.inject({ method: "POST", url: `/api/devices/self/code-requests/${id}`, payload: answer as never });
    },
    uploadEvidenceFile: async (uploadId: string, meta: unknown, bytes: Uint8Array) => {
      const response = await key.inject({
        method: "POST",
        url: `/api/devices/self/evidence-uploads/${uploadId}`,
        headers: { "content-type": "application/octet-stream", "x-ensemble-evidence": Buffer.from(JSON.stringify(meta)).toString("base64url") },
        ...(bytes.byteLength ? { payload: Buffer.from(bytes) } : {}),
      });
      if (response.statusCode === 404 || response.statusCode === 410) return { result: "gone" as const, error: json(response).error };
      if (response.statusCode >= 400) return { result: "refused" as const, error: json(response).error };
      return { result: "stored" as const, evidence: json(response).evidence };
    },
    toolOutput: async () => true,
  };
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${laptop.id}`) return;
    const data = frame.data as Record<string, unknown>;
    heard.push({ event: frame.event, data });
    if (frame.event === "node.tool.request") void answerNodeToolRequest({ prisma: db } as never, client as never, data);
    if (frame.event === "evidence.request") void answerEvidenceRequest({ prisma: db } as never, client as never, data);
  });
  return { key, laptop, db, heard, stop };
}

async function createNode(user: HttpUser) {
  const response = await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  assert.equal(response.statusCode, 201, response.body);
  return json(response) as { node: { id: string; slug: string }; room: { id: string } };
}

async function say(user: HttpUser, roomId: string, body: string) {
  const response = await user.inject({ method: "POST", url: `/api/node/rooms/${roomId}/messages`, payload: { body } });
  assert.equal(response.statusCode, 201, response.body);
  await settleTurns();
}

type Row = { id: string; kind: string; authorNodeId: string | null; body: string; private: boolean; data: { type?: string; status?: string; evidence?: Array<{ id: string; held?: boolean }>; media?: Array<{ evidenceId: string }>; tools?: Array<{ name: string; state: string; summary: string | null }>; nodeCapture?: boolean; result?: unknown } };

async function messages(user: HttpUser, roomId: string): Promise<Row[]> {
  return json(await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` })).messages as Row[];
}

async function until(check: () => Promise<boolean>, what: string) {
  for (let tries = 0; tries < 100; tries += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settleTurns();
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("a node browses and captures on its owner's computer; the capture is its evidence, and node_show attaches it", { skip: noBrowser, timeout: 180_000 }, async () => {
  const mira = await person("Mira");
  const computer = await computerFor(mira);
  const { node, room } = await createNode(mira);
  try {
    script = (turn) =>
      turn.transcript.includes("check the sign-up page")
        ? {
            calls: [
              { name: "browser_open", arguments: { url: `${base}/signup` } },
              { name: "browser_snapshot", arguments: { tab: "t1" } },
              { name: "capture_screenshot", arguments: { target: "web", url: `${base}/signup`, name: "signup" } },
            ],
            then: "The sign-up page works.",
          }
        : { text: "ok" };
    await say(mira, room.id, "check the sign-up page");
    assert.ok(["browser_open", "browser_snapshot", "browser_screenshot", "capture_screenshot", "capture_check", "capture_app_start"].every((name) => seen[0]!.tools.includes(name)), "a DM with its owner has the browser and capture tools");
    const asked = computer.heard.filter((frame) => frame.event === "node.tool.request");
    assert.deepEqual(asked.map((frame) => [frame.data.tool, frame.data.name]), [["browser", "browser_open"], ["browser", "browser_snapshot"], ["capture", "capture_screenshot"]]);
    const operation = `node:${node.id}:own`;
    assert.ok(asked.every((frame) => frame.data.operation === operation), "one operation for the node: its tab lasts across calls and conversations");
    const reply = (await messages(mira, room.id)).filter((row) => row.authorNodeId === node.id).at(-1)!;
    assert.deepEqual(reply.data.tools!.map((tool) => [tool.name, tool.state]), [["browser_open", "ok"], ["browser_snapshot", "ok"], ["capture_screenshot", "ok"]]);
    assert.match(reply.data.tools![1]!.summary ?? "", /Create your account/, "the page read as an accessibility tree");

    // The screenshot is the node's own evidence: uploaded, on no run, the owner's only.
    const shot = await h.prisma.jobEvidence.findFirstOrThrow({ where: { nodeId: node.id, kind: "screenshot" } });
    assert.deepEqual([shot.jobId, shot.operation, shot.held, shot.local, shot.mime, shot.userId, shot.deviceId], [null, operation, false, false, "image/png", mira.id, computer.laptop.id]);
    assert.match(reply.data.tools![2]!.summary ?? "", /Kept as your evidence: .*“signup.png”/, "the node reads its id in the tool's data");
    assert.deepEqual(reply.data.media!.map((item) => item.evidenceId), [shot.id], "the screenshot came with the reply by itself");
    const local = computer.db.evidence.find((row) => row.id === shot.id)!;
    assert.ok(existsSync(join(operationEvidenceDir(operation), String(local.storageKey))), "the computer keeps its copy in the operation's evidence folder");
    const opened = await mira.inject({ method: "GET", url: `/api/node/evidence/${shot.id}` });
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.headers["content-type"], "image/png");
    assert.equal(createHash("sha256").update(opened.rawPayload).digest("hex"), shot.sha256);
    const listed = json(await mira.inject({ method: "GET", url: `/api/node/evidence?nodeId=${node.id}` })).evidence as Array<{ id: string }>;
    assert.deepEqual(listed.map((row) => row.id), [shot.id]);
    const other = await person("Ravi");
    assert.equal((await other.inject({ method: "GET", url: `/api/node/evidence/${shot.id}` })).statusCode, 404, "nobody else");

    script = (turn) => (turn.transcript.includes("show me") ? { calls: [{ name: "node_show", arguments: { evidence: [shot.id], caption: "The sign-up page" } }], then: "Here it is." } : { text: "ok" });
    await say(mira, room.id, "show me");
    const shown = (await messages(mira, room.id)).filter((row) => row.authorNodeId === node.id).at(-1)!;
    assert.deepEqual(shown.data.media!.map((item) => item.evidenceId), [shot.id]);
  } finally {
    computer.stop();
  }
});

test("a capture the computer holds waits for its owner's preview: previewed from the computer, released, then shown", { skip: noBrowser, timeout: 180_000 }, async () => {
  const mira = await person("Mira");
  const computer = await computerFor(mira);
  const { node, room } = await createNode(mira);
  try {
    privacy.previewFirst = ["127.0.0.1"];
    script = (turn) => (turn.transcript.includes("screenshot the page") ? { calls: [{ name: "capture_screenshot", arguments: { target: "web", url: `${base}/signup` } }], then: "Taken." } : { text: "ok" });
    await say(mira, room.id, "test the sign-up page: screenshot the page");
    const held = await h.prisma.jobEvidence.findFirstOrThrow({ where: { nodeId: node.id } });
    assert.deepEqual([held.held, held.local, held.bytes], [true, true, null], "only its description reached the web");
    assert.match(held.holdReason ?? "", /before they are sent/);
    const reply = (await messages(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind !== "approval").at(-1)!;
    assert.match(reply.data.tools![0]!.summary ?? "", /Held for your owner to preview first/);
    const card = (await messages(mira, room.id)).find((row) => row.kind === "approval" && row.data.type === "media_preview")!;
    assert.ok(card, "one preview card");
    assert.equal(card.private, true, "owner-only");
    assert.deepEqual([card.data.status, card.data.evidence!.map((item) => item.id), card.data.nodeCapture], ["pending", [held.id], true]);
    assert.match(card.body, /Preview before it's used/);

    // Never shown, never in a chat, until released.
    script = (turn) => (turn.transcript.includes("show it") ? { calls: [{ name: "node_show", arguments: { evidence: [held.id] } }], then: "Cannot yet." } : { text: "ok" });
    await say(mira, room.id, "show it");
    const refused = (await messages(mira, room.id)).filter((row) => row.authorNodeId === node.id && row.kind !== "approval").at(-1)!;
    assert.equal(refused.data.media, undefined);
    assert.match(refused.data.tools![0]!.summary ?? "", /held for your owner to preview first/);

    // The owner previews it: from the computer, kept nowhere.
    const preview = await mira.inject({ method: "GET", url: `/api/node/evidence/${held.id}` });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.headers["cache-control"], "no-store");
    assert.equal(preview.headers["content-type"], "image/png");
    assert.ok(computer.heard.some((frame) => frame.event === "evidence.request" && frame.data.action === "preview"));
    assert.equal((await h.prisma.jobEvidence.findUniqueOrThrow({ where: { id: held.id } })).held, true, "a preview releases nothing");
    const other = await person("Ravi");
    assert.equal((await other.inject({ method: "GET", url: `/api/node/evidence/${held.id}` })).statusCode, 404);

    // Approving releases it: uploaded, usable, and the node hears it may show it now.
    script = (turn) => (turn.transcript.includes("previewed and released") ? { calls: [{ name: "node_show", arguments: { evidence: [held.id] } }], then: "Here it is." } : { text: "ok" });
    const approved = await mira.inject({ method: "POST", url: `/api/node/approvals/${card.id}`, payload: { decision: "approve" } });
    assert.equal(approved.statusCode, 200, approved.body);
    const released = await h.prisma.jobEvidence.findUniqueOrThrow({ where: { id: held.id } });
    assert.deepEqual([released.held, released.local, released.holdReason], [false, false, null]);
    assert.equal(computer.db.evidence.find((row) => row.id === held.id)!.held, false, "released on the computer too");
    assert.equal((await mira.inject({ method: "GET", url: `/api/node/evidence/${held.id}` })).headers["cache-control"], "private, no-cache");
    await until(async () => (await messages(mira, room.id)).some((row) => row.authorNodeId === node.id && row.data.media?.some((item) => item.evidenceId === held.id)), "the node to show the released capture");
    const settled = (await messages(mira, room.id)).find((row) => row.id === card.id)!;
    assert.equal(settled.data.status, "released");
  } finally {
    computer.stop();
  }
});

test("discarding a held capture deletes it on the computer and on the web", { skip: noBrowser, timeout: 120_000 }, async () => {
  const mira = await person("Mira");
  const computer = await computerFor(mira);
  const { node, room } = await createNode(mira);
  try {
    privacy.previewFirst = ["127.0.0.1"];
    script = (turn) => (turn.transcript.includes("screenshot again") ? { calls: [{ name: "capture_screenshot", arguments: { target: "web", url: `${base}/signup` } }], then: "Taken." } : { text: "ok" });
    await say(mira, room.id, "test the sign-up page: screenshot again");
    const held = await h.prisma.jobEvidence.findFirstOrThrow({ where: { nodeId: node.id } });
    const local = computer.db.evidence.find((row) => row.id === held.id)!;
    const file = join(operationEvidenceDir(String(local.operation)), String(local.storageKey));
    assert.ok(existsSync(file));
    const card = (await messages(mira, room.id)).find((row) => row.kind === "approval" && row.data.type === "media_preview")!;
    const discarded = await mira.inject({ method: "POST", url: `/api/node/approvals/${card.id}`, payload: { decision: "discard" } });
    assert.equal(discarded.statusCode, 200, discarded.body);
    assert.equal(await h.prisma.jobEvidence.count({ where: { id: held.id } }), 0);
    assert.equal(computer.db.evidence.some((row) => row.id === held.id), false);
    assert.equal(existsSync(file), false, "the file is gone from the computer");
    assert.equal((await messages(mira, room.id)).find((row) => row.id === card.id)!.data.status, "discarded");
  } finally {
    computer.stop();
  }
});

test("a computer too old to browse is asked to update; one without a browser is asked to set capture up", async () => {
  const mira = await person("Mira");
  const old = await computerFor(mira, { nodeTools: 1 });
  const { node, room } = await createNode(mira);
  try {
    script = (turn) => (turn.transcript.includes("open the site") ? { calls: [{ name: "browser_open", arguments: { url: `${base}/` } }], then: "Could not." } : { text: "ok" });
    await say(mira, room.id, "open the site");
    let reply = (await messages(mira, room.id)).filter((row) => row.authorNodeId === node.id).at(-1)!;
    assert.equal(reply.data.tools![0]!.state, "failed");
    assert.match(reply.data.tools![0]!.summary ?? "", /Update Ensemble on Mira's laptop/);
    assert.equal(old.heard.length, 0, "nothing was sent to it");
    await h.prisma.device.update({ where: { id: old.laptop.id }, data: { capabilities: { nodeTools: 1, browser: 1, capture: { browser: false } } } });
    await say(mira, room.id, "open the site");
    reply = (await messages(mira, room.id)).filter((row) => row.authorNodeId === node.id).at(-1)!;
    assert.match(reply.data.tools![0]!.summary ?? "", /no browser for Ensemble yet/);
  } finally {
    old.stop();
  }
});

test("looking at a page or a capture is not acting; clicking, typing and capturing are", async () => {
  const { actsOnTheWorld } = await import("./work-board.js");
  for (const name of ["browser_tabs", "browser_snapshot", "browser_console", "browser_network_errors", "browser_wait", "capture_status", "capture_apps", "capture_check"]) {
    assert.equal(actsOnTheWorld(name, false), false, name);
  }
  for (const name of ["browser_open", "browser_click", "browser_type", "browser_snapshots", "capture_screenshot", "capture_app_start"]) {
    assert.equal(actsOnTheWorld(name, false), true, name);
  }
});

/** A paired computer running one job of Mira's from her node, with its run card in the node's DM (as evidence.integration.test.ts). */
async function runningJob() {
  const mira = await person("Mira");
  const key = await h.asToken(mira, "device");
  const device = await h.prisma.device.create({ data: { userId: mira.id, name: "Studio Mac", platform: "macos", tokenId: key.id, lastSeenAt: new Date(), capabilities: { evidenceUpload: true } } });
  const { node, room } = await createNode(mira);
  const task = await h.prisma.task.create({ data: { userId: mira.id, title: "Check the sign-up page" } });
  const leaseToken = randomBytes(24).toString("base64url");
  const job = await h.prisma.workspaceJob.create({
    data: { userId: mira.id, taskId: task.id, executionMode: "sandbox", model: "default", status: "running", deviceId: device.id, leaseOwner: device.id, leaseToken, leaseUntil: new Date(Date.now() + 120_000), startedAt: new Date() },
  });
  const { postMessage } = await import("./store.js");
  const { message } = await postMessage(h.prisma, { roomId: room.id, userId: mira.id, authorKind: "node", authorNodeId: node.id, kind: "run", body: "Check the sign-up page", data: { jobId: job.id, status: "running", direct: true } });
  await h.prisma.nodeRun.create({ data: { userId: mira.id, nodeId: node.id, roomId: room.id, messageId: message.id, jobId: job.id, taskId: task.id, status: "running", direct: true } });
  return { mira, key, device, node, room, job, leaseToken, runCard: message };
}

test("a run's held capture is announced on a preview card where the run is followed, and listed held on its card", async () => {
  const { mira, key, node, room, job, leaseToken, runCard } = await runningJob();
  const id = randomUUID();
  const meta = { id, kind: "screenshot", name: "dashboard.png", size: 2048, sha256: "a".repeat(64), mime: "image/png", local: true, held: true, holdReason: "It shows one of your saved secret values." };
  const upload = await key.inject({
    method: "POST",
    url: `/api/devices/self/jobs/${job.id}/evidence`,
    headers: { "content-type": "application/octet-stream", "x-ensemble-job-lease": leaseToken, "x-ensemble-evidence": Buffer.from(JSON.stringify(meta)).toString("base64url") },
  });
  assert.equal(upload.statusCode, 201, upload.body);
  const row = await h.prisma.jobEvidence.findUniqueOrThrow({ where: { id } });
  assert.deepEqual([row.held, row.local, row.bytes, row.holdReason], [true, true, null, "It shows one of your saved secret values."]);
  const card = (await messages(mira, room.id)).find((message) => message.kind === "approval" && message.data.type === "media_preview")!;
  assert.ok(card);
  assert.deepEqual([card.authorNodeId, card.private, card.data.evidence!.map((item) => item.id), card.data.nodeCapture], [node.id, true, [id], false]);
  const runData = (await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: runCard.id } })).data as { evidence: Array<{ id: string; held?: boolean; holdReason?: string }> };
  assert.deepEqual(runData.evidence.map((item) => [item.id, item.held, item.holdReason]), [[id, true, "It shows one of your saved secret values."]]);
  // A second held file of the same run joins the card still pending.
  const second = { ...meta, id: randomUUID(), name: "settings.png" };
  await key.inject({ method: "POST", url: `/api/devices/self/jobs/${job.id}/evidence`, headers: { "content-type": "application/octet-stream", "x-ensemble-job-lease": leaseToken, "x-ensemble-evidence": Buffer.from(JSON.stringify(second)).toString("base64url") } });
  const cards = (await messages(mira, room.id)).filter((message) => message.kind === "approval" && message.data.type === "media_preview");
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0]!.data.evidence!.map((item) => item.id), [id, second.id]);
  // Its computer is offline here, so releasing waits; the card says why and stays pending.
  await h.prisma.device.updateMany({ where: { userId: mira.id }, data: { lastSeenAt: new Date(Date.now() - 3_600_000) } });
  const approved = await mira.inject({ method: "POST", url: `/api/node/approvals/${cards[0]!.id}`, payload: { decision: "approve" } });
  assert.equal(approved.statusCode, 200, approved.body);
  const after = (await messages(mira, room.id)).find((message) => message.id === cards[0]!.id)!;
  assert.equal(after.data.status, "pending");
  assert.match(String((after.data as { error?: string }).error), /offline/);
  // A preview from an offline computer says so too, as a computer out of reach (504).
  const preview = await mira.inject({ method: "GET", url: `/api/node/evidence/${id}` });
  assert.equal(preview.statusCode, 504);
  assert.match(json(preview).error, /offline/);
  // One file discarded on its own, then the rest from the card: the card keeps every answer.
  const one = await mira.inject({ method: "POST", url: `/api/node/evidence/${id}/release`, payload: { decision: "discard" } });
  assert.equal(one.statusCode, 200, one.body);
  let kept = (await messages(mira, room.id)).find((message) => message.id === cards[0]!.id)!;
  assert.deepEqual([kept.data.status, (kept.data as { answers?: Record<string, string> }).answers], ["pending", { [id]: "discarded" }]);
  const rest = await mira.inject({ method: "POST", url: `/api/node/approvals/${cards[0]!.id}`, payload: { decision: "discard" } });
  assert.equal(rest.statusCode, 200, rest.body);
  kept = (await messages(mira, room.id)).find((message) => message.id === cards[0]!.id)!;
  assert.deepEqual([kept.data.status, kept.data.result], ["discarded", { released: [], discarded: [id, second.id] }]);
});

test("a run's live view: the latest small picture for its owner only, a pause with why, a hint on the Node stream", async () => {
  const { mira, key, job, leaseToken } = await runningJob();
  const hints: unknown[] = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId === `node:${mira.id}` && frame.event === "node.live") hints.push(frame.data);
  });
  try {
    const jpeg = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
    const empty = await mira.inject({ method: "GET", url: `/api/node/live/${job.id}` });
    assert.equal(empty.statusCode, 204, "nothing yet");
    const posted = await key.inject({ method: "POST", url: `/api/devices/self/jobs/${job.id}/live`, payload: { leaseToken, tab: "t1", url: "http://localhost:3000/signup", title: "Sign up", at: new Date().toISOString(), jpeg: jpeg.toString("base64"), width: 640, height: 400 } });
    assert.equal(posted.statusCode, 200, posted.body);
    const frame = await mira.inject({ method: "GET", url: `/api/node/live/${job.id}` });
    assert.equal(frame.statusCode, 200);
    assert.equal(frame.headers["content-type"], "image/jpeg");
    assert.equal(frame.headers["cache-control"], "no-store");
    assert.equal(decodeURIComponent(String(frame.headers["x-ensemble-live-url"])), "http://localhost:3000/signup");
    assert.deepEqual(frame.rawPayload, jpeg);
    assert.deepEqual(hints.map((hint) => (hint as { jobId: string }).jobId), [job.id]);
    const other = await person("Ravi");
    assert.equal((await other.inject({ method: "GET", url: `/api/node/live/${job.id}` })).statusCode, 404, "nobody else");
    const wrongLease = await key.inject({ method: "POST", url: `/api/devices/self/jobs/${job.id}/live`, payload: { leaseToken: "not-the-lease", tab: "t1", url: "", title: "", at: new Date().toISOString() } });
    assert.equal(wrongLease.statusCode, 409);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await key.inject({ method: "POST", url: `/api/devices/self/jobs/${job.id}/live`, payload: { leaseToken, tab: "t1", url: "", title: "", at: new Date().toISOString(), paused: "secret_on_screen" } });
    const paused = await mira.inject({ method: "GET", url: `/api/node/live/${job.id}` });
    assert.equal(paused.statusCode, 204);
    assert.equal(paused.headers["x-ensemble-live-paused"], "secret_on_screen", "no picture while a secret is on screen");
  } finally {
    stop();
  }
});

test("a plan's report shows only media a passing check names when its requirement asks for pictures, never a held file", async () => {
  const mira = await person("Mira");
  const { node, room } = await createNode(mira);
  const ids = { checked: randomUUID(), failed: randomUUID(), unnamed: randomUUID(), held: randomUUID(), other: randomUUID() };
  const evidence = (id: string, extra: Record<string, unknown> = {}) =>
    h.prisma.jobEvidence.create({ data: { id, userId: mira.id, nodeId: node.id, operation: "node:x:y", kind: "screenshot", name: `${id.slice(0, 4)}.png`, mime: "image/png", size: 10, sha256: "b".repeat(64), storageKey: id, bytes: new Uint8Array([1, 2, 3]), ...extra } });
  for (const id of [ids.checked, ids.failed, ids.unnamed, ids.other]) await evidence(id);
  await evidence(ids.held, { held: true, local: true, bytes: null });
  const missionId = randomUUID();
  await h.prisma.nodeMission.create({
    data: {
      id: missionId,
      userId: mira.id,
      leadNodeId: node.id,
      originRoomId: room.id,
      status: "reporting",
      requirements: [
        { id: "r1", text: "The sign-up page", acceptance: [{ id: "a1", text: "renders" }], evidence: ["screenshot"] },
        { id: "r2", text: "The API", acceptance: [{ id: "a2", text: "answers" }] },
      ],
    },
  });
  const step = (id: string, requirementIds: string[], report: unknown) =>
    h.prisma.nodeStep.create({ data: { missionId, id, position: id === "s1" ? 0 : 1, nodeId: node.id, handle: node.slug, name: "Check", kind: "verify", brief: "Check it", requirementIds, status: "done", outcome: "pass", report: report as never } });
  await step("s1", ["r1"], {
    outcome: "pass",
    summary: "Checked.",
    checks: [
      { name: "The image is not blank", verdict: "pass", evidence: [ids.checked, ids.held] },
      { name: "Shows the expected text", verdict: "fail", evidence: [ids.failed] },
    ],
    evidence: [{ kind: "screenshot", ref: ids.unnamed }],
  });
  await step("s2", ["r2"], { outcome: "pass", summary: "The API answers.", checks: [{ name: "GET /health", verdict: "pass" }], evidence: [{ kind: "screenshot", ref: ids.other }] });
  const shown = (await missionMedia(h.prisma, missionId, mira.id)).map((item) => item.evidenceId).sort();
  assert.deepEqual(shown, [ids.checked, ids.other].sort(), "the checked capture, and the other step's named file (its requirement asks for no picture)");
});
