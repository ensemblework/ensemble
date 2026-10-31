/**
 * Sign-in cards (B11, docs/35 §8.16): a tab on the owner's computer waits for them to sign in to a
 * site, or to pass a human check there (`purpose`: a captcha, "Robot or human?"). The card (owner
 * only; in the node's conversation, Node's Needs me and the Hub's Needs me) says which site and
 * computer, and offers: sign in here (the page live on the owner's phone or computer, node/takeovers.ts),
 * use the login saved there, the window on the computer, type it here (sealed in the browser for that
 * computer's key, as B12 secrets are: this server relays a box it cannot open), the code the site asks
 * for (sealed the same way), or not now. "I'm done" (or the owner saying so in the chat,
 * node/login-check.ts) has the computer check it. This server only relays the answer
 * (`login.resolve`) and records how it went; it never sees, keeps or logs a password or a code, and the
 * node only hears whether its tab is signed in. A node's tab wakes the node when it ends; a run's agent
 * waits in its tool call.
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
import { CodeAnswer, LOGIN_CHECKS_API, LoginResolution, type LoginRequired, type LoginStatePost } from "../remote/contract.js";
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
    purpose: z.enum(["sign_in", "human_check"]).optional(),
    codeHint: z.string().nullish(),
    jobId: z.string().nullish(),
    operation: z.string().nullish(),
    private: z.boolean().optional(),
    workingId: z.string().optional(),
    workingAt: z.string().optional(),
    /** The status a card working on an answer goes back to when the answer did not end it. */
    workingFrom: z.string().optional(),
  })
  .passthrough();
export type LoginCardData = z.infer<typeof LoginCard>;

/** Statuses a card waits for its owner in: pending, or the site asks for a code. */
export const LOGIN_WAITING = ["pending", "needs_code"] as const;

/** A sign-in card waits at least this long, background work's too: signing in takes a while. */
export const LOGIN_MIN_WAIT_MS = 15 * 60_000;

/** How long a routine's sign-in card waits: as its other cards (`ENSEMBLE_BACKGROUND_DECISION_MINUTES`), never under 15 minutes. */
export function routineLoginWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(LOGIN_MIN_WAIT_MS, (Number(env.ENSEMBLE_BACKGROUND_DECISION_MINUTES ?? 30) || 30) * 60_000);
}

/** "portal.azure.com" for https://portal.azure.com, "walmart.com" for https://www.walmart.com (a port stays). */
export function siteOf(origin: string): string {
  try {
    return new URL(origin).host.replace(/^www\./, "") || origin;
  } catch {
    return origin;
  }
}

/** The card's words: a sign-in, or a human check. */
export function loginTitle(slug: string, origin: string, purpose: "sign_in" | "human_check" = "sign_in"): string {
  return purpose === "human_check" ? `@${slug} needs you to pass a human check on ${siteOf(origin)}.` : `@${slug} needs you to sign in to ${siteOf(origin)}.`;
}

export class LoginCardError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 502,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * What the owner's browser sends: one of the card's buttons (`check`: they said in the chat they
 * finished), or what they typed sealed for the computer (`typed`: the login; `code`: the code the site
 * asks for).
 */
