import { z } from "zod";
import type { ContentPart } from "../files/model-input.js";
import type { AssistantPageContext, AssistantRef, AssistantToolArea, CodeEngine, Settings } from "@ensemble/shared-types";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

export type ToolRisk = "low" | "medium" | "high";

/** Ensemble Code in the person's terminal: where it was opened and how it starts agent runs. */
export interface CodeSession {
  /** The folder `ensemble` was opened in (absolute). */
  folder: string;
  /** Who does the coding work. Default: the run profile's engine. */
  engine?: "ensemble" | CodeEngine;
  /** A run profile id or name. Default: the person's default profile, else Quick. */
  profileId?: string | null;
  /** The run's model (`provider::model` for Ensemble's agent, the engine's own name otherwise). */
  runModel?: string | null;
  outsideAccess?: "none" | "read" | "read-write";
}

export interface ToolContext {
  app: FastifyInstance;
  prisma: PrismaClient;
  /** Set when several tool writes must share one undo entry. */
  tx?: Prisma.TransactionClient;
  userId: string;
  /** "agent", not "me": the audit trail and undo tooltip both need to say who changed the row. */
  actor: "agent";
  conversationId?: string;
  page?: AssistantPageContext;
  settings: Settings;
  /** Optional modules that are on. Absent only for older callers; a string is enforced. */
  modules?: string | null;
  /** Project names proposed earlier in this tool batch. Resolved for real on Apply, in order. */
  pendingProjectNames?: readonly string[];
  /** Set only for Ensemble Code turns on the person's own computer. */
  code?: CodeSession;
  /** Original request credentials, used only inside the API; never sent to a model. */
  requestHeaders?: Record<string, string>;
  toolCallId?: string;
  /** The space this call acts in, already resolved and checked for it (Ensemble Node, node/spaces.ts). */
  space?: CallSpace;
  /** Records the turn knows by id, so a preview can name them by title. */
  refs?: ReadonlyMap<string, AssistantRef>;
}

/**
 * The space one tool call acts in when a turn reaches more than one (Ensemble Node acting for its
 * owner, node/spaces.ts). Resolved and access-checked for that call; never cached across calls.
 */
export interface CallSpace {
  id: string;
  name: string;
  /** Calls that name no space act here. */
  home: boolean;
  /** The acting person's settings there: their write areas and write policy. Set for write tools. */
  settings?: Settings;
  /** The context for a call there: the space as `userId`, its modules, request credentials for it. */
  context(base: ToolContext): ToolContext;
  /** Runs work with that space's request scope (sharing/context.ts): who acts, for whom, with what access. */
  run<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * Lets one assistant turn act in more than one space: Ensemble Node acting for its owner in every
 * space they can open (node/spaces.ts). The assistant itself never has one: it stays in one space
 * per conversation.
 */
export interface SpaceGateway {
  /** The turn's Hub tools, each taking an optional `space`. Connected-app tools are left as they are. */
  wrap(tools: readonly AnyHubTool[]): AnyHubTool[];
  /** The instructions' paragraph about spaces: which are reachable and how to name one. */
  instructions(): Promise<string>;
  /** Spaces reachable now. Earlier answers that used any other space drop out of the history. */
  reachable(): Promise<ReadonlySet<string>>;
}

export interface ToolResult {
  summary: string;
  data?: unknown;
  /** Pictures and files for the model, shown after this step's tool results (files/model-input.ts). */
  pictures?: ContentPart[];
  href?: string;
  undoEntryId?: string;
  invalidate?: string[];
}

/** Set on tools that act in a connected app. Gating reads it; tools without it are Hub tools. */
export interface AppToolMeta {
  provider: "google" | "microsoft" | "zoom" | "docusign" | "atlassian";
  /** Connector store suite, e.g. google_workspace. */
  suite: string;
  /** Products (settings.connectorProducts) that offer this tool. Any one switched on is enough. */
  products: readonly string[];
  /** Each entry lists alternatives; one scope from every entry must be granted. */
  scopes: ReadonlyArray<readonly string[]>;
  /** What the person calls it: "Google Calendar". */
  label: string;
}

export interface AnyHubTool {
  name: string;
  area: AssistantToolArea;
  description: string;
  input: z.ZodTypeAny;
  isWrite: boolean;
  risk: ToolRisk;
  undoable?: boolean;
  app?: AppToolMeta;
  /** Function parameters to send as-is (e.g. a remote MCP server's own schema) instead of converting `input`. */
  jsonSchema?: Record<string, unknown>;
  /** On Apply, runs on its own rather than in the batch's transaction (it starts work that writes elsewhere). */
  outsideTransaction?: boolean;
  /** Waits for Apply even when the person lets the assistant write without asking (settings changes). */
  alwaysHold?: boolean;
  /** Turns a filter into the exact records before preview, so Apply changes only what the person was shown. */
  prepare?: (ctx: ToolContext, input: unknown) => Promise<unknown>;
  preview?: (ctx: ToolContext, input: unknown) => Promise<string> | string;
  run: (ctx: ToolContext, input: unknown) => Promise<ToolResult>;
  /**
   * Set on tools that take a `space` (node/spaces.ts): resolves the space this call acts in and
   * checks, now, that the acting person may use this tool there. Throws ToolBlockedError otherwise.
   */
  spaceFor?: (ctx: ToolContext, input: unknown) => Promise<CallSpace>;
}

export function defineTool<I extends z.ZodTypeAny>(tool: {
  name: string;
  area: AssistantToolArea;
  description: string;
  input: I;
  isWrite: boolean;
  risk: ToolRisk;
  undoable?: boolean;
  app?: AppToolMeta;
  outsideTransaction?: boolean;
  alwaysHold?: boolean;
  prepare?: (ctx: ToolContext, input: z.infer<I>) => Promise<z.infer<I>>;
  preview?: (ctx: ToolContext, input: z.infer<I>) => Promise<string> | string;
  run: (ctx: ToolContext, input: z.infer<I>) => Promise<ToolResult>;
}): AnyHubTool {
  return tool as AnyHubTool;
}

export async function inTransaction<T>(ctx: ToolContext, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (ctx.tx) return fn(ctx.tx);
  return ctx.prisma.$transaction(fn);
}

export function toolOk(summary: string, data?: unknown, extra?: Omit<ToolResult, "summary" | "data">): ToolResult {
  return { summary, data, ...extra };
}

export class ToolBlockedError extends Error {
  constructor(
    message: string,
    public readonly remedy?: string,
  ) {
    super(message);
    this.name = "ToolBlockedError";
  }
}

export const OptionalId = z
  .string()
  .nullish()
  .transform((value) => (value && value.length > 0 ? value : undefined));
