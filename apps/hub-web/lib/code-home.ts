"use client";

/**
 * What Code's Welcome and Explorer show (`components/code/code-home.tsx`, docs/16): this computer's own
 * Ensemble, or on Ensemble on the web each paired computer, read through it (`lib/code-target.tsx`).
 * The query keys are shared with the editor and Settings, so one answer serves every view.
 */
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, hostOnly, type AgentJob, type CodeRepos, type ReviewSummary } from "./api";
import { codeApiFor, type CodeTarget } from "./code-target";
import { repoName, repoViews, viewFor, type RepoView } from "./code-repos";
import { desktopShell } from "./desktop-param";
import { useHostCode } from "./use-module";

export type Computer = Awaited<ReturnType<typeof api.devices>>["devices"][number];

type Caps = { code?: boolean; browseFiles?: boolean; webEdit?: boolean; webTerminal?: boolean };

/** Where code is: this Ensemble, or a paired computer. */
export type CodePlace = {
  key: string;
  target: CodeTarget;
  name: string;
  online: boolean;
  version: string | null;
  /** Its reviews and repositories can be read now. */
  usable: boolean;
  /** Why not, in one line. */
  why: string | null;
  terminal: boolean;
  /** *Change code from the web* is off there. */
  viewOnly: boolean;
};

export function placeOfDevice(device: Computer): CodePlace {
  const caps = (device.capabilities ?? {}) as Caps;
  const usable = device.online && caps.code === true && caps.browseFiles !== false;
  const why = !device.online
    ? "Offline. Open Ensemble there, or start it with `ensemble runner start`."
    : caps.code !== true
      ? "Update Ensemble there to review and edit its code from here (the CLI 0.3.8 or the desktop app 0.3.5)."
      : caps.browseFiles === false
        ? "Showing code on the web is turned off there (`ensemble browse on`)."
        : null;
  return {
    key: `device:${device.id}`,
    target: { kind: "device", deviceId: device.id },
    name: device.name,
    online: device.online,
    version: device.appVersion,
    usable,
    why,
    terminal: usable && caps.webTerminal !== false,
    viewOnly: usable && caps.webEdit === false,
  };
}

export function reviewsKey(place: CodePlace): unknown[] {
  return place.target.kind === "local" ? ["reviews", "all", false] : ["reviews", place.key, "all"];
}

export function reposKey(place: CodePlace): unknown[] {
  return place.target.kind === "local" ? ["code-repos"] : ["code-repos", place.key];
}

function deviceParam(place: CodePlace): string {
  return place.target.kind === "device" ? `device=${encodeURIComponent(place.target.deviceId)}&` : "";
}

export function reviewHref(place: CodePlace, id: string): string {
  return `/code/review?${deviceParam(place)}review=${encodeURIComponent(id)}`;
}

export function repoHref(place: CodePlace, path: string): string {
  return `/code/review?${deviceParam(place)}repo=${encodeURIComponent(path)}`;
}

export type HomeReview = ReviewSummary & { place: CodePlace; href: string; repo: string };
export type HomeRepo = RepoView & { place: CodePlace; href: string };
export type PlaceState = {
  place: CodePlace;
  reviews: UseQueryResult<{ reviews: ReviewSummary[]; ttlDays: number }>;
  repos: UseQueryResult<CodeRepos>;
  views: RepoView[];
};

const RUN_STATES = ["running", "waiting", "queued", "completed", "stopped"] as const;

/** Code runs on the board, newest first. */
export function codeRuns(board: { [key in (typeof RUN_STATES)[number]]?: AgentJob[] } | undefined): AgentJob[] {
  if (!board) return [];
  const when = (job: AgentJob) => job.finishedAt ?? job.startedAt ?? job.createdAt;
  return RUN_STATES.flatMap((state) => board[state] ?? [])
    .filter((job) => job.kind === "code")
    .sort((a, b) => when(b).localeCompare(when(a)));
}

export function useCodeHome() {
  const hostCode = useHostCode();
  const local: CodePlace = { key: "local", target: { kind: "local" }, name: desktopShell() ? "This computer" : "This server", online: true, version: null, usable: true, why: null, terminal: true, viewOnly: false };
  const localReviews = useQuery({ queryKey: reviewsKey(local), queryFn: () => api.reviews("all", false), enabled: hostCode !== false });
  // On Ensemble on the web this server's folders are its operator's: Code works on your computers.
  // The shell says so up front; the API's refusal is the fallback while it has not.
  const onComputers = hostCode === false || hostOnly(localReviews.error);
  const mode: "loading" | "local" | "computers" = onComputers ? "computers" : hostCode === null && localReviews.isPending ? "loading" : "local";
  const localRepos = useQuery({ queryKey: reposKey(local), queryFn: () => api.codeRepos(), enabled: hostCode !== false && !onComputers });
  const version = useQuery({ queryKey: ["version"], queryFn: () => api.version(), enabled: mode === "local", staleTime: 300_000, retry: false });
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, enabled: mode === "computers", staleTime: 30_000 });
  const computers = mode === "computers" ? (devices.data?.devices ?? []).map(placeOfDevice) : [];
  const deviceReviews = useQueries({
    queries: computers.map((place) => ({ queryKey: reviewsKey(place), queryFn: () => codeApiFor(place.target).reviews("all", false), enabled: place.usable, retry: false, staleTime: 15_000 })),
  });
  const deviceRepos = useQueries({
    queries: computers.map((place) => ({ queryKey: reposKey(place), queryFn: () => codeApiFor(place.target).codeRepos(), enabled: place.usable, retry: false, staleTime: 60_000 })),
  });
  const board = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, refetchInterval: 15_000, enabled: mode !== "loading", retry: false });

  const states: PlaceState[] =
    mode === "local"
      ? [{ place: { ...local, version: version.data?.version ?? null }, reviews: localReviews, repos: localRepos, views: repoViews(localRepos.data) }]
      : mode === "computers"
        ? computers.map((place, index) => ({ place, reviews: deviceReviews[index]!, repos: deviceRepos[index]!, views: repoViews(deviceRepos[index]!.data) }))
        : [];
  const reviews: HomeReview[] = states
    .flatMap((state) => (state.reviews.data?.reviews ?? []).map((review) => ({ ...review, place: state.place, href: reviewHref(state.place, review.id), repo: repoName(viewFor(review.repoPath, state.views)) })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const repos: HomeRepo[] = states.flatMap((state) => state.views.map((view) => ({ ...view, place: state.place, href: repoHref(state.place, view.path) })));
  const live = states.filter((state) => state.place.usable);
  return {
    mode,
    states,
    devices,
    reviews,
    repos,
    ttlDays: states.find((state) => state.reviews.data)?.reviews.data?.ttlDays ?? 14,
    reviewsLoading: live.some((state) => state.reviews.isLoading),
    reposLoading: live.some((state) => state.repos.isLoading),
    reviewErrors: live.filter((state) => state.reviews.error),
    repoErrors: live.filter((state) => state.repos.error),
    board,
    runs: codeRuns(board.data),
  };
}

export type CodeHome = ReturnType<typeof useCodeHome>;
