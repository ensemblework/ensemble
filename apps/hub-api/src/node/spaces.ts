/**
 * Ensemble Node in every space its owner can open (docs/35 §5.1): their own spaces and the spaces
 * shared with them as a member. The assistant stays in one space per conversation; a node turn gets
 * a gateway instead. Every Hub tool takes an optional `space` (an id or an exact name), and each call
 * runs with a delegated identity: the owner, acting through this node, with the access they have in
 * that space right now (lib/auth.ts). It is the scope a member's own request gets, so the route
 * policy, `guestMayUse`, owner-only tools, viewer limits and the private-apps rule apply unchanged.
 * Access is read again on every call and on every Apply.
 *
 * Integration (node/brain.ts, the `runAssistantTurn` call):
 *   spaces: nodeSpaceGateway(app, node, { homeSpaceId: turn.spaceId, reach: ownerOnly ? "all" : "home" }),
 */
import type { FastifyInstance } from "fastify";
import type { NodeAgent, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Settings } from "@ensemble/shared-types";
import { nodeRequestHeaders, openedSpace, type OpenedSpace } from "../lib/auth.js";
import { loadSettings } from "../lib/settings.js";
import { runInScope, type RequestScope } from "../sharing/context.js";
import { defaultSpaceName } from "../spaces/store.js";
import { guestMayUse, writeRefusal } from "../assistant/apps.js";
import { chatToolSpecs, toolAllowedFor, toolModule } from "../assistant/registry.js";
import { readablePreview } from "../assistant/refs.js";
import { ToolBlockedError, type AnyHubTool, type CallSpace, type SpaceGateway, type ToolContext } from "../assistant/types.js";

export type SpaceRole = "owner" | "editor" | "viewer";

/** A space the node's owner can open now. */
export type NodeSpace = {
  id: string;
  name: string;
  role: SpaceRole;
  /** The account that owns it: the node's owner, or the person who shared it with them. */
  ownerId: string;
  /** That person's name, for a space shared with the owner. */
  ownerName: string | null;
  /** The owner's account itself, their first space. */
  primary: boolean;
  modules: string | null;
  access: OpenedSpace["access"];
};

export type NodeSpaceOptions = {
  /**
   * The space calls act in when they name none: the room's bound space or the turn's own space
   * (`NodeTurn.spaceId`). When the owner cannot open it: `NodeAgent.spaceId`, then their account.
   */
  homeSpaceId?: string | null;
  /**
   * `home`: only the home space is reachable, for a turn whose answer other people read or that
   * someone else started (docs/35 §5.1, audience limits). Default `all`.
   */
  reach?: "all" | "home";
};

type Db = Pick<PrismaClient, "user" | "spaceMember">;

/** Names compare as the space switcher compares them: Unicode NFKC, spaces collapsed, any case. */
export const spaceNameKey = (name: string): string => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

function spaceName(row: { name: string; spaceName: string | null; ownerId: string | null }): string {
  return row.ownerId ? row.spaceName || "Untitled space" : row.spaceName || defaultSpaceName(row.name);
}

function personName(row: { name: string; email: string } | null | undefined): string | null {
  if (!row) return null;
  const name = row.name.trim();
  return name && !name.includes("@") ? name : (row.email.split("@")[0] ?? null);
}

const firstName = (name: string | null): string | null => name?.split(/\s+/)[0] || null;

/** One space by id, if `accountId` can open it now (read from the database every time). */
export async function nodeSpace(db: Db, accountId: string, spaceId: string): Promise<NodeSpace | null> {
  const opened = await openedSpace(accountId, spaceId);
  if (!opened) return null;
  const row = await db.user.findUnique({ where: { id: opened.id }, select: { name: true, spaceName: true, ownerId: true } });
  if (!row) return null;
  const member = opened.access.kind === "member" ? opened.access : null;
  const owner = member ? await db.user.findUnique({ where: { id: member.ownerId }, select: { name: true, email: true } }) : null;
  return {
    id: opened.id,
    name: spaceName(row),
    role: member ? member.role : "owner",
    ownerId: member ? member.ownerId : accountId,
    ownerName: personName(owner),
    primary: opened.id === accountId,
    modules: opened.moduleSet,
    access: opened.access,
  };
}

