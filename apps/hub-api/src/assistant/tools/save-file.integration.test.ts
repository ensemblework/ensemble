/**
 * `hub_save_file` (assistant/tools/save-file.ts, docs/35 §6): a public file from the web, evidence the
 * account owns, or a path on a node owner's computer goes into Ensemble Files, and the link it returns
 * opens that file. A local test site stands in for the web, reached through a name only this test
 * resolves; everything else goes through the real guard: web pages, files over the cap, private
 * addresses (directly or by a redirect), programs and non-PDFs called PDFs are refused. In the Hub the
 * save follows the write policy; a node's owner-started turn saves at once. The computer is simulated.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test, { after, afterEach } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../../test/http.js";
import type { RuntimeTurn } from "../../lib/model-turn.js";
import type { ToolContext } from "../types.js";

process.env.ENSEMBLE_NODE_PERMISSION_WAIT_MS = "60000";
const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../../lib/model-turn.js");
const { settleTurns } = await import("../../node/queue.js");
const { loadSettings, saveSettings } = await import("../../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
const { sseHub } = await import("../../lib/sse.js");
const { runAssistantTurn } = await import("../agent.js");
const { getTool } = await import("../registry.js");
const { makePdf } = await import("../../files/testing.js");
const { maxFileBytes } = await import("../../files/store.js");
const { fetchPublicFile, privateAddress, saveFromAttachment, setSaveFileNetworkForTests, sizeText } = await import("./save-file.js");

const PAPER = makePdf(["Attention is all you need"]);
const OTHER_PAPER = makePdf(["Deep residual learning"]);
const SITE = "files.example.test";
const INTRANET = "intranet.example.test";

const site = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://site");
  const send = (status: number, type: string, body: Buffer | string, headers: Record<string, string> = {}) => {
    response.writeHead(status, { "content-type": type, ...headers });
    response.end(body);
  };
  if (url.pathname === "/papers/cvpr.pdf") return send(200, "application/pdf", PAPER);
  if (url.pathname === "/content/2401.12345") return send(200, "application/pdf", PAPER);
  if (url.pathname === "/papers/resnet.pdf") return send(200, "application/pdf", OTHER_PAPER);
  if (url.pathname === "/download") return send(200, "application/octet-stream", PAPER, { "content-disposition": `attachment; filename*=UTF-8''Smith%20et%20al.%202024.pdf` });
  if (url.pathname === "/go/paper") {
    response.writeHead(302, { location: "/papers/resnet.pdf" });
    return void response.end();
  }
  if (url.pathname === "/to-intranet") {
    response.writeHead(302, { location: `http://${INTRANET}/secret.pdf` });
    return void response.end();
  }
  if (url.pathname === "/article") return send(200, "text/html; charset=utf-8", "<!doctype html><html><body><h1>The paper</h1></body></html>");
  if (url.pathname === "/sneaky.pdf") return send(200, "application/pdf", "<html><body>Sign in to download</body></html>");
  if (url.pathname === "/not-a.pdf") return send(200, "application/pdf", "this is not a pdf at all");
  if (url.pathname === "/setup.exe") return send(200, "application/octet-stream", Buffer.from("MZ binary"));
  if (url.pathname === "/huge.pdf") {
    response.writeHead(200, { "content-type": "application/pdf", "content-length": String(maxFileBytes() + 1) });
    return void response.end();
  }
  if (url.pathname === "/stream.pdf") {
    response.writeHead(200, { "content-type": "application/pdf" });
    response.write(Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(4096)]));
    return void response.end();
  }
  send(404, "text/plain", "not here");
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const port = (site.address() as { port: number }).port;
const WEB = `http://${SITE}:${port}`;

// The test site's name resolves to this computer, and only it may: every other private address is refused as in production.
setSaveFileNetworkForTests({
  lookup: async (hostname) => (hostname === SITE ? ["127.0.0.1"] : hostname === INTRANET ? ["10.0.0.7"] : []),
  allowAddress: (address, hostname) => (hostname === SITE && address === "127.0.0.1") || !privateAddress(address),
});

after(async () => {
  setSaveFileNetworkForTests(null);
  site.close();
  await h.close();
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
  const turn: RuntimeTurn = { text, toolCalls: calls.map((call, index) => ({ id: `call-${randomBytes(4).toString("hex")}-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })), model: "test-model", credits: 0, tokensIn: 10, tokensOut: 5, reasoning: "", raw: {}, finishReason: "stop", cutOff: false };
  if (text) args.onDelta?.(text);
  return turn;
});

afterEach(async () => {
  await settleTurns();
  seen.length = 0;
  script = () => ({ text: "ok" });
});

const json = (response: LightMyRequestResponse) => response.json() as any;

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

async function context(user: HttpUser): Promise<ToolContext> {
  return { app: h.app, prisma: h.prisma, userId: user.id, actor: "agent", settings: await loadSettings(h.prisma, user.id) };
}

const save = async (user: HttpUser, input: Record<string, unknown>) => getTool("hub_save_file")!.run(await context(user), getTool("hub_save_file")!.input.parse(input));

/** Evidence a computer uploaded for the account, as the evidence routes keep it. */
async function evidence(owner: string, name: string, bytes: Buffer, mime = "application/pdf", extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await h.prisma.jobEvidence.create({ data: { id, userId: owner, operation: "node:test:own", kind: "file", name, mime, size: bytes.byteLength, sha256: "c".repeat(64), storageKey: id, bytes: new Uint8Array(bytes), ...extra } });
  return id;
}

