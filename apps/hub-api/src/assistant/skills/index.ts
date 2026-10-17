/**
 * The assistant's built-in playbooks: one short how-to per area of Ensemble, written so a
 * small, cheap model can do the work without exploring. People call them the assistant's
 * skills; they are not the person's own Skills (hub_list_skills), which stay as they were.
 *
 * Every turn's system prompt carries the map of Ensemble (map.md) and one line per playbook.
 * A turn preloads the playbooks its words, mentions or open page point at (routePlaybooks),
 * and the model can load any other with hub_how_to. Each playbook names the tools it uses, so
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

/** The map of Ensemble every turn carries. */
export function appMap(): string {
  return load().map;
}

/** The playbooks this person can use: a module playbook needs its module. Undefined modules means an older caller. */
export function playbooksFor(modules?: string | null): Playbook[] {
  return allPlaybooks().filter((playbook) => !playbook.module || modules === undefined || hasModule(modules, playbook.module));
}

export function findPlaybook(name: string, modules?: string | null): Playbook | undefined {
  return playbooksFor(modules).find((playbook) => playbook.name === name.trim().toLowerCase());
}

/** One line per playbook, for the system prompt. */
export function playbookIndex(playbooks: readonly Playbook[], loaded: readonly Playbook[] = []): string {
  const open = new Set(loaded.map((playbook) => playbook.name));
  return [
    "Playbooks: step-by-step know-how for each part of Ensemble. Before multi-step work in an area whose playbook is not loaded below, call hub_how_to with its name; it also gives you that area's tools.",
    ...playbooks.map((playbook) => `- ${playbook.name}: ${playbook.when.length > 115 ? playbook.when.slice(0, 112) + "…" : playbook.when}${open.has(playbook.name) ? " (loaded below)" : ""}`),
  ].join("\n");
}

const MAX_ROUTED = 2;

/** How strongly a message's words point at a playbook: 0, or 2 plus up to 1 for longer and more matches. */
function wordScore(playbook: Playbook, message: string): number {
  if (!playbook.match) return 0;
  const found = new Set([...message.matchAll(playbook.match)].map((match) => match[0].toLowerCase()));
  if (!found.size) return 0;
  const chars = [...found].reduce((sum, word) => sum + word.length, 0);
  return 2 + Math.min(1, chars / 40);
}

/**
 * The playbooks a turn starts with: what the open page is, what the person mentioned, and the
 * words of the message (a longer, more specific phrase wins: "meeting notes" over "meeting"),
 * strongest first, at most two.
 */
export function routePlaybooks(
  turn: { message: string; path?: string; mentions?: ReadonlyArray<{ kind: string }> },
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
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const candidates = scored.some(row => row.intent > 0) ? scored.filter(row => row.intent > 0) : scored;
  return candidates.slice(0, MAX_ROUTED).map((row) => row.playbook);
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
  const mentionedServers = message ? new Set(offered.flatMap(tool => { const server = /^mcp_([^_]+)_/.exec(tool.name)?.[1]; return server && message.toLowerCase().includes(server) ? [server] : []; })) : new Set<string>();
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
