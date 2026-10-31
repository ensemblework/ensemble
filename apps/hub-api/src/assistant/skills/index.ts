/**
 * The assistant's built-in playbooks: one short how-to per area of Ensemble, written so a
 * small, cheap model can do the work without exploring. People call them the assistant's
 * skills; they are not the person's own Skills (hub_list_skills), which stay as they were.
 *
 * The assistant's instructions name the playbooks; hub_how_to's description says what each covers
 * and loads one (or the map of Ensemble, map.md). A message whose words or mentions point at a
 * playbook gets it as a guide in its context (routePlaybooks); the open page only breaks ties. Each playbook names the tools it uses, so
 * a turn advertises the core tools plus those of the playbooks in play, not all hundred-odd.
 * What a turn may *run* is unchanged: every tool the person's settings allow.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasModule, type OptionalModule } from "@ensemble/shared-types";
import { diagramSkillText } from "../diagram-skill.js";
import type { AnyHubTool } from "../types.js";

export interface Playbook {
  /** The name hub_how_to takes: lowercase, dashes. */
  name: string;
  title: string;
  /** One line for the index: what requests it covers. */
  when: string;
  /** Tools the playbook's steps call. Advertised while it is in play. */
  tools: string[];
  /** Tools this build must have for the playbook to be offered at all (`requires`): it stays out without them. */
  requires: string[];
  /** Every connected-app tool (area "apps", including remote MCP tools) while it is in play. */
  appTools: boolean;
  /** Hidden when the person does not have this module. */
  module?: OptionalModule;
  /** Words in a message that preload it (global, case-insensitive). */
  match?: RegExp;
  /** Open pages that preload it. */
  paths: string[];
  /** Mention kinds that preload it. */
  mentions: string[];
  body: string;
}

const DIR = fileURLToPath(new URL(".", import.meta.url));
const INCLUDES: Record<string, () => string> = { "block-diagrams": diagramSkillText };

/** LF line endings, whatever the checkout gave the file. */
export function lf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** `key: value` lines between `---` fences, then the body. */
export function parsePlaybook(raw: string, file = "playbook"): Playbook {
  // A Windows checkout (git's autocrlf) gives these files CRLF line endings.
  const source = lf(raw);
  const fence = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (!fence) throw new Error(`${file} has no frontmatter.`);
  const meta: Record<string, string> = {};
  for (const line of fence[1]!.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const list = (value?: string) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!meta.name || !meta.title || !meta.when) throw new Error(`${file} needs name, title and when.`);
  let body = source.slice(fence[0].length).trim();
  for (const name of list(meta.include)) {
    const include = INCLUDES[name];
    if (!include) throw new Error(`${file} includes unknown ${name}.`);
    // The included skill keeps its own frontmatter out of the prompt.
    body += `\n\n${include().replace(/^---\n[\s\S]*?\n---\n?/, "").trim()}`;
  }
  return {
    name: meta.name,
    title: meta.title,
    when: meta.when,
    tools: list(meta.tools),
    requires: list(meta.requires),
    appTools: meta.appTools === "true",
    ...(meta.module ? { module: meta.module as OptionalModule } : {}),
    ...(meta.match ? { match: new RegExp(meta.match, "gi") } : {}),
    paths: list(meta.paths),
    mentions: list(meta.mentions),
    body,
  };
}

let cached: { playbooks: Playbook[]; map: string } | null = null;

function load() {
  if (cached) return cached;
  const files = readdirSync(DIR).filter((file) => file.endsWith(".md")).sort();
  const map = files.includes("map.md") ? lf(readFileSync(`${DIR}/map.md`, "utf8")).trim() : "";
  const playbooks = files.filter((file) => file !== "map.md").map((file) => parsePlaybook(readFileSync(`${DIR}/${file}`, "utf8"), file));
  cached = { playbooks, map };
  return cached;
}

/** Every playbook, in name order. */
export function allPlaybooks(): Playbook[] {
  return load().playbooks;
}

/** The map of Ensemble (hub_how_to "map"). */
export function appMap(): string {
  return load().map;
}

