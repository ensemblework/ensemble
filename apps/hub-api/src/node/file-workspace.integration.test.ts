import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";

const root = await mkdtemp(join(homedir(), ".ensemble-original-files-test-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
process.env.ENSEMBLE_NODE_WEB_ORIGIN = "https://node.example.test";
const h = await createHttpHarness();
const { originalFile, nodeFileAnswer } = await import("../remote/node-files.js");
const { updateSettings } = await import("../remote/store.js");
const { sseHub } = await import("../lib/sse.js");
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { env } = await import("../config.js");
const folder = join(root, "project");
await mkdir(folder);
updateSettings({ browseFiles: true, webEdit: true });
const owner = await h.asUser();
const stranger = await h.asUser();
await h.prisma.user.update({ where: { id: owner.id }, data: { emailVerifiedAt: new Date() } });
const created = await owner.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
assert.equal(created.statusCode, 201, created.body);
const { node, room } = created.json() as { node: { id: string }; room: { id: string } };
const turn = await h.prisma.nodeTurn.create({ data: { userId: owner.id, nodeId: node.id, roomId: room.id, reason: "dm", status: "done" } });
const key = await h.asToken(owner, "device");
const device = await h.prisma.device.create({ data: { userId: owner.id, name: "Test computer", platform: "linux", tokenId: key.id, lastSeenAt: new Date(), capabilities: { code: true, codeApi: 3, browseFiles: true, webEdit: true } } });
let incomplete = false;
const stop = sseHub.onFrame(({ userId, frame }) => {
  if (userId !== `device:${device.id}` || frame.event !== "code.request") return;
  const request = frame.data as Parameters<typeof nodeFileAnswer>[1];
  void (incomplete ? Promise.resolve({ status: 200, body: {} }) : nodeFileAnswer(h.app, request)).then(answer => key.inject({ method: "POST", url: `/api/devices/self/code-requests/${request.id}`, payload: answer }));
});
after(async () => { stop(); await h.close(); await rm(root, { recursive: true, force: true }); });
const headers = { origin: process.env.ENSEMBLE_NODE_WEB_ORIGIN };
let source: { kind: "node"; id: string; fileId: string; path: string };
const open = (action: string, extra = {}) => owner.inject({ method: "POST", url: "/api/node/files/open", headers, payload: { source, action, ...extra } });
async function report(path: string) {
  const file = originalFile({ path: folder, label: "project" }, path);
  const response = await key.inject({ method: "POST", url: "/api/devices/self/node-file-changes", payload: { turnId: turn.id, nodeId: node.id, files: [file] } });
  assert.equal(response.statusCode, 200, response.body);
  const card = await h.prisma.nodeMessage.findFirstOrThrow({ where: { roomId: room.id, kind: "files" } });
  return { kind: "node" as const, id: card.id, fileId: file.fileId, path };
}

test("changed files coalesce into one private card; inventory and opening are owner-only", async () => {
  await writeFile(join(folder, "main.ts"), "\ufeffconst answer = 1;\r\n");
  source = await report("main.ts");
  await report("notes.md");
  const cards = await h.prisma.nodeMessage.findMany({ where: { roomId: room.id, kind: "files" } });
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0]!.visibleTo, [owner.id]);
  const response = await owner.inject({ method: "GET", url: "/api/node/files" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().files.length, 2);
  assert.equal((await stranger.inject({ method: "GET", url: "/api/node/files" })).json().files.length, 0);
  assert.equal((await stranger.inject({ method: "POST", url: "/api/node/files/open", headers, payload: { source, action: "read" } })).statusCode, 404);
  assert.equal((await owner.inject({ method: "POST", url: "/api/node/files/open", payload: { source, action: "read" } })).statusCode, 403);
  assert.equal((await owner.inject({ method: "POST", url: "/api/node/files/open", headers: { origin: "https://unrelated.example.test" }, payload: { source, action: "read" } })).statusCode, 403);
  const token = await h.asToken(owner, "full");
  assert.equal((await token.inject({ method: "POST", url: "/api/node/files/open", headers, payload: { source, action: "read" } })).statusCode, 403);
  assert.equal((await owner.inject({ method: "POST", url: `/api/devices/${device.id}/code`, headers, payload: { method: "GET", path: "/api/code/reviews" } })).statusCode, 403, "Node's origin does not gain access to the Hub Code bridge");
  assert.equal((await owner.inject({ method: "POST", url: "/api/web-terminal/unlock/options", headers, payload: {} })).statusCode, 403, "Node's origin cannot unlock a terminal");
  incomplete = true;
  try { assert.equal((await open("read")).statusCode, 502, "an incomplete answer never becomes a fake empty editor"); }
  finally { incomplete = false; }
});

test("edits reach the non-Git original, retain BOM, EOL and permissions, and reject stale versions", async () => {
  await import("node:fs/promises").then(fs => fs.chmod(join(folder, "main.ts"), 0o640));
  const read = await open("read");
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().content, "const answer = 1;\n");
  const hash = read.json().hash as string;
  const inode = (await stat(join(folder, "main.ts"))).ino;
  const saved = await open("save", { content: "const answer = 2;\n", expectedHash: hash });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(await readFile(join(folder, "main.ts"), "utf8"), "\ufeffconst answer = 2;\r\n");
  assert.equal((await stat(join(folder, "main.ts"))).mode & 0o777, 0o640);
  assert.equal((await stat(join(folder, "main.ts"))).ino, inode, "saving preserves inode-bound metadata and ACLs");
  const stale = await open("save", { content: "do not overwrite", expectedHash: hash });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.match(stale.body, /changed/);
  assert.equal(await readFile(join(folder, "main.ts"), "utf8"), "\ufeffconst answer = 2;\r\n");
  const both = await Promise.all(["a", "b"].map(content => open("save", { content, expectedHash: saved.json().hash })));
  assert.deepEqual(both.map(reply => reply.statusCode).sort(), [200, 409]);
});