export const LoginAnswer = z.union([
  z.object({ action: z.enum(["saved", "local", "done", "check", "decline"]) }).strict(),
  z.object({ action: z.enum(["typed", "code"]), sealed: SealedShape }).strict(),
]);
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
  const purpose = input.login.purpose ?? "sign_in";
  // A routine's card expires sooner than the computer's wait (node/routines.ts): the card says when.
  const routine = input.planId ? Boolean((await prisma.nodeMission.findUnique({ where: { id: input.planId }, select: { routine: true } }).catch(() => null))?.routine) : false;
  const expiresAt = routine ? new Date(Math.min(Date.parse(input.login.expiresAt) || Infinity, Date.now() + routineLoginWaitMs())).toISOString() : input.login.expiresAt;
  const { message } = await postMessage(prisma, {
    roomId: input.roomId,
    userId: input.ownerId,
    authorKind: "node",
    authorNodeId: input.node.id,
    kind: "approval",
    body: loginTitle(input.node.slug, input.login.origin, purpose),
    data: {
      type: LOGIN_CARD,
      status: "pending",
      purpose,
      codeHint: null,
      loginId: input.login.loginId,
      deviceId: input.device.id,
      computer: input.device.name,
      origin: input.login.origin,
      tab: input.login.tab,
      reasons: input.login.reasons,
      saved: input.login.saved,
      display: input.login.display,
      takeover: input.login.takeover,
      expiresAt,
      ...(input.jobId ? { jobId: input.jobId } : { operation: input.operation ?? null }),
      ...(input.private ? { private: true } : {}),
      // The step waits for the sign-in, and a routine's card expires as its other cards do.
      ...(input.planId ? { plan: { id: input.planId, step: input.planStep ?? null } } : {}),
    },
    visibleTo: [input.ownerId],
    rootMessageId: input.rootMessageId ?? null,
  });
  await appendLedger({ userId: input.ownerId, actor: "agent", action: "node.login_needed", payload: { nodeId: input.node.id, deviceId: input.device.id, origin: input.login.origin, purpose, run: Boolean(input.jobId) } });
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
): Promise<{
  id: string;
  status: string;
  purpose: "sign_in" | "human_check";
  codeHint: string | null;
  origin: string;
  loginId: string;
  computer: { id: string; name: string; online: boolean };
  route: { mode: "sealed"; sealKey: SealKeyInfo } | { mode: "pair_again" } | { mode: "unsupported" };
  saved: boolean;
  display: boolean;
  takeover: boolean;
  ttlMs: number;
}> {
  const { card, data } = await ownLoginCard(app, accountId, messageId);
  const device = await app.prisma.device.findFirst({ where: { id: data.deviceId, userId: accountId, revokedAt: null } });
  if (!device) throw new LoginCardError(`${data.computer ?? "That computer"} is no longer paired.`, 409);
  const secretRoute = secretRouteFor(device);
  const route = secretRoute.mode === "sealed" ? secretRoute : secretRoute.mode === "pair_again" ? { mode: "pair_again" as const } : { mode: "unsupported" as const };
  return {
    id: card.id,
    status: data.status,
    purpose: data.purpose ?? "sign_in",
    codeHint: data.codeHint ?? null,
    origin: data.origin,
    loginId: data.loginId,
    computer: { id: device.id, name: device.name, online: deviceOnline(device.lastSeenAt) },
    route,
    saved: data.saved === true,
    display: data.display === true,
    takeover: data.takeover === true,
    ttlMs: SEAL_TTL_MS,
  };
}

/** Whether a card can be answered now: waiting for its owner, or stuck working past `WORKING_STALE_MS`. */
function answerable(data: LoginCardData, now = Date.now()): Prisma.NodeMessageWhereInput | null {
  if ((LOGIN_WAITING as readonly string[]).includes(data.status)) return { data: { path: ["status"], equals: data.status } };
  if (data.status === "working" && data.workingId && data.workingAt && now - Date.parse(data.workingAt) > WORKING_STALE_MS) return workingBy(data.workingId);
  return null;
}

const workingBy = (workingId: string): Prisma.NodeMessageWhereInput => ({ AND: [{ data: { path: ["status"], equals: "working" } }, { data: { path: ["workingId"], equals: workingId } }] });

/** The waiting status an answer is to: the card's, or for a card stuck working, the one it worked from. */
function waitingStatus(data: LoginCardData): "pending" | "needs_code" {
  const status = data.status === "working" ? data.workingFrom : data.status;
  return status === "needs_code" ? "needs_code" : "pending";
}

/** The `capabilities.logins` of a computer. */
function loginsLevel(device: { capabilities: unknown }): number {
  const value = (device.capabilities as { logins?: unknown } | null)?.logins;
  return typeof value === "number" ? value : 0;
}

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

function words(status: LoginResolution["status"], computer: string, purpose: "sign_in" | "human_check", message?: string): string {
  const act = purpose === "human_check" ? "Pass the check" : "Sign in";
  if (status === "shown") return `It is open on ${computer}. ${act} there, then press I'm done.`;
  if (status === "waiting") return `${purpose === "human_check" ? "The check is not passed yet" : "Still not signed in"}${message ? `: ${message}` : "."} Finish on ${computer}, then press I'm done.`;
  if (status === "busy") return `${computer} is still working on the last answer.`;
  return message ?? `${computer} could not do that.`;
}

