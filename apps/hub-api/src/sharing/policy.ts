/**
 * What a person may reach inside a space that is not theirs.
 *
 * Deny by default: a route that is not listed here is owner-only, so a new route can never be
 * opened to someone a space is shared with by accident. `policy.test.ts` checks that every
 * route in scripts/route-inventory.json has a class.
 *
 * Classes, for a space member (the owner is never restricted here):
 *   shared    the space's content. Viewers may only read (GET); editors may also write.
 *   personal  acts on the signed-in person's own account, not the space: settings, model keys,
 *             notifications, devices, metrics, activity. `request.userId` becomes the account.
 *   owner     the owner's private surfaces: connected apps, imports, reminders, Today, terminal,
 *             tokens, data deletion, code changes on the host. Members get 403.
 *   runner    work on a computer. Editors may assign to their own computers; the handler lets
 *             only the person whose computer runs a job stop it or answer it.
 *   assistant model calls on the space's data with the person's own keys (see context.ts).
 *   self      routes that already act on the signed-in account (auth, spaces, sharing).
 *   live      the event stream and presence. Viewers may post here.
 *   open      catalogues and health checks that hold no space data.
 *
 * Single items shared with someone (a page, a diagram) are narrower still: see SHARE_RULES.
 */
import type { PublicKind, ShareKind } from "./context.js";

export type RouteClass = "shared" | "personal" | "owner" | "runner" | "assistant" | "self" | "live" | "open" | "prefs";

type Rule = [methods: string, pattern: string, cls: RouteClass];

/** First match wins. A pattern ending in `*` matches that prefix of the route pattern. */
const RULES: Rule[] = [
  ["*", "/health*", "open"],
  ["*", "/api/themes/*", "open"],
  ["GET", "/api/marketplace/templates*", "open"],
  ["GET", "/api/onboarding/templates", "open"],
  ["GET", "/api/mcp-client-metadata.json", "open"],

  ["*", "/api/auth/*", "self"],
  ["POST", "/api/cli/auth/approve", "owner"],
  ["*", "/api/cli/*", "self"],
  ["*", "/api/spaces*", "self"],
  ["*", "/api/sharing/*", "self"],
  ["*", "/api/links*", "self"],

  ["GET", "/api/events", "live"],
  ["POST", "/api/events/ticket", "live"],
  ["POST", "/api/presence", "live"],
  ["GET", "/api/presence", "live"],

  ["*", "/api/settings/modules", "owner"],
  ["*", "/api/settings", "personal"],
  ["*", "/api/model-keys*", "personal"],
  ["*", "/api/models*", "personal"],
  ["*", "/api/secrets/*", "personal"],
  ["*", "/api/notifications*", "personal"],
  ["*", "/api/metrics/*", "personal"],
  ["*", "/api/activity*", "personal"],
  ["GET", "/api/devices", "personal"],
  ["DELETE", "/api/devices/:id", "personal"],
  ["POST", "/api/devices/pair", "personal"],
  ["POST", "/api/devices/register", "personal"],

  ["*", "/api/assistant/*", "assistant"],
  ["POST", "/api/ask", "assistant"],
  ["POST", "/api/ensemble/invoke", "assistant"],
  ["POST", "/api/pages/:kind/:id/ensemble", "assistant"],
  ["POST", "/api/meetings/summarize", "assistant"],

  ["POST", "/api/agent/assign", "runner"],
  ["POST", "/api/agent/jobs/:id/retry", "runner"],
  ["POST", "/api/agent/jobs/:id/stop", "runner"],
  ["POST", "/api/decisions/:id/decide", "runner"],
  ["GET", "/api/agent/*", "shared"],
  ["GET", "/api/approvals", "shared"],
  ["GET", "/api/decisions", "shared"],
  ["GET", "/api/code/*", "shared"],
  ["GET", "/api/runs*", "shared"],
  ["GET", "/api/workspace*", "shared"],
  ["GET", "/api/layouts/:surface", "shared"],
  ["GET", "/api/prompts", "shared"],
  ["GET", "/api/recap/*", "shared"],
  ["GET", "/api/completed", "shared"],
  ["GET", "/api/artifacts", "shared"],
  ["GET", "/api/entities", "shared"],
  ["GET", "/api/shell", "shared"],
  // The space's live tiles for Context, without the owner's reminders or synced inbox (desk/live.ts).
  ["GET", "/api/desk/live", "shared"],
  ["GET", "/api/meetings/imported", "shared"],
  ["GET", "/api/meetings/notes/:id", "shared"],
  ["GET", "/api/ensemble/replies", "shared"],
  ["POST", "/api/ensemble/replies/:id/applied", "shared"],
  ["GET", "/api/preferences", "shared"],
  ["*", "/api/preferences/:key", "prefs"],

  ["*", "/api/tasks*", "shared"],
  ["*", "/api/pages*", "shared"],
  ["*", "/api/comments/*", "shared"],
  ["*", "/api/projects*", "shared"],
  ["*", "/api/deliverables*", "shared"],
  ["*", "/api/diagrams*", "shared"],
  ["*", "/api/plots*", "shared"],
  ["*", "/api/skills*", "shared"],
  ["*", "/api/documents*", "shared"],
  // Repositories are connected with the owner's GitHub key: members read them, only the owner links them.
  ["GET", "/api/repos*", "shared"],
  ["*", "/api/meetings/sessions*", "shared"],
  ["GET", "/api/context/*", "shared"],
  ["PUT", "/api/context/order", "shared"],
  ["POST", "/api/undo", "shared"],
  ["POST", "/api/redo", "shared"],
  ["GET", "/api/people", "shared"],
  ["POST", "/api/people", "shared"],
  ["PATCH", "/api/people/:id", "shared"],
  ["DELETE", "/api/people/:id", "shared"],
];

