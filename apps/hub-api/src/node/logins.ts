/**
 * Sign-in cards (B11, docs/35 §8.16): a tab on the owner's computer waits for them to sign in to a
 * site. The card (owner only; in the node's conversation, Node's Needs me and the Hub's Needs me) says
 * which site and computer, and offers: use the login saved there, sign in on the computer (then "I'm
 * done"), type it here (sealed in the browser for that computer's key, as B12 secrets are: this server
 * relays a box it cannot open), or not now. This server only relays the answer (`login.resolve`) and
 * records how it went; it never sees, keeps or logs a password, and the node only hears whether its
 * tab is signed in. A node's tab wakes the node when it ends; a run's agent waits in its tool call.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { NodeAgent, NodeMessage, Prisma } from "@prisma/client";
import { SEAL_MAX_TTL_MS, SEAL_TTL_MS, type SealKeyInfo, type Sealed } from "@ensemble/shared-types";
import { deviceOnline } from "../devices/constants.js";
import { askDeviceFor } from "../devices/file-relay.js";
import { appendLedger } from "../lib/ledger.js";
import { readAad, SealedShape, SealError } from "../credentials/seal.js";
import { CodeAnswer, LoginResolution, type LoginRequired } from "../remote/contract.js";
import { enqueueTurn } from "./queue.js";
import { postMessage, updateMessageDataIf } from "./store.js";
import { finishStep, planLinkOf } from "./plans.js";
import { secretRouteFor } from "./node-secrets.js";

export const LOGIN_CARD = "login";
/** How long the computer may take to fill a sign-in and check it. */
const ANSWER_MS = 60_000;
/** A card left "working" this long (the server restarted mid-answer) can be answered again. */
const WORKING_STALE_MS = ANSWER_MS + 15_000;

const LoginCard = z
  .object({
    type: z.literal(LOGIN_CARD),
    status: z.string(),
    loginId: z.string(),
    deviceId: z.string(),
    computer: z.string().nullish(),
    origin: z.string(),
    tab: z.string(),
    saved: z.boolean().optional(),
    display: z.boolean().optional(),
    takeover: z.boolean().optional(),
    jobId: z.string().nullish(),
    operation: z.string().nullish(),
    private: z.boolean().optional(),
    workingId: z.string().optional(),
    workingAt: z.string().optional(),
  })
  .passthrough();
type LoginCardData = z.infer<typeof LoginCard>;

export class LoginCardError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 502,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** What the owner's browser sends: one of the card's buttons, or what they typed sealed for the computer. */
export const LoginAnswer = z.union([z.object({ action: z.enum(["saved", "local", "done", "decline"]) }).strict(), z.object({ action: z.literal("typed"), sealed: SealedShape }).strict()]);
export type LoginAnswer = z.infer<typeof LoginAnswer>;

type PostInput = {
  ownerId: string;
  node: Pick<NodeAgent, "id" | "slug">;
  roomId: string;
  device: { id: string; name: string };
  login: LoginRequired;
  /** A run's sign-in (its hosted job); else a node tool operation's. */
  jobId?: string | null;
  operation?: string | null;
  planId?: string | null;
  planStep?: string | null;
  rootMessageId?: string | null;
  private?: boolean;
};

/** The owner-only card for a sign-in; the same card again for a sign-in it already shows. */
export async function postLoginCard(app: FastifyInstance, input: PostInput): Promise<NodeMessage> {
  const prisma = app.prisma;
  const existing = await prisma.nodeMessage.findFirst({ where: { roomId: input.roomId, kind: "approval", AND: [{ data: { path: ["type"], equals: LOGIN_CARD } }, { data: { path: ["loginId"], equals: input.login.loginId } }] } });
  if (existing) return existing;
  const { message } = await postMessage(prisma, {
    roomId: input.roomId,
    userId: input.ownerId,
    authorKind: "node",
    authorNodeId: input.node.id,
    kind: "approval",
    body: `@${input.node.slug} needs you to sign in to ${input.login.origin} on ${input.device.name}.`,
    data: {
      type: LOGIN_CARD,
      status: "pending",
      loginId: input.login.loginId,
      deviceId: input.device.id,
      computer: input.device.name,
      origin: input.login.origin,
      tab: input.login.tab,
      reasons: input.login.reasons,
      saved: input.login.saved,
      display: input.login.display,
      takeover: input.login.takeover,
      expiresAt: input.login.expiresAt,
      ...(input.jobId ? { jobId: input.jobId } : { operation: input.operation ?? null }),
      ...(input.private ? { private: true } : {}),
      // The step waits for the sign-in, and a routine's card expires as its other cards do.
      ...(input.planId ? { plan: { id: input.planId, step: input.planStep ?? null } } : {}),
    },
    visibleTo: [input.ownerId],
    rootMessageId: input.rootMessageId ?? null,
  });
  await appendLedger({ userId: input.ownerId, actor: "agent", action: "node.login_needed", payload: { nodeId: input.node.id, deviceId: input.device.id, origin: input.login.origin, run: Boolean(input.jobId) } });
  return message;
}

