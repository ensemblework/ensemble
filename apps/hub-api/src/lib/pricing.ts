/**
 * Published list prices, USD per 1 million tokens, [input, output].
 * A model that is not in this table has no dollar figure. Token counts still show.
 * These are estimates of the vendor's public price, not an invoice.
 */
const PER_MILLION: Record<string, [number, number]> = {
  "gpt-4.1-nano": [0.1, 0.4],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1": [2, 8],
  "gpt-4o-mini": [0.15, 0.6],
  "claude-3-5-haiku-latest": [0.8, 4],
  "claude-3-5-haiku-20241022": [0.8, 4],
  "gemini-3.5-flash-lite": [0.3, 2.5],
  "gemini-3.5-flash": [1.5, 9],
  "gemini-3-flash-preview": [0.5, 3],
  "gemini-3.1-flash-lite": [0.25, 1.5],
  "gemini-3.1-pro-preview": [2, 12],
  "gemini-2.5-flash": [0.15, 0.6],
  "gemini-2.5-pro": [1.25, 10],
  "mistral-small-latest": [0.1, 0.3],
  "moonshot-v1-8k": [0.2, 2],
  "qwen-turbo": [0.05, 0.2],
  "qwen-flash": [0.05, 0.4],
};

/** Vendor id for a model name, when the call did not record one. */
export function providerFor(model: string | null | undefined, given?: string | null): string {
  if (given && given !== "unknown") return given;
  const name = (model ?? "").toLowerCase();
  if (name.startsWith("gemini")) return "google";
  if (name.startsWith("gpt") || /^o[134](?:-|$)/.test(name)) return "openai";
  if (name.startsWith("claude")) return "anthropic";
  if (name.startsWith("mistral")) return "mistral";
  if (name.startsWith("qwen")) return "qwen";
  if (name.startsWith("moonshot")) return "moonshot";
  return "unknown";
}

export function estimateUsd(model: string, tokensIn: number | null, tokensOut: number | null): number | null {
  const rate = PER_MILLION[model];
  if (!rate || (tokensIn == null && tokensOut == null)) return null;
  return ((tokensIn ?? 0) * rate[0] + (tokensOut ?? 0) * rate[1]) / 1_000_000;
}
