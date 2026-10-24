import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRANCH_NAME, pullRequestBaseRefusal } from "@ensemble/shared-types";
import { COMMAND } from "./channel.js";
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
  /** Branches runs here may open pull requests into. Missing from runtimes that cannot open them. */
  pullRequestBases?: string[];
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

// ── pull request bases (`ensemble git bases`) ──────────────────────────────────────────────

const MAX_BASES = 20;

export type GitBasesPlan = { action: "list" } | { action: "add" | "remove"; branch: string };

export const GIT_BASES_USAGE = `Usage: ${COMMAND} git bases [list] | add <branch> | remove <branch>`;

/** The arguments after `git bases`. */
export function parseGitBasesArgs(args: readonly string[]): GitBasesPlan {
  const [action = "list", branch, ...extra] = args;
  if (action === "list" && branch === undefined) return { action };
  if ((action === "add" || action === "remove") && branch?.trim() && !extra.length) return { action, branch: branch.trim() };
  throw new Error(GIT_BASES_USAGE);
}

/** Throws unless git accepts `branch` as a name and it is never production or a deploy pointer. */
export function checkBase(branch: string): void {
  if (!BRANCH_NAME.test(branch)) throw new Error(`“${branch.slice(0, 80)}” is not a branch name git accepts.`);
  const never = pullRequestBaseRefusal(branch, [branch]);
  if (never) throw new Error(never);
}

/** The list after adding or removing `branch`. */
export function basesChange(current: readonly string[], action: "add" | "remove", branch: string): string[] {
  if (action === "remove") return current.filter((base) => base !== branch);
  checkBase(branch);
  if (current.includes(branch)) return [...current];
  if (current.length >= MAX_BASES) throw new Error(`This computer allows at most ${MAX_BASES} bases. Remove one first.`);
  return [...current, branch];
}

/** "into testing, develop", or "off" when runs here open no pull requests (`ensemble status`, `/status`). */
export function basesSummary(bases: readonly string[]): string {
  return bases.length ? `into ${bases.join(", ")}` : "off";
}

/** What `ensemble git bases` says about the list. */
export function basesSentence(bases: readonly string[]): string {
  return bases.length
    ? `Runs on this computer may open pull requests into: ${bases.join(", ")}.`
    : `Runs on this computer open no pull requests. Allow a branch with \`${COMMAND} git bases add <branch>\`.`;
}

function basesOf(status: RemoteStatus): string[] {
  if (!Array.isArray(status.pullRequestBases)) {
    throw new Error(`Ensemble on this computer is too old to open pull requests. Update it (\`${COMMAND} update\`, or the Ensemble app's update), then try again.`);
  }
  return status.pullRequestBases;
}

export async function pullRequestBases(discovery: Discovery): Promise<string[]> {
  return basesOf(await remoteStatus(discovery));
}

/** Saves the list (loopback only). The runtime refuses main, master, production and testing-live too. */
export async function setPullRequestBases(discovery: Discovery, bases: readonly string[]): Promise<string[]> {
  return basesOf(await localJson<RemoteStatus>(discovery, "/api/remote", { method: "PUT", body: JSON.stringify({ pullRequestBases: bases }) }));
}

/** Runs `ensemble git bases …` against this computer's runtime and says what the list is now. */
export async function gitBases(discovery: Discovery, plan: GitBasesPlan): Promise<string> {
  const current = await pullRequestBases(discovery);
  if (plan.action === "list") return basesSentence(current);
  const next = basesChange(current, plan.action, plan.branch);
  if (next.length === current.length) {
    return `${plan.action === "add" ? `${plan.branch} is already allowed.` : `${plan.branch} was not allowed.`} ${basesSentence(current)}`;
  }
  const saved = await setPullRequestBases(discovery, next);
  return `${plan.action === "add" ? "Added" : "Removed"} ${plan.branch}. ${basesSentence(saved)}`;
}

export async function withAdminApi<T>(input: {
  sidecarDir: string;
  apiBase?: string;
  run: (discovery: Discovery) => Promise<T>;
}): Promise<T> {
  return withLocalApi({ sidecarDir: input.sidecarDir, apiBase: input.apiBase, adminOnly: true, run: input.run });
}
