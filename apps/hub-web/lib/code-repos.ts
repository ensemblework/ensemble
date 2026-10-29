import type { CodeRepoDetail, CodeRepos } from "./api";

/**
 * How the Code tab names a checkout (docs/16). A run's checkout lives in a folder named by its job id,
 * so it is named by its task and its origin instead; an older computer that sends no `details` is
 * named from the path alone.
 */
export type RepoView = {
  path: string;
  kind: CodeRepoDetail["kind"];
  /** Never a folder id. */
  name: string;
  /** The muted second part: "run checkout", an origin that differs from the folder name. */
  note: string | null;
  branch: string | null;
  remote: string | null;
  taskTitle: string | null;
  at: string | null;
  /** More checkouts that look the same (older runs of one task on one branch), newest first. */
  others: Array<{ path: string; at: string | null }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{12,64}$/i;
const RUN_CHECKOUT = "Run checkout";

/** A folder or branch part that is an id or a hash, not a name. */
export function looksLikeId(name: string): boolean {
  return UUID.test(name) || HEX.test(name) || /^(?:job|run)[-_]?[0-9a-f]{8}[0-9a-f-]*$/i.test(name);
}

function parts(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/** Names a checkout from its path alone. */
export function guessRepo(path: string): CodeRepoDetail {
  const segments = parts(path);
  const base = segments.at(-1) ?? path;
  if (looksLikeId(base)) return { path, name: RUN_CHECKOUT, kind: "run" };
  // A repository cloned inside a run's folder keeps its own name.
  if (looksLikeId(segments.at(-2) ?? "")) return { path, name: base, kind: "run" };
  return { path, name: base, kind: "folder" };
}

/** A branch to show: id parts (`ensemble/<job id>/…`) are shortened to `…`. */
export function shortBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  return branch
    .split("/")
    .map((part) => (looksLikeId(part) ? "…" : part))
    .join("/");
}

export function repoView(path: string, detail?: CodeRepoDetail | null): RepoView {
  const known = detail ?? guessRepo(path);
  const remote = known.remote?.trim() || null;
  const taskTitle = known.taskTitle?.trim() || null;
  const plain = known.name && !looksLikeId(known.name) ? known.name : null;
  const base = { path, kind: known.kind, branch: known.branch ?? null, remote, taskTitle, at: known.at ?? null, others: [] };
  if (known.kind === "run") {
    const repo = remote ?? (plain && plain !== RUN_CHECKOUT ? plain : null);
    return { ...base, name: taskTitle ?? repo ?? RUN_CHECKOUT, note: taskTitle && repo ? `run checkout · ${repo}` : "run checkout" };
  }
  const name = plain ?? guessRepo(path).name;
  const shown = looksLikeId(name) ? "Checkout" : name;
  return { ...base, name: shown, note: remote && remote.split("/").at(-1) !== shown ? remote : null };
}

/** The muted part after a repository's name: its branch first, or for a run what kind it is first. */
export function repoSecond(view: RepoView, where?: string | null): string {
  const branch = shortBranch(view.branch);
  return (view.kind === "run" ? [view.note, branch, where] : [branch, view.note, where]).filter(Boolean).join(" · ");
}

/** The repository a path belongs to, for a line under a review or a run: an origin or a folder name. */
export function repoName(view: RepoView): string {
  if (view.kind !== "run") return view.name;
  if (view.remote) return view.remote;
  return view.name !== view.taskTitle && view.name !== RUN_CHECKOUT ? view.name : "run checkout";
}

/** Every checkout, most recently used first, with run checkouts that look the same folded into one. */
export function repoViews(answer: CodeRepos | null | undefined): RepoView[] {
  if (!answer) return [];
  const details = new Map((answer.details ?? []).map((detail) => [detail.path, detail]));
  const ordered = answer.repos
    .map((path, index) => ({ view: repoView(path, details.get(path)), index }))
    .sort((a, b) => (b.view.at ?? "").localeCompare(a.view.at ?? "") || a.index - b.index)
    .map((row) => row.view);
  const shown: RepoView[] = [];
  const first = new Map<string, RepoView>();
  for (const view of ordered) {
    if (view.kind !== "run") {
      shown.push(view);
      continue;
    }
    const key = [view.name, view.remote ?? "", view.branch ?? ""].join("\0");
    const kept = first.get(key);
    if (kept) kept.others.push({ path: view.path, at: view.at });
    else {
      first.set(key, view);
      shown.push(view);
    }
  }
  return shown;
}

/** Whether a checkout was used within the last `days` (unknown counts as not). */
export function usedWithin(view: Pick<RepoView, "at">, days: number, now = Date.now()): boolean {
  const at = view.at ? Date.parse(view.at) : Number.NaN;
  return Number.isFinite(at) && now - at <= days * 86_400_000;
}

/** Folders and workspace checkouts first; run checkouts apart (the Explorer folds them). */
export function splitRepos(views: RepoView[]): { folders: RepoView[]; runs: RepoView[] } {
  return { folders: views.filter((view) => view.kind !== "run"), runs: views.filter((view) => view.kind === "run") };
}

/** The view a path belongs to, folded or not; named from the path when it is not listed. */
export function viewFor(path: string, views: RepoView[]): RepoView {
  return views.find((view) => view.path === path || view.others.some((other) => other.path === path)) ?? repoView(path);
}

/** A remote URL reduced to `owner/repo` (or a local folder's name), never with a sign-in in it. */
export function remoteLabel(url: string | null | undefined): string | null {
  const clean = (url ?? "").trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  if (!clean) return null;
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(clean);
  const hosted = scp !== null || /^[a-z][a-z0-9+.-]*:\/\//i.test(clean);
  let path = scp?.[1] ?? clean;
  if (!scp && hosted) {
    try {
      path = new URL(clean).pathname;
    } catch {
      return null;
    }
  }
  const segments = parts(path);
  if (!segments.length) return null;
  return hosted && !/^file:/i.test(clean) ? segments.slice(-2).join("/") : segments.at(-1)!;
}
