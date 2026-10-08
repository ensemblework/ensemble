"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, CircleAlert, Clock3, Maximize2, Minimize2, Plus, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Mark } from "../mark";
import { AskLauncher } from "./ask-launcher";
import { formatChord } from "@ensemble/shared-types";
import { isApplePlatform } from "@/lib/platform";
import { useShortcuts } from "@/lib/shortcut-store";
import { API, ApiError, api, type AssistantMessageRecord, type AssistantToolCallRecord, type Complexity } from "@/lib/api";
import { isSilentCancellation } from "@/lib/fetch-cancel";
import { readSse } from "@/lib/sse";
import { applyNotice, applyRepliesToCache } from "@/lib/assistant-apply";
import { markModelOutOfQuota, quotaMessage, quotaSuffix, useQuotaMarks } from "@/lib/model-quota";
import { AssistantAnswer, splitCutOffReply } from "./cut-off-notice";
import { MarkdownText, choiceLines } from "../markdown-text";
import { useEntities } from "@/lib/entities";
import { useModKey } from "@/lib/platform";
import { usePersistentState } from "@/lib/prefs";
import { useLive } from "../live";
import { usePeek } from "../shell/peek";
import { useToast } from "../toast";
import { BrandMorph } from "@/components/motion/brand-morph";
import { ThinkingStatus } from "@/components/motion/slot";
import { cx } from "../ui";

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

const TIER_LABEL: Record<Complexity, string> = { easy: "Low", medium: "Medium", high: "High", max: "Max" };

