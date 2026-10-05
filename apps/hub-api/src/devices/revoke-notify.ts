/**
 * Tell every open device stream that its token is no longer valid.
 *
 * Subscribers live in the process that accepted the socket (`sseHub`). A revoke
 * handled by one hub-api must still reach the others, so the notice goes out on
 * Redis pub/sub. Each process writes `device.revoked` to its own sockets and
 * closes them. The desktop app runs one process against memory Redis, which
 * fans the same channel out in-process.
 */
import { Redis, type RedisOptions } from "ioredis";
import { env } from "../config.js";
import { redis } from "../lib/redis.js";
import { sseHub } from "../lib/sse.js";

export const DEVICE_REVOKED_CHANNEL = "ensemble:device:revoked";

const CONNECT_MS = 2_000;

type Notice = { deviceId?: unknown; reason?: unknown };

function usesMemoryRedis(): boolean {
  return process.env.ENSEMBLE_DESKTOP === "1" || env.REDIS_URL.startsWith("memory:");
}

function deliver(message: string): void {
  let notice: Notice;
  try {
    notice = JSON.parse(message) as Notice;
  } catch {
    return;
  }
  if (typeof notice.deviceId !== "string" || notice.deviceId.length === 0 || notice.reason !== "revoked") return;
  const deviceId = notice.deviceId;
  sseHub.end(`device:${deviceId}`, {
    event: "device.revoked",
    data: { deviceId, reason: "revoked" },
  });
}

let publisher: Redis | null = null;
let subscriber: Redis | null = null;
let remote = false;
let starting: Promise<boolean> | null = null;

function clientOptions(): RedisOptions {
  return {
    lazyConnect: true,
    connectTimeout: CONNECT_MS,
    // Subscribing blocks the connection. null lets ioredis resubscribe after a blip.
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    retryStrategy(times) {
      return Math.min(times * 200, 2_000);
    },
  };
}

async function ensureConnected(client: Redis): Promise<void> {
  if (client.status === "ready") return;
  const pending = client.connect();
  pending.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Redis did not connect")), CONNECT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function openBus(): Promise<boolean> {
  try {
    if (usesMemoryRedis()) {
      publisher = redis;
      subscriber = redis.duplicate();
    } else {
      publisher = new Redis(env.REDIS_URL, clientOptions());
      subscriber = new Redis(env.REDIS_URL, clientOptions());
    }
    publisher.on("error", () => {});
    subscriber.on("error", () => {});
    subscriber.on("message", (_channel: string, message: string) => {
      deliver(message);
    });
    await ensureConnected(publisher);
    await ensureConnected(subscriber);
    await subscriber.subscribe(DEVICE_REVOKED_CHANNEL);
    remote = true;
    return true;
  } catch {
    await stopDeviceRevokeBus();
    return false;
  }
}

/** Subscribe this process. Returns false when Redis pub/sub is not up. */
export function startDeviceRevokeBus(): Promise<boolean> {
  if (remote) return Promise.resolve(true);
  if (!starting) {
    starting = openBus().finally(() => {
      starting = null;
    });
  }
  return starting;
}

export async function stopDeviceRevokeBus(): Promise<void> {
  remote = false;
  const sub = subscriber;
  const pub = publisher;
  subscriber = null;
  publisher = null;
  if (sub && sub !== redis) {
    try {
      sub.disconnect(false);
    } catch {
      // The socket is already closed.
    }
  } else if (sub) {
    try {
      await sub.unsubscribe(DEVICE_REVOKED_CHANNEL);
    } catch {
      // The socket is already closed.
    }
  }
  if (pub && pub !== redis) {
    try {
      pub.disconnect(false);
    } catch {
      // The socket is already closed.
    }
  }
}

/**
 * `device.revoked` with `{deviceId, reason: "revoked"}`, then the stream ends.
 * Other hub-api processes hear it on `DEVICE_REVOKED_CHANNEL`. This process
 * hears it the same way when the subscriber is up. If the publish reaches
 * nobody, the sockets in this process are closed directly.
 */
export function publishDeviceRevoked(deviceId: string): void {
  if (!deviceId) return;
  const message = JSON.stringify({ deviceId, reason: "revoked" });
  if (!remote || !publisher) {
    deliver(message);
    return;
  }
  void publisher.publish(DEVICE_REVOKED_CHANNEL, message).then(
    (count) => {
      if (!count) deliver(message);
    },
    () => deliver(message),
  );
}
