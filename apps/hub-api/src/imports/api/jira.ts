/**
 * Jira Cloud REST v3. Token auth: Basic email:token against the site.
 * OAuth: bearer token through api.atlassian.com/ex/jira/{cloudId}.
 * Search uses /rest/api/3/search/jql with nextPageToken.
 */
import { adfToMarkdown } from "../markdown.js";
import { ImportError, type ApiImportSource, type ImportContainer, type ImportItem, type SourceAuth, type SourceContext } from "../types.js";

const MINE = "mine";
const FIELDS = ["summary", "description", "duedate", "labels", "status", "priority", "assignee", "project", "parent", "created", "updated", "resolutiondate", "issuetype"];

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    duedate?: string | null;
    labels?: string[];
    status?: { name?: string; statusCategory?: { key?: string } } | null;
    priority?: { name?: string } | null;
    assignee?: { displayName?: string; emailAddress?: string } | null;
    project?: { id: string; key: string; name: string } | null;
    parent?: { key: string; fields?: { summary?: string } } | null;
    issuetype?: { name?: string } | null;
    created?: string;
    updated?: string;
    resolutiondate?: string | null;
  };
}

export function jiraSiteHost(site: string): string {
  const host = site.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.(atlassian\.net|jira\.com|jira-dev\.com)$/.test(host)) {
    throw new ImportError("Enter your Jira site, like yourteam.atlassian.net.");
  }
  return host;
}

export function jiraBase(auth: SourceAuth): string {
  if (auth.cloudId) return `https://api.atlassian.com/ex/jira/${encodeURIComponent(auth.cloudId)}`;
  if (!auth.site) throw new ImportError("Enter your Jira site, like yourteam.atlassian.net.");
  return `https://${jiraSiteHost(auth.site)}`;
}

export function jiraHeaders(auth: SourceAuth): Record<string, string> {
  if (auth.cloudId) return { Authorization: `Bearer ${auth.token}` };
  if (!auth.email) throw new ImportError("Enter the email of your Atlassian account with the API token.");
  return { Authorization: `Basic ${Buffer.from(`${auth.email}:${auth.token}`).toString("base64")}` };
}

const quote = (value: string) => `"${value.replace(/["\\]/g, "")}"`;

export function jiraIssueItem(issue: JiraIssue, containerId: string, site: string | null): ImportItem {
  const fields = issue.fields;
  const parent = fields.parent ? `Part of ${fields.parent.key}${fields.parent.fields?.summary ? ` ${fields.parent.fields.summary}` : ""}` : "";
  const type = fields.issuetype?.name;
  return {
    kind: "task",
    externalId: issue.id,
    title: fields.summary ? `${fields.summary}` : issue.key,
    description: [adfToMarkdown(fields.description), parent].filter(Boolean).join("\n\n") || null,
    dueDate: fields.duedate ?? null,
    status: fields.status?.name ?? null,
    statusCategory: fields.status?.statusCategory?.key ?? null,
    priority: fields.priority?.name ?? null,
    labels: [...(fields.labels ?? []), ...(type && !/^(task|sub-?task)$/i.test(type) ? [type] : [])],
    assignees: fields.assignee ? [fields.assignee.displayName || fields.assignee.emailAddress || ""] : [],
    url: site ? `https://${site}/browse/${issue.key}` : null,
    containerId,
    projectRef: fields.project?.id ?? null,
    projectName: fields.project?.name ?? null,
    parentRef: fields.parent?.key ?? null,
    createdAt: fields.created ?? null,
    updatedAt: fields.updated ?? null,
    completedAt: fields.resolutiondate ?? null,
  };
}

async function approximateCount(ctx: SourceContext, jql: string): Promise<number | null> {
  try {
    const result = await ctx.http.json<{ count?: number }>(`${jiraBase(ctx.auth)}/rest/api/3/search/approximate-count`, {
      method: "POST",
      headers: jiraHeaders(ctx.auth),
      body: { jql },
    });
    return typeof result.count === "number" ? result.count : null;
  } catch {
    return null;
  }
}

export const jiraSource: ApiImportSource = {
  id: "jira",
  async listContainers(ctx) {
    const base = jiraBase(ctx.auth);
    const projects: ImportContainer[] = [];
    let startAt = 0;
    for (let page = 0; page < 20; page += 1) {
      const result = await ctx.http.json<{ values: Array<{ id: string; key: string; name: string }>; isLast?: boolean; total?: number }>(
        `${base}/rest/api/3/project/search?maxResults=50&startAt=${startAt}&orderBy=name`,
        { headers: jiraHeaders(ctx.auth) },
      );
      for (const project of result.values ?? []) projects.push({ id: project.id, name: `${project.name} (${project.key})`, kind: "project", count: null, parent: project.key, importAs: "tasks" });
      startAt += result.values?.length ?? 0;
      if (result.isLast !== false || !result.values?.length) break;
    }
    for (const project of projects.slice(0, 25)) project.count = await approximateCount(ctx, `project = ${quote(project.parent ?? project.id)}`);
    return [{ id: MINE, name: "Issues assigned to me", kind: "view", count: await approximateCount(ctx, "assignee = currentUser()"), importAs: "tasks" }, ...projects];
  },
  async *fetchItems(ctx, containers) {
    const base = jiraBase(ctx.auth);
    const site = ctx.auth.site ? jiraSiteHost(ctx.auth.site) : null;
    const open = ctx.options.includeCompleted === false ? " AND statusCategory != Done" : "";
    for (const container of containers) {
      const scope = container.id === MINE ? "assignee = currentUser()" : `project = ${quote(container.parent ?? container.id)}`;
      const jql = `${scope}${open} ORDER BY created ASC`;
      let nextPageToken: string | undefined;
      do {
        const page = await ctx.http.json<{ issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>(`${base}/rest/api/3/search/jql`, {
          method: "POST",
          headers: jiraHeaders(ctx.auth),
          body: { jql, maxResults: 100, fields: FIELDS, ...(nextPageToken ? { nextPageToken } : {}) },
        });
        yield (page.issues ?? []).map((issue) => jiraIssueItem(issue, container.id, site));
        nextPageToken = page.isLast === false || (page.nextPageToken && page.isLast !== true) ? page.nextPageToken : undefined;
      } while (nextPageToken && !ctx.signal.aborted);
    }
  },
};
