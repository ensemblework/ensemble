/**
 * Asking a paired computer for one folder's entries or one file's text, for the person looking at a
 * task on the web (docs/25 §4.3, protocol 3). The request goes to the computer's event stream as
 * `files.request`; the computer reads its own folder and posts the answer back; the web request that
 * asked waits up to `ASK_MS`. Requests and answers live in Redis for a minute and are then gone: the
 * server keeps no copy of a file read this way.
 */
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { FileAnswer } from "../remote/contract.js";
import { fileAnswers, publishDeviceFrame, publishFileAnswer } from "./revoke-notify.js";

export const ASK_MS = 15_000;
const TTL_SECONDS = 60;
const POLL_MS = 400;

const requestKey = (id: string) => `ensemble:files:request:${id}`;
const answerKey = (id: string) => `ensemble:files:answer:${id}`;

type Pending = { deviceId: string };

/** Asks the device; resolves with its answer, or null when it did not answer in time. */
export async function askDevice(
  redis: Pick<Redis, "get" | "set" | "del">,
  input: { deviceId: string; hostedJobId: string; kind: "tree" | "file"; path: string },
  timeoutMs = ASK_MS,
): Promise<FileAnswer | null> {
  const id = randomUUID();
  await redis.set(requestKey(id), JSON.stringify({ deviceId: input.deviceId } satisfies Pending), "EX", TTL_SECONDS);
  try {
    const answered = waitForAnswer(redis, id, timeoutMs);
    publishDeviceFrame(input.deviceId, "files.request", { id, jobId: input.hostedJobId, kind: input.kind, path: input.path });
    return await answered;
  } finally {
    await redis.del(requestKey(id)).catch(() => undefined);
    await redis.del(answerKey(id)).catch(() => undefined);
  }
}

async function waitForAnswer(redis: Pick<Redis, "get">, id: string, timeoutMs: number): Promise<FileAnswer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await redis.get(answerKey(id));
    if (raw) {
      try {
        return JSON.parse(raw) as FileAnswer;
      } catch {
        return { error: "The computer's answer could not be read." };
      }
    }
    // Woken by the bus as soon as the answer is stored, or by the poll if the signal was lost.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
      function done() {
        clearTimeout(timer);
        fileAnswers.off(id, done);
        resolve();
      }
      fileAnswers.once(id, done);
    });
  }
  return null;
}

/** Stores a device's answer for the request it was sent. "unknown": not this device's, or nobody waits any more. */
export async function storeAnswer(redis: Pick<Redis, "get" | "set">, deviceId: string, id: string, answer: FileAnswer): Promise<"stored" | "unknown"> {
  const raw = await redis.get(requestKey(id));
  if (!raw) return "unknown";
  let pending: Pending;
  try {
    pending = JSON.parse(raw) as Pending;
  } catch {
    return "unknown";
  }
  if (pending.deviceId !== deviceId) return "unknown";
  await redis.set(answerKey(id), JSON.stringify(answer), "EX", TTL_SECONDS);
  publishFileAnswer(id);
  return "stored";
}