/** Every space `accountId` can open now: its own (the account first, then switcher order), then those shared with it. */
export async function nodeSpaces(db: Db, accountId: string): Promise<NodeSpace[]> {
  const select = { id: true, name: true, spaceName: true, ownerId: true, moduleSet: true } as const;
  const [account, owned, memberships] = await Promise.all([
    db.user.findUnique({ where: { id: accountId }, select }),
    db.user.findMany({ where: { ownerId: accountId }, orderBy: [{ spacePosition: "asc" }, { createdAt: "asc" }], select }),
    db.spaceMember.findMany({ where: { accountId }, orderBy: { createdAt: "asc" }, select: { role: true, space: { select } } }),
  ]);
  if (!account || account.ownerId) return [];
  const ownerIds = [...new Set(memberships.map((row) => row.space.ownerId ?? row.space.id))];
  const owners = new Map((await db.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, email: true } })).map((row) => [row.id, personName(row)]));
  const own = (row: NonNullable<typeof account>, primary: boolean): NodeSpace => ({
    id: row.id,
    name: spaceName(row),
    role: "owner",
    ownerId: accountId,
    ownerName: null,
    primary,
    modules: row.moduleSet,
    access: { kind: "owner" },
  });
  return [
    own(account, true),
    ...owned.map((row) => own(row, false)),
    ...memberships.map((row): NodeSpace => {
      const ownerId = row.space.ownerId ?? row.space.id;
      const role = row.role === "viewer" ? "viewer" : "editor";
      return { id: row.space.id, name: spaceName(row.space), role, ownerId, ownerName: owners.get(ownerId) ?? null, primary: false, modules: row.space.moduleSet, access: { kind: "member", role, ownerId } };
    }),
  ];
}

/** The home space: the one asked for, then the node's own, then the owner's account; the first the owner can still open. */
async function chooseHome(node: Pick<NodeAgent, "userId" | "spaceId">, wanted: string | null | undefined): Promise<string> {
  for (const id of [wanted, node.spaceId]) {
    if (id && (await openedSpace(node.userId, id))) return id;
  }
  return node.userId;
}

const SPACE_TEXT = "The space to act in: its id or exact name. Default: the home space.";

/** The `space` a call names: undefined for none. */
function spaceArg(value: unknown): string | undefined {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).space : undefined;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function withoutSpace(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { space: _space, ...rest } = value as Record<string, unknown>;
  return rest;
}

type SpaceSchema = { input: z.ZodTypeAny; jsonSchema: Record<string, unknown> };
const schemas = new WeakMap<AnyHubTool, SpaceSchema>();

/** The tool's own input plus an optional `space`: as JSON Schema for the model, and as Zod for parsing. */
function spaceSchema(tool: AnyHubTool): SpaceSchema {
  const known = schemas.get(tool);
  if (known) return known;
  const spec = chatToolSpecs([tool])[0]!.function as { parameters: Record<string, unknown> };
  const jsonSchema = structuredClone(spec.parameters) as Record<string, unknown> & { properties?: Record<string, unknown> };
  jsonSchema.properties = { ...(jsonSchema.properties ?? {}), space: { type: "string", description: SPACE_TEXT } };
  const input = z.unknown().transform((raw, issues) => {
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const space = record?.space;
    if (space !== undefined && space !== null && (typeof space !== "string" || space.length > 200)) {
      issues.addIssue({ code: z.ZodIssueCode.custom, path: ["space"], message: "Give a space's id or its exact name." });
      return z.NEVER;
    }
    const parsed = tool.input.safeParse(record ? withoutSpace(record) : raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) issues.addIssue(issue as z.IssueData);
      return z.NEVER;
    }
    const named = typeof space === "string" && space.trim() ? space.trim() : undefined;
    return named === undefined ? parsed.data : { ...(parsed.data as Record<string, unknown>), space: named };
  });
  const made = { input, jsonSchema };
  schemas.set(tool, made);
  return made;
}

/** Display text for a call outside the home space says where it acted. */
const inSpace = (space: CallSpace, text: string): string => (space.home ? text : `In “${space.name}”: ${text}`);

class NodeSpaces implements SpaceGateway {
  private homeId: Promise<string> | null = null;

  constructor(
    private readonly db: PrismaClient,
    private readonly node: Pick<NodeAgent, "id" | "userId" | "spaceId">,
    private readonly options: NodeSpaceOptions,
  ) {}

