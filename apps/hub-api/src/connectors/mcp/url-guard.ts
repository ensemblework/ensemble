/**
 * Which MCP server addresses hub-api may call, and a fetch that enforces it on
 * every hop (the server, its metadata, the authorization server, redirects).
 *
 * Hosted: https only, and the host must resolve to public addresses only. The
 * connection itself is made to an address that passed the check (pinnedFetch),
 * so a DNS answer that changes after the check cannot point it elsewhere.
 * Local and desktop: https anywhere, plain http only to this computer.
 */
import { lookup } from "node:dns/promises";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isBlockedAddress } from "../../plots/ssrf.js";
import { isHosted } from "../../lib/hosted-access.js";

const MAX_REDIRECTS = 4;
const AUTH_FETCH_TIMEOUT_MS = 30_000;

export class McpUrlError extends Error {
  readonly expose = true;
  readonly statusCode = 400;
  readonly code = "MCP_URL_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "McpUrlError";
  }
}

export type LookupFn = (hostname: string) => Promise<string[]>;

export type UrlGuardOptions = {
  hosted?: boolean;
  lookup?: LookupFn;
};

const defaultLookup: LookupFn = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((row) => row.address);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
}

/** isBlockedAddress plus IPv6 forms it does not cover: mapped/compatible IPv4, NAT64, documentation, multicast. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isBlockedAddress(bare)) return true;
  if (!bare.includes(":")) return false;
  if (bare.startsWith("::")) return true;
  if (bare.startsWith("64:ff9b:") || bare.startsWith("2001:db8:") || bare.startsWith("100::") || bare.startsWith("ff")) return true;
  if (bare.startsWith("fec0") || bare.startsWith("2002:")) return true;
  return false;
}

/** Parse and check the shape of a pasted server URL. Does not resolve DNS. */
export function parseMcpUrl(raw: string, options: UrlGuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new McpUrlError("That is not a URL. Paste the server's full address, starting with https://.");
  }
  const hosted = options.hosted ?? isHosted();
  if (url.username || url.password) throw new McpUrlError("Server addresses with a username or password are refused.");
  if (url.protocol === "http:") {
    if (hosted || !isLoopbackHost(url.hostname)) {
      throw new McpUrlError("Use an https:// address. Plain http is only allowed for a server on this computer.");
    }
  } else if (url.protocol !== "https:") {
    throw new McpUrlError("Use an https:// address.");
  }
  if (hosted) {
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (isLoopbackHost(host) || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || !host.includes(".")) {
      throw new McpUrlError("That address is on a private network. Ensemble can only reach public MCP servers.");
    }
  }
  url.hash = "";
  return url;
}

/** parseMcpUrl, then on hosted resolve the host and refuse private, loopback, link-local and metadata addresses. */
export async function assertMcpUrlAllowed(raw: string | URL, options: UrlGuardOptions = {}): Promise<URL> {
  const url = parseMcpUrl(typeof raw === "string" ? raw : raw.href, options);
  const hosted = options.hosted ?? isHosted();
  if (!hosted) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new McpUrlError("That address is on a private network. Ensemble can only reach public MCP servers.");
    return url;
  }
  let addresses: string[];
  try {
    addresses = await (options.lookup ?? defaultLookup)(host);
  } catch {
    throw new McpUrlError(`${url.hostname} did not resolve. Check the address.`);
  }
  if (!addresses.length || addresses.some((address) => isPrivateAddress(address))) {
    throw new McpUrlError("That address points at a private network. Ensemble can only reach public MCP servers.");
  }
  return url;
}

/** Canonical form used for the custom server id and duplicate checks. */
export function canonicalMcpUrl(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  copy.hostname = copy.hostname.toLowerCase();
  return copy.href;
}

const PRIVATE_MESSAGE = "That address points at a private network. Ensemble can only reach public MCP servers.";

/**
 * A net/tls lookup that resolves the host and refuses the connection unless
 * every address is public. The socket connects to the address returned here.
 */
export function checkedLookup(resolve: LookupFn = defaultLookup, blocked: (address: string) => boolean = isPrivateAddress): LookupFunction {
  return ((hostname: string, options: { all?: boolean; family?: number | string } | number | undefined, callback: (...args: unknown[]) => void) => {
    const wanted = typeof options === "object" && options ? options : {};
    const family = Number(typeof options === "number" ? options : wanted.family) || 0;
    resolve(hostname)
      .then((addresses) => {
        if (!addresses.length) throw new McpUrlError(`${hostname} did not resolve. Check the address.`);
        if (addresses.some((address) => blocked(address))) throw new McpUrlError(PRIVATE_MESSAGE);
        let list = addresses.map((address) => ({ address, family: isIP(address) }));
        if (family === 4 || family === 6) list = list.filter((entry) => entry.family === family);
        if (!list.length) throw new McpUrlError(`${hostname} did not resolve. Check the address.`);
        if (wanted.all) callback(null, list);
        else callback(null, list[0]!.address, list[0]!.family);
      })
      .catch((error: unknown) => callback(error instanceof McpUrlError ? error : new McpUrlError(`${hostname} did not resolve. Check the address.`)));
  }) as LookupFunction;
}

