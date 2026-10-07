/**
 * Jira Cloud (read only): JQL search and one issue with its description and
 * latest comments, through REST API v3.
 *
 * Two ways in, both from the stored connection: OAuth (a bearer token through
 * api.atlassian.com/ex/jira/{cloudId}) or a pasted API token (Basic
 * email:token against https://{site}).
 */
import { z } from "zod";
import { ConnectorNotConnectedError, type ProviderToken } from "../../connectors/tokens.js";
import { adfToMarkdown } from "../../imports/markdown.js";
import { clip } from "../../lib/office/text.js";
import { defineTool, toolOk, type AppToolMeta } from "../types.js";
import { UNTRUSTED_NOTE, appAccess, appFetch, localStamp, plural, quote } from "./apps-common.js";

const JIRA: AppToolMeta = { provider: "atlassian", suite: "atlassian", products: [], scopes: [["read:jira-work"]], label: "Jira" };

const SITE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.(atlassian\.net|jira\.com|jira-dev\.com)$/;

export interface JiraTarget {
  base: string;
  /** For links people open: https://{site}. */
  site: string | null;
  authorization?: string;
}

/** Where to call and how to sign in, from the saved connection. Only Atlassian hosts are used. */
export function jiraTarget(token: Pick<ProviderToken, "token" | "extra">): JiraTarget {
  const extra = token.extra ?? {};
  const site = extra.site && SITE.test(extra.site.toLowerCase()) ? extra.site.toLowerCase() : null;
  if (extra.auth === "basic") {
    if (!site) throw new ConnectorNotConnectedError("atlassian", "This Jira connection has no site saved. Connect Jira again in Settings → Connections.");
    return { base: `https://${site}`, site: `https://${site}`, authorization: `Basic ${Buffer.from(token.token).toString("base64")}` };
  }
  if (!extra.cloudId) throw new ConnectorNotConnectedError("atlassian", "This Jira connection has no site saved. Connect Jira again in Settings → Connections.");
  return { base: `https://api.atlassian.com/ex/jira/${encodeURIComponent(extra.cloudId)}`, site: site ? `https://${site}` : null };
}

const LIST_FIELDS = ["summary", "status", "assignee", "duedate", "labels", "priority", "project", "issuetype", "updated"];
const ISSUE_FIELDS = [...LIST_FIELDS, "description", "reporter", "created", "parent", "comment"];

interface JiraUser {
  displayName?: string;
  emailAddress?: string;
}

interface JiraFields {
  summary?: string;
  status?: { name?: string; statusCategory?: { key?: string; name?: string } } | null;
  assignee?: JiraUser | null;
  reporter?: JiraUser | null;
  duedate?: string | null;
  labels?: string[];
  priority?: { name?: string } | null;
  project?: { key?: string; name?: string } | null;
  issuetype?: { name?: string } | null;
  parent?: { key?: string; fields?: { summary?: string } } | null;
  created?: string;
  updated?: string;
  description?: unknown;
  comment?: { comments?: Array<{ author?: JiraUser; created?: string; body?: unknown }>; total?: number };
}

interface JiraIssue {
  id: string;
  key: string;
  fields?: JiraFields;
}

function issueRow(issue: JiraIssue, target: JiraTarget, timeZone: string) {
  const fields = issue.fields ?? {};
  return {
    key: issue.key,
    summary: fields.summary ?? "",
    status: fields.status?.name,
    done: fields.status?.statusCategory?.key === "done",
    type: fields.issuetype?.name,
    assignee: fields.assignee?.displayName ?? null,
    due: fields.duedate ?? null,
    priority: fields.priority?.name,
    labels: fields.labels ?? [],
    project: fields.project ? `${fields.project.key ?? ""} ${fields.project.name ?? ""}`.trim() : undefined,
    updated: localStamp(fields.updated, timeZone) || undefined,
    ...(target.site ? { link: `${target.site}/browse/${encodeURIComponent(issue.key)}` } : {}),
  };
}

const notFound = "check the key, and that this Jira account can see it";

export const jiraSearch = defineTool({
  name: "jira_search",
  area: "apps",
  app: JIRA,
  description: "Search Jira issues with JQL. Without JQL, lists open issues assigned to the person, newest first.",
  input: z.object({
    jql: z.string().max(2000).optional().describe('JQL, e.g. project = WEB AND statusCategory != Done ORDER BY duedate'),
    max: z.number().int().min(1).max(50).default(20),
    nextPageToken: z.string().max(2000).optional(),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const access = await appAccess(ctx, JIRA);
    const target = jiraTarget(access);
    const jql = input.jql?.trim() || "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
    const body = await appFetch<{ issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>(ctx, JIRA, access.token, `${target.base}/rest/api/3/search/jql`, {
      method: "POST",
      headers: { Accept: "application/json" },
      ...(target.authorization ? { authorization: target.authorization } : {}),
      body: { jql, maxResults: input.max, fields: LIST_FIELDS, ...(input.nextPageToken ? { nextPageToken: input.nextPageToken } : {}) },
    });
    const issues = (body.issues ?? []).map((issue) => issueRow(issue, target, ctx.settings.timezone));
    return toolOk(`Found ${plural(issues.length, "Jira issue")}${body.nextPageToken && !body.isLast ? " (more available)" : ""}.`, {
      jql,
      issues,
      ...(body.nextPageToken && !body.isLast ? { nextPageToken: body.nextPageToken } : {}),
    });
  },
});

export const jiraGetIssue = defineTool({
  name: "jira_get_issue",
  area: "apps",
  app: JIRA,
  description: "Read one Jira issue by key: fields, the description as Markdown, and the latest comments.",
  input: z.object({
    key: z.string().trim().regex(/^([A-Za-z][A-Za-z0-9_]*-\d+|\d+)$/, "Use an issue key like WEB-42."),
    offset: z.number().int().min(0).default(0).describe("Character offset for a long description; use nextOffset from the last read."),
  }),
  isWrite: false,
  risk: "low",
  async run(ctx, input) {
    const access = await appAccess(ctx, JIRA);
    const target = jiraTarget(access);
    const key = input.key.toUpperCase();
    const issue = await appFetch<JiraIssue>(ctx, JIRA, access.token, `${target.base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS.join(",")}`, {
      headers: { Accept: "application/json" },
      ...(target.authorization ? { authorization: target.authorization } : {}),
      notFound,
    });
    const fields = issue.fields ?? {};
    const zone = ctx.settings.timezone;
    const description = clip(adfToMarkdown(fields.description), input.offset, 5000);
    const comments = (fields.comment?.comments ?? []).slice(-5).map((comment) => ({
      author: comment.author?.displayName ?? "Someone",
      at: localStamp(comment.created, zone),
      text: clip(adfToMarkdown(comment.body), 0, 1200).text,
    }));
    const row = issueRow(issue, target, zone);
    return toolOk(
      `Read ${issue.key} ${quote(row.summary)} (${row.status ?? "no status"}).`,
      {
        ...row,
        reporter: fields.reporter?.displayName ?? null,
        created: localStamp(fields.created, zone) || undefined,
        parent: fields.parent?.key ? `${fields.parent.key}${fields.parent.fields?.summary ? ` ${fields.parent.fields.summary}` : ""}` : undefined,
        description: description.text,
        offset: description.offset,
        total: description.total,
        ...(description.nextOffset !== undefined ? { nextOffset: description.nextOffset } : {}),
        comments,
        commentCount: fields.comment?.total ?? comments.length,
        note: UNTRUSTED_NOTE,
      },
      row.link ? { href: row.link } : {},
    );
  },
});

export const jiraTools = [jiraSearch, jiraGetIssue];
