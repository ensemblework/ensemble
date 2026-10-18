/**
 * Ensemble's included models in the terminal. They run on Ensemble's server on the account's
 * monthly credits, so this computer uses them only while it is connected to an account (`/login`,
 * with "Run tasks" approved). A refusal is shown as a notice with what to do next, not a bare error.
 */
import { INCLUDED_CREDITS_USED, INCLUDED_LOCAL_ONLY, INCLUDED_PAUSED, INCLUDED_PROVIDER, includedModelName, isIncludedErrorCode } from "@ensemble/shared-types";

export type IncludedNotice = { title: string; text: string; hint: string; tone: "accent" | "warn" };

const LOCAL_ONLY = /connected to your Ensemble account|no longer connected to your Ensemble account/i;

/** A model as the picker and the status line name it: an included model with its version. */
export function modelLabel(provider: string | null | undefined, model: string): string {
  return provider === INCLUDED_PROVIDER ? includedModelName(model) : model;
}

/** The refusal for an included call, as a notice; null for any other error. */
export function includedNotice(code: string | null | undefined, message: string): IncludedNotice | null {
  const local = code === INCLUDED_LOCAL_ONLY || (!code && LOCAL_ONLY.test(message));
  if (local) {
    return {
      title: "Included models need your Ensemble account",
      text: "This computer is local only. Included models run on Ensemble's server and use your account's monthly credits, so they work once this computer is connected.",
      hint: "/login and approve “Run tasks” to connect it, or add your own key with /keys.",
      tone: "accent",
    };
  }
  if (!isIncludedErrorCode(code)) return null;
  if (code === INCLUDED_CREDITS_USED || code === INCLUDED_PAUSED) {
    return { title: "Ensemble credits", text: message, hint: "Your own keys still work: /keys, or chat with Claude Code, Codex or Cursor: /agent.", tone: "warn" };
  }
  return { title: "Included with Ensemble", text: message, hint: "Add your own key with /keys, or pick another model with /model.", tone: "accent" };
}

/** The picker row for a local-only computer: the included models are there, but need an account first. */
export function localOnlyRow(rows: Array<{ provider: string; available: boolean; code?: string | null }>): boolean {
  return rows.some((row) => row.provider === INCLUDED_PROVIDER && !row.available && row.code === INCLUDED_LOCAL_ONLY);
}
