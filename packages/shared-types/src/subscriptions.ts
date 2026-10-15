/**
 * The person's own AI subscriptions (Claude, ChatGPT, Cursor, GitHub Copilot) as model providers.
 * Each runs as that vendor's own agent on the person's paired computer, signed in with the vendor's
 * own sign-in: Claude Code (the CLI, or the copy the Claude app ships), Codex (the CLI, or the copy
 * the ChatGPT app ships), Cursor's agent, Copilot CLI. Ensemble never holds their credentials.
 * docs/30 §8.
 */
import { z } from "zod";

export const SUBSCRIPTION_PROVIDERS = ["claude-code", "codex", "cursor-agent", "copilot-cli"] as const;
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
};

export const SubscriptionModel = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
  isDefault: z.boolean().optional(),
  /** Thinking levels the agent takes for this model, when it says. */
  efforts: z.array(z.string().max(20)).max(10).optional(),
  description: z.string().max(240).optional(),
});
export type SubscriptionModel = z.infer<typeof SubscriptionModel>;

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
  models: z.array(SubscriptionModel).max(120),
  /** Whether a model name not in the list may be typed. */
  typedModels: z.boolean().optional(),
  /** Thinking levels the tool takes (Claude Code's --effort), when not per model. */
  efforts: z.array(z.string().max(20)).max(10).optional(),
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

/** Claude Code's model names: the aliases follow the newest model of each family. */
export const CLAUDE_CODE_MODELS: SubscriptionModel[] = [
  { id: "default", label: "Your plan's default", isDefault: true, description: "The model Claude Code picks for your plan." },
  { id: "haiku", label: "Haiku (latest)", description: "Fastest and lightest on your plan's limits." },
  { id: "sonnet", label: "Sonnet (latest)", description: "Strong everyday model." },
  { id: "opus", label: "Opus (latest)", description: "Most capable. Uses your limits fastest." },
];

/** The computer-side protocol for assistant turns (capabilities `assistantTurns`). */
export const ASSISTANT_TURNS_API = 1;
