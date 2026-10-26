import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { filesForModel, keepRecentAttachments, MODEL_ATTACH_TOTAL_BYTES, sniffImage } from "./model-input.js";
import type { AttachedFile } from "./attached.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function file(id: string, filename: string, kind: AttachedFile["kind"], byteSize = 12): AttachedFile {
  return { id, filename, format: filename.split(".").pop() ?? "", kind, byteSize, textCharacters: kind === "image" ? 0 : 40, pageCount: null, textStatus: kind === "image" ? "none" : "ready" };
}

/** Only what filesForModel reads: a file's row with its text and original. */
function db(rows: Record<string, { filename: string; text?: string; original: Uint8Array }>): PrismaClient {
  return {
    document: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        const row = rows[where.id];
        if (!row) return null;
        return { id: where.id, filename: row.filename, byteSize: row.original.byteLength, textCharacters: row.text?.length ?? 0, pageCount: null, parseStatus: row.text ? "ready" : "none", artifact: row.text ? { text: row.text } : null, original: Buffer.from(row.original), blobKey: null };
      },
    },
  } as unknown as PrismaClient;
}

const dataOf = (bytes: Uint8Array | string) => Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString("base64");

test("pictures are recognised by their bytes, not their names", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImage(new TextEncoder().encode("<svg xmlns=")), null);
});

test("every attached file goes to the model as itself: pictures as image parts, everything else as a file part", async () => {
  const store = db({
    p1: { filename: "chart.png", original: PNG },
    m1: { filename: "memo.pdf", text: "The vault code is 7391.", original: new TextEncoder().encode("%PDF-1.7 memo") },
    o1: { filename: "old.doc", text: "Legacy words.", original: new TextEncoder().encode("doc") },
    n1: { filename: "notes.md", text: "# Notes", original: new TextEncoder().encode("# Notes") },
    h1: { filename: "photo.heic", original: new TextEncoder().encode("heic") },
  });
  const files = [file("p1", "chart.png", "image"), file("m1", "memo.pdf", "pdf"), file("o1", "old.doc", "document"), file("n1", "notes.md", "text"), file("h1", "photo.heic", "image")];
  const read = await filesForModel(store, "u1", files, { viewTool: "hub_view_file" });
  assert.equal(read.attachments.length, 5, "nothing is left out because a model might not read it");
  assert.deepEqual(read.parts, [
    { type: "text", text: "Picture: chart.png" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${dataOf(PNG)}` } },
    { type: "text", text: "File: memo.pdf" },
    { type: "file", file: { filename: "memo.pdf", file_data: `data:application/pdf;base64,${dataOf("%PDF-1.7 memo")}` } },
    { type: "text", text: "File: old.doc" },
    { type: "file", file: { filename: "old.doc", file_data: `data:application/msword;base64,${dataOf("doc")}` } },
    { type: "text", text: "File: notes.md" },
    { type: "file", file: { filename: "notes.md", file_data: `data:text/markdown;base64,${dataOf("# Notes")}` } },
    { type: "text", text: "File: photo.heic" },
    { type: "file", file: { filename: "photo.heic", file_data: `data:image/heic;base64,${dataOf("heic")}` } },
  ]);
  assert.match(read.text, /Attached below\./);
  assert.doesNotMatch(read.text, /7391|Legacy words/, "no extracted text");
});

test("only what one request can carry is attached; the rest is named with the tool that opens it", async () => {
  const store = db({ b1: { filename: "big.pdf", original: new TextEncoder().encode("%PDF") }, s1: { filename: "small.pdf", original: new TextEncoder().encode("%PDF") } });
  const read = await filesForModel(store, "u1", [file("b1", "big.pdf", "pdf", MODEL_ATTACH_TOTAL_BYTES + 1), file("s1", "small.pdf", "pdf")], { viewTool: "view_attachment" });
  assert.deepEqual(read.attachments.map((attachment) => attachment.file.filename), ["small.pdf"]);
  assert.match(read.text, /big\.pdf[\s\S]*Not attached here: the files together are over 32\.0 MB\. Open it with view_attachment\./);
});

test("a long conversation keeps the newest attachments within the byte budget; the newest always stays", () => {
  const big = () => ({ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(4000)}` } });
  const messages = [{ content: [big()] }, { content: [big()] }];
  keepRecentAttachments(messages, 4, 3000);
  assert.equal((messages[0]!.content as Array<{ type: string }>)[0]!.type, "text");
  assert.equal((messages[1]!.content as Array<{ type: string }>)[0]!.type, "image_url");
  const filePart = () => ({ type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,AA" } });
  const files = [{ content: [filePart()] }, { content: [filePart()] }];
  keepRecentAttachments(files, 1);
  assert.deepEqual(files[0]!.content[0], { type: "text", text: "(A file given earlier; open it again to read it.)" });
  assert.equal((files[1]!.content[0] as { type: string }).type, "file");
});