  private home(): Promise<string> {
    this.homeId ??= chooseHome(this.node, this.options.homeSpaceId);
    return this.homeId;
  }

  wrap(tools: readonly AnyHubTool[]): AnyHubTool[] {
    // Connected-app tools act in the apps of the space they were offered from; they take no `space`.
    return tools.map((tool) => (tool.area === "apps" || tool.spaceFor ? tool : this.wrapTool(tool)));
  }

  async instructions(): Promise<string> {
    const [homeId, owner, all] = await Promise.all([
      this.home(),
      this.db.user.findUnique({ where: { id: this.node.userId }, select: { name: true, email: true } }),
      nodeSpaces(this.db, this.node.userId),
    ]);
    const first = firstName(personName(owner)) ?? "your owner";
    const home = all.find((row) => row.id === homeId);
    if (!home) return `Spaces: ${first} can no longer open the space this conversation works in, so Ensemble's tools cannot be used here.`;
    if (this.options.reach === "home") {
      return `Spaces: only “${home.name}” is reachable in this conversation, because other people read it or asked in it. Ensemble's tools act there.`;
    }
    const role = (row: NodeSpace) =>
      row.role === "owner" ? `${first}'s own` : `${row.ownerName ?? "someone"}'s, shared with ${first}: ${row.role === "viewer" ? "view only" : "can edit"}`;
    return [
      `Spaces: you act for ${first} in every Ensemble space ${first} can open. Ensemble's tools (not connected-app tools) take an optional space: a space's id or exact name. Without it a call acts in “${home.name}”.`,
      ...all.map((row) => `- “${row.name}” [${row.id}]: ${role(row)}${row.id === homeId ? " (the default)" : ""}`),
      `In a space shared with ${first} only its work is reachable, never that person's connected apps, reminders, imports, layouts or settings; where it is view only, change nothing. Each result says which space it came from. Say where when you report work outside “${home.name}”.`,
    ].join("\n");
  }

  async reachable(): Promise<ReadonlySet<string>> {
    const homeId = await this.home();
    if (this.options.reach === "home") return new Set((await openedSpace(this.node.userId, homeId)) ? [homeId] : []);
    return new Set((await nodeSpaces(this.db, this.node.userId)).map((row) => row.id));
  }

  /** The space a call names (none: home), if the owner can open it now and this conversation may reach it. */
  private async find(wanted: string | undefined): Promise<NodeSpace> {
    const owner = this.node.userId;
    const homeId = await this.home();
    if (!wanted || wanted === homeId || this.options.reach === "home") {
      const home = await nodeSpace(this.db, owner, homeId);
      if (!home) throw new ToolBlockedError("Your owner can no longer open the space this conversation works in.");
      if (!wanted || wanted === home.id || spaceNameKey(wanted) === spaceNameKey(home.name)) return home;
      throw new ToolBlockedError(`Only “${home.name}” is reachable here: other people read this conversation or asked in it.`, "Your owner can ask in a chat with just you.");
    }
    const byId = await nodeSpace(this.db, owner, wanted);
    if (byId) return byId;
    const all = await nodeSpaces(this.db, owner);
    const named = all.filter((row) => spaceNameKey(row.name) === spaceNameKey(wanted));
    if (named.length === 1) return named[0]!;
    if (named.length > 1) {
      throw new ToolBlockedError(`More than one space is called “${wanted}”.`, `Name it by id: ${named.map((row) => `${row.id} (${row.role === "owner" ? "your owner's" : `${row.ownerName ?? "someone"}'s`})`).join(", ")}.`);
    }
    throw new ToolBlockedError(`Your owner cannot open a space “${wanted}”.`, `The spaces they can open: ${all.map((row) => `“${row.name}”`).join(", ")}.`);
  }

