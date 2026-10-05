"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useToast } from "@/components/toast";
import { SkeletonRows, Tag } from "@/components/ui";
import { api, type AgentDecisionRecord } from "@/lib/api";
import { deviceDecisionView } from "@/lib/device-copy";
import { relative, untilLabel } from "@/lib/format";

const SOURCE: Record<string, { label: string; tone: "blue" | "purple" | "orange" | "gray" }> = {
  cursor: { label: "Cursor", tone: "blue" },
  claude: { label: "Claude Code", tone: "orange" },
  copilot: { label: "VS Code Copilot", tone: "purple" },
  codex: { label: "Codex", tone: "gray" },
  ensemble: { label: "Ensemble agent", tone: "purple" },
};

/** A question or a commit/push approval from a task Ensemble itself is running. */
function EnsembleCard({ decision }: { decision: AgentDecisionRecord }) {
  const client = useQueryClient();
  const toast = useToast();
  const [answer, setAnswer] = useState("");
  const question = decision.event === "question";
  const decide = useMutation({
    mutationFn: (input: { decision: "allow" | "deny"; scope?: "once" | "session" | "always"; reason?: string }) =>
      api.decideAgent(decision.id, { decision: input.decision, scope: input.scope ?? "once", reason: input.reason }),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: ["decisions"] });
      const previous = client.getQueryData<{ decisions: AgentDecisionRecord[] }>(["decisions", "pending"]);
      const also = client.getQueryData<{ decisions: AgentDecisionRecord[] }>(["decisions"]);
      const strip = (rows: AgentDecisionRecord[] | undefined) => rows?.filter((row) => row.id !== decision.id);
      if (previous) client.setQueryData(["decisions", "pending"], { decisions: strip(previous.decisions) });
      if (also) client.setQueryData(["decisions"], { decisions: strip(also.decisions) });
      return { previous, also };
    },
    onSuccess: (_result, input) => {
      const allowed = input.decision === "allow";
      const scope = input.scope ?? "once";
      const permission = !allowed ? "Denied. The agent was told." : scope === "always" ? "Folder trusted. The agent continues." : scope === "session" ? "Allowed for this run." : "Allowed once.";
      toast(question ? (allowed ? "Answer sent. The agent continues." : "Skipped. The agent will choose and say what it chose.") : permission, { tone: "ok" });
      void client.invalidateQueries({ queryKey: ["workspace"] });
      void client.invalidateQueries({ queryKey: ["agent-state"] });
    },
    onError: (error, _vars, context) => {
      if (context?.previous) client.setQueryData(["decisions", "pending"], context.previous);
      if (context?.also) client.setQueryData(["decisions"], context.also);
      toast((error as Error).message, { tone: "error" });
    },
    onSettled: () => void client.invalidateQueries({ queryKey: ["decisions"] }),
  });
  const busy = decide.isPending;
  const push = decision.toolName === "git push";
  const outside = decision.toolName === "outside";
  return (
    <div className="tile rounded-lg bg-panel p-4" data-testid="ensemble-decision">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone="purple">Ensemble agent</Tag>
        <span className="text-[12px] text-muted">{question ? "has a question" : `wants to ${decision.toolName}`}</span>
        <span className="text-[12px] text-muted">· {relative(decision.requestedAt)}</span>
        {decision.detail.taskId ? (
          <Link href={`/tasks/${decision.detail.taskId}`} className="truncate text-[12px] text-accent hover:underline">
            {decision.detail.taskTitle ?? "Open task"}
          </Link>
        ) : null}
      </div>
      <div className="mt-1.5 text-[15px] font-semibold">{decision.title}</div>
      {!question && decision.detail.command ? (
        <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-raised p-2.5 font-mono text-[12.5px]">{decision.detail.command}</pre>
      ) : null}
      {!question && decision.cwd ? <div className="mt-1 truncate font-mono text-[12px] text-muted">{decision.cwd}</div> : null}
      {question ? (
        <>
          {decision.detail.options?.length ? (
            <div className="mt-3 grid gap-1.5">
              {decision.detail.options.map((option, index) => (
                <button key={option} type="button" className="btn justify-start text-left" disabled={busy} onClick={() => decide.mutate({ decision: "allow", reason: option })}>
                  <span className="w-4 shrink-0 font-mono text-[11px] text-faint">{String.fromCharCode(65 + index)}</span>
                  {option}
                </button>
              ))}
            </div>
          ) : null}
          {decision.detail.allowCustom !== false ? (
            <div className="mt-2 flex gap-2">
              <input
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && answer.trim() && decide.mutate({ decision: "allow", reason: answer.trim() })}
                placeholder="Or type your own answer"
                className="field min-w-0 flex-1"
              />
              <button type="button" className="btn-primary" disabled={busy || !answer.trim()} onClick={() => decide.mutate({ decision: "allow", reason: answer.trim() })}>
                Send
              </button>
            </div>
          ) : null}
          <button type="button" className="btn-ghost mt-2" disabled={busy} onClick={() => decide.mutate({ decision: "deny" })}>
            Skip — let the agent decide
          </button>
        </>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => decide.mutate({ decision: "allow", scope: "once" })}>
            <Check size={13} /> Allow once
          </button>
          {push ? null : (
            <button type="button" className="btn" disabled={busy} onClick={() => decide.mutate({ decision: "allow", scope: "session" })}>
              Allow for this run
            </button>
          )}
          {push || outside ? null : (
            <button
              type="button"
              className="btn"
              disabled={busy}
              title={decision.cwd ? `Trust ${decision.cwd} on this computer` : undefined}
              onClick={() => decide.mutate({ decision: "allow", scope: "always" })}
            >
              <ShieldCheck size={13} /> Always (trust folder)
            </button>
          )}
          <input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Reason if you deny (sent to the agent)" className="field min-w-0 flex-1" />
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => decide.mutate({ decision: "deny", scope: "once", reason: answer.trim() || undefined })}>
            <X size={13} /> Deny
          </button>
        </div>
      )}
    </div>
  );
}

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.round((new Date(until).getTime() - now) / 1000));
  return <span>{untilLabel(left)} left before it asks in the editor</span>;
}

