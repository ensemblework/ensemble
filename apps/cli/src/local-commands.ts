import { resolve } from "node:path";
import { localJson, withLocalApi, type Discovery } from "./sidecar.js";
import { slugLabel } from "./slug.js";
import { readSecret } from "./secret.js";

export const PROVIDERS = ["google", "openai", "anthropic", "mistral", "kimi", "qwen", "openrouter", "copilot", "cursor", "ollama"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export type RemoteStatus = {
  apiBase?: string | null;
  deviceName?: string | null;
  paired?: boolean;
  enabled?: boolean;
  folders?: Array<{ label: string; path: string; kind?: string; access?: string }>;
};

export type ModelKeys = {
  credentials?: Array<{ provider?: string; source?: string; hint?: string | null; updatedAt?: string | null }>;
};

export function assertProvider(value: string): asserts value is ProviderName {
  if (!(PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(`Unknown provider "${value}". Supported providers: ${PROVIDERS.join(", ")}`);
  }
}

export async function remoteStatus(discovery: Discovery): Promise<RemoteStatus> {
  return localJson<RemoteStatus>(discovery, "/api/remote");
}

export async function listFolders(discovery: Discovery): Promise<RemoteStatus["folders"]> {
  return (await remoteStatus(discovery)).folders ?? [];
}

export async function addFolder(discovery: Discovery, folderPath: string, options: { label?: string; readOnly?: boolean }): Promise<RemoteStatus["folders"]> {
  const absolute = resolve(folderPath);
  const label = options.label?.trim() || slugLabel(absolute.split(/[\\/]/).filter(Boolean).at(-1) || "folder");
  const result = await localJson<{ folders: NonNullable<RemoteStatus["folders"]> }>(discovery, "/api/remote/folders", {
    method: "POST",
    body: JSON.stringify({ label, path: absolute, kind: "folder", access: options.readOnly ? "review" : "read-write" }),
  });
  return result.folders;
}

export async function removeFolder(discovery: Discovery, label: string): Promise<void> {
  await localJson<unknown>(discovery, `/api/remote/folders/${encodeURIComponent(label)}`, { method: "DELETE" });
}

export async function listKeys(discovery: Discovery): Promise<ModelKeys["credentials"]> {
  return (await localJson<ModelKeys>(discovery, "/api/model-keys")).credentials ?? [];
}

export async function setKey(discovery: Discovery, provider: string): Promise<void> {
  assertProvider(provider);
  const apiKey = await readSecret(`Enter ${provider} API key: `);
  if (!apiKey) throw new Error("No API key provided.");
  await localJson<unknown>(discovery, `/api/model-keys/${encodeURIComponent(provider)}`, {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
}

export async function removeKey(discovery: Discovery, provider: string): Promise<void> {
  assertProvider(provider);
  await localJson<unknown>(discovery, `/api/model-keys/${encodeURIComponent(provider)}`, { method: "DELETE" });
}

export async function withAdminApi<T>(input: {
  sidecarDir: string;
  apiBase?: string;
  run: (discovery: Discovery) => Promise<T>;
}): Promise<T> {
  return withLocalApi({ sidecarDir: input.sidecarDir, apiBase: input.apiBase, adminOnly: true, run: input.run });
}