function ToolCall({ call, conversationId }: { call: AssistantToolCallRecord; conversationId: string | null }) {
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
      setLocal({ phase: "applied", entryId: result.undoEntryId ?? null });
      if (conversationId && result.replies?.length) {
        client.setQueryData(["assistant-messages", conversationId], (current: { messages: AssistantMessageRecord[] } | undefined) =>
          current ? applyRepliesToCache(current, result.replies) ?? current : current,
        );
      }
      toast(result.summary, {
        tone: "ok",
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
    <div className="tile m-tool flex items-center gap-2 rounded-md bg-panel px-2 py-1 text-[12px]" data-motion-slot="tool.call" data-state={motion}>
      {icon}
      <span className="font-mono text-[11px] text-faint">{call.name}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap text-muted">{call.error ?? call.summary}</span>
      {phase === "applied" ? <span className="text-faint">Applied</span> : null}
      {phase === "undone" ? <span className="text-faint">Undone</span> : null}
      {call.href ? (
        <Link href={call.href} className="text-accent hover:underline">
          Open
        </Link>
      ) : null}
      {phase === "pending" && call.state !== "failed" ? (
        <button type="button" className="btn-primary px-2 py-0.5 text-[11.5px]" onClick={() => apply.mutate()} disabled={apply.isPending}>
          Apply
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

export function Message({
  message,
  conversationId,
  onChoose,
}: {
  message: AssistantMessageRecord;
  conversationId: string | null;
  onChoose?: (text: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] whitespace-pre-wrap rounded-lg bg-raised px-3 py-2 text-[13.5px] leading-5">{message.content}</div>
      </div>
    );
  }
  const pending = (message.toolCalls ?? []).filter((call) => call.state === "awaiting_approval" && call.isWrite !== false);
  const answer = splitCutOffReply(message.content);
  return (
    <div className="space-y-2">
      {message.toolCalls?.length ? (
        <div className="space-y-1">
          {pending.length > 1 ? (
            <ApplyAll calls={pending} conversationId={conversationId} />
          ) : null}
          {message.toolCalls.map((call) => (
            <ToolCall key={call.id} call={call} conversationId={conversationId} />
          ))}
        </div>
      ) : null}
      <AssistantAnswer content={message.content} />
      {onChoose
        ? choiceLines(answer.body).map((choice) => (
            <button key={choice} type="button" className="btn mr-1 mt-1" onClick={() => onChoose(choice)}>
              {choice}
            </button>
          ))
        : null}
      {message.model ? <div className="text-2xs text-faint">{message.model}</div> : null}
    </div>
  );
}

function EmptyAssistant({ pathname, name, onPick }: { pathname: string; name: string | null; onPick: (text: string) => void }) {
  return (
    <div className="flex h-full flex-col justify-end pb-2" data-assistant-empty>
      <p className="display text-[26px] leading-tight text-ink">{greeting(name)}</p>
      <p className="mt-1 text-[14px] text-muted">How can I help?</p>
      <div className="mt-5 flex flex-wrap gap-2">
        {starterPrompts(pathname).map((suggestion) => (
          <button key={suggestion} type="button" onClick={() => onPick(suggestion)} className="assistant-starter">
            {suggestion}
          </button>
        ))}
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
  const entities = useEntities(open);
  const [expanded, setExpanded] = usePersistentState("ensemble.assistant.expanded", false);
  const [conversationId, setConversationId] = usePersistentState<string | null>("ensemble.assistant.conversation", null);
  const conversationRef = useRef(conversationId);
  useEffect(() => {
    conversationRef.current = conversationId;
  }, [conversationId]);
  const [tierOverride, setTierOverride] = useState<Complexity | null>(null);
  const [streaming, setStreaming] = useState("");
  const [liveTools, setLiveTools] = useState<AssistantToolCallRecord[]>([]);
  const [pending, setPending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState("");
  const [turnError, setTurnError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<AssistantMessageRecord[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const quotas = useQuotaMarks();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, enabled: open });
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const { bindings } = useShortcuts();
  const assistantBinding = bindings.find((binding) => binding.id === "assistant");
  const assistantChord = assistantBinding ? formatChord(isApplePlatform() ? assistantBinding.mac : assistantBinding.other, isApplePlatform()) : "";
  const savedTier = settings.data?.settings.assistant.defaultTier ?? "medium";
  const tier = tierOverride ?? savedTier;
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

  const sendText = async (text: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setPending(true);
    setTurnError(null);
    setStreaming("");
    setLiveTools([]);
    setWorking("Assistant is thinking…");
    setOptimistic([{ id: `local-${Date.now()}`, role: "user", content: text, toolCalls: [], model: null, createdAt: new Date().toISOString() }]);
    let nextId = conversationId;
    const held: { reply: { messageId?: string; content: string } | null } = { reply: null };
    try {
      const response = await fetch(`${API}/api/assistant/turn`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          conversationId: conversationId ?? undefined,
          message: text,
          ...(tierOverride ? { tier: tierOverride } : {}),
          page: {
            path: pathname,
            taskId: peekId ?? undefined,
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
          type?: string;
          call?: AssistantToolCallRecord;
          preview?: string;
          code?: string;
          model?: string;
          resetsAt?: string;
          saveFailed?: boolean;
        };
        if (event === "status") {
          if (frame.text) setWorking(frame.text);
          if (frame.conversationId) {
            nextId = frame.conversationId;
            conversationRef.current = frame.conversationId;
            setConversationId(frame.conversationId);
          }
        }
        if (event === "delta") setStreaming((value) => value + (frame.text ?? ""));
        if ((event === "tool" || event === "pending") && frame.call) {
          const call = frame.preview ? { ...frame.call, summary: frame.preview } : frame.call;
          setLiveTools((rows) => [...rows.filter((row) => row.id !== call.id), call]);
        }
        if (event === "error") {
          const mark = quotaMessage(frame);
          if (mark) {
            markModelOutOfQuota(mark);
            void client.invalidateQueries({ queryKey: ["models"] });
          }
          setTurnError(frame.message ?? "The model request failed.");
        }
        if (event === "done" && frame.conversationId) {
          nextId = frame.conversationId;
          if (frame.saveFailed && frame.content) held.reply = { messageId: frame.messageId, content: frame.content };
        }
      });
      setDraft("");
      if (nextId) setConversationId(nextId);
      await client.invalidateQueries({ queryKey: ["assistant-messages", nextId] });
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
                role: "assistant",
                content: kept.content,
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
    } catch (error) {
      if (isSilentCancellation(error, controller.signal)) {
        setTurnError(null);
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
        setDraft(text);
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

  const all = [...(messages.data?.messages ?? []), ...optimistic];

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [all.length, pending, streaming]);

  const mentionMatch = draft.match(/@([\w.-]*)$/);
  const mentionOptions = useMemo(() => {
    if (!mentionMatch) return [];
    const needle = mentionMatch[1]!.toLowerCase();
    return entities.entities.filter((entity) => entity.label.toLowerCase().includes(needle)).slice(0, 6);
  }, [mentionMatch, entities.entities]);

  const submit = () => {
    const text = draft.trim();
    if (!text || pending) return;
    void sendText(text);
  };

  const tiers = settings.data?.settings.models;

  if (!open) {
    if (peekId) return null;
    if (pathname.startsWith("/start")) return null;
    const chord = assistantChord || (mod === "⌘" ? "⌘J" : "Ctrl+J");
    return <AskLauncher onOpen={() => setOpen(true)} title={`Ask Ensemble (${chord}). Drag to move it.`} />;
  }

  return (
    <div
      className={cx(
        "pop-in fixed z-50 flex flex-col overflow-hidden rounded-xl border border-line-strong bg-raised shadow-pop",
        expanded ? "inset-x-[8vw] bottom-6 top-[6vh]" : "bottom-5 right-5 h-[min(640px,80vh)] w-[min(620px,92vw)]",
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <Mark />
        <span className="flex-1 text-[14px] font-semibold">Assistant</span>
        {working && !pending ? <ThinkingStatus real={working === "Assistant is thinking…" || working === "Working…" ? null : working} active /> : null}
        <button type="button" className="icon-btn" title="New chat" onClick={() => setConversationId(null)}>
          <Plus size={15} />
        </button>
        <button type="button" className="icon-btn" title={expanded ? "Shrink" : "Expand"} onClick={() => setExpanded(!expanded)}>
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button type="button" className="icon-btn" title={`Close (${mod === "⌘" ? "⌘J" : "Ctrl+J"})`} aria-label="Close" onClick={() => setOpen(false)}>
          <X size={15} />
        </button>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {all.length === 0 ? (
          <EmptyAssistant pathname={pathname} name={shell.data?.user?.name ?? null} onPick={(text) => void sendText(text)} />
        ) : (
          all.map((message) => (
            <Message key={message.id} message={message} conversationId={conversationId} onChoose={(choice) => void sendText(choice)} />
          ))
        )}
        {pending ? (
          <div className="space-y-2">
            {liveTools.map((call) => (
              <ToolCall key={call.id} call={call} conversationId={conversationId} />
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
                    <MarkdownText text={streaming} />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="relative shrink-0 border-t border-line p-3">
        {mentionOptions.length ? (
          <div className="absolute bottom-full left-3 mb-1 w-[320px] rounded-lg bg-raised p-1 shadow-pop">
            {mentionOptions.map((entity) => (
              <button
                key={`${entity.kind}-${entity.id}`}
                type="button"
                className="row-tile flex w-full items-center justify-between rounded px-2 py-1 text-left text-[13px]"
                onMouseDown={(event) => {
                  event.preventDefault();
                  setDraft(draft.replace(/@([\w.-]*)$/, `@${entity.label} `));
                }}
              >
                <span className="truncate">{entity.label}</span>
                <span className="text-2xs text-faint">{entity.kind}</span>
              </button>
            ))}
          </div>
        ) : null}
        {turnError && !all.some((message) => message.role === "assistant" && message.content === turnError) ? (
          <div className="mb-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
            {turnError}
            {/\bno key\b/i.test(turnError) ? (
              <>
                {" "}
                <Link href="/settings#models" className="font-medium underline">
                  Settings → Models
                </Link>
              </>
            ) : null}
          </div>
        ) : null}
        <div className="tile flex items-center gap-2 rounded-lg bg-panel px-3 py-2 focus-within:border-accent">
          <textarea
            ref={input}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Ask, or tell me what to change. @ to mention…"
            className="box-border h-6 max-h-40 min-h-6 flex-1 resize-none bg-transparent py-0 text-[13.5px] leading-6 outline-none placeholder:text-faint"
          />
          <button
            type="button"
            className="icon-btn border-line"
            onClick={pending ? stop : submit}
            disabled={!pending && !draft.trim()}
            aria-label={pending ? "Stop" : "Send"}
          >
            {pending ? <span className="text-[11px] font-semibold">Stop</span> : <ArrowUp size={15} />}
          </button>
        </div>
        <div className="mt-2 flex items-center gap-3 text-[12px] text-faint">
          <select
            value={tier}
            onChange={(event) => setTierOverride(event.target.value as Complexity)}
            className="field py-1 text-[12px]"
            aria-label="Complexity"
          >
            {(Object.keys(TIER_LABEL) as Complexity[]).map((key) => {
            const model = tiers?.[key].model;
            return (
              <option key={key} value={key}>
                {TIER_LABEL[key]} · {model ?? "…"}
                {quotaSuffix(model, quotas)}
              </option>
            );
          })}
          </select>
          <span>Enter to send · Model presets are configured in Settings</span>
        </div>
      </div>
    </div>
  );
}
