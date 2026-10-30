/**
 * A node runs one command as the administrator (`sudo`) on its owner's computer (nodeTools 2), only
 * after the owner approves its exact text on a card in the chat (`data.type: "sudo"`, owner only). The
 * owner types their password into the card; their browser seals it for that computer's key (B12's
 * sealed box, purpose "sudo", bound to the card and to the command's sha256), and this server relays
 * the box to the computer once, from memory: it is never in a message, the database, a log, the ledger
 * or a model's input, and only that computer opens it, for that command. The hard floor
 * (device-tools/dangerous.ts) refuses catastrophic commands before any card, and again on the computer.
 *
 * The node's tool call waits in its turn for the answer and returns the command's output. When the
 * owner answers after the turn parked, the answer is relayed from the route and the node is woken with
 * how it went. A card nobody answers expires after 30 minutes.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Device, NodeAgent, NodeMessage, Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SEAL_MAX_TTL_MS, SEAL_TTL_MS, type SealKeyInfo, type Sealed } from "@ensemble/shared-types";
import { toolOk, ToolBlockedError, type ToolResult } from "../assistant/types.js";
import { pinnedSealKey, reportedSealKey } from "../credentials/device-key.js";
import { readAad, SealedShape, SealError } from "../credentials/seal.js";
import { deviceOnline } from "../devices/constants.js";
import { askDeviceFor } from "../devices/file-relay.js";
import { openToolRun } from "../devices/tool-runs.js";
import { appendLedger } from "../lib/ledger.js";
import { MemoryRateLimiter } from "../lib/rate-limit.js";
import { truncateText } from "../lib/text.js";
import { CodeAnswer, NODE_TOOL_FOREGROUND_MS, NODE_TOOLS_OWN_FOLDER, SUDO_PASSWORD_REFUSED } from "../remote/contract.js";
import { ownerName, permissionWaitMs, waitForOwner } from "./device-tool-decisions.js";
import { planLinkOf } from "./plans.js";
import { enqueueTurn, inBackground, requestPark } from "./queue.js";
import { postMessage, updateMessageDataIf, wireMessage } from "./store.js";
import type { NodeScope } from "./tools.js";

export const SUDO_CARD = "sudo";
/** A card nobody answers closes after this. */
export const SUDO_TTL_MS = 30 * 60_000;
/** A command's answer comes within its foreground minute, plus the way there and back. */
const RUN_ASK_MS = NODE_TOOL_FOREGROUND_MS + 25_000;
/** While a call waits, its card is read again this often (an answer taken by another process). */
const RECHECK_MS = 3_000;
/** A card left "running" this long with no answer from its computer (a restart) is closed. */
const RUNNING_STALE_MS = RUN_ASK_MS + 60_000;
/** Passwords sudo may refuse for one card before it closes: more wrong tries can lock the account (faillock). */
export const SUDO_PASSWORD_TRIES = 3;

export class SudoError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 429,
    readonly code?: string,
  ) {
    super(message);
  }
}

const SudoCard = z
  .object({
    type: z.literal(SUDO_CARD),
    status: z.string(),
    command: z.string(),
    commandHash: z.string(),
    reason: z.string().nullish(),
    deviceId: z.string(),
    deviceName: z.string().nullish(),
    folder: z.string().nullish(),
    exitCode: z.number().nullish(),
    error: z.string().nullish(),
    answeredAt: z.string().nullish(),
    private: z.boolean().optional(),
    expiresAt: z.string(),
    mission: z.string(),
    timeoutSec: z.number(),
    runId: z.string().nullish(),
    /** Passwords sudo did not take so far. */
    tries: z.number().optional(),
  })
  .passthrough();
type SudoCardData = z.infer<typeof SudoCard>;

/** What the owner's browser sends: run (with the password sealed for the computer, or without one: `sudo -n`), or deny. */
export const SudoAnswer = z.union([z.object({ action: z.literal("run"), sealed: SealedShape.optional() }).strict(), z.object({ action: z.literal("deny") }).strict()]);
export type SudoAnswer = z.infer<typeof SudoAnswer>;

/** The sha256 (hex) of a command: the sealed password is bound to it. */
export const commandHashOf = (command: string): string => createHash("sha256").update(command, "utf8").digest("hex");

const pending: Prisma.NodeMessageWhereInput = { data: { path: ["status"], equals: "pending" } };
const runningWhere: Prisma.NodeMessageWhereInput = { data: { path: ["status"], equals: "running" } };

