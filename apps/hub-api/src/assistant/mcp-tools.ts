/**
 * Tools from the person's remote MCP connections, shaped as Hub tools.
 *
 * Built per turn from the cached tools/list of connected servers, minus the
 * tools the person switched off. Names are `mcp_<server>_<tool>`, at most 64
 * characters of [a-zA-Z0-9_-], and depend only on the connection and the
 * tool, so a name proposed in one turn resolves to the same tool on Apply.
 * The model gets the server's own JSON Schema from `jsonSchema` (mcpJsonSchema),
 * not a conversion of the loose zod `input`.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpConnection, PrismaClient } from "@prisma/client";
import { catalogEntry } from "@ensemble/shared-types";
import { callMcpTool } from "../connectors/mcp/manager.js";
import { providerSafeSchema } from "../connectors/mcp/schema.js";
import { cachedTools, toolReadOnly, toolTitle, type McpToolSpec } from "../connectors/mcp/store.js";
import { toolOk, ToolBlockedError, type AnyHubTool, type ToolRisk } from "./types.js";

export const MCP_TOOL_PREFIX = "mcp_";
export const MCP_TOOL_NAME_MAX = 64;
export const MCP_TOOLS_PER_SERVER = 40;
export const MCP_TOOLS_TOTAL = 80;
const MAX_DESCRIPTION_CHARS = 1_000;

export type McpHubTool = AnyHubTool & {
  /** The server's own input JSON Schema, cleaned for model providers. Use it as the function parameters. */
  jsonSchema: Record<string, unknown>;
  mcp: { connectionId: string; serverId: string; serverName: string; toolName: string; readOnly: boolean };
};

type ConnectionRow = Pick<McpConnection, "id" | "userId" | "serverId" | "name" | "status" | "tools" | "disabledTools">;

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** Catalog servers use their id ("notion"); pasted URLs use the name plus a hash of the server id ("acme_1a2b"). */
export function serverSlug(row: Pick<McpConnection, "serverId" | "name">): string {
  if (!row.serverId.startsWith("custom-") && catalogEntry(row.serverId)) {
    return sanitize(row.serverId).toLowerCase().slice(0, 20) || "server";
  }
  const base = sanitize(row.name).toLowerCase().slice(0, 12).replace(/_+$/, "") || "custom";
  return `${base}_${shortHash(row.serverId, 4)}`;
}

/** `mcp_<slug>_<tool>`. A tool name that had to be changed or shortened gets a hash suffix, so two tools never share a name. */
export function mcpToolName(slug: string, serverId: string, toolName: string): string {
  const clean = sanitize(toolName);
  const plain = `${MCP_TOOL_PREFIX}${slug}_${clean}`;
  if (clean === toolName && plain.length <= MCP_TOOL_NAME_MAX) return plain;
  const suffix = `_${shortHash(`${serverId}:${toolName}`, 6)}`;
  return `${plain.slice(0, MCP_TOOL_NAME_MAX - suffix.length).replace(/_+$/, "")}${suffix}`;
}

/** Splits `total` across servers as evenly as their tool counts allow. */
export function fairShare(counts: readonly number[], total: number): number[] {
  const quota = counts.map(() => 0);
  let remaining = total;
  let open = counts.map((_, index) => index).filter((index) => counts[index]! > 0);
  while (remaining > 0 && open.length) {
    const share = Math.max(1, Math.floor(remaining / open.length));
    for (const index of [...open]) {
      const give = Math.min(share, counts[index]! - quota[index]!, remaining);
      quota[index]! += give;
      remaining -= give;
      if (quota[index]! >= counts[index]!) open = open.filter((other) => other !== index);
      if (remaining <= 0) break;
    }
  }
  return quota;
}

function shortValue(value: unknown): string {
  const text = typeof value === "string" ? JSON.stringify(value.length > 60 ? `${value.slice(0, 57)}…` : value) : (JSON.stringify(value) ?? String(value));
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** ` with { title: "Launch plan", status: "Done" }`, or "" for no arguments. */
export function shortArgs(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined && item !== null && item !== "");
  if (!entries.length) return "";
  const parts = entries.slice(0, 6).map(([key, item]) => `${key}: ${shortValue(item)}`);
  if (entries.length > 6) parts.push("…");
  return ` with { ${parts.join(", ")} }`;
}

function riskOf(spec: McpToolSpec): ToolRisk {
  if (toolReadOnly(spec)) return "low";
  return spec.annotations?.destructiveHint === true ? "high" : "medium";
}

