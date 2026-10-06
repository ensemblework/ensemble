import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "@ensemble/context-bridge/server";
import { createHubClient } from "@ensemble/context-bridge/hub";
import { loadConfig, loadToken, normalizeApiBase } from "./config.js";
import { resolveCliPaths } from "./paths.js";

export async function runMcp(input: { api?: string } = {}): Promise<void> {
  const paths = resolveCliPaths();
  const config = await loadConfig(paths);
  const token = await loadToken(paths);
  const apiBase = normalizeApiBase(input.api || process.env.ENSEMBLE_API_URL || config.apiBase);
  const auth = token ? ({ kind: "bearer" as const, token }) : ({ kind: "missing" as const, message: "Run `ensemble login` first." });
  const hub = createHubClient({
    hubUrl: apiBase,
    auth,
    httpHost: "127.0.0.1",
    httpPort: 0,
    httpToken: null,
  });
  const server = buildServer({ hub });
  await server.connect(new StdioServerTransport());
  console.error("ensemble MCP server listening on stdio");
}
