/**
 * Claude Code's own answers about this computer's sign-in, from one short `claude` started in the
 * Agent SDK's control mode with nothing to do (`--input-format stream-json`): `initialize` lists the
 * plan's models (each with its thinking levels and whether it has fast mode) and `get_usage` the
 * plan's usage windows (5-hour, weekly, per model). Claude Code reads its own sign-in to answer;
 * Ensemble never sees it. Protocol as in `@anthropic-ai/claude-agent-sdk`, and as T3 Code reads it
 * (`claudeUsageLimits.ts` in pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.).
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { ClaudeCodeListed, UsageWindow } from "@ensemble/shared-types";
import { agentEnv } from "./detect.js";

type Window = { utilization?: number | null; resets_at?: string | null } | null | undefined;

export type ClaudeRateLimits = {
  five_hour?: Window;
  seven_day?: Window;
  seven_day_opus?: Window;
  seven_day_sonnet?: Window;
  model_scoped?: Array<{ display_name?: string; utilization?: number | null; resets_at?: string | null }>;
  extra_usage?: { is_enabled?: boolean; utilization?: number | null } | null;
} | null;

export type ClaudeControl = {
  models: ClaudeCodeListed[];
  /** The plan Claude Code reports ("pro", "max", "team"), null for an API key or a cloud provider. */
  subscription: string | null;
  limits: UsageWindow[];
};

const HOURS_5 = 5 * 60;
const WEEK = 7 * 24 * 60;

/** The plan's usage windows as `get_usage` reports them, in the order the person reads them. */
export function claudeLimits(rateLimits: ClaudeRateLimits | undefined): UsageWindow[] {
  if (!rateLimits) return [];
  const out: UsageWindow[] = [];
  const add = (id: string, label: string, window: Window, minutes?: number) => {
    if (!window || typeof window.utilization !== "number" || !Number.isFinite(window.utilization)) return;
    const resetsAt = typeof window.resets_at === "string" && !Number.isNaN(Date.parse(window.resets_at)) ? new Date(window.resets_at).toISOString() : undefined;
    out.push({ id: id.slice(0, 40), label: label.slice(0, 60), usedPercent: Math.min(100, Math.max(0, window.utilization)), ...(minutes ? { minutes } : {}), ...(resetsAt ? { resetsAt } : {}) });
  };
  add("five_hour", "5-hour limit", rateLimits.five_hour, HOURS_5);
  add("seven_day", "Weekly limit", rateLimits.seven_day, WEEK);
  add("seven_day_opus", "Weekly Opus limit", rateLimits.seven_day_opus, WEEK);
  add("seven_day_sonnet", "Weekly Sonnet limit", rateLimits.seven_day_sonnet, WEEK);
  for (const row of rateLimits.model_scoped ?? []) {
    const name = (row.display_name ?? "").trim();
    if (name) add(`model:${name.toLowerCase()}`, `Weekly ${name} limit`, row, WEEK);
  }
  if (rateLimits.extra_usage?.is_enabled) add("extra_usage", "Extra usage this month", { utilization: rateLimits.extra_usage.utilization ?? null, resets_at: null });
  return out.slice(0, 6);
}

/** Asks Claude Code for its models and the plan's usage. Null when it does not answer in time. */
export function claudeControl(path: string, timeoutMs = 20_000): Promise<ClaudeControl | null> {
  return new Promise((resolve) => {
    let settled = false;
    let models: ClaudeCodeListed[] = [];
    const finish = (value: ClaudeControl | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(value);
    };
    // Only the person's own settings, and none of their MCP servers: nothing starts but Claude Code.
    const args = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence"];
    const child = spawn(path, args, { cwd: tmpdir(), env: agentEnv(), stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => finish(models.length ? { models, subscription: null, limits: [] } : null), timeoutMs);
    child.on("error", () => finish(null));
    child.once("close", () => finish(models.length ? { models, subscription: null, limits: [] } : null));
    child.stdin.on("error", () => undefined);
    const send = (value: unknown) => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(value)}\n`);
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: { type?: string; response?: { subtype?: string; request_id?: string; response?: Record<string, unknown> } };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type !== "control_response" || !message.response) return;
      const body = message.response.response ?? {};
      if (message.response.request_id === "ensemble-init") {
        models = Array.isArray(body.models) ? (body.models as ClaudeCodeListed[]) : [];
        send({ type: "control_request", request_id: "ensemble-usage", request: { subtype: "get_usage", skip_behaviors: true } });
      } else if (message.response.request_id === "ensemble-usage") {
        const usage = message.response.subtype === "success" ? body : {};
        const subscription = typeof usage.subscription_type === "string" && usage.subscription_type.trim() ? usage.subscription_type.trim().slice(0, 60) : null;
        finish({ models, subscription, limits: usage.rate_limits_available === true ? claudeLimits(usage.rate_limits as ClaudeRateLimits) : [] });
      }
    });
    send({ type: "control_request", request_id: "ensemble-init", request: { subtype: "initialize", hooks: null } });
  });
}
