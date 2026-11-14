import type { FastifyInstance, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "@ensemble/context-bridge/server";
import { buildCatalogServer } from "@ensemble/context-bridge/catalog";
import { HubError, type HubCallOptions, type HubClient } from "@ensemble/context-bridge/hub";
import { maxFileBytes } from "../files/store.js";
import { NODE_SPACE_HEADER } from "../lib/auth.js";
import { mcpBearerChallenge } from "../mcp-oauth/protocol.js";
import { z } from "zod";

function bearerRejected(request: FastifyRequest): boolean {
  const authorization = request.headers.authorization;
  return request.authVia !== "token" || request.tokenScope === "device" || !authorization?.startsWith("Bearer ens_");
}

function bearerRequired(reply: { header: (name: string, value: string) => unknown; code: (status: number) => { send: (body: unknown) => unknown } }) {
  reply.header("WWW-Authenticate", mcpBearerChallenge());
  return reply.code(401).send({ error: "Bearer token required." });
}

function bridgePath(path: string, query?: Record<string, string | number | undefined>): string {
  let clean = path.startsWith("/") ? path : `/${path}`;
  if (!clean.startsWith("/api/bridge")) clean = `/api/bridge${clean}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${clean}?${search}` : clean;
}

/**
 * The bridge's routes through this process, with the caller's own key. A space the MCP request named
 * (`x-ensemble-space`, already checked for this key in lib/auth.ts) goes with every call; a tool's own
 * `space` argument replaces it for that call, and each call is checked again.
 */
function hubFor(app: FastifyInstance, authorization: string, requestSpace: string | undefined): HubClient {
  const send = async (method: "GET" | "POST" | "PATCH", path: string, query?: Record<string, string | number | undefined>, body?: unknown, options?: HubCallOptions) => {
      const space = options?.space ?? requestSpace;
      const response = await app.inject({
        method,
        url: bridgePath(path, query),
        headers: { authorization, accept: "application/json", ...(space ? { [NODE_SPACE_HEADER]: space } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
      if (response.statusCode >= 400) {
        let message = response.statusMessage || "HTTP error";
        try {
          const body = response.json<{ error?: unknown }>();
          if (typeof body.error === "string") message = body.error;
        } catch {
          /* body was not JSON */
        }
        if (response.statusCode === 401 || response.statusCode === 403) throw new HubError(message, "auth");
        throw new HubError(`Ensemble hub-api returned ${response.statusCode}: ${message}`, "http");
      }
      return response.json() as unknown;
  };
  return {
    get: (path, query, options) => send("GET", path, query, undefined, options),
    post: (path, body, options) => send("POST", path, undefined, body, options),
    patch: (path, body, options) => send("PATCH", path, undefined, body, options),
  };
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.get("/mcp", async (_request, reply) => reply.header("Allow", "POST").code(405).send({ error: "Method not allowed." }));
  app.delete("/mcp", async (_request, reply) => reply.header("Allow", "POST").code(405).send({ error: "Method not allowed." }));

  // A file from ensemble_upload_file comes inside the JSON-RPC body as base64.
  app.post("/mcp", { bodyLimit: Math.ceil((maxFileBytes() * 4) / 3) + 256 * 1024 }, async (request, reply) => {
    const authorization = request.headers.authorization;
    if (bearerRejected(request) || !authorization) return bearerRequired(reply);
    const named = request.headers[NODE_SPACE_HEADER];
    const space = (Array.isArray(named) ? named[0] : named)?.trim() || undefined;
    const tools = z.enum(["catalog", "legacy"]).optional().parse(request.headers["x-ensemble-tools"]);
    const deps = {
      hub: hubFor(app, authorization, space),
      detect: async () => ({}),
      // Changes: a full key, or a bridge key made with them allowed (bridge/auth.ts). Apps likewise.
      canWrite: request.tokenScope === "full" || (request.tokenScope === "bridge" && request.tokenCanWrite === true),
      canUseApps: request.tokenScope === "full" || (request.tokenScope === "bridge" && request.tokenCanUseApps === true),
      // Ensemble on the web cannot read the editor's disk: uploads come as base64.
      localFiles: false,
    };
    const server = tools === "catalog" || (tools !== "legacy" && request.tokenOAuthGrantId)
      ? await buildCatalogServer(deps)
      : buildServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      void transport.close();
      void server.close();
    };
    reply.raw.on("close", close);
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, "hosted MCP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
      }
      if (!reply.raw.writableEnded) reply.raw.end(JSON.stringify({ error: "MCP request failed." }));
    }
  });
}
