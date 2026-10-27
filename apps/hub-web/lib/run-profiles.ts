/**
 * Run profiles: up to three saved sets of Assign options, one of them the
 * default for Quick assign. The schema and the limit live in shared-types
 * (`RunProfile`, `MAX_RUN_PROFILES`); the API refuses a fourth.
 */
import { ENGINE_LABELS, INCLUDED_PROVIDER, isCodeEngine, MAX_RUN_PROFILES, QUICK_PROFILE_ID, quickRunProfile, type ContextTier, type ReasoningEffort, type RunProfile } from "@ensemble/shared-types";
import { pullRequestLine } from "./pull-request";

export type ProfileFields = Omit<RunProfile, "id" | "name">;

export const QUICK_ID = QUICK_PROFILE_ID;

/** The built-in profile while none is saved: its own checkout, git without limits, Review only. */
export const quickProfile = quickRunProfile;

export function profileFields(profile: RunProfile): ProfileFields {
  const { id: _id, name: _name, ...fields } = profile;
  return fields;
}

const KEYS: Array<keyof ProfileFields> = [
  "deviceId",
  "engine",
  "model",
  "effort",
  "context",
  "fast",
  "branchMode",
  "delivery",
  "askBeforePublish",
  "mode",
  "sandbox",
  "useCredentials",
  "network",
  "markDone",
  "maxMinutes",
  "maxToolCalls",
  "maxTurns",
  "instructions",
  "pullRequest",
];

/** True when the form no longer matches the profile it started from. */
export function differs(profile: RunProfile, fields: ProfileFields): boolean {
  // An unset context window and "default" are the same choice.
  const value = (row: RunProfile | ProfileFields, key: keyof ProfileFields) =>
    key === "context" && row.context === "default" ? null : key === "fast" ? row.fast === true || null : key === "pullRequest" ? (row.pullRequest ? `${row.pullRequest.base}:${row.pullRequest.merge}` : null) : (row[key] ?? null);
  return KEYS.some((key) => value(profile, key) !== value(fields, key));
}

/** The saved profiles, or the built-in Quick one when there are none. */
export function profileChoices(saved: RunProfile[] | undefined, quick: RunProfile): RunProfile[] {
  return saved?.length ? saved : [quick];
}

/** The default: the one marked default, else the first saved, else Quick. */
export function defaultProfile(saved: RunProfile[] | undefined, defaultId: string | null | undefined, quick: RunProfile): RunProfile {
  const list = profileChoices(saved, quick);
  return list.find((row) => row.id === defaultId) ?? list[0]!;
}

export function canAddProfile(saved: RunProfile[] | undefined): boolean {
  return (saved?.length ?? 0) < MAX_RUN_PROFILES;
}

export function newProfileId(): string {
  return `p-${Math.random().toString(36).slice(2, 10)}`;
}

/** Adds or replaces one profile. A new one past the limit is refused, as the API would. */
export function upsertProfile(saved: RunProfile[] | undefined, profile: RunProfile): RunProfile[] {
  const list = [...(saved ?? [])];
  const index = list.findIndex((row) => row.id === profile.id);
  if (index >= 0) {
    list[index] = profile;
    return list;
  }
  if (list.length >= MAX_RUN_PROFILES) throw new Error(`Keep at most ${MAX_RUN_PROFILES} run profiles. Rename or update one instead.`);
  return [...list, profile];
}

export function removeProfile(saved: RunProfile[] | undefined, id: string): RunProfile[] {
  return (saved ?? []).filter((row) => row.id !== id);
}

/** Who does the work, as the agent picker holds it: null follows the task's complexity tier. */
export type ProfileAgent = { provider: string; model: string; effort: string; context?: ContextTier; fast?: boolean } | null;

/** A profile's agent and model as a picker choice. */
export function profileAgent(profile: Pick<RunProfile, "engine" | "model" | "effort" | "context" | "fast">): ProfileAgent {
  if (isCodeEngine(profile.engine)) {
    return { provider: profile.engine, model: profile.model, effort: profile.effort, ...(profile.context === "long_context" ? { context: "long_context" as const } : {}), ...(profile.fast ? { fast: true } : {}) };
  }
  const [provider, model] = profile.model.includes("::") ? (profile.model.split("::", 2) as [string, string]) : ["", ""];
  return provider && model ? { provider, model, effort: profile.effort } : null;
}

/** The profile fields for a picker choice. */
export function agentFields(choice: ProfileAgent): Pick<ProfileFields, "engine" | "model" | "effort" | "context" | "fast"> {
  if (!choice) return { engine: "ensemble", model: "", effort: "default", context: undefined, fast: undefined };
  if (isCodeEngine(choice.provider)) {
    return { engine: choice.provider, model: choice.model, effort: choice.effort as ReasoningEffort, context: choice.context === "long_context" ? "long_context" : undefined, fast: choice.fast ? true : undefined };
  }
  return { engine: "ensemble", model: `${choice.provider}::${choice.model}`, effort: choice.effort as ReasoningEffort, context: undefined, fast: undefined };
}

/** One line that says what a profile does, for its tooltip. */
export function profileSummary(profile: RunProfile): string {
  const mode = profile.mode === "unattended" ? "Run unattended" : profile.mode === "review" ? "Review only" : "Ask";
  // A run that ends in a pull request may commit; Ensemble pushes its branch when it ends.
  const delivery = profile.pullRequest ? "commit" : profile.delivery;
  const git = profile.pullRequest ? "may commit" : delivery === "local" ? "local only" : delivery === "commit" ? "may commit, no push" : "no git limits";
  const chosen = profileAgent(profile);
  const agent = isCodeEngine(profile.engine) ? ENGINE_LABELS[profile.engine] : chosen ? (chosen.provider === INCLUDED_PROVIDER ? "Included model" : chosen.model) : "Matches the task";
  const pull = profile.pullRequest ? ` · ${pullRequestLine(profile.pullRequest)}` : "";
  return `${agent} · ${mode} · ${git}${profile.askBeforePublish && delivery !== "local" && profile.mode !== "unattended" ? " (asks before each commit)" : ""}${pull}`;
}
