/**
 * The registry: every tool the assistant may be shown, in one place.
 *
 * Assembled from the area modules rather than declared inline so a new tool is
 * added next to the data it touches. The catalog is what the model sees, so it
 * is also the security boundary — a tool absent from here cannot be called
 * however convincingly the model asks for it, because dispatch is a lookup in
 * this map and not an eval of a name.
 */
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AssistantToolArea, AssistantToolInfo } from "@ensemble/shared-types";
import { hasModule, parseModules, type OptionalModule } from "@ensemble/shared-types";
import type { AnyHubTool } from "./types.js";
import { taskTools } from "./tools/tasks.js";
import { boardTools } from "./tools/boards.js";
import { projectTools } from "./tools/projects.js";
import { contextTools } from "./tools/context.js";
import { fileTools } from "./tools/files.js";
import { saveFileTools } from "./tools/save-file.js";
import { skillTools } from "./tools/skills.js";
import { reminderTools } from "./tools/reminders.js";
import { fetchTools } from "./tools/fetch.js";
import { graphTools } from "./tools/graph.js";
import { watcherTools } from "./tools/watchers.js";
import { diagramTools } from "./tools/diagrams.js";
import { diagramContextTools } from "./tools/diagram-context.js";
import { repoReadTools } from "./tools/repos.js";
import { plotTools } from "./tools/plots.js";
import { googleWorkspaceTools } from "./tools/google-workspace.js";
import { microsoft365Tools } from "./tools/microsoft-365.js";
import { zoomTools } from "./tools/zoom.js";
import { docusignTools } from "./tools/docusign.js";
import { jiraTools } from "./tools/jira.js";
import { pageTools } from "./tools/pages.js";
import { meetingTools } from "./tools/meetings.js";
import { calendarTools } from "./tools/calendar.js";
import { deskTools } from "./tools/desk.js";
import { importTools } from "./tools/imports.js";
import { activityTools } from "./tools/activity.js";
import { settingsTools } from "./tools/settings.js";
import { workspaceTools } from "./tools/workspace.js";
import { howToTools } from "./tools/howto.js";
import { layoutTools } from "./tools/layouts.js";
import { pageEditTools } from "./tools/page-edits.js";
import { relationshipTools } from "./tools/relationships.js";
import { boardImportTools } from "./tools/board-imports.js";
import { workflowTools } from "./tools/workflows.js";
import { calendarManagementTools } from "./tools/calendar-management.js";
import { fileEditTools } from "./tools/file-edits.js";
import { recordTools } from "./tools/records.js";
import { surfaceTools } from "./tools/surfaces.js";
import { recordActionTools } from "./tools/record-actions.js";
import { agentAssignTools } from "./tools/agent-assign.js";
import { connectionTools } from "./tools/connections.js";
import { setToolCatalog } from "./skills/index.js";

const ALL: readonly AnyHubTool[] = [
  ...howToTools,
  ...layoutTools,
  ...pageEditTools,
  ...relationshipTools,
  ...boardImportTools,
  ...workflowTools,
  ...fileEditTools,
  ...recordTools,
  ...surfaceTools,
  ...recordActionTools,
  ...taskTools,
  ...boardTools,
  ...projectTools,
  ...contextTools,
  ...fileTools,
  ...saveFileTools,
  ...skillTools,
  ...reminderTools,
  ...fetchTools,
  ...graphTools,
  ...watcherTools,
  ...diagramTools,
  ...diagramContextTools,
  ...repoReadTools,
  ...plotTools,
  ...pageTools,
  ...meetingTools,
  ...calendarTools,
  ...deskTools,
  ...importTools,
  ...activityTools,
  ...settingsTools,
  ...connectionTools,
  ...workspaceTools,
  ...agentAssignTools,
];

export const TOOLS: ReadonlyMap<string, AnyHubTool> = new Map(ALL.map((tool) => [tool.name, tool]));

/**
 * Tools that act in connected apps (area "apps"). Not in TOOLS or toolsFor():
 * apps.ts offers them per person, by connection and product, and Apply finds
 * them through apps.resolveTool.
 */