test("a public PDF link is saved in Files with where it came from, and the link it returns opens that file", async () => {
  const mira = await person("Mira");
  const result = await save(mira, { url: `${WEB}/papers/cvpr.pdf` });
  const data = result.data as { file: { id: string; name: string; size: number; mime: string }; link: string };
  assert.equal(result.summary, `Saved “cvpr.pdf” (${PAPER.byteLength} bytes) to Ensemble Files.`);
  assert.deepEqual(data.file, { id: data.file.id, name: "cvpr.pdf", size: PAPER.byteLength, mime: "application/pdf" });
  assert.equal(data.link, `ensemble://file/${data.file.id}`);
  // The link resolves: the file is the owner's, and the Files routes open it.
  const opened = await mira.inject({ method: "GET", url: `/api/documents/${data.file.id}` });
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(json(opened).file.filename, "cvpr.pdf");
  assert.deepEqual(json(opened).file.source, { app: "web", label: `${SITE}:${port}`, url: `${WEB}/papers/cvpr.pdf` });
  const original = await mira.inject({ method: "GET", url: `/api/documents/${data.file.id}/original` });
  assert.equal(original.statusCode, 200);
  assert.ok(Buffer.from(original.rawPayload).equals(PAPER), "the bytes are the site's");
  const ada = await person("Ada");
  assert.equal((await ada.inject({ method: "GET", url: `/api/documents/${data.file.id}` })).statusCode, 404, "nobody else opens it");

  // The same file from the same link is the file already kept.
  const again = await save(mira, { url: `${WEB}/papers/cvpr.pdf` });
  assert.equal((again.data as { file: { id: string } }).file.id, data.file.id);
  assert.match(again.summary, /is already in Ensemble Files/);

  // A redirect is followed (and checked); a name comes from Content-Disposition, or from the type when the link has none.
  const redirected = (await save(mira, { url: `${WEB}/go/paper`, name: "He et al. 2016" })).data as { file: { id: string; name: string } };
  assert.equal(redirected.file.name, "He et al. 2016.pdf");
  assert.equal(json(await mira.inject({ method: "GET", url: `/api/documents/${redirected.file.id}` })).file.source.url, `${WEB}/papers/resnet.pdf`, "where it came from is where it was found");
  assert.equal(((await save(mira, { url: `${WEB}/download` })).data as { file: { name: string } }).file.name, "Smith et al. 2024.pdf");
  assert.equal(((await save(mira, { url: `${WEB}/content/2401.12345` })).data as { file: { name: string } }).file.name, "2401.12345.pdf");
  assert.equal(await h.prisma.document.count({ where: { userId: mira.id, deletedAt: null } }), 4);
});

test("web pages, files over the cap, private addresses (also by a redirect), programs and fake PDFs are refused", async () => {
  const mira = await person("Mira");
  const refused = async (input: Record<string, unknown>, pattern: RegExp) => {
    await assert.rejects(save(mira, input), (error: Error) => {
      assert.match(`${error.message} ${(error as { remedy?: string }).remedy ?? ""}`, pattern);
      return true;
    });
  };
  await refused({ url: `${WEB}/article` }, /opened a web page, not a file\. Give the direct link to the file.*browser_fetch/);
  await refused({ url: `${WEB}/sneaky.pdf` }, /web page, not a file/);
  await refused({ url: `${WEB}/huge.pdf` }, /larger than the \d+ MB Ensemble Files keeps/);
  await refused({ url: `http://127.0.0.1:${port}/papers/cvpr.pdf` }, /private address/);
  await refused({ url: `http://${INTRANET}/secret.pdf` }, /private address/);
  await refused({ url: `${WEB}/to-intranet` }, /private address/);
  await refused({ url: `${WEB}/setup.exe` }, /programs or raw binary data/);
  await refused({ url: `${WEB}/not-a.pdf` }, /did not give a PDF/);
  await refused({ url: "ftp://example.com/paper.pdf" }, /Only http and https/);
  await refused({ url: `http://mira:secret@${SITE}:${port}/papers/cvpr.pdf` }, /user name or password/);
  assert.equal(await h.prisma.document.count({ where: { userId: mira.id } }), 0, "nothing was kept");
  // A file without a length is cut off at the cap while it streams.
  await assert.rejects(fetchPublicFile(`${WEB}/stream.pdf`, 1024), /larger than/);
  assert.equal((await fetchPublicFile(`${WEB}/papers/cvpr.pdf`)).bytes.byteLength, PAPER.byteLength);
  // Exactly one source.
  assert.throws(() => getTool("hub_save_file")!.input.parse({}), /exactly one of url, evidence/);
  assert.throws(() => getTool("hub_save_file")!.input.parse({ url: `${WEB}/papers/cvpr.pdf`, evidence: randomUUID() }), /exactly one of url, evidence/);
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:c0a8:101::1"]) assert.equal(privateAddress(address), true, address);
  for (const address of ["8.8.8.8", "151.101.1.140", "2606:4700:4700::1111"]) assert.equal(privateAddress(address), false, address);
});