test("links, hardlinks, credentials, invalid UTF-8 and key-bearing originals cannot be saved or leaked by download", async () => {
  for (const [path, content] of [[".env", "TOKEN=never"], ["key.ts", 'const token = "sk-abcdefghijklmnop1234567890";']] as const) {
    await writeFile(join(folder, path), content);
    const ref = await report(path);
    const response = await owner.inject({ method: "POST", url: "/api/node/files/open", headers, payload: { source: ref, action: "download" } });
    assert.equal(response.statusCode, 403, response.body);
  }
  await symlink(join(folder, "main.ts"), join(folder, "linked.ts"));
  await link(join(folder, "main.ts"), join(folder, "hard.ts"));
  for (const path of ["linked.ts", "hard.ts"]) {
    const ref = await report(path);
    const response = await owner.inject({ method: "POST", url: "/api/node/files/open", headers, payload: { source: ref, action: "read" } });
    assert.equal(response.statusCode, 403, response.body);
  }
  await rm(join(folder, "hard.ts"));
  await writeFile(join(folder, "invalid.txt"), Buffer.from([0xff, 0xfe, 0x61]));
  const ref = await report("invalid.txt");
  const invalid = await owner.inject({ method: "POST", url: "/api/node/files/open", headers, payload: { source: ref, action: "read" } });
  assert.equal(invalid.json().binary, true);
  assert.ok(invalid.json().readOnly);
});

test("downloads stream the original in bounded chunks", async () => {
  const bytes = Buffer.alloc(800_000, 65);
  await writeFile(join(folder, "large.txt"), bytes);
  const ref = await report("large.txt");
  const response = await owner.inject({ method: "POST", url: "/api/node/files/open", headers, payload: { source: ref, action: "download" } });
  assert.equal(response.statusCode, 200, response.body.slice(0, 100));
  assert.equal(response.headers["content-length"], String(bytes.length));
  assert.deepEqual(response.rawPayload, bytes);
});

