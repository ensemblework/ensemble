import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { assertLoopbackHost, loadBridgeConfig } from "./config.js";
import { buildServer, type BridgeDeps } from "./server.js";

export interface HttpBridge {
  url: string;
  close: () => Promise<void>;
}

function authorized(req: IncomingMessage, token: string | null): boolean {
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

/**
 * Streamable HTTP on loopback. Stateless: each request gets its own MCP server.
 * The Hub token stays in this process; clients do not send it.
 * Set CONTEXT_BRIDGE_HTTP_TOKEN to require a bearer on /mcp as well.
 */
export async function startHttpServer(deps: BridgeDeps = {}, env = process.env): Promise<HttpBridge> {
  const config = loadBridgeConfig(env);
  assertLoopbackHost(config.httpHost);
  const server = createServer(async (req, res) => {
    try {
      await handle(req, res, config.httpToken, deps);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`context-bridge http error: ${message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Context Bridge request failed." }));
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.httpPort, config.httpHost, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.httpPort;
  const host = config.httpHost === "::1" ? "[::1]" : config.httpHost;
  console.error(`ensemble context-bridge streamable http on http://${host}:${port}/mcp`);
  return {
    url: `http://${host}:${port}/mcp`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, httpToken: string | null, deps: BridgeDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "context-bridge", transport: "streamable-http" }));
    return;
  }
  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found." }));
    return;
  }
  if (!authorized(req, httpToken)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Context Bridge HTTP token required." }));
    return;
  }
  const mcp = buildServer(deps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
}
