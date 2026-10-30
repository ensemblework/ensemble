/**
 * `ensemble secrets` (docs/26, docs/35 §8.7): the run secrets saved on this computer, where each may be
 * sent by reference, how runs here get them, and the fingerprint of the key Ensemble on the web
 * encrypts secrets for. Values only go in, never out.
 */
import { localJson, type Discovery } from "./sidecar.js";

export type SavedSecret = { name: string; updatedAt: string; allow?: string[] };
export type SecretsMode = "all" | "named";
export type SealKeyView = { kid: string; fingerprint: string; alg?: string };

export async function listSecrets(discovery: Discovery): Promise<{ secrets: SavedSecret[]; mode: SecretsMode }> {
  const result = await localJson<{ secrets?: SavedSecret[]; mode?: SecretsMode }>(discovery, "/api/run-secrets");
  return { secrets: result.secrets ?? [], mode: result.mode === "named" ? "named" : "all" };
}

export async function setSecret(discovery: Discovery, name: string, value: string, allow?: string[]): Promise<{ allow: string[] }> {
  const result = await localJson<{ allow?: string[] }>(discovery, `/api/run-secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value, ...(allow ? { allow } : {}) }) });
  return { allow: result.allow ?? [] };
}

export async function removeSecret(discovery: Discovery, name: string): Promise<void> {
  await localJson<unknown>(discovery, `/api/run-secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export async function allowSecret(discovery: Discovery, name: string, allow: string[]): Promise<string[]> {
  return (await localJson<{ allow: string[] }>(discovery, `/api/run-secrets/${encodeURIComponent(name)}/allow`, { method: "PUT", body: JSON.stringify({ allow }) })).allow;
}

export async function secretsMode(discovery: Discovery, mode?: SecretsMode): Promise<SecretsMode> {
  const result = mode
    ? await localJson<{ mode: SecretsMode }>(discovery, "/api/run-secrets/mode", { method: "PUT", body: JSON.stringify({ mode }) })
    : await localJson<{ mode: SecretsMode }>(discovery, "/api/run-secrets/mode");
  return result.mode === "named" ? "named" : "all";
}

export async function secretKey(discovery: Discovery): Promise<{ paired: boolean; sealKey: SealKeyView | null; createdAt: string | null }> {
  return localJson(discovery, "/api/run-secrets/key");
}

/** One line per secret: its name, when it changed, and how runs use it. */
export function formatSecrets(rows: SavedSecret[], mode: SecretsMode, command = "ensemble"): string {
  if (!rows.length) return `No secrets on this computer. Save one with \`${command} secrets set <NAME>\`, or when a node asks for one.\n${modeLine(mode, command)}`;
  const width = Math.max(...rows.map((row) => row.name.length));
  const lines = rows.map((row) => `${row.name.padEnd(width)}  ${row.updatedAt.slice(0, 10)}  ${row.allow?.length ? `by reference only, to ${row.allow.join(", ")}` : "in run environments ($NAME)"}`);
  return `${lines.join("\n")}\n${modeLine(mode, command)}`;
}

/** What the mode means, labelling `all` as the compatibility mode it is. */
export function modeLine(mode: SecretsMode, command = "ensemble"): string {
  return mode === "named"
    ? `Mode: named. A run gets only the secrets its run profile, task or node step names. Back to compatibility mode: \`${command} secrets mode all\`.`
    : `Mode: all (compatibility mode). A run from the web or this computer that names no secrets gets every environment secret, and a program it runs can read them; Ensemble Node runs get only what they name. Only named secrets: \`${command} secrets mode named\`.`;
}

/** The key's fingerprint as the web shows it, to compare on the secret card and in the computer's details. */
export function formatKey(key: { paired: boolean; sealKey: SealKeyView | null; createdAt: string | null }, command = "ensemble"): string {
  if (!key.paired) return `This computer is not paired, so it has no key. Pair it with \`${command} login\`.`;
  if (!key.sealKey) return "This computer has no key for encrypted secrets yet. It makes one when it next reports to Ensemble on the web (start the runner).";
  return `Fingerprint ${key.sealKey.fingerprint}\nEnsemble on the web encrypts secrets typed for this computer with this key. Check the secret card and this computer's details on the web show the same fingerprint.${key.createdAt ? `\nMade ${key.createdAt.slice(0, 10)}; a new pairing makes a new key.` : ""}`;
}
