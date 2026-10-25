"use client";
import { useTrackOpen } from "@/lib/telemetry";
import { assistantSurface } from "@/lib/assistant-surface";
import { createPortal } from "react-dom";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { LayerFloor, Popover } from "../ui";
import { ModelLogo } from "../connectors/provider-logo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, ChevronDown, CircleAlert, Copy, Clock3, History, Maximize2, Minimize2, Plus, Unplug, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type DragEvent } from "react";
import { Mark } from "../mark";
import { AskLauncher } from "./ask-launcher";
import { asksForIds, assistantErrorText, ASSISTANT_UNAVAILABLE, CHAT_FILES_MAX, CONNECT_COMPUTER_HREF, formatChord, formatEntityText, INCLUDED_LABEL, INCLUDED_PROVIDER, INCLUDED_SOURCE, includedModelName, isSubscriptionProvider, SUBSCRIPTION_INFO, type AssistantRef, type PageMention } from "@ensemble/shared-types";
import { callRefs, replyContext, savedRefs, type ReplyContext } from "@/lib/assistant-refs";
import { isApplePlatform } from "@/lib/platform";
import { useShortcuts } from "@/lib/shortcut-store";
import { API, ApiError, api, type AssistantMessageRecord, type AssistantToolCallRecord, type Complexity, type ConversationRecord } from "@/lib/api";
import { isSilentCancellation } from "@/lib/fetch-cancel";
import { readSse } from "@/lib/sse";
import { applyNotice, applyRepliesToCache, refreshAfterAssistantWrite } from "@/lib/assistant-apply";
import { useAutoGrow } from "@/lib/auto-grow";
import { plural, relative } from "@/lib/format";
import { markModelOutOfQuota, quotaMessage, quotaSuffix, useQuotaMarks } from "@/lib/model-quota";
import { includedLocalOnly, includedNote, includedRefusal, INCLUDED_USAGE_KEY, needsConnection, refreshIncluded, tierModelLabel, tierModelName, useIncludedUsage } from "@/lib/included";
import { IncludedLocalOnly } from "@/components/metrics/included-credits";
import { AssistantAnswer, splitCutOffReply } from "./cut-off-notice";
import { MarkdownText, choiceLines } from "../markdown-text";
import { MentionPopover, useMentionMenu } from "../mentions/mention-menu";
import { MentionTextarea } from "../mentions/mention-field";
import { LinkifiedText } from "../linkified-text";
import { useModKey } from "@/lib/platform";
import { usePersistentState } from "@/lib/prefs";
import { useLive } from "../live";
import { usePeek } from "../shell/peek";
import { useToast } from "../toast";
import { BrandMorph } from "@/components/motion/brand-morph";
import { ThinkingStatus } from "@/components/motion/slot";
import { cx } from "../ui";
import { pastedFiles } from "@/lib/files/pasted";
import { AttachMenu, AttachmentShelf, MessageFiles, attachmentMentions, attachmentsOnlyMessage, fileCount, useChatAttachments, withAttachedFiles, type ChatAttachment } from "./chat-attachments";
import { PANEL_EDGES, usePanelSize } from "./use-panel-size";

/** 48 px mark in the empty reply. Settles to the mark, then leaves, once tokens arrive. */
function ReplyMorph({ waiting }: { waiting: boolean }) {
  const [shown, setShown] = useState(waiting);
  useEffect(() => {
    if (waiting) setShown(true);
  }, [waiting]);
  if (!shown) return null;
  return <BrandMorph size={48} state={waiting ? "loop" : "idle"} onIdle={() => { if (!waiting) setShown(false); }} />;
}

/** Short, page-aware starters. They never quote a record title, so an Untitled task never shows up here. */
export function starterPrompts(pathname: string): string[] {
  if (pathname.startsWith("/board")) return ["What is blocked, and why?", "Which tasks could you take for me?", "Summarize what moved this week."];
  if (pathname.startsWith("/context")) return ["Who have I not talked to in a while?", "Which project has the most open work?", "Add a person I work with."];
  if (pathname.startsWith("/needs-me")) return ["What should I approve first?", "Summarize what is waiting on me.", "What can wait until tomorrow?"];
  if (pathname.startsWith("/pages/") || pathname.startsWith("/tasks/")) return ["Summarize this page.", "Turn this into a checklist.", "What is missing here?"];
  if (pathname.startsWith("/plots")) return ["Plot one column against another.", "Which chart fits this data?"];
  if (pathname.startsWith("/diagrams")) return ["Draw a diagram of a project.", "Simplify the diagram I have open."];
  if (pathname.startsWith("/meetings")) return ["Summarize this meeting note.", "What decisions did we make?", "Find action items across my meeting notes."];
  if (pathname.startsWith("/code")) return ["What is left to review?", "Summarize the open change."];
  if (pathname.startsWith("/metrics")) return ["Where did model calls go this week?", "Which model cost the most?"];
  return ["Plan my day.", "What is due this week?", "Turn a note into tasks."];
}

export function greeting(name: string | null | undefined, now = new Date()): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  const hour = now.getHours();
  const part = hour < 5 ? "Hello" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return first ? `${part}, ${first}` : part;
}