/** A run's sign-in, raised by its computer: the card goes where the run's card is, by the run's node. Null for a run no node follows. */
export async function loginCardForRun(app: FastifyInstance, device: { id: string; name: string; userId: string }, jobId: string, login: LoginRequired): Promise<NodeMessage | null> {
  const run = await app.prisma.nodeRun.findUnique({ where: { jobId }, select: { nodeId: true, roomId: true, userId: true, planId: true, planStep: true, messageId: true } });
  if (!run || run.userId !== device.userId) return null;
  const node = await app.prisma.nodeAgent.findUnique({ where: { id: run.nodeId }, select: { id: true, slug: true } });
  if (!node) return null;
  const runCard = run.messageId ? await app.prisma.nodeMessage.findUnique({ where: { id: run.messageId }, select: { rootMessageId: true, data: true } }) : null;
  return postLoginCard(app, {
    ownerId: run.userId,
    node,
    roomId: run.roomId,
    device,
    login,
    jobId,
    planId: run.planId,
    planStep: run.planStep,
    rootMessageId: runCard?.rootMessageId ?? null,
    private: (runCard?.data as { private?: unknown } | null)?.private === true,
  });
}

/** The card, if this account may answer it: its owner, still in the room. */
async function ownLoginCard(app: FastifyInstance, accountId: string, messageId: string): Promise<{ card: NodeMessage; node: NodeAgent; data: LoginCardData }> {
  const card = await app.prisma.nodeMessage.findUnique({ where: { id: messageId } });
  const parsed = card ? LoginCard.safeParse(card.data) : null;
  if (!card || !parsed?.success || card.kind !== "approval" || card.userId !== accountId || !card.authorNodeId) throw new LoginCardError("That sign-in is not available.", 404);
  const [node, member] = await Promise.all([
    app.prisma.nodeAgent.findUnique({ where: { id: card.authorNodeId } }),
    app.prisma.nodeRoomMember.findFirst({ where: { roomId: card.roomId, userId: accountId, nodeId: null }, select: { id: true } }),
  ]);
  if (!node || node.userId !== accountId || !member) throw new LoginCardError("That sign-in is not available.", 404);
  return { card, node, data: parsed.data };
}

/** The computer, and how typed values reach it: sealed for its pinned key (or nothing until it is paired again). */
export async function loginTarget(
  app: FastifyInstance,
  accountId: string,
  messageId: string,
): Promise<{ id: string; status: string; origin: string; loginId: string; computer: { id: string; name: string; online: boolean }; route: { mode: "sealed"; sealKey: SealKeyInfo } | { mode: "pair_again" } | { mode: "unsupported" }; saved: boolean; display: boolean; takeover: boolean; ttlMs: number }> {
  const { card, data } = await ownLoginCard(app, accountId, messageId);
  const device = await app.prisma.device.findFirst({ where: { id: data.deviceId, userId: accountId, revokedAt: null } });
  if (!device) throw new LoginCardError(`${data.computer ?? "That computer"} is no longer paired.`, 409);
  const secretRoute = secretRouteFor(device);
  const route = secretRoute.mode === "sealed" ? secretRoute : secretRoute.mode === "pair_again" ? { mode: "pair_again" as const } : { mode: "unsupported" as const };
  return { id: card.id, status: data.status, origin: data.origin, loginId: data.loginId, computer: { id: device.id, name: device.name, online: deviceOnline(device.lastSeenAt) }, route, saved: data.saved === true, display: data.display === true, takeover: data.takeover === true, ttlMs: SEAL_TTL_MS };
}

/** Whether a card can be answered now: pending, or stuck working past `WORKING_STALE_MS`. */
function answerable(data: LoginCardData, now = Date.now()): Prisma.NodeMessageWhereInput | null {
  if (data.status === "pending") return { data: { path: ["status"], equals: "pending" } };
  if (data.status === "working" && data.workingId && data.workingAt && now - Date.parse(data.workingAt) > WORKING_STALE_MS) return workingBy(data.workingId);
  return null;
}

const workingBy = (workingId: string): Prisma.NodeMessageWhereInput => ({ AND: [{ data: { path: ["status"], equals: "working" } }, { data: { path: ["workingId"], equals: workingId } }] });

