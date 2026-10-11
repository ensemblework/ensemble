/** Types for scripts/ensemble-ask-mcp.mjs, the ask_person MCP tool for engine runs. */
export function questionInput(args: Record<string, unknown>): { questions: Array<{ question: string; multiSelect: boolean; options: Array<{ label: string }> }> };
export function answerText(input: { questions: Array<{ question: string }> }, verdict: { decision?: string; message?: string; updatedInput?: { answers?: Record<string, string> } } | null): string;
