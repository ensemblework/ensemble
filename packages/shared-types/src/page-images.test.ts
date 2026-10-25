import assert from "node:assert/strict";
import test from "node:test";
import {
  PAGE_IMAGE_MAX_BYTES,
  checkPageImage,
  dataUrlBytes,
  pageImageAlign,
  pageImageFileProblem,
  pageImageWidth,
  readImageHeader,
} from "./page-images.js";
import { testGif, testJpeg, testPng, testWebp } from "./page-images-testing.js";

test("the limit is exactly 2 MiB", () => {
  assert.equal(PAGE_IMAGE_MAX_BYTES, 2_097_152);
});

test("sizes are read from PNG, JPEG, GIF and WebP headers; EXIF turns a JPEG a quarter", () => {
  assert.deepEqual(readImageHeader(testPng(640, 480)), { format: "png", width: 640, height: 480 });
  assert.deepEqual(readImageHeader(testJpeg(1200, 800)), { format: "jpeg", width: 1200, height: 800 });
  assert.deepEqual(readImageHeader(testJpeg(1200, 800, 6)), { format: "jpeg", width: 800, height: 1200 });
  assert.deepEqual(readImageHeader(testJpeg(1200, 800, 1)), { format: "jpeg", width: 1200, height: 800 });
  assert.deepEqual(readImageHeader(testGif(32, 16)), { format: "gif", width: 32, height: 16 });
  assert.deepEqual(readImageHeader(testWebp(300, 200)), { format: "webp", width: 300, height: 200 });
  assert.deepEqual(readImageHeader(testWebp(300, 200, true)), { format: "webp", width: 300, height: 200 });
});

test("an image at the limit is accepted and one byte more is refused with what to do", () => {
  const at = checkPageImage({ filename: "site.png", bytes: testPng(10, 10, PAGE_IMAGE_MAX_BYTES), mediaType: "image/png", strict: true });
  assert.deepEqual(at, { ok: true, format: "png", width: 10, height: 10, mime: "image/png", filename: "site.png" });
  const over = checkPageImage({ filename: "site.png", bytes: testPng(10, 10, PAGE_IMAGE_MAX_BYTES + 1), strict: true });
  assert.deepEqual(over, { ok: false, status: 413, message: "site.png is just over 2 MB. Images in pages can be up to 2 MB: make it smaller, or attach it as a file with /file." });
  assert.equal(
    pageImageFileProblem({ name: "holiday.jpg", size: Math.round(3.4 * 1024 * 1024), type: "image/jpeg" }),
    "holiday.jpg is 3.4 MB. Images in pages can be up to 2 MB: make it smaller, or attach it as a file with /file.",
  );
  assert.equal(pageImageFileProblem({ name: "small.webp", size: PAGE_IMAGE_MAX_BYTES, type: "image/webp" }), null);
});

test("SVG is refused because it can carry scripts, by content or by name", () => {
  const svg = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  for (const input of [{ filename: "logo.svg", bytes: svg }, { filename: "logo.png", bytes: svg, mediaType: "image/png" }, { filename: "logo.svg", bytes: new Uint8Array([1, 2, 3]) }]) {
    const result = checkPageImage({ ...input, strict: true });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.message : "", /SVG files can carry scripts/);
  }
  assert.match(pageImageFileProblem({ name: "logo.svg", size: 10, type: "image/svg+xml" }) ?? "", /carry scripts/);
});

test("damaged, empty, unsupported and absurdly large pictures are refused", () => {
  const png = testPng(8, 8);
  const reason = (bytes: Uint8Array, filename = "shot.png") => {
    const result = checkPageImage({ filename, bytes, strict: true });
    return result.ok ? "ok" : `${result.status} ${result.message}`;
  };
  assert.match(reason(png.subarray(0, png.length - 12)), /^400 shot\.png looks damaged/, "no IEND: cut off");
  const badCrc = png.slice();
  badCrc[20] ^= 0xff;
  assert.match(reason(badCrc), /^400 .*damaged/, "header checksum");
  assert.match(reason(new TextEncoder().encode("just some text")), /^400 .*damaged/, "text named .png");
  assert.match(reason(new TextEncoder().encode("PK\u0003\u0004zip"), "notes.bin"), /^415 notes\.bin isn't a PNG, JPEG, GIF or WebP/);
  const heic = new Uint8Array(32);
  heic.set(new TextEncoder().encode("\0\0\0\u0018ftypheic\0\0\0\0mif1heic"), 0);
  assert.match(reason(heic, "IMG_1.heic"), /^415 .*isn't a PNG/);
  assert.match(reason(new Uint8Array()), /^400 shot\.png is empty/);
  assert.match(reason(testPng(0, 10)), /^400 .*no width or height/);
  assert.match(reason(testPng(20_000, 10)), /^413 .*20,000 × 10 pixels/);
  assert.match(reason(testPng(8_000, 8_000)), /^413 .*40 megapixels/);
  assert.equal(reason(testPng(16_384, 2_000)), "ok");
  const jpeg = testJpeg(4, 4);
  assert.match(reason(jpeg.subarray(0, jpeg.length - 2), "a.jpg"), /damaged/, "no end-of-image marker");
});

test("the server refuses a name or type that says another format; the editor corrects the name", () => {
  const jpeg = testJpeg(4, 3);
  const strict = checkPageImage({ filename: "photo.png", bytes: jpeg, strict: true });
  assert.deepEqual(strict, { ok: false, status: 415, message: "photo.png is named .png but holds a JPEG image. Rename it to .jpg and add it again." });
  const typed = checkPageImage({ filename: "photo.jpg", bytes: jpeg, mediaType: "image/png", strict: true });
  assert.equal(typed.ok ? "" : typed.message, "photo.jpg was sent as image/png but holds a JPEG image. Rename it to .jpg and add it again.");
  assert.equal(checkPageImage({ filename: "photo.jpeg", bytes: jpeg, mediaType: "image/jpg", strict: true }).ok, true);
  const fixed = checkPageImage({ filename: "photo.png", bytes: jpeg, mediaType: "image/png" });
  assert.equal(fixed.ok && fixed.filename, "photo.jpg");
  const named = checkPageImage({ filename: "Screenshot", bytes: testPng(), strict: true });
  assert.equal(named.ok && named.filename, "Screenshot.png");
});

test("data: URLs are measured without decoding them", () => {
  const payload = Buffer.from(new Uint8Array(1000)).toString("base64");
  assert.equal(dataUrlBytes(`data:image/png;base64,${payload}`), 1000);
  assert.equal(dataUrlBytes("data:image/svg+xml,%3Csvg%3E"), 5);
  assert.equal(dataUrlBytes("https://example.com/a.png"), null);
});

test("width and alignment are normalised", () => {
  assert.deepEqual([pageImageWidth(55), pageImageWidth("60%"), pageImageWidth(3), pageImageWidth(140), pageImageWidth(null), pageImageWidth("wide")], [55, 60, 10, 100, null, null]);
  assert.deepEqual([pageImageAlign("left"), pageImageAlign("right"), pageImageAlign("middle"), pageImageAlign(undefined)], ["left", "right", "center", "center"]);
});