type Handoff = { action: "run"; sealed?: Sealed } | { action: "deny" };
/** Tool calls waiting in their turn for a card's answer, in this process: the answer is handed to them. */
const waiters = new Map<string, (handoff: Handoff) => void>();
const expiries = new Map<string, ReturnType<typeof setTimeout>>();

type SudoAsk = {
  scope: Pick<NodeScope, "prisma" | "node" | "room" | "lineage" | "privateTo" | "turnId" | "plan">;
  device: Device;
  command: string;
  reason: string;
  folder: string | null;
  timeoutSec: number;
  /** What a "This mission" answer covers (the computer reads it as the call's mission). */
  mission: string;
};

/** The node's card for this command on this computer: the one still waiting for the same command, or a new one. */
async function sudoCard(app: Pick<FastifyInstance, "prisma">, ask: SudoAsk): Promise<NodeMessage> {
  const { scope, device } = ask;
  const commandHash = commandHashOf(ask.command);
  const open = await app.prisma.nodeMessage.findFirst({
    where: { roomId: scope.room.id, kind: "approval", authorNodeId: scope.node.id, AND: [{ data: { path: ["type"], equals: SUDO_CARD } }, { data: { path: ["commandHash"], equals: commandHash } }, { data: { path: ["deviceId"], equals: device.id } }, pending] },
    orderBy: { createdAt: "desc" },
  });
  if (open && Date.parse(String((open.data as { expiresAt?: unknown }).expiresAt)) > Date.now()) return open;
  const { message } = await postMessage(app.prisma, {
    roomId: scope.room.id,
    userId: scope.node.userId,
    authorKind: "node",
    authorNodeId: scope.node.id,
    kind: "approval",
    body: `@${scope.node.slug} wants to run as administrator on ${device.name}: ${truncateText(ask.command, 600)}`,
    data: {
      type: SUDO_CARD,
      status: "pending",
      command: ask.command,
      commandHash,
      reason: ask.reason.trim().slice(0, 300),
      deviceId: device.id,
      deviceName: device.name,
      folder: ask.folder,
      exitCode: null,
      error: null,
      answeredAt: null,
      private: Boolean(scope.privateTo),
      expiresAt: new Date(Date.now() + SUDO_TTL_MS).toISOString(),
      mission: ask.mission,
      timeoutSec: ask.timeoutSec,
      // The step waits for this answer.
      ...(scope.plan?.planStep ? { plan: { id: scope.plan.planId, step: scope.plan.planStep } } : {}),
    },
    visibleTo: [scope.node.userId],
    rootMessageId: scope.lineage.rootMessageId,
    botDepth: scope.lineage.botDepth,
  });
  await appendLedger({ userId: scope.node.userId, actor: "agent", action: "node.sudo.asked", payload: { nodeId: scope.node.id, deviceId: device.id, program: ask.command.trim().split(/\s+/)[0]?.slice(0, 60) ?? "" } });
  return message;
}

