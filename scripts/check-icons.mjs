/**
 * Validate the recommended app-icon containers as far as a Linux VM can.
 * iconutil and a real Windows shell are not available here.
 */
import { readFileSync } from "node:fs";

const icoPath = "design/icons/app-icon/png/recommended/ensemble.ico";
const icnsPath = "design/icons/app-icon/png/recommended/ensemble.icns";
const failures = [];

function fail(message) {
  failures.push(message);
}

function checkIco(buf) {
  if (buf.length < 6) return fail("ico: too small");
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) fail(`ico: bad header reserved=${reserved} type=${type}`);
  if (count < 1) fail("ico: no images");
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    if (at + 16 > buf.length) {
      fail(`ico: entry ${i} truncated`);
      continue;
    }
    const width = buf[at] || 256;
    const height = buf[at + 1] || 256;
    const bytes = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    sizes.push(`${width}x${height}`);
    if (offset + bytes > buf.length) fail(`ico: image ${width}x${height} exceeds file`);
    const magic = buf.subarray(offset, offset + 8);
    const png = magic[0] === 0x89 && magic[1] === 0x50;
    const dib = magic.readUInt32LE?.(0) === 40 || buf.readUInt32LE(offset) === 40;
    if (!png && !dib) fail(`ico: image ${width}x${height} is neither PNG nor BMP`);
  }
  const need = ["16x16", "32x32", "48x48", "256x256"];
  for (const size of need) if (!sizes.includes(size)) fail(`ico: missing ${size} (have ${sizes.join(", ")})`);
  console.log(`ico: ${count} images (${sizes.join(", ")})`);
}

function checkIcns(buf) {
  if (buf.subarray(0, 4).toString("ascii") !== "icns") fail("icns: missing magic");
  const declared = buf.readUInt32BE(4);
  if (declared !== buf.length) fail(`icns: length ${declared} != file ${buf.length}`);
  const known = new Set(["TOC ", "ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14", "ic04", "ic05", "is32", "il32", "ih32", "it32"]);
  const types = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const type = buf.subarray(offset, offset + 4).toString("ascii");
    const size = buf.readUInt32BE(offset + 4);
    if (size < 8 || offset + size > buf.length) {
      fail(`icns: chunk ${type} size ${size} at ${offset} is invalid`);
      break;
    }
    types.push(type);
    if (!known.has(type) && !/^[a-z][a-z0-9]{3}$/i.test(type)) fail(`icns: odd type ${type}`);
    offset += size;
  }
  if (offset !== buf.length) fail(`icns: stopped at ${offset} of ${buf.length}`);
  const pngChunks = types.filter((type) => type.startsWith("ic"));
  if (pngChunks.length < 4) fail(`icns: only ${pngChunks.length} modern chunks (${types.join(", ")})`);
  console.log(`icns: ${types.length} chunks (${types.join(", ")})`);
}

checkIco(readFileSync(icoPath));
checkIcns(readFileSync(icnsPath));
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("icon containers parsed");
