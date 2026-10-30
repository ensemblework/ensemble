/**
 * A sign-in card, answered from the Hub's Needs me (B11, docs/35 §8.16): a tab on the owner's computer
 * waits for them to sign in to a site. They pick the login saved on that computer, sign in on the
 * computer itself, or type the login here: encrypted in this browser for the computer's own key
 * (`sealFor`, purpose `login`, the same format as the Ensemble Node website), so Ensemble's server only
 * relays ciphertext. The computer fills the page; no node or model sees what was typed.
 */
import { sealFingerprint, sealFor, type SealKeyInfo, type Sealed } from "@ensemble/shared-types";

/** `GET /api/node/logins/:id`: the card's computer, how typed values reach it, and what it offers. */
export type LoginTarget = {
  id: string;
  status: string;
  origin: string;
  loginId: string;
  computer: { id: string; name: string; online: boolean };
  route: { mode: "sealed"; sealKey: SealKeyInfo } | { mode: "pair_again" } | { mode: "unsupported" };
  saved: boolean;
  display: boolean;
  takeover: boolean;
  ttlMs: number;
};

export type LoginAnswer = { action: "saved" | "local" | "done" | "decline" } | { action: "typed"; sealed: Sealed };

export type TypedLogin = { username: string; password: string; code?: string; save: boolean };

/** How typed values travel, said plainly. */
export function loginRouteText(target: Pick<LoginTarget, "route" | "computer">, fingerprint: string | null, cli = "ensemble"): string {
  const computer = target.computer.name;
  if (target.route.mode === "sealed") return `Encrypted in this browser for ${computer}: only ${computer} can read it, and Ensemble's server passes it on without being able to.${fingerprint ? ` Key ${fingerprint}: it should match \`${cli} secrets fingerprint\` on ${computer}.` : ""}`;
  if (target.route.mode === "pair_again") return `${computer} now reports a different key from the one it was paired with, so nothing typed here is sent to it. Pair it again (\`${cli} login\`).`;
  return `Ensemble on ${computer} cannot open values typed here. Update it there, or sign in on the computer.`;
}

/** The fingerprint of the key the box is made for, worked out here from the key itself. */
export async function loginFingerprint(target: Pick<LoginTarget, "route">): Promise<string | null> {
  return target.route.mode === "sealed" ? sealFingerprint(target.route.sealKey.spki) : null;
}

/** The body for `POST /api/node/logins/:id` with what was typed: sealed for the computer, bound to this card, this sign-in and its site. */
export async function typedLoginAnswer(target: LoginTarget, card: { id: string }, typed: TypedLogin, origin: string): Promise<LoginAnswer> {
  if (target.route.mode !== "sealed") throw new Error(loginRouteText(target, null));
  const payload = { origin: target.origin, ...(typed.username.trim() ? { username: typed.username.trim() } : {}), ...(typed.password ? { password: typed.password } : {}), ...(typed.code?.trim() ? { code: typed.code.trim() } : {}), ...(typed.save ? { save: true } : {}) };
  const made = await sealFor(target.route.sealKey, { purpose: "login", deviceId: target.computer.id, decisionId: card.id, name: target.loginId, origin }, payload, { ttlMs: target.ttlMs });
  return { action: "typed", sealed: made.sealed };
}

/** What a settled sign-in card says. */
export function loginOutcomeText(data: { status?: string; origin?: string; computer?: string | null; via?: string; savedNow?: boolean; note?: string | null }): string {
  const where = `${data.origin ?? "the site"} on ${data.computer ?? "your computer"}`;
  if (data.status === "signed_in") {
    const how = data.via === "saved" ? "with the saved login" : data.via === "typed" ? "with what you typed (encrypted for the computer)" : "on the computer";
    return `Signed in to ${where} ${how}.${data.savedNow ? " The login is saved there for next time." : ""}${data.note ? ` ${data.note}` : ""}`;
  }
  if (data.status === "declined") return `You chose not to sign in to ${where} now.`;
  if (data.status === "expired") return `Nobody signed in to ${where} in time.`;
  if (data.status === "ended") return data.note ?? "The work that needed this sign-in ended.";
  return "";
}