/** The node's call: a card for the owner, then the command's output (or why not), or the turn parks until they answer. */
export async function askSudo(app: FastifyInstance, ask: SudoAsk): Promise<ToolResult> {
  const { scope, device } = ask;
  const card = await sudoCard(app, ask);
  const where = `on ${device.name}`;
  const waiting = { turnId: scope.turnId, ownerId: scope.node.userId, nodeId: scope.node.id, roomId: scope.room.id, private: Boolean(scope.privateTo), threadRootId: scope.lineage.rootMessageId };
  // A password sudo refused puts the card back for another try: the call waits again, a few times.
  for (let attempt = 0; attempt <= SUDO_PASSWORD_TRIES; attempt += 1) {
    const handoff = await waitForOwner(waiting, card.id, (signal) => handedOver(app, card.id, signal, permissionWaitMs()));
    if (handoff?.action === "deny") return toolOk(`Your owner chose not to run \`${ask.command}\` as administrator ${where}. Continue without it, or say what cannot be done without it.`, { ran: false });
    if (handoff?.action !== "run") break;
    const current = await app.prisma.nodeMessage.findUnique({ where: { id: card.id } });
    const outcome = current ? await relaySudo(app, current, handoff.sealed) : ({ kind: "failed", error: "The card is gone." } as const);
    if (outcome.kind === "retry") continue;
    if (outcome.kind === "failed") throw new ToolBlockedError(`It did not run: ${outcome.error}`);
    if (outcome.kind === "background") return toolOk(`\`${ask.command}\` is running as administrator in the background ${where}. You are woken when it ends; do not wait for it.`, { computer: device.name, run: outcome.runId, output: outcome.output });
    return toolOk(`Ran as administrator ${where}: exit code ${outcome.exitCode ?? "unknown"}${outcome.timedOut ? " (stopped at its time limit)" : ""}.`, {
      computer: device.name,
      exitCode: outcome.exitCode,
      output: outcome.output,
      ...(outcome.clipped ? { run: outcome.runId, note: "The output was long: the middle is left out. Read all of it with computer_run_output." } : {}),
    });
  }
  // No answer here: the card may have been answered in another process, or not at all yet.
  const now = await app.prisma.nodeMessage.findUnique({ where: { id: card.id } });
  const status = (now?.data as { status?: unknown } | null)?.status;
  if (status === "denied") return toolOk(`Your owner chose not to run \`${ask.command}\` as administrator ${where}. Continue without it, or say what cannot be done without it.`, { ran: false });
  if (status === "expired") return toolOk(`Your owner did not answer the card about \`${ask.command}\` in time, and it closed. It did not run.`, { ran: false });
  if (status === "failed") throw new ToolBlockedError(`It did not run: ${String((now?.data as { error?: unknown } | null)?.error ?? "it failed")}`);
  const owner = await ownerName(app.prisma, scope.node.userId);
  const waits = status === "pending" ? `Waiting for ${owner} to answer the card about running \`${truncateText(ask.command, 200)}\` as administrator ${where}.` : `${owner} answered the card about running \`${truncateText(ask.command, 200)}\` as administrator ${where}; you hear how it went.`;
  if (status === "pending") scheduleExpiry(app, card);
  requestPark(scope.turnId, waits);
  return toolOk(`${waits} End your turn now without a reply: you continue when they answer.`, { waitingForOwner: true, card: card.id });
}

/** Waits for the owner's answer handed over in this process; null when the wait ends first or the card left pending elsewhere. */
function handedOver(app: Pick<FastifyInstance, "prisma">, cardId: string, signal: AbortSignal, ms: number): Promise<Handoff | null> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value: Handoff | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(poll);
      signal.removeEventListener("abort", stop);
      if (waiters.get(cardId) === hand) waiters.delete(cardId);
      resolve(value);
    };
    const hand = (handoff: Handoff) => finish(handoff);
    const stop = () => finish(null);
    waiters.set(cardId, hand);
    const timer = setTimeout(stop, ms);
    const poll = setInterval(() => {
      void app.prisma.nodeMessage
        .findUnique({ where: { id: cardId }, select: { data: true } })
        .then((row) => {
          if ((row?.data as { status?: unknown } | null)?.status !== "pending") finish(null);
        })
        .catch(() => undefined);
    }, RECHECK_MS);
    poll.unref?.();
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

/** retry: sudo did not take the password; the card waits for another (`SUDO_PASSWORD_TRIES`). */
type Outcome = { kind: "done"; exitCode: number | null; output: string; timedOut: boolean; clipped: boolean; runId: string } | { kind: "background"; runId: string; output: string } | { kind: "failed"; error: string } | { kind: "retry" };

/** The card's patch for how its command ended. */
async function finishCard(app: Pick<FastifyInstance, "prisma">, cardId: string, patch: Record<string, unknown>): Promise<NodeMessage | null> {
  const card = await app.prisma.nodeMessage.findUnique({ where: { id: cardId } });
  if (!card) return null;
  return updateMessageDataIf(app.prisma, card, runningWhere, patch);
}

/**
 * Sends the approved command to its computer, with the sealed password when the owner gave one (from
 * memory, once), and records how it ended on the card. The card is "running" when this is called.
 */
