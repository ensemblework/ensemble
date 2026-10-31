/**
 * `web_task` (docs/35 §6.1): a small agent loop on this server for multi-step web work the node's other
 * tools do not cover (a value behind clicks on a dashboard, a console to read, a form to fill). Each
 * step it reads the tab (browser_snapshot, interactive elements only), asks the node's model at low
 * thinking for one action as JSON, and does it with the node's own browser tools on its owner's
 * computer (node/device-tools.ts), so their rules, cards and evidence apply. Its own rules: it never
 * types a password or a code (a sign-in goes to the owner's card and the turn parks, as other waits
 * do), never buys, pays, deletes or sends anything the owner's words did not ask for, and stops at a
 * human check. Each model call is metered like the turn's own.
 */
import { z } from "zod";
import { isSubscriptionProvider } from "@ensemble/shared-types";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool, type ToolContext, type ToolResult } from "../assistant/types.js";
import { askRuntimeStream, type ModelMessage } from "../lib/model-turn.js";
import { recordMetric } from "../lib/metrics.js";
import { callCost } from "../lib/pricing.js";
import { loadSettings } from "../lib/settings.js";
import { truncateText } from "../lib/text.js";
import { captureTools } from "./device-tools.js";
import { chatModelFor, fastChatModel, type ChatModel } from "./model.js";
import { parkedFor } from "./queue.js";
import type { NodeScope } from "./tools.js";

export const MAX_WEB_STEPS = 8;
/** What one observation of the page gives the model. */
const PAGE_CHARS = 8_000;
const RESULT_CHARS = 1_500;
const EXTRACT_CHARS = 6_000;
const MODEL_TIMEOUT_MS = 60_000;

export type WebTaskStatus = "done" | "sign_in_needed" | "human_check" | "blocked" | "gave_up";

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), ref: z.string().min(1).max(40) }),
  z.object({ action: z.literal("type"), ref: z.string().min(1).max(40), text: z.string().max(2000), submit: z.boolean().optional() }),
  z.object({ action: z.literal("press"), key: z.string().min(1).max(40) }),
  z.object({ action: z.literal("goto"), url: z.string().min(1).max(4000) }),
  z.object({ action: z.literal("scroll"), direction: z.enum(["down", "up"]).optional() }),
  z.object({ action: z.literal("wait"), text: z.string().max(200).optional(), ms: z.number().int().min(0).max(10_000).optional() }),
  z.object({ action: z.literal("extract"), focus: z.string().max(200).optional() }),
  z.object({ action: z.literal("screenshot"), focus: z.string().max(200).optional() }),
  z.object({ action: z.literal("done"), answer: z.string().min(1).max(4000) }),
  z.object({ action: z.literal("stop"), reason: z.string().min(1).max(1000) }),
]);
export type WebAction = z.infer<typeof Action>;

export const WEB_TASK_PROMPT = [
  "You do one web task for your owner's Ensemble Node, one action at a time, in the browser on their computer.",
  "Each turn you get the goal, what you did so far, and the page now: its interactive elements, each with a [ref=…].",
  "Answer with one JSON object and nothing else, one of:",
  '{"action":"click","ref":"e12"}',
  '{"action":"type","ref":"e7","text":"…","submit":true}',
  '{"action":"press","key":"Enter"}',
  '{"action":"goto","url":"https://…"}',
  '{"action":"scroll","direction":"down"}',
  '{"action":"wait","text":"words the page will show"}',
  '{"action":"extract","focus":"the usage table"} (reads the page\'s main content as text)',
  '{"action":"screenshot","focus":"the chart"} (a picture your owner sees)',
  '{"action":"done","answer":"what you found, with the numbers and where"}',
  '{"action":"stop","reason":"why it cannot be done"}',
  "Rules: never type a password, a one-time code or card details: on a sign-in page stop with reason \"sign in\". Never buy, pay, delete, send or submit anything the goal does not ask for. A captcha or \"Robot or human?\": stop with reason \"human check\".",
  "Use only refs from the page now. Answer done as soon as the goal is met.",
].join("\n");

