"use client";

/**
 * A Code tab turn's states, each apart (hub-api workspace/completion.ts): the conversation, the files it
 * changed, the checks Ensemble ran again, whether the owner accepted the work, and its pull request;
 * and the line that marks a new agent session (a handoff or a fork). One short line each; the details
 * are in the ⓘ.
 */
import { ENGINE_LABELS, type CodeEngine } from "@ensemble/shared-types";
import { InfoTip, cx } from "@/components/ui";
import type { CodeTurn, TurnCompletion } from "@/lib/api";

type Part = { text: string; tone: "ok" | "warn" | "danger" | "muted"; href?: string };

const agentName = (agent: string) => ENGINE_LABELS[agent as CodeEngine] ?? agent;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The states as short parts, in order: conversation, files, checks, accepted, pull request. */
export function stateParts(completion: TurnCompletion): Part[] {
  const parts: Part[] = [];
  const conversation = completion.conversation.state;
  parts.push({ text: conversation === "finished" ? "Finished" : conversation === "failed" ? "Failed" : conversation === "interrupted" ? "Interrupted" : "Stopped", tone: conversation === "finished" ? "muted" : "danger" });
  parts.push(completion.files.state === "changed" ? { text: `${plural(completion.files.count, "file")} changed`, tone: "muted" } : { text: "No file changes", tone: "muted" });
  const checks = completion.checks;
  if (checks.state === "passed") parts.push({ text: `Checks passed (${checks.passed})`, tone: "ok" });
  else if (checks.state === "failed") parts.push({ text: `Checks failed (${checks.failed} of ${checks.claimed})`, tone: "danger" });
  else if (checks.state === "unverified") parts.push({ text: "Checks not confirmed", tone: "warn" });
  if (completion.accepted.state === "accepted") parts.push({ text: "Accepted", tone: "ok" });
  else if (completion.accepted.state === "rejected") parts.push({ text: "Discarded", tone: "muted" });
  else if (completion.files.state === "changed") parts.push({ text: "Not accepted yet", tone: "muted" });
  if (completion.pr.state !== "none") parts.push({ text: completion.pr.state === "merged" ? "PR merged" : "PR opened", tone: "ok", ...(completion.pr.url ? { href: completion.pr.url } : {}) });
  return parts;
}

/** What each check showed: what the agent said, and what Ensemble's own run showed. */
export function checkLines(completion: TurnCompletion): string[] {
  return completion.checks.runs.map((run) => {
    const ran = run.verdict === "pass" ? "passed" : run.verdict === "fail" ? "failed" : "was not run";
    return `${run.id ? `${run.id} ` : ""}${run.name}: the agent said ${run.claimed}; Ensemble's run ${ran}${run.reason ? `. ${run.reason}` : ""}`;
  });
}

const TONE: Record<Part["tone"], string> = { ok: "text-ok", warn: "text-warn", danger: "text-danger", muted: "text-muted" };

export function TurnStates({ completion }: { completion: TurnCompletion }) {
  const parts = stateParts(completion);
  const lines = checkLines(completion);
  const unrun = completion.checks.claimed - completion.checks.runs.length;
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px]" data-testid="agent-turn-states">
      {parts.map((part, index) => (
        <span key={part.text} className="inline-flex items-center gap-1.5">
          {index ? <span className="text-faint" aria-hidden>·</span> : null}
          {part.href ? (
            <a href={part.href} target="_blank" rel="noreferrer" className={cx("hover:underline", TONE[part.tone])}>{part.text}</a>
          ) : (
            <span className={TONE[part.tone]}>{part.text}</span>
          )}
        </span>
      ))}
      <InfoTip
        label="How this turn ended"
        text={
          <span className="flex flex-col gap-1.5">
            <span>Each state is its own: the agent finishing its turn, files changing, checks passing, you accepting the changes and a pull request are separate. Passing checks are not acceptance.</span>
            {lines.length ? <span>Ensemble ran each check the agent reported again, in this folder, after it finished:</span> : null}
            {lines.map((line) => <span key={line} className="font-mono text-[11.5px]">{line}</span>)}
            {unrun > 0 ? <span>{plural(unrun, "check")} came without a command to run again, so only the agent's word stands for {unrun === 1 ? "it" : "them"}.</span> : null}
          </span>
        }
      />
    </div>
  );
}

/** The line before a turn that started a new agent session from a handoff record of the one before. */
export function SessionStart({ turn }: { turn: Pick<CodeTurn, "handoff" | "packet" | "provider"> }) {
  const handoff = turn.handoff;
  if (!handoff && turn.packet?.operation !== "fork") return null;
  const to = agentName(turn.provider ?? "");
  const text =
    handoff?.reason === "fork" || (!handoff && turn.packet?.operation === "fork")
      ? `Forked: a new session with ${to}`
      : handoff?.reason === "session_gone"
        ? `New session with ${to}: the earlier one was gone`
        : `New session with ${to}, handed over from ${agentName(handoff?.from ?? "")}`;
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted" data-testid="agent-session-start">
      <span className="h-px flex-1 bg-[var(--line)]" aria-hidden />
      <span>{text}</span>
      <InfoTip
        label="About the new session"
        text={`A new agent session starts when you switch agent or subscription, fork a thread, or the agent no longer has its earlier session. Ensemble gave it a handoff record of the session before: what you asked, what worked and what failed, the checks, files and your decisions. It is a summary, not the whole conversation.${handoff ? ` The agent can read it again in .ensemble/handoff/${handoff.id}.md in the folder.` : ""}`}
      />
      <span className="h-px flex-1 bg-[var(--line)]" aria-hidden />
    </div>
  );
}
