import assert from "node:assert/strict";
import test from "node:test";
import { ensureLocalDatabase, localDatabaseTarget, localDbHelp } from "./ensure-local-db.mjs";

const localUrl = "postgresql://ensemble:ensemble@127.0.0.1:5432/ensemble";

test("only the compose database on 127.0.0.1:5432 is started automatically", () => {
  assert.deepEqual(localDatabaseTarget(localUrl), { host: "127.0.0.1", port: 5432 });
  assert.deepEqual(localDatabaseTarget("postgres://ensemble:ensemble@127.0.0.1/ensemble"), { host: "127.0.0.1", port: 5432 });
  assert.equal(localDatabaseTarget("postgresql://ensemble:ensemble@localhost:5432/ensemble"), null);
  assert.equal(localDatabaseTarget("postgresql://ensemble:ensemble@127.0.0.1:5433/ensemble"), null);
  assert.equal(localDatabaseTarget("postgresql://postgres:secret@db.example.com:5432/postgres"), null);
  assert.equal(localDatabaseTarget(""), null);
  assert.equal(localDatabaseTarget("not a url"), null);
});

test("a database that is already accepting connections is left alone", async () => {
  const calls = [];
  const result = await ensureLocalDatabase({
    env: { DATABASE_URL: localUrl },
    probe: async () => true,
    spawn(command, args) {
      calls.push([command, args]);
      return { status: 0 };
    },
  });
  assert.equal(result.action, "ready");
  assert.deepEqual(calls, []);
});

test("a stopped local database is started with the compose volume", async () => {
  const calls = [];
  const logs = [];
  const result = await ensureLocalDatabase({
    env: { DATABASE_URL: localUrl },
    probe: async () => false,
    ready: async () => true,
    log(message) {
      logs.push(message);
    },
    spawn(command, args) {
      calls.push([command, ...args]);
      return { status: 0 };
    },
  });
  assert.equal(result.action, "started");
  assert.deepEqual(calls, [
    ["docker", "volume", "create", "ensemble_pg"],
    ["docker", "compose", "-f", "infra/docker-compose.yml", "up", "-d"],
  ]);
  assert.match(logs.join("\n"), /Starting it with Docker/);
  assert.match(logs.join("\n"), /accepting connections at 127\.0\.0\.1:5432/);
});

test("docker failing to start prints the next command instead of a Prisma stack", async () => {
  const logs = [];
  const result = await ensureLocalDatabase({
    env: { DATABASE_URL: localUrl },
    probe: async () => false,
    log(message) {
      logs.push(message);
    },
    spawn() {
      return { status: 1 };
    },
    timeoutMs: 0,
  });
  assert.equal(result.action, "failed");
  assert.equal(result.status, 1);
  assert.match(logs.join("\n"), /Can't reach database server at `127\.0\.0\.1:5432`/);
  assert.match(logs.join("\n"), /pnpm infra:up/);
  assert.equal(logs.some((line) => line.includes("PrismaClient")), false);
});

test("compose coming up without accepting connections is a failure", async () => {
  const logs = [];
  const result = await ensureLocalDatabase({
    env: { DATABASE_URL: localUrl },
    probe: async () => false,
    ready: async () => false,
    log(message) {
      logs.push(message);
    },
    spawn() {
      return { status: 0 };
    },
    timeoutMs: 0,
    intervalMs: 0,
  });
  assert.equal(result.action, "failed");
  assert.match(logs.at(-1), new RegExp(localDbHelp({ host: "127.0.0.1", port: 5432 }).split("\n")[0]));
});

test("a remote database and CI are not started from Docker", async () => {
  let spawned = false;
  const spawn = () => {
    spawned = true;
    return { status: 0 };
  };
  const remote = await ensureLocalDatabase({
    env: { DATABASE_URL: "postgresql://postgres:secret@db.example.com:5432/postgres" },
    probe: async () => false,
    spawn,
  });
  const ci = await ensureLocalDatabase({
    env: { CI: "true", DATABASE_URL: localUrl },
    probe: async () => false,
    spawn,
  });
  const skipped = await ensureLocalDatabase({
    env: { ENSEMBLE_SKIP_LOCAL_DB: "1", DATABASE_URL: localUrl },
    probe: async () => false,
    spawn,
  });
  assert.equal(remote.action, "skip");
  assert.equal(ci.action, "skip");
  assert.equal(skipped.action, "skip");
  assert.equal(spawned, false);
});
