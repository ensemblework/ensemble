export const DOCS_ONLY = "I can help with Ensemble's documentation, but I can't identify the model, write general-purpose code, or help with unrelated requests. Ask about an Ensemble feature or setup.";

/** Fast refusals do not retrieve passages or spend a model call. The prompt enforces the same scope. */
export function outsideDocs(question: string): boolean {
  const text = question.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").toLowerCase();
  const identity = /\byour\s+(?:ai\s+)?(?:model|llm|provider|system prompt|system instructions)\b/.test(text) ||
    /\b(?:what|which)\s+(?:ai\s+)?(?:model|llm|provider)\b.{0,60}\b(?:am i|are we|are you|speaking|talking)\b/.test(text) ||
    /\b(?:are you|you are|you're)\b.{0,30}\b(?:gpt|chatgpt|openai|azure|anthropic|gemini|claude)\b/.test(text) ||
    /\byou\b.{0,20}\b(?:powered by|based on|built by|running on)\b|\b(?:powers|built|created|made) you\b/.test(text) ||
    /\b(?:reveal|print|show)\b.{0,30}\b(?:system prompt|internal instructions)\b/.test(text);
  const override = /\b(?:ignore|override|forget|disregard)\b.{0,50}\b(?:instructions|rules|prompt|guardrails)\b|\b(?:pretend|roleplay)\b.{0,40}\b(?:unrestricted|developer|system|model)\b/.test(text);
  const programming = /\b(?:python|numpy|javascript|typescript|java|c\+\+|rust|bfs|dfs|graph traversal|matrix multiplication)\b/.test(text);
  const generateCode = /\b(?:write|code|implement|generate|give|provide|need|show|solve|debug)\b/.test(text) &&
    /\b(?:code|algorithm|function|program|script|bfs|dfs|matrix multiplication)\b/.test(text) &&
    (programming || /\b(?:write|implement|generate|provide|give)\b.{0,70}\b(?:code|algorithm|function|program|script)\b/.test(text));
  const algorithm = /\b(?:bfs|dfs|numpy|matrix multiplication|graph traversal)\b/.test(text);
  const productUsage = /^how\b/.test(text) && /\bensemble\b/.test(text) && !algorithm;
  const capability = /^can (?:the )?ensemble\b[^.!]*\??$/.test(text) && !algorithm && !/\b(?:give|show|provide|for me|write me)\b/.test(text);
  return identity || override || (generateCode && !productUsage && !capability);
}

export function unsafeAnswer(answer: string): boolean {
  return /https?:\/\/|github\.|—|--|```|\b(?:apps|packages|src|components|lib)\/|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs)\b/.test(answer) ||
    /\bgpt[- ]?5[- ]?mini\b/i.test(answer) ||
    /\b(?:I am|I'm|I’m|I use|I run|powered by|my provider|my model)\b.{0,60}\b(?:gpt|openai|azure|anthropic|gemini|claude)\b|\b(?:gpt|openai|azure|anthropic)\b.{0,30}\b(?:powers me|is my model|is my provider)\b/i.test(answer) ||
    /^(?:openai|azure|anthropic|gemini|claude)[.!]?$/i.test(answer.trim()) ||
    /(?:^|\n)\s*(?:def |import |from \w+ import|function |class |const |let |var )|=>|\bnp\.\w+\(|[{}]/.test(answer);
}
