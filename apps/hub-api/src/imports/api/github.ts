/** GitHub issues (not pull requests) from chosen repositories, or everything assigned to me. */
import type { ApiImportSource, ImportContainer, ImportItem, SourceContext } from "../types.js";

const API = "https://api.github.com";
const MINE = "mine";
const MAX_PAGES = 100;

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  state_reason?: string | null;
  html_url: string;
  labels?: Array<string | { name?: string }>;
  assignees?: Array<{ login: string }>;
  milestone?: { title?: string; due_on?: string | null } | null;
  pull_request?: unknown;
  repository?: { id: number; full_name: string; name: string };
  repository_url?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
}

const headers = (ctx: SourceContext) => ({
  Authorization: `Bearer ${ctx.auth.token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

export function githubIssueItem(issue: GitHubIssue, container: ImportContainer): ImportItem {
  const repo = issue.repository?.full_name ?? (container.id === MINE ? issue.repository_url?.replace(/^.*\/repos\//, "") : container.id) ?? "";
  return {
    kind: "task",
    externalId: String(issue.id),
    title: issue.title,
    description: issue.body ?? null,
    dueDate: issue.milestone?.due_on ?? null,
    status: issue.state,
    statusCategory: issue.state_reason === "not_planned" ? "not_planned" : issue.state,
    labels: [
      ...(issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name ?? "")),
      ...(issue.milestone?.title ? [issue.milestone.title] : []),
    ],
    assignees: (issue.assignees ?? []).map((person) => person.login),
    url: issue.html_url,
    containerId: container.id,
    projectRef: repo ? `repo:${repo.toLowerCase()}` : null,
    projectName: repo ? repo.split("/").pop() ?? repo : null,
    createdAt: issue.created_at ?? null,
    updatedAt: issue.updated_at ?? null,
    completedAt: issue.closed_at ?? null,
  };
}

export const githubSource: ApiImportSource = {
  id: "github",
  async listContainers(ctx) {
    const repos: ImportContainer[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const batch = await ctx.http.json<Array<{ id: number; full_name: string; has_issues?: boolean; open_issues_count?: number; archived?: boolean }>>(
        `${API}/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
        { headers: headers(ctx) },
      );
      for (const repo of batch) {
        if (repo.has_issues === false || repo.archived) continue;
        repos.push({ id: repo.full_name, name: repo.full_name, kind: "repo", count: repo.open_issues_count ?? null, importAs: "tasks" });
      }
      if (batch.length < 100) break;
    }
    return [{ id: MINE, name: "Issues assigned to me", kind: "view", count: null, importAs: "tasks" }, ...repos];
  },
  async *fetchItems(ctx, containers) {
    const state = ctx.options.includeCompleted === false ? "open" : "all";
    for (const container of containers) {
      for (let page = 1; page <= MAX_PAGES && !ctx.signal.aborted; page += 1) {
        const path = container.id === MINE
          ? `/issues?filter=assigned&state=${state}&per_page=100&page=${page}`
          : `/repos/${container.id.split("/").map(encodeURIComponent).join("/")}/issues?state=${state}&per_page=100&page=${page}`;
        const batch = await ctx.http.json<GitHubIssue[]>(`${API}${path}`, { headers: headers(ctx) });
        yield batch.filter((issue) => !issue.pull_request).map((issue) => githubIssueItem(issue, container));
        if (batch.length < 100) break;
      }
    }
  },
};
