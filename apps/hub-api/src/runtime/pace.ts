/** Per-key token bucket. Free-tier Gemini is 15 requests per minute. */

const RPM: Record<string, number> = { google: 15 };
const DEFAULT_RPM = 60;

class Bucket {
  capacity: number;
  tokens: number;
  rate: number;
  updated: number;

  constructor(rpm: number, now: number) {
    this.capacity = rpm;
    this.tokens = rpm;
    this.rate = rpm / 60;
    this.updated = now;
  }

  reserve(now: number): number {
    const elapsed = Math.max(0, now - this.updated);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.updated = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const wait = (1 - this.tokens) / this.rate;
    this.tokens = 0;
    this.updated = now + wait;
    return wait;
  }
}

const buckets = new Map<string, Bucket>();
const tails = new Map<string, Promise<void>>();

type RateRedis = {
  eval(script: string, numkeys: number, key: string, ...args: string[]): Promise<unknown>;
};

const SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local rate = tonumber(ARGV[3])
local raw = redis.call("GET", key)
local tokens = capacity
local updated = now
if raw then
  local ok, parsed = pcall(cjson.decode, raw)
  if ok and type(parsed) == "table" then
    tokens = tonumber(parsed.tokens) or capacity
    updated = tonumber(parsed.updated) or now
  end
end
local elapsed = now - updated
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * rate)
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  updated = now
else
  wait = (1 - tokens) / rate
  tokens = 0
  updated = now + wait
end
redis.call("SET", key, cjson.encode({tokens = tokens, updated = updated}), "EX", 180)
return string.format("%.6f", wait)
`;

let injected: RateRedis | null | undefined;
let auto: RateRedis | null = null;
let autoDownUntil = 0;
let clock: () => number = () => Date.now() / 1000;
let redisInflight = 0;

type PaceSocket = { ref?: () => void; unref?: () => void };

function paceSocket(client: RateRedis): PaceSocket | null {
  const stream = (client as { stream?: PaceSocket | null }).stream;
  return stream ?? null;
}

/** An idle Redis socket must not hold the process open. Node's test runner waits for the event loop, and the hub process already has its own listener. */
function syncPaceSocket(client: RateRedis): void {
  const stream = paceSocket(client);
  if (!stream) return;
  if (redisInflight > 0) stream.ref?.();
  else stream.unref?.();
}

/** Tests pass a Redis-like client, or null to force the in-process bucket. */
export function setPaceRedisForTests(client: RateRedis | null | undefined): void {
  injected = client;
}

export function setPaceClockForTests(next: (() => number) | null): void {
  clock = next ?? (() => Date.now() / 1000);
}

function redisUrl(): string {
  const url = process.env.REDIS_URL?.trim() ?? "";
  if (!url || url.startsWith("memory:")) return "";
  return url;
}

async function redisClient(): Promise<RateRedis | null> {
  if (injected !== undefined) return injected;
  if (Date.now() < autoDownUntil) return null;
  const url = redisUrl();
  if (!url) return null;
  if (!auto) {
    const { Redis } = await import("ioredis");
    const client = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 300, lazyConnect: true, enableOfflineQueue: false });
    client.on("error", () => undefined);
    client.on("connect", () => syncPaceSocket(client));
    client.on("ready", () => syncPaceSocket(client));
    auto = client;
  }
  return auto;
}

function noteRedisDown(): void {
  if (injected === undefined) autoDownUntil = Date.now() + 30_000;
}

async function reserveRedis(client: RateRedis, ident: string, rpm: number, now: number): Promise<number> {
  redisInflight += 1;
  syncPaceSocket(client);
  try {
    const raw = await client.eval(SCRIPT, 1, `ensemble:model-rpm:${ident}`, now.toFixed(6), String(rpm), (rpm / 60).toFixed(8));
    const wait = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(wait)) throw new Error("Redis rate limit returned a non-number.");
    return wait;
  } finally {
    redisInflight -= 1;
    syncPaceSocket(client);
  }
}

export function reserveDelay(userId: string | null | undefined, provider: string, now = clock()): number {
  if (provider === "mock" || provider === "cursor" || provider === "") return 0;
  const rpm = RPM[provider] ?? DEFAULT_RPM;
  const ident = `${userId || "anon"}:${provider}:${rpm}`;
  let bucket = buckets.get(ident);
  if (!bucket) {
    bucket = new Bucket(rpm, now);
    buckets.set(ident, bucket);
  }
  return bucket.reserve(now);
}

function exclusive<T>(key: string, run: () => Promise<T> | T): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const next = prev.then(run, run);
  tails.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export async function takeToken(userId: string | null | undefined, provider: string): Promise<number> {
  if (provider === "mock" || provider === "cursor" || provider === "") return 0;
  const rpm = RPM[provider] ?? DEFAULT_RPM;
  const ident = `${userId || "anon"}:${provider}:${rpm}`;
  const remote = await redisClient();
  if (remote) {
    try {
      return await reserveRedis(remote, ident, rpm, clock());
    } catch {
      noteRedisDown();
    }
  }
  return exclusive(ident, () => reserveDelay(userId, provider));
}

let sleepImpl: (seconds: number) => Promise<void> = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

export function setRuntimeSleepForTests(sleep: ((seconds: number) => Promise<void>) | null): void {
  sleepImpl = sleep ?? ((seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)));
}

export function runtimeSleep(seconds: number): Promise<void> {
  return sleepImpl(seconds);
}

export async function pace(userId: string | null | undefined, provider: string): Promise<number> {
  const delay = await takeToken(userId, provider);
  if (delay > 0) await runtimeSleep(delay);
  return delay;
}

export function resetBuckets(): void {
  buckets.clear();
}
