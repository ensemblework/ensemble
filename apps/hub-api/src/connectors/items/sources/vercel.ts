/**
 * Vercel: projects and recent deployments in your personal account and teams, a
 * deployment's state with its build log (errors first), and a project's latest deployments.
 * Ids carry the team the item lives in, which every Vercel call needs:
 * "team_abc/dpl_123", or "dpl_123" for a personal one.
 */
import type { AppItem, AppItemContent } from "@ensemble/shared-types";
import { facts, itemFetch, itemMarkdown } from "../http.js";
import { ItemError, type ItemContext, type ItemSource } from "../types.js";

const API = "https://api.vercel.com";
const LABEL = "Vercel";
const MAX_TEAMS = 5;
const LOG_LINES = 200;
const ERROR_LINES = 40;

interface Team {
  id: string;
  slug: string;
}

interface Project {
  id: string;
  name: string;
  framework?: string | null;
  updatedAt?: number;
  link?: { type?: string; org?: string; repo?: string; projectName?: string } | null;
  latestDeployments?: Array<{ readyState?: string }>;
}

interface Deployment {
  uid: string;
  name: string;
  url?: string;
  created?: number;
  state?: string;
  readyState?: string;
  target?: string | null;
  inspectorUrl?: string | null;
  creator?: { username?: string } | null;
  meta?: Record<string, string | undefined>;
}

interface DeploymentDetail {
  id: string;
  name: string;
  url?: string;
  readyState?: string;
  target?: string | null;
  createdAt?: number;
  ready?: number;
  errorCode?: string;
  errorMessage?: string | null;
  inspectorUrl?: string | null;
  creator?: { username?: string } | null;
  meta?: Record<string, string | undefined>;
}

interface LogEvent {
  type?: string;
  created?: number;
  text?: string;
  payload?: { text?: string; date?: number };
}

const TEAM = /^team_[A-Za-z0-9]{4,64}$/;
const PROJECT_ID = /^prj_[A-Za-z0-9]{4,64}$/;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{4,64}$/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

const headers = (ctx: ItemContext) => ({ Authorization: `Bearer ${ctx.token.token}` });

const withTeam = (path: string, teamId: string | null) => (teamId ? `${path}${path.includes("?") ? "&" : "?"}teamId=${teamId}` : path);

const get = <T>(ctx: ItemContext, path: string, teamId: string | null) => itemFetch<T>(ctx, "vercel", LABEL, `${API}${withTeam(path, teamId)}`, { headers: headers(ctx) });

function teams(ctx: ItemContext): Team[] {
  const saved = ctx.token.meta?.teams;
  if (!Array.isArray(saved)) return [];
  return (saved as Array<Partial<Team>>)
    .filter((team): team is Team => typeof team?.id === "string" && TEAM.test(team.id))
    .map((team) => ({ id: team.id, slug: typeof team.slug === "string" ? team.slug : team.id }));
}

/** Where to look: the personal account, then each team saved at connect. */
const scopes = (ctx: ItemContext): Array<string | null> => [null, ...teams(ctx).slice(0, MAX_TEAMS).map((team) => team.id)];

function dashboardSlug(ctx: ItemContext, teamId: string | null): string | null {
  if (teamId) return teams(ctx).find((team) => team.id === teamId)?.slug ?? null;
  const username = ctx.token.meta?.username;
  return typeof username === "string" && username ? username : null;
}

const joinId = (teamId: string | null, id: string) => (teamId ? `${teamId}/${id}` : id);

function splitId(id: string, pattern: RegExp): { teamId: string | null; id: string } {
  const [first = "", second, extra] = id.split("/");
  if (second === undefined && pattern.test(first)) return { teamId: null, id: first };
  if (extra === undefined && second !== undefined && TEAM.test(first) && pattern.test(second)) return { teamId: first, id: second };
  throw new ItemError("That is not a Vercel id from a search.", 400);
}

const iso = (ms: number | undefined) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : undefined);

const stateOf = (deployment: { state?: string; readyState?: string }) => (deployment.state ?? deployment.readyState ?? "UNKNOWN").toUpperCase();

