import { VERSION } from "./version.js";
import { fetchJson, readResponseBody, type FetchLike } from "./http.js";

export type DeviceStartResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type DeviceTokenResponse = {
  token: string;
  tokenId?: string;
  scopes: string[];
  account?: { email?: string | null; name?: string | null };
  apiBase?: string;
  appUrl?: string;
  pairingCode?: string;
  pairingExpiresAt?: string;
};

export class DeviceFlowError extends Error {
  constructor(readonly code: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "unexpected", message: string) {
    super(message);
  }
}

export async function startDeviceFlow(input: {
  apiBase: string;
  clientName: string;
  platform: string;
  scopes: string[];
  fetchImpl?: FetchLike;
}): Promise<DeviceStartResponse> {
  return fetchJson<DeviceStartResponse>(
    `${input.apiBase}/api/cli/auth/start`,
    {
      method: "POST",
      body: JSON.stringify({
        clientName: input.clientName.slice(0, 80),
        platform: input.platform.slice(0, 32),
        version: VERSION.slice(0, 32),
        scopes: input.scopes,
      }),
    },
    input.fetchImpl,
  );
}

export async function pollDeviceToken(input: {
  apiBase: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
  fetchImpl?: FetchLike;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<DeviceTokenResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? (() => Date.now());
  let interval = Math.max(1, input.interval || 5);
  const expiresAt = now() + Math.max(1, input.expiresIn || 600) * 1000;
  while (now() < expiresAt) {
    await wait(interval * 1000);
    const response = await fetchImpl(`${input.apiBase}/api/cli/auth/token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: input.deviceCode }),
    });
    const body = await readResponseBody(response);
    if (response.ok) return body as DeviceTokenResponse;
    const error = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "unexpected";
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5;
      continue;
    }
    if (error === "access_denied") throw new DeviceFlowError("access_denied", "Login was denied.");
    if (error === "expired_token") throw new DeviceFlowError("expired_token", "Login code expired. Run `ensemble login` again.");
    throw new DeviceFlowError("unexpected", `Login failed: ${error}`);
  }
  throw new DeviceFlowError("expired_token", "Login code expired. Run `ensemble login` again.");
}
