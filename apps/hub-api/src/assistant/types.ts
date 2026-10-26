import { z } from "zod";
import type { ContentPart } from "../files/model-input.js";
import type { AssistantPageContext, AssistantToolArea, CodeEngine, Settings } from "@ensemble/shared-types";
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
}

export interface ToolResult {
  summary: string;
  data?: unknown;
  /** Pictures for the model, shown after this step's tool results (files/model-input.ts). */
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
