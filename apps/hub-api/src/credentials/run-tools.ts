/**
 * The run's credential tools on its `ensemble` MCP server (B12): `secret_http`, answered by
 * `/api/engine/tool` with the run's own secret, for task runs and Chat alike. A run may use only the
 * secrets its scope allows (credentials/mode.ts), each only to its allowed destinations.
 */
import type { JobContext } from "../workspace/tools.js";
import { runSecretScope } from "./mode.js";
import { secretHttp, SecretUseError, type SecretHttpResult } from "./secret-http.js";

export const CREDENTIAL_TOOLS = ["secret_http"] as const;
export type CredentialTool = (typeof CREDENTIAL_TOOLS)[number];

/** The answer as the agent reads it: the status, the headers kept, then the body (the value hidden throughout). */
export function secretHttpText(result: SecretHttpResult): string {
  const lines = [`HTTP ${result.status} from ${result.url}`, ...Object.entries(result.headers).map(([key, value]) => `${key}: ${value}`)];
  if (result.note) lines.push(`(${result.note})`);
  return `${lines.join("\n")}\n\n${result.body}${result.truncated ? "\n[cut at 64 KB]" : ""}`;
}

export async function runCredentialTool(ctx: Pick<JobContext, "prisma" | "job" | "userId" | "network">, name: string, input: unknown): Promise<string> {
  if (name !== "secret_http") throw new SecretUseError(`Unknown tool ${name}.`, 400);
  const result = await secretHttp(input, { prisma: ctx.prisma, userId: ctx.userId, scope: runSecretScope(ctx.job.context), network: ctx.network, via: { kind: "run", jobId: ctx.job.id } });
  return secretHttpText(result);
}
