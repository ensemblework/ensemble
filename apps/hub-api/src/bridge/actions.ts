/**
 * Actions an editor or agent runs in Ensemble through the Context Bridge (MCP): the assistant's own
 * Hub tools on an allowlist, and the connected apps' tools, run at once with the same validation,
 * access checks, Undo entries and live refresh as the assistant (docs/CONTEXT_BRIDGE.md §5).
 *
 * The allowlist is the line between the ways in. A key reads everything the assistant reads and,
 * with changes allowed, changes Ensemble's records: tasks, pages, boards, diagrams, plots, files
 * (new ones only), projects, people, deliverables, meeting notes, comments, skills, routines,
 * reminders, desk lists and imports. What changes how Ensemble behaves or starts work stays with the
 * person in Ensemble: settings, model choice and layouts, stopping or deleting runs, starting the
 * assistant, agents, workflows or watchers, deleting routines or files, and editing a file's original.
 * An agent run Ensemble started (workspace/context-tools.ts) keeps the everyday list: entries marked
 * `keyOnly` are for keys only. A tool absent here cannot be reached, however it is named.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings } from "../lib/settings.js";
import { sseHub } from "../lib/sse.js";
import { env } from "../config.js";
import { describeToolError } from "../assistant/agent.js";
import { fitList } from "../assistant/agent.js";
import { appToolsFor, ensureAppAccess, resolveTool, writeRefusal } from "../assistant/apps.js";
import { runOutsideWrite } from "../assistant/apply.js";
import { loadConnections } from "../assistant/connections.js";
import { getTool, toolAllowedFor, toolJsonSchema } from "../assistant/registry.js";
import type { AnyHubTool, ToolContext } from "../assistant/types.js";
import { bridgeAppsRejected, bridgeWriteRejected } from "./auth.js";
import { hubUrl } from "./text.js";

export const ACTION_GROUPS = [
  "guides",
  "tasks",
  "pages",
  "boards",
  "diagrams",
  "plots",
  "files",
  "projects",
  "people",
  "meetings",
  "comments",
  "context",
  "skills",
  "routines",
  "reminders",
  "desk",
  "calendar",
  "runs",
  "agents",
  "code",
  "settings",
  "layouts",
  "imports",
  "relationships",
] as const;
export type ActionGroup = (typeof ACTION_GROUPS)[number];

interface Allowed {
  group: ActionGroup;
  /** Why this input is refused through the bridge, or null. */
  guard?: (input: Record<string, unknown>, caller: Caller) => string | null;
  /** What the guard refuses, said up front in the listing. */
  limit?: string;
  /** Reaches a connected app as well (an app item saved as a page): the key also needs apps allowed. */
  apps?: boolean;
  /** For a key only: an agent run's own MCP server (workspace/context-tools.ts) keeps the everyday list. */
  keyOnly?: boolean;
}

const FILES_STAY = "Files cannot be deleted from editors and agents; delete it in Ensemble.";
const ROUTINES_STAY = "Routines are deleted by the person, in Ensemble.";

