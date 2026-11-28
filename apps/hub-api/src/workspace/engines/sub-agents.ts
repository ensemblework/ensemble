/**
 * What a session's sub-agents send on the session's own stream, told apart from the session's own work (#272).
 *
 * An agent can start sub-agents in the middle of a turn: Claude Code with its Agent tool, Codex with
 * `spawn_agent` (each sub-agent is a thread of its own), GitHub Copilot with its task tool. Their messages,
 * token counts and turn ends reach Ensemble on the connection it reads for the session. None of them is the
 * session's reply, and a sub-agent's turn ending does not end the session's. Their tool calls are real work in
 * the person's folder, so those stay in the run's trace, marked as a sub-agent's.
 */

/** How a sub-agent's tool call starts its summary in a run's trace and live log. */
export const SUB_AGENT = "Sub-agent: ";

/**
 * The `env` of the per-run settings (`--settings`) of a Claude Code run Ensemble starts with its own tools: agent
 * teams off. Claude Code applies the `env` of its settings over its environment, so a person's `~/.claude/settings.json`
 * that turns teams on would otherwise win; the per-run settings come above theirs.
 */
export const CLAUDE_SETTINGS_ENV = { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0" } as const;

/** How deep Claude Code's sub-agents may nest in a run Ensemble starts: Claude Code's documented default, which a remote flag of its own can otherwise change. */
export const CLAUDE_SUB_AGENT_DEPTH = 3;

/**
 * The environment of a Claude Code run Ensemble starts, with its limits on sub-agents (docs/30 §6). Sub-agents
 * nest at most `CLAUDE_SUB_AGENT_DEPTH` deep unless the person set a depth of their own. Agent teams, an
 * experimental Claude Code feature, stay off: with them on, a named sub-agent starts as a teammate, a session of
 * its own outside the one Ensemble owns.
 */
export function withClaudeSubAgentLimits(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const own = env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH?.trim();
  return { ...env, CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: own && /^\d+$/.test(own) ? own : String(CLAUDE_SUB_AGENT_DEPTH), CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0" };
}

/** Whether a Codex app-server notification is about another thread than the session's: a sub-agent's (`spawn_agent`). */
export function otherCodexThread(params: Record<string, unknown>, threadId: string | null): boolean {
  return threadId !== null && typeof params.threadId === "string" && params.threadId !== threadId;
}

/** The sub-agent a GitHub Copilot ACP `session/update` comes from (`_meta["github.com/copilot"].agentId`), or null for the session's own. */
export function copilotUpdateAgent(update: { _meta?: unknown }): string | null {
  const meta = update._meta;
  if (typeof meta !== "object" || meta === null) return null;
  const copilot = (meta as Record<string, unknown>)["github.com/copilot"];
  const id = typeof copilot === "object" && copilot !== null ? (copilot as { agentId?: unknown }).agentId : null;
  return typeof id === "string" && id ? id : null;
}

/** Whether a GitHub Copilot `--output-format json` event is a sub-agent's: its envelope names the agent, its data the task call. */
export function copilotEventFromSubAgent(event: { agentId?: unknown; data?: Record<string, unknown> }): boolean {
  if (typeof event.agentId === "string" && event.agentId) return true;
  return typeof event.data?.parentToolCallId === "string" && event.data.parentToolCallId !== "";
}

/** Whether a Claude Code stream-json message is a sub-agent's: it names the Agent tool call that started it. */
export function claudeFromSubAgent(message: Record<string, unknown>): boolean {
  return typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id !== "";
}

export type ClaudeSpend = { tokensIn: number; tokensOut: number; costUsd: number | null; perResult: boolean };

/**
 * A Claude Code run's tokens and cost, with one more `result` message added.
 *
 * A run whose background sub-agents finish after its answer goes on and answers again (`result_index`), so one
 * run can end with several results; the last one is the reply. `model_usage_since_last_result` (stream-json,
 * Claude Code 2.1.3xx) covers each stretch, its sub-agents included. `total_cost_usd` and `modelUsage` count
 * the whole session instead, including the earlier runs of a resumed one. Without the per-stretch field, each
 * result's own `usage` (the main agent's) is added and the cost is the session's total, as Claude Code gives it.
 */
export function addClaudeResult(spend: ClaudeSpend | null, message: Record<string, unknown>): ClaudeSpend {
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const stretch = message.model_usage_since_last_result;
  if (typeof stretch === "object" && stretch !== null && Object.keys(stretch).length) {
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;
    let priced = false;
    for (const row of Object.values(stretch as Record<string, unknown>)) {
      if (typeof row !== "object" || row === null) continue;
      const model = row as Record<string, unknown>;
      tokensIn += count(model.inputTokens) + count(model.cacheReadInputTokens) + count(model.cacheCreationInputTokens);
      tokensOut += count(model.outputTokens);
      if (typeof model.costUSD === "number" && Number.isFinite(model.costUSD)) {
        cost += model.costUSD;
        priced = true;
      }
    }
    const earlier = spend?.perResult ? spend.costUsd : null;
    return { tokensIn: (spend?.tokensIn ?? 0) + tokensIn, tokensOut: (spend?.tokensOut ?? 0) + tokensOut, costUsd: priced ? (earlier ?? 0) + cost : earlier, perResult: true };
  }
  const usage = (typeof message.usage === "object" && message.usage !== null ? message.usage : {}) as Record<string, unknown>;
  return {
    tokensIn: (spend?.tokensIn ?? 0) + count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens),
    tokensOut: (spend?.tokensOut ?? 0) + count(usage.output_tokens),
    costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : (spend?.costUsd ?? null),
    perResult: false,
  };
}
