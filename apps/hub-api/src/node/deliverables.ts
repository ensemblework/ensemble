/**
 * What the owner asked for, and whether the reply delivers it (docs/35 §6.1). A node's conversation
 * turn gets a checklist from its owner's new messages: rules for screenshots and how many, a table,
 * a file to add to their Ensemble Files, a place prices are for, a file in the chat, links; plus,
 * when the message asks for something, one small checklist call to the fast model at low thinking,
 * made while the turn runs and ignored when it fails or is late. When the model gives its final text,
 * code checks it (`runAssistantTurn`'s verify hook): what the reply will show, a Markdown table, a
 * saved file that exists, the place given to a tool, links that lead somewhere (node/refs-check.ts),
 * and no claim ("attached", "added to your files") without a tool result behind it. What is missing
 * goes back to the model, at most twice per turn.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { isUuid } from "@ensemble/shared-types";
import type { AssistantToolCall } from "@ensemble/shared-types";
import type { VerifyState } from "../assistant/agent.js";
import { askRuntimeStream } from "../lib/model-turn.js";
import { recordMetric } from "../lib/metrics.js";
import { callCost } from "../lib/pricing.js";
import { truncateText } from "../lib/text.js";
import { MAX_MEDIA, peekTurnMedia, type Media } from "./media.js";
import { validateRefs, type RefProblem } from "./refs-check.js";

export type Check =
  | { kind: "screenshots"; count: number; names?: string[]; exact?: boolean }
  | { kind: "table" }
  | { kind: "save_file" }
  | { kind: "location"; place: string }
  | { kind: "file_in_chat" }
  | { kind: "links" };

const WORDS: Record<string, number> = { one: 1, two: 2, both: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const SHOT = String.raw`(?:screen ?shots?|screen ?grabs?|screen ?caps?|screen captures?|snapshots?)`;
const SHOT_RE = new RegExp(String.raw`\b${SHOT}\b`, "i");
/** "4 screenshots", "four separate screenshots", "a couple of screenshots", "2 more screenshots". */
const COUNTED = new RegExp(String.raw`\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|both|a couple of|a pair of)\s+(?:(?:more|separate|different|full|clear|quick|small|new|other|web|page|browser)\s+){0,2}${SHOT}\b`, "i");
const SINGLE = new RegExp(String.raw`\b(?:a|an|one|the|single)\s+(?:(?:full|clear|quick|small|new|web|page|browser)\s+)?(?:screen ?shot|screen ?grab|screen capture|snapshot)\b(?!s)`, "i");
const EACH = /\b(?:each|every|all (?:the|of the|three|four|five)|per)\s+(?:of (?:the|these|those)\s+)?(?:web ?sites?|sites?|stores?|shops?|retailers?|pages?|ones?|companies|stocks?|tickers?|links?|results?)\b/i;

/** Stores a shopping request names (browser_shop's recipes and the big US retailers). */
const STORES: Array<[string, RegExp]> = [
  ["amazon", /\bamazon\b/i],
  ["walmart", /\bwal-?mart\b/i],
  ["target", /\btarget(?:\.com)?\b(?=[^.\n]{0,60}\b(?:price|store|stock|buy|shop|compare|walmart|amazon|best ?buy|costco)\b)|\b(?:at|from|and|,)\s+target\b/i],
  ["bestbuy", /\bbest ?buy\b/i],
  ["costco", /\bcostco\b/i],
  ["newegg", /\bnewegg\b/i],
  ["ebay", /\bebay\b/i],
  ["gamestop", /\bgame ?stop\b/i],
  ["bhphotovideo", /\bb ?& ?h\b|\bbhphotovideo\b|\bb and h photo\b/i],
];

