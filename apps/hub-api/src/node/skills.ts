/**
 * Skills for a node's turn (docs/35 §5.6): Ensemble's bundled skills (skills/<name>/SKILL.md at the repository
 * root, embedded by packages/prompts) and its owner's own enabled personal skills, as one catalogue. No model
 * call chooses them: `scoreSkill` weighs the words of the request and the task against each skill (its
 * keywords and name found there, the request's words in its description, the first part of an owner's skill,
 * a read in this conversation's last replies, and a small weight for the process skills), with the weights of
 * the versioned config (context/config.ts). The best few go into the turn's context, one line each with when
 * to use it (`node/56-skills`); a skill whose tools the turn lacks is not offered. The node reads one in full
 * with `node_skill`; when the request has the best one's own words, its guidance comes in full with the turn
 * too (`inlineGuidance`, `node/56-skill-guidance`), as small models need.
 *
 * The tool tiers (which browser and capture tools a conversation turn offers) are here too: `tieredTools`.
 */
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { SKILLS } from "@ensemble/prompts";
import { hasModule } from "@ensemble/shared-types";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool } from "../assistant/types.js";
import type { SkillsConfig } from "../context/config.js";
import { purposeOf } from "../lib/skill-purpose.js";
import { truncateText } from "../lib/text.js";
import { stem, STOPWORDS } from "../workspace/session-choice/text.js";

export type CatalogueSkill = {
  name: string;
  source: "bundled" | "owner";
  /** An owner's skill's id. */
  id?: string;
  /** When to use it. */
  description: string;
  keywords: readonly string[];
  /** Offered only when the turn has one of these tools; empty when it needs none. */
  tools: readonly string[];
  priority: string;
  /** The start of an owner's skill's instructions, which are scored too. */
  body?: string;
  /** Its guidance in full, for `inlineGuidance`. */
  text?: string;
};

export const BUNDLED_SKILLS: readonly CatalogueSkill[] = Object.values(SKILLS).map((skill) => ({
  name: skill.name,
  source: "bundled",
  description: skill.description,
  keywords: skill.keywords,
  tools: skill.tools,
  priority: skill.priority,
  text: skill.body,
}));

/** Ways of writing the same words: "log into" is "log in", "login" is "log in", "screengrab" is "screen grab". */
const SAME_WORDS: Record<string, string> = {
  into: "in",
  onto: "on",
  login: "log in",
  logins: "log ins",
  logon: "log on",
  loggedin: "logged in",
  signin: "sign in",
  signins: "sign ins",
  signon: "sign on",
  signedin: "signed in",
  screengrab: "screen grab",
  screengrabs: "screen grabs",
  screenshot: "screen shot",
  screenshots: "screen shots",
  webpage: "web page",
  webpages: "web pages",
};