/** Ensemble's own tools a key may run. Writes also need a key made with changes allowed. */
export const BRIDGE_ACTIONS: Readonly<Record<string, Allowed>> = {
  hub_how_to: { group: "guides" },

  hub_list_tasks: { group: "tasks" },
  hub_get_task: { group: "tasks" },
  hub_read_task_page: { group: "tasks" },
  hub_list_due: { group: "tasks" },
  hub_create_tasks: { group: "tasks" },
  hub_update_task: { group: "tasks" },
  hub_delete_task: { group: "tasks" },
  hub_delete_tasks: { group: "tasks", keyOnly: true },

  hub_list_pages: { group: "pages" },
  hub_read_page: { group: "pages" },
  hub_read_page_blocks: { group: "pages" },
  hub_create_page: { group: "pages" },
  hub_update_page: { group: "pages" },
  hub_edit_page: { group: "pages" },
  hub_move_page: { group: "pages" },
  hub_delete_page: { group: "pages" },
  hub_delete_pages: { group: "pages", keyOnly: true },

  hub_list_boards: { group: "boards" },
  hub_read_board: { group: "boards" },
  hub_create_board: { group: "boards" },
  hub_update_board: { group: "boards" },
  hub_move_to_board: { group: "boards" },
  hub_remove_from_board: { group: "boards" },
  hub_delete_board: { group: "boards", keyOnly: true },

  hub_list_diagrams: { group: "diagrams" },
  hub_get_diagram: { group: "diagrams" },
  hub_validate_diagram: { group: "diagrams" },
  hub_explain_diagram: { group: "diagrams" },
  hub_diagram_context: { group: "diagrams" },
  hub_create_diagram: { group: "diagrams" },
  hub_update_diagram: { group: "diagrams" },
  hub_edit_diagram: { group: "diagrams" },

  hub_list_plots: { group: "plots" },
  hub_get_plot: { group: "plots" },
  hub_list_datasets: { group: "plots" },
  hub_get_dataset: { group: "plots" },
  hub_create_plot: { group: "plots" },
  hub_update_plot: { group: "plots" },
  hub_import_dataset: { group: "plots" },

  // hub_view_file hands a file to the assistant's model; editors get the file itself with ensemble_get_file.
  hub_list_files: { group: "files" },
  hub_file_edit_info: { group: "files", keyOnly: true },
  hub_file_to_page: { group: "files" },
  hub_export_page_file: {
    group: "files",
    guard: (input) => (input.replaceFileId ? "Replacing a file is not offered here: export to a new file, or upload the new version with ensemble_upload_file." : null),
    limit: "Exports to a new file only; replaceFileId is refused.",
  },
  hub_save_file: { group: "files", keyOnly: true },
  hub_save_app_item_as_page: { group: "files", apps: true },
  hub_import_app_file: { group: "files", apps: true },

  hub_list_projects: { group: "projects" },
  hub_list_deliverables: { group: "projects" },
  hub_create_project: { group: "projects" },
  hub_update_project: { group: "projects" },
  hub_create_deliverable: { group: "projects" },
  hub_update_deliverable: { group: "projects" },
  hub_complete_deliverable: { group: "projects" },
  hub_delete_deliverable: { group: "projects", keyOnly: true },

  hub_list_people: { group: "people" },
  hub_list_repos: { group: "people" },
  hub_create_person: { group: "people" },
  hub_update_person: { group: "people" },
  hub_link_repo: { group: "people" },
  hub_unlink_repo: { group: "people" },
  hub_update_repo: { group: "people" },
  hub_delete_person: { group: "people", keyOnly: true },

  hub_list_meeting_notes: { group: "meetings" },
  hub_read_meeting_note: { group: "meetings" },
  hub_create_meeting_note: { group: "meetings" },
  hub_update_meeting_note: { group: "meetings" },
  hub_suggest_meeting_tasks: { group: "meetings" },
  hub_delete_meeting_note: { group: "meetings", keyOnly: true },
  hub_import_meeting_notes: { group: "meetings", apps: true, keyOnly: true },

  hub_read_record_details: { group: "comments" },
  hub_manage_record: {
    group: "comments",
    // An agent run keeps the everyday limits; a key may also delete datasets and restore any record.
    guard: (input, caller) =>
      !caller.run
        ? null
        : input.action === "delete_dataset"
          ? "Deleting a dataset can remove plots that use it; ask the person to do it in Ensemble."
          : input.action === "restore" && (input.kind === "skill" || input.kind === "reminder")
            ? "Skills and reminders are restored by the person, in Ensemble."
            : null,
  },

  hub_item_context: { group: "context", keyOnly: true },
  hub_search_work: { group: "context", keyOnly: true },
  hub_search_context: { group: "context", keyOnly: true },
  hub_read_context: { group: "context", keyOnly: true },
  hub_read_surface: { group: "context", keyOnly: true },
  hub_list_approvals: { group: "context", keyOnly: true },
  hub_delete_entity: {
    group: "context",
    keyOnly: true,
    guard: (input) => (input.kind === "document" ? FILES_STAY : null),
    limit: "Projects, repositories and skills only; files stay until the person deletes them in Ensemble.",
  },
  hub_restore_entity: { group: "context", keyOnly: true },

  hub_list_skills: { group: "skills", keyOnly: true },
  hub_read_skill: { group: "skills", keyOnly: true },
  hub_manage_skill: { group: "skills", keyOnly: true },

  hub_list_routines: { group: "routines", keyOnly: true },
  hub_create_routine: { group: "routines", keyOnly: true },
  hub_update_routine: {
    group: "routines",
    keyOnly: true,
    guard: (input) => (input.action === "delete" ? ROUTINES_STAY : null),
    limit: "Edit, pause or resume; action delete is refused.",
  },

  hub_list_reminders: { group: "reminders", keyOnly: true },
  hub_create_reminder: { group: "reminders", keyOnly: true },
  hub_update_reminder: { group: "reminders", keyOnly: true },
  hub_dismiss_reminder: { group: "reminders", keyOnly: true },
  hub_delete_reminder: { group: "reminders", keyOnly: true },
  hub_list_watchers: { group: "reminders", keyOnly: true },

  hub_list_desk_items: { group: "desk", keyOnly: true },
  hub_add_desk_item: { group: "desk", keyOnly: true },
  hub_update_desk_item: { group: "desk", keyOnly: true },
  hub_remove_desk_item: { group: "desk", keyOnly: true },

  hub_list_events: { group: "calendar", keyOnly: true },
  hub_weekly_recap: { group: "calendar", keyOnly: true },

  hub_list_activity: { group: "runs", keyOnly: true },
  hub_list_runs: { group: "runs", keyOnly: true },
  hub_get_run: { group: "runs", keyOnly: true },

  hub_list_agent_sessions: { group: "agents", keyOnly: true },
  hub_list_agent_options: { group: "agents", keyOnly: true },

  hub_repo_overview: { group: "code", keyOnly: true },
  hub_repo_read_file: { group: "code", keyOnly: true },
  hub_list_code_folders: { group: "code", keyOnly: true },
  hub_list_agent_changes: { group: "code", keyOnly: true },

  hub_find_setting: { group: "settings", keyOnly: true },
  hub_get_settings: { group: "settings", keyOnly: true },
  hub_list_model_choices: { group: "settings", keyOnly: true },

  hub_read_layout: { group: "layouts", keyOnly: true },

  hub_read_import: { group: "imports", keyOnly: true },
  hub_preview_board_import: { group: "imports", apps: true, keyOnly: true },
  hub_start_board_import: { group: "imports", apps: true, keyOnly: true },
  hub_manage_import: { group: "imports", keyOnly: true },

  hub_list_connections: { group: "relationships", keyOnly: true },
  hub_list_app_relationships: { group: "relationships", keyOnly: true },
  hub_manage_app_relationship: { group: "relationships", apps: true, keyOnly: true },
  hub_fetch_now: { group: "relationships", apps: true, keyOnly: true },
};

