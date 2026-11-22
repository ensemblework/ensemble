import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { fetchWindowsCuaDriver, signerOrganisation, WINDOWS_CUA_DRIVER_PIN, zipMember } from "./fetch-cua-driver.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
mkdirSync(join(root, "node_modules", ".cache"), { recursive: true });
const scratch = mkdtempSync(join(root, "node_modules", ".cache", "fetch-cua-driver-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A zip archive of `files` (deflated, or stored when `store`). */
function zip(files, store = false) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const packed = store ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(store ? 0 : 8, 10);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("a zip member is read from the archive's directory, deflated or stored, and a missing one is named", () => {
  for (const store of [false, true]) {
    const archive = zip({ "a/README": "hello", "a/cua-driver.exe": "MZ program bytes ".repeat(100) }, store);
    assert.equal(zipMember(archive, "a/cua-driver.exe").toString(), "MZ program bytes ".repeat(100));
    assert.equal(zipMember(archive, "a/README").toString(), "hello");
    assert.throws(() => zipMember(archive, "a/other.exe"), /a\/other\.exe is not in the zip archive/);
  }
  assert.throws(() => zipMember(Buffer.from("not a zip at all, just some text that is long enough"), "x"), /not a zip archive/);
});

test("the Windows driver comes out of an archive only when the archive and the program match their pinned checksums", async () => {
  const pin = WINDOWS_CUA_DRIVER_PIN;
  assert.deepEqual(Object.keys(pin.assets).sort(), ["arm64", "x64"]);
  const folder = pin.assets.x64.member.replace(/\/cua-driver\.exe$/, "");
  const archive = join(scratch, "wrong.zip");
  writeFileSync(archive, zip({ [pin.assets.x64.member]: "a different program", [`${folder}/THIRD_PARTY_NOTICES.md`]: "notices" }));
  process.env.ENSEMBLE_CUA_DRIVER_ARCHIVE = archive;
  try {
    const out = join(scratch, "out");
    mkdirSync(out, { recursive: true });
    await assert.rejects(fetchWindowsCuaDriver({ out, arch: "x64" }), (error) => error.message.includes(createHash("sha256").update(readFileSync(archive)).digest("hex")) && error.message.includes(pin.assets.x64.sha256));
    await assert.rejects(fetchWindowsCuaDriver({ out, arch: "ia32" }), /no Windows build for ia32/);
  } finally {
    delete process.env.ENSEMBLE_CUA_DRIVER_ARCHIVE;
  }
});

test("the signer is the certificate subject's organisation, quoted when it holds a comma", () => {
  assert.equal(signerOrganisation('CN="Cua AI, Inc.", O="Cua AI, Inc.", L=San Francisco, S=California, C=US'), "Cua AI, Inc.");
  assert.equal(signerOrganisation("CN=Someone, O=Other Ltd, C=GB"), "Other Ltd");
  assert.equal(signerOrganisation('CN="Cua AI, Inc."'), null, "a common name alone is not the organisation");
});
