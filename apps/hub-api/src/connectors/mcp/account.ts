/**
 * Whose account an MCP token belongs to, for vendors whose own API says so,
 * so Settings can show "Connected as …" and a pasted token is checked against
 * the vendor as well as the MCP server. Only fixed vendor addresses are called,
 * through the same guarded fetch as the MCP server.
 */
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

type Whoami = { url: string; name: (body: Record<string, unknown>) => unknown };

const WHOAMI: Readonly<Record<string, Whoami>> = {
  huggingface: { url: "https://huggingface.co/api/whoami-v2", name: (body) => body.name },
};

const WHOAMI_TIMEOUT_MS = 10_000;

/** account: the vendor named it. refused: the vendor said the token is not valid (401). null: no such API, or no clear answer. */
export type McpAccountCheck = { account: string } | { refused: true } | null;

export async function mcpAccount(serverId: string, token: string, fetchFn: FetchLike): Promise<McpAccountCheck> {
  const whoami = Object.hasOwn(WHOAMI, serverId) ? WHOAMI[serverId] : undefined;
  if (!whoami) return null;
  try {
    const response = await fetchFn(whoami.url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(WHOAMI_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return response.status === 401 ? { refused: true } : null;
    }
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const name = whoami.name(body as Record<string, unknown>);
    return typeof name === "string" && name.trim() ? { account: name.trim().slice(0, 120) } : null;
  } catch {
    return null;
  }
}