/** The assistant window floats above the page; menus and dialogs it opens start above it. */
const ASSISTANT_LAYER = 2000;

const TIER_LABEL: Record<Complexity, string> = { easy: "Low", medium: "Medium", high: "High", max: "Max" };

function ToolCall({ call, conversationId, refs }: { call: AssistantToolCallRecord; conversationId: string | null; refs?: readonly AssistantRef[] }) {
  const toast = useToast();
  const client = useQueryClient();
  const [local, setLocal] = useState<{ phase: "applied" | "undone"; entryId: string | null } | null>(null);
  const entryId = local?.entryId ?? call.undoEntryId ?? null;
  const phase = local?.phase ?? (call.state === "undone" ? "undone" : call.state === "ok" ? "applied" : "pending");
  useEffect(() => {
    const onUndo = (event: Event) => {
      const detail = (event as CustomEvent<{ entryId?: string; direction?: string }>).detail;
      if (!entryId || detail?.entryId !== entryId) return;
      setLocal({ phase: detail.direction === "redo" ? "applied" : "undone", entryId });
    };
    window.addEventListener("ensemble:undo", onUndo);
    return () => window.removeEventListener("ensemble:undo", onUndo);
  }, [entryId]);
  const apply = useMutation({
    mutationFn: () => api.applyAssistant({ name: call.name, input: call.input ?? {}, conversationId: conversationId ?? undefined, callId: call.id }),
    onSuccess: (result) => {
      const failedHere = result.failed?.some(item => item.callId === call.id);
      setLocal(failedHere ? null : { phase: "applied", entryId: result.undoEntryId ?? null });
      if (conversationId && result.replies?.length) {
        client.setQueryData(["assistant-messages", conversationId], (current: { messages: AssistantMessageRecord[] } | undefined) =>
          current ? applyRepliesToCache(current, result.replies) ?? current : current,
        );
      }
      const notice = applyNotice(result);
      toast(notice.text, {
        tone: notice.tone,
        action: result.undoEntryId
          ? {
              label: "Undo",
              run: () => {
                void api
                  .undo(result.undoEntryId ?? undefined)
                  .then(() => client.invalidateQueries())
                  .catch((error: Error) => toast(error.message, { tone: "error" }));
              },
            }
          : undefined,
      });
      void client.invalidateQueries();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const history = async (direction: "undo" | "redo") => {
    if (!entryId) return;
    try {
      if (direction === "undo") await api.undo(entryId);
      else await api.redo(entryId);
      setLocal({ phase: direction === "undo" ? "undone" : "applied", entryId });
      void client.invalidateQueries();
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    }
  };
  const icon =
    call.state === "failed" ? (
      <CircleAlert size={12} className="text-danger" />
    ) : phase === "pending" ? (
      <Clock3 size={12} className="text-warn" />
    ) : (
      <Check size={12} className="text-ok" />
    );
  const motion =
    call.state === "failed" ? "failed" : call.state === "awaiting_approval" ? "pending" : call.state === "ok" || phase === "applied" || phase === "undone" ? "done" : "running";
  return (
    <div className="assistant-tool tile m-tool flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]" data-motion-slot="tool.call" data-state={motion}>
      {icon}
      <span className="assistant-tool-name" title={call.name}>{call.name.replace(/^(hub_|apps_)/, "").replace(/_/g, " ")}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap text-muted">{formatEntityText(call.error ?? call.summary ?? "", [...(call.refs ?? []), ...(refs ?? [])], { plain: true })}</span>
      {phase === "applied" ? <span className="text-faint">{call.isWrite === false ? "Read" : "Applied"}</span> : null}
      {phase === "undone" ? <span className="text-faint">Undone</span> : null}
      {call.href ? (
        <Link href={call.href} className="text-accent hover:underline">
          Open
        </Link>
      ) : null}
      {phase === "pending" && (call.state !== "failed" || call.name === "hub_run_workflow" && Array.isArray(call.input?.steps) && !/interrupted|uncertain|may have completed/i.test(call.error ?? "")) ? (
        <button type="button" className="btn-primary px-2 py-0.5 text-[11.5px]" onClick={() => apply.mutate()} disabled={apply.isPending}>
          {call.state === "failed" ? "Retry remaining steps" : "Apply"}
        </button>
      ) : null}
      {phase === "applied" && entryId ? (
        <button type="button" className="btn px-2 py-0.5 text-[11.5px]" onClick={() => void history("undo")}>
          Undo
        </button>
      ) : null}
      {phase === "undone" && entryId ? (
        <button type="button" className="btn px-2 py-0.5 text-[11.5px]" onClick={() => void history("redo")}>
          Redo
        </button>
      ) : null}
    </div>
  );
}

function ApplyAll({ calls, conversationId }: { calls: AssistantToolCallRecord[]; conversationId: string | null }) {
  const toast = useToast();
  const client = useQueryClient();
  const apply = useMutation({
    mutationFn: () =>
      api.applyAssistant({
        conversationId: conversationId ?? undefined,
        calls: calls.map((call) => ({ name: call.name, input: call.input ?? {}, callId: call.id })),
      }),
    onSuccess: (result) => {
      if (conversationId && result.replies?.length) {
        client.setQueryData(["assistant-messages", conversationId], (current: { messages: AssistantMessageRecord[] } | undefined) =>
          current ? applyRepliesToCache(current, result.replies) ?? current : current,
        );
      }
      // A partial batch: the rows already show which calls landed and which failed; the toast says it too.
      const notice = applyNotice(result);
      toast(notice.text, { tone: notice.tone });
      void client.invalidateQueries();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  return (
    <button type="button" className="btn-primary px-2 py-0.5 text-[11.5px]" onClick={() => apply.mutate()} disabled={apply.isPending}>
      Apply all
    </button>
  );
}

function CopyReply({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <button type="button" aria-label="Copy reply" title="Copy reply" onClick={() => {
    if (!navigator.clipboard) { toast("Copy is unavailable in this browser.", { tone: "error" }); return; }
    void navigator.clipboard.writeText(content).then(() => setCopied(true)).catch(() => toast("Could not copy this reply.", { tone: "error" }));
  }}>{copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}</button>;
}

export function AssistantFailure({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const connect = needsConnection(message);
  return <div role="alert" className="m-3 rounded-xl border border-danger/40 bg-danger/10 p-3 text-[13px] text-ink"><div className="flex items-start gap-2">{connect ? <Unplug size={16} className="mt-0.5 shrink-0 text-danger" /> : <CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" />}<p className="flex-1">{assistantErrorText(message)}</p></div>{onRetry && !connect ? <button type="button" className="btn mt-3" onClick={onRetry}>Retry</button> : null}{connect ? <a className="btn btn-primary mt-3 inline-flex" href={CONNECT_COMPUTER_HREF}>Connect this computer</a> : null}{/key|provider|model.*configure/i.test(message) ? <a className="btn ml-2 mt-3 inline-flex" href="/settings?tab=assistant#models">Open model settings</a> : null}</div>;
}

export function Message({
  message,
  conversationId,
  onChoose,
  onRetry,
  context,
}: {
  message: AssistantMessageRecord;
  conversationId: string | null;
  onChoose?: (text: string) => void;
  onRetry?: () => void;
  /** The records this reply may name by id, and whether its question asked for ids. Default: its own. */
  context?: ReplyContext;
}) {
  if (message.role === "user") {
    return (
      <div className="assistant-turn assistant-user-turn">
        <div className="assistant-user-message"><LinkifiedText text={message.content} mentions={message.mentions} /></div>
        <MessageFiles content={message.content} mentions={message.mentions} />
      </div>
    );
  }
  if (message.role === "error" || /^The model runtime (?:is not running|could not be reached)/i.test(message.content)) return <AssistantFailure message={message.content} onRetry={onRetry} />;
  const pending = (message.toolCalls ?? []).filter((call) => call.state === "awaiting_approval" && call.isWrite !== false);
  const failed = (message.toolCalls ?? []).filter((call) => call.state === "failed").length;
  // Records show by title; the saved text keeps the model's words.
  const { refs, showIds } = context ?? replyContext([message], 0);
  const shown = formatEntityText(message.content, refs, { showIds });
  const plainText = formatEntityText(message.content, refs, { showIds, plain: true });
  const answer = splitCutOffReply(plainText);
  // Replies saved before 18 Oct 2026 named included credits as an API key.
  const included = message.credentialSource === INCLUDED_SOURCE || message.credentialSource === `API key · ${INCLUDED_PROVIDER}`;
  const source = included ? INCLUDED_SOURCE : message.credentialSource;
  return (
    <article className="assistant-turn assistant-answer-turn">
      <div className="assistant-message-heading"><span className="assistant-message-avatar"><Mark size={18} /></span><span>Ensemble</span></div>
      {message.toolCalls?.length ? (
        <details className="assistant-activity" open={pending.length > 0 || message.toolCalls.some((call) => call.state === "failed")} >
          <summary>{failed ? <CircleAlert size={13} /> : <Check size={13} />}<span>{pending.length ? `${plural(pending.length, "action")} to review` : failed ? `${plural(failed, "step")} ${failed === 1 ? "needs" : "need"} attention` : `${plural(message.toolCalls.length, "step")} completed`}</span><ChevronDown size={13} /></summary>
          <div className="space-y-1.5">
          {pending.length > 1 ? (
            <ApplyAll calls={pending} conversationId={conversationId} />
          ) : null}
          {message.toolCalls.map((call) => (
            <ToolCall key={call.id} call={call} conversationId={conversationId} refs={refs} />
          ))}
          </div>
        </details>
      ) : null}
      <div className="assistant-answer-body"><AssistantAnswer content={shown} /></div>
      {onChoose
        ? choiceLines(answer.body).map((choice) => (
            <button key={choice} type="button" className="btn mr-1 mt-1" onClick={() => onChoose(choice)}>
              {choice}
            </button>
          ))
        : null}
      <div className="assistant-message-footer">
        {message.model ? <span className="inline-flex items-center gap-1.5"><ModelLogo model={message.model} provider={included ? INCLUDED_PROVIDER : undefined} size={11} />{included ? includedModelName(message.model) : message.model}</span> : null}
        {source ? <span className="min-w-0 break-words">{source}</span> : null}
        <CopyReply content={plainText} />
      </div>
    </article>
  );
}

function EmptyAssistant({ pathname, name, onPick }: { pathname: string; name: string | null; onPick: (text: string) => void }) {
  return (
    <div className="assistant-welcome" data-assistant-empty>
      <span className="assistant-welcome-mark"><Mark size={38} /></span>
      <p className="display text-[26px] leading-tight text-ink">{greeting(name)}</p>
      <p className="mt-1 text-[14px] text-muted">Bring your thoughts, pages, and connected apps together.</p>
      <div className="assistant-starters">
        {starterPrompts(pathname).map((suggestion) => (
          <button key={suggestion} type="button" onClick={() => onPick(suggestion)} className="assistant-starter">
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Recent chats, newest first. Picking one opens it in the dock. */
function ChatHistory({
  chats,
  loading,
  current,
  onPick,
  onClose,
}: {
  chats: ConversationRecord[];
  loading: boolean;
  current: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("[data-chat-current], button")?.focus();
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || (target as HTMLElement).closest?.("[data-chat-history-toggle]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Recent chats"
      className="absolute right-2 top-12 z-10 flex max-h-[min(360px,60%)] w-[min(320px,calc(100%-16px))] flex-col overflow-hidden rounded-lg border border-line-strong bg-raised shadow-pop"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      data-chat-history
    >
      <div className="border-b border-line px-3 py-2 text-[12px] font-medium text-muted">Recent chats</div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {loading ? (
          <div className="px-2 py-3 text-[12.5px] text-muted">Loading…</div>
        ) : chats.length === 0 ? (
          <div className="px-2 py-3 text-[12.5px] text-muted">No earlier chats yet.</div>
        ) : (
          chats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              onClick={() => onPick(chat.id)}
              aria-current={chat.id === current ? "true" : undefined}
              data-chat-current={chat.id === current ? "" : undefined}
              className={cx(
                "flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover focus-visible:bg-hover focus-visible:outline-none",
                chat.id === current && "bg-hover",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{chat.title || "New chat"}</span>
              <span className="shrink-0 text-[11.5px] text-faint">{relative(chat.updatedAt)}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export function AssistantDock() {
  const pathname = usePathname();
  const client = useQueryClient();
  const toast = useToast();
  const { peekId } = usePeek();
  const mod = useModKey();
  const { setWorking, working } = useLive();
  const [open, setOpen] = usePersistentState("ensemble.assistant.open", false);
  useTrackOpen("assistant.open", open);
  const [expanded, setExpanded] = usePersistentState("ensemble.assistant.expanded", false);
  const panel = useRef<HTMLDivElement>(null);
  const panelSize = usePanelSize(panel, !expanded);
  const [conversationId, setConversationId] = usePersistentState<string | null>("ensemble.assistant.conversation", null);
  const conversationRef = useRef(conversationId);
  useEffect(() => {
    conversationRef.current = conversationId;
  }, [conversationId]);
  const [tierOverride, setTierOverride] = useState<Complexity | null>(null);
  /** An included model picked for this chat instead of a tier. */
  const [includedPick, setIncludedPick] = useState<string | null>(null);
  const [streaming, setStreaming] = useState("");
  const [liveTools, setLiveTools] = useState<AssistantToolCallRecord[]>([]);
  /** Records the turn showed the model by id, sent before its text (the `refs` frame). */
  const [turnRefs, setTurnRefs] = useState<AssistantRef[]>([]);
  const [pending, setPending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState("");
  const [turnError, setTurnError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<AssistantMessageRecord[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const mention = useMentionMenu({ value: draft, onValue: setDraft, inputRef: input });
  const attachments = useChatAttachments();
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const uploadHint = useId();
  useAutoGrow(input, open ? draft : "", 8);
  const [history, setHistory] = useState(false);
  const closeHistory = useCallback(() => setHistory(false), []);

  const quotas = useQuotaMarks();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, enabled: open });
  const catalog = useQuery({ queryKey: ["models"], queryFn: api.models, enabled: open, staleTime: 60_000 });
  const includedModels = catalog.data?.providers?.find((row) => row.provider === INCLUDED_PROVIDER && row.available)?.models ?? [];
  const localOnly = includedLocalOnly(catalog.data);
  const usage = useIncludedUsage(open && includedModels.length > 0);
  const picked = includedPick && includedModels.includes(includedPick) ? includedPick : null;
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const { bindings } = useShortcuts();
  const assistantBinding = bindings.find((binding) => binding.id === "assistant");
  const assistantChord = assistantBinding ? formatChord(isApplePlatform() ? assistantBinding.mac : assistantBinding.other, isApplePlatform()) : "";
  const savedTier = settings.data?.settings.assistant.defaultTier ?? "medium";
  const tier = tierOverride ?? savedTier;
  const chats = useQuery({ queryKey: ["assistant-chats"], queryFn: api.assistantChats, enabled: open && history, staleTime: 10_000 });
  const messages = useQuery({
    queryKey: ["assistant-messages", conversationId],
    queryFn: () => api.conversationMessages(conversationId!),
    enabled: open && Boolean(conversationId),
    retry: false,
  });

  useEffect(() => {
    if (messages.error) setConversationId(null);
  }, [messages.error, setConversationId]);

  useEffect(() => {
    const onPrefill = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text?.trim();
      if (!text) return;
      setOpen(true);
      setDraft(text);
      window.setTimeout(() => input.current?.focus(), 30);
    };
    window.addEventListener("ensemble:assistant-prefill", onPrefill);
    return () => window.removeEventListener("ensemble:assistant-prefill", onPrefill);
  }, [setOpen]);

  useEffect(() => {
    // The chord is configurable, so the shortcut host owns it and asks the dock to toggle.
    const onToggle = () => setOpen((value) => !value);
    window.addEventListener("ensemble:assistant-toggle", onToggle);
    return () => window.removeEventListener("ensemble:assistant-toggle", onToggle);
  }, [setOpen]);

  useEffect(() => {
    if (open) window.setTimeout(() => input.current?.focus(), 30);
  }, [open]);

  const lastRequest = useRef<{ text: string; mentions: PageMention[]; sent?: { draft: string; files: ChatAttachment[] } } | null>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setOpen(false);
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('button[aria-label="Ask Ensemble"]')?.focus());
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [open, setOpen]);
  /** `sent`: what the person had written and attached, put back when the turn never reached the assistant. */
  const sendText = async (text: string, mentions: PageMention[] = [], sent?: { draft: string; files: ChatAttachment[] }) => {
    if (abortRef.current) return;
    lastRequest.current = { text, mentions, sent };
    const controller = new AbortController();
    abortRef.current = controller;
    setPending(true);
    setDraft("");
    setTurnError(null);
    setStreaming("");
    setLiveTools([]);
    setTurnRefs([]);
    setWorking("Assistant is thinking…");
    setOptimistic([{ id: `local-${Date.now()}`, role: "user", content: text, mentions, toolCalls: [], model: null, createdAt: new Date().toISOString() }]);
    let nextId = conversationId;
    const held: { reply: { messageId?: string; content: string; failed?: boolean; refs?: AssistantRef[] } | null } = { reply: null };
    try {
      const response = await fetch(`${API}/api/assistant/turn`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          conversationId: conversationId ?? undefined,
          message: text,
          ...(mentions.length ? { mentions } : {}),
          ...(picked ? { model: picked, provider: INCLUDED_PROVIDER, reasoningEffort: "default" } : tierOverride ? { tier: tierOverride } : {}),
          page: {
            path: pathname + (() => { const params = new URLSearchParams(); const current = new URLSearchParams(window.location.search); for (const key of ["q", "search", "who", "ids", "status", "owner", "project", "projectId", "view", "tab", "run", "session", "note", "skill", "item", "space"]) { const value = current.get(key); if (value) params.set(key, value.slice(0, 200)); } return params.size ? `?${params}` : ""; })(),
            selection: window.getSelection()?.toString().slice(0, 2000) || undefined,
            surface: assistantSurface(pathname),
            taskId: peekId ?? undefined,
            meetingId: pathname === "/meetings" ? document.querySelector<HTMLElement>("[data-meeting-id]")?.dataset.meetingId : undefined,
            label: peekId ? "a task page" : pathname.startsWith("/pages/") ? "a note" : pathname.slice(1) || "Today",
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const raw = await response.text();
        let parsed: { error?: string; message?: string; code?: string; model?: string; resetsAt?: string } = {};
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          // not json
        }
        const refused = includedRefusal(parsed);
        if (refused) {
          refreshIncluded(client);
          throw new ApiError(refused, response.status, parsed.code ?? null);
        }
        const mark = quotaMessage(parsed);
        if (mark) {
          markModelOutOfQuota(mark);
          void client.invalidateQueries({ queryKey: ["models"] });
        }
        throw new ApiError(parsed.message || parsed.error || raw || "The assistant did not answer.", response.status);
      }
      await readSse(response, (event, data) => {
        const frame = data as {
          text?: string;
          content?: string;
          conversationId?: string;
          message?: string;
          messageId?: string;
          userMessageId?: string;
          type?: string;
          call?: AssistantToolCallRecord;
          preview?: string;
          code?: string;
          model?: string;
          resetsAt?: string;
          saveFailed?: boolean;
          failed?: boolean;
          refs?: AssistantRef[];
        };
        if (event === "status") {
          if (frame.userMessageId) setOptimistic((rows) => rows.map((row) => row.role === "user" ? { ...row, id: frame.userMessageId! } : row));
          if (frame.text) setWorking(frame.text);
          if (frame.conversationId) {
            nextId = frame.conversationId;
            conversationRef.current = frame.conversationId;
            setConversationId(frame.conversationId);
          }
        }
        if (event === "delta") setStreaming((value) => value + (frame.text ?? ""));
        if (event === "refs") setTurnRefs(savedRefs(frame.refs));
        if ((event === "tool" || event === "pending") && frame.call) {
          const call = frame.preview ? { ...frame.call, summary: frame.preview } : frame.call;
          setLiveTools((rows) => [...rows.filter((row) => row.id !== call.id), call]);
          if (event === "tool" && call.state === "ok" && call.isWrite) refreshAfterAssistantWrite(client);
        }
        if (event === "error") {
          // Credits used, paused for everyone, or not set up: not a quota mark on the model.
          const refused = includedRefusal(frame);
          if (refused) {
            refreshIncluded(client);
            setTurnError(refused);
            return;
          }
          const mark = quotaMessage(frame);
          if (mark) {
            markModelOutOfQuota(mark);
            void client.invalidateQueries({ queryKey: ["models"] });
          }
          setTurnError(assistantErrorText(frame.message ?? ASSISTANT_UNAVAILABLE));
        }
        if (event === "done" && frame.conversationId) {
          nextId = frame.conversationId;
          if (frame.saveFailed && frame.content) held.reply = { messageId: frame.messageId, content: frame.content, failed: frame.failed, refs: savedRefs(frame.refs) };
        }
      });
      if (nextId) setConversationId(nextId);
      await client.invalidateQueries({ queryKey: ["assistant-messages", nextId] });
      void client.invalidateQueries({ queryKey: ["assistant-chats"] });
      if (picked || settings.data?.settings.models[tier]?.provider === INCLUDED_PROVIDER) void client.invalidateQueries({ queryKey: INCLUDED_USAGE_KEY });
      const kept = held.reply;
      if (kept && nextId) {
        client.setQueryData(["assistant-messages", nextId], (current: { messages: AssistantMessageRecord[] } | undefined) => {
          if (!current) return current;
          if (kept.messageId && current.messages.some((row) => row.id === kept.messageId)) {
            return {
              ...current,
              messages: current.messages.map((row) => (row.id === kept.messageId ? { ...row, content: kept.content } : row)),
            };
          }
          return {
            ...current,
            messages: [
              ...current.messages,
              {
                id: kept.messageId || `unsaved-${Date.now()}`,
                role: kept.failed ? "error" : "assistant",
                content: kept.content,
                ...(kept.refs?.length ? { mentions: kept.refs as PageMention[] } : {}),
                toolCalls: [],
                model: null,
                createdAt: new Date().toISOString(),
              },
            ],
          };
        });
      }
      setOptimistic([]);
      setStreaming("");
      setLiveTools([]);
      if (sent) attachments.release(sent.files);
      setTurnRefs([]);
    } catch (error) {
      if (isSilentCancellation(error, controller.signal)) {
        setTurnError(null);
        if (sent) attachments.release(sent.files);
        if (nextId) {
          setConversationId(nextId);
          setOptimistic([
            {
              id: `stopped-${nextId}`,
              role: "assistant",
              content: "Stopped.",
              toolCalls: [],
              model: null,
              createdAt: new Date().toISOString(),
            },
          ]);
          window.setTimeout(() => {
            void client.invalidateQueries({ queryKey: ["assistant-messages", nextId] });
          }, 600);
        } else {
          setOptimistic([]);
        }
      } else {
        setDraft((current) => current || (sent ? sent.draft : text));
        if (sent) attachments.restore(sent.files);
        setTurnError((error as Error).message);
        setOptimistic([]);
      }
    } finally {
      setPending(false);
      setWorking(null);
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    const id = conversationRef.current;
    if (id) void api.stopAssistant(id);
  };

  const saved = messages.data?.messages ?? [];
  const all = [...saved, ...optimistic.filter((row) => !saved.some((message) => message.id === row.id))];
  // While a reply streams: the records its calls returned, the ones the turn showed the model, and the question's mentions.
  const liveRefs = [...callRefs(liveTools), ...turnRefs, ...(lastRequest.current?.mentions ?? [])];
  const liveShowIds = asksForIds(lastRequest.current?.text);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [all.length, pending, streaming]);

  /** Sends `text` with the files on the shelf. False when it could not go yet, with the reason on the shelf. */
  const send = (text: string, typed: PageMention[] = []): boolean => {
    if (abortRef.current) return false;
    if (attachments.uploading) {
      attachments.setNotice("Wait for the uploads to finish, or cancel them, then send.");
      return false;
    }
    const files = attachments.take();
    const mentions = withAttachedFiles(typed, attachmentMentions(files));
    if (fileCount(mentions) > CHAT_FILES_MAX) {
      attachments.restore(files);
      attachments.setNotice(`A message can carry up to ${CHAT_FILES_MAX} files, counting @file mentions. Remove some, then send.`);
      return false;
    }
    const message = text || (files.length ? attachmentsOnlyMessage(files.length) : "");
    if (!message) return false;
    void sendText(message, mentions, { draft: text, files });
    return true;
  };

  /** The failed turn again, as it was sent. Files that came back to the shelf after it failed leave it again. */
  const retryLast = () => {
    const request = lastRequest.current;
    if (!request) return;
    const sent = request.sent;
    void sendText(request.text, request.mentions, sent && { draft: sent.draft, files: sent.files.length ? attachments.take(sent.files) : [] });
  };

  const submit = () => {
    const text = draft.trim();
    if ((!text && !attachments.ready.length) || pending) return;
    if (send(text, mention.takeMentions(text))) mention.clear();
  };

  const tiers = settings.data?.settings.models;

  const chord = assistantChord || (mod === "⌘" ? "⌘J" : "Ctrl+J");
  // Always mounted and only hidden: mounting again after a task closes would measure from the corner and slide back.
  const launcher = (
    <AskLauncher
      hidden={open || pathname.startsWith("/start")}
      working={pending}
      onOpen={() => setOpen(true)}
      title={`Ask Ensemble (${chord}). Drag to move it.`}
    />
  );
  if (!open) return launcher;

  const filesDragged = (event: DragEvent<HTMLDivElement>) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

  return createPortal(
    <LayerFloor.Provider value={ASSISTANT_LAYER}>
    {launcher}
    <div
      ref={panel}
      data-assistant-surface
      style={{ zIndex: ASSISTANT_LAYER, ...panelSize.style }}
      onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); setOpen(false); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('button[aria-label="Ask Ensemble"]')?.focus()); } }}
      // The whole window takes dropped files, so one dropped beside the box is attached, not opened by the browser.
      onDragEnter={(event) => {
        if (!filesDragged(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDropping(true);
      }}
      onDragOver={(event) => {
        if (!filesDragged(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!filesDragged(event)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDropping(false);
      }}
      onDrop={(event) => {
        dragDepth.current = 0;
        setDropping(false);
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (!files.length) return;
        event.preventDefault();
        attachments.add(files);
        input.current?.focus();
      }}
      className={cx(
        "assistant-window pop-in fixed flex flex-col overflow-hidden border border-line-strong shadow-pop",
        expanded ? "inset-x-[5vw] bottom-6 top-[5vh]" : "bottom-5 right-5 h-[min(720px,85vh)] w-[min(660px,94vw)]",
      )}
    >
      {panelSize.enabled ? PANEL_EDGES.map((edge) => <div key={edge} {...panelSize.handleProps(edge)} />) : null}
      <div className="assistant-window-header flex shrink-0 items-center gap-2 px-4">
        <BrandMorph size={24} state="once" kind="unfurl" />
        <div className="min-w-0 flex-1"><span className="text-[14px] font-semibold">Ensemble assistant</span><span className="assistant-header-hint">Your workspace, in conversation</span></div>
        {working && !pending ? <ThinkingStatus real={working === "Assistant is thinking…" || working === "Working…" ? null : working} active /> : null}
        <button
          type="button"
          className="icon-btn"
          title={pending ? "Recent chats (after this answer)" : "Recent chats"}
          aria-label="Recent chats"
          aria-expanded={history}
          disabled={pending}
          onClick={() => setHistory((value) => !value)}
          data-chat-history-toggle
        >
          <History size={15} />
        </button>
        <button type="button" className="icon-btn" title="New chat" aria-label="New chat" onClick={() => { setHistory(false); setConversationId(null); }}>
          <Plus size={15} />
        </button>
        <button type="button" className="icon-btn" title={expanded ? "Shrink" : "Expand"} onClick={() => setExpanded(!expanded)}>
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button type="button" className="icon-btn" title={`Close (${mod === "⌘" ? "⌘J" : "Ctrl+J"})`} aria-label="Close" onClick={() => setOpen(false)}>
          <X size={15} />
        </button>
      </div>

      {history ? (
        <ChatHistory
          chats={chats.data?.conversations ?? []}
          loading={chats.isLoading}
          current={conversationId}
          onClose={closeHistory}
          onPick={(id) => {
            setHistory(false);
            setTurnError(null);
            setOptimistic([]);
            setConversationId(id);
            window.setTimeout(() => input.current?.focus(), 30);
          }}
        />
      ) : null}

      <div ref={scroller} className="assistant-conversation min-h-0 flex-1 overflow-y-auto">
        {all.length === 0 ? (
          <EmptyAssistant pathname={pathname} name={shell.data?.user?.name ?? null} onPick={(text) => void send(text)} />
        ) : (
          all.map((message, index) => (
            <Message key={message.id} message={message} context={replyContext(all, index)} conversationId={conversationId} onChoose={(choice) => void send(choice)} onRetry={pending ? undefined : () => { const previous = all.slice(0, index).reverse().find(row => row.role === "user"); if (previous) void sendText(previous.content, previous.mentions ?? []); }} />
          ))
        )}
        {pending ? (
          <div className="assistant-turn space-y-2">
            {liveTools.map((call) => (
              <ToolCall key={call.id} call={call} conversationId={conversationId} refs={liveRefs} />
            ))}
            <div className="m-stream" data-motion-slot="reply.stream" data-state={streaming ? "streaming" : "done"}>
              <div className={streaming ? "mb-3 flex justify-center" : "flex flex-col items-center gap-3 py-4"}>
                <ReplyMorph waiting={!streaming} />
                {streaming ? null : <ThinkingStatus real={working && working !== "Assistant is thinking…" && working !== "Working…" ? working : null} active art={false} />}
              </div>
              {streaming ? (
                <div className="flex items-start gap-2">
                  <BrandMorph size={16} state="loop" />
                  <div className="min-w-0 flex-1">
                    <MarkdownText text={formatEntityText(streaming, liveRefs, { streaming: true, showIds: liveShowIds })} />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="assistant-composer-area relative shrink-0">
        <MentionPopover menu={mention} />
        {turnError && !all.some(message => message.role === "error" && assistantErrorText(message.content) === assistantErrorText(turnError)) ? <AssistantFailure message={turnError} onRetry={pending ? undefined : retryLast} /> : null}
        <div className="assistant-composer tile flex flex-col gap-2 px-4 py-3" data-dropping={dropping ? "" : undefined}>
          <AttachmentShelf attachments={attachments} hintId={uploadHint} />
          <div className="flex items-end gap-2">
            <AttachMenu attachments={attachments} onAttached={() => window.setTimeout(() => input.current?.focus(), 30)} />
            <MentionTextarea
              menu={mention}
              rows={1}
              value={draft}
              onKeyDown={(event) => {
                if (mention.onKeyDown(event)) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              onPaste={(event) => {
                const files = pastedFiles(event.clipboardData);
                if (!files.length) return;
                event.preventDefault();
                attachments.add(files);
              }}
              placeholder="Ask, or tell me what to change. @ to mention…"
              fieldClassName="flex-1"
              className="box-border min-h-6 resize-none overflow-hidden bg-transparent py-0 text-[13.5px] leading-6 outline-none placeholder:text-faint"
            />
            <button
              type="button"
              className="assistant-send icon-btn"
              onClick={pending ? stop : submit}
              disabled={!pending && (attachments.uploading > 0 || (!draft.trim() && !attachments.ready.length))}
              aria-label={pending ? "Stop" : "Send"}
              title={pending ? "Stop" : attachments.uploading ? "Send is available when the files finish uploading" : "Send"}
              aria-describedby={!pending && attachments.uploading ? uploadHint : undefined}
            >
              {pending ? <span className="text-[11px] font-semibold">Stop</span> : <ArrowUp size={15} />}
            </button>
          </div>
          {dropping ? <div className="assistant-drop-target" aria-hidden="true">Drop files to attach them to this message</div> : null}
        </div>
        <div className="assistant-composer-options mt-2 flex flex-wrap items-center gap-3 text-[12px] text-faint">
          <Popover width={360} trigger={(open, toggle) => <button type="button" className="btn min-w-0 max-w-full" aria-label="Complexity" aria-haspopup="listbox" aria-expanded={open} onClick={toggle}><span className="truncate">{picked ? `${includedModelName(picked)} · Included` : `${TIER_LABEL[tier]} · ${tiers ? tierModelName(tiers[tier].provider, tiers[tier].model) : "Automatic"}`}</span><ChevronDown size={13} /></button>}>
            {close => <div role="listbox" aria-label="Response complexity" className="space-y-1" onKeyDown={event => {
              const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
              const index = options.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === "ArrowDown" ? (index + 1) % options.length : event.key === "ArrowUp" ? (index + options.length - 1) % options.length : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : -1;
              if (next >= 0) { event.preventDefault(); options[next]?.focus(); }
            }}>{(Object.keys(TIER_LABEL) as Complexity[]).map(key => <button key={key} type="button" role="option" aria-selected={!picked && tier === key} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13px] text-ink hover:bg-hover" onClick={() => { setIncludedPick(null); setTierOverride(key); close(); }}><span><strong className="font-medium">{TIER_LABEL[key]}</strong><small className="mt-1 block text-muted">{tierModelLabel(tiers?.[key]) ?? "Automatic"}{quotaSuffix(tiers?.[key].model, quotas)}</small></span>{!picked && tier === key ? <Check size={14} /> : null}</button>)}
              {!includedModels.length && localOnly ? <div className="mt-1 border-t border-line pt-2"><IncludedLocalOnly compact onNavigate={close} /></div> : null}
              {includedModels.length ? <div role="group" aria-label={INCLUDED_LABEL} className="mt-1 border-t border-line pt-2">
                <div className="px-3 pb-1 text-[11.5px] text-muted">{INCLUDED_LABEL}{usage.data?.available ? ` · ${includedNote(usage.data)}` : ""}</div>
                {includedModels.map(model => <button key={model} type="button" role="option" aria-selected={picked === model} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13px] text-ink hover:bg-hover" onClick={() => { setIncludedPick(model); close(); }}><span className="inline-flex items-center gap-2"><ModelLogo model={model} provider={INCLUDED_PROVIDER} size={13} />{includedModelName(model)}</span>{picked === model ? <Check size={14} /> : null}</button>)}
              </div> : null}</div>}
          </Popover>
          <span className="assistant-key-hint">Enter to send · ⇧ Enter for a new line</span>
        </div>
      </div>
    </div>
    </LayerFloor.Provider>, document.body
  );
}
