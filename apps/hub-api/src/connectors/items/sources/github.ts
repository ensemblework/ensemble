/**
 * GitHub: repositories you can reach, issues and pull requests that involve you,
 * organisation members, and comments on issues and pull requests.
 * Ids: "owner/name" for a repository, "owner/name#123" for an issue or pull request.
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { capText, facts, itemFetch, itemMarkdown } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const API = "https://api.github.com";
const LABEL = "GitHub";

interface Repo {
  full_name: string;
  html_url: string;
  description?: string | null;
  private?: boolean;
  archived?: boolean;
  default_branch?: string;
  language?: string | null;
  pushed_at?: string;
  updated_at?: string;
  open_issues_count?: number;
}

interface Issue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  body?: string | null;
  user?: { login?: string } | null;
  assignees?: Array<{ login?: string }>;
  labels?: Array<{ name?: string } | string>;
  milestone?: { title?: string; due_on?: string | null } | null;
  pull_request?: unknown;
  repository_url?: string;
  updated_at?: string;
  comments?: number;
  draft?: boolean;
  merged_at?: string | null;
}

const headers = (ctx: ItemContext) => ({
  Authorization: `Bearer ${ctx.token.token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "Ensemble",
});

const get = <T>(ctx: ItemContext, path: string) => itemFetch<T>(ctx, "github", LABEL, `${API}${path}`, { headers: headers(ctx) });

const REPO_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_ID = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/;

/** "https://github.com/o/r/issues/4", "o/r#4" or "o/r" → an id this source reads. */
export function githubRef(text: string): { kind: "repo" | "issue"; id: string } | null {
  const value = text.trim().replace(/\.git$/, "");
  const url = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s#?]+)(?:\/(?:issues|pull)\/(\d+))?/i.exec(value);
  if (url) return url[2] ? { kind: "issue", id: `${url[1]}#${url[2]}` } : { kind: "repo", id: url[1]! };
  if (ISSUE_ID.test(value)) return { kind: "issue", id: value };
  if (REPO_ID.test(value)) return { kind: "repo", id: value };
  return null;
}

function repoItem(repo: Repo): AppItem {
  return {
    source: "github",
    kind: "repo",
    id: repo.full_name,
    title: repo.full_name,
    subtitle: [repo.private ? "private" : "public", repo.language, repo.archived ? "archived" : null, repo.description].filter(Boolean).join(" · ").slice(0, 160),
    url: repo.html_url,
    updatedAt: repo.pushed_at ?? repo.updated_at,
  };
}

function repoOf(issue: Issue): string {
  const match = /repos\/([^/]+\/[^/]+)$/.exec(issue.repository_url ?? "") ?? /github\.com\/([^/]+\/[^/]+)\//.exec(issue.html_url);
  return match?.[1] ?? "";
}

function issueItem(issue: Issue): AppItem {
  const repo = repoOf(issue);
  const pr = Boolean(issue.pull_request);
  return {
    source: "github",
    kind: pr ? "pull_request" : "issue",
    id: `${repo}#${issue.number}`,
    title: issue.title,
    subtitle: `${repo} #${issue.number} · ${issue.merged_at ? "merged" : issue.state}${issue.draft ? " · draft" : ""}`,
    url: issue.html_url,
    updatedAt: issue.updated_at,
  };
}