let toolInBuild: ((name: string) => boolean) | null = null;

/** The tool catalog tells which tools this build has (registry.ts), for playbooks that require one. */
export function setToolCatalog(has: (name: string) => boolean): void {
  toolInBuild = has;
}

/** Whether this build has the tools a playbook requires. */
export function playbookAvailable(playbook: Pick<Playbook, "requires">): boolean {
  return !playbook.requires.length || (toolInBuild !== null && playbook.requires.every(toolInBuild));
}

/** The playbooks this person can use: a module playbook needs its module. Undefined modules means an older caller. */
export function playbooksFor(modules?: string | null): Playbook[] {
  return allPlaybooks().filter((playbook) => playbookAvailable(playbook) && (!playbook.module || modules === undefined || hasModule(modules, playbook.module)));
}

export function findPlaybook(name: string, modules?: string | null): Playbook | undefined {
  return playbooksFor(modules).find((playbook) => playbook.name === name.trim().toLowerCase());
}

const MAX_ROUTED = 2;

/** A connected app as routing sees it: the names a message may use, and whether it holds meeting notes. */
export interface ConnectedAppNames {
  names: readonly string[];
  meetings?: boolean;
}

/** App names that are also everyday words count only when written with a capital: "Box", "Close", "Front". */
const EVERYDAY = new Set(["box", "close", "front", "jam", "render", "square", "pitch", "loom", "clay", "ramp", "grain", "fellow", "gamma", "hex", "neon", "guru", "mercury", "paddle", "railway", "resend", "monday"]);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when the text names one of these apps as a whole word. `anyCase` also accepts everyday words in lowercase. */
export function namesApp(text: string, names: readonly string[], anyCase = false): boolean {
  for (const name of names) {
    if (!name) continue;
    const everyday = !anyCase && EVERYDAY.has(name);
    const word = everyday ? `${name[0]!.toUpperCase()}${escape(name.slice(1))}` : escape(name);
    if (new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, everyday ? "u" : "iu").test(text)) return true;
  }
  return false;
}

/** How strongly a message's words point at a playbook: 0, or 2 plus up to 1 for longer and more matches. */
function wordScore(playbook: Playbook, message: string): number {
  if (!playbook.match) return 0;
  const found = new Set([...message.matchAll(playbook.match)].map((match) => match[0].toLowerCase()));
  if (!found.size) return 0;
  const chars = [...found].reduce((sum, word) => sum + word.length, 0);
  return 2 + Math.min(1, chars / 40);
}

/**
 * The playbooks a turn starts with: those the person's mentions or the words of the message point
 * at (a longer, more specific phrase wins: "meeting notes" over "meeting"), strongest first, at most
 * two; the open page only breaks ties, and never loads one on its own (on a custom board, task work also gets
 * the boards playbook). A message that names one of the person's connected apps, or
 * asks about meetings while a meeting-notes app is connected, also gets the apps playbook, on
 * top of those two: without it that app's tools are not shown.
 */
export function routePlaybooks(
  turn: { message: string; path?: string; mentions?: ReadonlyArray<{ kind: string }>; apps?: readonly ConnectedAppNames[]; customBoard?: boolean },
  playbooks: readonly Playbook[],
): Playbook[] {
  const kinds = new Set((turn.mentions ?? []).map((mention) => mention.kind));
  const scored = playbooks
    .map((playbook, order) => {
      let score = 0;
      if (turn.path && playbook.paths.some((path) => turn.path === path || turn.path!.startsWith(`${path}/`) || turn.path!.startsWith(`${path}?`))) score += 1;
      if (playbook.mentions.some((kind) => kinds.has(kind))) score += 2;
      const intent = wordScore(playbook, turn.message);
      score += intent;
      return { playbook, score, order, intent };
    })
    .filter((row) => row.score >= 2)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const routed = scored.slice(0, MAX_ROUTED).map((row) => row.playbook);
  // On a custom board, task work ("move this to Done") is about that board's cards.
  const boards = playbooks.find((playbook) => playbook.name === "boards");
  if (turn.customBoard && boards && !routed.includes(boards) && routed.some((playbook) => playbook.name === "tasks")) routed.push(boards);
  const apps = playbooks.find((playbook) => playbook.name === "apps");
  if (!apps || routed.includes(apps) || !turn.apps?.length) return routed;
  const named = turn.apps.some((app) => namesApp(turn.message, app.names));
  const meetings = routed.some((playbook) => playbook.name === "meeting-notes") && turn.apps.some((app) => app.meetings);
  return named || meetings ? [...routed, apps] : routed;
}

