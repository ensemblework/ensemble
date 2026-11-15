/**
 * Asking a paired computer for one folder's entries or one file's text, for the person looking at a
 * task on the web (docs/25 §4.6, protocol 3), and, the same way, for one call to its Code API or its
 * terminal (protocol 4, `devices/code-routes.ts`). The request goes to the computer's event stream as
 * `files.request`; the computer reads its own folder and posts the answer back; the web request that
 * asked waits up to `ASK_MS`. Requests and answers live in Redis for a minute and are then gone: the
 * server keeps no copy of a file read this way. A request that changes something on the computer is
 * claimed by the runtime that acts on it first (`claimRequest`), so two runtimes with one pairing never
 * both act on it.
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
const claimKey = (id: string) => `ensemble:files:claim:${id}`;
/** Longer than any wait for an answer; the claim goes with its request. */
const CLAIM_TTL_SECONDS = 3600;

type Pending = { deviceId: string };

/** Asks the device; resolves with its answer, or null when it did not answer in time. */
export async function askDevice(
  redis: Pick<Redis, "get" | "set" | "del">,
  input: { deviceId: string; hostedJobId: string; kind: "tree" | "file"; path: string },
  timeoutMs = ASK_MS,
): Promise<FileAnswer | null> {
  const answer = await askDeviceFor(redis, { deviceId: input.deviceId, event: "files.request", data: { jobId: input.hostedJobId, kind: input.kind, path: input.path } }, timeoutMs);
  return answer as FileAnswer | null;
}

/**
 * Sends one request frame to a device's event stream and waits for the answer it posts back
 * (`files.request`, `code.request`, `terminal.request`). The frame carries `id` plus `data`.
 */
export async function askDeviceFor(
  redis: Pick<Redis, "get" | "set" | "del">,
  input: { deviceId: string; event: string; data: Record<string, unknown>; id?: string },
  timeoutMs = ASK_MS,
): Promise<unknown | null> {
  const id = input.id ?? randomUUID();
  await redis.set(requestKey(id), JSON.stringify({ deviceId: input.deviceId } satisfies Pending), "EX", Math.max(TTL_SECONDS, Math.ceil(timeoutMs / 1000) + 5));
  try {
    const answered = waitForAnswer(redis, id, timeoutMs);
    publishDeviceFrame(input.deviceId, input.event, { ...input.data, id });
    return await answered;
  } finally {
    await redis.del(requestKey(id)).catch(() => undefined);
    await redis.del(answerKey(id)).catch(() => undefined);
    await redis.del(claimKey(id)).catch(() => undefined);
  }
}

async function waitForAnswer(redis: Pick<Redis, "get">, id: string, timeoutMs: number): Promise<unknown | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await redis.get(answerKey(id));
    if (raw) {
      try {
        return JSON.parse(raw) as unknown;
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

/** Whether someone waits for this request's answer from this device. */
async function waitedFor(redis: Pick<Redis, "get">, deviceId: string, id: string): Promise<boolean> {
  const raw = await redis.get(requestKey(id));
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as Pending).deviceId === deviceId;
  } catch {
    return false;
  }
}

/**
 * A runtime of the device takes a request before it acts on it: the first to ask gets it and the same
 * runtime keeps it; any other runtime of that device is refused ("taken"). "unknown": not this device's,
 * or nobody waits any more.
 */
export async function claimRequest(redis: Pick<Redis, "get" | "set">, deviceId: string, id: string, instance: string): Promise<"claimed" | "taken" | "unknown"> {
  if (!(await waitedFor(redis, deviceId, id))) return "unknown";
  if ((await redis.set(claimKey(id), instance, "EX", CLAIM_TTL_SECONDS, "NX")) === "OK") return "claimed";
  return (await redis.get(claimKey(id))) === instance ? "claimed" : "taken";
}

/**
 * Stores a device's answer for the request it was sent. "unknown": not this device's, or nobody waits any
 * more. "taken": another runtime of the device claimed the request and answers it.
 */
export async function storeAnswer(redis: Pick<Redis, "get" | "set">, deviceId: string, id: string, answer: unknown, instance: string | null = null): Promise<"stored" | "unknown" | "taken"> {
  if (!(await waitedFor(redis, deviceId, id))) return "unknown";
  const claimed = await redis.get(claimKey(id));
  if (claimed && claimed !== instance) return "taken";
  await redis.set(answerKey(id), JSON.stringify(answer), "EX", TTL_SECONDS);
  publishFileAnswer(id);
  return "stored";
}