test("evidence the account owns is saved once; another account's, a held one and one kept on the computer are not", async () => {
  const mira = await person("Mira");
  const ada = await person("Ada");
  const id = await evidence(mira.id, "Wisconsin PS5 prices.pdf", PAPER);
  const saved = await save(mira, { evidence: id });
  const file = (saved.data as { file: { id: string; name: string } }).file;
  assert.equal(file.name, "Wisconsin PS5 prices.pdf");
  assert.equal(saved.summary, `Saved “Wisconsin PS5 prices.pdf” (${sizeText(PAPER.byteLength)}) to Ensemble Files.`);
  assert.deepEqual([sizeText(14_260_000), sizeText(820 * 1024), sizeText(600)], ["13.6 MB", "820 KB", "600 bytes"]);
  assert.equal(json(await mira.inject({ method: "GET", url: `/api/documents/${file.id}` })).file.source.app, "evidence");
  assert.equal(((await save(mira, { evidence: id })).data as { file: { id: string } }).file.id, file.id, "saved once");
  // A picture without an extension in its name gets one from its type.
  const shot = await evidence(mira.id, "chart", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), "image/png");
  assert.equal(((await save(mira, { evidence: shot, name: "GOOG 5 days" })).data as { file: { name: string } }).file.name, "GOOG 5 days.png");
  await assert.rejects(save(ada, { evidence: id }), /There is no evidence with that id/);
  const held = await evidence(mira.id, "held.pdf", PAPER, "application/pdf", { held: true });
  await assert.rejects(save(mira, { evidence: held }), /held on the computer for your owner to preview first/);
  const local = await evidence(mira.id, "local.pdf", PAPER, "application/pdf", { local: true, bytes: null });
  await assert.rejects(save(mira, { evidence: local }), /stayed on the computer/);
});