/** Repositories the connection can reach: yours, collaborations and organisations, newest push first. */
export async function listGithubRepos(ctx: ItemContext, q = "", limit = 30): Promise<AppItem[]> {
  const needle = q.trim().toLowerCase();
  const out: AppItem[] = [];
  for (let page = 1; page <= 5 && out.length < limit; page += 1) {
    const repos = await get<Repo[]>(ctx, `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
    for (const repo of repos) {
      if (needle && !`${repo.full_name} ${repo.description ?? ""}`.toLowerCase().includes(needle)) continue;
      out.push(repoItem(repo));
      if (out.length >= limit) break;
    }
    if (repos.length < 100) break;
  }
  return out;
}

async function login(ctx: ItemContext): Promise<string> {
  if (ctx.token.account && /^[A-Za-z0-9-]+$/.test(ctx.token.account)) return ctx.token.account;
  const me = await get<{ login: string }>(ctx, "/user");
  return me.login;
}

const labelNames = (labels: Issue["labels"]) => (labels ?? []).map((label) => (typeof label === "string" ? label : (label.name ?? ""))).filter(Boolean);

export const githubItems: ItemSource = {
  id: "github",
  provider: "github",
  label: LABEL,
  kinds: ["repo", "issue", "pull_request"],
  async search(ctx, query) {
    const direct = githubRef(query.q);
    if (direct) {
      const read = await this.read(ctx, direct);
      return [{ source: read.source, kind: read.kind, id: read.id, title: read.title, subtitle: read.subtitle, url: read.url, updatedAt: read.updatedAt }];
    }
    const results: AppItem[] = [];
    if (!query.kind || query.kind === "repo") results.push(...(await listGithubRepos(ctx, query.q, query.kind ? query.limit : Math.min(5, query.limit))));
    if (!query.kind || query.kind === "issue" || query.kind === "pull_request") {
      const who = await login(ctx);
      const type = query.kind === "pull_request" ? " is:pr" : query.kind === "issue" ? " is:issue" : "";
      const text = query.q.trim().replace(/[^\p{L}\p{N}\s._/#-]/gu, " ").slice(0, 200);
      const q = `${text}${type} involves:${who}${text ? "" : " is:open"} archived:false`;
      const found = await get<{ items: Issue[] }>(ctx, `/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${query.limit}`);
      results.push(...found.items.map(issueItem));
    }
    return results.slice(0, query.kind ? query.limit : query.limit + 5);
  },
  async read(ctx, ref): Promise<AppItemContent> {
    if (ref.kind === "repo") {
      if (!REPO_ID.test(ref.id)) throw new ItemError("That is not a GitHub repository name like owner/name.", 400);
      const repo = await get<Repo>(ctx, `/repos/${ref.id}`);
      let readme = "";
      try {
        readme = await itemFetch<string>(ctx, "github", LABEL, `${API}/repos/${ref.id}/readme`, { headers: { ...headers(ctx), Accept: "application/vnd.github.raw+json" }, text: true });
      } catch {
        readme = "";
      }
      const list = facts({
        Visibility: repo.private ? "private" : "public",
        "Default branch": repo.default_branch,
        Language: repo.language,
        "Open issues and pull requests": repo.open_issues_count,
        Archived: repo.archived ? "yes" : null,
      });
      return {
        ...repoItem(repo),
        facts: list,
        text: itemMarkdown(repo.full_name, list, [repo.description ?? "", readme ? `## README\n\n${capText(readme, 12_000)}` : ""].filter(Boolean).join("\n\n")),
      };
    }
    const match = ISSUE_ID.exec(ref.id);
    if (!match) throw new ItemError("That is not a GitHub issue like owner/name#123.", 400);
    const [, repo, number] = match;
    const issue = await get<Issue>(ctx, `/repos/${repo}/issues/${number}`);
    const comments = issue.comments ? await get<Array<{ user?: { login?: string }; body?: string; created_at?: string }>>(ctx, `/repos/${repo}/issues/${number}/comments?per_page=10&page=${Math.max(1, Math.ceil(issue.comments / 10))}`) : [];
    const list = facts({
      State: issue.merged_at ? "merged" : issue.state,
      Author: issue.user?.login,
      Assignees: (issue.assignees ?? []).map((row) => row.login).filter(Boolean).join(", "),
      Labels: labelNames(issue.labels).join(", "),
      Milestone: issue.milestone?.title,
      Due: issue.milestone?.due_on?.slice(0, 10),
    });
    const thread = comments.map((comment) => `**${comment.user?.login ?? "someone"}** (${(comment.created_at ?? "").slice(0, 10)}):\n${comment.body ?? ""}`).join("\n\n");
    const people: AppItemPerson[] = [issue.user?.login, ...(issue.assignees ?? []).map((row) => row.login)]
      .filter((value): value is string => Boolean(value))
      .map((handle) => ({ name: handle, handle }));
    return {
      ...issueItem(issue),
      facts: list,
      people,
      text: itemMarkdown(issue.title, list, [issue.body ?? "", thread ? `## Latest comments\n\n${thread}` : ""].filter(Boolean).join("\n\n")),
    };
  },
  async people(ctx) {
    const orgs = await get<Array<{ login: string }>>(ctx, "/user/orgs?per_page=10");
    const seen = new Map<string, AppItemPerson>();
    for (const org of orgs.slice(0, 5)) {
      const members = await get<Array<{ login: string; type?: string }>>(ctx, `/orgs/${encodeURIComponent(org.login)}/members?per_page=100`);
      for (const member of members) {
        if (member.type === "Bot") continue;
        seen.set(member.login.toLowerCase(), { name: member.login, handle: member.login, title: org.login });
      }
    }
    return [...seen.values()];
  },
  fromUrl(url) {
    const ref = githubRef(url);
    return ref?.kind === "issue" ? ref : null;
  },
  async comment(ctx, ref, body) {
    const match = ISSUE_ID.exec(ref.id);
    if (!match) throw new ItemError("Only GitHub issues and pull requests take comments.", 400);
    const posted = await itemFetch<{ html_url?: string }>(ctx, "github", LABEL, `${API}/repos/${match[1]}/issues/${match[2]}/comments`, {
      method: "POST",
      headers: headers(ctx),
      body: { body },
    });
    return { url: posted.html_url };
  },
};
