/**
 * What each included call really costs the operator, in USD. Azure bills Global Standard
 * deployments per token at these rates. Checked 17 Oct 2026 against the Azure Retail Prices API
 * (eastus2, Global Standard meters) and xAI's and OpenAI's model pages for the long-prompt rules.
 * Recheck when Azure changes a rate; a wrong rate here makes the $200 ceiling wrong.
 */
import { CREDITS_PER_USD } from "./config.js";

/** USD per 1M tokens. A request whose input passes `over` tokens pays the `long` rates for all of it. */
type Rates = { input: number; cacheRead: number; cacheWrite: number; output: number };
type Price = { base: Rates; long?: { over: number; rates: Rates } };

export const INCLUDED_PRICES: Record<string, Price> = {
  "gpt-6-luna": {
    base: { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
    long: { over: 272_000, rates: { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 0.75 } },
  },
  // Azure lists no cache-write meter for DeepSeek: a write costs what new input costs.
  "deepseek-v4-flash": { base: { input: 0.19, cacheRead: 0.028, cacheWrite: 0.19, output: 0.51 } },
  "gpt-6.1-sol": {
    base: { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
    long: { over: 272_000, rates: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 15 } },
  },
  // OpenAI's list price; Azure's priority-processing meters are exactly 1.8 times these.
  "gpt-5-mini": { base: { input: 0.25, cacheRead: 0.025, cacheWrite: 0.25, output: 2 } },
  "gpt-4.1-mini": { base: { input: 0.4, cacheRead: 0.1, cacheWrite: 0.4, output: 1.6 } },
  // xAI: the higher rates apply from 200,000 prompt tokens; Azure's "L" meters match them.
  "grok-4.7": {
    base: { input: 2, cacheRead: 0.5, cacheWrite: 2, output: 6 },
    long: { over: 199_999, rates: { input: 4, cacheRead: 1, cacheWrite: 4, output: 12 } },
  },
};

/**
 * What one call of the hosted web search tool (Responses `tools: [{ type: "web_search" }]`) costs on
 * top of its tokens: Azure bills $10 per 1,000 web search calls (checked 31 Oct 2026); the pages it
 * reads are input tokens of the call at the model's rates. A built-in tool's fee counts with the
 * call's output in the ledger.
 */
export const WEB_SEARCH_CALL_USD = 0.01;

/**
 * Tokens of one call. `inputTokens` is every input token, including the ones read from or written
 * to the prompt cache (Anthropic reports those separately; each runtime adds them up).
 */
export type IncludedTokens = { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number };

export type IncludedCost = { usd: number; inputUsd: number; outputUsd: number };

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function includedCost(model: string, tokens: IncludedTokens): IncludedCost {
  const price = INCLUDED_PRICES[model];
  if (!price) throw new Error(`No price for included model ${model}.`);
  const input = count(tokens.inputTokens);
  const read = Math.min(count(tokens.cacheReadTokens), input);
  const write = Math.min(count(tokens.cacheWriteTokens), input - read);
  const rates = price.long && input > price.long.over ? price.long.rates : price.base;
  const inputUsd = ((input - read - write) * rates.input + read * rates.cacheRead + write * rates.cacheWrite) / 1_000_000;
  const outputUsd = (count(tokens.outputTokens) * rates.output) / 1_000_000;
  return { usd: inputUsd + outputUsd, inputUsd, outputUsd };
}

/** The most a call can cost before it runs: every input token uncached, and the full reply cap. */
export function worstCaseUsd(model: string, inputTokens: number, maxOutputTokens: number): number {
  return includedCost(model, { inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: maxOutputTokens }).usd;
}

export function toCredits(usd: number): number {
  return usd * CREDITS_PER_USD;
}

export function toUsd(credits: number): number {
  return credits / CREDITS_PER_USD;
}
