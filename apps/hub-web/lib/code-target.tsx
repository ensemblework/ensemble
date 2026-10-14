"use client";

/**
 * Where the Code tab's calls go. On this computer (the desktop app, a local server) they go to this
 * Ensemble's own `/api/code/*`. On Ensemble on the web, a review or repository on a paired computer is
 * opened through that computer (`/code/review?device=<id>&…`): every call is passed to its own Code API
 * (`POST /api/devices/:id/code`, protocol 4), so the same review page, source control and terminal work
 * on it unchanged.
 */
import { createContext, useContext, useMemo } from "react";
import { api, type ActionsResult, type CodeFile, type CodeProgress, type CommitPlan, type CodeSearch, type CodeSource, type CodeTree, type CodeVersions, type FileDiff, type ReviewSummary, type ScmStatus } from "./api";

export type CodeTarget = { kind: "local" } | { kind: "device"; deviceId: string };

export type Source = { review?: string; repo?: string };

/** A short key for query caches, so a computer's review never shares a cache entry with this one's. */
export function targetKey(target: CodeTarget): string {
  return target.kind === "local" ? "local" : `device:${target.deviceId}`;
}

/** Query values as the API reads them: strings only, empty ones left out. */
function query(values: Record<string, string | boolean | undefined | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== "") out[key] = String(value);
  return out;
}

export type CodeApi = {
  codeRepos(): Promise<{ repos: string[]; roots: string[] }>;
  reviews(filter: "needs" | "reviewed" | "all", expired: boolean): Promise<{ reviews: ReviewSummary[]; ttlDays: number }>;
  codeSource(source: Source): Promise<CodeSource>;
  codeDiff(source: Source, path: string, untracked: boolean): Promise<{ diff: FileDiff; decisions: Array<{ chunkKey: string; decision: string }> }>;
  decideHunk(data: Source & { path: string; key: string; untracked: boolean; decision: "accepted" | "rejected" }): Promise<unknown>;
  completeReview(id: string): Promise<unknown>;
  acceptReview(id: string): Promise<{ commit: string | null; branch: string; pushable: boolean }>;
  discardReview(id: string): Promise<{ restored: number; keptCommits: boolean }>;
  pushReview(id: string): Promise<{ branch: string; remote: string }>;
  codeFile(source: Source, path: string): Promise<CodeFile>;
  saveCodeFile(source: Source, path: string, content: string, expectedHash?: string | null): Promise<{ ok: boolean; hash?: string | null }>;
  versions(source: Source, path: string): Promise<CodeVersions>;
  acceptContent(source: Source, path: string, content: string): Promise<unknown>;
  restore(review: string, path: string): Promise<unknown>;
  progress(source: Source): Promise<CodeProgress>;
  tree(source: Source, path: string): Promise<CodeTree>;
  files(source: Source): Promise<{ files: string[]; truncated: boolean }>;
  search(source: Source, q: string, matchCase: boolean): Promise<CodeSearch>;
  commitPlan(source: Source): Promise<CommitPlan>;
  commitPaths(source: Source, paths: string[], message: string): Promise<{ ok: boolean; commit: string; branch: string }>;
  pullRequest(source: Source, pr: { title: string; body: string; base: string; draft: boolean }): Promise<{ ok: boolean; url: string; number: number }>;
  scm(repo: string): Promise<ScmStatus>;
  stage(repo: string, paths: string[]): Promise<unknown>;
  unstage(repo: string, paths: string[]): Promise<unknown>;
  discard(repo: string, paths: string[]): Promise<unknown>;
  commit(repo: string, message: string, all?: boolean): Promise<unknown>;
  push(repo: string): Promise<{ output: string }>;
  pull(repo: string): Promise<{ output: string }>;
  actions(repo: string): Promise<ActionsResult>;
};

