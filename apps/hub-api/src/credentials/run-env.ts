/**
 * What a coding-agent run on this computer gets of the saved secrets (B12, docs/35 §8.7), worked out
 * once when it starts (workspace/agent.ts): the environment secrets its scope allows under this
 * computer's mode (credentials/mode.ts), the git settings for the secrets it may use by reference, and
 * those secrets' names and destinations for its brief. Never a reference secret's value.
 */
import type { PrismaClient } from "@prisma/client";
import { referenceSecrets, runSecretEnv } from "../lib/run-secrets.js";
import { localApiUrl } from "../workspace/engines/registry.js";
import { gitCredentialEnv } from "./git-credential.js";
import { runSecretScope } from "./mode.js";

export type RunCredentials = { env: Record<string, string>; references: Array<{ name: string; allow: string[] }> };

export async function runCredentials(prisma: PrismaClient, userId: string, job: { id: string; context: unknown }): Promise<RunCredentials> {
  const scope = runSecretScope(job.context);
  const env = await runSecretEnv(prisma, userId, scope);
  const references = await referenceSecrets(prisma, userId, scope);
  let git: Record<string, string> = {};
  // Git signs in with a secret only in a run that names it (credentials/git-credential.ts).
  if (references.length && scope !== "all") {
    try {
      git = await gitCredentialEnv(prisma, { jobId: job.id, userId }, scope, localApiUrl());
    } catch {
      // The local API's port is not known (a run outside the desktop runtime): git signs in as before.
    }
  }
  return { env: { ...env, ...git }, references };
}
