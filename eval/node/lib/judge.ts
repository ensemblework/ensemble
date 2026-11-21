/**
 * The rubric judge: one call to the Copilot CLI on the judge model, with no tools, the prompt on
 * stdin, under a session id the ledger records before the call starts. It answers with a JSON
 * object {score, reason}; the score is clamped to 0..1 and any failure scores 0. The session is
 * deleted as soon as the verdict is read.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deleteSessions, type SessionLedger } from "./sessions.js";
import type { CleanupEntry, Verdict } from "./types.js";

const JUDGE_MS = 180_000;

export const JUDGE_INSTRUCTIONS = 'You grade an AI assistant\'s work against a rubric. Use only what is written below; do not look anything up. Reply with only a JSON object: {"score": number between 0 and 1, "reason": "one sentence"}.';

export function judgePrompt(task: string, rubric: string, answer: string): string {
  return `${JUDGE_INSTRUCTIONS}\n\nWhat the owner asked:\n${task.slice(0, 4000)}\n\nRubric:\n${rubric}\n\nThe assistant's answer:\n${answer.trim().slice(0, 8000) || "(no answer)"}`;
}

/** The verdict in a judge's reply: the JSON object it wrote, clamped; a reply without one scores 0. */
export function parseVerdict(text: string): Verdict {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { score: 0, reason: `judge failed: no JSON in its reply (${text.slice(0, 80)})`, ok: false };
  try {
    const json = JSON.parse(text.slice(start, end + 1)) as { score?: unknown; reason?: unknown };
    const score = Number(json.score);
    if (!Number.isFinite(score)) return { score: 0, reason: "judge failed: no score", ok: false };
    return { score: Math.max(0, Math.min(1, score)), reason: String(json.reason ?? "").slice(0, 300), ok: true };
  } catch (error) {
    return { score: 0, reason: `judge failed: ${error instanceof Error ? error.message : String(error)}`, ok: false };
  }
}

export type JudgeCall = { verdict: Verdict; session: string; tokensIn: number | null; tokensOut: number | null; model: string | null };

export function makeJudge(options: { model: string; ledger: SessionLedger; root: string; log: (line: string) => void; cleanup: CleanupEntry[] }) {
  return async function judge(task: string | null, asked: string, rubric: string, answer: string): Promise<JudgeCall> {
    const { copilotArgs } = await import("../../../apps/hub-api/src/subscriptions/agents.js");
    const { copilotBinary, copilotEnv } = await import("../../../apps/hub-api/src/subscriptions/copilot.js");
    const { copilotOutput } = await import("../../../apps/hub-api/src/subscriptions/copilot-output.js");
    const id = randomUUID();
    const folder = join(options.root, "judge", id);
    mkdirSync(folder, { recursive: true });
    options.ledger.record({ agent: "copilot-cli", id, kind: "judge", task, folder });
    const call: JudgeCall = { verdict: { score: 0, reason: "judge failed: not run", ok: false }, session: id, tokensIn: null, tokensOut: null, model: null };
    try {
      const bin = await copilotBinary();
      if (!bin) throw new Error("GitHub Copilot CLI is not on this computer");
      const mcpFile = join(folder, "mcp.json");
      writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }));
      const usageFile = join(folder, "usage.json");
      const args = copilotArgs({ prompt: "", mcpFile, model: options.model, effort: null, sessionId: id, web: false, stdin: true, usageFile });
      const output = copilotOutput(options.model, () => undefined);
      const child = spawn(bin, args, { cwd: folder, env: copilotEnv({}), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stderr = "";
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let at = buffer.indexOf("\n");
        while (at >= 0) {
          output.line(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
          at = buffer.indexOf("\n");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => void (stderr = (stderr + chunk.toString("utf8")).slice(-2000)));
      child.stdin.on("error", () => undefined);
      child.stdin.end(judgePrompt(asked, rubric, answer), "utf8");
      const timer = setTimeout(() => child.kill("SIGKILL"), JUDGE_MS);
      const code = await new Promise<number>((done) => child.once("close", (value) => done(value ?? 1)));
      clearTimeout(timer);
      if (buffer) output.line(buffer);
      const { readFile } = await import("node:fs/promises");
      output.usageFile(await readFile(usageFile, "utf8").catch(() => null));
      const result = output.finish();
      call.tokensIn = result.tokensIn;
      call.tokensOut = result.tokensOut;
      call.model = result.model;
      call.verdict = code === 0 ? parseVerdict(result.text) : { score: 0, reason: `judge failed: exit ${code} ${stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? ""}`, ok: false };
    } catch (error) {
      call.verdict = { score: 0, reason: `judge failed: ${error instanceof Error ? error.message : String(error)}`, ok: false };
    } finally {
      options.cleanup.push(...(await deleteSessions(options.ledger, options.ledger.entries().filter((row) => row.id === id), options.log)));
      rmSync(folder, { recursive: true, force: true });
    }
    return call;
  };
}
