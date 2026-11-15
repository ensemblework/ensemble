/**
 * Tell every open device stream that its token is no longer valid, and carry other frames to a
 * device's stream and answers back to whoever waits for them.
 *
 * Subscribers live in the process that accepted the socket (`sseHub`). A revoke
 * handled by one hub-api must still reach the others, so the notice goes out on
 * Redis pub/sub. Each process writes `device.revoked` to its own sockets and
 * closes them. The desktop app runs one process against memory Redis, which
 * fans the same channel out in-process. A `files.request` frame for a device,
 * the "answered" signal for a file request, and a runtime's newly opened stream
 * (which ends the older streams of other runtimes with the same pairing) travel
 * the same way, on their own channels.
 */
import { EventEmitter } from "node:events";
import { Redis, type RedisOptions } from "ioredis";
import { env } from "../config.js";
import { logAi } from "../lib/ai-activity.js";
import { redis } from "../lib/redis.js";
import { sseHub } from "../lib/sse.js";
import { RUNTIME_REPLACED_EVENT } from "../remote/contract.js";

export const DEVICE_REVOKED_CHANNEL = "ensemble:device:revoked";
export const DEVICE_FRAME_CHANNEL = "ensemble:device:frame";
export const FILE_ANSWER_CHANNEL = "ensemble:device:file-answer";
export const DEVICE_STREAM_CHANNEL = "ensemble:device:stream";

/** Emits a request id when its answer is stored, in every process that hears the bus. */
export const fileAnswers = new EventEmitter();
fileAnswers.setMaxListeners(0);

const CONNECT_MS = 2_000;

type Notice = { deviceId?: unknown; reason?: unknown };

function usesMemoryRedis(): boolean {
  return process.env.ENSEMBLE_DESKTOP === "1" || env.REDIS_URL.startsWith("memory:");
}

/** A frame for one device's stream: `{deviceId, event, data}`, written by whichever process holds the socket. */
function deliverFrame(message: string): void {
  let frame: { deviceId?: unknown; event?: unknown; data?: unknown };
  try {
    frame = JSON.parse(message) as typeof frame;
  } catch {
    return;
  }
  if (typeof frame.deviceId !== "string" || !frame.deviceId || typeof frame.event !== "string") return;
  sseHub.publish(`device:${frame.deviceId}`, { event: frame.event, data: frame.data ?? {} });
}

/** A runtime opened its stream: `{deviceId, userId, name, instance, openedAt}`. Older streams of other runtimes for that device end. */
function replaceStreams(message: string): void {
  let notice: { deviceId?: unknown; userId?: unknown; name?: unknown; instance?: unknown; openedAt?: unknown };
  try {
    notice = JSON.parse(message) as typeof notice;
  } catch {
    return;
  }
  if (typeof notice.deviceId !== "string" || !notice.deviceId || typeof notice.instance !== "string" || typeof notice.openedAt !== "number") return;
  const closed = sseHub.replace(`device:${notice.deviceId}`, { instance: notice.instance, openedAt: notice.openedAt }, { event: RUNTIME_REPLACED_EVENT, data: {} });
  if (!closed.length || typeof notice.userId !== "string") return;
  const name = typeof notice.name === "string" ? notice.name : "this computer";
  logAi({
    kind: "server.log",
    userId: notice.userId,
    app: "server",
    name: "warn",
    ok: false,
    output: `Another Ensemble runtime on ${name} connected with the same pairing while an earlier one's connection was open. The earlier connection was closed, so only the newer runtime gets this computer's work.`,
    refs: { device: notice.deviceId },
    meta: { kept: notice.instance.slice(0, 8), closed: closed.map((instance) => instance.slice(0, 8)) },
  });
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
    subscriber.on("message", (channel: string, message: string) => {
      if (channel === DEVICE_FRAME_CHANNEL) deliverFrame(message);
      else if (channel === FILE_ANSWER_CHANNEL) fileAnswers.emit(message);
      else if (channel === DEVICE_STREAM_CHANNEL) replaceStreams(message);
      else deliver(message);
    });
    await ensureConnected(publisher);
    await ensureConnected(subscriber);
    await subscriber.subscribe(DEVICE_REVOKED_CHANNEL, DEVICE_FRAME_CHANNEL, FILE_ANSWER_CHANNEL, DEVICE_STREAM_CHANNEL);
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
      await sub.unsubscribe(DEVICE_REVOKED_CHANNEL, DEVICE_FRAME_CHANNEL, FILE_ANSWER_CHANNEL, DEVICE_STREAM_CHANNEL);
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

/** A frame on one device's event stream, from any process. Without the bus, this process's sockets get it. */
export function publishDeviceFrame(deviceId: string, event: string, data: Record<string, unknown>): void {
  const message = JSON.stringify({ deviceId, event, data });
  if (!remote || !publisher) {
    deliverFrame(message);
    return;
  }
  void publisher.publish(DEVICE_FRAME_CHANNEL, message).then(
    (count) => {
      if (!count) deliverFrame(message);
    },
    () => deliverFrame(message),
  );
}

/**
 * A runtime of a computer opened its event stream. The streams other runtimes of that computer opened
 * before it end with `device.replaced`, in every process, and the owner's AI activity log says so.
 */
export function publishRuntimeStream(input: { deviceId: string; userId: string; name: string; instance: string; openedAt: number }): void {
  const message = JSON.stringify(input);
  if (!remote || !publisher) {
    replaceStreams(message);
    return;
  }
  void publisher.publish(DEVICE_STREAM_CHANNEL, message).then(
    (count) => {
      if (!count) replaceStreams(message);
    },
    () => replaceStreams(message),
  );
}

/** Wakes whoever waits for this file request's answer, in any process. Waiters also poll, so a lost signal only slows them. */
export function publishFileAnswer(requestId: string): void {
  if (!remote || !publisher) {
    fileAnswers.emit(requestId);
    return;
  }
  void publisher.publish(FILE_ANSWER_CHANNEL, requestId).then(
    (count) => {
      if (!count) fileAnswers.emit(requestId);
    },
    () => fileAnswers.emit(requestId),
  );
}
