import { Redis } from "ioredis";
import { env } from "../config.js";
import { memoryRedis } from "./memory-redis.js";

const embedded = process.env.ENSEMBLE_DESKTOP === "1" || env.REDIS_URL.startsWith("memory:");

export const redis = embedded
  ? (memoryRedis() as unknown as Redis)
  : new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });

redis.on("error", () => {
  // Localhost-first: Redis is optional until pause/cancel is used.
});

// An idle socket must not hold the process open. The hub already has its own listener, and Node's test runner waits until the event loop is empty.
const releaseRedis = () => {
  (redis as { stream?: { unref?: () => void } }).stream?.unref?.();
};
redis.on("connect", releaseRedis);
redis.on("ready", releaseRedis);
