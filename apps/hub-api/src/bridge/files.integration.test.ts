import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness, type HttpUser } from "../test/http.js";

const h = await createHttpHarness();
after(() => h.close());
const db = h.prisma;
const { saveFile } = await import("../files/store.js");
const { fileTextSettled } = await import("../files/extract.js");
const { FILE_ANSWER_MAX_BYTES } = await import("./files.js");

const READINGS = Array.from({ length: 60 }, (_, index) => `Reading ${index + 1}: north field pH 7.${index % 10}`).join("\n");

async function file(user: HttpUser, filename: string, body: string | Uint8Array) {
  const saved = await saveFile(db, user.id, { filename, mediaType: "application/octet-stream", bytes: typeof body === "string" ? new TextEncoder().encode(body) : body }, { summarize: false });
  await fileTextSettled(saved.id);
  return saved;
}

type FileAnswer = {
  file: { id: string; filename: string; summary: string | null; mediaType: string; textual: boolean; tags: { projects: Array<{ name: string }> } };
  text?: { text: string; offset: number; total: number; nextOffset: number | null };
  original?: { base64?: string; mediaType?: string; omitted?: boolean; note?: string };
};

test("any key reads a file: details and summary, Ensemble's text in parts, and the original up to the cap or any size raw", async () => {
  const user = await h.asUser();
  const key = await h.asToken(user, "bridge");
  const readings = await file(user, "readings.txt", READINGS);
  const project = await db.project.create({ data: { userId: user.id, name: "Soil survey", createdBy: "me" } });
  await db.document.update({ where: { id: readings.id }, data: { summary: "Soil readings from the north field.", projectIds: [project.id] } });

  const details = await key.inject({ method: "GET", url: `/api/bridge/files/${readings.id}` });
  assert.equal(details.statusCode, 200, details.body);
  const plain = details.json<FileAnswer>();
  assert.equal(plain.file.summary, "Soil readings from the north field.");
  assert.equal(plain.file.mediaType, "text/plain");
  assert.equal(plain.file.textual, true);
  assert.deepEqual(plain.file.tags.projects.map((row) => row.name), ["Soil survey"]);
  assert.equal(plain.text, undefined);
  assert.equal(plain.original, undefined, "the bytes only when asked");

  const part = (await key.inject({ method: "GET", url: `/api/bridge/files/${readings.id}?text=1&offset=0&limit=200` })).json<FileAnswer>();
  assert.equal(part.text?.offset, 0);
  assert.equal(part.text?.total, READINGS.length);
  assert.ok(part.text!.text.startsWith("Reading 1: north field"));
  assert.ok(part.text?.nextOffset && part.text.nextOffset <= 200);

  const whole = (await key.inject({ method: "GET", url: `/api/bridge/files/${readings.id}?original=1` })).json<FileAnswer>();
  assert.equal(Buffer.from(whole.original!.base64!, "base64").toString("utf8"), READINGS);

  const raw = await key.inject({ method: "GET", url: `/api/bridge/files/${readings.id}/original` });
  assert.equal(raw.statusCode, 200);
  assert.equal(raw.body, READINGS);
  assert.match(String(raw.headers["content-type"]), /^text\/plain/);
  assert.match(String(raw.headers["content-disposition"]), /^attachment; filename="readings\.txt"/);
  assert.equal(raw.headers["x-content-type-options"], "nosniff");

  // Over the cap, an answer says so instead of carrying the bytes; the raw route still gives them.
  await db.document.update({ where: { id: readings.id }, data: { byteSize: FILE_ANSWER_MAX_BYTES + 1 } });
  const capped = (await key.inject({ method: "GET", url: `/api/bridge/files/${readings.id}?original=1` })).json<FileAnswer>();
  assert.equal(capped.original?.omitted, true);
  assert.equal(capped.original?.base64, undefined);
  assert.match(capped.original?.note ?? "", /over the 20 MB one answer carries: save it with saveTo/);
  assert.equal((await key.inject({ method: "GET", url: `/api/bridge/files/${readings.id}/original` })).body, READINGS);

  const stranger = await h.asToken(await h.asUser(), "bridge");
  assert.equal((await stranger.inject({ method: "GET", url: `/api/bridge/files/${readings.id}` })).statusCode, 404);
  assert.equal((await stranger.inject({ method: "GET", url: `/api/bridge/files/${readings.id}/original` })).statusCode, 404);
});

