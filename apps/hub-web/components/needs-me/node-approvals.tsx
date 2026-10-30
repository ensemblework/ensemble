"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowUpRight, Check, KeyRound, X } from "lucide-react";
import { useToast } from "@/components/toast";
import { api, type NodeApprovalCard } from "@/lib/api";
import { keptText, parseAllow, routeText, secretAnswer, targetFingerprint } from "@/lib/node-secret";
import { relative } from "@/lib/format";

const WANTS: Record<string, string> = {
  tools: "wants to act for you",
  post: "wants to post for you",
  session: "wants to start work on your computer",
  secret: "needs a secret for work on your computer",
  node_proposal: "proposes something new for you",
  disclosure: "asks before sharing something with a room",
  peer_request: "has a request for you from a room",
  media_preview: "has a capture for you to check first",
};

/** What the node wants, as the card's first line says it after its handle. */
function wants(card: NodeApprovalCard): string {
  if (card.data.type === "session" && card.data.action === "hand_over") return "wants to hand a session to another node";
  const count = Array.isArray(card.data.evidence) ? card.data.evidence.length : 0;
  if (card.data.type === "media_preview" && count > 1) return `has ${count} captures for you to check first`;
  return WANTS[card.data.type ?? "tools"] ?? WANTS.tools;
}

/**
 * The value is encrypted here for the computer on the card (lib/node-secret.ts) and sent once; it is
 * not kept in this page after sending. A computer too old for a key gets it over HTTPS, and the card
 * says so.
 */
function SecretForm({ card, onDone }: { card: NodeApprovalCard; onDone: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const [allowText, setAllowText] = useState((card.data.allow ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = card.data.name ?? "SECRET";
  const target = useQuery({ queryKey: ["node-secret", card.id], queryFn: () => api.nodeSecretTarget(card.id), retry: false, staleTime: 30_000 });
  const fingerprint = useQuery({ queryKey: ["node-secret-key", card.id, target.data?.route.mode === "sealed" ? target.data.route.sealKey.kid : null], queryFn: () => targetFingerprint(target.data!), enabled: Boolean(target.data) });
  const computer = target.data?.computer.name ?? card.data.computer ?? "your computer";
  const allow = parseAllow(allowText);
  const blocked = target.data?.route.mode === "pair_again";
  return (
    <form
      className="mt-3 space-y-2"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value || !target.data) return;
        setBusy(true);
        setError(null);
        secretAnswer(target.data, card, value, allow, window.location.origin)
          .then((answer) => api.saveNodeSecret(card.id, answer))
          .then(() => {
            setValue("");
            toast(`Saved ${name} on ${computer}.`);
            onDone();
          })
          .catch((failure: Error) => setError(failure.message))
          .finally(() => setBusy(false));
      }}
    >
      <label className="field flex items-center gap-2">
        <KeyRound size={14} className="shrink-0 text-muted" />
        <input type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="new-password" spellCheck={false} aria-label={`Value for ${name}`} placeholder={`Paste ${name}`} className="min-w-0 flex-1 bg-transparent font-mono outline-none" disabled={busy || blocked} />
      </label>
      <label className="block text-[12px] text-muted">
        Only send it to (optional)
        <input value={allowText} onChange={(event) => setAllowText(event.target.value)} spellCheck={false} aria-label={`Where ${name} may be sent`} placeholder="https://api.example.com" className="field mt-1 w-full font-mono text-[12px]" disabled={busy || blocked} />
      </label>
      <div className="text-[12px] text-muted" data-secret-route={target.data?.route.mode ?? "loading"}>
        {target.data ? routeText(target.data, fingerprint.data ?? null) : target.error ? (target.error as Error).message : "Checking how this goes to the computer…"} {keptText(name, computer, allow)} The node and its models never see it.
      </div>
      {error ? <div className="text-[12px] text-danger">{error}</div> : null}
      <button type="submit" className="btn-primary" disabled={!value || busy || !target.data || blocked}>
        <Check size={13} /> Save to {computer}
      </button>
    </form>
  );
}

/** The person's Ensemble Node approval cards. Ensemble on a computer has no Node, so a refusal there is an empty list. */
export function useNodeApprovals() {
  return useQuery({ queryKey: ["node-approvals"], queryFn: api.nodeApprovals, retry: false, staleTime: 15_000 });
}

function NodeCard({ card, nodeUrl }: { card: NodeApprovalCard; nodeUrl: string | null }) {
  const client = useQueryClient();
  const toast = useToast();
  const settle = useMutation({
    mutationFn: (decision: "approve" | "discard") => api.settleNodeApproval(card.id, decision),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: ["node-approvals"] });
      const previous = client.getQueryData<{ approvals: NodeApprovalCard[]; nodeUrl: string | null }>(["node-approvals"]);
      if (previous) client.setQueryData(["node-approvals"], { ...previous, approvals: previous.approvals.filter((row) => row.id !== card.id) });
      return { previous };
    },
    onSuccess: (_result, decision) => toast(decision === "approve" ? `Approved. @${card.node?.slug ?? "the node"} goes on.` : "Discarded. Nothing was done."),
    onError: (error, _decision, context) => {
      if (context?.previous) client.setQueryData(["node-approvals"], context.previous);
      toast((error as Error).message, { tone: "error" });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["node-approvals"] });
      void client.invalidateQueries({ queryKey: ["shell"] });
    },
  });
  const open = nodeUrl ? `${nodeUrl}/r/${card.roomId}#m-${card.id}` : null;
  return (
    <div className="review-card items-start" data-motion-slot="needs.waiting" data-state="waiting">
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-[12px] uppercase tracking-[0.04em] text-muted">Ensemble Node</span>
            <span className="block text-[15px] font-medium">
              @{card.node?.slug ?? "node"} {wants(card)}
            </span>
            <span className="mt-0.5 block text-[12px] text-muted">
              {relative(card.createdAt)}
              {card.room ? ` · in ${card.room.title}` : ""}
            </span>
          </span>
          {open ? (
            <a className="btn shrink-0" href={open} target="_blank" rel="noreferrer">
              Open in Node <ArrowUpRight size={13} />
            </a>
          ) : null}
        </div>
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-raised p-3 text-[13px] leading-5">{card.data.type === "secret" ? `${card.data.name}: ${card.body}` : card.body}</pre>
        {card.data.error ? <div className="mt-2 text-[12px] text-danger">{card.data.error}</div> : null}
        {card.data.type === "secret" ? (
          <SecretForm
            card={card}
            onDone={() => {
              void client.invalidateQueries({ queryKey: ["node-approvals"] });
              void client.invalidateQueries({ queryKey: ["shell"] });
            }}
          />
        ) : null}
        <div className="mt-3 flex items-center gap-2">
          {card.data.type === "secret" ? null : (
            <button type="button" className="btn-primary" onClick={() => settle.mutate("approve")} disabled={settle.isPending}>
              <Check size={13} /> {card.data.type === "media_preview" ? "Send" : "Approve"}
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={() => settle.mutate("discard")} disabled={settle.isPending}>
            <X size={13} /> Discard
          </button>
        </div>
      </div>
    </div>
  );
}

export function NodeApprovals({ cards, nodeUrl }: { cards: NodeApprovalCard[]; nodeUrl: string | null }) {
  return (
    <div className="space-y-3">
      {cards.map((card) => (
        <NodeCard key={card.id} card={card} nodeUrl={nodeUrl} />
      ))}
    </div>
  );
}