/** What stays with the person in Ensemble, for a key that asks for a tool off the list. */
export const KEPT_IN_ENSEMBLE =
  "Changing settings, model choice or layouts, stopping or deleting runs, starting the assistant, agents, workflows or watchers, deleting routines or files, and editing a file's original stay with the person in Ensemble.";

/** Why a Hub tool off the list cannot be run, in one sentence. */
function notOffered(name: string, caller: Caller): string {
  if (caller.run) return `Agent runs cannot use ${name}: say what should change in your report and the person does it in Ensemble.`;
  if (name === "hub_view_file") return "hub_view_file is not offered here: open a file with ensemble_get_file.";
  if (name === "hub_web_search" || name === "hub_read_web_page") return `${name} is the Ensemble assistant's web search: use your own web tools.`;
  return `${name} stays with the person in Ensemble: editors and agents do not change settings, model choice or layouts, stop or delete runs, start the assistant, agents, workflows or watchers, delete routines or files, or edit a file's original.`;
}

/** The assistant's wording about Apply does not hold here: a bridge action runs at once. */
const APPLY_SENTENCE = /[^.]*\bApply\b[^.]*\.\s*/g;
export const actionDescription = (tool: AnyHubTool): string => tool.description.replace(APPLY_SENTENCE, "").trim();

/** Results an agent reads in one go; a longer one keeps its list's first rows, else its start and end. */
const RESULT_CHARS = 40_000;

function fitData(data: unknown): unknown {
  if (data === undefined || data === null) return null;
  const json = JSON.stringify(data);
  if (json === undefined || json.length <= RESULT_CHARS) return data;
  const fitted = fitList(data, RESULT_CHARS);
  if (fitted) return fitted;
  return { truncated: true, note: "The result was too long; this is its start and end. Narrow the request.", preview: `${json.slice(0, RESULT_CHARS / 2)} … ${json.slice(-RESULT_CHARS / 4)}` };
}

export class BridgeActionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Who runs an action: a request through the bridge (a key, a signed-in page), or an agent run
 * Ensemble started (`run`, workspace/context-tools.ts), which keeps the everyday list.
 */
type Caller = Pick<FastifyRequest, "userId" | "modules" | "authVia" | "tokenScope" | "tokenCanWrite" | "tokenCanUseApps" | "tokenId"> & { run?: boolean };

/** The allowlist entry this caller may use: entries for keys only are not an agent run's. */
function allowedFor(caller: Caller, name: string): Allowed | null {
  const allowed = BRIDGE_ACTIONS[name] ?? null;
  return allowed && !(allowed.keyOnly && caller.run) ? allowed : null;
}

