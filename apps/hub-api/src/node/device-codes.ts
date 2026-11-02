/**
 * Sign-ins a node's command needs (C2, docs/35 §8.16.4). A command such as `az login --use-device-code`
 * or `gh auth login` prints a code to enter on a page: its computer finds it in the output and posts it
 * here, and the owner gets it on a card only they see, in the command's conversation (the code, the page,
 * the command, the computer, and until when); the card says done or expired when the command ends. A
 * command that opens a sign-in page in a browser (`az login`, `gh auth login --web`) has it opened in the
 * computer's sign-in browser, and the usual sign-in card is raised (`source: "cli"`): the owner signs in
 * from the remote view, and the command's own callback lands on that computer. The code is the owner's:
 * the command they asked for printed it on their computer. It is in the card and the command's output,
 * never in the ledger. One attempt at a time: a newer run of the same sign-in on the same computer
 * replaces the older one (`replaceSignInRun`).
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Device as DeviceRow, NodeMessage } from "@prisma/client";
import { quietRun, stopRunOnComputer, toolRunOf } from "../devices/tool-runs.js";
import { appendLedger } from "../lib/ledger.js";
import type { NodeCliLoginPost, NodeDeviceCodePost } from "../remote/contract.js";
import { LOGIN_CARD, LOGIN_WAITING, loginCardClosed, postLoginCard } from "./logins.js";
import { postMessage, updateMessageDataIf } from "./store.js";

export const DEVICE_CODE_CARD = "device_code";
/** A code that says nothing about its life is good for this long (Microsoft's and GitHub's are 15 minutes). */
const DEFAULT_CODE_MS = 15 * 60_000;

type Device = { id: string; name: string; userId: string };
type Redisish = Parameters<typeof toolRunOf>[0];

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/** The command's run, if this computer runs it for this node of its owner. */
async function runOf(app: FastifyInstance, device: Device, nodeId: string, runId: string) {
  const run = await toolRunOf(app.redis as unknown as Redisish, runId);
  if (!run || run.deviceId !== device.id || run.nodeId !== nodeId || run.ownerId !== device.userId) return null;
  const node = await app.prisma.nodeAgent.findFirst({ where: { id: nodeId, userId: device.userId }, select: { id: true, slug: true } });
  return node ? { run, node } : null;
}

/**
 * A code the command printed: one owner-only card per code, in the command's conversation; the same post
 * with `status` done or expired when the command ended. Null when the command is not this computer's.
 */
export async function deviceCodeFromComputer(app: FastifyInstance, device: Device, body: NodeDeviceCodePost): Promise<NodeMessage | null> {
  const found = await runOf(app, device, body.nodeId, body.operation);
  if (!found) return null;
  const { run, node } = found;
  const prisma = app.prisma;
  // One card per code and command, whichever post comes first.
  const clientId = `device-code:${createHash("sha256").update(`${body.operation}\u0000${body.code}`).digest("hex").slice(0, 40)}`;
  const existing = await prisma.nodeMessage.findUnique({ where: { roomId_clientId: { roomId: run.roomId, clientId } } });
  if (existing) {
    if (body.status === "pending") return existing;
    const updated = await updateMessageDataIf(prisma, existing, { data: { path: ["status"], equals: "pending" } }, { status: body.status, endedAt: new Date().toISOString() });
    if (updated) await appendLedger({ userId: device.userId, actor: "agent", action: "node.device_code", payload: { nodeId: node.id, deviceId: device.id, site: hostOf(body.url), status: body.status } }).catch(() => undefined);
    return updated ?? existing;
  }
  if (body.status !== "pending") return null;
  const expiresAt = body.expiresAt && Number.isFinite(Date.parse(body.expiresAt)) ? new Date(Math.min(Date.parse(body.expiresAt), Date.now() + 3600_000)).toISOString() : new Date(Date.now() + DEFAULT_CODE_MS).toISOString();
  const { message } = await postMessage(prisma, {
    roomId: run.roomId,
    userId: device.userId,
    authorKind: "node",
    authorNodeId: node.id,
    kind: "text",
    // The body says it too, for a page that does not draw the card yet: only the owner sees it.
    body: `To finish \`${body.command}\` on ${device.name}, open ${body.url} and enter the code ${body.code}.`,
    data: {
      type: DEVICE_CODE_CARD,
      status: "pending",
      url: body.url,
      code: body.code,
      command: body.command,
      computer: device.name,
      deviceId: device.id,
      operation: body.operation,
      expiresAt,
      ...(run.private ? { private: true } : {}),
    },
    visibleTo: [device.userId],
    clientId,
  });
  await appendLedger({ userId: device.userId, actor: "agent", action: "node.device_code", payload: { nodeId: node.id, deviceId: device.id, site: hostOf(body.url), status: "pending" } }).catch(() => undefined);
  return message;
}