/** Sign-in pages: a password field, or an identity provider's own page. */
const PASSWORD_FIELD = /\b(?:textbox|input|field)\b[^\n]*\b(?:password|passcode|passwort|contraseña)\b|\[type=password\]/i;
const IDENTITY_HOSTS = /^(?:login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|accounts\.google\.com|signin\.aws\.amazon\.com|[a-z0-9-]+\.signin\.aws\.amazon\.com|appleid\.apple\.com|idmsa\.apple\.com|login\.salesforce\.com|[a-z0-9-]+\.okta\.com|[a-z0-9-]+\.auth0\.com|login\.yahoo\.com)$/i;
const HUMAN_CHECK = /\b(?:robot or human|verify (?:that )?you(?: are|'re|’re) (?:a )?human|are you a robot|press (?:&|and) hold|checking (?:if the site connection is secure|your browser)|unusual traffic from your|complete the (?:security )?check|solve the captcha|captcha challenge)\b|\bjust a moment\s*(?:\.\.\.|…)/i;
const BLOCKED = /\b(?:could not load the page|ERR_[A-Z_]+|access denied|403 forbidden|\(403\)|you have been blocked|request blocked)\b/i;
/** Fields nothing types into: the owner signs in on their card. */
const SECRET_FIELD = /\b(?:password|passcode|one[- ]time|otp|verification code|security code|2fa|two[- ]factor|authenticator|pin|cvv|cvc|card number|credit card)\b/i;
/** What a click must not do without the owner's words, by the words that allow it. */
const RISKY: Array<{ label: RegExp; allowed: RegExp; what: string }> = [
  { label: /\b(?:buy|purchase|place (?:your |my )?order|order now|pay(?: now)?|checkout|check out|complete (?:purchase|order)|confirm (?:order|payment|purchase))\b/i, allowed: /\b(?:buy|purchase|order|pay|checkout|check out)\b/i, what: "buy or pay" },
  { label: /\b(?:delete|remove|erase|destroy|terminate|deactivate|close (?:my |the )?account|cancel (?:my |the )?(?:subscription|account|plan|order))\b/i, allowed: /\b(?:delete|remove|erase|destroy|terminate|deactivate|cancel|close)\b/i, what: "delete or cancel" },
  { label: /\b(?:send|transfer|donate|wire|publish|post)\b/i, allowed: /\b(?:send|transfer|donate|wire|publish|post|reply|email|message)\b/i, what: "send or publish" },
  { label: /\b(?:subscribe|upgrade|start (?:my |a )?(?:free )?trial)\b/i, allowed: /\b(?:subscribe|upgrade|trial|sign up)\b/i, what: "subscribe" },
];

/** The line of a snapshot that names `ref`, without the ref itself. */
export function labelOf(page: string, ref: string): string {
  const line = page.split("\n").find((row) => row.includes(`[ref=${ref}]`)) ?? "";
  return line.replace(/\[ref=[^\]]+\]/g, "").replace(/^\s*-\s*/, "").trim();
}

export function signInPage(url: string, page: string): boolean {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  return IDENTITY_HOSTS.test(host) || PASSWORD_FIELD.test(page);
}

export function humanCheckPage(page: string): boolean {
  return HUMAN_CHECK.test(page);
}

/** A field only the owner types into (a password, a one-time code, card details). */
export function secretField(label: string): boolean {
  return SECRET_FIELD.test(label);
}

/** Why the owner's words do not cover this click, or null when they do (or it is harmless). */
export function riskyClick(label: string, ownerWords: string): string | null {
  for (const risk of RISKY) if (risk.label.test(label) && !risk.allowed.test(ownerWords)) return risk.what;
  return null;
}

/** One JSON action from the model's answer, or why it is not one. */
export function parseAction(raw: string): WebAction | { error: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "That was not a JSON action." };
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { error: "That JSON could not be read." };
  }
  const parsed = Action.safeParse(value);
  return parsed.success ? parsed.data : { error: `That action is not valid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}.` };
}

const Input = z
  .object({
    goal: z.string().trim().min(3).max(1500).describe("What to find or do, as your owner asked it, and what done looks like."),
    url: z.string().min(1).max(4000).optional().describe("Where to start. Omit it to go on in `tab`."),
    tab: z.string().regex(/^t\d{1,9}$/, "a tab id such as t1").optional().describe("A tab already open (from browser_open, browser_view or an earlier web_task)."),
    maxSteps: z.number().int().min(1).max(MAX_WEB_STEPS).default(MAX_WEB_STEPS),
    computer: z.string().max(120).optional().describe("The computer's name, when your owner has more than one."),
  })
  .strict();

type Step = { action: string; result: string };
type Outcome = { status: WebTaskStatus; answer: string; waiting?: boolean };