export function storesNamed(text: string): string[] {
  return STORES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

/** A short list written after `from`: "Microsoft, Amazon, Nvidia and Apple stock" → 4 names; one item, or none, gives []. */
function listAt(text: string, from: number): string[] {
  const rest = text.slice(from).split(/[?!\n;]|\.(?=\s|$)|\b(?:and|then)\s+(?:add|save|put|give|make|send|write|tell|also|compare)\b|\b(?:in|with|as) (?:a|one) table\b/i)[0] ?? "";
  const body = rest.replace(/^\s*(?:of|for|from|on|:|-|–)\s*/i, "").replace(/^(?:the|these|those|my)\s+/i, "");
  const items = body
    .split(/\s*(?:,|&|\/|\band\b|\bvs\.?|\bversus\b)\s*/i)
    .map((item) => item.replace(/^(?:the|and|or)\s+/i, "").trim())
    .filter((item) => item && item.split(/\s+/).length <= 4 && !/^(?:a|an|each|every|all|some|any|it|them|this|that|these|those|me|us|one|both)\b/i.test(item));
  return items.length >= 2 ? items.slice(0, MAX_MEDIA * 2) : [];
}

function screenshotsIn(text: string): Check | null {
  const at = SHOT_RE.exec(text);
  if (!at) return null;
  const counted = COUNTED.exec(text);
  const listed = listAt(text, at.index + at[0].length);
  if (counted) {
    const raw = counted[1]!.toLowerCase();
    const count = /^\d+$/.test(raw) ? Number(raw) : raw.startsWith("a couple") || raw.startsWith("a pair") ? 2 : (WORDS[raw] ?? 1);
    if (count >= 1) return { kind: "screenshots", count: Math.min(count, MAX_MEDIA), exact: true, ...(listed.length ? { names: listed } : {}) };
  }
  if (EACH.test(text)) {
    const stores = storesNamed(text);
    const names = stores.length >= 2 ? stores : listed;
    if (names.length >= 2) return { kind: "screenshots", count: Math.min(names.length, MAX_MEDIA), names, exact: true };
  }
  if (listed.length >= 2 && /s$/i.test(at[0])) return { kind: "screenshots", count: Math.min(listed.length, MAX_MEDIA), names: listed, exact: true };
  return { kind: "screenshots", count: 1, exact: SINGLE.test(text) };
}

const TABLE = /\b(?:in|as|into|with|and|plus|also|give me|make|build|create|draw|show|put (?:it|them|this|that|everything) in|want|need)\s+(?:a\s+|the\s+|one\s+)?(?:markdown\s+|comparison\s+|small\s+|nice\s+|simple\s+|short\s+|quick\s+|clear\s+)?table\b|\btabular\b|\btable\s+(?:format|form|view)\b|\b(?:comparison|price|summary|markdown)\s+table\b|^\s*(?:a\s+)?table\s*[.!]?\s*$/im;
const SAVE_FILE = /\b(?:add|save|put|upload|store|keep|copy|drop|import)\b[^.?!\n]{0,80}?\b(?:to|in|into|on|under)\s+(?:my\s+|our\s+|the\s+)?(?:ensemble\s+)?files?\b(?!\s+(?:folder|directory|dir)\b)|\b(?:add|save|put|upload|store|keep|import)\b[^.?!\n]{0,80}?\b(?:to|in|into)\s+(?:my\s+)?ensemble\b(?!\s+(?:node|chat|crew|room))/i;
const FILE_IN_CHAT = /\b(?:send|share|attach|give|post|drop)\b[^.?!\n]{0,50}\b(?:file|report|pdf|document|doc|csv|log|spreadsheet|markdown|\.md)\b[^.?!\n]{0,40}\b(?:here|in (?:this|the|our) (?:chat|conversation|thread)|to me)\b/i;
const LINKS = /\b(?:with|include|including|give me|send me|add|share|list)\s+(?:the\s+|their\s+|its\s+|your\s+)?(?:links?|sources?|urls?|citations?|references?)\b|\bcite\b|\blinks? to (?:each|every|all|them|the)\b/i;
const PLACE_CONTEXT = /\b(?:prices?|pricing|costs?|cheap(?:est|er)?|buy|purchase|shop(?:ping)?|stores?|retailers?|deliver(?:y|ed)?|ship(?:ping|ped)?|in stock|out of stock|availab(?:le|ility)|deals?|near(?:by| me)?|local(?:ly)?|weather|forecast|restaurants?|zip)\b/i;

const STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming", "District of Columbia",
];
const STATE_RE = new RegExp(String.raw`\b(${STATES.join("|")})\b`, "i");
const CITY_STATE = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?),\s*(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/;
const ZIP = /\b(?:zip(?:\s?code)?|postal code|post ?code|deliver(?:y|ed)? to|ship(?:ping)? to|near|in|around|for|at)\s*:?\s*(\d{5})(?:-\d{4})?\b/i;
const COUNTRY = /\b(?:in|for|to|from|within)\s+(?:the\s+)?(US|USA|U\.S\.A?\.?|United States|UK|U\.K\.|United Kingdom|India|Canada|Germany|France|Australia|Japan|Singapore|Ireland|Spain|Italy|Mexico|Brazil|Netherlands|Sweden|UAE)\b/;

export function placeIn(text: string): string | null {
  if (!PLACE_CONTEXT.test(text)) return null;
  const zip = ZIP.exec(text);
  if (zip) return zip[1]!;
  const city = CITY_STATE.exec(text);
  if (city) return `${city[1]}, ${city[2]}`;
  const state = STATE_RE.exec(text);
  if (state) return STATES.find((name) => name.toLowerCase() === state[1]!.toLowerCase())!;
  const country = COUNTRY.exec(text);
  return country ? country[1]! : null;
}

/** The checklist the rules find in the owner's words. */
export function checklistFrom(text: string): Check[] {
  const checks: Check[] = [];
  const shots = screenshotsIn(text);
  if (shots) checks.push(shots);
  if (TABLE.test(text)) checks.push({ kind: "table" });
  if (SAVE_FILE.test(text)) checks.push({ kind: "save_file" });
  const place = placeIn(text);
  if (place) checks.push({ kind: "location", place });
  if (FILE_IN_CHAT.test(text) && !checks.some((check) => check.kind === "save_file")) checks.push({ kind: "file_in_chat" });
  if (LINKS.test(text)) checks.push({ kind: "links" });
  return checks;
}

const CHIT_CHAT = /^\s*(?:hi|hello|hey|yo|thanks|thank you|thx|ty|ok(?:ay)?|k|cool|great|nice|perfect|awesome|got it|sure|yes|no|yep|nope|good (?:morning|afternoon|evening|night)|bye|see you|lol|haha)\b[\s!.,:)]*$/i;
const ASKS = /\b(?:send|show|give|get|grab|find|fetch|download|compare|list|make|create|write|take|save|add|put|check|look up|screen ?shots?|tables?|prices?|links?|sources?|reports?|pdfs?|files?|charts?|pictures?|images?|photos?)\b/i;