/** A tool context for the bridge's caller: their own space, and route-backed tools call the API as them. */
export async function bridgeContext(app: FastifyInstance, caller: Pick<Caller, "userId" | "modules">): Promise<ToolContext> {
  return {
    app,
    prisma: app.prisma,
    userId: caller.userId,
    actor: "agent",
    settings: await loadSettings(app.prisma, caller.userId),
    modules: caller.modules,
    requestHeaders: { "x-ensemble-internal": env.ENSEMBLE_INTERNAL_TOKEN, "x-ensemble-user": caller.userId },
    // An editor or run lists the person's whole app catalog and reads a schema when it wants one.
    appCatalog: true,
  };
}

export interface ActionInfo {
  name: string;
  group: ActionGroup | "apps";
  description: string;
  write: boolean;
  /** Whether this key may run it now; when not, why. */
  allowed: boolean;
  refusal?: string;
  /** Inputs the bridge refuses even when it is allowed (a guard), said up front. */
  limit?: string;
  inputSchema?: Record<string, unknown>;
}

function refusalFor(caller: Caller, tool: AnyHubTool, allowed: Allowed | null): string | null {
  if (allowed?.apps || tool.area === "apps") {
    const apps = bridgeAppsRejected(caller);
    if (apps) return apps;
  }
  return tool.isWrite ? bridgeWriteRejected(caller) : null;
}

function info(caller: Caller, tool: AnyHubTool, group: ActionGroup | "apps", allowed: Allowed | null, schema: boolean): ActionInfo {
  const refusal = refusalFor(caller, tool, allowed);
  const limit = caller.run ? undefined : allowed?.limit;
  return {
    name: tool.name,
    group,
    description: actionDescription(tool),
    write: tool.isWrite,
    allowed: !refusal,
    ...(refusal ? { refusal } : {}),
    ...(limit ? { limit } : {}),
    ...(schema ? { inputSchema: toolJsonSchema(tool) } : {}),
  };
}

/** Ensemble's actions this caller has, by group; with schemas when asked (or when names are given). */
export function listActions(caller: Caller, options: { groups?: readonly string[]; names?: readonly string[]; schema?: boolean } = {}): ActionInfo[] {
  const names = new Set(options.names ?? []);
  const groups = new Set(options.groups ?? []);
  const rows: ActionInfo[] = [];
  for (const name of Object.keys(BRIDGE_ACTIONS)) {
    const allowed = allowedFor(caller, name);
    if (!allowed) continue;
    if (names.size && !names.has(name)) continue;
    if (groups.size && !groups.has(allowed.group)) continue;
    const tool = getTool(name);
    if (!tool || !toolAllowedFor(tool, caller.modules)) continue;
    rows.push(info(caller, tool, allowed.group, allowed, Boolean(options.schema) || names.size > 0));
  }
  return rows;
}

/**
 * The connected apps and their tools for this caller (apps allowed). The list names each tool with its
 * first sentence, for all apps or one (`app`); named tools come with their full description and
 * inputSchema, so an agent reads a schema only for the tool it will call (one app's whole list with
 * schemas runs past 100 KB).
 */
export async function listApps(app: FastifyInstance, caller: Caller, options: { app?: string; names?: readonly string[]; schema?: boolean } = {}) {
  const refused = bridgeAppsRejected(caller);
  if (refused) throw new BridgeActionError(refused, 403);
  const ctx = await bridgeContext(app, caller);
  const tools = await appToolsFor(ctx);
  const connections = await loadConnections(ctx, tools);
  const wanted = options.app?.trim().toLowerCase();
  const apps = connections.connected.filter((row) => !wanted || row.id.toLowerCase() === wanted || row.names.includes(wanted));
  const prefixes = (row: (typeof apps)[number]) => row.tools.map((name) => (name.endsWith("*") ? { prefix: name.slice(0, -1) } : { name }));
  const belongs = (tool: AnyHubTool, row: (typeof apps)[number]) => prefixes(row).some((entry) => ("name" in entry ? entry.name === tool.name : tool.name.startsWith(entry.prefix)));
  const names = new Set(options.names ?? []);
  const shown = tools.filter((tool) => (names.size ? names.has(tool.name) : !wanted || apps.some((row) => belongs(tool, row))));
  return {
    apps: apps.map((row) => ({ id: row.id, name: row.name, via: row.via, account: row.account, uses: row.uses, publicOnly: row.publicOnly })),
    broken: connections.broken,
    tools: shown.map((tool) => {
      const row = info(caller, tool, "apps", null, names.size > 0);
      return { ...row, ...(names.size ? {} : { description: firstSentence(row.description) }), app: apps.find((entry) => belongs(tool, entry))?.name ?? tool.app?.label ?? null };
    }),
  };
}

