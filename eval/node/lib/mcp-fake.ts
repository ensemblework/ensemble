/**
 * A connected app for a task, with no real account behind it: a small MCP server on 127.0.0.1 (the
 * streamable HTTP transport, answering JSON) whose tools answer from fixed data and record every call.
 * The owner connects it as a remote MCP connection, as they would a real app's server.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  run: (args: Record<string, unknown>) => string;
};

export type FakeCall = { tool: string; args: Record<string, unknown>; at: string };

export type FakeMcp = { url: string; token: string; calls: () => FakeCall[]; close: () => Promise<void> };

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** One JSON-RPC message's answer, or null for a notification (no id). */
export function answer(server: { name: string; tools: FakeTool[]; calls: FakeCall[] }, message: RpcRequest): Record<string, unknown> | null {
  if (message.id === undefined || message.id === null) return null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
  const failure = (code: number, text: string) => ({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
  const params = record(message.params);
  switch (message.method) {
    case "initialize":
      return reply({ protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: server.name, version: "1.0.0" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: server.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: tool.readOnly === true } })) });
    case "tools/call": {
      const tool = server.tools.find((row) => row.name === params.name);
      if (!tool) return failure(-32602, `Unknown tool ${String(params.name)}`);
      const args = record(params.arguments);
      server.calls.push({ tool: tool.name, args, at: new Date().toISOString() });
      return reply({ content: [{ type: "text", text: tool.run(args) }], isError: false });
    }
    default:
      return failure(-32601, `Method not found: ${String(message.method)}`);
  }
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakeMcp(input: { name: string; token: string; tools: FakeTool[] }): Promise<FakeMcp> {
  const calls: FakeCall[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${input.token}`) {
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" }).end();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await body(request));
      } catch {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
        return;
      }
      const messages = (Array.isArray(parsed) ? parsed : [parsed]) as RpcRequest[];
      const answers = messages.map((message) => answer({ name: input.name, tools: input.tools, calls }, message)).filter((row): row is Record<string, unknown> => row !== null);
      if (!answers.length) {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]));
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token: input.token,
    calls: () => [...calls],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
