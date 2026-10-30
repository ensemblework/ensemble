"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowUpRight, Check, KeyRound, LogIn, Monitor, X } from "lucide-react";
import { useToast } from "@/components/toast";
import { api, type NodeApprovalCard } from "@/lib/api";
import { keptText, parseAllow, routeText, secretAnswer, targetFingerprint } from "@/lib/node-secret";
import { loginFingerprint, loginRouteText, typedLoginAnswer } from "@/lib/node-login";
import { relative } from "@/lib/format";

const WANTS: Record<string, string> = {
  tools: "wants to act for you",
  post: "wants to post for you",
  session: "wants to start work on your computer",
  secret: "needs a secret for work on your computer",
  login: "needs you to sign in on your computer",
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

/**
 * A tab on the person's computer waits for them to sign in (B11). The saved login there, signing in on
 * the computer itself, or a login typed here: encrypted in this browser for that computer (lib/node-login.ts),
 * filled into the page by the computer. Nothing typed is kept in this page after sending.
 */
function LoginForm({ card, nodeUrl, onDone }: { card: NodeApprovalCard; nodeUrl: string | null; onDone: () => void }) {
  const toast = useToast();
  const [typing, setTyping] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [shown, setShown] = useState(false);
  const target = useQuery({ queryKey: ["node-login", card.id], queryFn: () => api.nodeLoginTarget(card.id), retry: false, staleTime: 30_000 });
  const fingerprint = useQuery({ queryKey: ["node-login-key", card.id, target.data?.route.mode === "sealed" ? target.data.route.sealKey.kid : null], queryFn: () => loginFingerprint(target.data!), enabled: Boolean(target.data) });
  const computer = target.data?.computer.name ?? card.data.computer ?? "your computer";
  const site = card.data.origin ?? target.data?.origin ?? "the site";
  const send = (action: string, answer: Parameters<typeof api.answerNodeLogin>[1] | Promise<Parameters<typeof api.answerNodeLogin>[1]>) => {
    setBusy(action);
    setMessage(null);
    Promise.resolve(answer)
      .then((body) => api.answerNodeLogin(card.id, body))
      .then((done) => {
        if (done.result.status === "signed_in") {
          setPassword("");
          setCode("");
          toast(`Signed in to ${site} on ${computer}. @${card.node?.slug ?? "the node"} goes on.`);
          onDone();
        } else if (done.result.status === "declined") {
          toast("Not now. The work goes on without it.");
          onDone();
        } else if (done.result.status === "shown") {
          setShown(true);
          setMessage({ tone: "ok", text: `It is open on ${computer}. Sign in there, then press I'm done.` });
        } else {
          setPassword("");
          setCode("");
          setMessage({ tone: "error", text: done.message.data.error ?? done.result.message ?? "Still not signed in." });
        }
      })
      .catch((failure: Error) => setMessage({ tone: "error", text: failure.message }))
      .finally(() => setBusy(null));
  };
  const open = nodeUrl ? `${nodeUrl}/r/${card.roomId}#m-${card.id}` : null;
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        {card.data.saved ? (
          <button type="button" className="btn-primary" disabled={Boolean(busy)} onClick={() => send("saved", { action: "saved" })}>
            <KeyRound size={13} /> Use saved login
          </button>
        ) : null}
        {card.data.display ? (
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => send("local", { action: "local" })}>
            <Monitor size={13} /> Sign in on {computer}
          </button>
        ) : null}
        {card.data.display || shown ? (
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => send("done", { action: "done" })}>
            <Check size={13} /> I&apos;m done
          </button>
        ) : null}
        <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => setTyping((value) => !value)} aria-expanded={typing}>
          <LogIn size={13} /> Type it here
        </button>
        {open && card.data.takeover ? (
          <a className="btn" href={open} target="_blank" rel="noreferrer">
            Open the browser in Node <ArrowUpRight size={13} />
          </a>
        ) : null}
      </div>
      {!card.data.display ? <div className="text-[12px] text-muted">{computer} has no screen to sign in on{card.data.takeover ? "; open the browser in Node to use it from here." : "."}</div> : null}
      {typing ? (
        <form
          className="space-y-2"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (!target.data || !password) return;
            send("typed", typedLoginAnswer(target.data, card, { username, password, code, save }, window.location.origin));
          }}
        >
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" spellCheck={false} aria-label={`User name or email for ${site}`} placeholder="User name or email" className="field w-full" disabled={Boolean(busy)} />
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" spellCheck={false} aria-label={`Password for ${site}`} placeholder="Password" className="field w-full font-mono" disabled={Boolean(busy)} />
          <input value={code} onChange={(event) => setCode(event.target.value.replace(/\s/g, ""))} inputMode="numeric" autoComplete="one-time-code" aria-label="One-time code (optional)" placeholder="One-time code (optional)" className="field w-full font-mono" disabled={Boolean(busy)} />
          <label className="flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={save} onChange={(event) => setSave(event.target.checked)} disabled={Boolean(busy)} /> Save on {computer} for next time
          </label>
          <div className="text-[12px] text-muted" data-login-route={target.data?.route.mode ?? "loading"}>
            {target.data ? loginRouteText(target.data, fingerprint.data ?? null) : target.error ? (target.error as Error).message : "Checking how this goes to the computer…"} {computer} fills the page itself; the node and its models never see it.
          </div>
          <button type="submit" className="btn-primary" disabled={!password || Boolean(busy) || target.data?.route.mode !== "sealed"}>
            <LogIn size={13} /> Sign in on {computer}
          </button>
        </form>
      ) : null}
      {busy ? <div className="text-[12px] text-muted">Working on {computer}…</div> : null}
      {message ? <div className={`text-[12px] ${message.tone === "error" ? "text-danger" : "text-muted"}`}>{message.text}</div> : null}
    </div>
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
    onSuccess: (_result, decision) => toast(decision === "approve" ? `Approved. @${card.node?.slug ?? "the node"} goes on.` : card.data.type === "login" ? "Not now. The work goes on without it." : "Discarded. Nothing was done."),
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
        {card.data.type === "login" ? (
          <LoginForm
            card={card}
            nodeUrl={nodeUrl}
            onDone={() => {
              void client.invalidateQueries({ queryKey: ["node-approvals"] });
              void client.invalidateQueries({ queryKey: ["shell"] });
            }}
          />
        ) : null}
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
          {card.data.type === "secret" || card.data.type === "login" ? null : (
            <button type="button" className="btn-primary" onClick={() => settle.mutate("approve")} disabled={settle.isPending}>
              <Check size={13} /> {card.data.type === "media_preview" ? "Send" : "Approve"}
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={() => settle.mutate("discard")} disabled={settle.isPending}>
            <X size={13} /> {card.data.type === "login" ? "Not now" : "Discard"}
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
