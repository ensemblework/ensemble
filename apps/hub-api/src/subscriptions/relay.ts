/**
 * Assistant turns that Ensemble on the web hands to the person's paired computer (docs/25 §4.7):
 * the computer's agent does the thinking on the person's own subscription; the tools run here,
 * where the account's data is. The computer is told on its event stream (`assistant.turn {id}`),
 * reads the turn with its device token, downloads the files attached to the person's message,
 * calls tools, streams the reply text in small batches and says when it is done. Turns live in
 * this process's memory: the hosted API is one process.
 *
 * A call the computer sends again with its own id (its answer was lost) runs once (`relayedCall`). A turn whose
 * runtime is gone (its computer restarted, or its event stream ended and it says nothing more) is cut off at once
 * (`TurnCutOff`, `runtimeConnected`, `runtimeDisconnected`), and whoever ran it resumes it, told what may have run.
 */
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { publishDeviceFrame } from "../devices/revoke-notify.js";
import { redactArgs } from "../lib/redact.js";
import { RuntimeError } from "../lib/runtime-error.js";
import { currentScope, runInScope } from "../sharing/context.js";
import type { AgentTurnResult, AgentTurnSpec } from "./agents.js";
import type { OwnAnswer, OwnAsk, OwnToolEvent, ToolAnswer } from "./bridge.js";

/** The computer's request a relayed tool call came on: whether its answer reached the computer. */
const relayedRequest = new AsyncLocalStorage<{ received: () => boolean }>();

/** Runs a relayed tool call with how to tell, later, whether its answer reached the computer (its request may end first). */
export function inRelayedRequest<T>(received: () => boolean, work: () => Promise<T>): Promise<T> {
  return relayedRequest.run({ received }, work);
}

/**
 * Inside a relayed tool call: whether its answer reached the computer (asked after the call ended); null
 * elsewhere. Ensemble Node's tool journal (node/journal.ts) treats the computer's next identical call after
 * an answer that never arrived as that same call again.
 */
export function answerReceived(): (() => boolean) | null {
  return relayedRequest.getStore()?.received ?? null;
}

/** How long a computer has to pick a turn up before the person is told it did not. */
export const PICKUP_MS = 20_000;
/**
 * A turn the computer stopped talking about for this long has ended: no reply text, status, tool call
 * or own call of the agent's (a computer keeps a long own call alive, remote/assistant.ts). A turn that
 * keeps working has no time limit.
 */
export const QUIET_MS = 10 * 60_000;
/**
 * A node's turn that parked on its owner's answer to one of the agent's own calls: its run is stopped this long
 * after the computer has the answer, so the agent hears it first (an agent told to stop may end its turn itself).
 */
export const PARK_GRACE_MS = 2_000;

/**
 * A runtime's event stream ended and nothing more came from it (no reconnect, no request about the turn) for
 * this long: the turns it took were cut off (its process ended, or its computer lost its connection).
 */
const PRESENCE_MS = 90_000;
const timing = { presenceMs: PRESENCE_MS };

/** Tests shorten the grace before a silent runtime's turns are cut off; null puts the shipped value back. */
export function setRelayTimingForTests(value: { presenceMs?: number } | null): void {
  timing.presenceMs = value?.presenceMs ?? PRESENCE_MS;
}

/** One of the agent's own calls (its shell, files, web) that started on the computer and never said it ended. */
export type OpenOwnCall = { name: string; summary: string; acts: boolean };

/**
 * The computer that ran a relayed turn restarted (another runtime of it connected after the one that took the
 * turn went away), or Ensemble lost touch with it (that runtime's stream ended and it sent nothing more): the
 * turn was cut off where it was. What it was doing may have happened; whoever runs the turn resumes it, told so.
 */
export class TurnCutOff extends RuntimeError {
  /** What happened, in a few words: "<computer> restarted", "Ensemble lost touch with <computer>". */
  readonly what: string;
  constructor(
    readonly computer: { id: string; name: string },
    readonly why: "restarted" | "lost",
    /** The agent's own calls that started and never ended. */
    readonly ownCalls: readonly OpenOwnCall[],
    /** Ensemble's tool calls of the turn still running here when it was cut off (name and short input): their answers never reached the computer. */
    readonly running: readonly string[],
  ) {
    super(`${cutOffWhat(computer.name, why)} while it was answering, so this turn was cut off.`, 503);
    this.name = "TurnCutOff";
    this.what = cutOffWhat(computer.name, why);
  }
}

function cutOffWhat(computer: string, why: TurnCutOff["why"]): string {
  return why === "restarted" ? `${computer} restarted` : `Ensemble lost touch with ${computer}`;
}

/** A call as a short line: its name and its input with secrets out, cut to 200 characters. */
function callLine(name: string, input: unknown): string {
  let shown = "";
  try {
    shown = JSON.stringify(redactArgs(input ?? {})) ?? "";
  } catch {
    shown = "";
  }
  return `${name} ${shown.length > 200 ? `${shown.slice(0, 199)}…` : shown}`.trim();
}