/** A typed answer's box, checked against this card, its computer's pinned key and the page that sent it; the computer checks again. */
function checkTypedBox(sealed: Sealed, card: NodeMessage, data: LoginCardData, sealKey: SealKeyInfo, origin: string | undefined): void {
  let aad;
  try {
    aad = readAad(sealed);
  } catch (error) {
    throw new LoginCardError(error instanceof SealError ? error.message : "What you typed could not be read.", 400, "seal_shape");
  }
  const now = Date.now();
  const expires = Date.parse(aad.expiresAt);
  const problem =
    sealed.kid !== sealKey.kid || aad.kid !== sealKey.kid
      ? "It was encrypted for an older key of this computer. Reload the page and type it again."
      : aad.deviceId !== data.deviceId
        ? "It was encrypted for another computer."
        : aad.decisionId !== card.id || aad.purpose !== "login" || aad.name !== data.loginId
          ? "It was encrypted for another request."
          : origin && aad.origin !== origin
            ? "It was encrypted on another site."
            : !Number.isFinite(expires) || expires <= now || expires - now > SEAL_MAX_TTL_MS
              ? "It expired. Type it again."
              : null;
  if (problem) throw new LoginCardError(problem, 400, "seal_bound");
}

function words(status: LoginResolution["status"], computer: string, message?: string): string {
  if (status === "shown") return `It is open on ${computer}. Sign in there, then press I'm done.`;
  if (status === "waiting") return `Still not signed in${message ? `: ${message}` : "."} Finish on ${computer}, then press I'm done.`;
  if (status === "busy") return `${computer} is still working on the last answer.`;
  return message ?? `${computer} could not do that.`;
}

/**
 * Relays the owner's answer to the card's computer and records how it went. The card stays pending
 * when the computer could not sign in (with why), so the owner can try again or another way.
 * `origin`: the browser's Origin header, which a typed box must name.
 */
export async function answerLoginCard(app: FastifyInstance, accountId: string, messageId: string, answer: LoginAnswer, origin?: string): Promise<{ message: NodeMessage; result: LoginResolution }> {
  const prisma = app.prisma;
  const { card, node, data } = await ownLoginCard(app, accountId, messageId);
  const when = answerable(data);
  if (!when) throw new LoginCardError(data.status === "working" ? `${data.computer ?? "The computer"} is still working on the last answer.` : "This sign-in was already answered.", 409);
  const device = await prisma.device.findFirst({ where: { id: data.deviceId, userId: accountId, revokedAt: null } });
  const computer = device?.name ?? data.computer ?? "the computer";
  if (answer.action === "decline" && (!device || !deviceOnline(device.lastSeenAt))) {
    // Not now needs no computer: its sign-in ends there by itself.
    const declined = await updateMessageDataIf(prisma, card, when, { status: "declined", error: null, resolvedAt: new Date().toISOString() });
    if (!declined) throw new LoginCardError("This sign-in was already answered.", 409);
    await afterLogin(app, node, declined, "declined");
    return { message: declined, result: { status: "declined" } };
  }
  if (!device) throw new LoginCardError(`${computer} is no longer paired.`, 409);
  if (answer.action === "typed") {
    const route = secretRouteFor(device);
    if (route.mode === "pair_again") throw new LoginCardError(`${computer} now reports a different key from the one it was paired with, so nothing is sent to it. Pair it again, then sign in.`, 409, "pair_again");
    if (route.mode !== "sealed") throw new LoginCardError(`Ensemble on ${computer} cannot open what you type here. Update it there, or sign in on the computer.`, 409, "seal_unsupported");
    checkTypedBox(answer.sealed as Sealed, card, data, route.sealKey, origin);
  }
  if (answer.action === "local" && data.display !== true) throw new LoginCardError(`${computer} has no screen to sign in on. Type it here instead.`, 409, "no_display");
  if (!deviceOnline(device.lastSeenAt)) throw new LoginCardError(`${computer} is offline. Open Ensemble there, then try again.`, 409, "offline");
  const workingId = randomUUID();
  const current = await updateMessageDataIf(prisma, card, when, { status: "working", workingId, workingAt: new Date().toISOString(), working: answer.action, error: null });
  if (!current) throw new LoginCardError("This sign-in was already answered.", 409);
  const ours = workingBy(workingId);
  const raw = await askDeviceFor(app.redis as never, { deviceId: device.id, event: "login.resolve", data: { loginId: data.loginId, decisionId: card.id, action: answer.action, ...(answer.action === "typed" ? { sealed: answer.sealed } : {}) } }, ANSWER_MS).catch(() => null);
  const reply = raw ? CodeAnswer.safeParse(raw) : null;
  const parsed = reply?.success && reply.data.status < 400 ? LoginResolution.safeParse(reply.data.body) : null;
  if (!parsed?.success) {
    const reason = raw ? `${computer} sent an answer that could not be read. Update Ensemble there.` : `${computer} did not answer. Check Ensemble is running there and try again.`;
    await updateMessageDataIf(prisma, current, ours, { status: "pending", working: null, error: reason });
    throw new LoginCardError(reason, 502);
  }
  const result = parsed.data;
  const now = new Date().toISOString();
  const via = answer.action === "saved" ? "saved" : answer.action === "typed" ? "typed" : "computer";
  const patch: Record<string, unknown> =
    result.status === "signed_in"
      ? { status: "signed_in", working: null, error: null, note: result.message ?? null, via, resolvedAt: now, ...(result.savedNow ? { savedNow: true } : {}) }
      : result.status === "declined" || result.status === "expired"
        ? { status: result.status, working: null, error: null, resolvedAt: now }
        : result.status === "gone"
          ? { status: "ended", working: null, error: null, note: "The work that needed this sign-in ended, or its tab closed.", resolvedAt: now }
          : result.status === "shown"
            ? { status: "pending", working: null, error: null, note: words("shown", computer), shownAt: now }
            : { status: "pending", working: null, error: words(result.status, computer, result.message) };
  const updated = await updateMessageDataIf(prisma, current, ours, patch);
  if (!updated) throw new LoginCardError("This sign-in was already answered.", 409);
  await appendLedger({ userId: accountId, actor: "me", action: "node.login_answered", payload: { nodeId: node.id, deviceId: device.id, origin: data.origin, action: answer.action, status: result.status } });
  if (result.status === "signed_in" || result.status === "declined" || result.status === "expired") await afterLogin(app, node, updated, result.status);
  return { message: updated, result };
}