/** Words as the scorer compares them: lower case, apostrophes dropped, written one way (`SAME_WORDS`), each reduced to its stem. */
export function stems(text: string): string[] {
  return (text.toLowerCase().replace(/['’]/g, "").match(/[\p{L}\p{N}]+/gu) ?? []).flatMap((word) => (SAME_WORDS[word] ?? word).split(" ")).map((word) => stem(word));
}

/** Words every description has ("Use when your owner asks…"), which say nothing about the skill. */
const GENERIC = new Set(["use", "when", "owner", "ask", "work", "want", "need", "help", "thing", "make", "get", "tell", "say", "someone", "another", "other", "more", "than", "before", "after"].map((word) => stem(word)));
const STOP = new Set([...STOPWORDS].map((word) => stem(word)));
const meaningful = (list: readonly string[]) => new Set(list.filter((word) => word.length > 1 && !STOP.has(word) && !GENERIC.has(word) && !/^\d+$/.test(word)));

/** Whether `phrase` (stems) appears in `words` (stems) as consecutive words. */
function contains(words: readonly string[], phrase: readonly string[]): boolean {
  if (!phrase.length || phrase.length > words.length) return false;
  outer: for (let at = 0; at + phrase.length <= words.length; at += 1) {
    for (let index = 0; index < phrase.length; index += 1) if (words[at + index] !== phrase[index]) continue outer;
    return true;
  }
  return false;
}

/** A request prepared once for scoring every skill. */
export type Request = { words: string[]; meaningful: Set<string> };

export function prepareRequest(text: string): Request {
  const words = stems(text);
  return { words, meaningful: meaningful(words) };
}

/**
 * Points for one skill against the request (config `weights`), with the signals that gave them; `strength` is
 * the part its own words gave (its keywords and its name), which decides whether its guidance comes in full.
 */
export function scoreSkill(skill: CatalogueSkill, request: Request, recent: ReadonlySet<string>, config: SkillsConfig): { score: number; strength: number; why: string[] } {
  const { weights } = config;
  const why: string[] = [];
  let points = 0;
  let strength = 0;
  const hits = new Set<string>();
  for (const keyword of skill.keywords) {
    const phrase = stems(keyword);
    if (contains(request.words, phrase)) hits.add(phrase.join(" "));
  }
  if (hits.size) {
    points += weights.keyword * hits.size;
    strength += weights.keyword * hits.size;
    why.push(`keywords: ${[...hits].join(", ")}`);
  }
  const name = stems(skill.name);
  if (contains(request.words, name)) {
    points += weights.name;
    strength += weights.name;
    why.push("name");
  } else if (skill.source === "owner") {
    const named = meaningful(name);
    const found = [...named].filter((word) => request.meaningful.has(word)).length;
    if (found) {
      points += (weights.name / 2) * (found / named.size);
      why.push("words of its name");
    }
  }
  const described = [...meaningful(stems(skill.description))].filter((word) => request.meaningful.has(word));
  if (described.length) {
    points += weights.description * Math.min(described.length, weights.descriptionMax);
    why.push(`description: ${described.slice(0, weights.descriptionMax).join(", ")}`);
  }
  if (skill.body) {
    const inBody = [...meaningful(stems(skill.body))].filter((word) => request.meaningful.has(word));
    if (inBody.length) {
      points += weights.body * Math.min(inBody.length, weights.descriptionMax);
      why.push("its instructions");
    }
  }
  if (recent.has(skill.name.toLowerCase())) {
    points += weights.recent;
    why.push("read in this conversation");
  }
  if (skill.priority === "p0") {
    points += weights.p0;
    why.push("process skill");
  }
  return { score: Math.round(points * 1000) / 1000, strength: Math.round(strength * 1000) / 1000, why };
}

export type SkillChoice = { skill: CatalogueSkill; score: number; strength: number; why: string[]; line: string };

/** When to use a skill in at most `max` characters, cut at a word. */
function when(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = truncateText(flat, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** One catalogue line: its name (an owner's skill says it is theirs) and when to use it. */
export function catalogueLine(skill: CatalogueSkill, max: number): string {
  return `- ${skill.name}${skill.source === "owner" ? " (your owner's skill)" : ""}: ${when(skill.description || "Your owner's own instructions.", max)}`;
}

/**
 * The catalogue for a turn: the skills it can use (the tools they need are offered; an owner's skill hides a
 * bundled one of the same name and is found by its keywords too), scored against the request, the best `max`
 * that score at least `minScore`, within `budgetChars`.
 */
export function chooseSkills(input: { text: string; skills: readonly CatalogueSkill[]; has: (tool: string) => boolean; recent?: ReadonlySet<string>; config: SkillsConfig }): SkillChoice[] {
  const { config } = input;
  const request = prepareRequest(input.text);
  const recent = input.recent ?? new Set<string>();
  const bundled = new Map(input.skills.filter((skill) => skill.source === "bundled").map((skill) => [skill.name.toLowerCase(), skill]));
  const owned = new Set(input.skills.filter((skill) => skill.source === "owner").map((skill) => skill.name.toLowerCase()));
  const usable = input.skills
    .filter((skill) => (skill.source === "owner" || !owned.has(skill.name.toLowerCase())) && (!skill.tools.length || skill.tools.some((tool) => input.has(tool))))
    .map((skill) => {
      const same = skill.source === "owner" ? bundled.get(skill.name.toLowerCase()) : undefined;
      return same ? { ...skill, keywords: [...skill.keywords, ...same.keywords] } : skill;
    });
  const ranked = usable
    .map((skill, order) => ({ skill, order, ...scoreSkill(skill, request, recent, config) }))
    .filter((row) => row.score >= config.minScore)
    .sort((a, b) => b.score - a.score || (a.skill.priority === "p0" ? 0 : 1) - (b.skill.priority === "p0" ? 0 : 1) || a.order - b.order);
  const chosen: SkillChoice[] = [];
  let chars = 0;
  for (const row of ranked) {
    if (chosen.length >= config.max) break;
    const line = catalogueLine(row.skill, config.lineChars);
    if (chars + line.length + 1 > config.budgetChars) continue;
    chosen.push({ skill: row.skill, score: row.score, strength: row.strength, why: row.why, line });
    chars += line.length + 1;
  }
  return chosen;
}

const OWNER_BODY_SCORED = 1_000;
const OWNER_TEXT_CHARS = 20_000;

export type SkillGuidance = { name: string; source: CatalogueSkill["source"]; text: string; cut: boolean };

/**
 * The best skill's guidance in full, for the turn's context: only when its own words (keywords and name) give at
 * least `inline.minScore`, at most `inline.chars` characters, whole lines from its start with where to read the
 * rest when it is longer. One skill at most; the others stay catalogue lines for `node_skill`.
 */
export function inlineGuidance(choices: readonly SkillChoice[], config: SkillsConfig): SkillGuidance | null {
  const top = choices[0];
  const text = top?.skill.text?.trim();
  if (!top || !text || top.strength < config.inline.minScore) return null;
  const { name, source } = top.skill;
  if (text.length <= config.inline.chars) return { name, source, text, cut: false };
  const rest = `(The rest of this skill: node_skill “${name}”.)`;
  const kept: string[] = [];
  let chars = rest.length;
  for (const line of text.split("\n")) {
    if (chars + line.length + 1 > config.inline.chars) break;
    kept.push(line);
    chars += line.length + 1;
  }
  while (kept.length && !kept.at(-1)!.trim()) kept.pop();
  return kept.length ? { name, source, text: [...kept, rest].join("\n"), cut: true } : null;
}

/** The owner's enabled personal skills (not one made for a feature), as catalogue entries. */
export async function ownerSkills(prisma: PrismaClient, spaceId: string, modules: string | null | undefined): Promise<CatalogueSkill[]> {
  if (!hasModule(modules, "skills")) return [];
  const rows = await prisma.skill.findMany({
    where: { userId: spaceId, deletedAt: null, enabled: true },
    select: { id: true, name: true, description: true, body: true, scope: true },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  return rows
    .filter((row) => !purposeOf(row.scope))
    .map((row) => ({
      name: row.name.trim() || "Untitled skill",
      source: "owner" as const,
      id: row.id,
      description: row.description.trim() || (row.body.split("\n").find((line) => line.trim() && !line.startsWith("---"))?.trim() ?? ""),
      keywords: [],
      tools: [],
      priority: "p1",
      body: row.body.slice(0, OWNER_BODY_SCORED),
      text: row.body.slice(0, OWNER_TEXT_CHARS),
    }));
}

/** Skills `node_skill` read in this conversation's last `replies` replies, by name (lower case). */
export async function recentSkillReads(prisma: PrismaClient, conversationId: string | null, replies: number): Promise<Set<string>> {
  if (!conversationId || replies <= 0) return new Set();
  const rows = await prisma.assistantMessage.findMany({ where: { conversationId, role: "assistant" }, orderBy: { createdAt: "desc" }, take: replies, select: { toolCalls: true } });
  const names = new Set<string>();
  for (const row of rows) {
    for (const call of Array.isArray(row.toolCalls) ? (row.toolCalls as Array<Record<string, unknown> | null>) : []) {
      if (call?.name !== "node_skill") continue;
      const input = (call.input ?? (typeof call.arguments === "string" ? safeJson(call.arguments) : call.arguments)) as { name?: unknown } | null;
      if (typeof input?.name === "string") names.add(input.name.trim().toLowerCase());
    }
  }
  return names;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const SKILL_TEXT_CHARS = 12_000;

/** `node_skill`: a skill's full text by its name: the owner's own first (where only the owner reads), then Ensemble's. */
export function skillTool(scope: { prisma: PrismaClient; node: { userId: string }; ownerOnly: boolean; lineage: { fromNonOwner: boolean } }): AnyHubTool {
  const { prisma, node } = scope;
  return defineTool({
    name: "node_skill",
    area: "tasks",
    description:
      "Read a skill in full by its name: one listed under Skills for this request, any of Ensemble's skills, or one of your owner's own skills. Read the one that fits before longer work of its kind (several steps, a deliverable), not for a quick answer or one change, and once in a conversation; it is guidance, and your owner's words come first.",
    input: z.object({ name: z.string().min(1).max(200).describe("The skill's name as listed (“debugging”, or your owner's skill's name).") }).strict(),
    isWrite: false,
    risk: "low",
    parallelSafe: true,
    async run(_ctx, input) {
      const wanted = input.name.trim().replace(/^[“"']|[”"']$/g, "").trim();
      const lower = wanted.toLowerCase();
      // The owner's skills may hold private instructions: only in a turn its owner started and reads alone.
      if (scope.ownerOnly && !scope.lineage.fromNonOwner) {
        const user = await prisma.user.findUnique({ where: { id: node.userId }, select: { moduleSet: true } });
        if (hasModule(user?.moduleSet, "skills")) {
          const rows = await prisma.skill.findMany({ where: { userId: node.userId, deletedAt: null, enabled: true }, select: { id: true, name: true, slug: true, description: true, body: true, scope: true }, take: 200 });
          const own = rows.filter((row) => !purposeOf(row.scope)).find((row) => row.name.trim().toLowerCase() === lower || row.slug.toLowerCase() === lower || row.id === wanted);
          if (own) {
            return toolOk(
              `Read your owner's skill “${own.name}”.`,
              {
                name: own.name,
                source: "your owner's skill",
                description: own.description,
                text: own.body.slice(0, SKILL_TEXT_CHARS),
                ...(own.body.length > SKILL_TEXT_CHARS ? { more: `The rest: hub_read_skill with skillId ${own.id} and offset ${SKILL_TEXT_CHARS}.` } : {}),
              },
              { href: `/skills?skill=${own.id}` },
            );
          }
        }
      }
      const bundled = Object.values(SKILLS).find((skill) => skill.name === lower.replace(/\s+/g, "-"));
      if (bundled) return toolOk(`Read the ${bundled.name} skill.`, { name: bundled.name, source: "Ensemble", description: bundled.description, text: bundled.body });
      throw new ToolBlockedError(`There is no skill called “${wanted}”.`, `Ensemble's skills: ${Object.keys(SKILLS).join(", ")}. Your owner's own skills go by their names.`);
    },
  });
}

/**
 * Tool tiers (docs/35 §6.1): the browser and capture tools for building or testing a web app or making a
 * video. A conversation turn offers them only when its words are about that work, or the conversation's
 * last tools were; web screenshots are browser_view and browser_screenshot. browser_tabs and
 * browser_close are not among them: a click can open a popup (a payment window) and the owner can ask
 * to close a tab at any time. Plan steps and turns that carry on work (an answered card, a run that
 * ended) keep every tool.
 */
export const ADVANCED_TOOLS: ReadonlySet<string> = new Set([
  "browser_console",
  "browser_network_errors",
  "browser_record",
  "browser_upload",
  "capture_app_start",
  "capture_app_stop",
  "capture_apps",
  "capture_check",
  "capture_status",
  "capture_video",
  "capture_screenshot",
]);

const ADVANCED_INTENT =
  /\b(?:videos?|record(?:ing)?|screencast|gif|(?:browser|js|javascript|dev ?tools) console|console (?:logs?|errors?|messages?|output)|network (?:errors?|requests?|tab)|devtools|upload|dev server|localhost|127\.0\.0\.1|desktop app|electron|tauri|app window|e2e|end[- ]to[- ]end|playwright|(?:test|testing|tested|debug|debugging|qa|build|building|check|checking)\b[^.?!\n]{0,40}\b(?:app|apps|site|website|web ?page|page|ui|frontend|front[- ]end|sign-?up|log-?in|form|flow|feature|endpoint|game|build))\b/i;

/** Whether a turn's words (or its conversation's last tools) are about building or testing a web app or a video. */
export function wantsAdvancedTools(words: string, recentTools: readonly string[] = []): boolean {
  return ADVANCED_INTENT.test(words) || recentTools.some((name) => ADVANCED_TOOLS.has(name)) || [...ADVANCED_TOOLS].some((name) => words.includes(name));
}

/**
 * Tools a conversation turn is offered only for their kind of work: when its words say so, when one of them is named,
 * or when the conversation's last replies used one. `always`: the node's situation needs them whatever the words.
 */
export type ToolTier = { name: string; tools: (name: string) => boolean; intent: RegExp; always?: keyof TierSituation };

/** What about the node's situation keeps a tier's tools in every turn (node/brain.ts): `crew`, it leads a crew, has helpers or other nodes beside it, or works in a crew, a task room or a plan. */
export type TierSituation = { crew: boolean };

const CREW_TOOLS = new Set(["node_plan", "node_plan_revise", "node_delegate", "node_crew_add"]);
const SESSION_EXTRAS = new Set(["node_session_delete", "node_session_queue", "node_session_adopt", "node_session_hand_over", "node_answer_question"]);
const MAKER_TOOLS = new Set(["node_create", "node_create_group", "node_routines"]);

export const TOOL_TIERS: readonly ToolTier[] = [
  { name: "advanced", tools: (name) => ADVANCED_TOOLS.has(name), intent: ADVANCED_INTENT },
  // An app on the owner's screen: its windows, a recording of it, the screen itself.
  {
    name: "desktop",
    tools: (name) => name.startsWith("desktop_"),
    intent: /\b(?:desktop|(?<!web[ -]?)apps?|applications?|programs?|windows?|screens?|gui|record(?:ing)?|videos?|screencast|calculator|install(?:er|ing)?|file manager|finder|menu bar|dialog)\b/i,
  },
  // Work for several nodes: a crew's plan, a step for a member or a helper.
  { name: "crew", tools: (name) => CREW_TOOLS.has(name), intent: /@[a-z0-9]|\b(?:crew|delegate|delegating|helpers?|(?:other|my|your|another|new|the) nodes?\b(?!\.))/i, always: "crew" },
  // A coding session's less common handling.
  { name: "sessions", tools: (name) => SESSION_EXTRAS.has(name), intent: /\b(?:sessions?|claude|codex|copilot|cursor|gemini|coding agents?|adopt|hand (?:it )?over|queue)\b/i },
  { name: "terminal", tools: (name) => name.startsWith("terminal_") || name === "live_view", intent: /\b(?:terminal|shell|interactive|ssh|repl|live|watch|tty|tmux|htop)\b/i },
  {
    name: "maker",
    tools: (name) => MAKER_TOOLS.has(name),
    intent: /\b(?:routines?|every (?:day|morning|evening|night|week(?:day)?|month|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+)|daily|weekly|monthly|hourly|each (?:day|morning|evening|week|month)|recurring|automat\w*|(?:a|new|another) (?:node|group|crew)\b(?!\.))/i,
  },
];

/**
 * A conversation turn's tools: a tier's only when the turn is about that work (`TOOL_TIERS`), so a plain request is
 * not sent every tool's description. Steps and turns that carry on earlier work keep them all (node/brain.ts).
 */
export function tieredTools<T extends { name: string }>(tools: readonly T[], words: string, recentTools: readonly string[] = [], situation: Partial<TierSituation> = {}): T[] {
  const wanted = (tier: ToolTier) =>
    (tier.always !== undefined && situation[tier.always] === true) ||
    tier.intent.test(words) ||
    recentTools.some((name) => tier.tools(name)) ||
    tools.some((tool) => tier.tools(tool.name) && words.includes(tool.name));
  const hidden = TOOL_TIERS.filter((tier) => !wanted(tier));
  return tools.filter((tool) => !hidden.some((tier) => tier.tools(tool.name)));
}
