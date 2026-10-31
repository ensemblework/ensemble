/**
 * The owner's answer to a sign-in card, on this computer (`login.resolve`, protocol 8, B11). Typed
 * values, and a one-time code the site asks for after them (`code`), come in a box sealed in the
 * owner's browser for this computer's key (B12, credentials/seal.ts): opened only here, after checking
 * it is for this computer and its current key, this card, this sign-in (its id is the box's `name`) and
 * its site (inside the box), typed on a site this computer trusts, not expired and never seen before.
 * The values go into the page and nowhere else; the answer says only how the sign-in went, in the words
 * the server knows (`v`).
 */
import { z } from "zod";
import { trustedOrigins } from "../credentials/origins.js";
import { takeOnce } from "../credentials/replay.js";
import { checkAad, openSealed, SealError } from "../credentials/seal.js";
import { loadSealKey } from "../credentials/seal-key.js";
import { remoteApiBase, type HostedClient } from "../remote/client.js";
import { LoginResolve, type LoginResolution } from "../remote/contract.js";
import { loadSettings } from "../remote/store.js";
import { bindDecision, resolveLogin, waitingLogin } from "./requests.js";
import type { LoginValues } from "./fill.js";

/** What a sealed sign-in box holds. `origin`: the site the owner typed it for, which must be the sign-in's. */
const TypedLogin = z
  .object({
    origin: z.string().min(1).max(300),
    username: z.string().max(320).optional(),
    password: z.string().max(1024).optional(),
    code: z.string().max(20).optional(),
    save: z.boolean().optional(),
  })
  .strict();

class NotSignedIn extends Error {
  constructor(readonly resolution: LoginResolution) {
    super("not signed in");
  }
}

/** Opens a typed sign-in box for this sign-in and card; the values, or a SealError. */
export function openTypedLogin(frame: Pick<LoginResolve, "loginId" | "decisionId" | "sealed">, origin: string, now = Date.now()): { values: LoginValues; save: boolean; nonce: string; expiresAt: string; site: string } {
  if (!frame.sealed) throw new SealError("shape", "Send what you typed encrypted for this computer.");
  const key = loadSealKey();
  if (!key) throw new SealError("key", "This computer has no key for encrypted values. Update Ensemble here, or pair it again.");
  const settings = loadSettings();
  const deviceId = settings.deviceId ?? key.deviceId;
  if (!deviceId) throw new SealError("device", "This computer does not know its own id. Pair it again.");
  const { aad, plaintext } = openSealed(frame.sealed, { kid: key.info.kid, privateKey: key.privateKey });
  try {
    checkAad(aad, { deviceId, kid: key.info.kid, decisionId: frame.decisionId, purpose: "login", name: frame.loginId, origins: trustedOrigins(remoteApiBase() ?? settings.apiBase), now });
    let payload: z.infer<typeof TypedLogin>;
    try {
      payload = TypedLogin.parse(JSON.parse(plaintext.toString("utf8")));
    } catch {
      throw new SealError("shape", "What you typed could not be read.");
    }
    if (payload.origin !== origin) throw new SealError("name", "That was typed for another site.");
    if (!payload.password && !payload.code && !payload.username) throw new SealError("shape", "Nothing was typed.");
    return { values: { username: payload.username ?? null, password: payload.password ?? null, code: payload.code ? () => payload.code ?? null : null }, save: payload.save === true, nonce: aad.nonce, expiresAt: aad.expiresAt, site: aad.origin };
  } finally {
    plaintext.fill(0);
  }
}

/** An answer in the words a server of sign-in version `v` knows: before 2 it has no `passed` or `needs_code`. */
export function forServer(result: LoginResolution, v: number | undefined): LoginResolution {
  if ((v ?? 1) >= 2) return result;
  if (result.status === "passed") return { ...result, status: "signed_in" };
  if (result.status === "needs_code") return { ...result, status: "failed", message: `The site asks for a one-time code: ${result.message ?? "type it in the browser on the computer, or open the browser from here."}`.slice(0, 500) };
  return result;
}

/** The answer to one `login.resolve` frame. */
export async function loginResolution(data: unknown, now = Date.now()): Promise<LoginResolution> {
  const parsed = LoginResolve.safeParse(data);
  if (!parsed.success) return { status: "failed", message: "That answer could not be read. Update Ensemble on this computer." };
  const frame = parsed.data;
  return forServer(await resolution(frame, now), frame.v);
}

async function resolution(frame: LoginResolve, now: number): Promise<LoginResolution> {
  const login = waitingLogin(frame.loginId);
  if (login && !bindDecision(frame.loginId, frame.decisionId)) return { status: "failed", message: "That answer is for another card.", code: "decision" };
  if (frame.action !== "typed" && frame.action !== "code") return resolveLogin(frame.loginId, frame.action);
  if (!login) return resolveLogin(frame.loginId, "done");
  try {
    const box = openTypedLogin(frame, login.origin, now);
    if (frame.action === "code" && !box.values.code) throw new SealError("shape", "Type the code the site asks for.");
    // Each box is taken once; a sign-in that did not work (or now asks for a code) leaves the card open for another box.
    return await takeOnce({ decisionId: frame.decisionId, nonce: box.nonce, expiresAt: box.expiresAt }, async () => {
      const result = frame.action === "code" ? await resolveLogin(frame.loginId, "code", { values: { code: box.values.code }, save: false }) : await resolveLogin(frame.loginId, "typed", { values: box.values, save: box.save });
      if (result.status !== "signed_in") throw new NotSignedIn(result);
      return result;
    }, now);
  } catch (error) {
    if (error instanceof NotSignedIn) return error.resolution;
    if (error instanceof SealError) return { status: "failed", message: error.message, code: `seal_${error.code}` };
    return { status: "failed", message: error instanceof Error ? error.message.slice(0, 300) : "This computer could not do that." };
  }
}

/** A `login.resolve` frame from the event stream: answered once. */
export async function answerLoginResolve(client: HostedClient, data: unknown): Promise<void> {
  const id = (data as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id) return;
  await client.answerCode(id, { status: 200, body: await loginResolution(data) });
}
