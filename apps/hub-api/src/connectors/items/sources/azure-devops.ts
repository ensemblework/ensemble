/**
 * Azure DevOps: work items (WIQL title search, or yours that are still open), active
 * pull requests and repositories in the organization saved at connect; a work item with
 * its comments, a pull request with its reviewers and threads; work item comments.
 * Ids: "Project/42" for a work item, "Project/17" for a pull request, "Project/<repo id>"
 * for a repository. A work item link gives "org/Project/42" so a comment never lands in
 * another organization's item with the same number.
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { escapeHtml } from "../../../lib/office/html.js";
import { htmlToText } from "../../../lib/office/text.js";
import { facts, itemFetch, itemMarkdown, type ItemRequest } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const LABEL = "Azure DevOps";
const API_VERSION = "api-version=7.1";
const COMMENTS_VERSION = "api-version=7.1-preview.4";
/** Pull requests are listed per project; more projects means more calls per search. */
const MAX_PR_PROJECTS = 5;

const ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/;
const NUMBER = /^\d{1,10}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_FIELDS = ["System.Id", "System.Title", "System.State", "System.WorkItemType", "System.TeamProject", "System.ChangedDate", "System.AssignedTo"];

interface Identity {
  displayName?: string;
  uniqueName?: string;
}

interface WorkItem {
  id: number;
  fields: Record<string, unknown>;
}

interface PullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status?: string;
  isDraft?: boolean;
  creationDate?: string;
  closedDate?: string;
  sourceRefName?: string;
  targetRefName?: string;
  mergeStatus?: string;
  createdBy?: Identity;
  reviewers?: Array<Identity & { vote?: number }>;
  repository?: { id: string; name: string; project?: { name?: string } };
}

interface Repository {
  id: string;
  name: string;
  defaultBranch?: string;
  webUrl?: string;
  size?: number;
  isDisabled?: boolean;
  project?: { name?: string };
}

function org(ctx: ItemContext): string {
  const value = ctx.token.meta?.org;
  if (typeof value !== "string" || !ORG.test(value)) throw new ItemError("Azure DevOps is connected without an organization. Connect it again in Settings → Connections.", 409);
  return value;
}

const web = (ctx: ItemContext) => `https://dev.azure.com/${org(ctx)}`;
const enc = encodeURIComponent;

function call<T>(ctx: ItemContext, path: string, init: ItemRequest = {}): Promise<T> {
  const auth = `Basic ${Buffer.from(`:${ctx.token.token}`).toString("base64")}`;
  return itemFetch<T>(ctx, "azure_devops", LABEL, `${web(ctx)}${path}`, { ...init, headers: { Authorization: auth, ...init.headers } });
}

const field = (row: WorkItem, name: string): string => {
  const value = row.fields[name];
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return (value as Identity).displayName ?? "";
  return String(value);
};

const identityPerson = (value: unknown): AppItemPerson | null => {
  const person = value as Identity | undefined;
  if (!person?.displayName) return null;
  return { name: person.displayName, ...(person.uniqueName?.includes("@") ? { email: person.uniqueName } : {}) };
};

const workItemUrl = (ctx: ItemContext, project: string, id: number | string) => `${web(ctx)}/${enc(project)}/_workitems/edit/${id}`;

function workItemItem(ctx: ItemContext, row: WorkItem): AppItem {
  const project = field(row, "System.TeamProject");
  return {
    source: "azure_devops",
    kind: "work_item",
    id: `${project}/${row.id}`,
    title: `${field(row, "System.WorkItemType") || "Work item"} ${row.id}: ${field(row, "System.Title")}`,
    subtitle: [project, field(row, "System.State"), field(row, "System.AssignedTo")].filter(Boolean).join(" · "),
    url: workItemUrl(ctx, project, row.id),
    updatedAt: field(row, "System.ChangedDate") || undefined,
  };
}

const prUrl = (ctx: ItemContext, project: string, repo: string, id: number) => `${web(ctx)}/${enc(project)}/_git/${enc(repo)}/pullrequest/${id}`;

