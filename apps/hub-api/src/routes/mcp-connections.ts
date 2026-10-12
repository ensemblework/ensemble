/**
 * Remote MCP connections: connect a vendor's hosted MCP server (or any pasted
 * URL), list what it offers, switch tools off, disconnect.
 * Docs: docs/03 "Remote MCP connectors", API rows in docs/02.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CONNECTOR_CATALOG, catalogEntry, type ConnectorCatalogEntry } from "@ensemble/shared-types";
import { oauthApp } from "../connectors/accounts.js";
import { isHosted, requireVerifiedUser } from "../lib/hosted-access.js";
import { appendLedger } from "../lib/ledger.js";
import { clientAddress, MemoryRateLimiter } from "../lib/rate-limit.js";
import { hubReturnUrl, MCP_CALLBACK_PATH, MCP_CLIENT_METADATA_PATH, mcpClientMetadataDocument } from "../connectors/mcp/config.js";
import { disconnect, finishConnection, McpConnectionError, refreshTools, startConnection, type McpTransportKind } from "../connectors/mcp/manager.js";
import { connectionView } from "../connectors/mcp/store.js";
import { canonicalMcpUrl, parseMcpUrl } from "../connectors/mcp/url-guard.js";

/** Connections one person may keep. */
export const MAX_MCP_CONNECTIONS = 30;

const limiter = new MemoryRateLimiter();
const LIMITS = {
  connect: { limit: 20, windowMs: 10 * 60_000, error: "Too many connection attempts. Wait a few minutes and try again." },
  refresh: { limit: 30, windowMs: 10 * 60_000, error: "Too many tool refreshes. Wait a few minutes and try again." },
  callback: { limit: 60, windowMs: 10 * 60_000, error: "Too many sign-in returns from this address. Wait a few minutes and try again." },
} as const;

function overLimit(request: FastifyRequest, reply: FastifyReply, bucket: keyof typeof LIMITS): boolean {
  const rule = LIMITS[bucket];
  const key = bucket === "callback" ? `mcp-${bucket}:ip:${clientAddress(request)}` : `mcp-${bucket}:user:${request.userId}`;
  const wait = limiter.take(key, rule.limit, rule.windowMs);
  if (wait === null) return false;
  reply.header("Retry-After", String(Math.max(1, Math.ceil(wait / 1000))));
  void reply.code(429).send({ error: rule.error });
  return true;
}

const Params = z.object({ id: z.string().uuid() });

const ConnectBody = z
  .object({
    serverId: z.string().trim().min(1).max(64).optional(),
    url: z.string().trim().min(8).max(2048).optional(),
    name: z.string().trim().min(1).max(80).optional(),
    token: z.string().trim().min(8).max(8192).optional(),
    clientId: z.string().trim().min(1).max(512).optional(),
    clientSecret: z.string().trim().min(1).max(2048).optional(),
    /** Values for the catalog entry's {placeholders}, e.g. { stack: "fieldnote" }. */
    fields: z.record(z.string().trim().max(200)).optional(),
    /** Sign in with the person's existing connection to the entry's provider. */
    useConnection: z.boolean().optional(),
    returnTo: z.string().max(400).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Boolean(body.serverId) === Boolean(body.url)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Send either serverId or url.", path: ["serverId"] });
    }
    if (body.clientSecret && !body.clientId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "clientSecret needs clientId.", path: ["clientSecret"] });
    if (body.token && body.clientId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Send a token or a client, not both.", path: ["token"] });
  });

const PatchBody = z
  .object({
    disabledTools: z.array(z.string().min(1).max(128)).max(500).optional(),
    status: z.enum(["disabled", "connected"]).optional(),
  })
  .strict()
  .refine((body) => body.disabledTools !== undefined || body.status !== undefined, { message: "Nothing to change." });

type Target = { serverId: string; name: string; url: string; transport: McpTransportKind; entry?: ConnectorCatalogEntry };