const commitLine = (meta: Record<string, string | undefined> | undefined) => (meta?.githubCommitMessage ?? meta?.gitlabCommitMessage ?? meta?.bitbucketCommitMessage ?? "").split("\n")[0]!.trim();

const branchOf = (meta: Record<string, string | undefined> | undefined) => meta?.githubCommitRef ?? meta?.gitlabCommitRef ?? meta?.bitbucketCommitRef;

function projectItem(ctx: ItemContext, project: Project, teamId: string | null): AppItem {
  const slug = dashboardSlug(ctx, teamId);
  const latest = project.latestDeployments?.[0]?.readyState;
  return {
    source: "vercel",
    kind: "project",
    id: joinId(teamId, project.id),
    title: project.name,
    subtitle: [project.framework, slug, latest ? `latest ${latest.toLowerCase()}` : null].filter(Boolean).join(" · "),
    url: slug ? `https://vercel.com/${slug}/${project.name}` : undefined,
    updatedAt: iso(project.updatedAt),
  };
}

function deploymentItem(deployment: Deployment, teamId: string | null): AppItem {
  const commit = commitLine(deployment.meta);
  return {
    source: "vercel",
    kind: "deployment",
    id: joinId(teamId, deployment.uid),
    title: `${deployment.name}: ${commit || deployment.url || deployment.uid}`.slice(0, 200),
    subtitle: [stateOf(deployment), deployment.target ?? "preview", branchOf(deployment.meta)].filter(Boolean).join(" · "),
    url: deployment.inspectorUrl ?? (deployment.url ? `https://${deployment.url}` : undefined),
    updatedAt: iso(deployment.created),
  };
}

/** The events endpoint answers with a JSON array, or with one JSON event per line. */
export function vercelLogLines(raw: string): Array<{ type: string; text: string }> {
  let events: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    events = Array.isArray(parsed) ? parsed : [];
  } catch {
    events = raw.split("\n").flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line) as unknown] : [];
      } catch {
        return [];
      }
    });
  }
  return events
    .map((value) => {
      const event = (value ?? {}) as LogEvent;
      return { at: event.created ?? event.payload?.date ?? 0, type: event.type ?? "", text: (event.payload?.text ?? event.text ?? "").replace(ANSI, "").trimEnd() };
    })
    .filter((line) => line.text.trim())
    .sort((a, b) => a.at - b.at)
    .map(({ type, text }) => ({ type, text }));
}

const isError = (line: { type: string; text: string }) => line.type === "stderr" || /\b(error|failed|err!|fatal|exception|cannot find|not found)\b/i.test(line.text);