function matches(pattern: string, url: string): boolean {
  return pattern.endsWith("*") ? url.startsWith(pattern.slice(0, -1)) : pattern === url;
}

/** The class of one route. Unlisted routes are owner-only. */
export function classify(method: string, url: string): RouteClass {
  const verb = method === "HEAD" ? "GET" : method;
  for (const [methods, pattern, cls] of RULES) {
    if ((methods === "*" || methods === verb) && matches(pattern, url)) return cls;
  }
  return "owner";
}

export type MemberDecision = { allow: true; personal: boolean } | { allow: false; status: 403; message: string };

const READ = new Set(["GET", "HEAD", "OPTIONS"]);

/** A viewer may ask the assistant about the space, never apply what it proposes. */
const VIEWER_ASSISTANT = new Set(["POST /api/assistant/turn", "POST /api/assistant/conversations", "POST /api/assistant/conversations/:id/stop", "POST /api/ask"]);

/** A whole-space member's request. The owner never reaches this. */
export function memberDecision(method: string, url: string, role: "viewer" | "editor", ownerName: string): MemberDecision {
  const cls = classify(method, url);
  const owned = (): MemberDecision => ({ allow: false, status: 403, message: `Only ${ownerName} can do this in their space.` });
  switch (cls) {
    case "open":
    case "self":
    case "live":
      return { allow: true, personal: false };
    case "personal":
      return { allow: true, personal: true };
    case "assistant":
      if (role === "viewer" && !READ.has(method) && !VIEWER_ASSISTANT.has(`${method} ${url}`)) {
        return { allow: false, status: 403, message: "You can view this space. Ask its owner for edit access." };
      }
      return { allow: true, personal: false };
    case "prefs":
      // The handler decides per key: your own layout and shortcuts, never the owner's other preferences.
      return { allow: true, personal: false };
    case "shared":
      if (role === "viewer" && !READ.has(method)) return { allow: false, status: 403, message: "You can view this space. Ask its owner for edit access." };
      return { allow: true, personal: false };
    case "runner":
      if (role === "viewer") return { allow: false, status: 403, message: "You can view this space. Ask its owner for edit access." };
      return { allow: true, personal: false };
    case "owner":
    default:
      return owned();
  }
}

/**
 * Single shared items. Each rule names the routes that item's viewer needs, the role it takes,
 * and which route parameter (or query or body field) must be the shared item's id.
 */
type ShareRule = { method: string; url: string; role: "view" | "edit"; bind?: { param?: string; query?: string; body?: string; kind?: string } };

const PAGE: ShareRule[] = [
  { method: "GET", url: "/api/pages/:id", role: "view", bind: { param: "id" } },
  { method: "PUT", url: "/api/pages/:id", role: "edit", bind: { param: "id" } },
  { method: "PATCH", url: "/api/pages/:id", role: "edit", bind: { param: "id" } },
  { method: "GET", url: "/api/pages/:kind/:id/comments", role: "view", bind: { param: "id", kind: "page" } },
  { method: "POST", url: "/api/pages/:kind/:id/comments", role: "edit", bind: { param: "id", kind: "page" } },
  // Your own comments on it. The handler checks the comment belongs to the shared item.
  { method: "PATCH", url: "/api/comments/:id", role: "edit" },
  { method: "DELETE", url: "/api/comments/:id", role: "edit" },
];

