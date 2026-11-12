/**
 * Spaces for a Context Bridge key (docs/CONTEXT_BRIDGE.md §4): the key works in the space it was made
 * in, and in every other space its account owns when the request names one (`x-ensemble-space`,
 * resolved in lib/auth.ts). Spaces shared with the account are listed but refused: the bridge's reads
 * and actions act as a space's owner, which a member is not.
 */
import type { FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { nodeSpaces } from "../node/spaces.js";
import { spaceLabel } from "../spaces/store.js";

type Asker = Pick<FastifyRequest, "userId" | "authVia" | "tokenScope" | "tokenSpaceId" | "tokenAccountId">;

export const SHARED_SPACE_REFUSAL = "Shared with you: keys act only in your own spaces, so work there in Ensemble.";

/** The space a key was made in (its default); for anyone else, the space the request is in. */
export function defaultSpaceOf(request: Asker): string {
  return request.tokenSpaceId ?? request.userId;
}

/** The account whose own spaces this caller may name with `x-ensemble-space`, or null. */
export function crossSpaceAccount(request: Asker): string | null {
  if (request.authVia !== "token" || (request.tokenScope !== "bridge" && request.tokenScope !== "full")) return null;
  return request.tokenAccountId ?? null;
}

export async function spaceName(db: Pick<PrismaClient, "user">, id: string): Promise<string | undefined> {
  const row = await db.user.findUnique({ where: { id }, select: { name: true, spaceName: true, ownerId: true } });
  return row ? spaceLabel(row) : undefined;
}

/** Why a key cannot name another space, or null when it can. */
export async function crossSpaceRefusal(db: Pick<PrismaClient, "user">, request: Asker): Promise<string | null> {
  if (crossSpaceAccount(request)) return null;
  if (request.authVia !== "token") return "Only an Ensemble key names a space; a signed-in page uses the space switcher.";
  return `This key works only in “${(await spaceName(db, defaultSpaceOf(request))) ?? "its space"}”: make a new key in Ensemble to reach your other spaces.`;
}

export interface BridgeSpace {
  id: string;
  name: string;
  /** `own`: the account's own space; `member`: shared with it by someone else. */
  access: "own" | "member";
  role: "owner" | "editor" | "viewer";
  /** Who shared it, for a member's space. */
  owner?: string | null;
  /** The account's first space. */
  primary: boolean;
  /** The key's default: the space it was made in. */
  default: boolean;
  /** The space this request is in. */
  current: boolean;
  /** Whether this key may act there; when not, why. */
  usable: boolean;
  refusal?: string;
}

/** The spaces the key's account can open, each with whether the key may act there. */
export async function bridgeSpaces(db: Pick<PrismaClient, "user" | "spaceMember">, request: Asker): Promise<{ crossSpace: boolean; spaces: BridgeSpace[]; note: string }> {
  const account = crossSpaceAccount(request);
  const home = defaultSpaceOf(request);
  if (!account) {
    return {
      crossSpace: false,
      spaces: [{ id: home, name: (await spaceName(db, home)) ?? "This space", access: "own", role: "owner", primary: false, default: true, current: request.userId === home, usable: true }],
      note: (await crossSpaceRefusal(db, request)) ?? "",
    };
  }
  const spaces = (await nodeSpaces(db, account)).map((space): BridgeSpace => {
    const own = space.role === "owner";
    return {
      id: space.id,
      name: space.name,
      access: own ? "own" : "member",
      role: space.role,
      ...(own ? {} : { owner: space.ownerName }),
      primary: space.primary,
      default: space.id === home,
      current: space.id === request.userId,
      usable: own,
      ...(own ? {} : { refusal: SHARED_SPACE_REFUSAL }),
    };
  });
  return {
    crossSpace: true,
    spaces,
    note: "Pass space (a space's id or exact name) to any Ensemble tool to read or change that space; without it a call acts in the key's default space.",
  };
}
