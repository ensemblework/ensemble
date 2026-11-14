export const DOCS_ONLY = "I can help with Ensemble's documentation, but I can't identify the model, write general-purpose code, or help with unrelated requests. Ask about an Ensemble feature or setup.";

/** Fast refusals do not retrieve passages or spend a model call. The prompt enforces the same scope. */
export function outsideDocs(question: string): boolean {
  const text = question.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").toLowerCase();
  const identity = /\b(?:your|you|youre|you're|i am|i'm|am i|are we)\b/.test(text) &&
    /\b(?:model|llm|provider|powered|gpt|chatgpt|openai|azure|anthropic|gemini|claude|system prompt|system instructions)\b/.test(text);
  const override = /\b(?:ignore|override|forget|disregard)\b.{0,50}\b(?:instructions|rules|prompt|guardrails)\b|\b(?:pretend|roleplay)\b.{0,40}\b(?:unrestricted|developer|system|model)\b/.test(text);
  const programming = /\b(?:python|numpy|javascript|typescript|java|c\+\+|rust|bfs|dfs|graph traversal|matrix multiplication)\b/.test(text);
  const generateCode = /\b(?:write|code|implement|generate|give|provide|need|show|solve|debug)\b/.test(text) &&
    /\b(?:code|algorithm|function|program|script|bfs|dfs|matrix multiplication)\b/.test(text) &&
    (programming || /\b(?:write|implement|generate|provide|give)\b.{0,70}\b(?:code|algorithm|function|program|script)\b/.test(text));
  const productUsage = /^how\b/.test(text) && /\bensemble\b/.test(text) && !programming;
  return identity || override || (generateCode && !productUsage);
}

export function unsafeAnswer(answer: string): boolean {
  return /https?:\/\/|github\.|—|--|```|\b(?:apps|packages|src|components|lib)\/|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs)\b/.test(answer) ||
    /\b(?:gpt[- ]?5[- ]?mini|openai|azure ai foundry)\b/i.test(answer) ||
    /(?:^|\n)\s*(?:def |import |from \w+ import|function |class |const |let |var )|=>|\bnp\.\w+\(|[{}]/.test(answer);
}
