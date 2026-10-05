/**
 * Whether this page's address can open the terminal, and what to tell the
 * person when it cannot.
 *
 * Two things decide it:
 * - Browsers only run passkeys (WebAuthn) in a secure context on a named host:
 *   never on an IP address, and never on plain http other than localhost.
 * - The Hub's server only unlocks the terminal from a page whose hostname is
 *   exactly `localhost` (`humanOnlyRefusal` in hub-api). A hosted domain such
 *   as https://app.ensemblework.com is refused there, even though passkeys would
 *   work in the browser, so this file must not send people into a passkey
 *   set-up that the server will reject.
 *
 * Nothing here relaxes a check; it only picks the right words.
 */

export type PageAddress = { protocol: string; hostname: string; port: string };

export type TerminalAccess =
  | { ok: true }
  | { ok: false; reason: "loopback-ip" | "ip" | "named-host"; message: string };

function bare(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isIpv6(host: string): boolean {
  return host.includes(":");
}

export function isIpAddress(hostname: string): boolean {
  const host = bare(hostname);
  return isIpv4(host) || isIpv6(host);
}

export function isLoopbackIp(hostname: string): boolean {
  const host = bare(hostname);
  if (isIpv4(host)) return host.startsWith("127.");
  return host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("::ffff:127.");
}

/** The browser's own answer when it has one; otherwise the same rule browsers use. */
export function isSecurePage(address: PageAddress, browserSays?: boolean): boolean {
  if (typeof browserSays === "boolean") return browserSays;
  if (address.protocol === "https:") return true;
  const host = bare(address.hostname);
  return host === "localhost" || host.endsWith(".localhost") || isLoopbackIp(host);
}

export function terminalAccess(address: PageAddress, secure: boolean = isSecurePage(address)): TerminalAccess {
  const host = bare(address.hostname);
  if (host === "localhost" && secure) return { ok: true };
  if (isLoopbackIp(host)) {
    const here = `${address.protocol}//localhost${address.port ? `:${address.port}` : ""}`;
    return {
      ok: false,
      reason: "loopback-ip",
      message: `Passkeys need a named, secure address and do not work on an IP address. Open Ensemble at ${here} to use the terminal.`,
    };
  }
  if (isIpAddress(host)) {
    return {
      ok: false,
      reason: "ip",
      message:
        "Passkeys need a named, secure address and do not work on an IP address. The terminal opens only on the computer running Ensemble, at its localhost address.",
    };
  }
  return {
    ok: false,
    reason: "named-host",
    message: `The terminal is not available at ${host} yet. It opens only on the computer running Ensemble, at its localhost address, where Touch ID can unlock it.`,
  };
}

export function currentTerminalAccess(): TerminalAccess {
  if (typeof window === "undefined") return { ok: true };
  const { protocol, hostname, port } = window.location;
  const address = { protocol, hostname, port };
  return terminalAccess(address, isSecurePage(address, (window as { isSecureContext?: boolean }).isSecureContext));
}
