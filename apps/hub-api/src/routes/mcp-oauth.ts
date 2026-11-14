import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { env } from "../config.js";
import { McpOAuthService, type McpOAuthOptions } from "../mcp-oauth/service.js";
import { authorizationMetadata, formParameters, McpOAuthError, protectedMetadata } from "../mcp-oauth/protocol.js";
import { OPENAI_APPS_CHALLENGE_PATH } from "../mcp-oauth/paths.js";

const requestId = z.string().min(32).max(256);
const consentBody = z.object({
  request: requestId,
  csrf: requestId,
  decision: z.enum(["allow", "deny"]),
  spaceId: z.string().uuid().optional(),
  canWrite: z.boolean().optional(),
  canUseApps: z.boolean().optional(),
}).strict();

function uncached(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Referrer-Policy", "no-referrer");
}

function browserOrigin(origin: string | undefined): void {
  if (origin !== new URL(env.HUB_WEB_ORIGIN).origin) {
    throw Object.assign(new Error("Submit this decision from the Ensemble page in your browser."), { statusCode: 403 });
  }
}

async function oauthResult(reply: FastifyReply, action: () => Promise<unknown>) {
  uncached(reply);
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof McpOAuthError)) throw error;
    if (error.redirectTo) return reply.redirect(error.redirectTo);
    if (error.statusCode === 401) reply.header("WWW-Authenticate", 'Basic realm="Ensemble MCP client"');
    return reply.code(error.statusCode).send({ error: error.oauthError, error_description: error.message });
  }
}

export async function mcpOAuthRoutes(app: FastifyInstance, options: McpOAuthOptions = {}): Promise<void> {
  const service = new McpOAuthService(app.prisma, options, app.log);
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_request, body, done) => {
    try {
      done(null, formParameters(String(body)));
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  });

  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    app.get(path, async (_request, reply) => {
      uncached(reply);
      return protectedMetadata();
    });
  }
  app.get("/.well-known/oauth-authorization-server", async (_request, reply) => {
    uncached(reply);
    return authorizationMetadata();
  });
  app.get(OPENAI_APPS_CHALLENGE_PATH, async (_request, reply) => {
    uncached(reply);
    reply.type("text/plain; charset=utf-8");
    if (!env.OPENAI_APPS_CHALLENGE) return reply.code(404).send("No OpenAI domain challenge is configured.");
    return reply.send(env.OPENAI_APPS_CHALLENGE);
  });
  app.post("/oauth/register", { bodyLimit: 16 * 1024 }, async (request, reply) => oauthResult(reply, async () => {
    const client = await service.register(request.body);
    return reply.code(201).send(client);
  }));
  app.get("/oauth/authorize", async (request, reply) => oauthResult(reply, async () => {
    const id = await service.authorize(request.query);
    return reply.redirect(`${env.HUB_WEB_ORIGIN.replace(/\/$/, "")}/oauth?request=${encodeURIComponent(id)}`);
  }));
  app.post("/oauth/token", { bodyLimit: 16 * 1024 }, async (request, reply) => oauthResult(reply, async () => {
    const parsed = z.record(z.string().max(4096)).safeParse(request.body);
    if (!parsed.success) throw new McpOAuthError("invalid_request", "Send OAuth token parameters as form-encoded strings.");
    return service.token(parsed.data, request.headers.authorization);
  }));
  app.post("/oauth/revoke", { bodyLimit: 16 * 1024 }, async (request, reply) => oauthResult(reply, async () => {
    const parsed = z.record(z.string().max(4096)).safeParse(request.body);
    if (!parsed.success) throw new McpOAuthError("invalid_request", "Send the client credentials and token as form-encoded strings.");
    await service.revoke(parsed.data, request.headers.authorization);
    return {};
  }));

  app.get("/api/mcp-oauth/consent", async (request, reply) => {
    uncached(reply);
    const query = z.object({ request: requestId }).strict().parse(request.query);
    return service.consent(request, query.request);
  });
  app.post("/api/mcp-oauth/consent", async (request, reply) => {
    uncached(reply);
    browserOrigin(request.headers.origin);
    return { redirect: await service.decide(request, consentBody.parse(request.body)) };
  });
  app.get("/api/mcp-oauth/connections", async (request, reply) => {
    uncached(reply);
    return service.connections(request);
  });
  app.delete("/api/mcp-oauth/connections/:id", async (request, reply) => {
    uncached(reply);
    browserOrigin(request.headers.origin);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { csrf } = z.object({ csrf: requestId }).strict().parse(request.body);
    await service.disconnect(request, id, csrf);
    return { ok: true };
  });
}