test("selected file lines reach the actual model transcript; quotes never turn a question into a bare Stop", async () => {
  const transcripts: string[] = [];
  setAskRuntimeStreamForTests(async args => {
    transcripts.push(JSON.stringify(args.messages));
    args.onDelta?.("I can see the selected lines.");
    return { text: "I can see the selected lines.", toolCalls: [], model: "test-model", credits: 0, tokensIn: 1, tokensOut: 1, reasoning: "", raw: {}, finishReason: "stop", cutOff: false };
  });

  const quote = { source, from: 3, to: 5, text: "const selectedValue = 42;\n// selected from my unsaved draft", hash: null, draft: true };
  const response = await owner.inject({ method: "POST", url: `/api/node/rooms/${room.id}/messages`, payload: { body: "stop", clientId: randomUUID(), fileQuotes: [quote] } });
  assert.equal(response.statusCode, 201, response.body);
  await settleTurns();
  assert.ok(transcripts.some(text => text.includes("selectedValue = 42") && text.includes("lines 3") && text.includes("unsaved selection")), transcripts.join("\n"));
  const exported = await owner.inject({ method: "GET", url: `/api/node/rooms/${room.id}/export` });
  assert.equal(exported.statusCode, 200);
  assert.match(exported.body, /selectedValue = 42/);
  const forged = await stranger.inject({ method: "POST", url: "/api/node/files/open", headers, payload: { source, action: "read" } });
  assert.equal(forged.statusCode, 404);
  const invalid = await owner.inject({ method: "POST", url: `/api/node/rooms/${room.id}/messages`, payload: { body: "Explain", fileQuotes: [{ ...quote, source: { ...source, fileId: "0".repeat(64) } }] } });
  assert.equal(invalid.statusCode, 404);
});

  test("inventory includes unmanaged agent sessions, paginates without dropping files and searches literal names", async () => {
    const task = await h.prisma.task.create({ data: { userId: owner.id, title: "CLI session" } });
    const job = await h.prisma.workspaceJob.create({ data: { userId: owner.id, taskId: task.id, executionMode: "manual", model: "fixture", deviceId: device.id, evidence: { files: [{ path: "cli-only.ts", status: "M" }] } } });
    const all = await owner.inject({ method: "GET", url: "/api/node/files?q=cli-only" });
    assert.equal(all.statusCode, 200, all.body);
    assert.equal(all.json().files[0].source.id, job.id);
    assert.equal(all.json().files[0].nodeId, null, "an adopted NodeRun is not required");
    assert.equal((await owner.inject({ method: "GET", url: `/api/node/files?roomId=${room.id}&q=cli-only` })).json().files.length, 0);
    const files = Array.from({ length: 66 }, (_, index) => originalFile({ path: folder, label: "project" }, `page-${index}.txt`));
    const reported = await key.inject({ method: "POST", url: "/api/devices/self/node-file-changes", payload: { turnId: turn.id, nodeId: node.id, files } });
    assert.equal(reported.statusCode, 200, reported.body);
    const first = (await owner.inject({ method: "GET", url: "/api/node/files?q=page-" })).json();
    assert.equal(first.files.length, 50);
    const second = (await owner.inject({ method: "GET", url: `/api/node/files?q=page-&cursor=${encodeURIComponent(first.nextCursor)}` })).json();
    assert.equal(second.files.length, 16);
    assert.equal(new Set([...first.files, ...second.files].map(file => file.source.fileId)).size, 66);
    assert.equal(second.nextCursor, null);
    assert.equal((await owner.inject({ method: "GET", url: "/api/node/files?q=page_" })).json().files.length, 0, "underscore is not a wildcard");
  });

  test("old/offline computers and edit switches give explicit errors; oversized relay text can still download", async () => {
    await h.prisma.device.update({ where: { id: device.id }, data: { capabilities: { codeApi: 2 } } });
    assert.equal((await open("read")).json().code, "FILE_UPDATE_REQUIRED");
    await h.prisma.device.update({ where: { id: device.id }, data: { capabilities: { codeApi: 3 }, lastSeenAt: new Date(Date.now() - 600_000) } });
    assert.equal((await open("read")).json().code, "FILE_OFFLINE");
    await h.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
    updateSettings({ webEdit: false });
    const readonly = await open("read");
    assert.equal(readonly.statusCode, 200, readonly.body);
    assert.match(readonly.json().readOnly, /off/);
    assert.equal((await open("save", { content: "no", expectedHash: readonly.json().hash })).statusCode, 409);
    updateSettings({ webEdit: true });
    await writeFile(join(folder, "control.txt"), "\u0001".repeat(1024 * 1024));
    const ref = await report("control.txt");
    const read = await owner.inject({ method: "POST", url: "/api/node/files/open", headers, payload: { source: ref, action: "read" } });
    assert.equal(read.statusCode, 413, read.body.slice(0, 100));
    const downloaded = await owner.inject({ method: "POST", url: "/api/node/files/open", headers, payload: { source: ref, action: "download" } });
    assert.equal(downloaded.statusCode, 200);
    assert.equal(downloaded.rawPayload.length, 1024 * 1024);
  });

  test("public quotes omit owner-only computer/location metadata, while private questions retain it", async () => {
    const made = await owner.inject({ method: "POST", url: "/api/node/rooms", payload: { title: "Quoted code", nodeIds: [node.id] } });
    assert.equal(made.statusCode, 201, made.body);
    const sharedRoom = made.json().room.id as string;
    const quote = { source, from: 1, to: 1, text: "const question = 1;", hash: null, draft: false, location: "/private/project/main.ts" };
    const publicPost = await owner.inject({ method: "POST", url: `/api/node/rooms/${sharedRoom}/messages`, payload: { body: "Here are the lines", fileQuotes: [quote] } });
    assert.equal(publicPost.statusCode, 201, publicPost.body);
    assert.equal(publicPost.json().message.data.fileQuotes[0].location, undefined);
    assert.equal(publicPost.json().message.data.fileQuotes[0].computer, undefined);
    const privatePost = await owner.inject({ method: "POST", url: `/api/node/rooms/${sharedRoom}/messages`, payload: { body: "Explain privately", private: true, fileQuotes: [quote] } });
    assert.equal(privatePost.statusCode, 201, privatePost.body);
    assert.equal(privatePost.json().message.data.fileQuotes[0].location, quote.location);
    await settleTurns();
  });

