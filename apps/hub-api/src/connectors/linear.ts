/** Linear: open issues assigned to you become proposed todos (docs/03 §2). */
import { getAccount } from "./accounts.js";
import { upsertArtifact } from "./ingest.js";
import { ConnectorError, readJson, type SyncContext, type SyncResult } from "./types.js";

interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  dueDate: string | null;
  updatedAt: string;
  state: { name: string; type: string };
  team: { key: string; name: string };
  project: { name: string } | null;
}

const QUERY = `query {
  viewer {
    name
    email
    assignedIssues(first: 50, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes { id identifier title description url priority dueDate updatedAt state { name type } team { key name } project { name } }
    }
  }
}`;

export async function syncLinear(ctx: SyncContext): Promise<SyncResult> {
  const account = await getAccount(ctx.userId, "linear");
  if (!account) throw new ConnectorError("Linear is not connected. Paste a Linear API key in Settings → Connections.", true);
  const key = account.accessToken;
  const body = await readJson<{ data?: { viewer: { name: string; email: string; assignedIssues: { nodes: Issue[] } } }; errors?: Array<{ message: string }> }>(
    await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key.startsWith("lin_oauth") ? `Bearer ${key}` : key },
      body: JSON.stringify({ query: QUERY }),
    }),
    "Linear",
  );
  if (!body.data) throw new ConnectorError(`Linear: ${body.errors?.[0]?.message ?? "no data returned"}`);
  const viewer = body.data.viewer;
  const result: SyncResult = { items: 0, stored: [], proposals: [], triage: [], account: viewer.email };
  for (const issue of viewer.assignedIssues.nodes) {
    const stored = await upsertArtifact(ctx.userId, {
      kind: "issue",
      externalId: `linear:${issue.identifier}`,
      url: issue.url,
      ts: new Date(issue.updatedAt),
      title: `${issue.identifier} ${issue.title}`,
      text: issue.description ?? "",
      metadata: { source: "linear", state: issue.state.name, team: issue.team.name, project: issue.project?.name ?? null, priority: issue.priority, due: issue.dueDate },
    });
    result.items += 1;
    result.stored.push(stored);
    result.proposals.push({
      sourceRef: `linear:${issue.identifier}`,
      sourceKind: "linear",
      title: `${issue.identifier}: ${issue.title}`,
      description: (issue.description ?? "").slice(0, 2000),
      sourceUrl: issue.url,
      excerpt: `${issue.team.name} · ${issue.state.name}`,
      priority: issue.priority === 1 ? "p0" : issue.priority === 2 ? "p1" : "p2",
      due: issue.dueDate ? new Date(`${issue.dueDate}T17:00:00`) : null,
      artifactId: stored.id,
      rationale: "Assigned to you in Linear.",
    });
  }
  return result;
}
