/**
 * The split saved folders list against Postgres: the terminal reads only
 * `terminal.roots`, the Code tab (code.ts and repo/locate.ts) reads only
 * `code.roots`, Settings checks every Code folder it adds, and the startup
 * upgrade copies folders saved before the split into both lists exactly once.
 * Skips when the database is down.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { ZodError } from "zod";
import { upgradeCodeFolders } from "../lib/code-folders.js";
import { prisma } from "../lib/prisma.js";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { allowedRoots } from "../repo/locate.js";
import "../types.js";
import { codeRoutes } from "./code.js";
import { contextRoutes } from "./context.js";
import { settingsRoutes } from "./settings.js";
import { terminalRoutes } from "./terminal.js";

const MODULES = "code,diagrams,metrics,runs,skills,workspace";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/** Two folders, each holding one git checkout: one only the terminal may use, one only Code may use. */
// macOS tmpdir() is under /private/var, which blockedReason refuses.
// /tmp resolves to /private/tmp, which it allows.
function scratchRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

const base = realpathSync(mkdtempSync(join(scratchRoot(), "ensemble-code-split-")));
const terminalOnly = join(base, "terminal-only");
const codeOnly = join(base, "code-only");
const added = join(base, "added");
for (const [folder, repo] of [
  [terminalOnly, "term-repo"],
  [codeOnly, "code-repo"],
  [added, "added-repo"],
] as const) {
  mkdirSync(join(folder, repo), { recursive: true });
  execFileSync("git", ["init", "-q", join(folder, repo)]);
}
test.after(() => rmSync(base, { recursive: true, force: true }));

async function build(userId: () => string): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("redis", { get: async () => null, set: async () => "OK", del: async () => 1 } as unknown as Redis);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(statusCode).send({ error: (error as Error).message });
  });
  app.addHook("onRequest", async (request) => {
    request.userId = userId();
    request.authVia = "session";
    request.modules = MODULES;
  });
  await app.register(codeRoutes);
  await app.register(terminalRoutes);
  await app.register(settingsRoutes);
  await app.register(contextRoutes);
  return app;
}

async function person(label: string) {
  return prisma.user.create({ data: { email: `${label}-${Date.now()}-${randomBytes(3).toString("hex")}@ensemble.test`, name: label } });
}

