import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { makeTestDirectory } from "../test/temporary.js";
import { deleteRepoEntry, moveRepoEntry, packRepoEntry } from "./git.js";

const exec = promisify(execFile);

async function repo() {
  const root = makeTestDirectory("ensemble-explorer-");
  await exec("git", ["init", "-q"], { cwd: root });
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "a");
  await writeFile(join(root, "src", "lib", "b.ts"), "b");
  await writeFile(join(root, ".gitignore"), "dist/\n");
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "big.js"), "built");
  await writeFile(join(root, ".env"), "SECRET=1");
  return root;
}

test("the explorer moves and renames inside the repository, never over something or into itself", async () => {
  const root = await repo();
  try {
    await moveRepoEntry(root, "src/a.ts", "src/lib/a.ts");
    assert.equal(await readFile(join(root, "src", "lib", "a.ts"), "utf8"), "a");
    await moveRepoEntry(root, "src/lib/a.ts", "src/lib/renamed.ts");
    assert.ok(await stat(join(root, "src", "lib", "renamed.ts")));
    await assert.rejects(moveRepoEntry(root, "src/lib/renamed.ts", "src/lib/b.ts"), /already there/);
    await assert.rejects(moveRepoEntry(root, "src", "src/lib/src"), /inside itself/);
    await assert.rejects(moveRepoEntry(root, "src/lib/b.ts", ".git/b.ts"), /Git's own files/);
    await assert.rejects(moveRepoEntry(root, "src/lib/b.ts", "../outside.ts"), /outside the repository|not in the repository/);
    await deleteRepoEntry(root, "src/lib");
    await assert.rejects(stat(join(root, "src", "lib")));
    await assert.rejects(deleteRepoEntry(root, ""), /Choose a file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a download zips what git would show: no ignored build output, no secrets", async () => {
  const root = await repo();
  try {
    const secret = (path: string) => path.endsWith(".env");
    const whole = await packRepoEntry(root, "", secret);
    assert.equal(whole.kind, "zip");
    const files = Object.keys(unzipSync(whole.bytes)).sort();
    const name = root.split("/").pop();
    assert.deepEqual(files, [`${name}/.gitignore`, `${name}/src/a.ts`, `${name}/src/lib/b.ts`]);
    const folder = await packRepoEntry(root, "src/lib", secret);
    assert.deepEqual(Object.keys(unzipSync(folder.bytes)), ["lib/b.ts"]);
    const file = await packRepoEntry(root, "src/a.ts", secret);
    assert.equal(file.kind, "file");
    assert.equal(Buffer.from(file.bytes).toString(), "a");
    await assert.rejects(packRepoEntry(root, ".env", secret), /keys or secrets/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
