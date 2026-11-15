/**
 * `ensemble doctor`'s check of the agents' apps (docs/30 §8): an app this computer's runtime found
 * without its agent, the Cursor app without Cursor's agent or VS Code with Copilot without Copilot
 * CLI, with how to set it up. The runtime's own check (`GET /api/subscriptions`), the one Settings →
 * Models shows.
 */
import { AGENT_APP_INFO, appWithoutAgent, parseAgentApps, parseSubscriptionAgents, SUBSCRIPTION_PROVIDERS } from "@ensemble/shared-types";
import { localJson, type Discovery } from "./sidecar.js";

export type AppNote = { label: string; fix: string };

type LocalComputer = { local?: boolean; agents?: unknown; apps?: unknown };

/** One note per agent whose app is here without it, with the vendor's install command for this system. */
export function agentAppNotes(computer: LocalComputer | null | undefined, platform: NodeJS.Platform = process.platform): AppNote[] {
  if (!computer) return [];
  const agents = parseSubscriptionAgents(computer.agents);
  const apps = parseAgentApps(computer.apps);
  return SUBSCRIPTION_PROVIDERS.flatMap((id) => {
    const app = appWithoutAgent(id, agents, apps);
    if (!app) return [];
    const info = AGENT_APP_INFO[app];
    const install = platform === "win32" ? info.install.windows : info.install.unix;
    return [{ label: `${info.name} found. Set up ${info.setsUp}`, fix: `press Set up under Settings → Models, or run \`${install}\`, then \`${info.install.login}\`` }];
  });
}

/** This computer as its runtime reports it, or null when the runtime does not answer in time. */
export async function localComputer(discovery: Discovery, timeoutMs = 30_000): Promise<LocalComputer | null> {
  const body = await localJson<{ computers?: LocalComputer[] }>(discovery, "/api/subscriptions", { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  return body?.computers?.find((computer) => computer.local) ?? null;
}
