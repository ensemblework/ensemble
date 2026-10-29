/** Types for scripts/ensemble-ask-mcp.mjs, the ask_person MCP tool for engine runs. */
export function questionInput(args: Record<string, unknown>): { questions: Array<{ question: string; multiSelect: boolean; options: Array<{ label: string }> }> };
export function answerText(input: { questions: Array<{ question: string }> }, verdict: { decision?: string; message?: string; updatedInput?: { answers?: Record<string, string> } } | null): string;
/** The tools this server lists: ask_person, plus the person's board (`ensemble_*`) when ENSEMBLE_CHAT=1, else report_result and attach_evidence. */
export function toolsFor(env?: Record<string, string | undefined>): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
export const HEARTBEAT_MS: number;
/** MCP progress notifications for a waiting call, when it carries a progress token; returns the stop function. */
export function heartbeat(message: { params?: { _meta?: { progressToken?: unknown } } }, write?: (message: never) => void, every?: number): () => void;
