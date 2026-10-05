import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MODULE_DENIED, hasModule, moduleDenied, type OptionalModule } from "@ensemble/shared-types";

/** The matched route pattern, not the raw URL. Encoding cannot skip this. */
export async function enforceRouteModule(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.userId) return;
  const pattern = request.routeOptions?.url ?? "";
  if (!pattern || pattern.includes("*")) return;
  if (moduleDenied(pattern, request.modules)) {
    await reply.code(404).send({ error: MODULE_DENIED });
  }
}

/** A plugin declares the module it serves and refuses the request itself. */
export function declareModule(app: FastifyInstance, id: OptionalModule): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!hasModule(request.modules, id)) {
      return reply.code(404).send({ error: MODULE_DENIED });
    }
  });
}