/** How the card says it ended: by which answer. */
const VIA: Record<LoginAnswer["action"], string> = { saved: "saved", typed: "typed", code: "code", check: "chat", local: "computer", done: "computer", decline: "computer" };

export type LoginAnswerOptions = {
  /**
   * False: a node that is told in its own turn (node/login-check.ts) is not woken for a sign-in that
   * ended. A step's or a run's sign-in still wakes what waits for it.
   */
  wake?: boolean;
};

/**
 * Relays the owner's answer to the card's computer and records how it went. The card stays waiting
 * when the computer could not sign in (with why), so the owner can try again or another way; a site
 * that asks for a code turns it to `needs_code` with what it asks (`codeHint`).
 * `origin`: the browser's Origin header, which a typed box must name.
 */
export async function answerLoginCard(app: FastifyInstance, accountId: string, messageId: string, answer: LoginAnswer, origin?: string, options: LoginAnswerOptions = {}): Promise<{ message: NodeMessage; result: LoginResolution }> {
  const prisma = app.prisma;
  const { card, node, data } = await ownLoginCard(app, accountId, messageId);
  const when = answerable(data);
  if (!when) throw new LoginCardError(data.status === "working" ? `${data.computer ?? "The computer"} is still working on the last answer.` : "This sign-in was already answered.", 409);
  const purpose = data.purpose ?? "sign_in";
  const waiting = waitingStatus(data);
  if (answer.action === "code" && waiting !== "needs_code") throw new LoginCardError(`${siteOf(data.origin)} is not asking for a code.`, 409, "no_code");
  if (answer.action === "typed" && purpose === "human_check") throw new LoginCardError("A human check is passed on the page itself. Open it here, or on the computer.", 409, "human_check");
  const device = await prisma.device.findFirst({ where: { id: data.deviceId, userId: accountId, revokedAt: null } });
  const computer = device?.name ?? data.computer ?? "the computer";
  if (answer.action === "decline" && (!device || !deviceOnline(device.lastSeenAt))) {
    // Not now needs no computer: its sign-in ends there by itself.
    const declined = await updateMessageDataIf(prisma, card, when, { status: "declined", error: null, codeHint: null, resolvedAt: new Date().toISOString() });
    if (!declined) throw new LoginCardError("This sign-in was already answered.", 409);
    await afterLogin(app, node, declined, "declined", options);
    return { message: declined, result: { status: "declined" } };
  }
  if (!device) throw new LoginCardError(`${computer} is no longer paired.`, 409);
  if (answer.action === "typed" || answer.action === "code") {
    const route = secretRouteFor(device);
    if (route.mode === "pair_again") throw new LoginCardError(`${computer} now reports a different key from the one it was paired with, so nothing is sent to it. Pair it again, then sign in.`, 409, "pair_again");
    if (route.mode !== "sealed") throw new LoginCardError(`Ensemble on ${computer} cannot open what you type here. Update it there, or sign in on the computer.`, 409, "seal_unsupported");
    checkTypedBox(answer.sealed as Sealed, card, data, route.sealKey, origin);
  }
  if (answer.action === "local" && data.display !== true) throw new LoginCardError(`${computer} has no screen to sign in on. Type it here instead.`, 409, "no_display");
  if (!deviceOnline(device.lastSeenAt)) throw new LoginCardError(`${computer} is offline. Open Ensemble there, then try again.`, 409, "offline");
  const checks = loginsLevel(device) >= LOGIN_CHECKS_API;
  if (answer.action === "code" && !checks) throw new LoginCardError(`Update Ensemble on ${computer} to enter a code from here, or sign in there.`, 409, "update");
  // An older computer checks a sign-in with I'm done.
  const action = answer.action === "check" && !checks ? "done" : answer.action;
  const workingId = randomUUID();
  const current = await updateMessageDataIf(prisma, card, when, { status: "working", workingFrom: waiting, workingId, workingAt: new Date().toISOString(), working: answer.action, error: null });
  if (!current) throw new LoginCardError("This sign-in was already answered.", 409);
  const ours = workingBy(workingId);
  const sealed = answer.action === "typed" || answer.action === "code" ? { sealed: answer.sealed } : {};
  // v 2: the computer may answer needs_code and passed (an older server would hear failed and signed_in).
  const raw = await askDeviceFor(app.redis as never, { deviceId: device.id, event: "login.resolve", data: { loginId: data.loginId, decisionId: card.id, action, ...sealed, ...(checks ? { v: 2 } : {}) } }, ANSWER_MS).catch(() => null);
  const reply = raw ? CodeAnswer.safeParse(raw) : null;
  const parsed = reply?.success && reply.data.status < 400 ? LoginResolution.safeParse(reply.data.body) : null;
  if (!parsed?.success) {
    const reason = raw ? `${computer} sent an answer that could not be read. Update Ensemble there.` : `${computer} did not answer. Check Ensemble is running there and try again.`;
    await updateMessageDataIf(prisma, current, ours, { status: waiting, working: null, error: reason });
    throw new LoginCardError(reason, 502);
  }
  const result = parsed.data;
  const now = new Date().toISOString();
  const patch: Record<string, unknown> =
    result.status === "signed_in" || result.status === "passed"
      ? { status: result.status, working: null, error: null, codeHint: null, note: result.message ?? null, via: VIA[answer.action], resolvedAt: now, ...(result.savedNow ? { savedNow: true } : {}) }
      : result.status === "declined" || result.status === "expired"
        ? { status: result.status, working: null, error: null, codeHint: null, resolvedAt: now }
        : result.status === "gone"
          ? { status: "ended", working: null, error: null, codeHint: null, note: "The work that needed this sign-in ended, or its tab closed.", resolvedAt: now }
          : result.status === "needs_code"
            ? { status: "needs_code", working: null, error: null, note: null, codeHint: result.message ?? "Enter the code the site asks for." }
            : result.status === "shown"
              ? { status: waiting, working: null, error: null, note: words("shown", computer, purpose), shownAt: now }
              : { status: waiting, working: null, error: words(result.status, computer, purpose, result.message) };
  const updated = await updateMessageDataIf(prisma, current, ours, patch);
  if (!updated) throw new LoginCardError("This sign-in was already answered.", 409);
  await appendLedger({ userId: accountId, actor: "me", action: "node.login_answered", payload: { nodeId: node.id, deviceId: device.id, origin: data.origin, purpose, action: answer.action, status: result.status } });
  if (result.status === "signed_in" || result.status === "passed" || result.status === "declined" || result.status === "expired") await afterLogin(app, node, updated, result.status, options);
  return { message: updated, result };
}

