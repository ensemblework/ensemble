/**
 * A node's `computer_http`: one request to a development server on this computer. Only http and
 * https, never a user name or password in the address, and every address the host name resolves to
 * must be this computer's own (loopback); the connection goes to the address that was checked, so a
 * name cannot change its answer in between. Redirects are followed by hand, each checked the same way.
 * Ensemble's own local API is off limits. The answer is cut to 64 KB and redacted.
 */
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { GuardError } from "../workspace/guard.js";
import { localApiUrl } from "../workspace/engines/registry.js";
import { NODE_TOOL_INLINE_BYTES, type NodeToolRequest } from "../remote/contract.js";
import { cleanOutput } from "./run.js";

type HttpRequest = Extract<NodeToolRequest, { tool: "http" }>;

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;

/** This computer's own addresses: 127.0.0.0/8 and ::1 (also as IPv4-mapped IPv6). */
export function loopbackAddress(address: string): boolean {
  const plain = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(plain) === 4) return plain.split(".")[0] === "127";
  if (isIP(plain) === 6) {
    if (plain === "::1" || plain === "0:0:0:0:0:0:0:1") return true;
    const mapped = /^(?:0:0:0:0:0:ffff:|::ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(plain);
    return Boolean(mapped && mapped[1]!.split(".")[0] === "127");
  }
  return false;
}

/** Tests resolve names without DNS. */
let resolveName: (host: string) => Promise<string[]> = async (host) => (await lookup(host, { all: true, verbatim: true })).map((row) => row.address);
export function setResolverForTests(resolver: ((host: string) => Promise<string[]>) | null): void {
  resolveName = resolver ?? (async (host) => (await lookup(host, { all: true, verbatim: true })).map((row) => row.address));
}

/** Ensemble's own local API, when this runtime knows its port. */
function ownPort(): string | null {
  try {
    return new URL(localApiUrl()).port;
  } catch {
    return null;
  }
}

/** The address checked: the URL, and the loopback address to connect to. Refused unless every address is loopback. */
export async function checkTarget(raw: string): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GuardError("That is not a web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new GuardError(`${url.protocol.replace(/:$/, "")} addresses are not fetched: http and https on this computer only.`);
  if (url.username || url.password) throw new GuardError("An address with a user name or password is not fetched.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolveName(host).catch(() => [] as string[]);
  if (!addresses.length) throw new GuardError(`${host} could not be resolved.`);
  const outside = addresses.find((address) => !loopbackAddress(address));
  if (outside) throw new GuardError(`computer_http reaches only development servers on this computer (localhost); ${host} is ${outside}.`);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (port === ownPort()) throw new GuardError("Ensemble's own local API is off limits.");
  return { url, address: addresses[0]! };
}

type Reply = { status: number; headers: Record<string, string>; body: Buffer; truncated: boolean };

function send(target: { url: URL; address: string }, method: string, body: string | undefined, contentType: string | undefined): Promise<Reply> {
  const { url, address } = target;
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requester(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: { "user-agent": "Ensemble Node", accept: "*/*", ...(body !== undefined ? { "content-type": contentType ?? "application/json", "content-length": Buffer.byteLength(body) } : {}) },
        // Connect to the address that was checked, whatever the name resolves to now.
        lookup: ((_host: string, options: { all?: boolean }, callback: (error: Error | null, address: unknown, family?: number) => void) => {
          const family = isIP(address) === 6 ? 6 : 4;
          if (options?.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        }) as never,
        // A development server's certificate is usually its own.
        rejectUnauthorized: false,
        timeout: TIMEOUT_MS,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          if (size >= NODE_TOOL_INLINE_BYTES) {
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        const done = () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) if (typeof value === "string") headers[key] = value;
          const all = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers, body: all.subarray(0, NODE_TOOL_INLINE_BYTES), truncated: truncated || all.length > NODE_TOOL_INLINE_BYTES });
        };
        res.on("end", done);
        res.on("close", done);
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`No answer within ${TIMEOUT_MS / 1000} s.`)));
    req.on("error", reject);
    req.end(body);
  });
}

/** The request, with each redirect checked like the first address. */
export async function fetchLoopback(request: Pick<HttpRequest, "url" | "method" | "body" | "contentType">): Promise<{ status: number; url: string; headers: Record<string, string>; body: string; binary: boolean; truncated: boolean; redirects: number }> {
  let target = await checkTarget(request.url);
  let method = request.method;
  let body = request.body;
  for (let redirects = 0; ; redirects += 1) {
    const reply = await send(target, method, body, request.contentType);
    const location = reply.headers.location;
    if (reply.status >= 300 && reply.status < 400 && location) {
      if (redirects >= MAX_REDIRECTS) throw new GuardError(`More than ${MAX_REDIRECTS} redirects.`);
      target = await checkTarget(new URL(location, target.url).href).catch((error: unknown) => {
        throw new GuardError(`A redirect was refused: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (reply.status === 303 || ((reply.status === 301 || reply.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    const type = reply.headers["content-type"] ?? "";
    const binary = reply.body.includes(0) && !/^text\/|json|xml|javascript/.test(type);
    const keep = ["content-type", "content-length", "location", "cache-control", "server", "x-powered-by"];
    return {
      status: reply.status,
      url: target.url.href,
      headers: Object.fromEntries(Object.entries(reply.headers).filter(([key]) => keep.includes(key))),
      body: binary ? `[${reply.body.length} bytes of binary content]` : cleanOutput(reply.body.toString("utf8")),
      binary,
      truncated: reply.truncated,
      redirects,
    };
  }
}

export async function runNodeHttp(request: HttpRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await fetchLoopback(request);
  await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "agent", action: "node.tool.http", payload: { nodeId: request.nodeId, method: request.method, origin: new URL(result.url).origin, status: result.status, operationId: request.operationId ?? null } }).catch(() => undefined);
  return { status: 200, body: result };
}
