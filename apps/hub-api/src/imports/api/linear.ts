/** Linear over GraphQL: teams to pick from, plus "assigned to me". */
import { ImportError, type ApiImportSource, type ImportContainer, type ImportItem, type SourceContext } from "../types.js";

const API = "https://api.linear.app/graphql";
const MINE = "mine";

interface Connection<T> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url?: string | null;
  priorityLabel?: string | null;
  dueDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
  state?: { name: string; type: string } | null;
  labels?: { nodes: Array<{ name: string }> } | null;
  assignee?: { name?: string | null; displayName?: string | null; email?: string | null } | null;
  project?: { id: string; name: string } | null;
  team?: { id: string; name: string; key: string } | null;
  parent?: { identifier: string; title: string } | null;
  cycle?: { number: number; name?: string | null } | null;
}

const ISSUE_FIELDS = `
  id identifier title description url priorityLabel dueDate createdAt updatedAt completedAt canceledAt
  state { name type }
  labels(first: 20) { nodes { name } }
  assignee { name displayName email }
  project { id name }
  team { id name key }
  parent { identifier title }
  cycle { number name }
`;

export function linearAuthHeader(token: string): string {
  // Personal API keys go in as-is; OAuth access tokens are bearer tokens.
  return token.startsWith("lin_api_") ? token : `Bearer ${token}`;
}

async function gql<T>(ctx: SourceContext, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await ctx.http.json<{ data?: T; errors?: Array<{ message?: string }> }>(API, {
    method: "POST",
    headers: { Authorization: linearAuthHeader(ctx.auth.token) },
    body: { query, variables },
  });
  if (response.errors?.length || !response.data) {
    throw new ImportError(`Linear could not answer: ${response.errors?.[0]?.message?.slice(0, 200) ?? "no data"}.`, 502);
  }
  return response.data;
}

export function linearIssueItem(issue: LinearIssue, containerId: string): ImportItem {
  const labels = (issue.labels?.nodes ?? []).map((label) => label.name);
  if (issue.cycle?.name || issue.cycle?.number) labels.push(issue.cycle.name || `Cycle ${issue.cycle.number}`);
  const parent = issue.parent ? `Sub-issue of ${issue.parent.identifier} ${issue.parent.title}` : "";
  return {
    kind: "task",
    externalId: issue.identifier,
    title: issue.title,
    description: [issue.description ?? "", parent].filter(Boolean).join("\n\n") || null,
    dueDate: issue.dueDate ?? null,
    status: issue.state?.name ?? null,
    statusCategory: issue.state?.type ?? null,
    priority: issue.priorityLabel ?? null,
    labels,
    assignees: issue.assignee ? [issue.assignee.name || issue.assignee.displayName || issue.assignee.email || ""] : [],
    url: issue.url ?? null,
    containerId,
    projectRef: issue.project?.id ?? null,
    projectName: issue.project?.name ?? null,
    parentRef: issue.parent?.identifier ?? null,
    createdAt: issue.createdAt ?? null,
    updatedAt: issue.updatedAt ?? null,
    completedAt: issue.completedAt ?? issue.canceledAt ?? null,
  };
}

export const linearSource: ApiImportSource = {
  id: "linear",
  async listContainers(ctx) {
    const data = await gql<{ viewer: { name: string }; teams: Connection<{ id: string; name: string; key: string }> }>(
      ctx,
      `query { viewer { name } teams(first: 100) { nodes { id name key } pageInfo { hasNextPage endCursor } } }`,
    );
    return [
      { id: MINE, name: "Issues assigned to me", kind: "view", count: null, importAs: "tasks" },
      ...data.teams.nodes.map((team): ImportContainer => ({ id: team.id, name: `${team.name} (${team.key})`, kind: "team", count: null, importAs: "tasks" })),
    ];
  },
  async *fetchItems(ctx, containers) {
    const filter = ctx.options.includeCompleted === false ? `, filter: { state: { type: { nin: ["completed", "canceled"] } } }` : "";
    for (const container of containers) {
      let after: string | null = null;
      do {
        let page: Connection<LinearIssue>;
        if (container.id === MINE) {
          const data: { viewer: { assignedIssues: Connection<LinearIssue> } } = await gql(
            ctx,
            `query($after: String) { viewer { assignedIssues(first: 50, after: $after${filter}) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
            { after },
          );
          page = data.viewer.assignedIssues;
        } else {
          const teamFilter = ctx.options.includeCompleted === false
            ? `{ team: { id: { eq: $team } }, state: { type: { nin: ["completed", "canceled"] } } }`
            : `{ team: { id: { eq: $team } } }`;
          const data: { issues: Connection<LinearIssue> } = await gql(
            ctx,
            `query($team: ID!, $after: String) { issues(first: 50, after: $after, filter: ${teamFilter}) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
            { team: container.id, after },
          );
          page = data.issues;
        }
        yield page.nodes.map((issue) => linearIssueItem(issue, container.id));
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after && !ctx.signal.aborted);
    }
  },
};
