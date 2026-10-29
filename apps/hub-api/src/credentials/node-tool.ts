/**
 * A node's `secret_http` on this computer (B12): `node.tool.request` with `tool: "secret_http"`. The node
 * names the secret in its call, so any saved secret may be used, but only to the destinations the owner
 * allowed for it here; that list is the owner's answer, so no Needs me card is asked for. The answer
 * has the value hidden (credentials/secret-http.ts).
 */
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import type { NodeToolRequest } from "../remote/contract.js";
import { secretHttp, SecretUseError } from "./secret-http.js";

type SecretHttpRequest = Extract<NodeToolRequest, { tool: "secret_http" }>;

export async function nodeSecretHttp(app: Pick<FastifyInstance, "prisma">, request: SecretHttpRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const result = await secretHttp(
      { ref: request.ref, url: request.url, method: request.method, headers: request.headers, body: request.body },
      { prisma: app.prisma, userId: env.ENSEMBLE_DEV_USER_ID, scope: "all", via: { kind: "node", nodeId: request.nodeId, operationId: request.operationId ?? null } },
    );
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof SecretUseError) return { status: error.statusCode, body: { error: error.message } };
    throw error;
  }
}
