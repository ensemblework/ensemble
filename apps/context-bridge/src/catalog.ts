import { createHash } from "node:crypto";
import type { RegisteredTool, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getParseErrorMessage, safeParseAsync, type ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { buildServer, type BridgeDeps } from "./server.js";
import type { HubClient } from "./hub.js";
import { spaceResolver } from "./spaces.js";

type Action = {
  name: string;
  description: string;
  write: boolean;
  allowed: boolean;
  group: string;
  limit?: string;
  openWorld?: boolean;
  requiresApps?: boolean;
  inputSchema?: Record<string, unknown>;
};
type Proxy = { source: Action; definition: Tool; fixed?: { field: string; value: string }; wrapped: boolean; validate?: ReturnType<AjvJsonSchemaValidator["getValidator"]> };

const SCOPE = { type: "string", maxLength: 200, description: "The Ensemble space's id or exact name. Default: this connection's space." };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const security = (write: boolean, apps: boolean) => [{ type: "oauth2", scopes: ["ensemble:read", ...(write ? ["ensemble:write"] : []), ...(apps ? ["ensemble:apps"] : [])] }];
const neutralDescription = (description: string): string => description
  .replace(/\bensemble_(?:actions|act|apps|app_call)\b/g, "the action-specific tools")
  .replace(/\u2014|\u2013|--/g, ",");

function toolName(source: string, variant?: string): string {
  const clean = source.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!variant && clean === source && clean.length <= 64) return clean;
  const suffix = `_${createHash("sha256").update(`${source}:${variant ?? ""}`).digest("hex").slice(0, 10)}`;
  return `${clean.slice(0, 64 - suffix.length).replace(/_+$/, "")}${suffix}`;
}

function parseActions(answer: unknown): Action[] {
  if (!object(answer)) throw new Error("Ensemble returned an invalid tool catalog. Retry the connection.");
  const rows = answer.actions ?? answer.tools;
  if (!Array.isArray(rows)) throw new Error("Ensemble returned no tool catalog. Retry the connection.");
  return rows.map(row => {
    if (!object(row) || typeof row.name !== "string" || typeof row.description !== "string" ||
      typeof row.write !== "boolean" || typeof row.allowed !== "boolean" || typeof row.group !== "string" ||
      (row.allowed && !object(row.inputSchema))) {
      throw new Error("Ensemble returned an incomplete tool definition. Refresh the connection.");
    }
    return {
      name: row.name, description: row.description, write: row.write, allowed: row.allowed, group: row.group,
      ...(typeof row.limit === "string" ? { limit: row.limit } : {}),
      ...(typeof row.openWorld === "boolean" ? { openWorld: row.openWorld } : {}),
      ...(typeof row.requiresApps === "boolean" ? { requiresApps: row.requiresApps } : {}),
      ...(object(row.inputSchema) ? { inputSchema: row.inputSchema } : {}),
    };
  });
}

function proxiesFor(source: Action): Proxy[] {
  if (!source.allowed || !source.inputSchema) return [];
  const schema = structuredClone(source.inputSchema);
  const properties = object(schema.properties) ? schema.properties : {};
  const field = ["action", "operation", "method", "op", "mode"].find(key => {
    const item = properties[key];
    return object(item) && Array.isArray(item.enum) && item.enum.length > 1 && item.enum.every(value => typeof value === "string");
  });
  const values = field && object(properties[field]) && Array.isArray(properties[field].enum) ? properties[field].enum : [undefined];
  return values.map(value => {
    const fixed = field && typeof value === "string" ? { field, value } : undefined;
    const input = structuredClone(schema);
    const originalProperties = object(input.properties) ? input.properties : {};
    if (fixed) {
      const original = originalProperties[fixed.field];
      originalProperties[fixed.field] = { ...(object(original) ? original : {}), enum: [fixed.value], default: fixed.value };
      if (Array.isArray(input.required)) input.required = input.required.filter(key => key !== fixed.field);
    }
    const wrapped = Object.hasOwn(originalProperties, "space");
    const inputSchema = wrapped
      ? { type: "object", properties: { input, space: SCOPE }, required: ["input"], additionalProperties: false }
      : { ...input, type: "object", properties: { ...originalProperties, space: SCOPE } };
    const apps = source.group === "apps" || source.openWorld === true;
    const base = source.group === "apps" ? `ensemble_app_${source.name}` : `ensemble_action_${source.name.replace(/^hub_/, "")}`;
    const title = `${source.name.replace(/^(hub_|mcp_)/, "").replace(/_/g, " ")}${fixed ? `: ${fixed.value}` : ""}`;
    const definition = ToolSchema.parse({
      name: toolName(`${base}${fixed ? `_${fixed.value}` : ""}`, fixed ? `${source.name}:${fixed.field}:${fixed.value}` : undefined),
      title: title.charAt(0).toUpperCase() + title.slice(1),
      description: `${neutralDescription(source.description)}${fixed ? ` This tool performs only ${fixed.value}; other operations use separate tools.` : ""}${source.limit ? ` ${source.limit}` : ""}`,
      inputSchema,
      annotations: { readOnlyHint: !source.write, destructiveHint: source.write, idempotentHint: !source.write, openWorldHint: apps },
      _meta: { securitySchemes: security(source.write, source.group === "apps" || source.requiresApps === true) },
    });
    return { source, definition, fixed, wrapped };
  });
}