/** The node's model for its sub-agent: its own chat model, else the fast one (an AI plan on a computer is too slow for it). */
async function webModel(scope: NodeScope): Promise<ChatModel> {
  const settings = await loadSettings(scope.prisma, scope.node.userId);
  const own = chatModelFor(scope.node, settings);
  if (!("error" in own) && !isSubscriptionProvider(own.provider)) return own;
  const fast = fastChatModel(settings);
  if (!fast || isSubscriptionProvider(fast.provider)) throw new ToolBlockedError("web_task needs a chat model this server can call, and this node has none.", "Use the browser tools one by one instead.");
  return fast;
}

const keyOf = (data: unknown, key: string): unknown => (data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined);

export function webTaskTool(scope: NodeScope): AnyHubTool {
  return defineTool({
    name: "web_task",
    area: "tasks",
    description:
      "Do a multi-step task on a website in your owner's browser on their computer: a value behind clicks on a dashboard or console, a setting to read, a form to fill. " +
      "Give the goal (and url to start, or the tab). It reads the page, clicks and types step by step (at most 8 steps) and returns status (done, sign_in_needed, human_check, blocked, gave_up), the answer, the steps and any screenshots. " +
      "It never types passwords or codes: a sign-in goes to your owner on a card in this chat, and you go on (call it again with the same tab) when they are done. It never buys, pays, deletes or sends anything your owner did not ask for. " +
      "For a screenshot of a page use browser_view; for prices browser_shop; for facts hub_web_search.",
    input: Input,
    isWrite: false,
    risk: "medium",
    async run(ctx, input) {
      if (!scope.ownerOnly || scope.lineage.fromNonOwner) throw new ToolBlockedError("Your owner's computer is used only in a chat with just your owner, started by them.");
      if (!input.url && !input.tab) throw new ToolBlockedError("Give the url to start at, or the tab to go on in.");
      return runWebTask(ctx, scope, input);
    },
  });
}