test("an unrelated missing shared folder does not block a run's original", async () => {
  const local = env.ENSEMBLE_DEV_USER_ID;
  await h.prisma.user.upsert({ where: { id: local }, create: { id: local, email: `local-${randomUUID()}@example.test`, name: "Local runtime" }, update: {} });
  const task = await h.prisma.task.create({ data: { userId: local, title: "Local source" } });
  const job = await h.prisma.workspaceJob.create({ data: { userId: local, taskId: task.id, executionMode: "manual", model: "fixture", externalRoot: folder, repoPath: folder, evidence: { files: [{ path: "main.ts" }] } } });
  updateSettings({ folders: [{ label: "project", path: folder, kind: "folder", access: "read-write" }, { label: "unavailable drive", path: join(root, "gone"), kind: "folder", access: "read-write" }] });
  const answer = await nodeFileAnswer(h.app, { id: "local", method: "GET", path: "/api/code/node-file", query: { jobId: job.id, path: "main.ts" } });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

test("editor themes persist on the account, including imported colour data, not a particular browser", async () => {
  const { loadBuiltinTheme } = await import("@ensemble/ide-theme");
  const theme = await loadBuiltinTheme("builtin:github-dark");
  assert.ok(theme);
  const saved = await owner.inject({ method: "PUT", url: "/api/node/themes/current", headers, payload: { theme } });
  assert.equal(saved.statusCode, 200, saved.body);
  const secondBrowser = await h.app.inject({ method: "GET", url: "/api/node/themes/current", headers: { cookie: owner.cookie, origin: headers.origin } });
  assert.equal(secondBrowser.json().theme.id, theme.id);
  assert.equal((await stranger.inject({ method: "GET", url: "/api/node/themes/current" })).json().theme.id, "builtin:ensemble-default");
  const imported = { ...theme, id: "import:fixture", label: "My imported colours" };
  assert.equal((await owner.inject({ method: "PUT", url: "/api/node/themes/current", headers, payload: { theme: imported } })).statusCode, 200);
  assert.deepEqual((await owner.inject({ method: "GET", url: "/api/node/themes/current" })).json().theme, imported);
  const hubView = await owner.inject({ method: "GET", url: "/api/settings/editor-theme/current", headers: { origin: "http://localhost:3000" } });
  assert.equal(hubView.statusCode, 200, hubView.body);
  assert.deepEqual(hubView.json().theme, imported, "Hub Code can restore a palette imported in Node");
  const hubSave = await owner.inject({ method: "PUT", url: "/api/settings/editor-theme/current", headers: { origin: "http://localhost:3000" }, payload: { theme } });
  assert.equal(hubSave.statusCode, 200, hubSave.body);
  assert.equal((await owner.inject({ method: "GET", url: "/api/node/themes/current" })).json().theme.id, theme.id, "Node follows the same account theme chosen in Hub Code");
  const token = await h.asToken(owner, "full");
  assert.equal((await token.inject({ method: "PUT", url: "/api/node/themes/current", headers, payload: { theme } })).statusCode, 403);
});

test("a quote targets the latest recorded editing node, not the current chat or last unrelated file in a card", async () => {
  const response = await owner.inject({ method: "POST", url: "/api/node/nodes", payload: { name: "Other editor", templateId: "assistant" } });
  assert.equal(response.statusCode, 201, response.body);
  const other = response.json() as { node: { id: string }; room: { id: string } };
  const edited = await h.prisma.nodeTurn.create({ data: { userId: owner.id, nodeId: other.node.id, roomId: other.room.id, reason: "dm", status: "done" } });
  const file = originalFile({ path: folder, label: "project" }, "main.ts");
  const report = await key.inject({ method: "POST", url: "/api/devices/self/node-file-changes", payload: { turnId: edited.id, nodeId: other.node.id, files: [{ ...file, updatedAt: new Date(Date.now() + 1000).toISOString() }] } });
  assert.equal(report.statusCode, 200, report.body);
  const target = await owner.inject({ method: "POST", url: "/api/node/files/target", headers, payload: { source } });
  assert.equal(target.statusCode, 200, target.body);
  assert.equal(target.json().target.nodeId, other.node.id);
  assert.equal(target.json().target.roomId, other.room.id);
  assert.equal(target.json().target.kind, "node");
  const staleTarget = target.json().target;
  const newer = await key.inject({ method: "POST", url: "/api/devices/self/node-file-changes", payload: { turnId: turn.id, nodeId: node.id, files: [{ ...file, updatedAt: new Date(Date.now() + 2000).toISOString() }] } });
  assert.equal(newer.statusCode, 200);
  const stale = await owner.inject({ method: "POST", url: "/api/node/files/query", headers, payload: { body: "Explain this", clientId: randomUUID(), target: staleTarget, fileQuotes: [{ source, from: 1, to: 1, text: "const answer = 1;", hash: null, draft: false }] } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, "FILE_TARGET_CHANGED");
  const elsewhere = originalFile({ path: join(root, "other-project"), label: "other project" }, "main.ts");
  await key.inject({ method: "POST", url: "/api/devices/self/node-file-changes", payload: { turnId: edited.id, nodeId: other.node.id, files: [{ ...elsewhere, updatedAt: new Date(Date.now() + 3000).toISOString() }] } });
  const sameNamed = await owner.inject({ method: "POST", url: "/api/node/files/target", headers, payload: { source } });
  assert.equal(sameNamed.json().target.nodeId, node.id, "same relative path on another checkout must not win");
  const denied = await stranger.inject({ method: "POST", url: "/api/node/files/target", headers, payload: { source } });
  assert.equal(denied.statusCode, 404);
});
