/**
 * Run profiles: up to three saved sets of Assign options, one of them the
 * default for Quick assign. The schema and the limit live in shared-types
 * (`RunProfile`, `MAX_RUN_PROFILES`); the API refuses a fourth.
 */
import { ENGINE_LABELS, isCodeEngine, MAX_RUN_PROFILES, QUICK_PROFILE_ID, quickRunProfile, type RunProfile } from "@ensemble/shared-types";
import { pullRequestLine } from "./pull-request";

export type ProfileFields = Omit<RunProfile, "id" | "name">;

export const QUICK_ID = QUICK_PROFILE_ID;

/** The built-in profile while none is saved: code in its own checkout, commits allowed, Ask. */
export const quickProfile = quickRunProfile;

export function profileFields(profile: RunProfile): ProfileFields {
  const { id: _id, name: _name, ...fields } = profile;
  return fields;
}

const KEYS: Array<keyof ProfileFields> = [
  "kind",
  "deviceId",
  "engine",
  "model",
  "effort",
  "context",
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
    key === "context" && row.context === "default" ? null : key === "pullRequest" ? (row.pullRequest ? `${row.pullRequest.base}:${row.pullRequest.merge}` : null) : (row[key] ?? null);
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

/** One line that says what a profile does, for its tooltip. */
export function profileSummary(profile: RunProfile): string {
  const mode = profile.mode === "unattended" ? "Run unattended" : profile.mode === "review" ? "Review only" : "Ask";
  // A run that ends in a pull request may always commit; Ensemble pushes it, not the agent.
  const delivery = profile.pullRequest ? "commit" : profile.delivery;
  const git = delivery === "local" ? "local only" : delivery === "commit" ? "may commit" : "may commit and push";
  const engine = isCodeEngine(profile.engine) ? `${ENGINE_LABELS[profile.engine]} · ` : "";
  const pull = profile.pullRequest ? ` · ${pullRequestLine(profile.pullRequest)}` : "";
  return profile.kind === "research" ? "Research & writing" : `${engine}Code · ${mode} · ${git}${profile.askBeforePublish && delivery !== "local" && profile.mode !== "unattended" ? " (asks before each commit)" : ""}${pull}`;
}