const TASK: ShareRule[] = [
  { method: "GET", url: "/api/tasks/:id", role: "view", bind: { param: "id" } },
  { method: "PATCH", url: "/api/tasks/:id", role: "edit", bind: { param: "id" } },
  { method: "GET", url: "/api/tasks/:id/page", role: "view", bind: { param: "id" } },
  { method: "PUT", url: "/api/tasks/:id/page", role: "edit", bind: { param: "id" } },
  { method: "GET", url: "/api/tasks/:id/runs", role: "view", bind: { param: "id" } },
  { method: "GET", url: "/api/tasks/:id/transitions", role: "view", bind: { param: "id" } },
  { method: "GET", url: "/api/pages/:kind/:id/comments", role: "view", bind: { param: "id", kind: "task" } },
  { method: "POST", url: "/api/pages/:kind/:id/comments", role: "edit", bind: { param: "id", kind: "task" } },
  { method: "PATCH", url: "/api/comments/:id", role: "edit" },
  { method: "DELETE", url: "/api/comments/:id", role: "edit" },
];

const SHARE_RULES: Record<ShareKind, ShareRule[]> = {
  page: PAGE,
  task: TASK,
  board: [
    { method: "GET", url: "/api/tasks", role: "view" },
    { method: "GET", url: "/api/tasks/:id", role: "view" },
    { method: "GET", url: "/api/tasks/:id/page", role: "view" },
    { method: "POST", url: "/api/tasks", role: "edit" },
    { method: "PATCH", url: "/api/tasks/:id", role: "edit" },
    { method: "POST", url: "/api/tasks/:id/move", role: "edit" },
    { method: "PUT", url: "/api/tasks/:id/page", role: "edit" },
  ],
  diagram: [
    { method: "GET", url: "/api/diagrams/:id", role: "view", bind: { param: "id" } },
    { method: "GET", url: "/api/diagrams/:id/svg", role: "view", bind: { param: "id" } },
    { method: "GET", url: "/api/diagrams/:id/revisions", role: "view", bind: { param: "id" } },
    { method: "GET", url: "/api/diagrams/:id/freshness", role: "view", bind: { param: "id" } },
    { method: "PATCH", url: "/api/diagrams/:id", role: "edit", bind: { param: "id" } },
    { method: "POST", url: "/api/diagrams/:id/restore", role: "edit", bind: { param: "id" } },
  ],
  plot_space: [
    { method: "GET", url: "/api/plots/workspace", role: "view", bind: { query: "id" } },
    { method: "PUT", url: "/api/plots/workspace", role: "edit", bind: { body: "id" } },
  ],
  plot: [
    { method: "GET", url: "/api/plots/:id", role: "view", bind: { param: "id" } },
    { method: "PATCH", url: "/api/plots/:id", role: "edit", bind: { param: "id" } },
  ],
  meeting: [
    { method: "GET", url: "/api/meetings/sessions/:id", role: "view", bind: { param: "id" } },
    { method: "GET", url: "/api/meetings/notes/:id", role: "view", bind: { param: "id" } },
  ],
  skill: [
    { method: "GET", url: "/api/skills/:id", role: "view", bind: { param: "id" } },
    { method: "PATCH", url: "/api/skills/:id", role: "edit", bind: { param: "id" } },
  ],
  workspace: [
    { method: "GET", url: "/api/workspace", role: "view" },
    { method: "GET", url: "/api/agent/jobs", role: "view" },
    { method: "GET", url: "/api/agent/jobs/:id", role: "view" },
    { method: "GET", url: "/api/agent/jobs/:id/logs", role: "view" },
    { method: "GET", url: "/api/runs", role: "view" },
    { method: "GET", url: "/api/runs/:id", role: "view" },
  ],
  code: [
    { method: "GET", url: "/api/code/repos", role: "view" },
    { method: "GET", url: "/api/code/source", role: "view" },
    { method: "GET", url: "/api/code/file", role: "view" },
    { method: "GET", url: "/api/code/diff", role: "view" },
    { method: "GET", url: "/api/code/reviews", role: "view" },
    { method: "GET", url: "/api/code/scm", role: "view" },
  ],
};

/** Kinds that can never be edited by the person they are shared with. */
export const VIEW_ONLY_KINDS: ReadonlySet<ShareKind> = new Set(["meeting", "workspace", "code"]);

