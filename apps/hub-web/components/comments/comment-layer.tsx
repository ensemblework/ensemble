"use client";

import type { Editor } from "@tiptap/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type PageComment } from "@/lib/api";
import { MarkdownText } from "../markdown-text";
import { ensembleNodeRequest } from "./ensemble-prompt";
import type { PageDocument } from "@ensemble/shared-types";
import { ENTITY_MENTION_KEY } from "../editor/extensions";
import { retargetEnsembleReply } from "./ensemble-artifacts";
import { useToast } from "../toast";
import { streamEnsemble } from "./ensemble-view";

function clampBox(top: number, left: number, width: number, height: number) {
  if (typeof window === "undefined") return { top, left };
  const margin = 8;
  const y = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
  const x = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  return { top: y, left: x };
}

function textOf(body: PageComment["body"]): string {
  if (typeof body?.text === "string") return body.text;
  return "";
}

export function CommentLayer({
  editor,
  pageKind,
  pageId,
}: {
  editor: Editor | null;
  pageKind: string;
  pageId: string;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const comments = useQuery({ queryKey: ["comments", pageKind, pageId], queryFn: () => api.comments(pageKind, pageId) });
  const [selection, setSelection] = useState<{ text: string; top: number; left: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [pageDraft, setPageDraft] = useState("");
  const [hover, setHover] = useState<{ top: number; left: number; from: number; to: number } | null>(null);
  const [frame, setFrame] = useState(0);
  const hoverTimer = useRef(0);
  const rangeRef = useRef<{ from: number; to: number } | null>(null);
  const quoteRef = useRef("");
  const activeRef = useRef<string | null>(null);
  activeRef.current = active;

  useEffect(() => {
    const bump = () => setFrame((value) => value + 1);
    window.addEventListener("resize", bump);
    window.addEventListener("scroll", bump, true);
    return () => {
      window.removeEventListener("resize", bump);
      window.removeEventListener("scroll", bump, true);
    };
  }, []);

  useEffect(() => {
    if (!editor) return;
    const refresh = () => {
      const { from, to } = editor.state.selection;
      if (from === to) {
        setSelection((current) => (activeRef.current === "new" ? current : null));
        return;
      }
      const text = editor.state.doc.textBetween(from, to, " ").trim();
      if (!text) {
        setSelection((current) => (activeRef.current === "new" ? current : null));
        return;
      }
      const coords = editor.view.coordsAtPos(from);
      rangeRef.current = { from, to };
      quoteRef.current = text;
      setSelection({ text, top: coords.top, left: coords.left });
    };
    editor.on("selectionUpdate", refresh);
    return () => {
      editor.off("selectionUpdate", refresh);
    };
  }, [editor]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        if (selection) setDraft(selection.text ? "" : "");
        setActive("new");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection]);

  useEffect(() => {
    const open = () => {
      setActive("page");
      setPageDraft("");
    };
    window.addEventListener("ensemble:page-comment", open);
    return () => window.removeEventListener("ensemble:page-comment", open);
  }, []);

  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const clearSoon = () => {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = window.setTimeout(() => setHover(null), 400);
    };
    const move = (event: MouseEvent) => {
      const block = (event.target as HTMLElement | null)?.closest(".ProseMirror > *");
      if (!block || !dom.contains(block)) {
        clearSoon();
        return;
      }
      window.clearTimeout(hoverTimer.current);
      try {
        const pos = editor.view.posAtDOM(block, 0);
        const resolved = editor.state.doc.resolve(Math.min(pos, editor.state.doc.content.size));
        const from = resolved.depth > 0 ? resolved.start() : pos;
        const to = resolved.depth > 0 ? resolved.end() : pos;
        const box = block.getBoundingClientRect();
        const next = { top: box.top + 4, left: box.left - 28, from, to };
        setHover((current) => (current && current.from === from && current.to === to ? current : next));
      } catch {
        clearSoon();
      }
    };
    dom.addEventListener("mousemove", move);
    dom.addEventListener("mouseleave", clearSoon);
    return () => {
      window.clearTimeout(hoverTimer.current);
      dom.removeEventListener("mousemove", move);
      dom.removeEventListener("mouseleave", clearSoon);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const onKey = (_view: unknown, event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || !editor.isEditable) return false;
      const { $from } = editor.state.selection;
      if ($from.parent.type.name === "codeBlock") return false;
      const suggestion = ENTITY_MENTION_KEY.getState(editor.state);
      if (suggestion?.active && !suggestion.query.toLowerCase().startsWith("ensemble")) return false;
      const slice = ensembleNodeRequest($from.parent, $from.parentOffset);
      if (!slice) return false;
      event.preventDefault();
      event.stopPropagation();
      const prompt = slice.prompt;
      const start = $from.start();
      const cut = start + slice.at;
      const caret = start + slice.caret;
      const threadId = crypto.randomUUID();
      editor
        .chain()
        .focus()
        .deleteRange({ from: cut, to: caret })
        .insertContentAt(cut, {
          type: "ensembleReply",
          attrs: { threadId, prompt, pageKind, pageId },
        })
        .run();
      void streamEnsemble({
        pageKind,
        pageId,
        prompt,
        threadId,
        content: editor.getJSON() as PageDocument,
        mentions: slice.mentions,
        onServerId: (id) => {
          retargetEnsembleReply(editor, threadId, id);
          void client.invalidateQueries({ queryKey: ["comments", pageKind, pageId] });
        },
      });
      return true;
    };
    const handler = (event: KeyboardEvent) => {
      onKey(null, event);
    };
    editor.view.dom.addEventListener("keydown", handler, true);
    return () => editor.view.dom.removeEventListener("keydown", handler, true);
  }, [editor, pageKind, pageId, client]);

  const presentMarks = useMemo(() => {
    const ids = new Set<string>();
    editor?.state.doc.descendants((node) => {
      for (const mark of node.marks) {
        if (mark.type.name === "comment" && mark.attrs.id) ids.add(String(mark.attrs.id));
      }
    });
    return ids;
  }, [editor, comments.data]);

  const create = useMutation({
    mutationFn: (input: { quote: string; text: string; markId?: string }) =>
      api.createComment(pageKind, pageId, { markId: input.markId, quote: input.quote, body: { text: input.text } }),
    onSuccess: async (result, input) => {
      const range = rangeRef.current;
      if (editor && input.markId && range) {
        editor
          .chain()
          .focus()
          .setTextSelection(range)
          .setMark("comment", { id: input.markId, commentId: result.comment.id })
          .run();
      }
      setDraft("");
      setActive(result.comment.id);
      setSelection(null);
      await client.invalidateQueries({ queryKey: ["comments", pageKind, pageId] });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });

  const roots = (comments.data?.comments ?? []).filter((row) => !row.parentId && row.kind !== "ensemble");
  const childrenOf = (id: string) => (comments.data?.comments ?? []).filter((row) => row.parentId === id);
  const showMargin = roots.length > 0 || active === "page";

  useEffect(() => {
    const host = editor?.view.dom.closest(".comment-host");
    if (!host) return;
    host.classList.toggle("has-comments", showMargin);
    return () => host.classList.remove("has-comments");
  }, [editor, showMargin]);

  const bubbleTop = useMemo(() => {
    const placed = new Map<string, number>();
    const host = editor?.view.dom.closest(".comment-host");
    if (!host) return placed;
    const hostTop = host.getBoundingClientRect().top;
    let cursor = active === "page" ? 168 : 0;
    for (const row of roots) {
      let raw = cursor;
      if (row.markId) {
        const mark = host.querySelector(`[data-comment-id="${CSS.escape(row.markId)}"]`);
        if (mark) raw = mark.getBoundingClientRect().top - hostTop;
      }
      const top = Math.max(cursor, raw);
      placed.set(row.id, top);
      cursor = top + 148;
    }
    return placed;
    // frame bumps this after scroll and resize so bubbles track their marks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, roots, active, frame, comments.data]);

  return (
    <>
      {selection && active !== "new" ? (
        <button
          type="button"
          className="btn-primary fixed z-40"
          style={clampBox(selection.top - 36, selection.left, 96, 32)}
          data-frame={frame}
          onMouseDown={(event) => {
            event.preventDefault();
            setActive("new");
            setDraft("");
          }}
        >
          Comment
        </button>
      ) : null}
      {active === "new" && selection ? (
        <form
          className="fixed z-40 w-72 max-w-[calc(100vw-16px)] rounded-lg border border-line bg-raised p-2 shadow-pop"
          style={clampBox(
            selection.top + 180 > window.innerHeight - 8 ? selection.top - 188 : selection.top - 8,
            selection.left,
            288,
            180,
          )}
          onSubmit={(event) => {
            event.preventDefault();
            const markId = crypto.randomUUID();
            create.mutate({ quote: selection?.text || quoteRef.current, text: draft.trim(), markId });
          }}
        >
          <div className="mb-1 line-clamp-2 text-[12px] text-muted">“{selection.text}”</div>
          <textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Comment"
            placeholder="Comment. People can't reply, @ensemble can."
            className="field min-h-16 w-full"
          />
          <div className="mt-2 flex gap-2">
            <button type="submit" className="btn-primary" disabled={!draft.trim() || create.isPending}>
              Comment
            </button>
            <button type="button" className="btn" onClick={() => setActive(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {hover && active !== "new" && !selection ? (
        <button
          type="button"
          className="comment-block-action"
          style={{ top: hover.top, left: Math.max(8, hover.left) }}
          aria-label="Comment on this block"
          onMouseEnter={() => window.clearTimeout(hoverTimer.current)}
          onMouseLeave={() => {
            hoverTimer.current = window.setTimeout(() => setHover(null), 400);
          }}
          onMouseDown={(event) => {
            event.preventDefault();
            if (!editor) return;
            const text = editor.state.doc.textBetween(hover.from, hover.to, " ").trim();
            if (!text) return;
            rangeRef.current = { from: hover.from, to: hover.to };
            quoteRef.current = text;
            const coords = editor.view.coordsAtPos(hover.from);
            setSelection({ text, top: coords.top, left: coords.left });
            setActive("new");
            setDraft("");
          }}
        >
          +
        </button>
      ) : null}
      {showMargin ? (
        <div className="comment-margin" aria-label="Comments">
          {active === "page" ? (
            <form
              className="comment-bubble"
              style={{ top: 0 }}
              onSubmit={(event) => {
                event.preventDefault();
                if (!pageDraft.trim()) return;
                create.mutate({ quote: "", text: pageDraft.trim() });
                setPageDraft("");
                setActive(null);
              }}
            >
              <textarea
                value={pageDraft}
                onChange={(event) => setPageDraft(event.target.value)}
                aria-label="Page comment"
                placeholder="A note on the whole page. @ensemble can answer."
                className="field min-h-16 w-full"
              />
              <div className="mt-2 flex gap-2">
                <button type="submit" className="btn-primary" disabled={!pageDraft.trim()}>
                  Comment
                </button>
                <button type="button" className="btn" onClick={() => setActive(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
          {roots.map((row) => (
            <div key={row.id} className="comment-bubble" style={{ top: bubbleTop.get(row.id) ?? 0 }} data-comment-bubble>
              <Thread
                row={row}
                replies={childrenOf(row.id)}
                orphan={Boolean(row.markId) && !presentMarks.has(row.markId!)}
                pageKind={pageKind}
                pageId={pageId}
                active={active === row.id}
                onOpen={() => setActive(row.id)}
              />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function Thread({
  row,
  replies,
  orphan,
  pageKind,
  pageId,
  active,
  onOpen,
}: {
  row: PageComment;
  replies: PageComment[];
  orphan: boolean;
  pageKind: string;
  pageId: string;
  active: boolean;
  onOpen: () => void;
}) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(textOf(row.body));
  const [ask, setAsk] = useState("");
  const save = useMutation({
    mutationFn: () => api.patchComment(row.id, { body: { text } }),
    onSuccess: () => {
      setEditing(false);
      void client.invalidateQueries({ queryKey: ["comments", pageKind, pageId] });
    },
  });
  const resolve = useMutation({
    mutationFn: () => api.patchComment(row.id, { status: row.status === "resolved" ? "open" : "resolved" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["comments", pageKind, pageId] }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteComment(row.id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["comments", pageKind, pageId] }),
  });
  return (
    <article className={`rounded-lg px-2 py-2 ${active ? "bg-accent-soft" : ""}`} onClick={onOpen}>
      {row.quote ? <div className="mb-1 border-l-2 border-accent pl-2 text-[12px] text-muted">“{row.quote}”</div> : null}
      {orphan ? <div className="mb-1 text-[12px] text-warn">The highlighted text was removed. “{row.quote}”</div> : null}
      {editing ? (
        <textarea aria-label="Edit comment" value={text} onChange={(event) => setText(event.target.value)} className="field min-h-16 w-full" />
      ) : (
        <MarkdownText text={textOf(row.body)} />
      )}
      <div className="mt-1 flex flex-wrap gap-1">
        {editing ? (
          <button type="button" className="btn" onClick={() => save.mutate()}>
            Save
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        <button type="button" className="btn" onClick={() => resolve.mutate()}>
          {row.status === "resolved" ? "Reopen" : "Resolve"}
        </button>
        <button type="button" className="btn" onClick={() => remove.mutate()}>
          Delete
        </button>
      </div>
      {replies.map((reply) => (
        <div key={reply.id} className="ensemble-reply mt-2">
          <div className="ensemble-reply-rule" />
          <div>
            <div className="text-[12px] font-medium">Ensemble {reply.tier ? `· ${reply.tier}` : ""}</div>
            <MarkdownText text={textOf(reply.body)} />
          </div>
        </div>
      ))}
      <form
        className="mt-2 flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const prompt = String(new FormData(event.currentTarget).get("prompt") ?? ask).trim();
          if (!prompt) return;
          const threadId = crypto.randomUUID();
          setAsk("");
          void streamEnsemble({ pageKind, pageId, prompt, threadId, parentId: row.id, quote: row.quote }).then(() =>
            client.invalidateQueries({ queryKey: ["comments", pageKind, pageId] }),
          );
        }}
      >
        <input
          name="prompt"
          value={ask}
          onChange={(event) => setAsk(event.target.value)}
          aria-label="Ask Ensemble"
          placeholder="@ensemble…"
          className="field flex-1 py-1 text-[12.5px]"
        />
      </form>
    </article>
  );
}
