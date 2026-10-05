import assert from "node:assert/strict";
import test from "node:test";
import { fetchPublicTable, isBlockedAddress, normalizeSheetUrl, SsrfError } from "./ssrf.js";

test("private and metadata addresses are blocked", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.4", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("1.1.1.1"), false);
});

test("google sheets and drive links become export urls", () => {
  const sheets = normalizeSheetUrl("https://docs.google.com/spreadsheets/d/abc_123/edit?gid=7#gid=7");
  assert.match(sheets, /\/export\?format=xlsx/);
  assert.match(sheets, /gid=7/);
  const drive = normalizeSheetUrl("https://drive.google.com/file/d/FILE123/view");
  assert.equal(drive, "https://drive.google.com/uc?export=download&id=FILE123");
});

test("http, credentials, and unknown hosts are refused", async () => {
  await assert.rejects(() => fetchPublicTable("http://docs.google.com/spreadsheets/d/abc/edit"), SsrfError);
  await assert.rejects(() => fetchPublicTable("https://user:pw@docs.google.com/spreadsheets/d/abc/edit"), SsrfError);
  await assert.rejects(
    () => fetchPublicTable("https://evil.example/sheet.csv", { lookup: async () => ["8.8.8.8"] }),
    /not a spreadsheet/i,
  );
  await assert.rejects(
    () => fetchPublicTable("https://docs.google.com/spreadsheets/d/abc/export?format=csv", { lookup: async () => ["127.0.0.1"] }),
    /private/i,
  );
});

test("a redirect onto a private host is refused", async () => {
  await assert.rejects(
    () =>
      fetchPublicTable("https://docs.google.com/spreadsheets/d/abc/export?format=csv", {
        lookup: async (host) => (host === "docs.google.com" ? ["8.8.8.8"] : ["127.0.0.1"]),
        fetch: async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } }),
      }),
    /not a spreadsheet|private/i,
  );
});

test("an allowlisted file is returned and html is refused", async () => {
  const ok = await fetchPublicTable("https://docs.google.com/spreadsheets/d/abc/export?format=csv", {
    lookup: async () => ["8.8.8.8"],
    fetch: async () => new Response("a,b\n1,2\n", { status: 200, headers: { "content-type": "text/csv" } }),
  });
  assert.equal(new TextDecoder().decode(ok.bytes), "a,b\n1,2\n");
  await assert.rejects(
    () =>
      fetchPublicTable("https://docs.google.com/spreadsheets/d/abc/export?format=csv", {
        lookup: async () => ["8.8.8.8"],
        fetch: async () => new Response("<html>sign in</html>", { status: 200, headers: { "content-type": "text/html" } }),
      }),
    /web page/i,
  );
});