  /** Resolves a call's space and checks, now, what the owner may do there with this tool. */
  async resolve(tool: AnyHubTool, wanted: string | undefined): Promise<CallSpace> {
    const space = await this.find(wanted);
    const homeId = await this.home();
    const scope: RequestScope = { spaceId: space.id, accountId: this.node.userId, access: { ...space.access, node: this.node.id } };
    const run = <T>(work: () => Promise<T>): Promise<T> => runInScope(scope, work);
    const module = toolModule(tool);
    if (!toolAllowedFor(tool, space.modules)) throw new ToolBlockedError(`“${space.name}” does not have ${module ?? "that feature"} turned on.`);
    // The same rules as a member's own assistant there (assistant/apps.ts), read inside that space's scope.
    if (!(await run(async () => guestMayUse(tool, space.id)))) {
      const owner = firstName(space.ownerName) ?? "its owner";
      if (tool.isWrite && space.role === "viewer") throw new ToolBlockedError(`Your owner can only view “${space.name}”, so nothing there can be changed.`, `${owner} can give them edit access.`);
      throw new ToolBlockedError(`That stays private to ${owner} in “${space.name}”: connected apps, reminders, imports, layouts and syncs are the space owner's alone.`);
    }
    let settings: Settings | undefined;
    if (tool.isWrite) {
      // Their own settings there decide which writes are on and which wait (lib/settings.ts: a member's are their own).
      settings = await run(() => loadSettings(this.db, space.id));
      const refusal = writeRefusal(tool, settings);
      if (refusal) throw new ToolBlockedError(`In “${space.name}”: ${refusal}`);
    }
    const headers = nodeRequestHeaders({ accountId: this.node.userId, spaceId: space.id, nodeId: this.node.id });
    const call: CallSpace = {
      id: space.id,
      name: space.name,
      home: space.id === homeId,
      ...(settings ? { settings } : {}),
      context: (base: ToolContext): ToolContext => ({ ...base, userId: space.id, modules: space.modules, requestHeaders: headers, space: call }),
      run,
    };
    return call;
  }

  /** The space a call acts in: the one already resolved for it, else resolved and checked now. */
  private target(tool: AnyHubTool, ctx: ToolContext, value: unknown): Promise<CallSpace> {
    const wanted = spaceArg(value);
    const known = ctx.space;
    if (known && (wanted === undefined ? known.home : wanted === known.id || spaceNameKey(wanted) === spaceNameKey(known.name))) return Promise.resolve(known);
    return this.resolve(tool, wanted);
  }

  private wrapTool(tool: AnyHubTool): AnyHubTool {
    const { input, jsonSchema } = spaceSchema(tool);
    return {
      ...tool,
      input,
      jsonSchema,
      spaceFor: (ctx, value) => this.target(tool, ctx, value),
      // The call's receipt records the space it resolved to, by id.
      prepare: async (ctx, value) => {
        const space = await this.target(tool, ctx, value);
        const rest = withoutSpace(value);
        const prepared = tool.prepare ? await space.run(() => tool.prepare!(space.context(ctx), rest)) : rest;
        return { ...(prepared as Record<string, unknown>), space: space.id };
      },
      preview: async (ctx, value) => {
        const space = await this.target(tool, ctx, value);
        const rest = withoutSpace(value);
        const text = tool.preview ? await space.run(async () => tool.preview!(space.context(ctx), rest)) : readablePreview(tool.name, rest, ctx.refs ?? new Map());
        return inSpace(space, text);
      },
      run: async (ctx, value) => {
        const space = await this.target(tool, ctx, value);
        const result = await space.run(() => tool.run(space.context(ctx), withoutSpace(value)));
        return { ...result, summary: inSpace(space, result.summary) };
      },
    };
  }
}

/**
 * What node/brain.ts passes into runAssistantTurn as `spaces`: the node acts for its owner in every
 * space they can open, each call checked again with the owner's current access there.
 */
export function nodeSpaceGateway(app: FastifyInstance, node: Pick<NodeAgent, "id" | "userId" | "spaceId">, options: NodeSpaceOptions = {}): SpaceGateway {
  return new NodeSpaces(app.prisma, node, options);
}

/**
 * The gateway for a node's own conversation, so Apply checks each held call's space again with the
 * owner's access at that moment. Null for any other conversation: the assistant's stay in one space.
 */
export async function conversationSpaces(app: FastifyInstance, conversationId: string): Promise<SpaceGateway | null> {
  const member = await app.prisma.nodeRoomMember.findFirst({
    where: { nodeId: { not: null }, OR: [{ conversationId }, { privateConversationId: conversationId }] },
    select: { nodeId: true },
  });
  const node = member?.nodeId ? await app.prisma.nodeAgent.findUnique({ where: { id: member.nodeId }, select: { id: true, userId: true, spaceId: true } }) : null;
  return node ? nodeSpaceGateway(app, node) : null;
}
