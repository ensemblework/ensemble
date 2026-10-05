/**
 * Path jail for repository reads. No database: a temp folder is the checkout.
 * Escapes, secret names, symlink hops, and gitignored paths must all fail closed.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { remoteSlug } from "./locate.js";
import { buildOverview, isSecretPath, readBounded, RepoReadError, safeRelative } from "./read.js";

const exec = promisify(execFile);

test("safeRelative rejects escapes on both separators", () => {
  const rejected = [
    "foo/../../etc/passwd",
    "foo\\..\\..\\etc\\passwd",
    "/etc/passwd",
    "C:\\windows\\system32",
    "C:/windows",
    "\\\\server\\share\\secret",
    "..",
    "foo/../x",
    "a\0b",
    "",
    ".",
  ];
  for (const path of rejected) {
    assert.throws(() => safeRelative(path), RepoReadError, path);
  }
  assert.equal(safeRelative("apps/hub-api/src/index.ts"), "apps/hub-api/src/index.ts");
  assert.equal(safeRelative("./apps//hub/./file.ts"), "apps/hub/file.ts");
  assert.equal(safeRelative("apps\\hub-web\\package.json"), "apps/hub-web/package.json");
});

test("secret file names are refused even when the bytes are not read", () => {
  const secrets = [
    ".env",
    ".env.local",
    "apps/api/.env.production",
    "id_rsa",
    "keys/id_ed25519.pub",
    "foo.pem",
    "certs/server.p12",
    "credentials.json",
    "secrets.yaml",
    "service-account.json",
    "service-account-prod.json",
    ".ssh/id_rsa",
    ".aws/credentials",
    ".npmrc",
    ".git-credentials",
  ];
  for (const path of secrets) assert.equal(isSecretPath(path), true, path);
  assert.equal(isSecretPath("apps/hub-api/src/index.ts"), false);
  assert.equal(isSecretPath("README.md"), false);
  assert.equal(isSecretPath("infra/docker-compose.yml"), false);
});

test("remote slugs keep owner/name and drop userinfo", () => {
  assert.equal(remoteSlug("https://x-access-token:ghs_secret@github.com/ensemblework/ensemble.git"), "ensemblework/ensemble");
  assert.equal(remoteSlug("git@github.com:ensemblework/ensemble.git"), "ensemblework/ensemble");
  assert.equal(remoteSlug("https://github.com/ensemblework/ensemble"), "ensemblework/ensemble");
  assert.equal(remoteSlug("not a url"), null);
});

test("reads stay inside the folder and skip secrets, links, ignored paths, and build dirs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-repo-read-"));
  const outside = await mkdtemp(join(tmpdir(), "ensemble-repo-out-"));
  try {
    await exec("git", ["init"], { cwd: root });
    await writeFile(join(root, ".gitignore"), "hidden/\n");
    await writeFile(join(root, "visible.txt"), "hello\nPASSWORD=hunter2\napi_key: sk-live\n");
    await mkdir(join(root, "hidden"));
    await writeFile(join(root, "hidden", "note.txt"), "secret note");
    await writeFile(join(root, ".env"), "TOKEN=abc");
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1\n");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "bundle.js"), "bundled\n");
    await writeFile(join(outside, "passwd"), "root-secret");
    await symlink(join(outside, "passwd"), join(root, "linked.txt"));
    await mkdir(join(root, "apps", "web"), { recursive: true });
    await writeFile(join(root, "apps", "web", "package.json"), JSON.stringify({ name: "web", scripts: { dev: "next" } }));
    await writeFile(join(root, "README.md"), "# Hello\n\n## Parts\n");
    await writeFile(
      join(root, "docker-compose.yml"),
      "services:\n  postgres:\n    environment:\n      POSTGRES_PASSWORD: hunter2\n  redis:\n    image: redis:7\n",
    );

    const visible = await readBounded(root, "visible.txt");
    assert.match(visible.text, /hello/);
    assert.match(visible.text, /PASSWORD=\[redacted\]/);
    assert.match(visible.text, /api_key: \[redacted\]/);
    assert.doesNotMatch(visible.text, /hunter2/);
    assert.doesNotMatch(visible.text, /sk-live/);

    const compose = await readBounded(root, "docker-compose.yml");
    assert.match(compose.text, /postgres/);
    assert.match(compose.text, /POSTGRES_PASSWORD: \[redacted\]/);
    assert.doesNotMatch(compose.text, /hunter2/);

    await assert.rejects(() => readBounded(root, ".env"), (error: unknown) => error instanceof RepoReadError && error.statusCode === 403);
    await assert.rejects(
      () => readBounded(root, "hidden/note.txt"),
      (error: unknown) => error instanceof RepoReadError && /ignored/i.test(error.message),
    );
    await assert.rejects(
      () => readBounded(root, "linked.txt"),
      (error: unknown) => error instanceof RepoReadError && error.statusCode === 403 && !error.message.includes(outside),
    );
    await assert.rejects(() => readBounded(root, "../.env"), RepoReadError);
    await assert.rejects(() => readBounded(root, "visible.txt/../../.env"), RepoReadError);
    await assert.rejects(() => readBounded(root, "apps\\..\\..\\..\\etc\\passwd"), RepoReadError);
    await assert.rejects(() => readBounded(root, "node_modules/pkg/index.js"), RepoReadError);

    const overview = await buildOverview(root);
    assert.ok(overview.apps.includes("web"));
    assert.ok(overview.tree.includes("visible.txt"));
    assert.ok(overview.tree.includes("apps/web/package.json"));
    assert.equal(overview.tree.some((path) => path.includes("hidden") || path === ".env" || path.startsWith("node_modules") || path.startsWith("dist")), false);
    assert.ok(overview.readme.some((item) => item.headings.includes("Hello") && item.headings.includes("Parts")));
    assert.ok(overview.compose.some((item) => item.services.includes("postgres") && item.services.includes("redis")));
    const dumped = JSON.stringify(overview);
    assert.equal(dumped.includes("hunter2"), false);
    assert.equal(dumped.includes("root-secret"), false);
    assert.equal(dumped.includes(outside), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
