import { DESKTOP_WEBVIEW_ORIGINS } from "./desktop-guard.js";

/**
 * Shown when the desktop app's own window calls a terminal route. The request is still refused: the
 * desktop app signs in with a token its agents use too, so it cannot show a command came from a person.
 */
export const TERMINAL_DESKTOP_REFUSAL =
  "The terminal isn't available in the desktop app yet: the app signs in with the same token its agents use. Use your computer's own terminal app.";

/** The assistant's own calls, made with the person's browser credentials, never open the terminal. */
export const TERMINAL_ASSISTANT_REFUSAL = "The assistant cannot use the terminal. Open it yourself in the Code tab.";

const WEBVIEW: ReadonlySet<string> = new Set(DESKTOP_WEBVIEW_ORIGINS);

/**
 * Why a terminal request is refused, or `null` when it may run. Only a browser signed in with a session
 * cookie, on the Hub's own page (`webOrigins`: HUB_WEB_ORIGIN and its localhost spelling), at the
 * localhost address of the computer running Ensemble. API keys, bridge and device tokens, the desktop
 * token, agents and the assistant (`injected`) are refused. Only the wording depends on the origin.
 */
export function humanOnlyRefusal(input: { authVia: string | undefined; origin: string | undefined; webOrigins: readonly string[]; injected?: boolean }): string | null {
  const tokens = "The terminal only opens from a signed-in browser. Tokens and agents are refused.";
  // The assistant calls routes with the person's own cookie and Origin; its calls are marked (lib/injected.ts).
  if (input.injected) return TERMINAL_ASSISTANT_REFUSAL;
  if (input.authVia !== "session" && input.authVia !== "desktop") return tokens;
  const origin = input.origin;
  if (origin && WEBVIEW.has(origin)) return TERMINAL_DESKTOP_REFUSAL;
  // The desktop token is not a person: its agents use it too.
  if (input.authVia !== "session") return tokens;
  if (!origin || !input.webOrigins.includes(origin)) return "The terminal only accepts requests from the Ensemble page itself.";
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
 * The refusal for the Hub's own page on a hostname other than `localhost`: the terminal runs commands on
 * the computer serving Ensemble, so it opens only there. Same cases and words as hub-web
 * `components/code/terminal-address.ts`.
 */
export function notLocalhostRefusal(page: { protocol: string; hostname: string; port: string }): string {
  const host = bare(page.hostname);
  const ipv4 = isIpv4(host);
  const ip = ipv4 || host.includes(":");
  const loopback = ipv4 ? host.startsWith("127.") : host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("::ffff:127.");
  if (loopback) {
    const here = `${page.protocol}//localhost${page.port ? `:${page.port}` : ""}`;
    return `Open Ensemble at ${here} to use the terminal.`;
  }
  if (ip) return "The terminal opens only on the computer running Ensemble, at its localhost address.";
  return `The terminal is not available at ${host}. It opens only on the computer running Ensemble, at its localhost address.`;
}
