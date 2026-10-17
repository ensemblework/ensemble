import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ENSEMBLE_VERSION } from "./version.js";

const repo = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repo), "utf8");

test("the download page links the desktop version the next desktop-v tag builds", () => {
  const tauri = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).version as string;
  assert.equal(JSON.parse(read("apps/desktop/package.json")).version, tauri);
  assert.equal(/^version = "([^"]+)"/m.exec(read("apps/desktop/src-tauri/Cargo.toml"))?.[1], tauri);
  assert.equal(ENSEMBLE_VERSION, tauri);
  const canonical = JSON.parse(read("release.json")).version;
  for (const app of ["hub-api", "hub-web", "landing", "cli", "desktop"]) assert.equal(JSON.parse(read(`apps/${app}/package.json`)).version, canonical);
  assert.equal(ENSEMBLE_VERSION, canonical);
});