/** The node hears how its tab's sign-in ended; a run's agent hears it in its own tool call instead. */
async function afterLogin(app: FastifyInstance, node: NodeAgent, card: NodeMessage, status: "signed_in" | "declined" | "expired"): Promise<void> {
  const data = card.data as LoginCardData;
  if (data.jobId) return;
  const link = planLinkOf(card.data);
  const where = `${data.origin} on ${data.computer ?? "the computer"}`;
  const note =
    status === "signed_in"
      ? `Your owner signed in to ${where} (you never see how). Tab ${data.tab} is yours again: take a new snapshot and carry on with the work that needed it.`
      : `Your owner ${status === "declined" ? "chose not to sign in" : "did not sign in in time"} to ${where}. Do not try to sign in yourself. Finish your step without it, or call node_step_blocked with why (it needs a sign-in to ${data.origin}).`;
  const queued = await enqueueTurn(app, { nodeId: node.id, roomId: card.roomId, reason: "approval", note, private: data.private === true, ...(link ?? {}) });
  if (!queued && status !== "signed_in" && link?.planStep) await finishStep(app, link.planId, link.planStep, { status: "blocked", result: `It needs a sign-in to ${data.origin}, and your owner did not sign in (login_required).` });
}

/** The card was closed elsewhere (its work ended, a routine's wait ran out): its computer frees the tab. */
export async function loginCardClosed(app: FastifyInstance, card: NodeMessage): Promise<void> {
  const data = LoginCard.safeParse(card.data);
  if (!data.success) return;
  const device = await app.prisma.device.findFirst({ where: { id: data.data.deviceId, revokedAt: null } });
  if (!device || !deviceOnline(device.lastSeenAt)) return;
  await askDeviceFor(app.redis as never, { deviceId: device.id, event: "login.resolve", data: { loginId: data.data.loginId, decisionId: card.id, action: "expire" } }, 10_000).catch(() => null);
}

/**
 * A takeover of a sign-in's tab ended with I'm done (node/takeovers.ts): the computer checked it. Signed
 * in, the card says so and its node goes on; not yet, the card stays open with why.
 */
export async function loginTakeoverEnded(app: FastifyInstance, accountId: string, cardId: string, signedIn: boolean | null, message?: string): Promise<NodeMessage | null> {
  if (signedIn === null) return null;
  let own;
  try {
    own = await ownLoginCard(app, accountId, cardId);
  } catch {
    return null;
  }
  const { card, node, data } = own;
  if (data.status !== "pending") return null;
  const pending: Prisma.NodeMessageWhereInput = { data: { path: ["status"], equals: "pending" } };
  if (!signedIn) return updateMessageDataIf(app.prisma, card, pending, { error: `Still not signed in${message ? `: ${message}` : "."} Open the browser again, or answer another way.` });
  const updated = await updateMessageDataIf(app.prisma, card, pending, { status: "signed_in", working: null, error: null, note: null, via: "takeover", resolvedAt: new Date().toISOString() });
  if (!updated) return null;
  await appendLedger({ userId: accountId, actor: "me", action: "node.login_answered", payload: { nodeId: node.id, deviceId: data.deviceId, origin: data.origin, action: "takeover", status: "signed_in" } });
  await afterLogin(app, node, updated, "signed_in");
  return updated;
}
