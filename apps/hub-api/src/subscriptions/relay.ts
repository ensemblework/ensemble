/**
 * Assistant turns that Ensemble on the web hands to the person's paired computer (docs/25 §4.7):
 * the computer's agent does the thinking on the person's own subscription; the tools run here,
 * where the account's data is. The computer is told on its event stream (`assistant.turn {id}`),
 * reads the turn with its device token, downloads the files attached to the person's message,
 * calls tools, streams the reply text in small batches and says when it is done. Turns live in
 * this process's memory: the hosted API is one process.
 */
import { randomUUID } from "node:crypto";
import { publishDeviceFrame } from "../devices/revoke-notify.js";
import { RuntimeError } from "../lib/runtime-error.js";
import { currentScope, runInScope } from "../sharing/context.js";
import type { AgentTurnResult, AgentTurnSpec } from "./agents.js";
import type { ToolAnswer } from "./bridge.js";

/** How long a computer has to pick a turn up before the person is told it did not. */
export const PICKUP_MS = 20_000;
/** A turn the computer stopped talking about for this long has ended. */
const QUIET_MS = 5 * 60_000;
const LONGEST_MS = 20 * 60_000;

type Live = {
  id: string;
  deviceId: string;
  spec: AgentTurnSpec;
  call: (name: string, input: unknown) => Promise<ToolAnswer>;
  /** The bytes of one of `spec.files`, read as the person who asked. */
  read: ((fileId: string) => Promise<Uint8Array | null>) | null;
  onDelta: (text: string) => void;
  picked: boolean;
  seq: number;
  heard: number;
  /** Tool calls running now: a long one (a browser task, a sign-in) is work, not silence. */
  busy: number;
  stopped: boolean;
  settle: (outcome: { result: AgentTurnResult } | { error: Error }) => void;
};

const live = new Map<string, Live>();

export function liveTurn(id: string, deviceId: string): Live | null {
  const turn = live.get(id);
  return turn && turn.deviceId === deviceId && !turn.stopped ? turn : null;
}

export function heard(turn: Live): void {
  turn.heard = Date.now();
}

/** The computer stopped talking about the turn: nothing heard for a while, and no tool call of it running here. */
export function quiet(turn: Pick<Live, "picked" | "busy" | "heard">, now = Date.now()): boolean {
  return turn.picked && turn.busy === 0 && now - turn.heard > QUIET_MS;
}

/** The computer's answer, as `done` carries it. */
export function finishTurn(turn: Live, body: { result?: AgentTurnResult; error?: { problem?: string; message?: string } }): void {
  if (body.result) turn.settle({ result: body.result });
  else turn.settle({ error: errorFromComputer(body.error?.problem, body.error?.message) });
}

export function errorFromComputer(problem: string | undefined, message: string | undefined): Error {
  const text = (message ?? "").trim().slice(0, 600) || "The agent on your computer stopped without saying why.";
  if (problem === "limit") return new RuntimeError(text, 429);
  if (problem === "signed_out" || problem === "not_installed") return new RuntimeError(text, 409);
  return new RuntimeError(text, 502);
}

/** Streamed text in order; a repeated batch (a retried post) is dropped. */
export function streamInto(turn: Live, seq: number, text: string): void {
  heard(turn);
  if (seq <= turn.seq) return;
  turn.seq = seq;
  if (text) turn.onDelta(text);
}

export function runOnComputer(input: {
  device: { id: string; name: string };
  spec: AgentTurnSpec;
  call: (name: string, input: unknown) => Promise<ToolAnswer>;
  onDelta: (text: string) => void;
  signal: AbortSignal;
  read?: (fileId: string) => Promise<Uint8Array | null>;
}): Promise<AgentTurnResult> {
  const id = randomUUID();
  // Tool calls and file reads arrive on the computer's own requests; they run as the person who asked, in their space.
  const scope = currentScope();
  const call = scope ? (name: string, args: unknown) => runInScope(scope, () => input.call(name, args)) : input.call;
  const reader = input.read;
  const read = reader ? (scope ? (fileId: string) => runInScope(scope, () => reader(fileId)) : reader) : null;
  return new Promise<AgentTurnResult>((resolve, reject) => {
    const timers: NodeJS.Timeout[] = [];
    const turn: Live = {
      id,
      deviceId: input.device.id,
      spec: input.spec,
      call: async (name, args) => {
        turn.busy += 1;
        try {
          return await call(name, args);
        } finally {
          turn.busy -= 1;
          heard(turn);
        }
      },
      read,
      onDelta: input.onDelta,
      picked: false,
      seq: 0,
      heard: Date.now(),
      busy: 0,
      stopped: false,
      settle: (outcome) => {
        if (!live.has(id)) return;
        live.delete(id);
        turn.stopped = true;
        for (const timer of timers) clearTimeout(timer);
        clearInterval(watch);
        input.signal.removeEventListener("abort", onAbort);
        if ("result" in outcome) resolve(outcome.result);
        else reject(outcome.error);
      },
    };
    const onAbort = () => {
      publishDeviceFrame(input.device.id, "assistant.stop", { id });
      turn.settle({ error: new DOMException("Stopped", "AbortError") });
    };
    live.set(id, turn);
    input.signal.addEventListener("abort", onAbort, { once: true });
    timers.push(
      setTimeout(() => {
        if (!turn.picked) {
          turn.settle({
            error: new RuntimeError(
              `${input.device.name} did not pick this up. Check that it is awake and that Ensemble is open on it (the desktop app, or \`ensemble\` in a terminal), then try again.`,
              503,
            ),
          });
        }
      }, PICKUP_MS),
      setTimeout(() => turn.settle({ error: new RuntimeError(`${input.device.name} took longer than ${LONGEST_MS / 60_000} minutes, so the turn was stopped.`, 504) }), LONGEST_MS),
    );
    const watch = setInterval(() => {
      if (quiet(turn)) {
        publishDeviceFrame(input.device.id, "assistant.stop", { id });
        turn.settle({ error: new RuntimeError(`${input.device.name} stopped answering. Try again.`, 504) });
      }
    }, 10_000);
    watch.unref?.();
    if (input.signal.aborted) {
      onAbort();
      return;
    }
    publishDeviceFrame(input.device.id, "assistant.turn", { id });
  });
}

export function liveTurnCountForTests(): number {
  return live.size;
}

export function stopComputerTurns(deviceId: string): void {
  for (const turn of live.values()) if (turn.deviceId === deviceId) turn.settle({ error: new RuntimeError("This computer was disconnected from Ensemble.", 409) });
}
