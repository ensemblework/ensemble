/**
 * Ensemble spaces for MCP tools (docs/CONTEXT_BRIDGE.md §4): every Ensemble tool takes an optional
 * `space` (an id or exact name). The call's hub requests then carry it as `x-ensemble-space`, and
 * hub-api checks on each one that the key's account owns that space.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HubCallOptions, HubClient } from "./hub.js";

/** Names compare as Ensemble's space switcher compares them: Unicode NFKC, spaces collapsed, any case. */
export const spaceNameKey = (name: string): string => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

export const SPACE_ARG = z
  .string()
  .max(200)
  .optional()
  .describe("The Ensemble space to work in: its id or exact name (ensemble_spaces lists them). Default: the key's own space.");

interface ListedSpace {
  id: string;
  name: string;
  usable?: boolean;
  refusal?: string;
}

interface SpaceList {
  crossSpace?: boolean;
  spaces?: ListedSpace[];
  note?: string;
}

const LIST_FOR_MS = 30_000;

/** A space's id or exact name to its id, from `GET /api/bridge/spaces` (kept for 30 seconds). */
export function spaceResolver(hub: HubClient): (wanted: string) => Promise<string> {
  let cached: { at: number; list: Promise<SpaceList> } | null = null;
  const list = (): Promise<SpaceList> => {
    if (!cached || Date.now() - cached.at > LIST_FOR_MS) {
      const asked = hub.get("/api/bridge/spaces") as Promise<SpaceList>;
      cached = { at: Date.now(), list: asked };
      asked.catch(() => {
        cached = null;
      });
    }
    return cached.list;
  };
  return async (wanted) => {
    const answer = await list();
    const spaces = Array.isArray(answer?.spaces) ? answer.spaces : [];
    const byId = spaces.filter((space) => space.id === wanted);
    const named = byId.length ? byId : spaces.filter((space) => spaceNameKey(space.name) === spaceNameKey(wanted));
    if (named.length > 1) throw new Error(`More than one space is called “${wanted}”: name it by id (${named.map((space) => space.id).join(", ")}).`);
    const found = named[0];
    if (found) {
      if (found.usable === false) throw new Error(`“${found.name}”: ${found.refusal ?? "this key cannot act there."}`);
      return found.id;
    }
    if (answer?.crossSpace === false && answer.note) throw new Error(answer.note);
    const known = spaces.map((space) => `“${space.name}”`).join(", ");
    throw new Error(`This key's account has no space “${wanted}”.${known ? ` Its spaces: ${known}.` : ""}`);
  };
}

/** The hub client the tools use: a request made while a tool runs in a space carries that space. */
export function scopedHub(base: HubClient, current: () => string | undefined): HubClient {
  const at = (options?: HubCallOptions): HubCallOptions | undefined => {
    const space = current();
    return space ? { ...options, space } : options;
  };
  const post = base.post?.bind(base);
  const patch = base.patch?.bind(base);
  const download = base.download?.bind(base);
  return {
    get: (path, query, options) => base.get(path, query, at(options)),
    ...(post ? { post: (path: string, body: unknown, options?: HubCallOptions) => post(path, body, at(options)) } : {}),
    ...(patch ? { patch: (path: string, body: unknown, options?: HubCallOptions) => patch(path, body, at(options)) } : {}),
    ...(download ? { download: (path: string, options?: HubCallOptions) => download(path, at(options)) } : {}),
  };
}

type RegisterTool = McpServer["registerTool"];
type LooseConfig = { inputSchema?: Record<string, unknown> } & Record<string, unknown>;
type LooseCallback = (args: Record<string, unknown>, extra: unknown) => unknown;

function refused(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

/**
 * `server.registerTool` for Ensemble's tools: each gets an optional `space`, resolved to an id before
 * the call and kept in `scope` while it runs, so every hub request it makes carries that space.
 */
export function spacedRegistrar(server: McpServer, resolve: (wanted: string) => Promise<string>, scope: AsyncLocalStorage<string>): RegisterTool {
  const register = server.registerTool.bind(server) as unknown as (name: string, config: LooseConfig, cb: LooseCallback) => ReturnType<RegisterTool>;
  const spaced = (name: string, config: LooseConfig, cb: LooseCallback) =>
    register(name, { ...config, inputSchema: { ...(config.inputSchema ?? {}), space: SPACE_ARG } }, async (args, extra) => {
      const { space, ...rest } = args;
      const wanted = typeof space === "string" ? space.trim() : "";
      if (!wanted) return cb(rest, extra);
      let id: string;
      try {
        id = await resolve(wanted);
      } catch (error) {
        return refused(error);
      }
      return scope.run(id, () => cb(rest, extra));
    });
  return spaced as unknown as RegisterTool;
}