/** Whether the words ask for something the model checklist may help with (not chit-chat). */
export function asksForSomething(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 8 && !CHIT_CHAT.test(trimmed) && ASKS.test(trimmed);
}

const ModelCheck = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("screenshots"), count: z.number().int().min(1).max(20) }),
  z.object({ kind: z.literal("table") }),
  z.object({ kind: z.literal("save_file") }),
  z.object({ kind: z.literal("location"), place: z.string().trim().min(2).max(80) }),
  z.object({ kind: z.literal("file_in_chat") }),
  z.object({ kind: z.literal("links") }),
]);

/** The checks a model's answer holds: strict JSON `{"checks": [...]}`, anything else ignored. */
export function parseModelChecklist(raw: string): Check[] | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = (parsed as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(list)) return null;
  const checks: Check[] = [];
  for (const item of list.slice(0, 8)) {
    const check = ModelCheck.safeParse(item);
    if (!check.success || checks.some((row) => row.kind === check.data.kind)) continue;
    checks.push(check.data.kind === "screenshots" ? { kind: "screenshots", count: Math.min(check.data.count, MAX_MEDIA) } : check.data);
  }
  return checks;
}

/** The rules' checklist with what the model found on top: a kind the rules missed, or a count where the rules had only "at least one". */
export function mergeChecklists(rules: readonly Check[], model: readonly Check[] | null): Check[] {
  const merged = [...rules];
  for (const check of model ?? []) {
    const index = merged.findIndex((row) => row.kind === check.kind);
    if (index < 0) merged.push(check);
    else if (check.kind === "screenshots") {
      const own = merged[index] as Extract<Check, { kind: "screenshots" }>;
      if (!own.exact && check.count > own.count) merged[index] = { ...own, count: check.count };
    }
  }
  return merged;
}