test("files are listed and found by their summary, ensemble_read gives the summary, and nothing reaches Files' own routes", async () => {
  const user = await h.asUser();
  const key = await h.asToken(user, "bridge");
  await db.apiToken.update({ where: { id: key.id }, data: { canWrite: true } });
  const readings = await file(user, "readings.txt", READINGS);
  const other = await file(user, "budget.csv", "line,amount\nsensors,120");
  const project = await db.project.create({ data: { userId: user.id, name: "Soil survey", createdBy: "me" } });
  await db.document.update({ where: { id: readings.id }, data: { summary: "Soil acidity readings from the north field.", projectIds: [project.id] } });

  const bySummary = await key.inject({ method: "GET", url: "/api/bridge/files?q=acidity" });
  assert.equal(bySummary.statusCode, 200, bySummary.body);
  assert.deepEqual(bySummary.json<{ files: Array<{ id: string }> }>().files.map((row) => row.id), [readings.id]);
  const byText = await key.inject({ method: "GET", url: "/api/bridge/files?q=sensors" });
  assert.deepEqual(byText.json<{ files: Array<{ id: string }> }>().files.map((row) => row.id), [other.id]);
  const onProject = await key.inject({ method: "GET", url: `/api/bridge/files?on=${encodeURIComponent(`ensemble://project/${project.id}`)}` });
  assert.deepEqual(onProject.json<{ files: Array<{ id: string; summary: string }> }>().files.map((row) => row.id), [readings.id]);
  assert.equal((await key.inject({ method: "GET", url: "/api/bridge/files?on=not-a-record" })).statusCode, 400);

  const read = await key.inject({ method: "GET", url: `/api/bridge/read?kind=document&id=${readings.id}` });
  assert.equal(read.statusCode, 200, read.body);
  const item = read.json<{ summary: string; note: string }>();
  assert.equal(item.summary, "Soil acidity readings from the north field.");
  assert.match(item.note, /ensemble_get_file/);
  assert.doesNotMatch(read.body, /Reading 1:/, "ensemble_read gives no file text");

  const search = await key.inject({ method: "GET", url: "/api/bridge/search?q=acidity&kinds=file" });
  const hits = search.json<{ results: Array<{ id: string; kind: string; excerpt: string }> }>().results;
  assert.equal(hits[0]?.id, readings.id);
  assert.equal(hits[0]?.kind, "document");
  assert.match(hits[0]!.excerpt, /acidity/);

  // A key changes files only by adding new ones.
  assert.equal((await key.inject({ method: "DELETE", url: `/api/documents/${readings.id}` })).statusCode, 403);
  assert.equal((await key.inject({ method: "PUT", url: `/api/documents/${readings.id}/content`, payload: { dataBase64: Buffer.from("x").toString("base64") } })).statusCode, 403);
  assert.equal((await key.inject({ method: "GET", url: `/api/documents/${readings.id}/original` })).statusCode, 403);
  assert.equal((await db.document.findUniqueOrThrow({ where: { id: readings.id } })).deletedAt, null);
});

test("the hosted MCP endpoint gives a picture as an image and a PDF as an embedded resource", async () => {
  const user = await h.asUser();
  const key = await h.asToken(user, "bridge");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const picture = await file(user, "chart.png", png);
  const pdf = await file(user, "deck.pdf", "%PDF-1.4 tiny deck");
  const call = async (args: Record<string, unknown>) => {
    const response = await key.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ensemble_get_file", arguments: args } }),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ result: { isError?: boolean; content: Array<{ type: string; data?: string; mimeType?: string; resource?: { blob?: string; mimeType?: string } }> } }>().result;
  };
  const image = await call({ id: picture.id });
  assert.notEqual(image.isError, true, JSON.stringify(image));
  assert.equal(image.content[1]?.type, "image");
  assert.equal(image.content[1]?.mimeType, "image/png");
  assert.deepEqual(Buffer.from(image.content[1]!.data!, "base64"), png);
  const deck = await call({ id: `ensemble://file/${pdf.id}`, saveTo: "deck.pdf" });
  assert.equal(deck.content[1]?.type, "resource", "the web cannot save to a disk, so saveTo is not taken");
  assert.equal(deck.content[1]?.resource?.mimeType, "application/pdf");
  assert.equal(Buffer.from(deck.content[1]!.resource!.blob!, "base64").toString(), "%PDF-1.4 tiny deck");
});