function makeTool(row: ConnectionRow, slug: string, spec: McpToolSpec, hidden: readonly McpToolSpec[]): McpHubTool {
  const title = toolTitle(spec);
  const readOnly = toolReadOnly(spec);
  const { schema, required, trimmed } = providerSafeSchema(spec.inputSchema);
  const about = (spec.description ?? "").replace(/\s+/g, " ").trim();
  let description = `${row.name}: ${title}.${about && about !== title ? ` ${about}` : ""}`;
  if (description.length > MAX_DESCRIPTION_CHARS) description = `${description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`;
  if (!readOnly) description += ` Changes data in ${row.name}.`;
  if (trimmed) description += " Some argument details were cut to fit; pass what the description asks for.";
  if (hidden.length) {
    const names = hidden.slice(0, 8).map((tool) => tool.name).join(", ");
    description += ` ${hidden.length} more ${row.name} tools are hidden to keep the list short (${names}${hidden.length > 8 ? ", …" : ""}). The person can switch off unused ${row.name} tools in Settings → Connections to make room.`;
  }
  const input = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
    const missing = required.filter((key) => value[key] === undefined || value[key] === null);
    if (missing.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Missing ${missing.join(", ")}.` });
  });
  return {
    name: mcpToolName(slug, row.serverId, spec.name),
    area: "apps",
    description,
    input,
    jsonSchema: schema,
    isWrite: !readOnly,
    risk: riskOf(spec),
    undoable: false,
    mcp: { connectionId: row.id, serverId: row.serverId, serverName: row.name, toolName: spec.name, readOnly },
    preview: (_ctx, value) => `${row.name}: ${title}${shortArgs(value)}`,
    run: async (ctx, value) => {
      if (ctx.userId !== row.userId) throw new ToolBlockedError("That connected app belongs to another account.");
      const args = (value ?? {}) as Record<string, unknown>;
      // Writes only run from Apply, which ledgers them as apps.<tool> (src/assistant/apply.ts).
      const output = await callMcpTool(ctx.prisma, ctx.userId, row.id, spec.name, args);
      if (output.isError) throw new Error(`${row.name} returned an error: ${output.text.slice(0, 600) || "no details."}`);
      return toolOk(readOnly ? `${row.name}: ${title}` : `${row.name}: ${title} done`, {
        text: output.text,
        ...(output.structured !== undefined ? { structured: output.structured } : {}),
        ...(output.truncated ? { truncated: true } : {}),
      });
    },
  };
}

/**
 * Hub tools for the given connection rows. Only "connected" rows count.
 * With cap (the default) each server keeps its first MCP_TOOLS_PER_SERVER
 * enabled tools and all servers share MCP_TOOLS_TOTAL; the first tool of a
 * trimmed server says what was hidden.
 */
export function buildMcpTools(rows: readonly ConnectionRow[], options: { cap?: boolean } = {}): McpHubTool[] {
  const cap = options.cap ?? true;
  const servers = rows
    .filter((row) => row.status === "connected")
    .map((row) => {
      const off = new Set(row.disabledTools);
      return { row, slug: serverSlug(row), tools: cachedTools(row).filter((tool) => !off.has(tool.name)) };
    });
  const quotas = cap
    ? fairShare(
        servers.map((server) => Math.min(server.tools.length, MCP_TOOLS_PER_SERVER)),
        MCP_TOOLS_TOTAL,
      )
    : servers.map((server) => server.tools.length);
  const out: McpHubTool[] = [];
  const names = new Set<string>();
  servers.forEach((server, index) => {
    const quota = quotas[index] ?? 0;
    const hidden = server.tools.slice(quota);
    server.tools.slice(0, quota).forEach((spec, position) => {
      const tool = makeTool(server.row, server.slug, spec, position === 0 ? hidden : []);
      if (names.has(tool.name)) return;
      names.add(tool.name);
      out.push(tool);
    });
  });
  return out;
}

async function connectedRows(prisma: Pick<PrismaClient, "mcpConnection">, userId: string): Promise<ConnectionRow[]> {
  return prisma.mcpConnection.findMany({
    where: { userId, status: "connected" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, userId: true, serverId: true, name: true, status: true, tools: true, disabledTools: true },
  });
}

/** The tools to offer the model this turn, within the caps. */
export async function mcpToolsForUser(prisma: Pick<PrismaClient, "mcpConnection">, userId: string): Promise<McpHubTool[]> {
  return buildMcpTools(await connectedRows(prisma, userId));
}

/** Finds one MCP tool by name for dispatch or Apply. Ignores the caps; still only connected servers and enabled tools. */
export async function resolveMcpTool(prisma: Pick<PrismaClient, "mcpConnection">, userId: string, name: string): Promise<McpHubTool | undefined> {
  if (!isMcpToolName(name)) return undefined;
  return buildMcpTools(await connectedRows(prisma, userId), { cap: false }).find((tool) => tool.name === name);
}

/** The JSON Schema registry.parameters() should send for this tool, when it has its own. */
export function mcpJsonSchema(tool: AnyHubTool): Record<string, unknown> | undefined {
  const schema = (tool as Partial<McpHubTool>).jsonSchema;
  return schema && typeof schema === "object" ? structuredClone(schema) : undefined;
}
