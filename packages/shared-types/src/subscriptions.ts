/**
 * The person's own AI subscriptions as model providers and coding agents. Each runs as that
 * vendor's own agent on the person's paired computer, signed in with the vendor's own sign-in:
 * Claude Code (the CLI, or the copy the Claude app ships), Codex (the CLI, or the copy the ChatGPT
 * app ships), Cursor's agent, Copilot CLI, Grok Build, OpenCode, Gemini CLI and Google Antigravity.
 * Ensemble never holds their credentials. docs/30.
 */
import { z } from "zod";

export const SUBSCRIPTION_PROVIDERS = ["claude-code", "codex", "cursor-agent", "copilot-cli", "grok-cli", "opencode", "gemini-cli", "antigravity"] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

export function isSubscriptionProvider(provider: string | null | undefined): provider is SubscriptionProvider {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(provider ?? "");
}

export type SubscriptionInfo = {
  /** What people call the subscription. */
  label: string;
  /** The plan it runs on. */
  plan: string;
  /** The program that does the work, in the app or as the command-line tool. */
  program: string;
  /** Where the person gets it, when the computer has neither the app nor the tool. */
  install: { label: string; url: string };
};

export const SUBSCRIPTION_INFO: Record<SubscriptionProvider, SubscriptionInfo> = {
  "claude-code": {
    label: "Claude",
    plan: "Claude Pro, Max, Team or Enterprise",
    program: "Claude Code, from the Claude app or the claude command",
    install: { label: "Get the Claude app", url: "https://claude.ai/download" },
  },
  codex: {
    label: "ChatGPT",
    plan: "ChatGPT Plus, Pro, Business or Enterprise",
    program: "Codex, from the ChatGPT app or the codex command",
    install: { label: "Get the ChatGPT app", url: "https://openai.com/chatgpt/download/" },
  },
  "cursor-agent": {
    label: "Cursor",
    plan: "a Cursor plan",
    program: "Cursor's agent (the cursor-agent command)",
    install: { label: "Install Cursor's agent", url: "https://cursor.com/cli" },
  },
  "copilot-cli": {
    label: "GitHub Copilot",
    plan: "a Copilot plan",
    program: "GitHub Copilot CLI (the copilot command)",
    install: { label: "Install Copilot CLI", url: "https://github.com/features/copilot/cli" },
  },
  "grok-cli": {
    label: "Grok",
    plan: "SuperGrok or an X Premium plan",
    program: "Grok Build (the grok command)",
    install: { label: "Install Grok Build", url: "https://x.ai/cli" },
  },
  opencode: {
    label: "OpenCode",
    plan: "the providers you signed in to in OpenCode (Zen, Claude, ChatGPT, Copilot…)",
    program: "OpenCode (the opencode command)",
    install: { label: "Install OpenCode", url: "https://opencode.ai/download" },
  },
  "gemini-cli": {
    label: "Gemini",
    plan: "your Google account (Gemini Code Assist or Google AI plan)",
    program: "Gemini CLI (the gemini command)",
    install: { label: "Install Gemini CLI", url: "https://github.com/google-gemini/gemini-cli" },
  },
  antigravity: {
    label: "Antigravity",
    plan: "your Google account (Google Antigravity)",
    program: "Google Antigravity's agent server, which Ensemble installs",
    install: { label: "Install with Sign in", url: "https://antigravity.google" },
  },
};

/**
 * The coding agents that can do a code task on the person's computer (docs/30 §1–§4), each with
 * their own sign-in. Ensemble's own agent is "ensemble" and is not listed here.
 */
export const CODE_ENGINES = ["claude-code", "codex", "cursor-agent", "copilot-cli", "grok-cli", "opencode", "gemini-cli", "antigravity"] as const;
export type CodeEngine = (typeof CODE_ENGINES)[number];
export const ENGINE_LABELS: Record<CodeEngine, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "cursor-agent": "Cursor",
  "copilot-cli": "GitHub Copilot",
  "grok-cli": "Grok Build",
  opencode: "OpenCode",
  "gemini-cli": "Gemini CLI",
  antigravity: "Antigravity",
};
/** The agents driven through ACP, the Agent Client Protocol, by one shared runner (docs/30 §3.3). */
export const ACP_ENGINES = ["grok-cli", "opencode", "gemini-cli", "antigravity"] as const;
export type AcpEngine = (typeof ACP_ENGINES)[number];
export function isAcpEngine(value: string | null | undefined): value is AcpEngine {
  return (ACP_ENGINES as readonly string[]).includes(value ?? "");
}