/** A question the paired computer asked. Once only, and no note on a permission. */
function DeviceCard({ decision }: { decision: AgentDecisionRecord }) {
  const client = useQueryClient();
  const toast = useToast();
  const computer = decision.detail.deviceName || "your computer";
  const view = deviceDecisionView({
    tier: decision.detail.tier,
    event: decision.event,
    options: decision.detail.options,
    deviceName: decision.detail.deviceName,
  });
  const decide = useMutation({
    mutationFn: (input: { decision: "allow" | "deny"; reason?: string }) =>
      api.decideAgent(decision.id, { decision: input.decision, scope: view.scope, reason: input.reason }),
    onSuccess: (_result, input) => {
      toast(input.decision === "allow" ? `Sent to ${computer}.` : `Refused. ${computer} was told.`, { tone: "ok" });
      void client.invalidateQueries({ queryKey: ["decisions"] });
      void client.invalidateQueries({ queryKey: ["workspace"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const busy = decide.isPending;
  return (
    <div className="tile rounded-lg bg-panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone="purple">{computer}</Tag>
        <span className="text-[12px] text-muted">{decision.event === "question" ? "has a question" : decision.toolName}</span>
        <span className="text-[12px] text-muted">· {relative(decision.requestedAt)}</span>
      </div>
      <div className="mt-1.5 text-[15px] font-semibold">{decision.title}</div>
      {decision.detail.command ? <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-raised p-2.5 font-mono text-[12.5px]">{decision.detail.command}</pre> : null}
      {view.kind === "approve-on-computer" ? (
        <div className="mt-3 rounded-md border border-line bg-raised px-3 py-2 text-[13px] text-muted">{view.message}</div>
      ) : view.kind === "confirm" ? (
        <div className="mt-3 rounded-md border border-warn/40 bg-[var(--tag-yellow-bg)] px-3 py-2 text-[13px] text-[var(--tag-yellow-fg)]">{view.message}</div>
      ) : view.kind === "choices" ? (
        <div className="mt-3 grid gap-2">
          {view.options.map((option, index) => (
            <button
              key={`${index}-${option}`}
              type="button"
              className="btn min-h-[44px] w-full justify-start text-left"
              disabled={busy}
              onClick={() => decide.mutate({ decision: "allow", reason: option })}
            >
              {option}
            </button>
          ))}
          <button type="button" className="btn min-h-[44px] w-full justify-center" disabled={busy} onClick={() => decide.mutate({ decision: "deny" })}>
            <X size={15} /> No
          </button>
        </div>
      ) : (
        <div className="mt-3 grid gap-2">
          <button type="button" className="btn-primary min-h-[44px] w-full justify-center" disabled={busy} onClick={() => decide.mutate({ decision: "allow" })}>
            <Check size={15} /> Yes
          </button>
          <button type="button" className="btn min-h-[44px] w-full justify-center" disabled={busy} onClick={() => decide.mutate({ decision: "deny" })}>
            <X size={15} /> No
          </button>
        </div>
      )}
    </div>
  );
}

function DecisionCard({ decision }: { decision: AgentDecisionRecord }) {
  if (decision.source === "ensemble" && decision.detail.deviceId) return <DeviceCard decision={decision} />;
  if (decision.source === "ensemble") return <EnsembleCard decision={decision} />;
  return <EditorCard decision={decision} />;
}

function EditorCard({ decision }: { decision: AgentDecisionRecord }) {
  const client = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const source = SOURCE[decision.source] ?? { label: decision.source, tone: "gray" as const };
  const decide = useMutation({
    mutationFn: (input: { decision: "allow" | "deny"; scope: "once" | "session" | "always"; reason?: string }) =>
      api.decideAgent(decision.id, { decision: input.decision, scope: input.scope, reason: input.reason ?? (reason || undefined) }),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: ["decisions"] });
      const previous = client.getQueryData<{ decisions: AgentDecisionRecord[] }>(["decisions"]);
      if (previous) {
        client.setQueryData(["decisions"], { decisions: previous.decisions.filter((row) => row.id !== decision.id) });
      }
      return { previous };
    },
    onSuccess: (_result, input) => {
      toast(input.decision === "allow" ? `Sent “allow” back to ${source.label}.` : `Sent “deny” back to ${source.label}.`, { tone: "ok" });
      void client.invalidateQueries({ queryKey: ["decision-rules"] });
    },
    onError: (error, _vars, context) => {
      if (context?.previous) client.setQueryData(["decisions"], context.previous);
      toast((error as Error).message, { tone: "error" });
    },
    onSettled: () => void client.invalidateQueries({ queryKey: ["decisions"] }),
  });
  const input = decision.detail.input ?? {};
  const shown = decision.detail.command ?? (Object.keys(input).length ? JSON.stringify(input, null, 2) : null);
  const busy = decide.isPending;
  return (
    <div className="tile rounded-lg bg-panel p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Tag tone={source.tone}>{source.label}</Tag>
            <span className="font-mono text-[12px] text-muted">{decision.toolName}</span>
            <span className="text-[12px] text-muted">{relative(decision.requestedAt)}</span>
          </div>
          <div className="mt-1.5 text-[15px] font-semibold">{decision.title}</div>
          {decision.cwd ? <div className="mt-0.5 truncate font-mono text-[12px] text-muted">{decision.cwd}</div> : null}
        </div>
        <span className="shrink-0 text-[12px] text-faint">
          <Countdown until={decision.expiresAt} />
        </span>
      </div>
      {decision.detail.options?.length ? (
        <div className="mt-3 flex flex-col gap-1.5">
          {decision.detail.options.map((option) => (
            <button
              key={option}
              type="button"
              className="btn justify-start"
              disabled={busy}
              onClick={() => decide.mutate({ decision: "allow", scope: "once", reason: option })}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {shown ? (
        <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-raised p-3 font-mono text-[12.5px] leading-5">{shown}</pre>
      ) : null}
      <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason (optional — sent back to the agent on deny)" className="field mt-2 w-full" />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => decide.mutate({ decision: "allow", scope: "once" })}>
          <Check size={13} /> Allow once
        </button>
        <button type="button" className="btn" disabled={busy || !decision.sessionId} onClick={() => decide.mutate({ decision: "allow", scope: "session" })} title={decision.sessionId ? undefined : "This tool did not say which session asked."}>
          Allow for this session
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => decide.mutate({ decision: "allow", scope: "always" })}>
          <ShieldCheck size={13} /> Always allow {decision.detail.command ? "this command" : "this tool"}
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => decide.mutate({ decision: "deny", scope: "once" })}>
          <X size={13} /> Deny
        </button>
      </div>
    </div>
  );
}

export function EditorDecisions() {
  const pending = useQuery({ queryKey: ["decisions"], queryFn: () => api.decisions("pending"), refetchInterval: 30_000 });
  const all = pending.data?.decisions ?? [];
  const mine = all.filter((row) => row.source === "ensemble");
  const rows = all.filter((row) => row.source !== "ensemble");
  return (
    <>
    {mine.length ? (
      <section className="mb-10">
        <h2 className="mb-2 text-[15px] font-semibold">Your agent is asking ({mine.length})</h2>
        <div className="space-y-3">
          {mine.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} />
          ))}
        </div>
      </section>
    ) : null}
    <section className="mb-10">
      <h2 className="mb-2 flex items-center gap-2 text-[15px] font-semibold">
        From your editors{pending.data ? ` (${rows.length})` : ""}
        <Link href="/settings#editors" className="text-[12px] font-normal text-accent hover:underline">
          Set up Cursor, Claude Code or VS Code
        </Link>
      </h2>
      {pending.isLoading && !pending.data ? (
        <SkeletonRows count={2} />
      ) : rows.length === 0 ? (
        <div className="py-2 text-[13px] text-muted">No agent in another app is waiting on you. Their “Allow this?” prompts appear here live.</div>
      ) : (
        <div className="space-y-3">
          {rows.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} />
          ))}
        </div>
      )}
    </section>
    </>
  );
}