const localApi: CodeApi = {
  codeRepos: () => api.codeRepos(),
  reviews: (filter, expired) => api.reviews(filter, expired),
  codeSource: (source) => api.codeSource(source),
  codeDiff: (source, path, untracked) => api.codeDiff(source, path, untracked),
  decideHunk: (data) => api.decideHunk(data),
  completeReview: (id) => api.completeReview(id),
  acceptReview: (id) => api.acceptReview(id),
  discardReview: (id) => api.discardReview(id),
  pushReview: (id) => api.pushReview(id),
  codeFile: (source, path) => api.codeFile(source, path),
  saveCodeFile: (source, path, content, expectedHash) => api.saveCodeFile(source, path, content, expectedHash),
  versions: (source, path) => api.codeVersions(source, path),
  acceptContent: (source, path, content) => api.codeAcceptContent(source, path, content),
  restore: (review, path) => api.codeRestore(review, path),
  progress: (source) => api.codeProgress(source),
  tree: (source, path) => api.codeTree(source, path),
  files: (source) => api.codeFiles(source),
  search: (source, q, matchCase) => api.codeSearch(source, q, matchCase),
  commitPlan: (source) => api.codeCommitPlan(source),
  commitPaths: (source, paths, message) => api.codeCommitPaths(source, paths, message),
  pullRequest: (source, pr) => api.codePullRequest(source, pr),
  scm: (repo) => api.scm(repo),
  stage: (repo, paths) => api.stage(repo, paths),
  unstage: (repo, paths) => api.unstage(repo, paths),
  discard: (repo, paths) => api.discard(repo, paths),
  commit: (repo, message, all) => api.commit(repo, message, all),
  push: (repo) => api.push(repo),
  pull: (repo) => api.pull(repo),
  actions: (repo) => api.actions(repo),
};

/** The same calls, made on a paired computer through Ensemble on the web. */
export function deviceCodeApi(deviceId: string): CodeApi {
  const get = <T,>(path: string, values: Record<string, string | boolean | undefined | null> = {}) => api.deviceCode<T>(deviceId, "GET", path, query(values));
  const post = <T,>(path: string, body: unknown = {}) => api.deviceCode<T>(deviceId, "POST", path, {}, body);
  return {
    codeRepos: () => get("/api/code/repos"),
    reviews: (filter, expired) => get("/api/code/reviews", { filter, expired }),
    codeSource: (source) => get("/api/code/source", { ...source }),
    codeDiff: (source, path, untracked) => get("/api/code/diff", { ...source, path, untracked }),
    decideHunk: (data) => post("/api/code/decide", data),
    completeReview: (id) => post(`/api/code/reviews/${id}/complete`),
    acceptReview: (id) => post(`/api/code/reviews/${id}/accept`),
    discardReview: (id) => post(`/api/code/reviews/${id}/discard`),
    pushReview: (id) => post(`/api/code/reviews/${id}/push`),
    codeFile: (source, path) => get("/api/code/file", { ...source, path }),
    saveCodeFile: (source, path, content, expectedHash) => api.deviceCode(deviceId, "PUT", "/api/code/file", {}, { ...source, path, content, ...(expectedHash === undefined ? {} : { expectedHash }) }),
    versions: (source, path) => get("/api/code/versions", { ...source, path }),
    acceptContent: (source, path, content) => post("/api/code/accept-content", { ...source, path, content }),
    restore: (review, path) => post("/api/code/restore", { review, path }),
    progress: (source) => get("/api/code/progress", { ...source }),
    tree: (source, path) => get("/api/code/tree", { ...source, path }),
    files: (source) => get("/api/code/files", { ...source }),
    search: (source, q, matchCase) => get("/api/code/search", { ...source, q, case: matchCase ? "1" : "0" }),
    commitPlan: (source) => get("/api/code/commit-plan", { ...source }),
    commitPaths: (source, paths, message) => post("/api/code/commit-paths", { ...source, paths, message }),
    pullRequest: (source, pr) => post("/api/code/pull-request", { ...source, ...pr }),
    scm: (repo) => get("/api/code/scm", { repo }),
    stage: (repo, paths) => post("/api/code/scm/stage", { repo, paths }),
    unstage: (repo, paths) => post("/api/code/scm/unstage", { repo, paths }),
    discard: (repo, paths) => post("/api/code/scm/discard", { repo, paths }),
    commit: (repo, message, all = false) => post("/api/code/scm/commit", { repo, message, all }),
    push: (repo) => post("/api/code/scm/push", { repo }),
    pull: (repo) => post("/api/code/scm/pull", { repo }),
    actions: (repo) => get("/api/code/actions", { repo }),
  };
}

export function codeApiFor(target: CodeTarget): CodeApi {
  return target.kind === "local" ? localApi : deviceCodeApi(target.deviceId);
}

const TargetContext = createContext<CodeTarget>({ kind: "local" });

export const CodeTargetProvider = TargetContext.Provider;

export function useCodeTarget(): CodeTarget {
  return useContext(TargetContext);
}

/** The Code calls for the review or repository open now, and the cache key that goes with them. */
export function useCodeApi(): { code: CodeApi; target: CodeTarget; key: string } {
  const target = useCodeTarget();
  const key = targetKey(target);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const code = useMemo(() => codeApiFor(target), [key]);
  return { code, target, key };
}