export const CHECKLIST_PROMPT = [
  "You list what a reply must deliver for the request below. Answer with JSON only, no prose and no code fence:",
  '{"checks": [...]} where each check is one of',
  '{"kind":"screenshots","count":N} (pictures or screenshots asked for; N = how many),',
  '{"kind":"table"} (a table asked for),',
  '{"kind":"save_file"} (a file to add to their Ensemble Files),',
  '{"kind":"location","place":"…"} (prices or results for a place),',
  '{"kind":"file_in_chat"} (a file to send into this chat),',
  '{"kind":"links"} (links or sources asked for).',
  'Only what the request explicitly asks for. {"checks":[]} when it asks for none of these.',
].join("\n");

/** Tools that hand the work on (a plan, a session, background work) or ask the owner first: the reply is not the deliverable yet. */
const HANDED_OFF = new Set(["node_work_start", "node_delegate", "node_plan", "node_plan_revise", "node_helper", "node_session_start", "node_session_send", "node_routines", "node_create", "node_create_group", "node_crew_add"]);
const MEDIA_CLAIM =
  /\b(?:i(?:'ve|’ve| have)?\s+attached|(?:is|are)\s+attached|attached\s+(?:is|are|below|above|here)|here(?:'s|’s| is| are) (?:the |your |a |an )?(?:\d+\s+|two |three |four |five |six |seven |eight )?(?:screenshots?|screen ?shots?|pictures?|images?|photos?|videos?|charts?)|(?:screenshots?|pictures?|images?|videos?) (?:is |are )?(?:below|above)|see the (?:screenshots?|pictures?|images?|videos?) (?:below|above))\b/i;