export function isCodeEngine(value: string | null | undefined): value is CodeEngine {
  return (CODE_ENGINES as readonly string[]).includes(value ?? "");
}

/** A context window a model offers: Copilot's `default` and `long_context` tiers, with their size when the agent says. */
export const ContextTier = z.enum(["default", "long_context"]);
export type ContextTier = z.infer<typeof ContextTier>;

export const ModelContext = z.object({
  id: ContextTier,
  label: z.string().min(1).max(60),
  /** Prompt tokens the tier allows. */
  tokens: z.number().int().positive().max(100_000_000).optional(),
});
export type ModelContext = z.infer<typeof ModelContext>;

export const SubscriptionModel = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
  /** Other names the agent takes for the same model (Claude Code's `opus` for the newest Opus). */
  aliases: z.array(z.string().min(1).max(60)).max(8).optional(),
  isDefault: z.boolean().optional(),
  /** Thinking levels the agent takes for this model, when it says. */
  efforts: z.array(z.string().max(20)).max(10).optional(),
  /** The level the model uses when none is chosen. */
  defaultEffort: z.string().max(20).optional(),
  /** Context windows to pick from, smallest first. One entry: the model has a single size. */
  contexts: z.array(ModelContext).max(4).optional(),
  /** Whether the model takes images. */
  vision: z.boolean().optional(),
  /** What a request costs on the plan, as the vendor puts it ("1× premium requests"). */
  cost: z.string().max(60).optional(),
  /**
   * The model has a fast mode (faster output, more of the plan's usage): Claude Code's `fastMode`
   * ("on"), or the Codex service tier that runs it ("priority").
   */
  fast: z.string().min(1).max(40).optional(),
  description: z.string().max(240).optional(),
});
export type SubscriptionModel = z.infer<typeof SubscriptionModel>;

/** One of the plan's usage windows as the agent reports it (Codex's 5-hour and weekly limits). */
export const UsageWindow = z.object({
  id: z.string().min(1).max(40),
  /** "5-hour limit", "Weekly limit", "Monthly limit". */
  label: z.string().min(1).max(60),
  usedPercent: z.number().min(0).max(100),
  /** When the window starts over (ISO time). */
  resetsAt: z.string().max(40).optional(),
  minutes: z.number().int().positive().max(100_000).optional(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

/** One agent as a paired computer found it (device capabilities `agents`). */
export const SubscriptionAgent = z.object({
  id: z.enum(SUBSCRIPTION_PROVIDERS),
  /** "app": the copy inside the vendor's desktop app. "cli": the command-line tool. */
  via: z.enum(["app", "cli"]),
  version: z.string().max(80).nullable(),
  /** Null when the tool cannot say before it runs. */
  signedIn: z.boolean().nullable(),
  /** The plan the tool reports (e.g. "max", "plus"), when it reports one. */
  plan: z.string().max(60).nullable().optional(),
  /** The account the tool is signed in with, as it reports it (Copilot's GitHub login). */
  account: z.string().max(120).nullable().optional(),
  models: z.array(SubscriptionModel).max(120),
  /** Whether a model name not in the list may be typed. */
  typedModels: z.boolean().optional(),
  /** Thinking levels the tool takes (Claude Code's --effort), when not per model. */
  efforts: z.array(z.string().max(20)).max(10).optional(),
  /** How much of the plan's usage windows is used, when the agent reports it. */
  limits: z.array(UsageWindow).max(6).optional(),
  /** Why the check could not finish, in words for the person. */
  problem: z.string().max(300).nullable().optional(),
  checkedAt: z.string().max(40),
});
export type SubscriptionAgent = z.infer<typeof SubscriptionAgent>;

/** Read a computer's `agents` capability; anything that does not parse is left out. */
export function parseSubscriptionAgents(value: unknown): SubscriptionAgent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const parsed = SubscriptionAgent.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The computer-side protocol for assistant turns (capabilities `assistantTurns`): 1 runs turns, 2 also takes the files attached to the person's message. */
export const ASSISTANT_TURNS_API = 2;
/** The oldest `assistantTurns` that runs assistant turns at all. */
export const ASSISTANT_TURNS_MIN = 1;
/** The first `assistantTurns` that takes the message's files; older computers get Ensemble's text of them in the message. */
export const ASSISTANT_TURN_FILES = 2;
