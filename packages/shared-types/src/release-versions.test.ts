import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repo = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repo), "utf8");

test("the download page links the desktop version the next desktop-v tag builds", () => {
  const tauri = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).version as string;
  assert.equal(JSON.parse(read("apps/desktop/package.json")).version, tauri);
  assert.equal(/^version = "([^"]+)"/m.exec(read("apps/desktop/src-tauri/Cargo.toml"))?.[1], tauri);
  assert.equal(/DESKTOP_VERSION = "([^"]+)"/.exec(read("apps/landing/lib/download.ts"))?.[1], tauri);
});
