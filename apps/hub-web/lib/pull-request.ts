/**
 * A code run that ends in a pull request (docs/24 §5.1): what the Assign dialog offers and refuses
 * before the server does, the profile line, and the pull request a finished run opened.
 */
import { BRANCH_NAME, DEFAULT_PULL_REQUEST_BASES, NEVER_PULL_REQUEST_BASES, pullRequestBaseRefusal, pullRequestHeadRefusal, type PullRequestPlan } from "@ensemble/shared-types";
import { computerName, pullRequestNumber } from "./device-copy";

export type PullRequestMerge = PullRequestPlan["merge"];

export const MERGE_CHOICES: Array<{ id: PullRequestMerge; label: string }> = [
  { id: "ask", label: "Ask me before merging" },
  { id: "auto", label: "Merge when checks pass" },
  { id: "never", label: "Leave it open" },
];

const NEVER = NEVER_PULL_REQUEST_BASES as readonly string[];

/** The base a new pull request plan starts with: the computer's first allowed one, else testing. */
export function defaultPullRequestBase(bases: readonly string[] | null): string {
  return bases?.[0] ?? DEFAULT_PULL_REQUEST_BASES[0]!;
}

/** The bases a paired computer opens pull requests into (it alone sets them); null when its Ensemble is too old to open any. */
export function computerPullRequestBases(capabilities: unknown): string[] | null {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return null;
  const record = capabilities as { pullRequests?: unknown; pullRequestBases?: unknown };
  if (typeof record.pullRequests !== "number" || record.pullRequests < 1 || !Array.isArray(record.pullRequestBases)) return null;
  const bases = record.pullRequestBases.filter((base): base is string => typeof base === "string" && BRANCH_NAME.test(base) && !NEVER.includes(base));
  return [...new Set(bases)].slice(0, 20);
}

/**
 * How a computer works each shared folder: "repo" (shared as a repository, each run in its own clone)
 * or "folder" (worked in place). A label published without a kind is worked in place.
 */
export function sharedFolderKinds(capabilities: unknown): Record<string, "folder" | "repo"> {
  const kinds: Record<string, "folder" | "repo"> = {};
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return kinds;
  const raw = (capabilities as { folders?: unknown }).folders;
  if (!Array.isArray(raw)) return kinds;
  for (const item of raw) {
    if (!item || typeof item !== "object" || typeof (item as { label?: unknown }).label !== "string") continue;
    const label = (item as { label: string }).label.trim();
    if (label) kinds[label] = (item as { kind?: unknown }).kind === "repo" ? "repo" : "folder";
  }
  return kinds;
}

/** The labels of the folders a computer shares as repositories. */
export function repositoryLabels(capabilities: unknown): string[] {
  return Object.entries(sharedFolderKinds(capabilities))
    .filter(([, kind]) => kind === "repo")
    .map(([label]) => label);
}

export type PullRequestCheck = {
  /** The paired computer's name, or null for this server. */
  computer: string | null;
  capabilities?: unknown;
  place: "fresh" | "continue" | "folder";
  repo: string;
  /** On a computer: the shared folder's label. Here: the folder's path. */
  folder: string;
  base: string;
  branch: string;
};

export type PullRequestNotices = { tooOld: string | null; place: string | null; base: string | null; branch: string | null };

/** Every reason the server would refuse this pull request, each in words, or null. */
export function pullRequestNotices(check: PullRequestCheck): PullRequestNotices {
  const onComputer = check.computer !== null;
  const name = computerName(check.computer);
  const bases = onComputer ? computerPullRequestBases(check.capabilities) : null;
  const tooOld = onComputer && !bases ? `Ensemble on ${name} is too old to open pull requests. Update it there (\`ensemble update\`), then assign.` : null;

  let place: string | null = null;
  if (check.place === "folder") {
    const label = check.folder.trim();
    if (onComputer && label && sharedFolderKinds(check.capabilities)[label] !== "repo") place = `${label} is worked in place. Pick a repository, or a folder ${name} shares as a repository.`;
    if (!onComputer && label) place = `${label.split(/[\\/]/).filter(Boolean).pop() ?? label} is worked in place. Pick a repository.`;
  } else if (check.place === "fresh" && !check.repo.trim()) {
    place = onComputer
      ? `A pull request needs a repository. Give its GitHub address, or pick a folder ${name} shares as a repository.`
      : "A pull request needs a repository. Give its GitHub address.";
  }

  const target = check.base.trim();
  const base = !target
    ? "Choose the branch the pull request goes into."
    : !BRANCH_NAME.test(target)
      ? `“${target.slice(0, 80)}” is not a branch name git accepts.`
      : pullRequestBaseRefusal(target, bases ?? [target], onComputer ? name : "this server");
  const head = check.branch.trim();
  return { tooOld, place, base, branch: head && target ? pullRequestHeadRefusal(head, target) : null };
}

/** The first notice that keeps Assign from going ahead, and the field to fix, or null. */
export function pullRequestProblem(notices: PullRequestNotices): { text: string; field: "pull-request" | "place" | "branch" } | null {
  if (notices.tooOld) return { text: notices.tooOld, field: "pull-request" };
  if (notices.place) return { text: notices.place, field: "place" };
  if (notices.base) return { text: notices.base, field: "pull-request" };
  if (notices.branch) return { text: notices.branch, field: "branch" };
  return null;
}

const MERGE_NOTE: Record<PullRequestMerge, string> = { ask: "ask to merge", auto: "merge when checks pass", never: "left open" };

/** "PR → testing (ask to merge)", for a profile's summary line. */
export function pullRequestLine(plan: PullRequestPlan): string {
  return `PR → ${plan.base} (${MERGE_NOTE[plan.merge]})`;
}

export type RunPullRequest = { url: string; number: number; base: string; head: string; state: "open" | "merged" };

const SUMMARY_LINE = /Opened( and merged)? pull request #(\d+) from (\S+) into (\S+): (\S+)/g;

/**
 * The pull request a run opened: its latest `pull_request` event when the events are loaded, else
 * the line its summary ends with. Only a github.com pull request link counts.
 */
export function runPullRequest(input: { summary?: string | null; events?: ReadonlyArray<{ kind: string; data: Record<string, unknown> }> | null }): RunPullRequest | null {
  for (const event of [...(input.events ?? [])].reverse()) {
    if (event.kind !== "pull_request") continue;
    const { url, number, base, head, state } = event.data;
    if (typeof url !== "string" || pullRequestNumber(url) === null) continue;
    return {
      url,
      number: typeof number === "number" ? number : Number(pullRequestNumber(url)),
      base: typeof base === "string" ? base : "",
      head: typeof head === "string" ? head : "",
      state: state === "merged" ? "merged" : "open",
    };
  }
  let found: RunPullRequest | null = null;
  for (const match of (input.summary ?? "").matchAll(SUMMARY_LINE)) {
    const url = match[5]!;
    if (pullRequestNumber(url) !== match[2]) continue;
    found = { url, number: Number(match[2]), head: match[3]!, base: match[4]!, state: match[1] ? "merged" : "open" };
  }
  return found;
}

/** "Pull request #12 (merged into testing)" or "Pull request #12 (open, into testing)". */
export function runPullRequestLabel(pr: RunPullRequest): string {
  const into = pr.base ? ` into ${pr.base}` : "";
  return `Pull request #${pr.number} (${pr.state === "merged" ? `merged${into}` : `open${into ? `,${into}` : ""}`})`;
}