/** Fills an entry's {placeholders}. Each value must match its field's pattern, so nobody can point the URL elsewhere. */
export function fillMcpUrl(entry: ConnectorCatalogEntry, values: Record<string, string> = {}): string {
  const mcp = entry.mcp!;
  let url = mcp.url;
  for (const field of mcp.fields ?? []) {
    const raw = (values[field.name] ?? "").trim();
    let value = raw.toLowerCase().startsWith("https://") ? raw.replace(/^https:\/\//i, "").replace(/\/.*$/, "") : raw;
    // "fieldnote.grafana.net" for a template ending in "{stack}.grafana.net" means "fieldnote".
    const after = /^[^/{]*/.exec(mcp.url.split(`{${field.name}}`)[1] ?? "")?.[0] ?? "";
    if (after && value.toLowerCase().endsWith(after.toLowerCase())) value = value.slice(0, -after.length);
    if (!value || !new RegExp(`^(?:${field.pattern})$`).test(value)) throw new McpConnectionError(`Enter ${field.label.toLowerCase()} (${field.placeholder ?? "see the hint"}).`, 400, "MCP_FIELD");
    url = url.split(`{${field.name}}`).join(encodeURIComponent(value).replace(/%2E/gi, "."));
  }
  if (/\{[a-z_]+\}/i.test(url)) throw new McpConnectionError("This connector's address is incomplete.", 400, "MCP_FIELD");
  return url;
}

/** A pasted address that is a catalog server connects as that entry. Loom shares Atlassian's server; the first entry wins. */
const CATALOG_BY_URL = new Map<string, ConnectorCatalogEntry>();
for (const entry of CONNECTOR_CATALOG) {
  if (!entry.mcp || entry.status !== "ready" || entry.mcp.fields?.length) continue;
  const key = canonicalMcpUrl(new URL(entry.mcp.url));
  if (!CATALOG_BY_URL.has(key)) CATALOG_BY_URL.set(key, entry);
}

/** The field values a stored address was built from, so a reconnect does not ask again. */
export function mcpFieldsFromUrl(entry: ConnectorCatalogEntry, url: string): Record<string, string> | undefined {
  const names: string[] = [];
  const pattern = entry.mcp!.url
    .split(/(\{[a-z_]+\})/i)
    .map((part) => {
      const name = /^\{([a-z_]+)\}$/i.exec(part)?.[1];
      if (!name) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(name);
      return "([^/]+?)";
    })
    .join("");
  const match = new RegExp(`^${pattern}/?$`, "i").exec(url);
  return match ? Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)])) : undefined;
}

function targetFor(body: z.infer<typeof ConnectBody>): Target | string {
  if (body.serverId) {
    const entry = catalogEntry(body.serverId);
    if (!entry?.mcp || entry.status !== "ready") return "That app does not have a remote MCP server Ensemble can connect to.";
    return { serverId: entry.id, name: entry.name, url: fillMcpUrl(entry, body.fields), transport: entry.mcp.transport, entry };
  }
  const url = parseMcpUrl(body.url!);
  const canonical = canonicalMcpUrl(url);
  const known = CATALOG_BY_URL.get(canonical);
  if (known?.mcp) return { serverId: known.id, name: known.name, url: known.mcp.url, transport: known.mcp.transport };
  return {
    serverId: `custom-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`,
    name: body.name ?? url.hostname,
    url: canonical,
    transport: "streamable-http",
  };
}

