import { z } from "zod";

export function turnstileSiteKey(): string | null {
  return process.env.TURNSTILE_SITE_KEY?.trim() || null;
}

export function turnstileConfigured(): boolean {
  return Boolean(turnstileSiteKey() && process.env.TURNSTILE_SECRET_KEY?.trim());
}

export async function verifyTurnstile(token: string | undefined, remoteIp: string): Promise<void> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production" && process.env.ENSEMBLE_DESKTOP !== "1") {
      throw Object.assign(new Error("Signup bot protection is not configured. Contact the operator."), { statusCode: 503 });
    }
    return;
  }
  if (!token) throw Object.assign(new Error("Complete the signup verification and try again."), { statusCode: 400 });
  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, remoteip: remoteIp }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    throw Object.assign(new Error("Signup verification is temporarily unavailable. Try again shortly.", { cause }), { statusCode: 503 });
  }
  if (!response.ok) throw Object.assign(new Error("Signup verification is temporarily unavailable. Try again shortly."), { statusCode: 503 });
  const result = z.object({ success: z.boolean(), hostname: z.string().optional(), action: z.string().optional() }).parse(await response.json());
  const expectedHost = new URL(process.env.HUB_WEB_ORIGIN ?? "http://localhost:3000").hostname;
  if (!result.success || result.hostname !== expectedHost || result.action !== "signup") {
    throw Object.assign(new Error("Signup verification failed. Complete it again."), { statusCode: 400 });
  }
}
