/**
 * Who may use the web terminal and the other person-only routes (docs/16 §5, docs/25 §4.8): a person
 * signed in to Ensemble's own page in a browser, with a session cookie. No API key, bridge or device
 * token, agent, MCP client or internal call has one, and the assistant's own calls with the person's
 * cookie are marked (`lib/injected.ts`), so they are all refused here.
 */
import type { FastifyRequest } from "fastify";
import { env } from "../config.js";
import { isInjected } from "../lib/injected.js";
import { TERMINAL_ASSISTANT_REFUSAL } from "../lib/terminal-human.js";

class Refused extends Error {
  readonly expose = true;
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function origins(): string[] {
  const base = env.HUB_WEB_ORIGIN.replace(/\/$/, "");
  return [...new Set([base, base.replace("127.0.0.1", "localhost")])];
}

/**
 * Refuses anything but a person signed in to Ensemble's own page in a browser. A change must name the
 * page as its `Origin`; browsers leave `Origin` off a same-origin GET, so a read may come without one,
 * but never with another page's.
 */
export function requireWebPerson(request: FastifyRequest): void {
  if (isInjected(request.headers)) throw new Refused(403, TERMINAL_ASSISTANT_REFUSAL);
  if (request.authVia !== "session") throw new Refused(403, "The terminal opens only from Ensemble in your browser, signed in. Keys, agents and the assistant are refused.");
  const origin = request.headers.origin;
  const read = request.method === "GET" || request.method === "HEAD";
  if (origin ? !origins().includes(origin) : !read) throw new Refused(403, "The terminal only accepts requests from the Ensemble page itself.");
}
