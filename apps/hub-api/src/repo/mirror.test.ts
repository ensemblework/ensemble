/**
 * Shallow mirror: clone once, reuse the cache, refresh when the TTL is gone,
 * fail closed on a timeout or a private repo with no credentials.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { makeTestDirectory } from "../test/temporary.js";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { cleanRemote, ensureMirror, estimateTokens, overviewViaGitHub, type GitRunner } from "./mirror.js";
import { RepoReadError } from "./read.js";

const exec = promisify(execFile);

async function tinyRemote(): Promise<{ remote: string; dir: string; commit: (name: string) => Promise<void> }> {
  const dir = makeTestDirectory("ensemble-mirror-src-");
  await exec("git", ["init", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "mirror@ensemble.test"], { cwd: dir });
  await exec("git", ["config", "user.name", "Mirror"], { cwd: dir });
  const commit = async (name: string) => {
    await writeFile(join(dir, name), `${name}\n`);
    await exec("git", ["add", name], { cwd: dir });
    await exec("git", ["commit", "-m", name], { cwd: dir });
  };
  await commit("README.md");
  return { remote: dir, dir, commit };
}

const auth = { config: [] as string[], env: { GIT_TERMINAL_PROMPT: "0" }, missing: false };

test("cleanRemote strips userinfo", () => {
  assert.equal(cleanRemote("https://x-access-token:ghp_secret@github.com/acme/app.git", "acme/app"), "https://github.com/acme/app.git");
  assert.equal(cleanRemote(null, "acme/app"), "https://github.com/acme/app.git");
  assert.equal(cleanRemote("https://x-access-token:ghp_secret@github.com/acme/app.git", "acme/app").includes("ghp_"), false);
});

test("a mirror is cloned once, reused, and refreshed after the TTL", async () => {
  const source = await tinyRemote();
  const cacheRoot = makeTestDirectory("ensemble-mirror-cache-");
  const calls: string[] = [];
  const run: GitRunner = async (args, options) => {
    calls.push(args[0] === "-c" ? args[2] ?? "" : args[0] ?? "");
    const { stdout } = await exec("git", args, { cwd: options.cwd, env: { ...process.env, ...options.env }, timeout: options.timeout });
    return stdout;
  };
  try {
    const first = await ensureMirror({
      userId: "user/one",
      fullName: "acme/app",
      remote: source.remote,
      cacheRoot,
      auth,
      run,
      now: 1_000,
      ttlMs: 10_000,
    });
    assert.equal(first.cached, false);
    const second = await ensureMirror({
      userId: "user/one",
      fullName: "acme/app",
      remote: source.remote,
      cacheRoot,
      auth,
      run: async () => {
        throw new Error("cache hit must not call git");
      },
      now: 2_000,
      ttlMs: 10_000,
    });
    assert.equal(second.cached, true);
    assert.equal(second.refreshed, false);
    assert.equal(second.head, first.head);
    await source.commit("again.txt");
    const third = await ensureMirror({
      userId: "user/one",
      fullName: "acme/app",
      remote: source.remote,
      cacheRoot,
      auth,
      run,
      now: 50_000,
      ttlMs: 10_000,
    });
    assert.equal(third.cached, true);
    assert.equal(third.refreshed, true);
    assert.notEqual(third.head, first.head);
    assert.ok(calls.includes("clone"));
  } finally {
    await rm(source.dir, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("a timeout and a private repo without credentials fail closed", async () => {
  const cacheRoot = makeTestDirectory("ensemble-mirror-fail-");
  try {
    await assert.rejects(
      () =>
        ensureMirror({
          userId: "local",
          fullName: "acme/slow",
          remote: "https://github.com/acme/slow.git",
          cacheRoot,
          timeoutMs: 30,
          auth,
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            throw Object.assign(new Error("timed out"), { killed: true });
          },
        }),
      (error: unknown) => error instanceof RepoReadError && /too long/i.test(error.message),
    );
    await assert.rejects(
      () =>
        ensureMirror({
          userId: "local",
          fullName: "acme/private",
          remote: "https://github.com/acme/private.git",
          cacheRoot,
          auth: { config: [], env: { GIT_TERMINAL_PROMPT: "0", ENSEMBLE_GIT_TOKEN: "ghp_should_not_leak" }, missing: true },
          run: async () => {
            throw new Error("Authentication failed for 'https://github.com/acme/private.git'");
          },
        }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        return error instanceof RepoReadError && /private or not visible/i.test(message) && !message.includes("ghp_should_not_leak");
      },
    );
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("a mirror over the size cap is deleted", async () => {
  const source = await tinyRemote();
  const cacheRoot = makeTestDirectory("ensemble-mirror-cap-");
  try {
    await assert.rejects(
      () =>
        ensureMirror({
          userId: "local",
          fullName: "acme/huge",
          remote: source.remote,
          cacheRoot,
          auth,
          maxBytes: 10,
        }),
      (error: unknown) => error instanceof RepoReadError && /larger than the cache/i.test(error.message),
    );
  } finally {
    await rm(source.dir, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("the GitHub fallback builds an overview without putting the token in the result", async () => {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/repos/acme/app")) {
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    }
    if (url.includes("/git/trees/")) {
      return new Response(
        JSON.stringify({
          tree: [
            { path: "README.md", type: "blob" },
            { path: "apps/web/package.json", type: "blob" },
            { path: "infra/docker-compose.yml", type: "blob" },
            { path: ".env", type: "blob" },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("/contents/")) {
      const body = url.includes("package.json")
        ? JSON.stringify({ name: "web" })
        : url.includes("docker-compose")
          ? "services:\n  postgres:\n    environment:\n      POSTGRES_PASSWORD: hunter2\n"
          : "# Hello\n";
      return new Response(JSON.stringify({ encoding: "base64", content: Buffer.from(body).toString("base64") }), { status: 200 });
    }
    return new Response("no", { status: 404 });
  };
  const overview = await overviewViaGitHub({ fullName: "acme/app", token: "ghp_test_token", fetchImpl });
  assert.ok(overview.apps.includes("web"));
  assert.ok(overview.compose.some((item) => item.services.includes("postgres")));
  const dumped = JSON.stringify(overview);
  assert.equal(dumped.includes("ghp_test_token"), false);
  assert.equal(dumped.includes("hunter2"), false);
  assert.equal(dumped.includes(".env"), false);
  assert.ok(estimateTokens(dumped) < estimateTokens(seen.join("\n") + dumped));
});
