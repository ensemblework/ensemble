/**
 * A node's secret request, answered from the Hub's Needs me (docs/35 §8.7). The value is encrypted in
 * this browser for the computer's own key (`sealFor`, the same format as the Ensemble Node website),
 * so Ensemble's server only relays ciphertext. A computer too old for a key gets it over HTTPS through
 * the server, and the card says so plainly; one whose key changed must be paired again first.
 */
import { sealFingerprint, sealFor, type SealKeyInfo, type Sealed } from "@ensemble/shared-types";

/** `GET /api/node/secrets/:id`: the card's computer and how a value would reach it. */
export type SecretTarget = {
  id: string;
  name: string;
  status: string;
  computer: { id: string; name: string; online: boolean };
  route: { mode: "sealed"; sealKey: SealKeyInfo } | { mode: "tls" } | { mode: "pair_again" };
  ttlMs: number;
  /** Destinations the node suggested. */
  allow: string[];
};

export type SecretAnswer = { sealed: Sealed } | { value: string; allow?: string[] };

/** The destinations typed into the card: origins, one per line or comma-separated. */
export function parseAllow(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))].slice(0, 20);
}

/** What the card says about how the value travels. Accurate, not reassuring: TLS through the server is not end to end. */
export function routeText(target: Pick<SecretTarget, "route" | "computer">, fingerprint: string | null): string {
  const computer = target.computer.name;
  if (target.route.mode === "sealed") {
    return `Encrypted in this browser for ${computer}: only ${computer} can read it, and Ensemble's server passes it on without being able to.${fingerprint ? ` Key ${fingerprint}: it should match \`ensemble secrets fingerprint\` on ${computer}.` : ""}`;
  }
  if (target.route.mode === "tls") return `Sent over HTTPS to Ensemble's server, which passes it to ${computer} without keeping it. ${computer} is too old for end-to-end encryption; update Ensemble there.`;
  return `${computer} now reports a different key from the one it was paired with, so nothing is sent to it. Pair it again (\`ensemble login\`), then type the value again.`;
}

/** What happens to it there, with or without destinations. */
export function keptText(name: string, computer: string, allow: string[]): string {
  return allow.length
    ? `Kept encrypted on ${computer} for use by reference only: runs there send it to ${allow.join(", ")} without seeing it, and it is never put in a run's environment.`
    : `Kept encrypted on ${computer}; runs there that may have it get it as $${name}.`;
}

/** The fingerprint of the key the box is made for, worked out here from the key itself. */
export async function targetFingerprint(target: Pick<SecretTarget, "route">): Promise<string | null> {
  return target.route.mode === "sealed" ? sealFingerprint(target.route.sealKey.spki) : null;
}

/** The body for `POST /api/node/secrets/:id`: sealed for the computer, or (for a computer with no key) the value itself. */
export async function secretAnswer(target: SecretTarget, card: { id: string }, value: string, allow: string[], origin: string): Promise<SecretAnswer> {
  if (target.route.mode === "pair_again") throw new Error(routeText(target, null));
  const payload = { value, ...(allow.length ? { allow } : {}) };
  if (target.route.mode === "tls") return payload;
  const made = await sealFor(target.route.sealKey, { purpose: "secret", deviceId: target.computer.id, decisionId: card.id, name: target.name, origin }, payload, { ttlMs: target.ttlMs });
  return { sealed: made.sealed };
}