export type ShareDecision = { allow: true; personal: boolean } | { allow: false; status: 403 | 404; message: string };

export function shareDecision(
  access: { resource: ShareKind; resourceId: string; role: "view" | "edit" },
  method: string,
  url: string,
  input: { params: Record<string, string | undefined>; query: Record<string, unknown>; body: unknown },
): ShareDecision {
  const verb = method === "HEAD" ? "GET" : method;
  const cls = classify(verb, url);
  if (cls === "live" || cls === "open" || cls === "self") return { allow: true, personal: false };
  // Your own notifications and settings still work from a shared item's page.
  if (cls === "personal") return { allow: true, personal: true };
  const rule = SHARE_RULES[access.resource].find((row) => row.method === verb && row.url === url);
  if (!rule) return { allow: false, status: 403, message: "This link only opens the item that was shared with you." };
  if (rule.role === "edit" && access.role !== "edit") return { allow: false, status: 403, message: "You can view this. Ask its owner for edit access." };
  const bind = rule.bind;
  if (bind) {
    if (bind.kind && input.params.kind !== bind.kind) return { allow: false, status: 403, message: "This link only opens the item that was shared with you." };
    const value = bind.param
      ? input.params[bind.param]
      : bind.query
        ? input.query[bind.query]
        : bind.body && input.body && typeof input.body === "object"
          ? (input.body as Record<string, unknown>)[bind.body]
          : undefined;
    if (value !== access.resourceId) return { allow: false, status: 403, message: "This link only opens the item that was shared with you." };
  }
  return { allow: true, personal: false };
}

export const SHARE_RULE_TABLE = SHARE_RULES;

/**
 * Public links: anyone with the link, no account. Narrower than a share: the item's content
 * only. No comments (they name people), no task properties, no history restore, no assistant.
 */
const LINK_RULES: Record<PublicKind, ShareRule[]> = {
  page: [
    { method: "GET", url: "/api/pages/:id", role: "view", bind: { param: "id" } },
    { method: "PUT", url: "/api/pages/:id", role: "edit", bind: { param: "id" } },
    { method: "PATCH", url: "/api/pages/:id", role: "edit", bind: { param: "id" } },
  ],
  task: [
    { method: "GET", url: "/api/tasks/:id", role: "view", bind: { param: "id" } },
    { method: "GET", url: "/api/tasks/:id/page", role: "view", bind: { param: "id" } },
    { method: "PUT", url: "/api/tasks/:id/page", role: "edit", bind: { param: "id" } },
  ],
  diagram: [
    { method: "GET", url: "/api/diagrams/:id", role: "view", bind: { param: "id" } },
    { method: "GET", url: "/api/diagrams/:id/svg", role: "view", bind: { param: "id" } },
    { method: "GET", url: "/api/diagrams/:id/freshness", role: "view", bind: { param: "id" } },
    { method: "PATCH", url: "/api/diagrams/:id", role: "edit", bind: { param: "id" } },
  ],
  meeting: [
    { method: "GET", url: "/api/meetings/sessions/:id", role: "view", bind: { param: "id" } },
    { method: "GET", url: "/api/meetings/notes/:id", role: "view", bind: { param: "id" } },
  ],
};

/** Routes every link may call: what it opens, the live stream, and presence. */
const LINK_ALWAYS = new Set(["GET /api/links/open", "POST /api/events/ticket", "GET /api/events", "GET /api/presence", "POST /api/presence"]);

export function linkDecision(
  access: { resource: PublicKind; resourceId: string; role: "view" | "edit" },
  method: string,
  url: string,
  input: { params: Record<string, string | undefined>; query: Record<string, unknown>; body: unknown },
): ShareDecision {
  const verb = method === "HEAD" ? "GET" : method;
  if (LINK_ALWAYS.has(`${verb} ${url}`) || classify(verb, url) === "open") return { allow: true, personal: false };
  const rule = LINK_RULES[access.resource].find((row) => row.method === verb && row.url === url);
  if (!rule) return { allow: false, status: 403, message: "This link only opens the item it was made for." };
  if (rule.role === "edit" && access.role !== "edit") return { allow: false, status: 403, message: "This link is view only." };
  const value = rule.bind?.param ? input.params[rule.bind.param] : undefined;
  if (rule.bind && value !== access.resourceId) return { allow: false, status: 403, message: "This link only opens the item it was made for." };
  return { allow: true, personal: false };
}

export const LINK_RULE_TABLE = LINK_RULES;
