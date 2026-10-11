/** Types for scripts/ensemble-hook.mjs, which runs under plain Node in each tool's hook. */
export type HookResult = { decision?: "allow" | "deny" | null; reason?: string | null; note?: string };
export type HookTarget = "cursor" | "claude" | "codex" | "copilot-cli" | "vscode";

export const API_SOURCE: Record<string, string>;
export function output(source: string, event: string, result: HookResult): Record<string, unknown> | null;
export function normalizePayload(payload: Record<string, unknown>): Record<string, any>;
export function questionCards(payload: Record<string, unknown>): Array<{ question: string; payload: Record<string, any> }>;
export function answeredInput(payload: Record<string, unknown>, answers: Record<string, string>): Record<string, any>;
export function hookFile(target: string, options?: { home?: string; project?: string; cwd?: string }): string;
export const ACTIVITY_EVENTS: Set<string>;
export const HOOK_EVENTS: Record<string, { ask: string[]; report: string[] }>;
export function lastAssistantText(text: string): string | null;
export function questionOutput(event: string, updatedInput: Record<string, unknown>): Record<string, any>;
export function withHooks(target: string, file: Record<string, any>, remove: boolean, hookCommand: (source: string) => string, wait?: number): Record<string, any>;
export function engineOutput(verdict: { decision?: string; message?: string; updatedInput?: Record<string, unknown> } | null): Record<string, any>;
