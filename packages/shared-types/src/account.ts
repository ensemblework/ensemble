/**
 * Rules for account fields the Hub checks as you type and hub-api checks again on save:
 * new passwords (sign-up, reset, change), the email in Settings › Account, and time zones.
 */

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;

/** Shown beside every new-password field, before anything is typed. */
export const PASSWORD_RULE = "At least 8 characters. Spaces at the start or end don't count.";

/**
 * Why a new password is refused, or null when it is fine. Spaces at either end are not counted,
 * so eight spaces, or "  abc   ", is too short. The password itself is stored as typed.
 */
export function passwordProblem(password: string): string | null {
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (!password.trim()) return password ? "A password can't be only spaces." : `Use at least ${PASSWORD_MIN} characters.`;
  if (password.trim().length < PASSWORD_MIN) {
    return password.trim().length === password.length
      ? `Use at least ${PASSWORD_MIN} characters.`
      : `Use at least ${PASSWORD_MIN} characters, not counting spaces at the start or end.`;
  }
  return null;
}

/** name@example.com: one @, no spaces, and a dot in the domain. */
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export function isEmailAddress(value: string): boolean {
  const text = value.trim();
  return text.length <= 254 && EMAIL.test(text);
}

/**
 * The IANA name for a time zone, in its usual spelling ("europe/london" → "Europe/London"), or
 * null when it is not one. UTC offsets such as "+05:30" are refused: they do not follow
 * daylight saving. A name the browser files under an older alias stays as given:
 * "Asia/Kolkata" is not turned into "Asia/Calcutta".
 */
export function timeZoneName(value: string): string | null {
  const text = value.trim();
  if (!text || /^[+-]?\d/.test(text)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: text }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  const lower = text.toLowerCase();
  const listed = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return listed.find((zone) => zone === text) ?? listed.find((zone) => zone.toLowerCase() === lower) ?? (resolved.toLowerCase() === lower ? resolved : text);
}
