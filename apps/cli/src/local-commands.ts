import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
  folders?: SharedFolder[];
  /** The key Ensemble on the web encrypts secrets for (docs/35 §8.7). */
  sealKey?: { kid: string; fingerprint: string } | null;
  secretsMode?: "all" | "named";
};

/** `kind` "repo": shared as a repository, so every run from the web works in its own clone of it. */
export type SharedFolder = { label: string; path: string; kind?: string; access?: string };

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

export type FolderOptions = { label?: string; readOnly?: boolean; repo?: boolean };

export type FolderRequest = { label: string; path: string; kind: "folder" | "repo"; access: "review" | "read-write" };

/**
 * What `ensemble folders add` sends. `repo`: share a git repository, worked on in a clone per run
 * (and able to end in a pull request), so the path must hold a `.git`; read-only does not apply.
 */
export function folderRequest(folderPath: string, options: FolderOptions, isRepository: (path: string) => boolean = (path) => existsSync(join(path, ".git"))): FolderRequest {
  const absolute = resolve(folderPath);
  const label = options.label?.trim() || slugLabel(absolute.split(/[\\/]/).filter(Boolean).at(-1) || "folder");
  if (options.repo) {
    if (options.readOnly) throw new Error("--read-only and --repo do not go together: runs in a repository work in their own clone, never in the folder itself.");
    if (!isRepository(absolute)) throw new Error(`${absolute} is not a git repository (it has no .git), so it cannot be shared with --repo. Leave out --repo to share it as a folder.`);
    return { label, path: absolute, kind: "repo", access: "read-write" };
  }
  return { label, path: absolute, kind: "folder", access: options.readOnly ? "review" : "read-write" };
}

export async function addFolder(discovery: Discovery, request: FolderRequest): Promise<RemoteStatus["folders"]> {
  const result = await localJson<{ folders: SharedFolder[] }>(discovery, "/api/remote/folders", {
    method: "POST",
    body: JSON.stringify(request),
  });
  return result.folders;
}

/** One `ensemble folders list` row: label, path and access, tab-separated, and "(repository)" for a repository. */
export function folderLine(folder: SharedFolder): string {
  return `${folder.label}\t${folder.path}\t${folder.access ?? ""}${folder.kind === "repo" ? "\t(repository)" : ""}`;
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

// Run secrets: secrets.ts.
