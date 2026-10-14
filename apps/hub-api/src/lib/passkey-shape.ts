/**
 * The JSON a browser's passkey call posts (@simplewebauthn/browser), checked before the verifier, which
 * throws plain errors on anything else. Shared by the terminal on this computer's page
 * (`routes/terminal.ts`) and the web terminal's unlock (`devices/web-unlock.ts`).
 */
import { z } from "zod";

/** A body that is not a passkey response: the caller's mistake, so a 400 with a clear reason, never a 500 from inside the verifier. */
export class BadPasskeyResponse extends Error {
  readonly statusCode = 400;
  readonly expose = true;
}

/** The JSON shape @simplewebauthn/browser posts. Checked before the verifier, which throws plain errors on anything else. */
function credentialShape<T extends z.ZodRawShape>(response: T) {
  return z
    .object({
      id: z.string().min(1),
      rawId: z.string().min(1),
      type: z.literal("public-key"),
      response: z.object(response).passthrough(),
      clientExtensionResults: z.record(z.unknown()).default({}),
    })
    .passthrough();
}
export const RegistrationCredential = credentialShape({ clientDataJSON: z.string().min(1), attestationObject: z.string().min(1) });
export const UnlockCredential = credentialShape({ clientDataJSON: z.string().min(1), authenticatorData: z.string().min(1), signature: z.string().min(1) });

export function passkeyResponse<T extends z.ZodTypeAny>(schema: T, response: unknown, again: string): z.infer<T> {
  const parsed = schema.safeParse(response);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = ["response", ...(issue?.path ?? [])].join(".");
  throw new BadPasskeyResponse(`That is not a passkey response (${where}: ${issue?.message ?? "invalid"}). ${again}`);
}

/** The verifier throws (not returns false) on a credential it cannot read or that names the wrong origin or challenge: a bad request too. */
export async function verifying<T>(run: () => Promise<T>, again: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new BadPasskeyResponse(`That passkey response is not valid. ${again}`, { cause: error });
  }
}

