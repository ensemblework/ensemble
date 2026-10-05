"use client";

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ThinkingStatus } from "@/components/motion/slot";
import { Mark } from "../mark";
import { MarkdownText } from "../markdown-text";
import { api } from "@/lib/api";
import { API } from "@/lib/api";
import { isSilentCancellation } from "@/lib/fetch-cancel";
import { readSse } from "@/lib/sse";
import { publishEnsemble, readEnsemble, subscribeEnsemble, type EnsembleLive } from "./ensemble-bus";

export function EnsembleView({ node, deleteNode, editor }: NodeViewProps) {
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

  const retry = () => {
    const prompt = String(node.attrs.prompt ?? "");
    if (!prompt || !pageId) return;
    void streamEnsemble({ pageKind, pageId, prompt, threadId });
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
            {live?.error ? (
              <div className="text-[12.5px] text-danger" data-motion-slot="state.error" data-state="error">
                {live.error}
              </div>
            ) : null}
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
  onServerId?: (id: string) => void;
}): Promise<void> {
  const controller = new AbortController();
  controllers.set(input.threadId, controller);
  publishEnsemble(input.threadId, { text: "", status: "streaming" });
  try {
    const response = await fetch(`${API}/api/pages/${input.pageKind}/${input.pageId}/ensemble`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ prompt: input.prompt, parentId: input.parentId, quote: input.quote }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(raw || "Ensemble could not answer.");
    }
    let text = "";
    let model = "";
    let tier = "";
    await readSse(response, (event, data) => {
      const frame = data as { text?: string; message?: string; model?: string; tier?: string; content?: string };
      if (event === "status" && frame.text) {
        publishEnsemble(input.threadId, { text, status: "streaming", note: frame.text, model, tier });
      }
      if (event === "delta" && frame.text) {
        text += frame.text;
        publishEnsemble(input.threadId, { text, status: "streaming", model, tier });
      }
      if (event === "error") publishEnsemble(input.threadId, { text, status: "error", error: frame.message, model, tier });
      if (event === "done") {
        text = frame.content || text;
        model = frame.model || model;
        tier = frame.tier || tier;
        const serverId = (data as { id?: string }).id;
        if (serverId && serverId !== input.threadId) input.onServerId?.(serverId);
      }
    });
    publishEnsemble(input.threadId, { text, status: "open", model, tier });
  } catch (error) {
    if (isSilentCancellation(error, controller.signal)) {
      const current = readEnsemble(input.threadId);
      publishEnsemble(input.threadId, { text: current?.text ?? "", status: "open", error: "Stopped." });
    } else {
      publishEnsemble(input.threadId, { text: "", status: "error", error: (error as Error).message });
    }
  } finally {
    controllers.delete(input.threadId);
  }
}