/** A sign-in page the command opened in the computer's sign-in browser: the usual sign-in card, in the command's conversation. */
export async function cliLoginFromComputer(app: FastifyInstance, device: Device, body: NodeCliLoginPost): Promise<NodeMessage | null> {
  const found = await runOf(app, device, body.nodeId, body.operation);
  if (!found) return null;
  const { run, node } = found;
  return postLoginCard(app, {
    ownerId: device.userId,
    node,
    roomId: run.roomId,
    device,
    login: { ...body.login, source: "cli", command: body.login.command ?? run.command.slice(0, 200) },
    operation: `node:${node.id}:own`,
    run: body.operation,
    planId: run.planId,
    planStep: run.planStep,
    private: run.private,
  });
}

export const REPLACED_NOTE = "Replaced by a newer sign-in.";

/**
 * A node started the same sign-in again (`az login` after `az login --use-device-code`) on the same
 * computer: the older run is stopped there, its end wakes no one, and its cards say it was replaced.
 */
export async function replaceSignInRun(app: FastifyInstance, device: DeviceRow, nodeId: string, runId: string): Promise<void> {
  const redis = app.redis as unknown as Redisish & Parameters<typeof quietRun>[0];
  const run = await toolRunOf(redis, runId);
  if (!run || run.done || run.nodeId !== nodeId || run.deviceId !== device.id) return;
  await quietRun(redis, runId, "replaced");
  const prisma = app.prisma;
  const now = new Date().toISOString();
  const codes = await prisma.nodeMessage.findMany({ where: { roomId: run.roomId, AND: [{ data: { path: ["type"], equals: DEVICE_CODE_CARD } }, { data: { path: ["operation"], equals: runId } }, { data: { path: ["status"], equals: "pending" } }] } });
  for (const card of codes) await updateMessageDataIf(prisma, card, { data: { path: ["status"], equals: "pending" } }, { status: "replaced", note: REPLACED_NOTE, endedAt: now });
  const logins = await prisma.nodeMessage.findMany({ where: { roomId: run.roomId, kind: "approval", AND: [{ data: { path: ["type"], equals: LOGIN_CARD } }, { data: { path: ["run"], equals: runId } }] } });
  for (const card of logins) {
    const status = (card.data as { status?: unknown }).status;
    if (typeof status !== "string" || !(LOGIN_WAITING as readonly string[]).includes(status)) continue;
    const updated = await updateMessageDataIf(prisma, card, { data: { path: ["status"], equals: status } }, { status: "ended", replaced: true, note: REPLACED_NOTE, working: null, error: null, codeHint: null, resolvedAt: now });
    // Its tab on the computer is freed; a computer that cannot stop runs ends the command this way.
    if (updated) void loginCardClosed(app, updated).catch(() => undefined);
  }
  await stopRunOnComputer(app, device, nodeId, runId);
  await appendLedger({ userId: device.userId, actor: "agent", action: "node.sign_in_replaced", payload: { nodeId, deviceId: device.id, program: run.signIn ?? null } }).catch(() => undefined);
}
