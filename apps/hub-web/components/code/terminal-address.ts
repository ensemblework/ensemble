/**
 * Whether this page's address can open this Ensemble's own terminal, and what to tell the person when it
 * cannot. The Hub's server runs it only from a page whose hostname is exactly `localhost`
 * (`humanOnlyRefusal` in hub-api): the commands run on the computer serving Ensemble. A paired computer's
 * terminal opens from Ensemble on the web through the devices routes instead.
 *
 * Nothing here relaxes a check; it only picks the right words, the same as the server's.
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

export function terminalAccess(address: PageAddress): TerminalAccess {
  const host = bare(address.hostname);
  if (host === "localhost") return { ok: true };
  if (isLoopbackIp(host)) {
    const here = `${address.protocol}//localhost${address.port ? `:${address.port}` : ""}`;
    return {
      ok: false,
      reason: "loopback-ip",
      message: `Open Ensemble at ${here} to use the terminal.`,
    };
  }
  if (isIpAddress(host)) {
    return {
      ok: false,
      reason: "ip",
      message: "The terminal opens only on the computer running Ensemble, at its localhost address.",
    };
  }
  return {
    ok: false,
    reason: "named-host",
    message: `The terminal is not available at ${host}. It opens only on the computer running Ensemble, at its localhost address.`,
  };
}

export function currentTerminalAccess(): TerminalAccess {
  if (typeof window === "undefined") return { ok: true };
  const { protocol, hostname, port } = window.location;
  return terminalAccess({ protocol, hostname, port });
}
