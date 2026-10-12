/**
 * Linear: issues and projects (search, read with comments), workspace members,
 * and issue comments. Issue ids are Linear's own ids; identifiers like ENG-42 also read.
 */
import type { AppItem, AppItemContent } from "@ensemble/shared-types";
import { linearAuthHeader } from "../../../imports/api/linear.js";
import { facts, itemFetch, itemMarkdown } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const API = "https://api.linear.app/graphql";
const LABEL = "Linear";

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  updatedAt?: string;
  state?: { name?: string; type?: string } | null;
  team?: { key?: string; name?: string } | null;
}

const ISSUE_FIELDS = "id identifier title url updatedAt state { name type } team { key name }";

async function gql<T>(ctx: ItemContext, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const body = await itemFetch<{ data?: T; errors?: Array<{ message?: string; extensions?: { type?: string } }> }>(ctx, "linear", LABEL, API, {
    method: "POST",
    headers: { Authorization: linearAuthHeader(ctx.token.token) },
    body: { query, variables },
  });
  if (body.errors?.length || !body.data) {
    const message = body.errors?.[0]?.message ?? "no data";
    if (/scope|permission|forbidden/i.test(message)) throw new ItemError(`Linear refused: ${message.slice(0, 200)}. Connect Linear again to allow this.`, 403);
    throw new ItemError(`Linear could not answer: ${message.slice(0, 200)}.`);
  }
  return body.data;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;

/** "https://linear.app/team/issue/ENG-42/…" or "ENG-42" → "ENG-42". */
export function linearRef(text: string): string | null {
  const value = text.trim();
  const url = /linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/i.exec(value);
  if (url) return url[1]!.toUpperCase();
  return IDENTIFIER.test(value) ? value.toUpperCase() : null;
}

function issueItem(issue: IssueNode): AppItem {
  return {
    source: "linear",
    kind: "issue",
    id: issue.id,
    title: `${issue.identifier} ${issue.title}`,
    subtitle: [issue.team?.name, issue.state?.name].filter(Boolean).join(" · "),
    url: issue.url,
    updatedAt: issue.updatedAt,
  };
}

export const linearItems: ItemSource = {
  id: "linear",
  provider: "linear",
  label: LABEL,
  kinds: ["issue", "project"],
  async search(ctx, query) {
    const direct = linearRef(query.q);
    if (direct && query.kind !== "project") {
      const found = await gql<{ issue: IssueNode | null }>(ctx, `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id: direct }).catch(() => ({ issue: null }));
      if (found.issue) return [issueItem(found.issue)];
    }
    const out: AppItem[] = [];
    const text = query.q.trim().slice(0, 200);
    if (!query.kind || query.kind === "issue") {
      if (text) {
        const found = await gql<{ searchIssues: { nodes: IssueNode[] } }>(ctx, `query($q: String!, $n: Int!) { searchIssues(term: $q, first: $n) { nodes { ${ISSUE_FIELDS} } } }`, { q: text, n: query.limit });
        out.push(...found.searchIssues.nodes.map(issueItem));
      } else {
        const mine = await gql<{ viewer: { assignedIssues: { nodes: IssueNode[] } } }>(
          ctx,
          `query($n: Int!) { viewer { assignedIssues(first: $n, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE_FIELDS} } } } }`,
          { n: query.limit },
        );
        out.push(...mine.viewer.assignedIssues.nodes.map(issueItem));
      }
    }
    if (!query.kind || query.kind === "project") {
      const projects = await gql<{ projects: { nodes: Array<{ id: string; name: string; url: string; state?: string; updatedAt?: string }> } }>(
        ctx,
        `query($q: String!, $n: Int!) { projects(first: $n, orderBy: updatedAt, filter: { name: { containsIgnoreCase: $q } }) { nodes { id name url state updatedAt } } }`,
        { q: text, n: query.kind ? query.limit : 5 },
      );
      out.push(...projects.projects.nodes.map((row) => ({ source: "linear", kind: "project" as const, id: row.id, title: row.name, subtitle: `Project · ${row.state ?? ""}`.replace(/ · $/, ""), url: row.url, updatedAt: row.updatedAt })));
    }
    return out;
  },
  async read(ctx, ref): Promise<AppItemContent> {
    if (ref.kind === "project") {
      const { project } = await gql<{
        project: {
          id: string;
          name: string;
          url: string;
          state?: string;
          description?: string;
          content?: string;
          targetDate?: string | null;
          updatedAt?: string;
          lead?: { name?: string; email?: string } | null;
          issues: { nodes: IssueNode[] };
        } | null;
      }>(ctx, `query($id: String!) { project(id: $id) { id name url state description content targetDate updatedAt lead { name email } issues(first: 50) { nodes { ${ISSUE_FIELDS} } } } }`, { id: ref.id });
      if (!project) throw new ItemError("Linear could not find that project.", 404);
      const list = facts({ State: project.state, Lead: project.lead?.name, Target: project.targetDate });
      const issues = project.issues.nodes.map((issue) => `- ${issue.identifier} ${issue.title} (${issue.state?.name ?? ""})`).join("\n");
      return {
        source: "linear",
        kind: "project",
        id: project.id,
        title: project.name,
        subtitle: "Project",
        url: project.url,
        updatedAt: project.updatedAt,
        facts: list,
        people: project.lead?.name ? [{ name: project.lead.name, ...(project.lead.email ? { email: project.lead.email } : {}) }] : [],
        text: itemMarkdown(project.name, list, [project.description ?? "", project.content ?? "", issues ? `## Issues\n\n${issues}` : ""].filter(Boolean).join("\n\n")),
      };
    }
    const { issue } = await gql<{
      issue: (IssueNode & {
        description?: string | null;
        priorityLabel?: string;
        dueDate?: string | null;
        assignee?: { name?: string; email?: string } | null;
        creator?: { name?: string; email?: string } | null;
        labels?: { nodes: Array<{ name: string }> };
        project?: { name?: string } | null;
        cycle?: { name?: string | null; number?: number } | null;
        comments?: { nodes: Array<{ body?: string; createdAt?: string; user?: { name?: string } | null }> };
      }) | null;
    }>(
      ctx,
      `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} description priorityLabel dueDate assignee { name email } creator { name email } labels { nodes { name } } project { name } cycle { name number } comments(last: 10) { nodes { body createdAt user { name } } } } }`,
      { id: ref.id },
    );
    if (!issue) throw new ItemError("Linear could not find that issue.", 404);
    const list = facts({
      Status: issue.state?.name,
      Priority: issue.priorityLabel,
      Assignee: issue.assignee?.name,
      Due: issue.dueDate,
      Labels: (issue.labels?.nodes ?? []).map((label) => label.name).join(", "),
      Project: issue.project?.name,
      Cycle: issue.cycle?.name || (issue.cycle?.number ? `Cycle ${issue.cycle.number}` : null),
    });
    const comments = (issue.comments?.nodes ?? []).map((comment) => `**${comment.user?.name ?? "Someone"}** (${(comment.createdAt ?? "").slice(0, 10)}):\n${comment.body ?? ""}`).join("\n\n");
    const people = [issue.assignee, issue.creator]
      .filter((person): person is { name?: string; email?: string } => Boolean(person?.name))
      .map((person) => ({ name: person.name!, ...(person.email ? { email: person.email } : {}) }));
    return {
      ...issueItem(issue),
      facts: list,
      people,
      text: itemMarkdown(`${issue.identifier} ${issue.title}`, list, [issue.description ?? "", comments ? `## Latest comments\n\n${comments}` : ""].filter(Boolean).join("\n\n")),
    };
  },
  async people(ctx) {
    const { users } = await gql<{ users: { nodes: Array<{ name?: string; displayName?: string; email?: string; active?: boolean }> } }>(ctx, `{ users(first: 250) { nodes { name displayName email active } } }`);
    return users.nodes.filter((user) => user.active !== false && (user.name || user.email)).map((user) => ({ name: user.name || user.displayName || user.email!, ...(user.email ? { email: user.email } : {}) }));
  },
  fromUrl(url) {
    const id = linearRef(url);
    return id && /linear\.app\//i.test(url) ? { kind: "issue", id } : null;
  },
  async comment(ctx, ref, body) {
    if (ref.kind !== "issue") throw new ItemError("Only Linear issues take comments here.", 400);
    const { commentCreate } = await gql<{ commentCreate: { success: boolean; comment?: { url?: string } } }>(
      ctx,
      `mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success comment { url } } }`,
      { id: ref.id, body },
    );
    if (!commentCreate.success) throw new ItemError("Linear did not save the comment.");
    return { url: commentCreate.comment?.url };
  },
};
