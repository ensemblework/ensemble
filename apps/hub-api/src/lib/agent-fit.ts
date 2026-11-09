/**
 * Which coding agent can run which model, and whether an agent is there to run (docs/35, sessions). Pure:
 * node sessions (node/sessions.ts) and the assistant's hub_assign_to_agent (assistant/tools/agent-assign.ts)
 * both check a run with it before it is made, so GPT-6.1 Sol never goes to Claude Code, and a run never
 * goes to an agent that is not installed or not signed in.
 */
import { ENGINE_LABELS, isCodeEngine, type CodeEngine, type SubscriptionAgent } from "@ensemble/shared-types";

const agentName = (agent: string) => (isCodeEngine(agent) ? ENGINE_LABELS[agent] : agent === "ensemble" ? "Ensemble's agent" : agent);

/** A coding agent as people and models write it ("copilot", "GitHub Copilot", "claude", "Gemini CLI"), as its id. */
const ENGINE_WORDS: Array<[RegExp, CodeEngine]> = [
  [/^(github[\s-]*)?copilot([\s-]*cli)?$/, "copilot-cli"],
  [/^claude([\s-]*code)?$/, "claude-code"],
  [/^(openai[\s-]*)?codex([\s-]*cli)?$/, "codex"],
  [/^cursor([\s-]*(agent|cli))?$/, "cursor-agent"],
  [/^grok([\s-]*(build|cli))?$/, "grok-cli"],
  [/^open[\s-]*code$/, "opencode"],
  [/^gemini([\s-]*cli)?$/, "gemini-cli"],
  [/^(google[\s-]*)?antigravity$/, "antigravity"],
];

export function engineNamed(name: string | null | undefined): CodeEngine | undefined {
  const text = name?.trim().toLowerCase() ?? "";
  if (!text) return undefined;
  if (isCodeEngine(text)) return text;
  return ENGINE_WORDS.find(([pattern]) => pattern.test(text))?.[1];
}

/** The maker of a model, from its name, when the name says it; null for a name that says nothing ("default", "auto", "opus"[1m] counts). */
export function modelMaker(model: string | null | undefined): "Claude" | "OpenAI" | "Gemini" | "Grok" | null {
  const name = model?.trim().toLowerCase() ?? "";
  if (!name || name === "default" || name === "auto") return null;
  if (/claude|opus|sonnet|haiku|fable/.test(name)) return "Claude";
  if (/^(gpt|chatgpt|codex|o\d)\b|\bgpt-/.test(name)) return "OpenAI";
  if (/gemini/.test(name)) return "Gemini";
  if (/grok/.test(name)) return "Grok";
  return null;
}

/** Agents that run one maker's models only. GitHub Copilot, Cursor, OpenCode and Antigravity run several. */
const ONE_MAKER: Partial<Record<CodeEngine, "Claude" | "OpenAI" | "Gemini" | "Grok">> = { "claude-code": "Claude", codex: "OpenAI", "gemini-cli": "Gemini", "grok-cli": "Grok" };

/**
 * A model the agent cannot run: another maker's model in an agent that runs one maker's (GPT-6.1 Sol in
 * Claude Code). A model the computer lists for the agent is never refused here.
 */
export function makerProblem(engine: string, model: string | null | undefined, listing?: Pick<SubscriptionAgent, "models"> | null, others: readonly SubscriptionAgent[] = []): { message: string; remedy: string } | null {
  if (!isCodeEngine(engine) || !model?.trim()) return null;
  const wanted = model.trim().toLowerCase();
  const lists = (agent: Pick<SubscriptionAgent, "models"> | null | undefined) => (agent?.models ?? []).some((row) => [row.id, row.label, ...(row.aliases ?? [])].some((name) => name?.toLowerCase() === wanted));
  if (lists(listing)) return null;
  const maker = modelMaker(model), only = ONE_MAKER[engine];
  if (!maker || !only || maker === only) return null;
  const runs = others.filter((agent) => agent.id !== engine && agent.signedIn !== false && (lists(agent) || (isCodeEngine(agent.id) && (!ONE_MAKER[agent.id] || ONE_MAKER[agent.id] === maker)))).map((agent) => agentName(agent.id));
  return {
    message: `${ENGINE_LABELS[engine]} runs ${only} models only, and ${model} is a${maker === "OpenAI" ? "n" : ""} ${maker} model.`,
    remedy: runs.length ? `Run ${model} with ${runs.join(" or ")}, or give ${ENGINE_LABELS[engine]} one of its own models (or model: default).` : `Use an agent that runs ${maker} models, or give ${ENGINE_LABELS[engine]} one of its own models (or model: default).`,
  };
}

/**
 * An agent that is not there to run: not on the computer, or signed out of its account. A computer that
 * lists no agents at all (an older Ensemble) is not refused on a guess.
 */
export function readinessProblem(engine: string, computer: string | null, agents: readonly SubscriptionAgent[]): { message: string; remedy: string } | null {
  if (!isCodeEngine(engine) || !agents.length) return null;
  const where = computer ? ` on ${computer}` : "";
  const ready = agents.filter((agent) => agent.id !== engine && agent.signedIn !== false && isCodeEngine(agent.id)).map((agent) => agentName(agent.id));
  const instead = ready.length ? `Use ${ready.join(" or ")}, which ${ready.length > 1 ? "are" : "is"} signed in there, or ` : "Ask your owner to ";
  const row = agents.find((agent) => agent.id === engine);
  if (!row) return { message: `${ENGINE_LABELS[engine]} is not installed${where}.`, remedy: `${instead}${ready.length ? "ask your owner to install it" : `install ${ENGINE_LABELS[engine]} there`}.` };
  if (row.signedIn === false) return { message: `${ENGINE_LABELS[engine]} is not signed in${where}.`, remedy: `${instead}${ready.length ? "ask your owner to sign in to it" : `sign in to ${ENGINE_LABELS[engine]} there`}.` };
  return null;
}