test("a file the owner attached is the same file in their own Files, and copied once into another space", async () => {
  const mira = await person("Mira");
  const ada = await person("Ada");
  const upload = await mira.inject({ method: "POST", url: "/api/documents", payload: { filename: "Q3 notes.pdf", mediaType: "application/pdf", dataBase64: PAPER.toString("base64"), summarize: false } });
  assert.equal(upload.statusCode, 201, upload.body);
  const fileId = json(upload).file.id as string;
  const same = await saveFromAttachment(h.prisma, mira.id, mira.id, { file: fileId });
  assert.deepEqual([same.file.id, same.existing], [fileId, true]);
  const created = await mira.inject({ method: "POST", url: "/api/spaces", payload: { name: "Lab", templateId: "semester-desk", settings: { mode: "fresh" } } });
  assert.equal(created.statusCode, 201, created.body);
  const space = json(created).space.id as string;
  const copied = await saveFromAttachment(h.prisma, space, mira.id, { file: fileId });
  assert.equal(copied.existing, false);
  assert.notEqual(copied.file.id, fileId);
  const row = await h.prisma.document.findUniqueOrThrow({ where: { id: copied.file.id } });
  assert.deepEqual([row.userId, row.filename, row.sha256, (row.source as { externalId?: string }).externalId], [space, "Q3 notes.pdf", same.file.sha256, `attachment:${fileId}`]);
  assert.equal((await saveFromAttachment(h.prisma, space, mira.id, { file: fileId })).file.id, copied.file.id, "copied once");
  await assert.rejects(saveFromAttachment(h.prisma, ada.id, ada.id, { file: fileId }), /no longer in your owner's Files/);
});

test("in the Hub it follows the write policy: held for Apply under preview, saved at once when immediate", async () => {
  const mira = await person("Mira");
  const settings = await loadSettings(h.prisma, mira.id);
  script = (turn) => (turn.transcript.includes("save the paper") ? { calls: [{ name: "hub_save_file", arguments: { url: `${WEB}/papers/cvpr.pdf` } }], then: "Done." } : { text: "ok" });
  const held = await runAssistantTurn({ app: h.app, userId: mira.id, conversationId: randomUUID(), message: "save the paper to my files", settings: { ...settings, assistant: { ...settings.assistant, writePolicy: "preview" } }, model: "test-model", emit: () => undefined });
  assert.equal(held.toolCalls[0]?.state, "awaiting_approval", held.toolCalls[0]?.error);
  assert.match(held.toolCalls[0]?.summary ?? "", new RegExp(`Save the file from ${SITE}:${port} to Files`));
  assert.equal(await h.prisma.document.count({ where: { userId: mira.id } }), 0, "nothing saved before Apply");
  const done = await runAssistantTurn({ app: h.app, userId: mira.id, conversationId: randomUUID(), message: "save the paper to my files", settings: { ...settings, assistant: { ...settings.assistant, writePolicy: "immediate" } }, model: "test-model", emit: () => undefined });
  assert.equal(done.toolCalls[0]?.state, "ok", done.toolCalls[0]?.error);
  assert.ok(seen.some((turn) => turn.tools.includes("hub_save_file")), "the files playbook offers it");
  assert.equal(await h.prisma.document.count({ where: { userId: mira.id, deletedAt: null } }), 1);
});

test("a node saves a file from its owner's computer by path, at once in its owner's own turn even when their writes wait for Apply", async () => {
  const mira = await person("Mira");
  const key = await h.asToken(mira, "device");
  const laptop = await h.prisma.device.create({ data: { userId: mira.id, name: "Mira's laptop", platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: { folders: ["app"], engines: ["claude-code"], nodeTools: 2 } as never } });
  await saveSettings(h.prisma, mira.id, { runProfiles: [RunProfile.parse({ id: "main", name: "Main", engine: "claude-code", mode: "unattended", delivery: "local", deviceId: laptop.id })], defaultRunProfileId: "main", assistant: { writePolicy: "preview" } });
  const created = await mira.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  assert.equal(created.statusCode, 201, created.body);
  const { node, room } = json(created) as { node: { id: string; slug: string }; room: { id: string } };
  const heard: Array<Record<string, unknown>> = [];
  const stop = sseHub.onFrame(({ userId, frame }) => {
    if (userId !== `device:${laptop.id}` || frame.event !== "node.tool.request") return;
    const data = frame.data as Record<string, unknown> & { id: string };
    heard.push(data);
    setTimeout(async () => {
      const id = await evidence(mira.id, "paper.pdf", PAPER, "application/pdf", { nodeId: node.id, deviceId: laptop.id, operation: `node:${node.id}:own`, kind: "report" });
      await key.inject({ method: "POST", url: `/api/devices/self/code-requests/${data.id}`, payload: { status: 200, body: { ok: true, summary: "Shared paper.pdf.", evidence: [{ id, name: "paper.pdf", kind: "report", held: false, local: false }], refused: [] } } });
    }, 5);
  });
  try {
    script = (turn) => (turn.transcript.includes("add the paper") ? { calls: [{ name: "hub_save_file", arguments: { path: "downloads/paper.pdf", name: "CVPR 2024 paper" } }], then: "Saved." } : { text: "ok" });
    const posted = await mira.inject({ method: "POST", url: `/api/node/rooms/${room.id}/messages`, payload: { body: "add the paper you downloaded to my Ensemble files" } });
    assert.equal(posted.statusCode, 201, posted.body);
    await settleTurns();
    assert.ok(seen[0]!.tools.includes("hub_save_file"));
    assert.deepEqual([heard[0]!.tool, heard[0]!.action, heard[0]!.path, heard[0]!.nodeSlug], ["files", "share", "downloads/paper.pdf", node.slug]);
    const rows = json(await mira.inject({ method: "GET", url: `/api/node/rooms/${room.id}/messages` })).messages as Array<{ authorNodeId: string | null; kind: string; data: { tools?: Array<{ name: string; state: string; summary: string | null }>; media?: unknown[] } }>;
    const reply = rows.filter((row) => row.authorNodeId === node.id && row.kind === "text").at(-1)!;
    const tool = reply.data.tools!.find((call) => call.name === "hub_save_file")!;
    assert.equal(tool.state, "ok", "saved at once, not held for Apply");
    assert.equal(tool.summary, `Saved “CVPR 2024 paper.pdf” (${sizeText(PAPER.byteLength)}) to Ensemble Files.`);
    assert.equal(reply.data.media?.length ?? 0, 0, "a saved file is not also shown as a capture");
    const doc = await h.prisma.document.findFirstOrThrow({ where: { userId: mira.id, deletedAt: null } });
    assert.equal(doc.filename, "CVPR 2024 paper.pdf");
    assert.equal((await mira.inject({ method: "GET", url: `/api/documents/${doc.id}` })).statusCode, 200);
  } finally {
    stop();
  }
});
