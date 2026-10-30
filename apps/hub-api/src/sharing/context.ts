/**
 * Who is acting, in which space, with what access, for the life of one request.
 *
 * Set by an onRequest hook right after identity (app.ts) with AsyncLocalStorage.run, the
 * same technique @fastify/request-context uses, so deep code (model calls, metrics, undo,
 * the ledger, SSE audiences) can tell the space owner from a person the space is shared with
 * without threading another parameter through every call.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const SHARE_KINDS = ["page", "task", "board", "diagram", "plot_space", "plot", "meeting", "skill", "workspace", "code"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

/**
 * What anyone with a link may open, with no account. A whole space never; nor anything that
 * runs on someone's computer, holds code, or reaches connected apps.
 */
export const PUBLIC_KINDS = ["page", "task", "diagram", "meeting"] as const;
export type PublicKind = (typeof PUBLIC_KINDS)[number];
/** Public kinds that are only ever view-only by link. */
export const PUBLIC_VIEW_ONLY: ReadonlySet<PublicKind> = new Set(["meeting"]);

/** Who is on a public link: a signed-in person, or an anonymous visitor named by `sharing/visitors.ts`. */
export type LinkVisitor = { id: string; name: string; emoji: string | null; color: string; signedIn: boolean };

/**
 * `node` is set when an Ensemble Node acts for the account (lib/auth.ts, node/spaces.ts): the same
 * access the account has, attributed to that node.
 */
export type Access =
  | { kind: "owner"; node?: string }
  | { kind: "member"; role: "viewer" | "editor"; ownerId: string; node?: string }
  | { kind: "share"; shareId: string; resource: ShareKind; resourceId: string; role: "view" | "edit"; ownerId: string }
  /** Anyone with a public link, signed in or not. */
  | { kind: "link"; linkId: string; resource: PublicKind; resourceId: string; role: "view" | "edit"; ownerId: string; visitor: LinkVisitor }
  /** A share header that names nothing this account can open. Every route answers 404. */
  | { kind: "gone" };

/** Account ids of anonymous link visitors start with this; they are never a `users` row. */
export const VISITOR_PREFIX = "visitor:";

export function isVisitor(accountId: string | null | undefined): boolean {
  return Boolean(accountId?.startsWith(VISITOR_PREFIX));
}

export type RequestScope = { spaceId: string; accountId: string; access: Access };

const store = new AsyncLocalStorage<RequestScope>();

export function runInScope<T>(scope: RequestScope, work: () => T): T {
  return store.run(scope, work);
}

export function currentScope(): RequestScope | undefined {
  return store.getStore();
}

/** True when the request is someone other than the owner acting in this space. */
export function isGuestIn(spaceId: string): boolean {
  const scope = store.getStore();
  return Boolean(scope && scope.spaceId === spaceId && scope.access.kind !== "owner");
}

/**
 * The account whose model keys, usage and activity a call belongs to. Inside a space someone
 * shared with you, that is you, not the owner: you never spend or see the owner's keys.
 */
export function keysFor(userId: string): string {
  const scope = store.getStore();
  return scope && scope.spaceId === userId && scope.access.kind !== "owner" ? scope.accountId : userId;
}

/** Stamped on undo entries, comments and conversations made by a guest. Null for the owner. */
export function actorFor(spaceId: string): string | null {
  return isGuestIn(spaceId) ? store.getStore()!.accountId : null;
}

/** The Ensemble Node acting for the account in this space, if a node made this request. */
export function nodeActingIn(spaceId: string): string | null {
  const scope = store.getStore();
  if (!scope || scope.spaceId !== spaceId) return null;
  const access = scope.access;
  return (access.kind === "owner" || access.kind === "member") && access.node ? access.node : null;
}

/**
 * Who made something in a space, for "@node for person": the person (null for the space's owner acting
 * themselves, as `actorFor`) and the node acting for them, if one did.
 */
export function madeBy(spaceId: string): { accountId: string | null; nodeId: string | null } {
  const node = nodeActingIn(spaceId);
  return { accountId: node ? store.getStore()!.accountId : actorFor(spaceId), nodeId: node };
}

/**
 * Communications synced from the owner's connected apps: their inbox, chats and calendar.
 * Never shown to anyone a space is shared with. Work artifacts (files, pull requests, issues,
 * commits, transcripts, meeting notes) are the space's context and stay visible.
 */
export const PRIVATE_ARTIFACT_KINDS = ["email", "chat_msg", "channel_msg", "event"] as const;

/** A Prisma `where` fragment for artifacts the current person may see in `spaceId`. */
export function visibleArtifacts(spaceId: string): { kind?: { notIn: Array<(typeof PRIVATE_ARTIFACT_KINDS)[number]> } } {
  return isGuestIn(spaceId) ? { kind: { notIn: [...PRIVATE_ARTIFACT_KINDS] } } : {};
}
