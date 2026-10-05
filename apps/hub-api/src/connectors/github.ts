/**
 * GitHub REST (docs/03 §2): my open PRs, PRs waiting on my review, and issues
 * assigned to me. Review requests and assignments are proposals on their own;
 * nothing here needs a model to decide that a review request asks for a review.
 */
import { getAccount } from "./accounts.js";
import { upsertArtifact, upsertRepo } from "./ingest.js";
import { ConnectorError, readJson, type Proposal, type SyncContext, type SyncResult } from "./types.js";

interface SearchItem {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  repository_url: string;
  updated_at: string;
  created_at: string;
  state: string;
  draft?: boolean;
  pull_request?: unknown;
  user?: { login: string };
  labels?: Array<{ name: string }>;
  comments: number;
}

export async function githubRequest<T>(token: string, path: string): Promise<T> {
  return readJson<T>(
    await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Ensemble", "X-GitHub-Api-Version": "2022-11-28" },
    }),
    "GitHub",
  );
}

export async function syncGitHub(ctx: SyncContext): Promise<SyncResult> {
  const account = await getAccount(ctx.userId, "github");
  if (!account) throw new ConnectorError("GitHub is not connected. Paste a token or sign in with GitHub in Settings → Connections.", true);
  const me = await githubRequest<{ login: string }>(account.accessToken, "/user");
  const org = process.env.GITHUB_ORG?.trim();
  const scope = `archived:false${org ? ` org:${org}` : ""}`;
  const queries: Array<{ role: "author" | "reviewer" | "assignee"; q: string }> = [
    { role: "author", q: `is:open is:pr author:${me.login} ${scope}` },
    { role: "reviewer", q: `is:open is:pr review-requested:${me.login} ${scope}` },
    { role: "assignee", q: `is:open is:issue assignee:${me.login} ${scope}` },
  ];
  const result: SyncResult = { items: 0, stored: [], proposals: [], triage: [], account: me.login };
  const repoIds = new Map<string, string | null>();
  for (const { role, q } of queries) {
    const page = await githubRequest<{ items: SearchItem[] }>(
      account.accessToken,
      `/search/issues?${new URLSearchParams({ q, per_page: "50", sort: "updated" })}`,
    );
    for (const item of page.items) {
      const fullName = item.repository_url.replace("https://api.github.com/repos/", "");
      if (!repoIds.has(fullName)) repoIds.set(fullName, await upsertRepo(ctx.userId, { fullName }));
      const repoId = repoIds.get(fullName) ?? null;
      const isPr = Boolean(item.pull_request);
      const stored = await upsertArtifact(ctx.userId, {
        kind: isPr ? "pr" : "issue",
        externalId: `${fullName}#${item.number}`,
        url: item.html_url,
        ts: new Date(item.updated_at),
        title: item.title,
        text: item.body ?? "",
        repoId,
        authoredByMe: item.user?.login === me.login,
        participants: item.user ? [{ handle: item.user.login }] : [],
        metadata: {
          repo: fullName,
          number: item.number,
          role,
          draft: Boolean(item.draft),
          labels: (item.labels ?? []).map((label) => label.name),
          comments: item.comments,
          author: item.user?.login ?? null,
        },
      });
      result.items += 1;
      result.stored.push(stored);
      if (role === "reviewer" || role === "assignee") {
        result.proposals.push(proposal(role, fullName, item, stored.id, repoId));
      }
    }
  }
  return result;
}

function proposal(role: "reviewer" | "assignee", repo: string, item: SearchItem, artifactId: string, repoId: string | null): Proposal {
  const ref = `${repo}#${item.number}`;
  return {
    sourceRef: `github:${ref}:${role}`,
    sourceKind: "github",
    title: role === "reviewer" ? `Review ${ref}: ${item.title}` : `${ref}: ${item.title}`,
    description: (item.body ?? "").slice(0, 2000),
    sourceUrl: item.html_url,
    excerpt: item.title,
    priority: role === "reviewer" ? "p1" : (item.labels ?? []).some((label) => /urgent|p0|critical|bug/i.test(label.name)) ? "p1" : "p2",
    repoId,
    artifactId,
    rationale: role === "reviewer" ? `${item.user?.login ?? "Someone"} asked for your review.` : "Assigned to you on GitHub.",
  };
}