/** What the node hears when its tab's sign-in ended: signed in (or the check passed), or not. */
export function loginOutcomeNote(data: Pick<LoginCardData, "origin" | "computer" | "tab" | "purpose">, status: "signed_in" | "passed" | "declined" | "expired"): string {
  const where = `${data.origin} on ${data.computer ?? "the computer"}`;
  if (status === "passed") return `Your owner passed the human check on ${where}. Tab ${data.tab} is yours again: take a new snapshot and carry on with the work that needed it.`;
  if (status === "signed_in") return `Your owner signed in to ${where} (you never see how). Tab ${data.tab} is yours again: take a new snapshot and carry on with the work that needed it.`;
  const check = data.purpose === "human_check";
  const what = check ? "pass the human check" : "sign in";
  const at = `${check ? "pass the human check on" : "sign in to"} ${where}`;
  return `Your owner ${status === "declined" ? `chose not to ${at}` : `did not ${at} in time`}. Do not try to ${what} yourself. Finish your step without it, or call node_step_blocked with why (it needs ${check ? "a human check passed on" : "a sign-in to"} ${data.origin}).`;
}

/** The node hears how its tab's sign-in ended; a run's agent hears it in its own tool call instead. */
async function afterLogin(app: FastifyInstance, node: NodeAgent, card: NodeMessage, status: "signed_in" | "passed" | "declined" | "expired", options: LoginAnswerOptions = {}): Promise<void> {
  const data = card.data as LoginCardData;
  if (data.jobId) return;
  const link = planLinkOf(card.data);
  // A conversation's own turn already heard it (node/login-check.ts); a step still waits to be woken.
  if (options.wake === false && !link) return;
  const queued = await enqueueTurn(app, { nodeId: node.id, roomId: card.roomId, reason: "approval", note: loginOutcomeNote(data, status), private: data.private === true, ...(link ?? {}) });
  if (!queued && status !== "signed_in" && status !== "passed" && link?.planStep) await finishStep(app, link.planId, link.planStep, { status: "blocked", result: `It needs a sign-in to ${data.origin}, and your owner did not sign in (login_required).` });
}

