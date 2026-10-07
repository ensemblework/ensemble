"use client";

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ThinkingStatus } from "@/components/motion/slot";
import { Mark } from "../mark";
import { MarkdownText } from "../markdown-text";
import { api, type AssistantToolCallRecord } from "@/lib/api";
import { API } from "@/lib/api";
import { isSilentCancellation } from "@/lib/fetch-cancel";
import { readSse } from "@/lib/sse";
import { beginPageEnsemble, publishEnsemble, readEnsemble, subscribeEnsemble, type EnsembleLive } from "./ensemble-bus";
import type { PageDocument, PageMention } from "@ensemble/shared-types";
import { attachEnsembleArtifacts, retargetEnsembleReply } from "./ensemble-artifacts";
import { useToast } from "../toast";

export function EnsembleView({ node, deleteNode, editor }: NodeViewProps) {
  const client = useQueryClient();
  const threadId = String(node.attrs.threadId ?? "");
  const pageKind = String(node.attrs.pageKind ?? "task");
  const pageId = String(node.attrs.pageId ?? "");
  const [live, setLive] = useState<EnsembleLive | undefined>(() => (threadId ? readEnsemble(threadId) : undefined));
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const comments = useQuery({
    queryKey: ["comments", pageKind, pageId],
    queryFn: () => api.comments(pageKind, pageId),
    enabled: Boolean(pageId && threadId),
  });
  const saved = comments.data?.comments.find((row) => row.id === threadId);

  useEffect(() => {
    if (!threadId) return;
    return subscribeEnsemble(threadId, () => setLive(readEnsemble(threadId)));
  }, [threadId]);

  const text = live?.text || (typeof saved?.body?.text === "string" ? saved.body.text : "");
  const streaming = live?.status === "streaming";
  const model = live?.model || saved?.model || "";
  const tier = live?.tier || saved?.tier || "";
  const calls = live?.toolCalls ?? saved?.toolCalls ?? [];
  const conversationId = live?.conversationId ?? saved?.conversationId ?? undefined;
  const callKey = JSON.stringify(calls);

  useEffect(() => {
    attachEnsembleArtifacts(editor, threadId, calls);
    // Calls are the stream's snapshot. Selection and document edits must not replay an attachment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, threadId, callKey]);

  const retry = () => {
    const prompt = String(node.attrs.prompt ?? "");
    if (!prompt || !pageId) return;
    void streamEnsemble({
      pageKind, pageId, prompt, threadId, content: editor.getJSON() as PageDocument,
      onServerId: (id) => {
        retargetEnsembleReply(editor, threadId, id);
        void client.invalidateQueries({ queryKey: ["comments", pageKind, pageId] });
      },
    });
  };

  return (
    <NodeViewWrapper className="ensemble-reply" data-streaming={streaming || undefined}>
      <div className="ensemble-reply-rule" contentEditable={false} />
      <div className="min-w-0 flex-1" contentEditable={false}>
        <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((value) => !value)}>
          <Mark />
          <span className="text-[12.5px] font-medium">Ensemble</span>
          {tier ? <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] text-ink">{tier}</span> : null}
          {model ? <span className="truncate text-[11px] text-faint">{model}</span> : null}
          <span className="flex-1" />
          <span className="text-[11px] text-faint">{open ? "Hide" : "Show"}</span>
        </button>
        {open ? (
          <div className="mt-2 space-y-2">
            {streaming && !text ? (
              <ThinkingStatus real={live?.note && live.note !== "Working…" ? live.note : null} active />
            ) : (
              <div className="m-stream" data-motion-slot="reply.stream" data-state={streaming ? "streaming" : "done"}>
                <MarkdownText text={text || "…"} />
              </div>
            )}
            {live?.error || saved?.error ? (
              <div className="text-[12.5px] text-danger" data-motion-slot="state.error" data-state="error">
                {live?.error || saved?.error}
              </div>
            ) : null}
            {calls.filter((call) => call.isWrite && !(call.state === "ok" && ["hub_create_plot", "hub_create_diagram"].includes(call.name))).map((call) => (
              <InlineToolCall key={call.id} call={call} conversationId={conversationId} threadId={threadId} />
            ))}
            <div className="flex flex-wrap gap-1">
              {streaming ? (
                <button type="button" className="btn" onClick={() => abortEnsemble(threadId)}>
                  Stop
                </button>
              ) : (
                <button type="button" className="btn" onClick={retry}>
                  <RotateCcw size={12} /> Retry
                </button>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(text);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />} Copy
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const pos = editor.state.selection.from;
                  editor.chain().focus().insertContentAt(pos, text.split(/\n{2,}/).map((paragraph) => ({ type: "paragraph", content: paragraph ? [{ type: "text", text: paragraph }] : [] }))).run();
                }}
              >
                Insert into page
              </button>
              {editor.isEditable ? (
                <button type="button" className="btn" onClick={() => deleteNode()}>
                  <Trash2 size={12} /> Delete
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </NodeViewWrapper>
  );
}

function InlineToolCall({ call, conversationId, threadId }: { call: AssistantToolCallRecord; conversationId?: string; threadId: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const apply = useMutation({
    mutationFn: () => api.applyAssistant({ name: call.name, input: call.input, callId: call.id, conversationId }),
    onSuccess: (result) => {
      const current = readEnsemble(threadId);
      if (current) publishEnsemble(threadId, { ...current, toolCalls: current.toolCalls?.map((item) => item.id === call.id ? { ...item, state: "ok", summary: result.summary, href: result.href ?? undefined } : item) });
      void client.invalidateQueries();
      toast(result.summary, { tone: "ok" });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  return (
    <div className="flex items-center gap-2 rounded-md border border-line px-2 py-1 text-[12px]">
      <span className={call.state === "failed" ? "text-danger" : "text-muted"}>{call.error || call.summary || call.name}</span>
      {call.state === "awaiting_approval" ? <button type="button" className="btn ml-auto" disabled={apply.isPending} onClick={() => apply.mutate()}>Apply</button> : call.state === "ok" ? <span className="ml-auto text-muted">Done</span> : null}
    </div>
  );
}

const controllers = new Map<string, AbortController>();

export function abortEnsemble(id: string): void {
  controllers.get(id)?.abort();
}

export async function streamEnsemble(input: {
  pageKind: string;
  pageId: string;
  prompt: string;
  threadId: string;
  parentId?: string;
  quote?: string;
  content?: PageDocument;
  mentions?: PageMention[];
  onServerId?: (id: string) => void;
}): Promise<void> {
  const controller = new AbortController();
  const releasePage = beginPageEnsemble(input.pageKind, input.pageId);
  let serverId = input.threadId;
  controllers.set(input.threadId, controller);
  publishEnsemble(input.threadId, { text: "", status: "streaming" });
  try {
    const response = await fetch(`${API}/api/pages/${input.pageKind}/${input.pageId}/ensemble`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ prompt: input.prompt, parentId: input.parentId, quote: input.quote, content: input.content, mentions: input.mentions }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(raw || "Ensemble could not answer.");
    }
    let text = "";
    let model = "";
    let tier = "";
    let conversationId: string | undefined;
    let error: string | undefined;
    let note: string | undefined;
    let calls: AssistantToolCallRecord[] = [];
    let complete = false;
    const publish = (status: EnsembleLive["status"]) => {
      const next = { text, status, note, error, model, tier, toolCalls: calls, conversationId };
      publishEnsemble(input.threadId, next);
      if (serverId !== input.threadId) publishEnsemble(serverId, next);
    };
    const acceptId = (id?: string) => {
      if (!id || id === serverId) return;
      serverId = id;
      controllers.set(serverId, controller);
      publish("streaming");
      input.onServerId?.(serverId);
    };
    await readSse(response, (event, data) => {
      const frame = data as { text?: string; message?: string; model?: string; tier?: string; content?: string; id?: string; call?: AssistantToolCallRecord; toolCalls?: AssistantToolCallRecord[]; conversationId?: string };
      if (frame.conversationId) conversationId = frame.conversationId;
      if (event === "status" && frame.text) {
        note = frame.text;
        acceptId(frame.id);
        publish("streaming");
      }
      if (event === "delta" && frame.text) {
        text += frame.text;
        publish("streaming");
      }
      if ((event === "tool" || event === "pending") && frame.call) {
        calls = [...calls.filter((call) => call.id !== frame.call!.id), frame.call];
        publish("streaming");
      }
      if (event === "error") {
        error = frame.message || "Ensemble could not answer.";
        publish("error");
      }
      if (event === "done") {
        complete = true;
        text = frame.content || text;
        model = frame.model || model;
        tier = frame.tier || tier;
        calls = frame.toolCalls ?? calls;
        acceptId(frame.id);
      }
    });
    if (!complete) throw new Error("Ensemble's response ended before it finished. Retry to continue.");
    publish(error ? "error" : "open");
  } catch (error) {
    const current = readEnsemble(input.threadId);
    const stopped = isSilentCancellation(error, controller.signal);
    const next: EnsembleLive = {
      ...current,
      text: current?.text ?? "",
      status: stopped ? "open" : "error",
      error: stopped ? "Stopped." : current?.error || (error instanceof Error ? error.message : "Ensemble could not answer."),
    };
    publishEnsemble(input.threadId, next);
    if (serverId !== input.threadId) publishEnsemble(serverId, next);
  } finally {
    releasePage();
    for (const id of [input.threadId, serverId]) {
      if (controllers.get(id) === controller) controllers.delete(id);
    }
  }
}
