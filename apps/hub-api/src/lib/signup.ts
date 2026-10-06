export const INVITE_ONLY = "This Ensemble is invite only.";

export type SignupMode = "open" | "closed" | "allowlist";

export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

function patternMatches(email: string, pattern: string): boolean {
  if (pattern.startsWith("*@")) {
    const domain = pattern.slice(2);
    if (!domain || domain.includes("*") || !domain.includes(".")) return false;
    return email.endsWith(`@${domain}`);
  }
  return email === pattern;
}

type SignupPolicy = {
  mode?: string;
  production?: boolean;
  allowlist: string | undefined;
  hasAccounts?: boolean;
};

export function signupMode(input: SignupPolicy): SignupMode {
  if (input.mode !== undefined && input.mode.trim() !== "") {
    if (input.mode !== "open" && input.mode !== "closed" && input.mode !== "allowlist") {
      throw new Error("ENSEMBLE_SIGNUP_MODE must be open, allowlist, or closed.");
    }
    return input.mode;
  }
  if (parseAllowlist(input.allowlist).length > 0) return "allowlist";
  return "open";
}

export function signupPermitted(input: SignupPolicy & { email: string }): boolean {
  const mode = signupMode(input);
  if (mode === "open") return true;
  if (mode === "closed") return false;
  const email = input.email.trim().toLowerCase();
  return parseAllowlist(input.allowlist).some((pattern) => patternMatches(email, pattern));
}

export function currentSignupPolicy(): SignupPolicy {
  return { mode: process.env.ENSEMBLE_SIGNUP_MODE, allowlist: process.env.ENSEMBLE_SIGNUP_ALLOWLIST };
}