async function relaySudo(app: FastifyInstance, card: NodeMessage, sealed?: Sealed): Promise<Outcome> {
  const data = SudoCard.parse(card.data);
  const fail = async (error: string): Promise<Outcome> => {
    await finishCard(app, card.id, { status: "failed", error });
    return { kind: "failed", error };
  };
  const [device, node] = await Promise.all([
    app.prisma.device.findFirst({ where: { id: data.deviceId, userId: card.userId, revokedAt: null } }),
    card.authorNodeId ? app.prisma.nodeAgent.findUnique({ where: { id: card.authorNodeId } }) : null,
  ]);
  if (!node) return fail("Its node is gone.");
  if (!device) return fail(`${data.deviceName ?? "That computer"} is no longer paired.`);
  if (!deviceOnline(device.lastSeenAt)) return fail(`${device.name} is offline.`);
  const runId = randomUUID();
  const operationId = `${card.id}:sudo:${randomUUID()}`;
  const link = planLinkOf(card.data);
  const redis = app.redis as unknown as Parameters<typeof openToolRun>[0] & Parameters<typeof askDeviceFor>[0];
  // Its output has somewhere to go before the computer starts it; its end updates the card.
  await openToolRun(redis, runId, {
    deviceId: device.id,
    deviceName: device.name,
    ownerId: card.userId,
    nodeId: node.id,
    roomId: card.roomId,
    private: data.private === true,
    planId: link?.planId ?? null,
    planStep: link?.planStep ?? null,
    command: `sudo ${data.command}`.slice(0, 200),
    folder: data.folder ?? "your own folder",
    startedAt: new Date().toISOString(),
    cardId: card.id,
  });
  const request = {
    tool: "sudo",
    nodeId: node.id,
    nodeSlug: node.slug,
    mission: data.mission,
    attended: true,
    grants: [],
    operationId,
    ...(data.folder ? { folder: data.folder } : {}),
    command: data.command,
    commandHash: data.commandHash,
    cardId: card.id,
    ...(sealed ? { sealed } : {}),
    timeoutSec: data.timeoutSec,
    runId,
  };
  const raw = await askDeviceFor(redis, { deviceId: device.id, event: "node.tool.request", data: request }, RUN_ASK_MS).catch(() => null);
  if (!raw) return fail(`${device.name} did not answer. It may be asleep or busy.`);
  const answer = CodeAnswer.safeParse(raw);
  if (!answer.success) return fail(`${device.name} sent an answer that could not be read. Update Ensemble there.`);
  const body = (answer.data.body && typeof answer.data.body === "object" ? answer.data.body : {}) as Record<string, unknown>;
  await appendLedger({ userId: card.userId, actor: "agent", action: "node.device_tool.sudo", payload: { nodeId: node.id, deviceId: device.id, program: data.command.trim().split(/\s+/)[0]?.slice(0, 60) ?? "", status: answer.data.status, operationId } });
  if (answer.data.status >= 400) return fail(typeof body.error === "string" ? body.error.slice(0, 500) : `${device.name} refused it (${answer.data.status}).`);
  const output = typeof body.output === "string" ? body.output : "";
  if (body.error === SUDO_PASSWORD_REFUSED) {
    // Wrong password: the card waits for another, unless that was the last try.
    const tries = (data.tries ?? 0) + 1;
    if (tries >= SUDO_PASSWORD_TRIES) return fail(`The password was not accepted ${SUDO_PASSWORD_TRIES} times, so it did not run.`);
    await finishCard(app, card.id, { status: "pending", tries, answeredAt: null, exitCode: null, error: "The password was not accepted. Type it again." });
    return { kind: "retry" };
  }
  if (answer.data.status === 202) {
    await finishCard(app, card.id, { runId });
    return { kind: "background", runId, output };
  }
  const exitCode = typeof body.exitCode === "number" ? body.exitCode : null;
  await finishCard(app, card.id, { status: exitCode === 0 ? "done" : "failed", exitCode, error: exitCode === 0 ? null : body.timedOut ? "It was stopped at its time limit." : `It ended with exit code ${exitCode ?? "unknown"}.`, runId });
  return { kind: "done", exitCode, output, timedOut: body.timedOut === true, clipped: body.clipped === true, runId };
}

/** The node hears how an answer it was not waiting for went (the turn had parked). */
async function wake(app: FastifyInstance, card: NodeMessage, note: string): Promise<void> {
  if (!card.authorNodeId) return;
  const data = card.data as SudoCardData;
  await enqueueTurn(app, { nodeId: card.authorNodeId, roomId: card.roomId, reason: "approval", note, private: data.private === true, ...(planLinkOf(card.data) ?? {}) });
}

