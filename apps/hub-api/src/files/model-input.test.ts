import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { filesForModel, keepRecentPictures, MODEL_IMAGE_MAX_BYTES, sniffImage } from "./model-input.js";
import type { AttachedFile } from "./attached.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function file(id: string, filename: string, kind: AttachedFile["kind"], byteSize = PNG.byteLength): AttachedFile {
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

test("pictures are recognised by their bytes, not their names", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImage(new TextEncoder().encode("<svg xmlns=")), null);
});

test("a model that reads images gets the picture; one that does not is told it cannot see it", async () => {
  const store = db({ p1: { filename: "chart.png", original: PNG }, d1: { filename: "notes.txt", text: "Revenue rose 12% in Q3.", original: new TextEncoder().encode("Revenue rose 12% in Q3.") } });
  const files = [file("p1", "chart.png", "image"), file("d1", "notes.txt", "text")];
  const seeing = await filesForModel(store, "u1", files, { images: true });
  assert.equal(seeing.images.length, 1);
  assert.match(seeing.text, /Revenue rose 12% in Q3\./);
  assert.match(seeing.text, /The picture is included below\./);
  assert.deepEqual(seeing.parts[0], { type: "text", text: "Picture: chart.png" });
  assert.match((seeing.parts[1] as { image_url: { url: string } }).image_url.url, /^data:image\/png;base64,/);
  const blind = await filesForModel(store, "u1", files, { images: false });
  assert.equal(blind.parts.length, 0);
  assert.match(blind.text, /cannot see pictures/);
});

test("a picture that is not really a picture, or is too large, is explained instead of sent", async () => {
  const store = db({ s1: { filename: "logo.png", original: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>") } });
  const read = await filesForModel(store, "u1", [file("s1", "logo.png", "image"), file("b1", "huge.jpg", "image", MODEL_IMAGE_MAX_BYTES + 1)], { images: true });
  assert.equal(read.parts.length, 0);
  assert.match(read.text, /not a PNG, JPEG, GIF or WebP picture/);
  assert.match(read.text, /models take pictures up to 3\.75 MB/);
});

test("older pictures go once together they outgrow the byte budget; the newest stays", () => {
  const big = () => ({ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(4000)}` } });
  const messages = [{ content: [big()] }, { content: [big()] }];
  keepRecentPictures(messages, 4, 3000);
  assert.equal((messages[0]!.content as Array<{ type: string }>)[0]!.type, "text");
  assert.equal((messages[1]!.content as Array<{ type: string }>)[0]!.type, "image_url");
});

test("only the newest pictures stay in a long conversation", () => {
  const picture = () => ({ type: "image_url", image_url: { url: "data:image/png;base64,AA" } });
  const messages = [{ content: [picture(), picture()] }, { content: "text" }, { content: [{ type: "text", text: "x" }, picture()] }];
  keepRecentPictures(messages, 2);
  assert.equal((messages[0]!.content as Array<{ type: string }>)[0]!.type, "text");
  assert.equal((messages[0]!.content as Array<{ type: string }>)[1]!.type, "image_url");
  assert.equal((messages[2]!.content as Array<{ type: string }>)[1]!.type, "image_url");
});