const FILES_CLAIM = /\b(?:added|saved|uploaded|put|stored|imported)\b[^.?!\n]{0,60}\b(?:to|in|into)\s+(?:your\s+|the\s+)?(?:ensemble\s+)?files\b(?!\s+(?:folder|directory)\b)/i;
const EXPLAINS = /\b(?:could ?n[o'’]t|can ?n[o'’]t|cannot|unable to|was ?n[o'’]t able|were ?n[o'’]t able|did ?n[o'’]t (?:load|work|show|return|find|open)|failed|blocked|not available|unavailable|not shown|no (?:prices?|results?|offers?) (?:shown|found|listed)|human check|captcha|robot or human|sign[ -]?in|log[ -]?in|refused|denied)\b/i;
const TABLE_ROW = /^\s*\|.*\|\s*$/m;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m;

export type Evidence = {
  text: string;
  calls: VerifyState["calls"];
  media: readonly Media[];
  /** Files `hub_save_file` saved in this turn that exist. */
  savedFiles: number;
  brokenLinks: readonly RefProblem[];
  round: number;
};

const okCall = (row: { call: AssistantToolCall }) => row.call.state === "ok";
const waitsForOwner = (result: unknown) => /"waitingForOwner"\s*:\s*true/.test(JSON.stringify(result ?? null));

/** Pictures a tool kept but held for the owner's preview card (`evidence` in its result). */
function heldPictures(result: unknown): number {
  const list = (result as { data?: { evidence?: unknown } } | null)?.data?.evidence;
  if (!Array.isArray(list)) return 0;
  return list.filter((item) => item && typeof item === "object" && (item as { held?: unknown }).held === true && ["screenshot", "image", "video"].includes(String((item as { kind?: unknown }).kind))).length;
}

/** What the reply still lacks, as the model's final text reads now. */
export function problemsWith(checks: readonly Check[], evidence: Evidence): string[] {
  const { text, calls, media } = evidence;
  const problems: string[] = [];
  // The work went on elsewhere (a plan, a session, background work) or waits for the owner: the reply is not the deliverable yet.
  const later = calls.some((row) => okCall(row) && HANDED_OFF.has(row.call.name)) || calls.some((row) => waitsForOwner(row.result));
  const failed = calls.some((row) => row.call.state === "failed" || /"status"\s*:\s*"(?:blocked|human_check|error)"|"humanCheck"\s*:\s*(?:true|")/.test(JSON.stringify(row.result ?? null)));
  // A shortfall the reply plainly explains stands once something went wrong or it was asked once already;
  // so does a question to the owner after one round (the first round pushes a small model to act instead).
  const explained = (EXPLAINS.test(text) && (failed || evidence.round > 0)) || (evidence.round > 0 && /\?["”')\]]*\s*$/.test(text.trim()));
  // Captures held for the owner's preview reach them on their card.
  const held = calls.reduce((sum, row) => sum + heldPictures(row.result), 0);
  const pictures = media.filter((item) => item.kind === "screenshot" || item.kind === "image" || item.kind === "video").length + held;
  for (const check of later ? [] : checks) {
    if (check.kind === "screenshots" && pictures < check.count && !explained) {
      const names = check.names?.length ? ` (${check.names.join(", ")})` : "";
      problems.push(
        check.count === 1
          ? `a screenshot was asked for${names} and none will show with your reply`
          : `${check.count} screenshots were asked for${names} and ${pictures === 0 ? "none" : pictures} will show with your reply`,
      );
    }
    if (check.kind === "table" && !(TABLE_ROW.test(text) && TABLE_RULE.test(text)) && !(explained && evidence.round > 0)) problems.push("a table was asked for: write it as a Markdown table in your reply");
    if (check.kind === "save_file" && evidence.savedFiles === 0 && !explained) {
      problems.push("the file was to be added to your owner's Ensemble Files and nothing was saved there (hub_save_file with the direct file link, or with the evidence id of a file you fetched)");
    }
    if (check.kind === "location" && !placeUsed(check.place, calls) && !explained) {
      problems.push(`the results are for ${check.place}, and no tool was given that location (browser_shop or browser_view with location, or browser_set_location)`);
    }
    if (check.kind === "file_in_chat" && media.length === 0 && !explained) problems.push("a file was to be sent into this chat and none will show with your reply (node_share_file, or node_show with its evidence id)");
    if (check.kind === "links" && !/https?:\/\/\S+|ensemble:\/\/\S+|\]\((?:https?:|ensemble:|\/)/i.test(text) && !explained) problems.push("links were asked for: give the links your tools returned");
  }
  for (const link of evidence.brokenLinks) problems.push(`the link ${link.href} leads nowhere (${link.problem}): link only what a tool returned`);
  if (MEDIA_CLAIM.test(text) && media.length + held === 0) problems.push("your reply says something is attached or shown, but nothing will show with it: never say so unless a tool said it will appear");
  if (FILES_CLAIM.test(text) && evidence.savedFiles === 0) problems.push("your reply says a file is in your owner's Files, but no hub_save_file call saved it");
  return problems;
}

/** Whether a tool was given the place: in its input (`location`, a ZIP, the words), or a location was set. */
function placeUsed(place: string, calls: VerifyState["calls"]): boolean {
  const wanted = place.toLowerCase();
  return calls.some(({ call }) => {
    if (call.name === "browser_set_location") return true;
    const input = (call.input ?? {}) as Record<string, unknown>;
    if (typeof input.location === "string" && input.location.trim()) return true;
    if (typeof input.zip === "string" && input.zip.trim()) return true;
    return JSON.stringify(input).toLowerCase().includes(wanted);
  });
}

export const FEEDBACK_END = "Do it now with your tools, or say plainly what could not be done and why.";

export function feedbackFor(problems: readonly string[]): string | null {
  if (!problems.length) return null;
  return `Not done yet: ${problems.join("; ")}. ${FEEDBACK_END}`;
}

/** Ids of files `hub_save_file` saved in this turn (its result's `file.id` or `ensemble://file/<id>` link). */
export function savedFileIds(calls: VerifyState["calls"]): Array<{ id: string; space: string | null }> {
  const out: Array<{ id: string; space: string | null }> = [];
  for (const { call, result } of calls) {
    if (call.name !== "hub_save_file" || call.state !== "ok") continue;
    const json = JSON.stringify(result ?? null);
    const ids = new Set<string>();
    for (const match of json.matchAll(/ensemble:\/\/file\/([0-9a-f-]{36})/gi)) ids.add(match[1]!.toLowerCase());
    const file = (result as { data?: { file?: { id?: unknown } } } | null)?.data?.file?.id;
    if (isUuid(file)) ids.add(file.toLowerCase());
    for (const id of ids) out.push({ id, space: call.space?.id ?? null });
  }
  return out;
}

const MODEL_WAIT_MS = 3_000;
const MODEL_TIMEOUT_MS = 20_000;

export type DeliverablesInput = {
  ownerId: string;
  turnId: string;
  /** The owner's new messages in this turn. */
  text: string;
  /** The model for the checklist call (the fast one; none when only an AI plan on a computer is there). */
  model: { provider: string; model: string } | null;
  activityId: string;
  signal?: AbortSignal;
};

/** Whether the checklist call to the model is on (`ENSEMBLE_NODE_CHECKLIST_MODEL=off` turns it off). */
export function checklistModelOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ENSEMBLE_NODE_CHECKLIST_MODEL ?? "on").trim().toLowerCase() !== "off";
}

/** The model's checklist: asked while the turn runs, null when it fails. Metered like the turn's own calls. */
async function modelChecklist(app: FastifyInstance, input: DeliverablesInput): Promise<Check[] | null> {
  const model = input.model!;
  try {
    const turn = await askRuntimeStream({
      messages: [
        { role: "system", content: CHECKLIST_PROMPT },
        { role: "user", content: `Request:\n${truncateText(input.text, 2000)}` },
      ],
      model: model.model,
      provider: model.provider,
      reasoningEffort: "low",
      userId: input.ownerId,
      activityId: input.activityId,
      chatTools: [],
      responsesTools: [],
      signal: input.signal,
      timeoutMs: MODEL_TIMEOUT_MS,
      purpose: "Ensemble Node",
    });
    await recordMetric(app.prisma, {
      userId: input.ownerId,
      kind: "model.call",
      meta: { provider: model.provider, model: turn.model || model.model, purpose: "Ensemble Node", tokensIn: turn.tokensIn, tokensOut: turn.tokensOut, ...callCost(model.provider, turn.model || model.model, turn.tokensIn, turn.tokensOut, turn.credits), title: "Checklist" },
    }).catch(() => undefined);
    return parseModelChecklist(turn.text);
  } catch {
    return null;
  }
}

export type Deliverables = { checks: readonly Check[]; verify: (state: VerifyState) => Promise<string | null> };

/**
 * Starts a turn's checklist (the model's part runs while the turn does, when the words ask for
 * something) and returns its verify hook. Links and claims are checked whatever the checklist.
 */
export function startDeliverables(app: FastifyInstance, input: DeliverablesInput): Deliverables {
  const rules = checklistFrom(input.text);
  const ask = Boolean(input.model) && checklistModelOn() && asksForSomething(input.text);
  const pending = ask ? modelChecklist(app, input) : Promise.resolve(null);
  let settled: Check[] | null | undefined = ask ? undefined : null;
  void pending.then((found) => (settled = found));
  const checks: Check[] = [...rules];
  return {
    checks,
    async verify(state) {
      if (settled === undefined) {
        const late = new Promise<null>((resolve) => setTimeout(() => resolve(null), MODEL_WAIT_MS).unref());
        settled = await Promise.race([pending, late]);
      }
      checks.splice(0, checks.length, ...mergeChecklists(rules, settled ?? null));
      const brokenLinks = state.text.includes("ensemble://") ? await validateRefs(state.text, input.ownerId, app.prisma) : [];
      if (!checks.length && !brokenLinks.length && !MEDIA_CLAIM.test(state.text) && !FILES_CLAIM.test(state.text)) return null;
      const saved = savedFileIds(state.calls);
      const owners = [...new Set([input.ownerId, ...saved.flatMap((row) => (row.space ? [row.space] : []))])];
      const savedFiles = saved.length ? await app.prisma.document.count({ where: { id: { in: saved.map((row) => row.id) }, deletedAt: null, userId: { in: owners } } }) : 0;
      return feedbackFor(problemsWith(checks, { text: state.text, calls: state.calls, media: peekTurnMedia(input.turnId), savedFiles, brokenLinks, round: state.round }));
    },
  };
}