const firstSentence = (text: string): string => {
  const end = /[.!?](\s|$)/.exec(text);
  return (end ? text.slice(0, end.index + 1) : text).slice(0, 300);
};

async function keyName(app: FastifyInstance, caller: Caller): Promise<string> {
  if (!caller.tokenId) return caller.authVia === "session" ? "the Hub" : "an agent";
  const key = await app.prisma.apiToken.findUnique({ where: { id: caller.tokenId }, select: { name: true } });
  return key?.name || "an agent";
}

export interface ActionResult {
  ok: true;
  action: string;
  summary: string;
  data: unknown;
  url?: string;
  /** A change to Ensemble: whether Ensemble's Undo has it (custom boards and a few others do not). */
  undoable?: boolean;
}

/**
 * Runs one action for the caller: an allowlisted Hub tool, or (apps allowed) a connected app's tool.
 * Throws BridgeActionError with the status and the person-facing reason.
 */
export async function runAction(app: FastifyInstance, caller: Caller, name: string, rawInput: unknown): Promise<ActionResult> {
  const allowed = allowedFor(caller, name);
  let tool: AnyHubTool | undefined;
  const ctx = await bridgeContext(app, caller);
  if (allowed) tool = getTool(name);
  else if (!name.startsWith("hub_")) {
    // A connected app's tool: built-in (gmail_search…), app items (apps_search…) or an app's own MCP server (mcp_…).
    const appsRefused = bridgeAppsRejected(caller);
    if (appsRefused) throw new BridgeActionError(appsRefused, 403);
    const found = await resolveTool(ctx, name);
    tool = found?.area === "apps" ? found : undefined;
  }
  if (!tool) {
    throw new BridgeActionError(
      name.startsWith("hub_") && getTool(name)
        ? notOffered(name, caller)
        : `There is no action named ${name}. List them with ensemble_actions (Ensemble) or ensemble_apps (connected apps).`,
      404,
    );
  }
  if (!toolAllowedFor(tool, caller.modules)) throw new BridgeActionError(`${name} belongs to a feature that is off in this space.`, 403);
  const refused = refusalFor(caller, tool, allowed);
  if (refused) throw new BridgeActionError(refused, 403);
  // The person's own switch for changes in connected apps (Settings › Assistant) holds here too.
  const switchedOff = tool.area === "apps" ? writeRefusal(tool, ctx.settings) : null;
  if (switchedOff) throw new BridgeActionError(switchedOff, 403);

  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
    throw new BridgeActionError(`The input for ${name} is not right: ${issues.join("; ")}.`, 400, { inputSchema: toolJsonSchema(tool) });
  }
  let input: unknown = parsed.data;
  const guarded = allowed?.guard?.(input as Record<string, unknown>, caller);
  if (guarded) throw new BridgeActionError(guarded, 403);

  try {
    if (tool.prepare) input = await tool.prepare(ctx, input);
    let result;
    if (tool.area === "apps") {
      await ensureAppAccess(ctx, tool);
      result = tool.isWrite ? await runOutsideWrite(ctx, tool, input) : await tool.run(ctx, input as never);
    } else {
      result = await tool.run(ctx, input as never);
    }
    if (tool.isWrite && tool.area !== "apps") {
      await appendLedger({
        userId: caller.userId,
        actor: "agent",
        action: `bridge.${tool.name}`,
        payload: { summary: result.summary.slice(0, 500), href: result.href ?? null, key: await keyName(app, caller) },
      }).catch((error: unknown) => app.log.error({ err: error, tool: tool!.name }, "Could not ledger a bridge action"));
    }
    if (result.invalidate?.length) {
      sseHub.publish(caller.userId, { event: "assistant.acted", data: { at: new Date().toISOString(), tool: tool.name, summary: result.summary, keys: [...result.invalidate] } });
    }
    const href = result.href;
    return {
      ok: true,
      action: tool.name,
      summary: result.summary,
      data: fitData(result.data),
      ...(href ? { url: /^https?:/.test(href) ? href : hubUrl(href) } : {}),
      ...(tool.isWrite && tool.area !== "apps" ? { undoable: Boolean(tool.undoable || result.undoEntryId) } : {}),
    };
  } catch (error) {
    const status = (error as { statusCode?: unknown }).statusCode;
    const code = typeof status === "number" && status >= 400 && status < 600 ? status : 400;
    if (code >= 500 && !(error as { expose?: boolean }).expose) throw error;
    throw new BridgeActionError(describeToolError(error), code);
  }
}
