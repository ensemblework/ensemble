import type { FastifyInstance, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "@ensemble/context-bridge/server";
import { HubError, type HubClient } from "@ensemble/context-bridge/hub";

function bearerRejected(request: FastifyRequest): boolean {
  const authorization = request.headers.authorization;
  return request.authVia !== "token" || request.tokenScope === "device" || !authorization?.startsWith("Bearer ens_");
}

function bearerRequired(reply: { header: (name: string, value: string) => unknown; code: (status: number) => { send: (body: unknown) => unknown } }) {
  reply.header("WWW-Authenticate", 'Bearer realm="Ensemble"');
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

function hubFor(app: FastifyInstance, authorization: string): HubClient {
  return {
    async get(path, query) {
      const response = await app.inject({
        method: "GET",
        url: bridgePath(path, query),
        headers: { authorization, accept: "application/json" },
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
    },
  };
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.get("/mcp", async (_request, reply) => reply.header("Allow", "POST").code(405).send({ error: "Method not allowed." }));
  app.delete("/mcp", async (_request, reply) => reply.header("Allow", "POST").code(405).send({ error: "Method not allowed." }));

  app.post("/mcp", async (request, reply) => {
    const authorization = request.headers.authorization;
    if (bearerRejected(request) || !authorization) return bearerRequired(reply);
    const server = buildServer({
      hub: hubFor(app, authorization),
      detect: async () => ({}),
    });
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
