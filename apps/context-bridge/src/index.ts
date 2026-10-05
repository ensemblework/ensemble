/**
 * Read-only MCP server (docs/CONTEXT_BRIDGE.md).
 * Talks to hub-api over HTTP. Never opens a database connection.
 * Stdio is the default. `--http` serves Streamable HTTP on loopback.
 * Logs go to stderr. Stdout is JSON-RPC.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttpServer } from "./http.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  if (process.argv.includes("--http")) {
    await startHttpServer();
    return;
  }
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ensemble context-bridge listening on stdio");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