/** The answer of a parked turn's card: relayed from here, then the node is woken with how it went. */
async function relayAndWake(app: FastifyInstance, card: NodeMessage, sealed?: Sealed): Promise<void> {
  const data = SudoCard.parse(card.data);
  const where = `on ${data.deviceName ?? "the computer"}`;
  const outcome = await relaySudo(app, card, sealed);
  // A command that runs on wakes its node when it ends (devices/tool-runs.ts); a refused password waits for another.
  if (outcome.kind === "background" || outcome.kind === "retry") return;
  if (outcome.kind === "failed") return wake(app, card, `Your owner approved running \`${data.command}\` as administrator ${where}, but it did not run: ${outcome.error}`);
  const tail = outcome.output.length > 3000 ? `…${outcome.output.slice(-3000)}` : outcome.output;
  await wake(
    app,
    card,
    [
      `Your owner approved running \`${data.command}\` as administrator ${where}. It ended with exit code ${outcome.exitCode ?? "unknown"}${outcome.timedOut ? " (stopped at its time limit)" : ""}.`,
      tail.trim() ? `Its output ends:\n${tail.trim()}` : "It printed nothing.",
      outcome.clipped ? `The whole output: computer_run_output with run ${outcome.runId}.` : "",
      "Carry on with the work that needed it.",
    ].filter(Boolean).join("\n"),
  );
}

/** The card, if this account may answer it: its owner, still in the room. */
async function ownSudoCard(app: FastifyInstance, accountId: string, messageId: string): Promise<{ card: NodeMessage; node: NodeAgent; data: SudoCardData }> {
  const card = await app.prisma.nodeMessage.findUnique({ where: { id: messageId } });
  const parsed = card ? SudoCard.safeParse(card.data) : null;
  if (!card || !parsed?.success || card.kind !== "approval" || card.userId !== accountId || !card.authorNodeId) throw new SudoError("That request is not available.", 404);
  const [node, member] = await Promise.all([
    app.prisma.nodeAgent.findUnique({ where: { id: card.authorNodeId } }),
    app.prisma.nodeRoomMember.findFirst({ where: { roomId: card.roomId, userId: accountId, nodeId: null }, select: { id: true } }),
  ]);
  if (!node || node.userId !== accountId || !member) throw new SudoError("That request is not available.", 404);
  return { card, node, data: parsed.data };
}

export type SudoRoute = { mode: "sealed"; sealKey: SealKeyInfo } | { mode: "unavailable"; reason: string };

/** How a password reaches the computer: sealed for its pinned key, or not at all (the owner may still run it without one). */
export function sudoRouteFor(device: Pick<Device, "name" | "sealKey" | "capabilities">): SudoRoute {
  const pinned = pinnedSealKey(device);
  const reported = reportedSealKey(device.capabilities);
  const caps = (device.capabilities ?? {}) as { nodeTools?: unknown };
  if (typeof caps.nodeTools !== "number" || caps.nodeTools < NODE_TOOLS_OWN_FOLDER) return { mode: "unavailable", reason: `Ensemble on ${device.name} is too old to run commands as administrator. Update it there (\`ensemble update\`, or the desktop app's update).` };
  if (pinned && reported && reported.kid !== pinned.kid) return { mode: "unavailable", reason: `${device.name} now reports a different key from the one it was paired with, so no password is sent to it. Pair it again (\`ensemble login\`, or the desktop app), then answer.` };
  if (!pinned) return { mode: "unavailable", reason: `${device.name} has no key to encrypt a password for. Update Ensemble there, or run it without a password.` };
  return { mode: "sealed", sealKey: { kid: pinned.kid, alg: pinned.alg, spki: pinned.spki, fingerprint: pinned.fingerprint } };
}

/** A card past its time closes now (a compare-and-set), and its node hears it. */
async function expireIfDue(app: FastifyInstance, card: NodeMessage, data: SudoCardData): Promise<boolean> {
  if (data.status !== "pending" || Date.parse(data.expiresAt) > Date.now()) return false;
  await expireSudo(app, card.id);
  return true;
}

