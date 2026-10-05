import { z } from "zod";
import type { AssistantPageContext, AssistantToolArea, Settings } from "@ensemble/shared-types";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

export type ToolRisk = "low" | "medium" | "high";

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
}

export interface ToolResult {
  summary: string;
  data?: unknown;
  href?: string;
  undoEntryId?: string;
  invalidate?: string[];
}

export interface AnyHubTool {
  name: string;
  area: AssistantToolArea;
  description: string;
  input: z.ZodTypeAny;
  isWrite: boolean;
  risk: ToolRisk;
  undoable?: boolean;
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
