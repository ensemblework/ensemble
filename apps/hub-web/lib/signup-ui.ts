export const INVITE_ONLY = "This Ensemble is invite only.";

export type SignupMode = "open" | "closed" | "allowlist";

/** The signup page replaces the form only when new accounts are closed. */
export function signupPanel(mode: "login" | "signup", signup: SignupMode | undefined): "form" | "closed" {
  if (mode === "signup" && signup === "closed") return "closed";
  return "form";
}

export function showInviteNote(signup: SignupMode | undefined): boolean {
  return signup === "closed" || signup === "allowlist";
}