/** How the card says a sign-in the computer saw end by itself ended (`via`). */
const SEEN_VIA: Record<NonNullable<LoginStatePost["via"]>, string> = { computer: "computer", window: "window", takeover: "takeover", check: "check" };

/**
 * A sign-in that changed on its computer by itself (logins 2, `ROUTES.loginState`): seen done in the
 * node's tab, the window on the computer or the owner's remote view; its work gone; its time out; or a
 * problem to show while it waits. Only a waiting card follows (an answer in flight settles its own), and
 * only the computer that has the sign-in can move it. Its node is woken as for an answer, except after
 * its own `browser_login_check` (`via: check`), whose result already told it.
 */
export async function loginStateFromComputer(app: FastifyInstance, device: { id: string; userId: string }, loginId: string, state: LoginStatePost): Promise<NodeMessage | null> {
  const prisma = app.prisma;
  const card = await prisma.nodeMessage.findFirst({
    where: { userId: device.userId, kind: "approval", AND: [{ data: { path: ["type"], equals: LOGIN_CARD } }, { data: { path: ["loginId"], equals: loginId } }, { data: { path: ["deviceId"], equals: device.id } }] },
    orderBy: { createdAt: "desc" },
  });
  const parsed = card ? LoginCard.safeParse(card.data) : null;
  if (!card || !parsed?.success) return null;
  const data = parsed.data;
  if (!(LOGIN_WAITING as readonly string[]).includes(data.status)) return card;
  const node = card.authorNodeId ? await prisma.nodeAgent.findUnique({ where: { id: card.authorNodeId } }) : null;
  const waiting: Prisma.NodeMessageWhereInput = { data: { path: ["status"], equals: data.status } };
  const purpose = data.purpose ?? "sign_in";
  const now = new Date().toISOString();
  if (state.status === "waiting") return (await updateMessageDataIf(prisma, card, waiting, { error: state.message ?? null })) ?? card;
  const status = state.status === "signed_in" || state.status === "passed" ? (purpose === "human_check" ? "passed" : state.status) : state.status;
  const patch: Record<string, unknown> =
    status === "signed_in" || status === "passed"
      ? { status, working: null, error: null, codeHint: null, note: state.message ?? null, via: SEEN_VIA[state.via ?? "computer"], resolvedAt: now }
      : status === "ended"
        ? { status: "ended", working: null, error: null, codeHint: null, note: state.message ?? "The work that needed this sign-in ended, or its tab closed.", resolvedAt: now }
        : { status, working: null, error: null, codeHint: null, resolvedAt: now };
  const updated = await updateMessageDataIf(prisma, card, waiting, patch);
  if (!updated) return card;
  await appendLedger({ userId: device.userId, actor: "agent", action: "node.login_answered", payload: { nodeId: node?.id ?? null, deviceId: device.id, origin: data.origin, purpose, action: "seen", via: state.via ?? "computer", status } });
  if (node && state.via !== "check" && (status === "signed_in" || status === "passed" || status === "declined" || status === "expired")) await afterLogin(app, node, updated, status);
  return updated;
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
 * in (or the human check passed), the card says so and its node goes on; not yet, the card stays open
 * with why.
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
  if (!(LOGIN_WAITING as readonly string[]).includes(data.status)) return null;
  const purpose = data.purpose ?? "sign_in";
  const waiting: Prisma.NodeMessageWhereInput = { data: { path: ["status"], equals: data.status } };
  if (!signedIn) return updateMessageDataIf(app.prisma, card, waiting, { error: `${purpose === "human_check" ? "The check is not passed yet" : "Still not signed in"}${message ? `: ${message}` : "."} Open the browser again, or answer another way.` });
  const status = purpose === "human_check" ? "passed" : "signed_in";
  const updated = await updateMessageDataIf(app.prisma, card, waiting, { status, working: null, error: null, note: null, codeHint: null, via: "takeover", resolvedAt: new Date().toISOString() });
  if (!updated) return null;
  await appendLedger({ userId: accountId, actor: "me", action: "node.login_answered", payload: { nodeId: node.id, deviceId: data.deviceId, origin: data.origin, purpose, action: "takeover", status } });
  await afterLogin(app, node, updated, status);
  return updated;
}