async function runWebTask(ctx: ToolContext, scope: NodeScope, input: z.infer<typeof Input>): Promise<ToolResult> {
  const tools = new Map(captureTools(scope).map((tool) => [tool.name, tool]));
  const model = await webModel(scope);
  const ownerWords = scope.ownerWords ?? "";
  const steps: Step[] = [];
  const evidence: string[] = [];
  /** Inputs this computer's Ensemble does not take yet (an older version): not sent again. */
  const unsupported = new Set<string>();
  let tab = input.tab ?? null;
  let url = "";
  let title = "";
  let last = "";
  let calls = 0;

  type Called = { ok: true; summary: string; data: unknown } | { ok: false; error: string };
  const call = async (name: string, args: Record<string, unknown>, optional: readonly string[] = []): Promise<Called> => {
    const tool = tools.get(name);
    if (!tool) return { ok: false, error: `${name} is not available on this computer's Ensemble.` };
    const sent = Object.fromEntries(Object.entries(args).filter(([key, value]) => value !== undefined && !(optional.includes(key) && unsupported.has(`${name}.${key}`))));
    calls += 1;
    try {
      const done = await tool.run({ ...ctx, toolCallId: `${ctx.toolCallId ?? "web_task"}:${calls}` }, { ...sent, ...(input.computer ? { computer: input.computer } : {}) } as never);
      for (const item of (keyOf(done.data, "evidence") as Array<{ id?: unknown }> | undefined) ?? []) if (typeof item?.id === "string" && !evidence.includes(item.id)) evidence.push(item.id);
      const result = keyOf(done.data, "result");
      if (typeof keyOf(result, "tab") === "string") tab = keyOf(result, "tab") as string;
      if (typeof keyOf(result, "url") === "string") url = keyOf(result, "url") as string;
      if (typeof keyOf(result, "title") === "string") title = keyOf(result, "title") as string;
      return { ok: true, summary: done.summary, data: done.data };
    } catch (error) {
      const message = error instanceof ToolBlockedError ? [error.message, error.remedy].filter(Boolean).join(" ") : error instanceof Error ? error.message : String(error);
      // An older computer refuses an input it does not know: the same call again without it.
      const refused = optional.find((key) => key in sent && /unrecognized key/i.test(message) && message.includes(`'${key}'`));
      if (refused) {
        unsupported.add(`${name}.${refused}`);
        return call(name, args, optional);
      }
      return { ok: false, error: message };
    }
  };

  /** The owner has a card to answer (a sign-in, a permission): the turn parks after this call. */
  const waits = (done: Called) => done.ok && keyOf(done.data, "waitingForOwner") === true;
  /** The computer itself saw a sign-in page and the owner has its card. */
  const signingIn = (done: Called) => done.ok && Boolean(keyOf(done.data, "signIn"));
  const finish = (outcome: Outcome): ToolResult => {
    const data = { status: outcome.status, answer: outcome.answer, steps, evidence, ...(tab ? { tab } : {}), ...(url ? { url } : {}), ...(title ? { title } : {}), ...(outcome.waiting ? { waitingForOwner: true } : {}) };
    const lines = [
      `web_task ${outcome.status.replace(/_/g, " ")}: ${outcome.answer}`,
      evidence.length ? `${evidence.length === 1 ? "Its screenshot appears" : "Its screenshots appear"} with your reply by themselves.` : "",
      outcome.waiting ? "End your turn now without a reply: you continue when your owner answers the card." : "",
    ].filter(Boolean);
    return toolOk(lines.join("\n"), data);
  };
  const stopping = () => Boolean(scope.signal?.aborted) || parkedFor(scope.turnId).length > 0;

  /** Hands the tab to the owner on a card (a sign-in): the turn parks and wakes when it ends. */
  const askSignIn = async (why: string): Promise<Outcome> => {
    if (!tab) return { status: "sign_in_needed", answer: why };
    const asked = await call("browser_login_needed", { tab, reason: truncateText(`Sign in for: ${input.goal}`, 200), purpose: "sign_in" }, ["purpose"]);
    if (!asked.ok) return { status: "sign_in_needed", answer: `${why} Asking your owner failed: ${asked.error}` };
    return { status: "sign_in_needed", answer: `${why} Your owner is asked on a card in this chat to sign in; call web_task again with tab ${tab} when they are done.`, waiting: waits(asked) };
  };

  if (input.url) {
    const opened = await call("browser_open", { url: input.url, ...(tab ? { tab } : {}) });
    steps.push({ action: `goto ${input.url}`, result: truncateText(opened.ok ? opened.summary : opened.error, 200) });
    if (!opened.ok) return finish({ status: BLOCKED.test(opened.error) ? "blocked" : "gave_up", answer: `Could not open ${input.url}: ${opened.error}` });
    if (waits(opened)) return finish({ status: signingIn(opened) ? "sign_in_needed" : "blocked", answer: "Your owner has a card to answer first (in this chat).", waiting: true });
    if (BLOCKED.test(opened.summary)) return finish({ status: "blocked", answer: truncateText(opened.summary, 400) });
    last = opened.summary;
  }
  if (!tab) return finish({ status: "gave_up", answer: "No tab to work in." });

  for (let index = 0; index < input.maxSteps; index += 1) {
    if (stopping()) return finish({ status: "gave_up", answer: "Stopped before the task was done.", waiting: parkedFor(scope.turnId).length > 0 });
    const seen = await call("browser_snapshot", { tab, mode: "interactive", maxChars: PAGE_CHARS - 2_000 }, ["mode"]);
    if (!seen.ok) return finish({ status: BLOCKED.test(seen.error) ? "blocked" : "gave_up", answer: `Could not read the page: ${seen.error}` });
    if (waits(seen)) return finish({ status: signingIn(seen) ? "sign_in_needed" : "blocked", answer: "Your owner has a card to answer first (in this chat).", waiting: true });
    const page = truncateText(seen.summary, PAGE_CHARS);
    if (keyOf(keyOf(seen.data, "result"), "humanCheck") || humanCheckPage(page)) {
      return finish({ status: "human_check", answer: `The page shows a human check${title ? ` (${title})` : ""}. Your owner can pass it: browser_login_needed for tab ${tab} as a human check, if they want this site.` });
    }
    if (signInPage(url, page)) return finish(await askSignIn(`${title || url || "The site"} asks to sign in.`));

    const prompt = [
      `Goal: ${input.goal}`,
      `Step ${index + 1} of ${input.maxSteps}.`,
      steps.length ? `Done so far:\n${steps.map((step, at) => `${at + 1}. ${step.action} → ${step.result}`).join("\n")}` : "",
      last ? `Last result:\n${truncateText(last, last.length > RESULT_CHARS && steps.at(-1)?.action.startsWith("extract") ? EXTRACT_CHARS : RESULT_CHARS)}` : "",
      `Page now (${url || "this tab"}${title ? ` — ${title}` : ""}):\n${page}`,
    ].filter(Boolean).join("\n\n");
    const answer = await ask(ctx, scope, model, input.goal, [
      { role: "system", content: WEB_TASK_PROMPT },
      { role: "user", content: prompt },
    ]);
    if (answer === null) return finish({ status: "gave_up", answer: "The model did not answer." });
    const action = parseAction(answer);
    if ("error" in action) {
      steps.push({ action: "(no action)", result: action.error });
      last = `${action.error} Answer with one JSON object.`;
      continue;
    }
    if (action.action === "done") return finish({ status: "done", answer: action.answer });
    if (action.action === "stop") {
      if (/\b(?:sign|log)[ -]?in\b|password|credentials/i.test(action.reason)) return finish(await askSignIn(action.reason));
      if (/human check|captcha|robot/i.test(action.reason)) return finish({ status: "human_check", answer: `${action.reason} Your owner can pass it: browser_login_needed for tab ${tab} as a human check, if they want this site.` });
      return finish({ status: /block|denied|forbidden|refus/i.test(action.reason) ? "blocked" : "gave_up", answer: action.reason });
    }
    if (action.action === "type" && secretField(labelOf(page, action.ref))) {
      return finish(await askSignIn("The page asks for a password or a code, which only your owner types."));
    }
    if (action.action === "click") {
      const label = labelOf(page, action.ref);
      const risk = riskyClick(label, ownerWords);
      if (risk) return finish({ status: "blocked", answer: `Stopped before “${truncateText(/"([^"]+)"/.exec(label)?.[1] ?? label, 80)}”: that would ${risk}, and your owner's words do not ask for it. Ask them first.` });
    }

    const done =
      action.action === "click" ? await call("browser_click", { tab, ref: action.ref })
      : action.action === "type" ? await call("browser_type", { tab, ref: action.ref, text: action.text, submit: action.submit })
      : action.action === "press" ? await call("browser_press", { tab, key: action.key })
      : action.action === "goto" ? await call("browser_open", { url: action.url, tab })
      : action.action === "scroll" ? await call("browser_press", { tab, key: action.direction === "up" ? "PageUp" : "PageDown" })
      : action.action === "wait" ? await call("browser_wait", { tab, ...(action.text ? { text: action.text } : {}), timeoutMs: action.ms ?? 3_000 })
      : action.action === "extract"
        ? tools.has("browser_extract")
          ? await call("browser_extract", { tab, focus: action.focus, maxChars: EXTRACT_CHARS - 2_000 }, ["focus"])
          : await call("browser_snapshot", { tab, maxChars: EXTRACT_CHARS * 2 })
        : await call("browser_screenshot", { tab, focus: action.focus }, ["focus"]);
    const described = `${action.action}${"ref" in action ? ` ${action.ref}` : ""}${"url" in action ? ` ${action.url}` : ""}${"key" in action ? ` ${action.key}` : ""}${"focus" in action && action.focus ? ` (${action.focus})` : ""}`;
    steps.push({ action: described, result: truncateText(done.ok ? done.summary.split("\n")[0]! : `failed: ${done.error}`, 200) });
    if (waits(done)) return finish({ status: signingIn(done) ? "sign_in_needed" : "blocked", answer: signingIn(done) ? "The site asks to sign in: your owner is asked on a card in this chat." : "Your owner has a card to answer first (in this chat).", waiting: true });
    // What browser_extract read is in its result; a snapshot's is in its summary.
    const markdown = keyOf(keyOf(done.ok ? done.data : null, "result"), "markdown");
    last = !done.ok ? `That did not work: ${done.error}` : typeof markdown === "string" ? markdown : done.summary;
  }
  return finish({ status: "gave_up", answer: `Not done after ${input.maxSteps} steps. Last: ${truncateText(last.split("\n")[0] ?? "", 300)}` });
}

/** One step's model call: the node's model at low thinking, metered like the turn's calls. Null when it fails. */
async function ask(ctx: ToolContext, scope: NodeScope, model: ChatModel, goal: string, messages: ModelMessage[]): Promise<string | null> {
  try {
    const turn = await askRuntimeStream({
      messages,
      model: model.model,
      provider: model.provider,
      reasoningEffort: "low",
      userId: scope.node.userId,
      activityId: `assistant:${ctx.conversationId ?? scope.turnId}`,
      chatTools: [],
      responsesTools: [],
      signal: scope.signal,
      timeoutMs: MODEL_TIMEOUT_MS,
      purpose: "Ensemble Node",
    });
    await recordMetric(scope.prisma, {
      userId: scope.node.userId,
      kind: "model.call",
      meta: { provider: model.provider, model: turn.model || model.model, purpose: "Ensemble Node", tokensIn: turn.tokensIn, tokensOut: turn.tokensOut, ...callCost(model.provider, turn.model || model.model, turn.tokensIn, turn.tokensOut, turn.credits), title: truncateText(`web_task: ${goal}`, 80) },
    }).catch(() => undefined);
    return turn.text;
  } catch {
    return null;
  }
}
