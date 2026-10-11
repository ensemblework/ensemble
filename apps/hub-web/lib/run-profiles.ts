/**
 * Run profiles: up to three saved sets of Assign options, one of them the
 * default for Quick assign. The schema and the limit live in shared-types
 * (`RunProfile`, `MAX_RUN_PROFILES`); the API refuses a fourth.
 */
import { MAX_RUN_PROFILES, type RunProfile } from "@ensemble/shared-types";

export type ProfileFields = Omit<RunProfile, "id" | "name">;

export const QUICK_ID = "quick";

/** The built-in profile while none is saved: code in its own checkout, commits allowed, Ask. */
export function quickProfile(orchestration?: { defaultExecution?: string; sandboxNetwork?: boolean } | null): RunProfile {
  return {
    id: QUICK_ID,
    name: "Quick",
    kind: "code",
    deviceId: null,
    engine: "ensemble",
    model: "",
    effort: "default",
    branchMode: "as-is",
    delivery: "commit",
    askBeforePublish: true,
    mode: "ask",
    sandbox: orchestration?.defaultExecution !== "native",
    useCredentials: false,
    network: orchestration?.sandboxNetwork ?? true,
    markDone: true,
    maxMinutes: null,
    maxToolCalls: null,
    maxTurns: null,
    instructions: "",
  };
}

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
];

/** True when the form no longer matches the profile it started from. */
export function differs(profile: RunProfile, fields: ProfileFields): boolean {
  return KEYS.some((key) => (profile[key] ?? null) !== (fields[key] ?? null));
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
  const git = profile.delivery === "local" ? "local only" : profile.delivery === "commit" ? "may commit" : "may commit and push";
  const engine = profile.engine === "claude-code" ? "Claude Code · " : "";
  return profile.kind === "research" ? "Research & writing" : `${engine}Code · ${mode} · ${git}${profile.askBeforePublish && profile.delivery !== "local" && profile.mode !== "unattended" ? " (asks before each commit)" : ""}`;
}