/** The card's command and computer, and how a password would reach it (`GET /api/node/sudo/:messageId`). */
export async function sudoTarget(app: FastifyInstance, accountId: string, messageId: string): Promise<{ id: string; status: string; command: string; commandHash: string; deviceId: string; deviceName: string; online: boolean; route: SudoRoute; ttlMs: number; expiresAt: string }> {
  const { card, data } = await ownSudoCard(app, accountId, messageId);
  const expired = await expireIfDue(app, card, data);
  const device = await app.prisma.device.findFirst({ where: { id: data.deviceId, userId: accountId, revokedAt: null } });
  if (!device) throw new SudoError(`${data.deviceName ?? "That computer"} is no longer paired.`, 409);
  return { id: card.id, status: expired ? "expired" : data.status, command: data.command, commandHash: data.commandHash, deviceId: device.id, deviceName: device.name, online: deviceOnline(device.lastSeenAt), route: sudoRouteFor(device), ttlMs: SEAL_TTL_MS, expiresAt: data.expiresAt };
}

/** A sealed password's box, checked against this card, its computer's pinned key and the page that sent it; the computer checks again. */
function checkBox(sealed: Sealed, card: NodeMessage, data: SudoCardData, sealKey: SealKeyInfo, origin: string | undefined): void {
  let aad;
  try {
    aad = readAad(sealed);
  } catch (error) {
    throw new SudoError(error instanceof SealError ? error.message : "The password could not be read.", 400, "seal_shape");
  }
  const now = Date.now();
  const expires = Date.parse(aad.expiresAt);
  const problem =
    sealed.kid !== sealKey.kid || aad.kid !== sealKey.kid
      ? "It was encrypted for an older key of this computer. Reload the page and type it again."
      : aad.deviceId !== data.deviceId
        ? "It was encrypted for another computer."
        : aad.decisionId !== card.id || aad.purpose !== "sudo" || aad.name !== data.commandHash
          ? "It was encrypted for another request."
          : origin && aad.origin !== origin
            ? "It was encrypted on another site."
            : !Number.isFinite(expires) || expires <= now || expires - now > SEAL_MAX_TTL_MS
              ? "It expired. Type it again."
              : null;
  if (problem) throw new SudoError(problem, 400, "seal_bound");
}

const attempts = new MemoryRateLimiter();

/**
 * The owner's answer (`POST /api/node/sudo/:messageId`): once (a compare-and-set on the card). Run is
 * handed to the node's waiting call, or relayed from here and the node woken; deny tells the node.
 * `origin`: the browser's Origin header, which a sealed box must name.
 */
export async function answerSudo(app: FastifyInstance, accountId: string, messageId: string, answer: SudoAnswer, origin?: string): Promise<NodeMessage> {
  if (attempts.take(`sudo:${accountId}`, 30, 10 * 60_000) !== null) throw new SudoError("Too many answers. Wait a moment and try again.", 429);
  const { card, data } = await ownSudoCard(app, accountId, messageId);
  if (await expireIfDue(app, card, data)) throw new SudoError("This request expired. Ask your node again if it is still needed.", 409, "expired");
  if (data.status !== "pending") throw new SudoError("This was already answered.", 409);
  const now = new Date().toISOString();
  if (answer.action === "deny") {
    const denied = await updateMessageDataIf(app.prisma, card, pending, { status: "denied", answeredAt: now });
    if (!denied) throw new SudoError("This was already answered.", 409);
    const waiter = waiters.get(card.id);
    if (waiter) waiter({ action: "deny" });
    await appendLedger({ userId: accountId, actor: "me", action: "node.sudo.answered", payload: { nodeId: card.authorNodeId, deviceId: data.deviceId, action: "deny" } });
    if (!waiter) await wake(app, denied, `Your owner chose not to run \`${data.command}\` as administrator on ${data.deviceName ?? "the computer"}. Continue without it, or say what cannot be done without it.`);
    return denied;
  }
  const device = await app.prisma.device.findFirst({ where: { id: data.deviceId, userId: accountId, revokedAt: null } });
  if (!device) throw new SudoError(`${data.deviceName ?? "That computer"} is no longer paired.`, 409);
  if (answer.sealed) {
    const route = sudoRouteFor(device);
    if (route.mode !== "sealed") throw new SudoError(route.reason, 409, "seal_unavailable");
    checkBox(answer.sealed as Sealed, card, data, route.sealKey, origin);
  }
  if (!deviceOnline(device.lastSeenAt)) throw new SudoError(`${device.name} is offline. Open Ensemble there, then answer again.`, 409, "offline");
  const running = await updateMessageDataIf(app.prisma, card, pending, { status: "running", answeredAt: now, error: null });
  if (!running) throw new SudoError("This was already answered.", 409);
  const sealed = answer.sealed as Sealed | undefined;
  const waiter = waiters.get(card.id);
  if (waiter) waiter({ action: "run", ...(sealed ? { sealed } : {}) });
  else inBackground(app, () => relayAndWake(app, running, sealed));
  await appendLedger({ userId: accountId, actor: "me", action: "node.sudo.answered", payload: { nodeId: card.authorNodeId, deviceId: device.id, action: "run", withPassword: Boolean(sealed) } });
  return running;
}