/** Always advertised, whatever the playbooks: the reads most requests start with, and hub_how_to. */
export const CORE_TOOLS: readonly string[] = [
  "hub_how_to",
  "hub_read_surface",
  "hub_list_tasks",
  "hub_get_task",
  "hub_create_tasks",
  "hub_update_task",
  "hub_find_setting",
  "hub_web_search",
  // The instructions list the person's enabled skills by id, to read when one applies.
  "hub_read_skill",
];

export function simpleTodoRequest(message: string): boolean {
  return message.length < 400 && /\b(add|create|make)\b.{0,30}\b(todo|to-do|task)\b/i.test(message) && !/\b(then|workflow|import|attach|new project|new person|calendar|meeting|tile|skill)\b/i.test(message);
}

/** A common request gets one direct recipe rather than the complete area manual. */
export function playbookText(playbook: Playbook, message: string): string {
  if (playbook.name === "tasks" && simpleTodoRequest(message)) return "Create a todo → hub_create_tasks with tasks [{title, page?}]. Use todo when asked, proposed for inferred work. Set due, priority, projectName, labels and people only when stated or clear; list projects/people to resolve names. Detail goes in page, not description. A held write waits for Apply; report it as proposed. Return the created link after Apply.";
  return playbook.body;
}

/**
 * The tools a turn shows the model: the core tools and those of the playbooks in play, in the
 * order the caller offered them. `ENSEMBLE_ASSISTANT_TOOLSETS=off` shows them all.
 */
export function advertisedTools(offered: readonly AnyHubTool[], active: Iterable<Playbook>, message?: string): AnyHubTool[] {
  if (process.env.ENSEMBLE_ASSISTANT_TOOLSETS === "off") return [...offered];
  const names = new Set(CORE_TOOLS);
  let apps = false;
  const playbooks = [...active];
  const lowered = message?.toLowerCase() ?? "";
  // A server counts as named by its tool slug ("huggingface") or its own name ("Hugging Face").
  const mentionedServers = message
    ? new Set(
        offered.flatMap((tool) => {
          const server = /^mcp_([^_]+)_/.exec(tool.name)?.[1];
          const name = (tool as { mcp?: { serverName?: string } }).mcp?.serverName?.toLowerCase();
          return server && (lowered.includes(server) || (name && name.length >= 3 && lowered.includes(name))) ? [server] : [];
        }),
      )
    : new Set<string>();
  for (const playbook of playbooks) {
    for (const name of playbook.tools) names.add(name);
    apps ||= playbook.appTools;
  }
  if (message && simpleTodoRequest(message) && playbooks.every(book => ["tasks", "recap"].includes(book.name))) {
    return offered.filter(tool => ["hub_how_to", "hub_create_tasks", "hub_list_tasks", "hub_list_people", "hub_list_projects"].includes(tool.name));
  }
  return offered.filter((tool) => {
    if (names.has(tool.name)) return true;
    if (!apps || tool.area !== "apps") return false;
    if (!message) return true;
    const lower = message.toLowerCase();
    if (/\b(google|gmail|drive|docs|sheets|slides)\b/.test(lower) && tool.app?.provider === "microsoft") return false;
    if (/\b(outlook|onedrive|microsoft|word|excel|powerpoint)\b/.test(lower) && tool.app?.provider === "google") return false;
    const remote = /^mcp_([^_]+)_/.exec(tool.name)?.[1];
    if (remote && mentionedServers.size && !mentionedServers.has(remote) && !/\b(connected apps|all apps|integration)\b/.test(lower)) return false;
    return true;
  });
}