export const vercelItems: ItemSource = {
  id: "vercel",
  provider: "vercel",
  label: LABEL,
  kinds: ["deployment", "project"],
  async search(ctx, query) {
    const text = query.q.trim().slice(0, 100);
    const needle = text.toLowerCase();
    const projects = new Map<string, AppItem>();
    const deployments = new Map<string, { item: AppItem; at: number }>();
    const places = scopes(ctx);
    const failures: unknown[] = [];
    for (const teamId of places) {
      try {
        if (!query.kind || query.kind === "project") {
          const found = await get<{ projects: Project[] }>(ctx, `/v10/projects?limit=${Math.min(20, query.limit)}${text ? `&search=${encodeURIComponent(text)}` : ""}`, teamId);
          for (const project of found.projects) if (!projects.has(project.id)) projects.set(project.id, projectItem(ctx, project, teamId));
        }
        if (!query.kind || query.kind === "deployment") {
          const found = await get<{ deployments: Deployment[] }>(ctx, "/v6/deployments?limit=20", teamId);
          for (const deployment of found.deployments) {
            const haystack = `${deployment.name} ${commitLine(deployment.meta)} ${branchOf(deployment.meta) ?? ""} ${stateOf(deployment)} ${deployment.target ?? "preview"}`.toLowerCase();
            if (needle && !haystack.includes(needle)) continue;
            if (!deployments.has(deployment.uid)) deployments.set(deployment.uid, { item: deploymentItem(deployment, teamId), at: deployment.created ?? 0 });
          }
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === places.length) throw failures[0];
    const recent = [...deployments.values()].sort((a, b) => b.at - a.at).map((row) => row.item);
    if (query.kind === "deployment") return recent.slice(0, query.limit);
    if (query.kind === "project") return [...projects.values()].slice(0, query.limit);
    return [...[...projects.values()].slice(0, 5), ...recent.slice(0, query.limit)];
  },
  async read(ctx, ref): Promise<AppItemContent> {
    if (ref.kind === "project") {
      const { teamId, id } = splitId(ref.id, PROJECT_ID);
      const project = await get<Project>(ctx, `/v9/projects/${id}`, teamId);
      const { deployments } = await get<{ deployments: Deployment[] }>(ctx, `/v6/deployments?projectId=${id}&limit=10`, teamId);
      const repo = project.link?.org && project.link.repo ? `${project.link.org}/${project.link.repo}` : project.link?.projectName;
      const list = facts({ Framework: project.framework, Repository: repo, "Latest deployment": deployments[0] ? stateOf(deployments[0]) : null });
      const lines = deployments.map((deployment) => {
        const parts = [stateOf(deployment), deployment.target ?? "preview", iso(deployment.created)?.slice(0, 16).replace("T", " "), branchOf(deployment.meta), commitLine(deployment.meta)];
        return `- ${parts.filter(Boolean).join(" · ")}${deployment.inspectorUrl ? ` (${deployment.inspectorUrl})` : ""}`;
      });
      return {
        ...projectItem(ctx, project, teamId),
        facts: list,
        text: itemMarkdown(project.name, list, lines.length ? `## Latest deployments\n\n${lines.join("\n")}` : "No deployments yet."),
      };
    }
    const { teamId, id } = splitId(ref.id, DEPLOYMENT_ID);
    const deployment = await get<DeploymentDetail>(ctx, `/v13/deployments/${id}`, teamId);
    const raw = await itemFetch<string>(ctx, "vercel", LABEL, `${API}${withTeam(`/v3/deployments/${id}/events?direction=backward&limit=400&follow=0`, teamId)}`, {
      headers: headers(ctx),
      text: true,
    }).catch(() => "");
    const lines = vercelLogLines(raw);
    const errors = lines.filter(isError).slice(-ERROR_LINES);
    const tail = lines.slice(-LOG_LINES);
    const state = stateOf(deployment);
    const list = facts({
      State: state,
      Target: deployment.target ?? "preview",
      Branch: branchOf(deployment.meta),
      Commit: commitLine(deployment.meta),
      Creator: deployment.creator?.username,
      Created: iso(deployment.createdAt)?.slice(0, 16).replace("T", " "),
      Error: deployment.errorMessage ?? deployment.errorCode,
    });
    const body = [
      deployment.url ? `URL: https://${deployment.url}` : "",
      errors.length ? `## Errors\n\n\`\`\`\n${errors.map((line) => line.text).join("\n")}\n\`\`\`` : "",
      tail.length ? `## Build log (last ${tail.length} lines)\n\n\`\`\`\n${tail.map((line) => line.text).join("\n")}\n\`\`\`` : "No build log was returned.",
    ];
    return {
      source: "vercel",
      kind: "deployment",
      id: ref.id,
      title: `${deployment.name}: ${commitLine(deployment.meta) || deployment.url || id}`.slice(0, 200),
      subtitle: [state, deployment.target ?? "preview", branchOf(deployment.meta)].filter(Boolean).join(" · "),
      url: deployment.inspectorUrl ?? (deployment.url ? `https://${deployment.url}` : undefined),
      updatedAt: iso(deployment.ready ?? deployment.createdAt),
      facts: list,
      people: deployment.creator?.username ? [{ name: deployment.creator.username, handle: deployment.creator.username }] : [],
      text: itemMarkdown(`${deployment.name} deployment (${state.toLowerCase()})`, list, body.filter(Boolean).join("\n\n")),
    };
  },
};
