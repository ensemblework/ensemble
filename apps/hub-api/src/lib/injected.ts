/**
 * Requests Ensemble makes to itself on someone's behalf with their own browser credentials: the
 * assistant's route-backed tools (`assistant/request.ts`) forward the person's cookie and Origin into
 * `app.inject`, so a route cannot tell them from the browser by those alone. They carry this header,
 * whose value is a secret of this process; a real request never knows it, and the request hook drops
 * the header from every request that does not carry the secret (`app.ts`). Routes for the person alone
 * (the terminal: `lib/terminal-human.ts`, `devices/web-person.ts`) refuse a marked request.
 */
import { randomBytes } from "node:crypto";

export const INJECTED_HEADER = "x-ensemble-injected";
const MARK = randomBytes(24).toString("hex");

/** The header an in-process call on someone's behalf adds. */
export function injectedHeaders(): Record<string, string> {
  return { [INJECTED_HEADER]: MARK };
}

/** This request came from Ensemble itself (the assistant), not the person's browser. */
export function isInjected(headers: Record<string, string | string[] | undefined>): boolean {
  return headers[INJECTED_HEADER] === MARK;
}

/** Drops the header from a request that does not carry this process's secret, so no caller can claim or fake it. */
export function dropForgedInjection(headers: Record<string, string | string[] | undefined>): void {
  if (INJECTED_HEADER in headers && !isInjected(headers)) delete headers[INJECTED_HEADER];
}
