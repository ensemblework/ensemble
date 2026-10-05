import { DESKTOP_WEBVIEW_ORIGINS } from "./desktop-guard.js";

/**
 * Shown when the desktop app's own window calls a terminal route. The request
 * is still refused: the terminal opens only after a platform passkey check,
 * which the desktop webview cannot run yet, and the desktop token alone must
 * never be enough because agents use that token too.
 */
export const TERMINAL_DESKTOP_REFUSAL =
  "The terminal isn't available in the desktop app yet. It needs a Touch ID or Windows Hello check that the app can't run yet.";

const WEBVIEW: ReadonlySet<string> = new Set(DESKTOP_WEBVIEW_ORIGINS);

/**
 * Why a terminal request is refused, or `null` when it may go on to the
 * passkey checks. `webOrigins` is the Hub's own page (HUB_WEB_ORIGIN and its
 * localhost spelling). Only the wording of a refusal depends on whether the
 * origin is a desktop webview; nothing that was refused before is let through.
 */
export function humanOnlyRefusal(input: { authVia: string | undefined; origin: string | undefined; webOrigins: readonly string[] }): string | null {
  if (input.authVia !== "session" && input.authVia !== "desktop") return "The terminal only opens from a signed-in browser. Tokens and agents are refused.";
  const origin = input.origin;
  if (!origin || !input.webOrigins.includes(origin)) {
    return origin && WEBVIEW.has(origin) ? TERMINAL_DESKTOP_REFUSAL : "The terminal only accepts requests from the Ensemble page itself.";
  }
  const page = new URL(origin);
  if (page.hostname !== "localhost") return notLocalhostRefusal(page);
  return null;
}

function bare(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * The refusal for the Hub's own page on a hostname other than `localhost`.
 * Same three cases and words as hub-web `components/code/terminal-address.ts`,
 * so the server never says "IP address" to a domain.
 */
export function notLocalhostRefusal(page: { protocol: string; hostname: string; port: string }): string {
  const host = bare(page.hostname);
  const ipv4 = isIpv4(host);
  const ip = ipv4 || host.includes(":");
  const loopback = ipv4 ? host.startsWith("127.") : host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("::ffff:127.");
  if (loopback) {
    const here = `${page.protocol}//localhost${page.port ? `:${page.port}` : ""}`;
    return `Passkeys need a named, secure address and do not work on an IP address. Open Ensemble at ${here} to use the terminal.`;
  }
  if (ip) {
    return "Passkeys need a named, secure address and do not work on an IP address. The terminal opens only on the computer running Ensemble, at its localhost address.";
  }
  return `The terminal is not available at ${host} yet. It opens only on the computer running Ensemble, at its localhost address, where Touch ID can unlock it.`;
}
