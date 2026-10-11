"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Bot, Check, CheckCheck, CircleHelp, Clock3, Lock, Pencil, ShieldCheck, X } from "lucide-react";
import { useSpaceAccess } from "@/lib/access";
import { useState } from "react";
import { EditorDecisions } from "@/components/needs-me/editor-decisions";
import { usePeek } from "@/components/shell/peek";
import { useToast } from "@/components/toast";
import { AskEnsemble } from "@/components/ensemble/ask-button";
import { Held } from "@/components/motion/held";
import { Empty, PageHeader, SkeletonRows } from "@/components/ui";
import { api, type ApprovalRecord } from "@/lib/api";
import { relative } from "@/lib/format";
import { useWarmEditors, warmTask } from "@/lib/warm";

const KIND_LABEL: Record<string, string> = {
  send_email: "Send email",
  open_pr: "Open pull request",
  post_teams: "Post to Teams",
  other: "External write",
};

function previewText(preview: unknown): string {
  if (typeof preview === "string") return preview;
  if (preview && typeof preview === "object") {
    const record = preview as Record<string, unknown>;
    const body = record.body ?? record.text ?? record.description ?? record.content;
    if (typeof body === "string") return body;
  }
  return JSON.stringify(preview, null, 2);
}

function ApprovalCard({ approval }: { approval: ApprovalRecord }) {
  const access = useSpaceAccess();
  const client = useQueryClient();
  const toast = useToast();
  const peek = usePeek();
  const [editing, setEditing] = useState(false);
  const original = previewText(approval.preview);
  const [draft, setDraft] = useState(original);
  const [reason, setReason] = useState("");
  const decide = useMutation({
    mutationFn: (decision: "approved" | "edited" | "rejected") =>
      api.decide(approval.id, {
        decision,
        editedPayload:
          decision === "edited"
            ? typeof approval.preview === "object" && approval.preview
              ? { ...(approval.preview as Record<string, unknown>), body: draft }
              : draft
            : undefined,
        reason: reason || undefined,
      }),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: ["approvals"] });
      const previous = client.getQueryData<{ approvals: ApprovalRecord[] }>(["approvals"]);
      if (previous) {
        client.setQueryData(["approvals"], { approvals: previous.approvals.filter((row) => row.id !== approval.id) });
      }
      return { previous };
    },
    onSuccess: (_result, decision) => {
      toast(decision === "rejected" ? "Rejected. The agent will not send it." : "Approved. The run continues with exactly this.");
    },
    onError: (error, _vars, context) => {
      if (context?.previous) client.setQueryData(["approvals"], context.previous);
      toast((error as Error).message, { tone: "error" });
    },
    onSettled: () => void client.invalidateQueries({ queryKey: ["approvals"] }),
  });
  const recipients = (approval.preview as { to?: string | string[] } | null)?.to;
  return (
    <div className="review-card items-start" data-motion-slot="needs.waiting" data-state="waiting">
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-[12px] uppercase tracking-[0.04em] text-muted">{KIND_LABEL[approval.kind] ?? approval.kind}</span>
            <span className="block text-[15px] font-medium">{approval.title}</span>
            <span className="mt-0.5 block text-[12px] text-muted">
              {relative(approval.requestedAt)}
              {recipients ? ` · To ${Array.isArray(recipients) ? recipients.join(", ") : recipients}` : ""}
            </span>
          </span>
          {approval.taskId ? (
            <button
              type="button"
              className="btn shrink-0"
              onMouseEnter={() => warmTask(client, approval.taskId!)}
              onFocus={() => warmTask(client, approval.taskId!)}
              onClick={() => peek.open(approval.taskId!)}
            >
              Open task
            </button>
          ) : null}
        </div>
      {editing ? (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Edited approval content"
          rows={10}
          className="field mt-3 w-full font-mono text-[12.5px] leading-5"
        />
      ) : (
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-raised p-3 text-[13px] leading-5">
          {original}
        </pre>
      )}
      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        aria-label="Reason for this decision"
        placeholder="Why? (optional, helps the skill learn)"
        className="field mt-2 w-full"
      />
      {access.guest ? (
        <div className="mt-3 flex items-center gap-1.5 text-[12px] text-faint">
          <Lock size={12} /> Only {access.owner?.split(" ")[0] ?? "the owner"} can approve this. It runs on their resources.
        </div>
      ) : (
      <div className="mt-3 flex items-center gap-2">
        {editing ? (
          <button type="button" className="btn-primary" onClick={() => decide.mutate("edited")} disabled={decide.isPending}>
            <Check size={13} /> Approve edited
          </button>
        ) : (
          <button type="button" className="btn-primary" data-motion-slot="action.approve" data-state={decide.isPending ? "pressed" : decide.isSuccess ? "approved" : "idle"} onClick={() => decide.mutate("approved")} disabled={decide.isPending}>
            <Check size={13} /> Approve
          </button>
        )}
        <button type="button" className="btn" onClick={() => setEditing(!editing)}>
          <Pencil size={13} /> {editing ? "Cancel edit" : "Edit"}
        </button>
        <button type="button" className="btn-ghost" onClick={() => decide.mutate("rejected")} disabled={decide.isPending}>
          <X size={13} /> Reject
        </button>
      </div>
      )}
      </div>
    </div>
  );
}

