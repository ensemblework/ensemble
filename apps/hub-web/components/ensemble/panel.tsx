"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { quickActions, type ActAs } from "@ensemble/shared-types";
import { useEffect, useRef, useState } from "react";
import { API, ApiError, api, type AssistantToolCallRecord } from "@/lib/api";
import { isSilentCancellation } from "@/lib/fetch-cancel";
import { readSse } from "@/lib/sse";
import { ThinkingStatus } from "@/components/motion/slot";
import { MarkdownText } from "../markdown-text";
import { useToast } from "../toast";

type Citation = { kind: string; id?: string; url?: string; label: string; href?: string };

const ACTS: ActAs[] = ["general", "student", "engineer", "teacher", "lawyer"];

function ProposalCard({ call, onApply }: { call: AssistantToolCallRecord; onApply: () => void }) {
  const toast = useToast();
  const client = useQueryClient();
  const [local, setLocal] = useState<"applied" | "undone" | null>(null);
  const entryId = call.undoEntryId ?? null;
  const phase = local ?? (call.state === "undone" ? "undone" : call.state === "ok" ? "applied" : "pending");
  useEffect(() => {
    const onUndo = (event: Event) => {
      const detail = (event as CustomEvent<{ entryId?: string; direction?: string }>).detail;
      if (!entryId || detail?.entryId !== entryId) return;
      setLocal(detail.direction === "redo" ? "applied" : "undone");
    };
    window.addEventListener("ensemble:undo", onUndo);
    return () => window.removeEventListener("ensemble:undo", onUndo);
  }, [entryId]);
  const history = async (direction: "undo" | "redo") => {
    if (!entryId) return;
    try {
      if (direction === "undo") await api.undo(entryId);
      else await api.redo(entryId);
      setLocal(direction === "undo" ? "undone" : "applied");
      void client.invalidateQueries();
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    }
  };
  return (
    <div className="mt-2 rounded-md border border-line bg-bg p-2">
      <div className="text-[13px]">{call.summary || call.name}</div>
      {phase === "pending" ? (
        <button type="button" className="btn-primary mt-2 h-7 px-2 text-[12px]" onClick={onApply}>
          Apply
        </button>
      ) : (
        <div className="mt-1 flex items-center gap-2 text-[12px] text-muted">
          <span>{phase === "undone" ? "Undone" : "Applied"}</span>
          {phase === "applied" && entryId ? (
            <button type="button" className="btn h-7 px-2 text-[12px]" onClick={() => void history("undo")}>
              Undo
            </button>
          ) : null}
          {phase === "undone" && entryId ? (
            <button type="button" className="btn h-7 px-2 text-[12px]" onClick={() => void history("redo")}>
              Redo
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function EnsemblePanel({
  surface,
  anchorKey,
  entityIds,
  selection,
  codeText,
  path,
  line,
  projectId,
  contextLabel,
  onClose,
  onCitations,
}: {
  surface: string;
  anchorKey: string;
  entityIds?: string[];
  selection?: string;
  codeText?: string;
  path?: string;
  line?: number;
  projectId?: string;
  contextLabel?: string;
  onClose: () => void;
  onCitations?: (ids: string[]) => void;
}) {
  const toast = useToast();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const saved = settings.data?.settings.assistant.actAs ?? "general";
  const [actAs, setActAs] = useState<ActAs | "">("");
  const effective = (actAs || saved) as ActAs;
  const [prompt, setPrompt] = useState("");
  const [text, setText] = useState("");
  const [calls, setCalls] = useState<AssistantToolCallRecord[]>([]);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [statusText, setStatusText] = useState("");
  const errorRef = useRef("");
  const [replyId, setReplyId] = useState<string | null>(null);
  const conversationRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const hydrated = useRef(false);
  const past = useQuery({
    queryKey: ["ensemble-replies", surface, anchorKey],
    queryFn: () => api.ensembleReplies(surface, anchorKey),
  });

  useEffect(() => {
    if (hydrated.current || working || !past.data) return;
    hydrated.current = true;
    const latest = past.data.replies[0];
    if (!latest) return;
    setText(latest.content);
    setCalls(latest.toolCalls ?? []);
    setCitations(latest.citations ?? []);
    setReplyId(latest.id);
    onCitations?.((latest.citations ?? []).map((row) => row.id).filter((id): id is string => Boolean(id)));
  }, [past.data, working, onCitations]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = async (value: string) => {
    const message = value.trim();
    if (!message || working) return;
    setWorking(true);
    setError("");
    errorRef.current = "";
    setStatusText("");
    setText("");
    setCalls([]);
    setCitations([]);
    if (/^mock\s+\d{1,4}\s*\/\s*\d{1,4}\b/i.test(message) || /^hearing\s+.+\d{1,2}\s+[A-Za-z]{3,9}\b/i.test(message)) {
      try {
        const result = await api.ask(message);
        setText(result.answer);
        setPrompt("");
        if (result.undoEntryId) {
          const entryId = result.undoEntryId;
          toast(result.answer, {
            action: {
              label: "Undo",
              run: () => {
                void api
                  .undo(entryId)
                  .then(() => client.invalidateQueries({ queryKey: ["desk-live"] }))
                  .catch((error: Error) => toast(error.message, { tone: "error" }));
              },
            },
          });
        }
        void client.invalidateQueries({ queryKey: ["desk-live"] });
      } catch (caught) {
        setError((caught as Error).message);
      } finally {
        setWorking(false);
      }
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    let nextId: string | null = null;
    try {
      const response = await fetch(`${API}/api/ensemble/invoke`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          surface,
          prompt: message,
          anchorKey,
          entityIds,
          selection,
          codeText,
          path,
          line,
          projectId,
          ...(actAs ? { actAs } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const raw = await response.text();
        let detail = raw;
        try {
          const parsed = JSON.parse(raw) as { error?: string };
          if (parsed.error) detail = parsed.error;
        } catch {
          // keep the raw body
        }
        throw new ApiError(detail || "Ensemble could not answer.", response.status);
      }
      await readSse(response, (event, data) => {
        const frame = data as {
          text?: string;
          content?: string;
          message?: string;
          conversationId?: string;
          id?: string;
          replyId?: string;
          call?: AssistantToolCallRecord;
          preview?: string;
          toolCalls?: AssistantToolCallRecord[];
          citations?: Citation[];
        };
        if (event === "status") {
          if (frame.text) setStatusText(frame.text);
          if (frame.conversationId) conversationRef.current = frame.conversationId;
          if (frame.replyId) nextId = frame.replyId;
        }
        if (event === "delta" && frame.text) setText((current) => current + frame.text);
        if ((event === "pending" || event === "tool") && frame.call) {
          const call = frame.call;
          setCalls((current) => {
            const rest = current.filter((row) => row.id !== call.id);
            return [...rest, { ...call, summary: call.summary || frame.preview }];
          });
        }
        if (event === "error") {
          errorRef.current = frame.message ?? "Ensemble could not answer.";
          setError(errorRef.current);
        }
        if (event === "done") {
          if (frame.content && frame.content !== errorRef.current) setText(frame.content);
          if (frame.toolCalls) setCalls(frame.toolCalls);
          if (frame.citations) {
            setCitations(frame.citations);
            onCitations?.(frame.citations.map((row) => row.id).filter((id): id is string => Boolean(id)));
          }
          if (frame.id) {
            nextId = frame.id;
            setReplyId(frame.id);
          }
          if (frame.conversationId) conversationRef.current = frame.conversationId;
        }
      });
      void client.invalidateQueries({ queryKey: ["ensemble-replies", surface, anchorKey] });
    } catch (caught) {
      if (isSilentCancellation(caught, controller.signal)) setText((current) => current || "Stopped.");
      else setError((caught as Error).message);
    } finally {
      setWorking(false);
      abortRef.current = null;
      if (nextId) setReplyId(nextId);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    const id = conversationRef.current;
    if (id) void api.stopAssistant(id);
  };

  const apply = async (call: AssistantToolCallRecord) => {
    try {
      const result = await api.applyAssistant({
        name: call.name,
        input: call.input ?? {},
        conversationId: conversationRef.current ?? undefined,
        callId: call.id,
      });
      if (replyId) await api.markEnsembleApplied(replyId, call.id, result.undoEntryId);
      setCalls((current) =>
        current.map((row) => (row.id === call.id ? { ...row, state: "ok", summary: result.summary, undoEntryId: result.undoEntryId } : row)),
      );
      toast(result.summary || "Applied.", {
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
      void client.invalidateQueries({ queryKey: ["watchers"] });
      void client.invalidateQueries({ queryKey: ["tasks"] });
    } catch (caught) {
      toast((caught as Error).message, { tone: "error" });
    }
  };

  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const suggestions = quickActions(effective, surface, shell.data?.highlights);

  return (
    <div className="rounded-lg border border-line bg-panel p-3 shadow-pop" role="dialog" aria-label="Ensemble answer">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[13px] font-semibold">Ensemble</div>
        <select
          aria-label="Act as"
          className="field h-7 py-0 text-[12px]"
          value={effective}
          onChange={(event) => setActAs(event.target.value as ActAs)}
        >
          {ACTS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <button type="button" className="btn h-7 px-2 text-[12px]" onClick={onClose}>
          Close
        </button>
      </div>
      {contextLabel ? <div className="mb-2 text-[12px] text-muted">{contextLabel}</div> : null}
      <div className="mb-2 flex flex-wrap gap-1">
        {suggestions.map((line) => (
          <button key={line} type="button" className="btn h-7 px-2 text-[12px]" onClick={() => void send(line)}>
            {line}
          </button>
        ))}
      </div>
      <div className="max-h-[280px] overflow-y-auto text-[13.5px] leading-5">
        {text ? (
          <div className="m-stream" data-motion-slot="reply.stream" data-state={working ? "streaming" : "done"}>
            <MarkdownText text={text} />
          </div>
        ) : working ? (
          <ThinkingStatus real={statusText && statusText !== "Working…" ? statusText : null} active />
        ) : (
          <div className="text-muted">Ask about what is on this screen.</div>
        )}
        {error ? <div className="mt-2 text-[#ffb4ae]">{error}</div> : null}
        {calls
          .filter((call) => call.isWrite || call.state === "awaiting_approval" || call.state === "ok" || call.state === "undone")
          .map((call) => (
            <ProposalCard key={call.id} call={call} onApply={() => void apply(call)} />
          ))}
        {citations.length ? (
          <ul className="mt-2 space-y-1 text-[12px] text-muted">
            {citations.map((row) => {
              const href = row.href ?? row.url;
              return (
                <li key={row.id ?? row.url ?? row.label}>
                  {href ? (
                    <a href={href} className="text-accent hover:underline" target={row.url ? "_blank" : undefined} rel={row.url ? "noreferrer" : undefined}>
                      {row.label}
                    </a>
                  ) : (
                    row.label
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const value = String(new FormData(event.currentTarget).get("prompt") ?? prompt);
          void send(value);
        }}
      >
        <input
          name="prompt"
          aria-label="Ask Ensemble on this surface"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Ask about this"
          className="field h-8 flex-1 text-[13px]"
        />
        {working ? (
          <button type="button" className="btn h-8 px-2 text-[12px]" aria-label="Stop Ensemble" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn-primary h-8 px-2 text-[12px]" aria-label="Send to Ensemble">
            Send
          </button>
        )}
      </form>
    </div>
  );
}
