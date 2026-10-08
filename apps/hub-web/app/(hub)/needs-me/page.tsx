"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Lock, Pencil, X } from "lucide-react";
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
    <div className="record-row items-start" data-motion-slot="needs.waiting" data-state="waiting">
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
  const peek = usePeek();
  useWarmEditors("peek");
  const blocked = (tasks.data?.tasks ?? []).filter((task) => task.status === "blocked" || task.status === "waiting_approval");
  return (
    <div className="page-read mx-auto max-w-[760px] px-6 pb-24 pt-8">
      <PageHeader
        title="Needs me"
        description="Review outgoing mail, pull requests, chat posts, and permission requests from your agents. What you approve is exactly what happens."
        actions={<AskEnsemble surface="needs_me" anchorKey="needs_me" label="Ask Ensemble about needs me" />}
      />
      <EditorDecisions />
      <h2 className="mb-2 text-[15px] font-semibold">Ensemble approvals{approvals.data ? ` (${approvals.data.approvals.length})` : ""}</h2>
      <Held pending={approvals.isLoading} fallback={<SkeletonRows count={2} />}>
        {(approvals.data?.approvals ?? []).length === 0 ? (
        <Empty>Nothing is waiting on your approval.</Empty>
      ) : (
        <div className="space-y-3">
          {approvals.data!.approvals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} />
          ))}
        </div>
      )}
      </Held>
      <h2 className="mb-2 mt-10 text-[15px] font-semibold">Blocked on a question{tasks.data ? ` (${blocked.length})` : ""}</h2>
      {tasks.isLoading && !tasks.data ? (
        <SkeletonRows count={2} />
      ) : blocked.length === 0 ? (
        <Empty>No agent task is waiting on an answer from you.</Empty>
      ) : (
        <div>
          {blocked.map((task) => (
            <button
              key={task.id}
              type="button"
              onMouseEnter={() => warmTask(client, task.id)}
              onFocus={() => warmTask(client, task.id)}
              onClick={() => peek.open(task.id)}
              className="record-row mb-2 w-full text-left"
              data-motion-slot="needs.waiting"
              data-state="waiting"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] uppercase tracking-[0.04em] text-muted">{task.status === "blocked" ? "Blocked" : "Approval"}</span>
                <span className="block truncate text-[15px] font-medium">{task.title}</span>
                <span className="mt-0.5 block text-[12px] text-muted">{task.status === "blocked" ? "Needs an answer" : "Waiting for you"}</span>
              </span>
              <span className="btn shrink-0">Open</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