export default function NeedsMePage() {
  const client = useQueryClient();
  const approvals = useQuery({ queryKey: ["approvals"], queryFn: api.approvals });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks });
  const decisions = useQuery({ queryKey: ["decisions"], queryFn: () => api.decisions("pending"), refetchInterval: 30_000 });
  const peek = usePeek();
  const [view, setView] = useState<"all" | "requests" | "approvals" | "waiting">("all");
  useWarmEditors("peek");
  const blocked = (tasks.data?.tasks ?? []).filter((task) => task.status === "blocked" || task.status === "waiting_approval").sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  const pendingApprovals = approvals.data?.approvals ?? [];
  const requests = decisions.data?.decisions ?? [];
  const ready = approvals.isSuccess && tasks.isSuccess && decisions.isSuccess;
  const failed = approvals.isError || tasks.isError || decisions.isError;
  const clear = ready && !blocked.length && !pendingApprovals.length && !requests.length;
  return <div className="page-read review-page mx-auto max-w-[980px] px-6 pb-24 pt-8">
    <PageHeader title="Needs me" description="Decisions to make, questions to answer, and work ready for a next step." actions={<AskEnsemble surface="needs_me" anchorKey="needs_me" label="Ask Ensemble about needs me" />} />
    <div className="review-overview">
      {[{ id: "requests", label: "Agent & editor requests", n: requests.length, icon: Bot, tone: "violet", note: "Questions and permissions" }, { id: "approvals", label: "Outgoing approvals", n: pendingApprovals.length, icon: ShieldCheck, tone: "amber", note: "Review before anything is sent" }, { id: "waiting", label: "Waiting tasks", n: blocked.length, icon: Clock3, tone: "blue", note: "Find what will move work forward" }].map((item) => <button key={item.id} type="button" data-tone={item.tone} aria-pressed={view === item.id} onClick={() => setView(view === item.id ? "all" : item.id as typeof view)}><span className="review-overview-icon"><item.icon size={18} /></span><div><strong>{ready ? item.n : "—"}</strong><span>{item.label}</span><small>{item.note}</small></div><ArrowUpRight size={14} /></button>)}
    </div>
    <div className="work-view-tabs" aria-label="Review queues">{([ ["all", "Everything"], ["requests", "Requests"], ["approvals", "Approvals"], ["waiting", "Waiting tasks"] ] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}</div>
    {failed && <div className="work-load-error" role="alert">Some of your review queue could not load.<button className="btn" type="button" onClick={() => { void approvals.refetch(); void decisions.refetch(); void tasks.refetch(); }}>Try again</button></div>}
    {clear && view === "all" ? <div className="work-clear-state"><span><CheckCheck size={30} /></span><h2>You're clear to focus.</h2><p>No requests or waiting tasks need a next step right now.</p><a href="/board" className="btn">Back to the board<ArrowUpRight size={13} /></a></div> : <>
      {(view === "requests" || view === "all" && (requests.length > 0 || decisions.isPending)) && <div className="review-requests"><EditorDecisions hideEmpty={view === "all"} /></div>}
      {(view === "all" || view === "approvals") && <section className="review-section"><header><span><ShieldCheck size={16} />Outgoing approvals</span><small>{pendingApprovals.length}</small></header><p className="review-section-note">What you approve is exactly what happens. Review the content before sending.</p><Held pending={approvals.isPending} fallback={<SkeletonRows count={2} />}>{pendingApprovals.length ? <div className="space-y-3">{pendingApprovals.map((approval) => <ApprovalCard key={approval.id} approval={approval} />)}</div> : !approvals.isError && <div className="work-quiet-state"><Check size={15} />Nothing waiting on your approval.</div>}</Held></section>}
      {(view === "all" || view === "waiting") && <section className="review-section"><header><span><CircleHelp size={16} />Waiting for a next step</span><small>{blocked.length}</small></header>{tasks.isPending ? <SkeletonRows count={2} /> : blocked.length ? <div className="waiting-grid">{blocked.map((task) => <button key={task.id} type="button" onMouseEnter={() => warmTask(client, task.id)} onFocus={() => warmTask(client, task.id)} onClick={() => peek.open(task.id)} className="waiting-card" data-motion-slot="needs.waiting" data-state="waiting"><span className="waiting-status" data-blocked={task.status === "blocked"}>{task.status === "blocked" ? "Blocked" : "Awaiting approval"}</span><strong>{task.title}</strong><span className="waiting-meta">Updated {relative(task.updatedAt)}<ArrowUpRight size={14} /></span></button>)}</div> : !tasks.isError && <div className="work-quiet-state"><Check size={15} />No tasks are blocked or awaiting approval.</div>}</section>}
    </>}
  </div>;
}
