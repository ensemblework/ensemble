/**
 * Jira: issues (search, read with comments, comment), projects and the site's
 * people. Confluence pages too, but only for a connection made with an API token:
 * Atlassian OAuth grants Ensemble Jira scopes only.
 * Ids: issue keys (WEB-42), project keys (WEB), Confluence page ids.
 */
import type { AppItem, AppItemContent, AppItemPerson } from "@ensemble/shared-types";
import { jiraTarget } from "../../../assistant/tools/jira.js";
import { adfToMarkdown } from "../../../imports/markdown.js";
import { htmlToText } from "../../../lib/office/text.js";
import { facts, itemFetch, itemMarkdown, type ItemRequest } from "../http.js";
import { ItemError, MAX_PEOPLE, type ItemContext, type ItemSource } from "../types.js";

const LABEL = "Jira";
const LIST_FIELDS = ["summary", "status", "project", "issuetype", "updated"];
const ISSUE_FIELDS = ["summary", "status", "assignee", "reporter", "duedate", "labels", "priority", "project", "issuetype", "parent", "updated", "description"];

interface JiraUser {
  accountId?: string;
  accountType?: string;
  displayName?: string;
  emailAddress?: string;
  active?: boolean;
}

interface JiraIssue {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string } | null;
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    duedate?: string | null;
    labels?: string[];
    priority?: { name?: string } | null;
    project?: { key?: string; name?: string } | null;
    issuetype?: { name?: string } | null;
    parent?: { key?: string; fields?: { summary?: string } } | null;
    updated?: string;
    description?: unknown;
  };
}

interface JiraProject {
  id: string;
  key: string;
  name: string;
  description?: string;
  projectTypeKey?: string;
  lead?: JiraUser | null;
  insight?: { lastIssueUpdateTime?: string };
}

interface ConfluenceHit {
  content?: { id?: string; type?: string; title?: string; _links?: { webui?: string } };
  title?: string;
  url?: string;
  lastModified?: string;
  resultGlobalContainer?: { title?: string };
}

interface ConfluencePage {
  id: string;
  title?: string;
  status?: string;
  version?: { number?: number; createdAt?: string };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
}

const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const ATLASSIAN_URL = /^https?:\/\/[a-z0-9-]+\.(?:atlassian\.net|jira\.com)\//i;