async function cleanup(userId: string): Promise<void> {
  await prisma.preference.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

test("the terminal never reads the Code list, and Code never reads the terminal's", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await person("split");
  const app = await build(() => user.id);
  try {
    await saveSettings(prisma, user.id, { terminal: { roots: [terminalOnly] }, code: { roots: [codeOnly] } });

    const terminal = await app.inject({ method: "GET", url: "/api/terminal/status" });
    assert.equal(terminal.statusCode, 200, terminal.body);
    const terminalRoots = terminal.json().roots as string[];
    assert.equal(terminalRoots.includes(terminalOnly), true, "the terminal keeps its own folder");
    assert.equal(terminalRoots.includes(codeOnly), false, "the terminal must not read code.roots");

    const repos = await app.inject({ method: "GET", url: "/api/code/repos" });
    assert.equal(repos.statusCode, 200, repos.body);
    const listed = repos.json() as { repos: string[]; roots: string[] };
    assert.equal(listed.repos.includes(join(codeOnly, "code-repo")), true, "Code lists repos in code.roots");
    assert.equal(listed.repos.includes(join(terminalOnly, "term-repo")), false, "Code must not list repos in terminal.roots");
    assert.equal(listed.roots.includes(terminalOnly), false);

    const inCode = await app.inject({ method: "GET", url: `/api/code/scm?repo=${encodeURIComponent(join(codeOnly, "code-repo"))}` });
    assert.equal(inCode.statusCode, 200, inCode.body);
    const inTerminal = await app.inject({ method: "GET", url: `/api/code/scm?repo=${encodeURIComponent(join(terminalOnly, "term-repo"))}` });
    assert.equal(inTerminal.statusCode, 403, `review of a terminal-only folder: ${inTerminal.body}`);
    assert.match(inTerminal.json().error, /folders Code can use/);

    const located = await allowedRoots(prisma, user.id);
    assert.equal(located.includes(codeOnly), true, "repo/locate.ts reads code.roots");
    assert.equal(located.includes(terminalOnly), false, "repo/locate.ts must not read terminal.roots");
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("Settings checks every Code folder it adds; the terminal list is saved as before", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const user = await person("save");
  const app = await build(() => user.id);
  try {
    await saveSettings(prisma, user.id, { code: { roots: [codeOnly] } });
    for (const path of ["/", "/etc", "~", "~/.ssh", "~/.config/ensemble", `${added}/../code-only`, "relative/path"]) {
      const resolved = await app.inject({ method: "POST", url: "/api/code/folders/resolve", payload: { path } });
      assert.equal(resolved.statusCode, 403, `resolve ${path}: ${resolved.body}`);
      const saved = await app.inject({ method: "PATCH", url: "/api/settings", payload: { code: { roots: [codeOnly, path] } } });
      assert.equal(saved.statusCode, 403, `save ${path}: ${saved.body}`);
    }
    assert.deepEqual((await loadSettings(prisma, user.id)).code.roots, [codeOnly], "a refused save changes nothing");

    const ok = await app.inject({ method: "POST", url: "/api/code/folders/resolve", payload: { path: added } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().path, added);
    const save = await app.inject({ method: "PATCH", url: "/api/settings", payload: { code: { roots: [codeOnly, added] } } });
    assert.equal(save.statusCode, 200, save.body);
    assert.deepEqual(save.json().settings.code.roots, [codeOnly, added]);
    const listed = await app.inject({ method: "GET", url: "/api/code/repos" });
    assert.equal((listed.json().repos as string[]).includes(join(added, "added-repo")), true, "a folder added in Settings is listed in Code");

    const removed = await app.inject({ method: "PATCH", url: "/api/settings", payload: { code: { roots: [added] } } });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.deepEqual(removed.json().settings.code.roots, [added]);

    // The terminal's list is saved exactly as before this change (its checks run where it is used).
    const terminal = await app.inject({ method: "PATCH", url: "/api/settings", payload: { terminal: { roots: [terminalOnly] } } });
    assert.equal(terminal.statusCode, 200, terminal.body);
    assert.deepEqual(terminal.json().settings.terminal.roots, [terminalOnly]);
    assert.deepEqual(terminal.json().settings.code.roots, [added], "saving the terminal list leaves the Code list alone");

    // Settings cannot be rewritten wholesale as a preference, which would skip these checks.
    const raw = await app.inject({ method: "PUT", url: "/api/preferences/hub.settings", payload: { value: { code: { roots: ["/etc"] } } } });
    assert.equal(raw.statusCode, 400, raw.body);
    assert.deepEqual((await loadSettings(prisma, user.id)).code.roots, [added]);
  } finally {
    await app.close();
    await cleanup(user.id);
  }
});

test("the upgrade copies folders saved before the split into both lists, once", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const old = await person("upgrade-old");
  const none = await person("upgrade-none");
  const done = await person("upgrade-done");
  const app = await build(() => old.id);
  const ids = [old.id, none.id, done.id];
  try {
    const stamp = new Date("2026-10-01T10:00:00Z");
    // Settings rows as a build from before the split saved them: no `code` section.
    await prisma.preference.create({ data: { userId: old.id, key: "hub.settings", value: { terminal: { enabled: true, roots: [codeOnly, terminalOnly] } }, updatedAt: stamp } });
    await prisma.preference.create({ data: { userId: none.id, key: "hub.settings", value: { autonomy: "assist" }, updatedAt: stamp } });
    // Already upgraded, and the person removed every Code folder: stays empty.
    await prisma.preference.create({ data: { userId: done.id, key: "hub.settings", value: { terminal: { roots: [terminalOnly] }, code: { roots: [] } }, updatedAt: stamp } });

    const first = await upgradeCodeFolders(prisma);
    assert.ok(first >= 2, `first run upgraded ${first} rows`);
    const rows = async () => prisma.preference.findMany({ where: { userId: { in: ids } }, orderBy: { userId: "asc" } });
    const valueOf = async (userId: string) => (await prisma.preference.findFirstOrThrow({ where: { userId, key: "hub.settings" } })).value as Record<string, any>;
    assert.deepEqual((await valueOf(old.id)).code, { roots: [codeOnly, terminalOnly] });
    assert.deepEqual((await valueOf(old.id)).terminal.roots, [codeOnly, terminalOnly], "the terminal keeps its folders");
    assert.deepEqual((await valueOf(none.id)).code, { roots: [] });
    assert.deepEqual((await valueOf(done.id)).code, { roots: [] }, "an emptied Code list is not refilled");

    // Nothing stops working: both the terminal and Code still see the folders.
    const terminal = await app.inject({ method: "GET", url: "/api/terminal/status" });
    assert.equal((terminal.json().roots as string[]).includes(terminalOnly), true);
    const repos = await app.inject({ method: "GET", url: "/api/code/repos" });
    assert.equal((repos.json().repos as string[]).includes(join(terminalOnly, "term-repo")), true);
    assert.equal((repos.json().repos as string[]).includes(join(codeOnly, "code-repo")), true);

    const before = await rows();
    assert.equal(await upgradeCodeFolders(prisma), 0, "a second run changes nothing");
    assert.deepEqual(await rows(), before);
  } finally {
    await app.close();
    for (const id of ids) await cleanup(id);
  }
});