export type PinnedFetchOptions = { lookup?: LookupFn; isBlocked?: (address: string) => boolean };

let sharedAgents: { http: HttpAgent; https: HttpsAgent } | undefined;

function agentsFor(options: PinnedFetchOptions): { http: HttpAgent; https: HttpsAgent } {
  if (!options.lookup && !options.isBlocked) {
    sharedAgents ??= (() => {
      const lookupFn = checkedLookup();
      return { http: new HttpAgent({ keepAlive: true, lookup: lookupFn }), https: new HttpsAgent({ keepAlive: true, lookup: lookupFn }) };
    })();
    return sharedAgents;
  }
  const lookupFn = checkedLookup(options.lookup, options.isBlocked);
  return { http: new HttpAgent({ lookup: lookupFn }), https: new HttpsAgent({ lookup: lookupFn }) };
}

function requestBody(body: RequestInit["body"]): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError("Unsupported request body for an MCP server request.");
}

function decoded(response: IncomingMessage): { stream: Readable; decodedFrom?: string } {
  const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
  if (!decoder) return { stream: response };
  pipeline(response, decoder, () => undefined);
  return { stream: decoder, decodedFrom: encoding };
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * fetch over node:http(s) whose sockets connect only to addresses that passed
 * checkedLookup. TLS SNI and Host stay the URL's hostname. Redirects are not
 * followed (guardedFetch follows them hop by hop). Hosted only.
 */
export function pinnedFetch(options: PinnedFetchOptions = {}): FetchLike {
  const agents = agentsFor(options);
  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const url = requestUrl(input as string | URL);
      const method = (init.method ?? "GET").toUpperCase();
      const headers = new Headers(init.headers);
      let body: Buffer | undefined;
      try {
        body = requestBody(init.body);
      } catch (error) {
        reject(error);
        return;
      }
      if (init.body instanceof URLSearchParams && !headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      if (!headers.has("accept-encoding")) headers.set("accept-encoding", "gzip, deflate, br");
      if (body) headers.set("content-length", String(body.byteLength));
      const isHttps = url.protocol === "https:";
      const send = isHttps ? httpsRequest : httpRequest;
      const request = send(
        url,
        {
          method,
          headers: Object.fromEntries(headers),
          agent: isHttps ? agents.https : agents.http,
          signal: init.signal ?? undefined,
        },
        (response) => {
          const status = response.statusCode ?? 502;
          const out = new Headers();
          for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) out.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
          if (method === "HEAD" || NULL_BODY_STATUS.has(status)) {
            response.resume();
            resolve(new Response(null, { status, statusText: response.statusMessage, headers: out }));
            return;
          }
          const { stream, decodedFrom } = decoded(response);
          if (decodedFrom) {
            out.delete("content-encoding");
            out.delete("content-length");
          }
          try {
            resolve(new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, statusText: response.statusMessage, headers: out }));
          } catch (error) {
            response.destroy();
            reject(error);
          }
        },
      );
      request.on("error", (error: Error & { cause?: unknown }) => reject(error instanceof McpUrlError ? error : error.cause instanceof McpUrlError ? error.cause : error));
      request.end(body);
    });
}

export type GuardedFetchOptions = UrlGuardOptions & { fetch?: FetchLike; isBlocked?: (address: string) => boolean };

function requestUrl(input: string | URL | Request): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  return new URL(input.url);
}

/**
 * A fetch for the MCP SDK. Each request and each redirect hop is checked with
 * assertMcpUrlAllowed. Redirects are followed by hand so a public server cannot
 * bounce a request to a private address; Authorization is dropped when a
 * redirect leaves the origin. Requests without their own signal get a timeout.
 */
export function guardedFetch(options: GuardedFetchOptions = {}): FetchLike {
  const hosted = options.hosted ?? isHosted();
  const base: FetchLike =
    options.fetch ??
    (hosted ? pinnedFetch({ ...(options.lookup ? { lookup: options.lookup } : {}), ...(options.isBlocked ? { isBlocked: options.isBlocked } : {}) }) : (url, init) => fetch(url, init));
  return async (input, init) => {
    let url = requestUrl(input as string | URL);
    let current: RequestInit = { ...(init ?? {}), redirect: "manual" };
    if (!current.signal) current.signal = AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertMcpUrlAllowed(url, { ...options, hosted });
      const response = await base(url, current);
      if (response.status < 300 || response.status >= 400 || response.status === 304) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      await response.body?.cancel().catch(() => undefined);
      const next = new URL(location, url);
      const headers = new Headers(current.headers);
      if (next.origin !== url.origin) {
        headers.delete("authorization");
        headers.delete("cookie");
      }
      const method = (current.method ?? "GET").toUpperCase();
      if ((response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) && method !== "HEAD") {
        headers.delete("content-type");
        current = { ...current, method: "GET", body: undefined, headers };
      } else {
        current = { ...current, headers };
      }
      url = next;
    }
    throw new McpUrlError("The server redirected too many times.");
  };
}
