/**
 * `git clone` for an agent, run by Ensemble: which commands it takes, and the checks before any
 * network call. The engine judge hands a sandboxed engine's clone here instead of letting it fail
 * on the sandbox's .git rules.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkspaceJob } from "@prisma/client";
import { defaultCloneFolder, gitSubcommand, parseClone, publicHttpsUrl } from "./clone.js";

// tools.ts pulls in the API config. A unit run has no .env; the value is never connected to.
process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
const { cloneForAgent } = await import("./tools.js");
const { judgeEngineCall, setCloneRunnerForTests } = await import("./engines/judge.js");
type Ctx = Parameters<typeof cloneForAgent>[0];

const argv = (line: string) => line.split(/\s+/);

test("a clone takes a public https URL, an optional folder and only the flags that shape the fetch", () => {
  assert.deepEqual(parseClone(argv("git clone https://github.com/morluto/rea")), { url: "https://github.com/morluto/rea", dest: "rea", flags: [] });
  assert.deepEqual(parseClone(argv("git clone --depth 1 -b main https://github.com/a/b.git src/b 2>&1")), {
    url: "https://github.com/a/b.git",
    dest: "src/b",
    flags: ["--depth", "1", "--branch", "main"],
  });
  assert.deepEqual(parseClone(argv("git --no-pager clone --filter=blob:none -q https://gitlab.com/g/p.git > log")), { url: "https://gitlab.com/g/p.git", dest: "p", flags: ["--filter", "blob:none", "-q"] });
  for (const line of [
    "git clone -c core.hooksPath=x https://github.com/a/b",
    "git clone --upload-pack=touch https://github.com/a/b",
    "git clone --config core.fsmonitor=x https://github.com/a/b",
    "git clone --template=/tmp/t https://github.com/a/b",
    "git clone --recurse-submodules https://github.com/a/b",
    "git clone --separate-git-dir /tmp/g https://github.com/a/b",
    "git clone -b --upload-pack=x https://github.com/a/b",
    "git clone git@github.com:a/b.git",
    "git clone ssh://github.com/a/b",
    "git clone http://github.com/a/b",
    "git clone file:///etc/repo",
    "git clone /Users/me/repo",
    "git clone https://user@github.com/a/b",
    "git clone https://github.com/a/b?x=1",
    "git clone https://localhost/a/b",
    "git clone https://github.com/a/b one two",
    "git clone",
  ]) {
    assert.ok("error" in parseClone(argv(line)), line);
  }
});

test("URLs and folder names", () => {
  assert.equal(publicHttpsUrl("https://github.com/a/b.git"), "https://github.com/a/b.git");
  assert.equal(publicHttpsUrl("https://github.com/a/../b"), "https://github.com/b", "dot segments are resolved, never sent");
  assert.equal(publicHttpsUrl("https://github.com:8443/a/b"), null);
  assert.equal(defaultCloneFolder("https://github.com/a/b.git/"), "b");
  assert.equal(gitSubcommand(["git", "clone", "x"]), "clone");
  assert.equal(gitSubcommand(["/usr/bin/git", "--no-pager", "status"]), "status");
  assert.equal(gitSubcommand(["npm", "clone"]), null);
});

function ctx(root: string, over: Partial<Ctx> = {}): Ctx {
  return {
    job: { id: "job-1", provider: "claude-code", delivery: "local", unattended: true, askBeforePublish: false, accessMode: "read-write" } as WorkspaceJob,
    userId: "u1",
    root,
    sandboxed: true,
    network: true,
    trusted: true,
    explicitTrust: false,
    silentWorkspace: true,
    accessMode: "read-write",
    strength: "strong",
    blockedOutside: [],
    runBranch: "",
    signal: new AbortController().signal,
    event: async () => undefined,
    progress: async () => undefined,
    ...over,
  } as unknown as Ctx;
}

test("before any network call: internet, read-only runs, folders outside or already there", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clone-checks-")));
  const url = "git clone https://github.com/a/b";
  assert.match((await cloneForAgent(ctx(root, { network: false }), argv(url), url)).message, /internet is off/);
  assert.match((await cloneForAgent(ctx(root, { accessMode: "review" }), argv(url), url)).message, /read-only/);
  assert.match((await cloneForAgent(ctx(root), argv("git clone https://github.com/a/b ../escape"), url)).message, /outside/);
  assert.match((await cloneForAgent(ctx(root), argv("git clone https://github.com/a/b ."), url)).message, /new folder/);
  assert.match((await cloneForAgent(ctx(root), argv("git clone https://github.com/a/b .git/x"), url)).message, /\.git/);
  mkdirSync(join(root, "b"));
  writeFileSync(join(root, "b", "README.md"), "hi");
  const taken = await cloneForAgent(ctx(root), argv(url), url);
  assert.equal(taken.ok, false);
  assert.match(taken.message, /already exists/);
});

test("a sandboxed engine's git clone is done by Ensemble; the engine is told where it is", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clone-judge-")));
  const calls: string[][] = [];
  setCloneRunnerForTests(async (_ctx, args) => {
    calls.push(args);
    return { ok: true, result: {}, summary: "cloned", message: "Done: Ensemble cloned it into rea/." };
  });
  try {
    const run = ctx(root);
    const alone = await judgeEngineCall(run, { tool: "Bash", input: { command: "git clone https://github.com/morluto/rea" } });
    assert.equal(alone.decision, "deny", "the engine's own clone is not run");
    assert.match(alone.message ?? "", /^Done: Ensemble cloned/);
    assert.deepEqual(calls[0], ["git", "clone", "https://github.com/morluto/rea"]);
    const chained = await judgeEngineCall(run, { tool: "Bash", input: { command: "git clone https://github.com/morluto/rea && cd rea && ls" } });
    assert.match(chained.message ?? "", /rest of your command .* was not run/);
    const after = await judgeEngineCall(run, { tool: "Bash", input: { command: "mkdir x && cd x && git clone https://github.com/morluto/rea" } });
    assert.equal(after.decision, "deny");
    assert.match(after.message ?? "", /own command/);
    assert.equal(calls.length, 2, "a clone after other commands is not run");
    // Without its sandbox the engine's git works as usual: the clone goes through the normal checks.
    const unsandboxed = await judgeEngineCall(ctx(root, { sandboxed: false, network: true }), { tool: "Bash", input: { command: "git clone https://github.com/morluto/rea" } });
    assert.equal(unsandboxed.decision, "allow");
    // Codex and Cursor get a bare decline, never this message, so their clone is judged as before.
    const codex = ctx(root, { network: true });
    codex.job = { ...codex.job, provider: "codex" } as WorkspaceJob;
    assert.equal((await judgeEngineCall(codex, { tool: "Bash", input: { command: "git clone https://github.com/morluto/rea" } })).decision, "allow");
    assert.equal(calls.length, 2);
  } finally {
    setCloneRunnerForTests(null);
  }
});