/** A Jira or Confluence link, or a bare issue key → what this source reads. */
export function jiraRef(text: string): { kind: "issue" | "project" | "page"; id: string } | null {
  const value = text.trim();
  if (ATLASSIAN_URL.test(value)) {
    const page = /\/wiki\/spaces\/[^/]+\/pages\/(\d+)/.exec(value) ?? /\/wiki\/.*[?&]pageId=(\d+)/.exec(value);
    if (page) return { kind: "page", id: page[1]! };
    const issue = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(value) ?? /[?&]selectedIssue=([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(value);
    if (issue) return { kind: "issue", id: issue[1]!.toUpperCase() };
    const project = /\/(?:browse|projects)\/([A-Za-z][A-Za-z0-9_]*)(?:[/?#]|$)/.exec(value);
    return project ? { kind: "project", id: project[1]!.toUpperCase() } : null;
  }
  return KEY.test(value) ? { kind: "issue", id: value.toUpperCase() } : null;
}

function where(ctx: ItemContext) {
  const target = jiraTarget(ctx.token);
  return { base: target.base, site: target.site, headers: { Authorization: target.authorization ?? `Bearer ${ctx.token.token}` } };
}

const jira = <T>(ctx: ItemContext, path: string, init: Omit<ItemRequest, "headers"> = {}) => {
  const target = where(ctx);
  return itemFetch<T>(ctx, "atlassian", LABEL, `${target.base}${path}`, { ...init, headers: target.headers });
};

/** Confluence on the same site, reachable only with a pasted API token (Basic auth against the site). */
function confluence(ctx: ItemContext): { base: string; headers: Record<string, string> } | null {
  if (ctx.token.extra?.auth !== "basic") return null;
  const target = where(ctx);
  return target.site ? { base: `${target.site}/wiki`, headers: target.headers } : null;
}

const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : undefined);
const searchText = (q: string) => q.replace(/[^\p{L}\p{N}\s._@']/gu, " ").replace(/\s+/g, " ").trim().slice(0, 200);
const hit = ({ source, kind, id, title, subtitle, url, updatedAt }: AppItem): AppItem => ({ source, kind, id, title, subtitle, url, updatedAt });

function person(user: JiraUser | null | undefined): AppItemPerson | null {
  if (!user?.displayName) return null;
  return { name: user.displayName, ...(user.emailAddress ? { email: user.emailAddress } : {}), ...(user.accountId ? { handle: user.accountId } : {}) };
}

function issueItem(issue: JiraIssue, site: string | null): AppItem {
  const fields = issue.fields ?? {};
  return {
    source: "atlassian",
    kind: "issue",
    id: issue.key,
    title: `${issue.key} ${fields.summary ?? ""}`.trim(),
    subtitle: [fields.project?.name, fields.issuetype?.name, fields.status?.name].filter(Boolean).join(" · "),
    url: site ? `${site}/browse/${issue.key}` : undefined,
    updatedAt: fields.updated,
  };
}

function projectItem(project: JiraProject, site: string | null): AppItem {
  return {
    source: "atlassian",
    kind: "project",
    id: project.key,
    title: project.name,
    subtitle: `Project · ${project.key}`,
    url: site ? `${site}/browse/${project.key}` : undefined,
    updatedAt: project.insight?.lastIssueUpdateTime,
  };
}

/** Confluence may be missing from the site; Jira results still count. */
const skipItemError = (error: unknown): AppItem[] => {
  if (error instanceof ItemError) return [];
  throw error;
};

const unhighlight = (text: string) => text.replace(/@@@(?:end)?hl@@@/g, "");

async function searchPages(ctx: ItemContext, text: string, limit: number): Promise<AppItem[]> {
  const wiki = confluence(ctx);
  if (!wiki) return [];
  const cql = text ? `type = page AND text ~ "${text}"` : "type = page AND contributor = currentUser() ORDER BY lastmodified DESC";
  const found = await itemFetch<{ results?: ConfluenceHit[] }>(ctx, "atlassian", "Confluence", `${wiki.base}/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}`, { headers: wiki.headers });
  return (found.results ?? [])
    .filter((row) => row.content?.id && row.content.type === "page")
    .map((row) => ({
      source: "atlassian",
      kind: "page" as const,
      id: row.content!.id!,
      title: unhighlight(row.content!.title ?? row.title ?? "Untitled page"),
      subtitle: ["Confluence page", row.resultGlobalContainer?.title].filter(Boolean).join(" · "),
      url: row.content!._links?.webui ? `${wiki.base}${row.content!._links.webui}` : undefined,
      updatedAt: row.lastModified,
    }));
}

async function readIssue(ctx: ItemContext, id: string): Promise<AppItemContent> {
  if (!KEY.test(id)) throw new ItemError("That is not a Jira issue key like WEB-42.", 400);
  const key = encodeURIComponent(id.toUpperCase());
  const [issue, comments] = await Promise.all([
    jira<JiraIssue>(ctx, `/rest/api/3/issue/${key}?fields=${ISSUE_FIELDS.join(",")}`),
    jira<{ comments?: Array<{ author?: JiraUser; created?: string; body?: unknown }> }>(ctx, `/rest/api/3/issue/${key}/comment?orderBy=-created&maxResults=10`),
  ]);
  const fields = issue.fields ?? {};
  const list = facts({
    Status: fields.status?.name,
    Type: fields.issuetype?.name,
    Priority: fields.priority?.name,
    Assignee: fields.assignee?.displayName,
    Reporter: fields.reporter?.displayName,
    Due: fields.duedate,
    Labels: (fields.labels ?? []).join(", "),
    Project: fields.project?.name,
    Parent: fields.parent?.key ? `${fields.parent.key}${fields.parent.fields?.summary ? ` ${fields.parent.fields.summary}` : ""}` : null,
  });
  const thread = [...(comments.comments ?? [])]
    .reverse()
    .map((comment) => `**${comment.author?.displayName ?? "Someone"}** (${day(comment.created) ?? ""}):\n${adfToMarkdown(comment.body)}`)
    .join("\n\n");
  const people = new Map<string, AppItemPerson>();
  for (const row of [person(fields.assignee), person(fields.reporter)]) if (row) people.set(row.handle ?? row.name, row);
  const item = issueItem(issue, where(ctx).site);
  return {
    ...item,
    facts: list,
    people: [...people.values()],
    text: itemMarkdown(item.title, list, [adfToMarkdown(fields.description), thread ? `## Latest comments\n\n${thread}` : ""].filter(Boolean).join("\n\n")),
  };
}

async function readProject(ctx: ItemContext, id: string): Promise<AppItemContent> {
  if (!PROJECT_KEY.test(id)) throw new ItemError("That is not a Jira project key like WEB.", 400);
  const project = await jira<JiraProject>(ctx, `/rest/api/3/project/${encodeURIComponent(id.toUpperCase())}?expand=description,lead,insight`);
  const open = await jira<{ issues?: JiraIssue[]; isLast?: boolean }>(ctx, "/rest/api/3/search/jql", {
    method: "POST",
    body: { jql: `project = "${project.key}" AND statusCategory != Done ORDER BY updated DESC`, maxResults: 50, fields: ["summary", "status", "assignee"] },
  });
  const issues = open.issues ?? [];
  const list = facts({
    Key: project.key,
    Type: project.projectTypeKey,
    Lead: project.lead?.displayName,
    "Open issues": issues.length ? `${issues.length}${issues.length === 50 ? "+" : ""}` : "0",
  });
  const lines = issues.map((issue) => `- ${issue.key} ${issue.fields?.summary ?? ""} (${[issue.fields?.status?.name, issue.fields?.assignee?.displayName].filter(Boolean).join(", ")})`);
  const item = projectItem(project, where(ctx).site);
  const lead = person(project.lead);
  return {
    ...item,
    facts: list,
    people: lead ? [lead] : [],
    text: itemMarkdown(project.name, list, [project.description ?? "", lines.length ? `## Open issues, latest first\n\n${lines.join("\n")}` : ""].filter(Boolean).join("\n\n")),
  };
}

async function readPage(ctx: ItemContext, id: string): Promise<AppItemContent> {
  const wiki = confluence(ctx);
  if (!wiki) throw new ItemError("Confluence pages need Jira connected with an API token. Connect it that way in Settings → Connections.", 400);
  if (!/^\d+$/.test(id)) throw new ItemError("That is not a Confluence page id.", 400);
  const page = await itemFetch<ConfluencePage>(ctx, "atlassian", "Confluence", `${wiki.base}/api/v2/pages/${id}?body-format=storage`, { headers: wiki.headers });
  const title = page.title ?? "Untitled page";
  const list = facts({ Status: page.status, Version: page.version?.number, Updated: day(page.version?.createdAt) });
  return {
    source: "atlassian",
    kind: "page",
    id: page.id,
    title,
    subtitle: "Confluence page",
    url: page._links?.webui ? `${wiki.base}${page._links.webui}` : undefined,
    updatedAt: page.version?.createdAt,
    facts: list,
    text: itemMarkdown(title, list, htmlToText(page.body?.storage?.value ?? "")),
  };
}

async function read(ctx: ItemContext, ref: { kind: string; id: string }): Promise<AppItemContent> {
  if (ref.kind === "project") return readProject(ctx, ref.id);
  if (ref.kind === "page") return readPage(ctx, ref.id);
  return readIssue(ctx, ref.id);
}

/** Atlassian Document Format for plain text: one paragraph per line. */
export function adfDoc(text: string): { type: "doc"; version: 1; content: Array<{ type: "paragraph"; content: Array<{ type: "text"; text: string }> }> } {
  return {
    type: "doc",
    version: 1,
    content: text.split(/\r?\n/).map((line) => ({ type: "paragraph" as const, content: line.trim() ? [{ type: "text" as const, text: line }] : [] })),
  };
}

export const atlassianItems: ItemSource = {
  id: "atlassian",
  provider: "atlassian",
  label: LABEL,
  kinds: ["issue", "project", "page"],
  async search(ctx, query) {
    const direct = jiraRef(query.q);
    if (direct && (!query.kind || query.kind === direct.kind)) {
      try {
        return [hit(await read(ctx, direct))];
      } catch (error) {
        if (ATLASSIAN_URL.test(query.q.trim()) || !(error instanceof ItemError)) throw error;
      }
    }
    const text = searchText(query.q);
    const site = where(ctx).site;
    const out: AppItem[] = [];
    if (!query.kind || query.kind === "issue") {
      const jql = text ? `text ~ "${text}" ORDER BY updated DESC` : "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
      const found = await jira<{ issues?: JiraIssue[] }>(ctx, "/rest/api/3/search/jql", { method: "POST", body: { jql, maxResults: query.limit, fields: LIST_FIELDS } });
      out.push(...(found.issues ?? []).map((issue) => issueItem(issue, site)));
    }
    if (!query.kind || query.kind === "project") {
      const count = query.kind ? query.limit : Math.min(5, query.limit);
      const found = await jira<{ values?: JiraProject[] }>(ctx, `/rest/api/3/project/search?query=${encodeURIComponent(text)}&maxResults=${count}&orderBy=-lastIssueUpdatedTime&expand=insight`);
      out.push(...(found.values ?? []).map((project) => projectItem(project, site)));
    }
    if (!query.kind || query.kind === "page") {
      const pages = searchPages(ctx, text, query.kind ? query.limit : Math.min(5, query.limit));
      out.push(...(query.kind ? await pages : await pages.catch(skipItemError)));
    }
    return out;
  },
  read,
  async people(ctx) {
    const out = new Map<string, AppItemPerson>();
    for (let startAt = 0; startAt < MAX_PEOPLE && out.size < MAX_PEOPLE; startAt += 200) {
      const page = await jira<JiraUser[]>(ctx, `/rest/api/3/users/search?maxResults=200&startAt=${startAt}`);
      for (const user of page) {
        if (user.accountType !== "atlassian" || user.active === false || !user.accountId) continue;
        const row = person(user);
        if (row) out.set(user.accountId, row);
      }
      if (!page.length) break;
    }
    return [...out.values()].slice(0, MAX_PEOPLE);
  },
  fromUrl(url) {
    const ref = ATLASSIAN_URL.test(url.trim()) ? jiraRef(url) : null;
    return ref?.kind === "issue" ? ref : null;
  },
  async comment(ctx, ref, body) {
    if (ref.kind !== "issue" || !KEY.test(ref.id)) throw new ItemError("Only Jira issues take comments here.", 400);
    const scopes = ctx.token.scopes;
    if (ctx.token.extra?.auth === "bearer" && scopes.length && !scopes.some((scope) => scope === "write:jira-work" || scope === "write:comment:jira")) {
      throw new ItemError("Jira is connected with read-only access, so Ensemble cannot comment. Connect Jira with an API token in Settings → Connections to post updates.", 403);
    }
    const key = ref.id.toUpperCase();
    const posted = await jira<{ id?: string }>(ctx, `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { method: "POST", body: { body: adfDoc(body) } });
    const site = where(ctx).site;
    return site ? { url: `${site}/browse/${key}${posted.id ? `?focusedCommentId=${posted.id}` : ""}` } : {};
  },
};