export const APP_TOOL_LIST: readonly AnyHubTool[] = [...googleWorkspaceTools, ...microsoft365Tools, ...zoomTools, ...docusignTools, ...jiraTools, ...calendarManagementTools];

/** Names, for tests that assert the catalog has not silently shrunk. */
export const TOOL_NAMES: readonly string[] = ALL.map((tool) => tool.name);

export function getTool(name: string): AnyHubTool | undefined {
  return TOOLS.get(name);
}

// A playbook that requires a tool is offered only when this build has it (skills/index.ts).
setToolCatalog((name) => TOOLS.has(name) || APP_TOOL_LIST.some((tool) => tool.name === name));

export const toolInfo = (tool: AnyHubTool): AssistantToolInfo => ({
  name: tool.name,
  area: tool.area,
  description: tool.description,
  isWrite: tool.isWrite,
  risk: tool.risk,
  undoable: tool.undoable ?? false,
});

export const catalog = (): AssistantToolInfo[] => [...ALL, ...APP_TOOL_LIST].map(toolInfo);

/**
 * The tools this engineer's settings allow, for this turn.
 *
 * Reads are always offered. Writes are filtered by area, so switching off
 * skills genuinely removes the skill writers from the model's vocabulary.
 */
/** Drawing and reading diagrams follow the diagrams module. */
const DIAGRAM_TOOLS = new Set<string>([...diagramTools, ...diagramContextTools].map((tool) => tool.name));
const PLOT_TOOLS = new Set<string>(plotTools.map((tool) => tool.name));
/** Reading a repo's files is code-space work. Without Code a diagram still draws, it just cannot read a repo. */
const CODE_TOOLS = new Set<string>([...repoReadTools, ...workspaceTools].map((tool) => tool.name));
/** Assigning to an agent is the Workspace feature, as /api/agent/assign is. */
const AGENT_TOOLS = new Set<string>(agentAssignTools.map((tool) => tool.name));

/** The optional module a tool belongs to, or null for a core tool. */
export function toolModule(tool: AnyHubTool): OptionalModule | null {
  if (AGENT_TOOLS.has(tool.name)) return "workspace";
  if (tool.area === "skills" || tool.area === "runs") return tool.area;
  if (DIAGRAM_TOOLS.has(tool.name)) return "diagrams";
  if (PLOT_TOOLS.has(tool.name)) return "plots";
  if (CODE_TOOLS.has(tool.name)) return "code";
  return null;
}

/** False when the tool belongs to a module this person does not have. Undefined modules means an older caller. */
export function toolAllowedFor(tool: AnyHubTool, modules?: string | null): boolean {
  if (modules === undefined) return true;
  const needed = toolModule(tool);
  return needed === null || hasModule(modules, needed);
}

export function toolsFor(allowedWriteAreas: readonly AssistantToolArea[], modules?: string | null): AnyHubTool[] {
  const allowed = new Set(allowedWriteAreas);
  const on = modules === undefined ? null : parseModules(modules);
  return ALL.filter((tool) => {
    if (on && !toolAllowedFor(tool, modules)) return false;
    return !tool.isWrite || allowed.has(tool.area);
  });
}

function parameters(tool: AnyHubTool): Record<string, unknown> {
  if (tool.jsonSchema && typeof tool.jsonSchema === "object") return structuredClone(tool.jsonSchema);
  const schema = zodToJsonSchema(tool.input, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  delete schema.$schema;
  if (!schema.type) schema.type = "object";
  if (!schema.properties) schema.properties = {};
  return schema;
}

/** OpenAI /chat/completions tool format — nested under "function". */
export const chatToolSpecs = (tools: readonly AnyHubTool[]): Array<Record<string, unknown>> =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: parameters(tool),
    },
  }));

/**
 * OpenAI /responses tool format — flat.
 *
 * Two shapes rather than one adapter because the difference is not cosmetic:
 * /responses puts name at the top level and /chat/completions nests it.
 */
export const responsesToolSpecs = (tools: readonly AnyHubTool[]): Array<Record<string, unknown>> =>
  tools.map((tool) => ({
    type: "function",
    name: tool.name,
    strict: false,
    description: tool.description,
    parameters: parameters(tool),
  }));