function result(data: unknown): CallToolResult {
  const structuredContent = object(data) ? data : { value: data };
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
}

function failed(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

/** Same Context Bridge, with named operations instead of read/write catch-alls. */
export async function buildCatalogServer(deps: BridgeDeps & { hub: HubClient }) {
  const core = new Map<string, RegisteredTool>();
  const server = buildServer({ ...deps, catalog: true, localFiles: false, onTool: (name, tool) => core.set(name, tool) });
  const actions = parseActions(await deps.hub.get("/api/bridge/actions", { schema: "1" }));
  const apps = deps.canUseApps ? parseActions(await deps.hub.get("/api/bridge/apps", { schema: "1" })) : [];
  const proxy = new Map<string, Proxy>();
  for (const source of [...actions, ...apps]) {
    for (const entry of proxiesFor(source)) {
      if (core.has(entry.definition.name) || proxy.has(entry.definition.name)) throw new Error("Ensemble tool names collide. Refresh the catalog.");
      proxy.set(entry.definition.name, entry);
    }
  }
  const definitions = [...core].map(([name, entry]) => {
    if (!entry.inputSchema) throw new Error(`Ensemble tool ${name} has no input schema.`);
    const write = entry.annotations?.readOnlyHint !== true;
    return ToolSchema.parse({
      name, title: entry.title, description: neutralDescription(entry.description ?? ""),
      inputSchema: toJsonSchemaCompat(entry.inputSchema, { target: "jsonSchema7", pipeStrategy: "input" }),
      annotations: { ...entry.annotations, openWorldHint: name === "ensemble_docs" || entry.annotations?.openWorldHint === true },
      _meta: { ...entry._meta, securitySchemes: security(write, false) },
    });
  }).concat([...proxy.values()].map(entry => entry.definition));
  const resolveSpace = spaceResolver(deps.hub);

  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const args = request.params.arguments ?? {};
      const original = core.get(request.params.name);
      if (original) {
        if (!original.inputSchema || typeof original.handler !== "function") throw new Error("This tool cannot be called synchronously.");
        const parsed = await safeParseAsync(original.inputSchema, args);
        if (!parsed.success) throw new Error(`Invalid tool input: ${getParseErrorMessage(parsed.error)}`);
        if (!object(parsed.data)) throw new Error("Supply a JSON object as this tool's arguments.");
        const handler = original.handler as ToolCallback<ZodRawShapeCompat>;
        return await handler(parsed.data, extra);
      }
      const entry = proxy.get(request.params.name);
      if (!entry) throw new Error("This tool is not available with this connection's permissions. Refresh the tool list.");
      // Derived tools can share a provider's $id, but not its compiled schema validator.
      const validate = entry.validate ??= new AjvJsonSchemaValidator().getValidator<Record<string, unknown>>(entry.definition.inputSchema);
      const checked = validate(args);
      if (!checked.valid) throw new Error(`Invalid tool input: ${checked.errorMessage}`);
      const wanted = typeof args.space === "string" ? args.space.trim() : "";
      const space = wanted ? await resolveSpace(wanted) : undefined;
      const { space: _space, ...rest } = args;
      const input = entry.wrapped ? rest.input : rest;
      if (!object(input)) throw new Error("Supply the operation's input as a JSON object.");
      if (entry.fixed) input[entry.fixed.field] = entry.fixed.value;
      if (!deps.hub.post) throw new Error("This Ensemble connection cannot run actions.");
      return result(await deps.hub.post(`/api/bridge/act/${encodeURIComponent(entry.source.name)}`, { input }, space ? { space } : undefined));
    } catch (error) {
      return failed(error);
    }
  });
  return server;
}
