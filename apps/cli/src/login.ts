/**
 * Signing this computer in to ensemblework.com and out again: used by `ensemble login` and by
 * /login and /logout inside the app. The browser approves the sign-in; the computer is paired so
 * tasks assigned to it from the web run here.
 */
import { hostname } from "node:os";
import { pollDeviceToken, startDeviceFlow } from "./auth-flow.js";
import { openBrowser } from "./browser.js";
import { clearToken, loadConfig, loadToken, normalizeApiBase, saveConfig, saveToken } from "./config.js";
import { bearerHeaders, fetchJson, HttpError } from "./http.js";
import { remoteStatus } from "./local-commands.js";
import { resolveCliPaths, type CliPaths } from "./paths.js";
import { localJson, resolveSidecarDir, sidecarAvailable, withLocalApi } from "./sidecar.js";

export type LoginResult = { email: string | null; paired: boolean; name: string; hasRunner: boolean };

export async function signIn(options: {
  apiBase?: string;
  name?: string;
  mcpOnly?: boolean;
  noBrowser?: boolean;
  /** Called once with the code and the page to approve it on. */
  onCode: (code: string, url: string, opened: boolean) => void;
  signal?: AbortSignal;
  paths?: CliPaths;
}): Promise<LoginResult> {
  const paths = options.paths ?? resolveCliPaths();
  const apiBase = normalizeApiBase(options.apiBase || process.env.ENSEMBLE_API_URL);
  const sidecarDir = resolveSidecarDir(import.meta.url);
  const hasRunner = await sidecarAvailable(sidecarDir);
  const name = options.name || hostname() || "this computer";
  const scopes = options.mcpOnly ? ["mcp"] : hasRunner ? ["mcp", "runner"] : ["mcp"];
  const start = await startDeviceFlow({ apiBase, clientName: name, platform: process.platform, scopes });
  const url = start.verificationUriComplete || start.verificationUri;
  const opened = options.noBrowser ? false : openBrowser(url);
  options.onCode(start.userCode, url, opened);
  const token = await pollDeviceToken({ apiBase, deviceCode: start.deviceCode, interval: start.interval, expiresIn: start.expiresIn, signal: options.signal });
  const finalApi = normalizeApiBase(token.apiBase || apiBase);
  await saveToken(token.token, paths);
  await saveConfig(
    {
      apiBase: finalApi,
      appUrl: token.appUrl?.replace(/\/+$/, "") || "https://ensemblework.com",
      account: token.account ?? null,
      tokenId: token.tokenId ?? null,
      deviceName: name,
      pairedAt: null,
    },
    paths,
  );
  if (token.pairingCode && hasRunner && !options.mcpOnly) {
    await withLocalApi({
      sidecarDir,
      paths,
      apiBase: finalApi,
      adminOnly: true,
      run: async (discovery) => {
        // The desktop app may have paired this computer already: same data folder, same device.
        const current = await remoteStatus(discovery).catch(() => null);
        if (!(current?.paired && normalizeApiBase(current.apiBase || "") === finalApi)) {
          await localJson(discovery, "/api/remote/pair", { method: "POST", body: JSON.stringify({ apiBase: finalApi, code: token.pairingCode, name }) });
        }
        await localJson(discovery, "/api/remote", { method: "PUT", body: JSON.stringify({ enabled: true }) });
      },
    });
    const config = await loadConfig(paths);
    await saveConfig({ ...config, pairedAt: new Date().toISOString() }, paths);
  }
  const paired = Boolean((await loadConfig(paths)).pairedAt);
  return { email: token.account?.email ?? null, paired, name, hasRunner };
}

/** Revokes this computer's key (when the server can be reached), unpairs it, and forgets the sign-in. Returns warnings. */
export async function signOut(paths: CliPaths = resolveCliPaths()): Promise<string[]> {
  const warnings: string[] = [];
  const config = await loadConfig(paths);
  const token = await loadToken(paths);
  if (token) {
    try {
      await fetchJson(`${config.apiBase}/api/cli/logout`, { method: "POST", headers: bearerHeaders(token) });
    } catch (error) {
      if (!(error instanceof HttpError && (error.status === 401 || error.status === 404))) {
        const reason = error instanceof Error ? error.message : String(error);
        const keyName = config.deviceName ? `"Ensemble CLI on ${config.deviceName}"` : "the Ensemble CLI key";
        warnings.push(`Could not revoke this computer's key on ${config.apiBase} (${reason}). It is removed from this computer; to revoke it on the server, delete ${keyName} under Connect your apps in Ensemble.`);
      }
    }
  }
  const sidecarDir = resolveSidecarDir(import.meta.url);
  if (await sidecarAvailable(sidecarDir)) {
    try {
      await withLocalApi({ sidecarDir, paths, adminOnly: true, run: (discovery) => localJson(discovery, "/api/remote/unpair", { method: "POST" }) });
    } catch (error) {
      warnings.push(`Could not unpair the local runner: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await clearToken(paths);
  await saveConfig({ ...config, account: null, tokenId: null, pairedAt: null }, paths);
  return warnings;
}