/** A card nobody answered in time closes, and its node hears it did not run. */
export async function expireSudo(app: FastifyInstance, cardId: string): Promise<void> {
  const timer = expiries.get(cardId);
  if (timer) clearTimeout(timer);
  expiries.delete(cardId);
  const card = await app.prisma.nodeMessage.findUnique({ where: { id: cardId } });
  const data = card ? SudoCard.safeParse(card.data) : null;
  if (!card || !data?.success || data.data.status !== "pending") return;
  if (Date.parse(data.data.expiresAt) > Date.now()) return scheduleExpiry(app, card);
  const expired = await updateMessageDataIf(app.prisma, card, pending, { status: "expired" });
  if (!expired || waiters.has(cardId)) return;
  await wake(app, expired, `Your owner did not answer the card about running \`${data.data.command}\` as administrator on ${data.data.deviceName ?? "the computer"} in time, and it closed. It did not run. Go on without it, or ask again if it is still needed.`);
}

function scheduleExpiry(app: FastifyInstance, card: NodeMessage): void {
  if (expiries.has(card.id)) return;
  const at = Date.parse(String((card.data as { expiresAt?: unknown }).expiresAt));
  const timer = setTimeout(() => void expireSudo(app, card.id).catch((error: unknown) => app.log.warn({ err: error }, "could not close a sudo card")), Math.max(0, (Number.isFinite(at) ? at : Date.now()) - Date.now()));
  timer.unref?.();
  expiries.set(card.id, timer);
}

/** A command that ran on in the background ended (devices/tool-runs.ts): its card says how. */
export async function sudoRunEnded(app: Pick<FastifyInstance, "prisma">, cardId: string, exitCode: number | null): Promise<void> {
  await finishCard(app, cardId, { status: exitCode === 0 ? "done" : "failed", exitCode, error: exitCode === 0 ? null : `It ended with exit code ${exitCode ?? "unknown"}.` });
}

/** After a restart: cards still waiting close on time, and a relay a restart cut off is closed with why. */
export async function recoverSudoCards(app: FastifyInstance): Promise<void> {
  const cards = await app.prisma.nodeMessage.findMany({ where: { kind: "approval", data: { path: ["type"], equals: SUDO_CARD }, OR: [pending, runningWhere] }, take: 500 });
  for (const card of cards) {
    const data = SudoCard.safeParse(card.data);
    if (!data.success) continue;
    if (data.data.status === "pending") {
      if (Date.parse(data.data.expiresAt) <= Date.now()) await expireSudo(app, card.id).catch(() => undefined);
      else scheduleExpiry(app, card);
    } else if (!data.data.runId && data.data.answeredAt && Date.now() - Date.parse(data.data.answeredAt) > RUNNING_STALE_MS) {
      await updateMessageDataIf(app.prisma, card, runningWhere, { status: "failed", error: "Ensemble restarted before the computer answered: it may or may not have run." });
    }
  }
}

export async function registerSudoRoutes(app: FastifyInstance, account: (request: FastifyRequest) => string): Promise<void> {
  /** The command, its computer, and that computer's pinned key for a password sealed in the browser. */
  app.get("/api/node/sudo/:messageId", async (request, reply) => {
    try {
      return await sudoTarget(app, account(request), (request.params as { messageId: string }).messageId);
    } catch (error) {
      if (error instanceof SudoError) return reply.code(error.statusCode).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      throw error;
    }
  });

  /** The owner's answer: run (the password sealed for the computer, or none) or deny. The password is never stored or logged here. */
  app.post("/api/node/sudo/:messageId", async (request, reply) => {
    const accountId = account(request);
    const parsed = SudoAnswer.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Answer with run (and the password sealed for the computer) or deny." });
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    try {
      return { message: wireMessage(await answerSudo(app, accountId, (request.params as { messageId: string }).messageId, parsed.data, origin)) };
    } catch (error) {
      if (error instanceof SudoError) return reply.code(error.statusCode).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      throw error;
    }
  });
}
