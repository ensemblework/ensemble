export const INVITE_ONLY = "This Ensemble is invite only.";

export type SignupMode = "open" | "closed" | "allowlist";

export function safeLoginNext(value: string | null): string | null {
  return value?.startsWith("/") && !value.startsWith("//") && !/[\\\u0000-\u0020]/.test(value) ? value : null;
}

/** The signup page replaces the form only when new accounts are closed. */
export function signupPanel(mode: "login" | "signup", signup: SignupMode | undefined): "form" | "closed" {
  if (mode === "signup" && signup === "closed") return "closed";
  return "form";
}

export function showInviteNote(signup: SignupMode | undefined): boolean {
  return signup === "closed" || signup === "allowlist";
}
