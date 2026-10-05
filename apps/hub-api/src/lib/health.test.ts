import assert from "node:assert/strict";
import test from "node:test";
import { deployedCommit, healthTimeoutMs, probeAgent, probeRedis, readDeepHealth, schedulerCheck, schedulerStaleMs } from "./health.js";
import type { SchedulerSnapshot } from "../jobs/scheduler-clock.js";
import { memoryRedis } from "./memory-redis.js";

const fresh: SchedulerSnapshot = { enabled: true, lastTickAt: 1_000, startedAt: 0 };

test("a deep check is ok only when every probe is ok", async () => {
  const body = await readDeepHealth({
    postgres: async () => 1,
    redis: async () => "PONG",
    agent: async () => undefined,
    scheduler: fresh,
    now: 2_000,
    timeoutMs: 50,
    staleMs: 10_000,
  });
  assert.equal(body.ok, true);
  assert.equal(body.service, "hub-api");
  assert.equal(body.checks.postgres.ok, true);
  assert.equal(body.checks.scheduler.status, "ok");
  assert.equal(body.checks.scheduler.lastTickAt, new Date(1_000).toISOString());
});

test("a failing probe is a fixed word and drops the driver message", async () => {
  const secret = "postgresql://ensemble:super-secret@db.internal:5432/ensemble";
  const body = await readDeepHealth({
    postgres: async () => {
      throw new Error(secret);
    },
    redis: async () => "PONG",
    agent: async () => undefined,
    scheduler: { enabled: false, lastTickAt: null, startedAt: 0 },
    now: 5_000,
    timeoutMs: 50,
  });
  assert.equal(body.ok, false);
  assert.deepEqual(body.checks.postgres, { ok: false, error: "unreachable" });
  assert.equal(body.checks.redis.ok, true);
  assert.equal(body.checks.scheduler.status, "off");
  assert.equal(JSON.stringify(body).includes("super-secret"), false);
  assert.equal(JSON.stringify(body).includes("db.internal"), false);
});

test("a probe that does not finish is a timeout", async () => {
  const started = Date.now();
  const body = await readDeepHealth({
    postgres: () => new Promise(() => undefined),
    redis: async () => "PONG",
    agent: async () => undefined,
    scheduler: fresh,
    now: fresh.lastTickAt! + 1,
    timeoutMs: 30,
    staleMs: 10_000,
  });
  assert.deepEqual(body.checks.postgres, { ok: false, error: "timeout" });
  assert.equal(body.ok, false);
  assert.ok(Date.now() - started < 500);
});

test("scheduler freshness allows a startup window and then goes stale", () => {
  const off = schedulerCheck({ enabled: false, lastTickAt: null, startedAt: 0 }, 10_000, 1_000);
  assert.equal(off.ok, true);
  assert.equal(off.status, "off");

  const starting = schedulerCheck({ enabled: true, lastTickAt: null, startedAt: 9_500 }, 10_000, 1_000);
  assert.equal(starting.ok, true);
  assert.equal(starting.status, "starting");

  const staleStart = schedulerCheck({ enabled: true, lastTickAt: null, startedAt: 0 }, 10_000, 1_000);
  assert.equal(staleStart.ok, false);
  assert.equal(staleStart.error, "stale");

  const staleTick = schedulerCheck({ enabled: true, lastTickAt: 1_000, startedAt: 0 }, 10_000, 1_000);
  assert.equal(staleTick.ok, false);
  assert.equal(staleTick.lastTickAt, new Date(1_000).toISOString());
});

test("health timeouts come from the environment", () => {
  assert.equal(healthTimeoutMs({}), 800);
  assert.equal(healthTimeoutMs({ ENSEMBLE_HEALTH_TIMEOUT_MS: "250" }), 250);
  assert.equal(healthTimeoutMs({ ENSEMBLE_HEALTH_TIMEOUT_MS: "0" }), 800);
  assert.equal(schedulerStaleMs({}), 180_000);
  assert.equal(schedulerStaleMs({ ENSEMBLE_HEALTH_SCHEDULER_STALE_SEC: "90" }), 90_000);
});

test("a lazy Redis client connects before the first ping", async () => {
  const order: string[] = [];
  let status = "wait";
  await probeRedis({
    get status() {
      return status;
    },
    async connect() {
      order.push("connect");
      status = "ready";
    },
    async ping() {
      order.push("ping");
      if (status !== "ready") throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      return "PONG";
    },
  });
  assert.deepEqual(order, ["connect", "ping"]);
});

test("a Redis connect already in flight is waited out, not pinged", async () => {
  let ready: (() => void) | undefined;
  const order: string[] = [];
  const pending = probeRedis({
    status: "connecting",
    async connect() {
      order.push("connect");
    },
    once(event, listener) {
      if (event === "ready") ready = listener;
    },
    off() {},
    async ping() {
      order.push("ping");
      return "PONG";
    },
  });
  assert.deepEqual(order, []);
  ready?.();
  await pending;
  assert.deepEqual(order, ["ping"]);
});

test("the desktop memory Redis answers the readiness probe", async () => {
  await probeRedis(memoryRedis());
});

test("an in-memory Redis stand-in is only pinged", async () => {
  let pings = 0;
  await probeRedis({
    async ping() {
      pings += 1;
      return "PONG";
    },
  });
  assert.equal(pings, 1);
});

test("the agent probe accepts only its own health body", async () => {
  const ok = async () => new Response(JSON.stringify({ ok: true, service: "agent-runtime", token: "should-not-matter" }), { status: 200 });
  await probeAgent("http://127.0.0.1:5055", 50, ok as typeof fetch);
  const wrong = async () => new Response(JSON.stringify({ ok: true, service: "other", secret: "sk-live" }), { status: 200 });
  await assert.rejects(() => probeAgent("http://agent.internal", 50, wrong as typeof fetch));
  const down = async () => {
    throw new Error("connect ECONNREFUSED http://agent.internal token=sekrit");
  };
  await assert.rejects(() => probeAgent("http://agent.internal", 50, down as typeof fetch), (error: unknown) => {
    assert.equal(error instanceof Error && error.message.includes("sekrit"), false);
    return true;
  });
});

test("the deployed commit is a git hash or nothing", () => {
  assert.equal(deployedCommit({ ENSEMBLE_COMMIT: "0123456789abcdef0123456789abcdef01234567" }), "0123456789abcdef0123456789abcdef01234567");
  assert.equal(deployedCommit({ ENSEMBLE_COMMIT: " abc1234\n" }), "abc1234");
  assert.equal(deployedCommit({}), undefined);
  assert.equal(deployedCommit({ ENSEMBLE_COMMIT: "main; rm -rf /" }), undefined);
  assert.equal(deployedCommit({ ENSEMBLE_COMMIT: "ABC1234" }), undefined);
});