export async function mcpConnectionRoutes(app: FastifyInstance): Promise<void> {
  /** Client ID Metadata Document. Authorization servers fetch it when client_id is this URL. */
  app.get(MCP_CLIENT_METADATA_PATH, async (_request, reply) => {
    reply.header("cache-control", "public, max-age=3600");
    return mcpClientMetadataDocument();
  });

  app.get("/api/mcp-connections", async (request) => {
    await requireVerifiedUser(request.userId);
    const rows = await app.prisma.mcpConnection.findMany({ where: { userId: request.userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    return { connections: rows.map(connectionView) };
  });

  app.post("/api/mcp-connections", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const body = ConnectBody.parse(request.body ?? {});
    if (overLimit(request, reply, "connect")) return reply;
    const fielded = body.serverId ? catalogEntry(body.serverId) : undefined;
    if (fielded?.mcp?.fields?.length && !body.fields) {
      const previous = await app.prisma.mcpConnection.findUnique({ where: { userId_serverId: { userId: request.userId, serverId: fielded.id } }, select: { url: true } });
      if (previous) body.fields = mcpFieldsFromUrl(fielded, previous.url);
    }
    const target = targetFor(body);
    if (typeof target === "string") return reply.code(400).send({ error: target });
    const existing = await app.prisma.mcpConnection.findUnique({
      where: { userId_serverId: { userId: request.userId, serverId: target.serverId } },
      select: { id: true },
    });
    if (!existing && (await app.prisma.mcpConnection.count({ where: { userId: request.userId } })) >= MAX_MCP_CONNECTIONS) {
      return reply.code(409).send({ error: `You can keep up to ${MAX_MCP_CONNECTIONS} MCP connections. Remove one first.` });
    }
    const mcp = target.entry?.mcp;
    if (body.useConnection && !mcp?.connection) return reply.code(400).send({ error: `${target.name} cannot sign in with another connection.` });
    let client = body.clientId ? { clientId: body.clientId, ...(body.clientSecret ? { clientSecret: body.clientSecret } : {}) } : undefined;
    if (!client && !body.token && !body.useConnection && mcp?.client) {
      const operator = await oauthApp(mcp.client.app);
      if (!operator) return reply.code(409).send({ error: `${target.name} only accepts apps registered with it, and none is set up on this server yet.`, code: "MCP_APP_MISSING" });
      client = { clientId: operator.clientId, clientSecret: operator.clientSecret };
    }
    const outcome = await startConnection(app.prisma, request.userId, {
      serverId: target.serverId,
      name: target.name,
      url: target.url,
      transport: target.transport,
      returnTo: body.returnTo,
      token: body.token,
      ...(client ? { client } : {}),
      ...(body.useConnection && mcp?.connection ? { connection: mcp.connection } : {}),
    });
    if (outcome.status === "connected") {
      await appendLedger({
        userId: request.userId,
        actor: "me",
        action: "mcp.connect",
        payload: { serverId: target.serverId, name: target.name, auth: body.token ? "bearer" : body.useConnection ? "connection" : "none" },
      });
    }
    return outcome;
  });

  app.get(MCP_CALLBACK_PATH, async (request, reply) => {
    if (overLimit(request, reply, "callback")) return reply;
    const query = z
      .object({
        code: z.string().max(4096).optional(),
        state: z.string().max(512).optional(),
        error: z.string().max(200).optional(),
        error_description: z.string().max(2000).optional(),
      })
      .passthrough()
      .parse(request.query);
    const outcome = await finishConnection(app.prisma, {
      code: query.code,
      state: query.state,
      error: query.error,
      errorDescription: query.error_description,
      requireSession: isHosted(),
      sessionUserId: request.authVia === "session" ? request.userId : null,
    });
    if (outcome.ok) {
      await appendLedger({
        userId: outcome.userId,
        actor: "me",
        action: "mcp.connect",
        payload: { serverId: outcome.serverId, name: outcome.name, auth: "oauth", tools: outcome.toolCount },
      });
      return reply.redirect(hubReturnUrl(outcome.returnTo, { mcp: "connected", server: outcome.serverId }));
    }
    return reply.redirect(
      hubReturnUrl(outcome.returnTo, { mcp: "error", ...(outcome.serverId ? { server: outcome.serverId } : {}), mcpError: outcome.message }),
    );
  });

  app.post("/api/mcp-connections/:id/refresh-tools", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const { id } = Params.parse(request.params);
    if (overLimit(request, reply, "refresh")) return reply;
    const row = await refreshTools(app.prisma, request.userId, id);
    return { connection: connectionView(row) };
  });

  app.patch("/api/mcp-connections/:id", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const { id } = Params.parse(request.params);
    const body = PatchBody.parse(request.body ?? {});
    const row = await app.prisma.mcpConnection.findFirst({ where: { id, userId: request.userId } });
    if (!row) return reply.code(404).send({ error: "That connection is no longer available." });
    if (body.status === "connected" && row.status !== "connected" && row.status !== "disabled") {
      throw new McpConnectionError(`Connect ${row.name} again first.`, 409, "MCP_RECONNECT");
    }
    if (body.status === "disabled" && row.status === "pending") {
      throw new McpConnectionError(`${row.name} is still connecting. Remove it instead.`, 409, "MCP_PENDING");
    }
    const updated = await app.prisma.mcpConnection.update({
      where: { id: row.id },
      data: {
        ...(body.disabledTools ? { disabledTools: [...new Set(body.disabledTools)] } : {}),
        ...(body.status ? { status: body.status } : {}),
      },
    });
    if (body.status && body.status !== row.status) {
      await appendLedger({
        userId: request.userId,
        actor: "me",
        action: body.status === "disabled" ? "mcp.disable" : "mcp.enable",
        payload: { serverId: row.serverId, name: row.name },
      });
    }
    return { connection: connectionView(updated) };
  });

  app.delete("/api/mcp-connections/:id", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const { id } = Params.parse(request.params);
    const result = await disconnect(app.prisma, request.userId, id);
    if (!result) return reply.code(404).send({ error: "That connection is no longer available." });
    await appendLedger({
      userId: request.userId,
      actor: "me",
      action: "mcp.disconnect",
      payload: { serverId: result.row.serverId, name: result.row.name, revoked: result.revoked },
    });
    return reply.code(204).send();
  });
}
