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

/**
 * Unset allowlist: production closes signup once an account exists.
 * A list of emails or `*@domain` patterns applies in every environment.
 */
export function signupMode(input: { production: boolean; allowlist: string | undefined; hasAccounts: boolean }): SignupMode {
  if (parseAllowlist(input.allowlist).length > 0) return "allowlist";
  if (input.production && input.hasAccounts) return "closed";
  return "open";
}

export function signupPermitted(input: {
  email: string;
  production: boolean;
  allowlist: string | undefined;
  hasAccounts: boolean;
}): boolean {
  const mode = signupMode(input);
  if (mode === "open") return true;
  if (mode === "closed") return false;
  const email = input.email.trim().toLowerCase();
  return parseAllowlist(input.allowlist).some((pattern) => patternMatches(email, pattern));
}