function prItem(ctx: ItemContext, pr: PullRequest, fallbackProject: string): AppItem {
  const project = pr.repository?.project?.name ?? fallbackProject;
  const repo = pr.repository?.name ?? "";
  return {
    source: "azure_devops",
    kind: "pull_request",
    id: `${project}/${pr.pullRequestId}`,
    title: pr.title,
    subtitle: [`${project}/${repo} !${pr.pullRequestId}`, pr.isDraft ? "draft" : pr.status, pr.createdBy?.displayName].filter(Boolean).join(" · "),
    url: prUrl(ctx, project, repo, pr.pullRequestId),
    updatedAt: pr.closedDate ?? pr.creationDate,
  };
}

function repoItem(repo: Repository): AppItem {
  const project = repo.project?.name ?? "";
  return {
    source: "azure_devops",
    kind: "repo",
    id: `${project}/${repo.id}`,
    title: `${project}/${repo.name}`,
    subtitle: [repo.defaultBranch?.replace(/^refs\/heads\//, ""), repo.isDisabled ? "disabled" : null].filter(Boolean).join(" · "),
    url: repo.webUrl,
  };
}

const decode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

/** A work item link (dev.azure.com or the older visualstudio.com form) → "org/Project/42". */
export function azureWorkItemRef(text: string): string | null {
  const value = text.trim();
  const match =
    /^https?:\/\/dev\.azure\.com\/([^/?#]+)\/([^/?#]+)\/_workitems\/edit\/(\d{1,10})/i.exec(value) ??
    /^https?:\/\/([^./?#]+)\.visualstudio\.com\/([^/?#]+)\/_workitems\/edit\/(\d{1,10})/i.exec(value);
  const project = match ? decode(match[2]!) : null;
  return match && project && ORG.test(match[1]!) ? `${match[1]}/${project}/${match[3]}` : null;
}

/** "Project/42", or "org/Project/42" when that org is the connected one. Project names never contain "/". */
function projectRef(ctx: ItemContext, id: string, pattern: RegExp, what: string): { project: string; id: string } {
  const parts = id.split("/");
  if (parts.length === 3) {
    const [owner] = parts.splice(0, 1);
    if (owner!.toLowerCase() !== org(ctx).toLowerCase()) throw new ItemError(`That ${what} is in the ${owner} organization, but Azure DevOps is connected to ${org(ctx)}.`, 409);
  }
  const [project, rest] = parts;
  if (parts.length !== 2 || !project || !rest || !pattern.test(rest)) throw new ItemError(`That is not an Azure DevOps ${what} id like Project/42.`, 400);
  return { project, id: rest };
}

async function workItemsByIds(ctx: ItemContext, ids: number[]): Promise<WorkItem[]> {
  if (!ids.length) return [];
  const found = await call<{ value: WorkItem[] }>(ctx, `/_apis/wit/workitems?ids=${ids.slice(0, 200).join(",")}&fields=${SEARCH_FIELDS.join(",")}&errorPolicy=omit&${API_VERSION}`);
  const byId = new Map(found.value.filter(Boolean).map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is WorkItem => Boolean(row));
}

async function searchWorkItems(ctx: ItemContext, q: string, limit: number): Promise<AppItem[]> {
  const number = /^#?(\d{1,10})$/.exec(q);
  if (number) return (await workItemsByIds(ctx, [Number(number[1])])).map((row) => workItemItem(ctx, row));
  const text = q.replace(/'/g, "''").slice(0, 200);
  const where = text ? `[System.Title] CONTAINS '${text}'` : "[System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Done', 'Removed')";
  const found = await call<{ workItems: Array<{ id: number }> }>(ctx, `/_apis/wit/wiql?$top=${limit}&${API_VERSION}`, {
    method: "POST",
    body: { query: `SELECT [System.Id] FROM WorkItems WHERE ${where} ORDER BY [System.ChangedDate] DESC` },
  });
  return (await workItemsByIds(ctx, found.workItems.slice(0, limit).map((row) => row.id))).map((row) => workItemItem(ctx, row));
}

async function searchPullRequests(ctx: ItemContext, q: string, limit: number): Promise<AppItem[]> {
  const needle = q.toLowerCase();
  const { value: projects } = await call<{ value: Array<{ name: string }> }>(ctx, `/_apis/projects?$top=${MAX_PR_PROJECTS}&${API_VERSION}`);
  const out: AppItem[] = [];
  for (const project of projects.slice(0, MAX_PR_PROJECTS)) {
    const { value } = await call<{ value: PullRequest[] }>(ctx, `/${enc(project.name)}/_apis/git/pullrequests?searchCriteria.status=active&$top=50&${API_VERSION}`);
    for (const pr of value) if (!needle || `${pr.title} ${pr.repository?.name ?? ""}`.toLowerCase().includes(needle)) out.push(prItem(ctx, pr, project.name));
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, limit);
}

async function searchRepos(ctx: ItemContext, q: string, limit: number): Promise<AppItem[]> {
  const needle = q.toLowerCase();
  const { value } = await call<{ value: Repository[] }>(ctx, `/_apis/git/repositories?${API_VERSION}`);
  return value.filter((repo) => !needle || `${repo.project?.name ?? ""}/${repo.name}`.toLowerCase().includes(needle)).slice(0, limit).map(repoItem);
}

const VOTES: Record<string, string> = { "10": "approved", "5": "approved with suggestions", "-5": "waiting for author", "-10": "rejected" };

async function readWorkItem(ctx: ItemContext, ref: { project: string; id: string }): Promise<AppItemContent> {
  const row = await call<WorkItem>(ctx, `/${enc(ref.project)}/_apis/wit/workitems/${ref.id}?${API_VERSION}`);
  const comments = await call<{ comments?: Array<{ text?: string; createdDate?: string; createdBy?: Identity }> }>(
    ctx,
    `/${enc(ref.project)}/_apis/wit/workItems/${ref.id}/comments?$top=20&order=desc&${COMMENTS_VERSION}`,
  ).catch(() => ({ comments: [] }));
  const due = field(row, "Microsoft.VSTS.Scheduling.DueDate") || field(row, "Microsoft.VSTS.Scheduling.TargetDate");
  const list = facts({
    Type: field(row, "System.WorkItemType"),
    State: field(row, "System.State"),
    "Assigned to": field(row, "System.AssignedTo"),
    Priority: field(row, "Microsoft.VSTS.Common.Priority"),
    Iteration: field(row, "System.IterationPath"),
    Area: field(row, "System.AreaPath"),
    Tags: field(row, "System.Tags"),
    Due: due ? due.slice(0, 10) : null,
  });
  const sections = [
    ["", field(row, "System.Description")],
    ["Repro steps", field(row, "Microsoft.VSTS.TCM.ReproSteps")],
    ["Acceptance criteria", field(row, "Microsoft.VSTS.Common.AcceptanceCriteria")],
  ]
    .filter(([, html]) => html)
    .map(([heading, html]) => `${heading ? `## ${heading}\n\n` : ""}${htmlToText(html!)}`);
  const thread = [...(comments.comments ?? [])]
    .reverse()
    .map((comment) => `**${comment.createdBy?.displayName ?? "Someone"}** (${(comment.createdDate ?? "").slice(0, 10)}):\n${htmlToText(comment.text ?? "")}`)
    .join("\n\n");
  const people = [row.fields["System.AssignedTo"], row.fields["System.CreatedBy"]].map(identityPerson).filter((person): person is AppItemPerson => Boolean(person));
  const item = workItemItem(ctx, { ...row, fields: { ...row.fields, "System.TeamProject": row.fields["System.TeamProject"] ?? ref.project } });
  return { ...item, facts: list, people, text: itemMarkdown(item.title, list, [...sections, thread ? `## Latest comments\n\n${thread}` : ""].filter(Boolean).join("\n\n")) };
}

async function readPullRequest(ctx: ItemContext, ref: { project: string; id: string }): Promise<AppItemContent> {
  const pr = await call<PullRequest>(ctx, `/${enc(ref.project)}/_apis/git/pullrequests/${ref.id}?${API_VERSION}`);
  const threads = pr.repository?.id
    ? await call<{ value: Array<{ isDeleted?: boolean; comments?: Array<{ content?: string; publishedDate?: string; commentType?: string; author?: Identity }> }> }>(
        ctx,
        `/${enc(ref.project)}/_apis/git/repositories/${pr.repository.id}/pullRequests/${ref.id}/threads?${API_VERSION}`,
      ).catch(() => ({ value: [] }))
    : { value: [] };
  const comments = threads.value
    .filter((thread) => !thread.isDeleted)
    .flatMap((thread) => thread.comments ?? [])
    .filter((comment) => comment.commentType !== "system" && comment.content)
    .sort((a, b) => (a.publishedDate ?? "").localeCompare(b.publishedDate ?? ""))
    .slice(-20);
  const branch = (name: string | undefined) => name?.replace(/^refs\/heads\//, "");
  const list = facts({
    Status: pr.isDraft ? "draft" : pr.status,
    Author: pr.createdBy?.displayName,
    Branches: pr.sourceRefName ? `${branch(pr.sourceRefName)} → ${branch(pr.targetRefName)}` : null,
    Reviewers: (pr.reviewers ?? [])
      .map((reviewer) => {
        const vote = VOTES[String(reviewer.vote ?? 0)];
        return `${reviewer.displayName}${vote ? ` (${vote})` : ""}`;
      })
      .join(", "),
    "Merge status": pr.mergeStatus,
  });
  const thread = comments.map((comment) => `**${comment.author?.displayName ?? "Someone"}** (${(comment.publishedDate ?? "").slice(0, 10)}):\n${comment.content}`).join("\n\n");
  const people = [pr.createdBy, ...(pr.reviewers ?? [])].map(identityPerson).filter((person): person is AppItemPerson => Boolean(person));
  return { ...prItem(ctx, pr, ref.project), facts: list, people, text: itemMarkdown(pr.title, list, [pr.description ?? "", thread ? `## Latest comments\n\n${thread}` : ""].filter(Boolean).join("\n\n")) };
}

async function readRepo(ctx: ItemContext, ref: { project: string; id: string }): Promise<AppItemContent> {
  const repo = await call<Repository>(ctx, `/${enc(ref.project)}/_apis/git/repositories/${ref.id}?${API_VERSION}`);
  const readme = await call<{ content?: string }>(ctx, `/${enc(ref.project)}/_apis/git/repositories/${ref.id}/items?path=${enc("/README.md")}&includeContent=true&${API_VERSION}`)
    .then((row) => row.content ?? "")
    .catch(() => "");
  const list = facts({ "Default branch": repo.defaultBranch?.replace(/^refs\/heads\//, ""), Disabled: repo.isDisabled ? "yes" : null });
  const item = repoItem({ ...repo, project: { name: repo.project?.name ?? ref.project } });
  return { ...item, facts: list, text: itemMarkdown(item.title, list, readme ? `## README\n\n${readme}` : "") };
}

export const azureDevopsItems: ItemSource = {
  id: "azure_devops",
  provider: "azure_devops",
  label: LABEL,
  kinds: ["work_item", "pull_request", "repo"],
  async search(ctx, query) {
    const q = query.q.trim();
    const link = azureWorkItemRef(q);
    if (link) {
      if (query.kind && query.kind !== "work_item") return [];
      const read = await readWorkItem(ctx, projectRef(ctx, link, NUMBER, "work item"));
      return [{ source: read.source, kind: read.kind, id: read.id, title: read.title, subtitle: read.subtitle, url: read.url, updatedAt: read.updatedAt }];
    }
    const out: AppItem[] = [];
    if (!query.kind || query.kind === "work_item") out.push(...(await searchWorkItems(ctx, q, query.limit)));
    if (!query.kind || query.kind === "pull_request") out.push(...(await searchPullRequests(ctx, q, query.kind ? query.limit : 5)));
    if (!query.kind || query.kind === "repo") out.push(...(await searchRepos(ctx, q, query.kind ? query.limit : 3)));
    return out;
  },
  async read(ctx, ref) {
    if (ref.kind === "pull_request") return readPullRequest(ctx, projectRef(ctx, ref.id, NUMBER, "pull request"));
    if (ref.kind === "repo") return readRepo(ctx, projectRef(ctx, ref.id, GUID, "repository"));
    return readWorkItem(ctx, projectRef(ctx, ref.id, NUMBER, "work item"));
  },
  fromUrl(url) {
    const id = azureWorkItemRef(url);
    return id ? { kind: "work_item", id } : null;
  },
  async comment(ctx, ref, body) {
    if (ref.kind !== "work_item") throw new ItemError("Only Azure DevOps work items take comments here.", 400);
    const { project, id } = projectRef(ctx, ref.id, NUMBER, "work item");
    await call(ctx, `/${enc(project)}/_apis/wit/workItems/${id}/comments?${COMMENTS_VERSION}`, {
      method: "POST",
      body: { text: escapeHtml(body).replace(/\n/g, "<br>") },
    });
    return { url: workItemUrl(ctx, project, id) };
  },
};