type Live = {
  id: string;
  deviceId: string;
  /** The computer's name, for what the turn says when it is cut off. */
  computer: string;
  spec: AgentTurnSpec;
  call: (name: string, input: unknown) => Promise<ToolAnswer>;
  /** A node's turn: asks its owner about one of the agent's own calls (node/own-tool-asks.ts). */
  ask: ((request: OwnAsk) => Promise<OwnAnswer>) | null;
  /** A node's turn: each of the agent's own calls as it starts and ends, for the chat. */
  onOwnTool: ((event: OwnToolEvent) => void) | null;
  /** A node's turn whose ask was not answered in time: parks it, `PARK_GRACE_MS` from now. */
  park: (() => void) | null;
  /** The bytes of one of `spec.files`, read as the person who asked. */
  read: ((fileId: string) => Promise<Uint8Array | null>) | null;
  onDelta: (text: string) => void;
  /** A line for the chat while the computer waits on something (the ChatGPT app holding a thread). */
  onStatus?: (text: string) => void;
  picked: boolean;
  /** The runtime that read the turn first (its instance id, `INSTANCE_HEADER`); null for an older one that sends none. */
  pickedBy: string | null;
  seq: number;
  heard: number;
  /** When the computer last sent a request about the turn. */
  spoke: number;
  /** Tool calls and asks running now: a long one (a browser task, a sign-in, a card waiting for the owner) is work, not silence. */
  busy: number;
  /** Ensemble's tool calls running now, as short lines. */
  running: Map<number, string>;
  /** Calls the computer sent with its own id (`callId`): one sent again (its answer was lost) gets the first one's answer. */
  byCallId: Map<string, { answer: Promise<ToolAnswer>; received: boolean }>;
  /** The agent's own calls that started and have not ended, from the reply batches. */
  ownOpen: Map<string, OpenOwnCall>;
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

/** The computer sent a request about the turn: it is there, and the turn is not silent. */
export function spoke(turn: Live): void {
  turn.spoke = Date.now();
  heard(turn);
}

/**
 * A runtime of the computer reads the turn. The first to read it takes it; another runtime of the same
 * computer (two with one pairing) is refused, so one turn never runs twice. The one that took it may read
 * it again.
 */
export function pickTurn(turn: Pick<Live, "picked" | "pickedBy">, instance: string | null): boolean {
  if (!turn.picked) {
    turn.picked = true;
    turn.pickedBy = instance;
    return true;
  }
  return instance !== null && turn.pickedBy === instance;
}

/** Whether this runtime may work on the turn: the one that took it, any runtime before one has, and anyone when an older runtime took it. */
export function turnFor(turn: Pick<Live, "picked" | "pickedBy">, instance: string | null): boolean {
  return !turn.picked || turn.pickedBy === null || turn.pickedBy === instance;
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

/** Streamed text in order, with the computer's status line and the agent's own calls when it sent them; a repeated batch (a retried post) is dropped. */
export function streamInto(turn: Live, seq: number, text: string, status?: string, tools?: readonly OwnToolEvent[]): void {
  spoke(turn);
  if (seq <= turn.seq) return;
  turn.seq = seq;
  if (status) turn.onStatus?.(status);
  if (text) turn.onDelta(text);
  for (const event of tools ?? []) {
    if (event.phase === "start") turn.ownOpen.set(event.id, { name: event.name, summary: event.summary, acts: event.acts });
    else turn.ownOpen.delete(event.id);
    turn.onOwnTool?.(event);
  }
}

/** The most calls a turn remembers by their id. */
const CALL_IDS = 500;

/**
 * A tool call the computer sent: run once per `callId` (one sent again with the same id gets the first one's
 * answer, waiting for it while it runs), and without an id run as sent. `delivered` says its answer reached the
 * computer; node/journal.ts treats an identical call after an answer that never did as that call again.
 */
export function relayedCall(turn: Live, callId: string | undefined, name: string, input: unknown): { answer: Promise<ToolAnswer>; delivered: () => void } {
  const known = callId ? turn.byCallId.get(callId) : undefined;
  if (known) return { answer: known.answer, delivered: () => (known.received = true) };
  const entry = { answer: null as unknown as Promise<ToolAnswer>, received: false };
  entry.answer = inRelayedRequest(() => entry.received, () => turn.call(name, input));
  if (callId) {
    turn.byCallId.set(callId, entry);
    if (turn.byCallId.size > CALL_IDS) turn.byCallId.delete(turn.byCallId.keys().next().value!);
  }
  return { answer: entry.answer, delivered: () => (entry.received = true) };
}

export function runOnComputer(input: {
  device: { id: string; name: string };
  spec: AgentTurnSpec;
  call: (name: string, input: unknown) => Promise<ToolAnswer>;
  onDelta: (text: string) => void;
  signal: AbortSignal;
  read?: (fileId: string) => Promise<Uint8Array | null>;
  onStatus?: (text: string) => void;
  ask?: (request: OwnAsk) => Promise<OwnAnswer>;
  onOwnTool?: (event: OwnToolEvent) => void;
  /** Parks the node's turn (its run here is then stopped through `signal`). */
  onPark?: () => void;
  /** Whether the node's turn parked: its stop then keeps the agent's session on the computer. */
  parked?: () => boolean;
}): Promise<AgentTurnResult> {
  const id = randomUUID();
  // Tool calls, asks and file reads arrive on the computer's own requests; they run as the person who asked, in their space.
  const scope = currentScope();
  const call = scope ? (name: string, args: unknown) => runInScope(scope, () => input.call(name, args)) : input.call;
  const reader = input.read;
  const read = reader ? (scope ? (fileId: string) => runInScope(scope, () => reader(fileId)) : reader) : null;
  const asker = input.ask;
  const ask = asker ? (scope ? (request: OwnAsk) => runInScope(scope, () => asker(request)) : asker) : null;
  return new Promise<AgentTurnResult>((resolve, reject) => {
    const timers: NodeJS.Timeout[] = [];
    let calls = 0;
    const turn: Live = {
      id,
      deviceId: input.device.id,
      computer: input.device.name,
      spec: input.spec,
      call: async (name, args) => {
        turn.busy += 1;
        const n = (calls += 1);
        turn.running.set(n, callLine(name, args));
        try {
          return await call(name, args);
        } finally {
          turn.busy -= 1;
          turn.running.delete(n);
          heard(turn);
        }
      },
      ask: ask
        ? async (request) => {
            turn.busy += 1;
            try {
              return await ask(request);
            } finally {
              turn.busy -= 1;
              heard(turn);
            }
          }
        : null,
      onOwnTool: input.onOwnTool ?? null,
      park: input.onPark
        ? () => {
            setTimeout(input.onPark!, PARK_GRACE_MS);
          }
        : null,
      read,
      onDelta: input.onDelta,
      ...(input.onStatus ? { onStatus: input.onStatus } : {}),
      picked: false,
      pickedBy: null,
      seq: 0,
      heard: Date.now(),
      spoke: Date.now(),
      busy: 0,
      running: new Map(),
      byCallId: new Map(),
      ownOpen: new Map(),
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
      publishDeviceFrame(input.device.id, "assistant.stop", { id, ...(input.parked?.() ? { park: true } : {}) });
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
    );
    const watch = setInterval(() => {
      if (quiet(turn)) {
        publishDeviceFrame(input.device.id, "assistant.stop", { id });
        turn.settle({ error: new RuntimeError(`${input.device.name} sent nothing for ${QUIET_MS / 60_000} minutes (no reply text and no tool call), so the turn was stopped. Try again.`, 504) });
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

/** Ends a turn that was cut off: the runtime that had it, should it still run, is told to stop; whoever runs the turn resumes it. */
function cutOff(turn: Live, why: TurnCutOff["why"]): void {
  publishDeviceFrame(turn.deviceId, "assistant.stop", { id: turn.id });
  turn.settle({ error: new TurnCutOff({ id: turn.deviceId, name: turn.computer }, why, [...turn.ownOpen.values()], [...turn.running.values()]) });
}

/** When each runtime's event stream ended, by device and instance, while it has not come back. */
const gone = new Map<string, number>();

/**
 * A runtime of a computer opened its event stream (devices/routes.ts), `streams` saying which runtimes have one
 * open now. A turn another runtime of it took, whose stream is gone, was cut off: that runtime's process ended
 * (the computer or Ensemble on it restarted), so its turn ends at once and is resumed. A turn another runtime
 * took that still has its stream goes on with it. A turn no runtime has read yet is offered to this one.
 */
export function runtimeConnected(deviceId: string, instance: string, streams: (instance: string) => boolean): void {
  gone.delete(`${deviceId}:${instance}`);
  for (const turn of [...live.values()]) {
    if (turn.deviceId !== deviceId || turn.stopped) continue;
    if (!turn.picked) publishDeviceFrame(deviceId, "assistant.turn", { id: turn.id });
    else if (turn.pickedBy && turn.pickedBy !== instance && !streams(turn.pickedBy)) cutOff(turn, "restarted");
  }
}

/**
 * A runtime's event stream ended. While it has none, a turn it took that it says nothing about for the grace
 * (no request, no call of it running here) was cut off (its process ended, or its connection is gone): it ends
 * and is resumed.
 */
export function runtimeDisconnected(deviceId: string, instance: string, streams: (instance: string) => boolean): void {
  const key = `${deviceId}:${instance}`;
  const at = Date.now();
  gone.set(key, at);
  const check = () => {
    if (gone.get(key) !== at || streams(instance)) return;
    let watching = false;
    for (const turn of [...live.values()]) {
      if (turn.deviceId !== deviceId || turn.stopped || turn.pickedBy !== instance) continue;
      if (turn.busy > 0 || Date.now() - turn.spoke < timing.presenceMs) watching = true;
      else cutOff(turn, "lost");
    }
    if (watching) setTimeout(check, timing.presenceMs).unref?.();
    else gone.delete(key);
  };
  setTimeout(check, timing.presenceMs).unref?.();
}
