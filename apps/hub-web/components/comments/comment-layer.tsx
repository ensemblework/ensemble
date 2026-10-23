"use client";

import { Check, MessageSquare, X } from "lucide-react";
import type { Editor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, type PageComment } from "@/lib/api";
import { MarkdownText } from "../markdown-text";
import type { PageDocument, PageMention } from "@ensemble/shared-types";
import { useToast } from "../toast";
import { streamEnsemble } from "./ensemble-view";
import { useInlineEnsemble } from "./inline-ensemble";
import { MentionPopover, useMentionMenu } from "../mentions/mention-menu";
import { MentionTextarea } from "../mentions/mention-field";
import { COMMENT_BLOCK_EVENT } from "../editor/block-controls";
import { ModalScope, useLayerZ } from "../ui";
import { useModalFocus } from "@/lib/modal-focus";
import { relative } from "@/lib/format";

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

/** Viewport coordinates of a document position, or null when the position does not exist (any more). */
function coordsAt(editor: Editor, pos: number): { top: number; left: number; bottom: number } | null {
  if (pos < 0 || pos > editor.state.doc.content.size) return null;
  try {
    return editor.view.coordsAtPos(pos);
  } catch {
    return null;
  }
}

type Selected = { text: string; top: number; left: number; bottom: number };

const BUTTON = 28;

/**
 * Where the selection's Comment button goes: in the margin right of the text, level with the
 * first selected line, when there is room; otherwise under the last selected line, or above the
 * first one near the bottom of the window. Never over the selected line or the line above it.
 */
export function commentButtonPlace(selected: Omit<Selected, "text">, textRight: number, viewport: { width: number; height: number }): { top: number; left: number } {
  const margin = 8;
  const top = Math.max(margin, Math.min(selected.top - 2, viewport.height - BUTTON - margin));
  if (textRight + 6 + BUTTON <= viewport.width - margin) return { top, left: textRight + 6 };
  const left = Math.max(margin, Math.min(selected.left, viewport.width - BUTTON - margin));
  if (selected.bottom + 6 + BUTTON <= viewport.height - margin) return { top: selected.bottom + 6, left };
  return { top: Math.max(margin, selected.top - BUTTON - 6), left };
}

/** Takes a deleted comment's highlight off the page. */
export function removeCommentMark(editor: Editor, markId: string): void {
  const type = editor.schema.marks.comment;
  if (!type || editor.isDestroyed) return;
  const tr = editor.state.tr;
  editor.state.doc.descendants((node, pos) => {
    const mark = node.isInline ? node.marks.find((item) => item.type === type && item.attrs.id === markId) : undefined;
    if (mark) tr.removeMark(pos, pos + node.nodeSize, mark);
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}

export function CommentLayer({
  editor,
  pageKind,
  pageId,
  canComment = true,
}: {
  editor: Editor | null;
  pageKind: string;
  pageId: string;
  /** False for someone who can only view the page: comments show, but nothing that writes one. */
  canComment?: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const comments = useQuery({ queryKey: ["comments", pageKind, pageId], queryFn: () => api.comments(pageKind, pageId) });
  const [selection, setSelection] = useState<Selected | null>(null);
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [pageDraft, setPageDraft] = useState("");
  const draftMentions = useMentionMenu({ value: draft, onValue: setDraft });
  const pageMentions = useMentionMenu({ value: pageDraft, onValue: setPageDraft });
  const [frame, setFrame] = useState(0);
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
      const coords = coordsAt(editor, from);
      if (!coords) return;
      rangeRef.current = { from, to };
      quoteRef.current = text;
      setSelection({ text, top: coords.top, left: coords.left, bottom: coordsAt(editor, to)?.bottom ?? coords.bottom });
    };
    // The comment form can stay open while the page changes (typing elsewhere, someone else's save),
    // so the range it will highlight follows those edits.
    const follow = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) setFrame((value) => value + 1);
      const range = rangeRef.current;
      if (!range || !transaction.docChanged) return;
      rangeRef.current = { from: transaction.mapping.map(range.from, 1), to: transaction.mapping.map(range.to, -1) };
    };
    editor.on("selectionUpdate", refresh);
    editor.on("transaction", follow);
    return () => {
      editor.off("selectionUpdate", refresh);
      editor.off("transaction", follow);
    };
  }, [editor]);

  useEffect(() => {
    if (!canComment) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        if (selection) setDraft("");
        setActive(selection ? "new" : "page");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, canComment]);

  useEffect(() => {
    if (!canComment) return;
    const open = () => {
      setActive("page");
      setPageDraft("");
    };
    window.addEventListener("ensemble:page-comment", open);
    return () => window.removeEventListener("ensemble:page-comment", open);
  }, [canComment]);

  // The block's comment button (block-controls.tsx) sends the block's text range.
  useEffect(() => {
    if (!editor || !canComment) return;
    const dom = editor.view.dom;
    const start = (event: Event) => {
      const range = (event as CustomEvent<{ from: number; to: number }>).detail;
      const size = editor.state.doc.content.size;
      if (!range || range.from < 0 || range.from >= range.to || range.to > size) return;
      const text = editor.state.doc.textBetween(range.from, range.to, " ").trim();
      const coords = coordsAt(editor, range.from);
      if (!text || !coords) return;
      rangeRef.current = { from: range.from, to: range.to };
      quoteRef.current = text;
      setSelection({ text, top: coords.top, left: coords.left, bottom: coordsAt(editor, range.to)?.bottom ?? coords.bottom });
      setActive("new");
      setDraft("");
    };
    dom.addEventListener(COMMENT_BLOCK_EVENT, start);
    return () => dom.removeEventListener(COMMENT_BLOCK_EVENT, start);
  }, [editor, canComment]);

  useInlineEnsemble(editor, pageKind, pageId);

  const presentMarks = useMemo(() => {
    const ids = new Set<string>();
    editor?.state.doc.descendants((node) => {
      for (const mark of node.marks) {
        if (mark.type.name === "comment" && mark.attrs.id) ids.add(String(mark.attrs.id));
      }
    });
    return ids;
  }, [editor, comments.data, frame]);

  const create = useMutation({
    mutationFn: (input: { quote: string; text: string; markId?: string; mentions?: PageMention[] }) =>
      api.createComment(pageKind, pageId, { markId: input.markId, quote: input.quote, body: { text: input.text }, mentions: input.mentions }),
    onSuccess: async (result, input) => {
      const range = rangeRef.current;
      if (editor && input.markId && range && range.from < range.to && range.to <= editor.state.doc.content.size) {
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
  const activeRow = roots.find((row) => row.id === active);
  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    const open = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-comment-id]") : null;
      const row = roots.find((comment) => comment.markId === target?.dataset.commentId);
      if (row) setActive(row.id);
    };
    dom.addEventListener("click", open);
    return () => dom.removeEventListener("click", open);
  }, [editor, comments.data]);

  // Where the selected text is now: scrolling (which bumps `frame`) moves it.
  const placed = (() => {
    const range = rangeRef.current;
    if (!selection || !editor || !range) return selection;
    const start = coordsAt(editor, range.from);
    const end = coordsAt(editor, range.to);
    return start && end ? { ...selection, top: start.top, left: start.left, bottom: end.bottom } : selection;
  })();

  const bubbleTop = useMemo(() => {
    const placed = new Map<string, number>();
    const host = editor?.view.dom.closest(".comment-host");
    if (!host) return placed;
    const hostTop = host.getBoundingClientRect().top;
    const anchors = roots.map((row) => {
      let raw = 0;
      if (row.markId) {
        const mark = host.querySelector(`[data-comment-id="${CSS.escape(row.markId)}"]`);
        if (mark) raw = mark.getBoundingClientRect().top - hostTop;
      }
      return { row, raw };
    }).sort((a, b) => a.raw - b.raw);
    let cursor = 0;
    for (const { row, raw } of anchors) {
      const top = Math.max(cursor, raw);
      placed.set(row.id, top);
      cursor = top + 32;
    }
    return placed;
    // frame bumps this after scroll and resize so bubbles track their marks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, roots, active, frame, comments.data]);

  return (
    <>
      {canComment && selection && active !== "new" ? (
        <button
          type="button"
          className="comment-selection-action fixed z-40"
          style={commentButtonPlace(placed ?? selection, editor?.view.dom.getBoundingClientRect().right ?? selection.left, { width: window.innerWidth, height: window.innerHeight })}
          data-frame={frame}
          aria-label="Comment on the selected text"
          title="Comment (⌘⇧M)"
          onMouseDown={(event) => {
            event.preventDefault();
            setActive("new");
            setDraft("");
          }}
        >
          <MessageSquare size={14} />
        </button>
      ) : null}
      {canComment && active === "new" && selection ? (
        <FloatingComment editor={editor} top={(placed ?? selection).top} frame={frame} title="New comment" onClose={() => { setActive(null); setSelection(null); }}>
        <form
          className="comment-compose"
          onSubmit={(event) => {
            event.preventDefault();
            const markId = crypto.randomUUID();
            const text = draft.trim();
            // The draft stays until the comment is saved, so a failed save loses nothing.
            create.mutate({ quote: selection?.text || quoteRef.current, text, markId, mentions: draftMentions.takeMentions(text) }, { onSuccess: () => draftMentions.clear() });
          }}
        >
          <blockquote className="comment-quote">{selection.text}</blockquote>
          <MentionPopover menu={draftMentions} />
          <MentionTextarea
            menu={draftMentions}
            autoFocus
            value={draft}
            onKeyDown={(event) => {
              if (draftMentions.onKeyDown(event) || event.key !== "Escape") return;
              event.preventDefault();
              setActive(null);
              setSelection(null);
              editor?.commands.focus();
            }}
            aria-label="Comment"
            placeholder="Write a comment…"
            className="field min-h-16 w-full"
          />
          <div className="mt-2 flex gap-2">
            <button type="submit" className="btn-primary" disabled={!draft.trim() || create.isPending}>
              Comment
            </button>
            <button type="button" className="btn" onClick={() => { setActive(null); setSelection(null); }}>
              Cancel
            </button>
          </div>
        </form></FloatingComment>
      ) : null}
      {roots.length > 0 && <div className="comment-margin" aria-label="Comments">
        {roots.map((row, index) => <button key={row.id} type="button" className="comment-marker" style={{ top: bubbleTop.get(row.id) ?? 0 }} data-resolved={row.status === "resolved" || undefined} aria-label={`Open comment ${index + 1}: ${textOf(row.body).slice(0, 60)}`} aria-expanded={active === row.id} title={textOf(row.body)} onClick={() => setActive(row.id)}>{row.status === "resolved" ? <Check size={13} /> : <MessageSquare size={13} />}<span>{1 + childrenOf(row.id).length}</span></button>)}
      </div>}
      {canComment && active === "page" && <FloatingComment editor={editor} frame={frame} title="Page comment" onClose={() => setActive(null)}>
            <form
              className="comment-compose"
              onSubmit={(event) => {
                event.preventDefault();
                const text = pageDraft.trim();
                if (!text) return;
                create.mutate({ quote: "", text, mentions: pageMentions.takeMentions(text) }, {
                  onSuccess: () => {
                    pageMentions.clear();
                    setPageDraft("");
                  },
                });
              }}
            >
              <MentionPopover menu={pageMentions} />
              <MentionTextarea
                menu={pageMentions}
                value={pageDraft}
                onKeyDown={pageMentions.onKeyDown}
                aria-label="Page comment"
                autoFocus
                placeholder="A note on this page. @ensemble can answer."
                className="field min-h-16 w-full"
              />
              <div className="mt-2 flex gap-2">
                <button type="submit" className="btn-primary" disabled={!pageDraft.trim() || create.isPending}>
                  Comment
                </button>
                <button type="button" className="btn" onClick={() => setActive(null)}>
                  Cancel
                </button>
              </div>
            </form>
      </FloatingComment>}
      {activeRow && <FloatingComment editor={editor} markId={activeRow.markId} frame={frame} title={activeRow.status === "resolved" ? "Resolved comment" : "Comment"} onClose={() => setActive(null)}>
            <div data-comment-bubble>
              <Thread
                key={activeRow.id}
                row={activeRow}
                replies={childrenOf(activeRow.id)}
                orphan={Boolean(activeRow.markId) && !presentMarks.has(activeRow.markId!)}
                pageKind={pageKind}
                pageId={pageId}
                active
                canComment={canComment}
                onOpen={() => setActive(activeRow.id)}
                onDeleted={() => {
                  if (editor && activeRow.markId) removeCommentMark(editor, activeRow.markId);
                  setActive(null);
                }}
              />
            </div>
      </FloatingComment>}
      {comments.isError && <div role="alert" className="mt-3 text-[12px] text-danger">Couldn’t load comments. <button type="button" className="underline" onClick={() => void comments.refetch()}>Try again</button></div>}
    </>
  );
}

function FloatingComment({ editor, markId, top, frame, title, children, onClose }: { editor: Editor | null; markId?: string | null; top?: number; frame: number; title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(300);
  const zIndex = useLayerZ(90);
  const owner = "page-comment";
  useModalFocus(ref, true, onClose);
  useEffect(() => {
    const node = ref.current?.querySelector<HTMLElement>(".comment-popover");
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.getBoundingClientRect().height));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const host = editor?.view.dom;
  const mark = markId ? host?.querySelector(`[data-comment-id="${CSS.escape(markId)}"]`) : null;
  const box = host?.getBoundingClientRect();
  const width = Math.min(336, window.innerWidth - 24);
  const position = clampBox(top ?? mark?.getBoundingClientRect().top ?? box?.top ?? 80, (box?.right ?? window.innerWidth) + 14, width, height);
  return createPortal(<ModalScope.Provider value={owner}>
    <div ref={ref} className="comment-overlay" data-modal-layer={owner} style={{ zIndex }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={title} className="comment-popover" style={{ ...position, width }} data-frame={frame} onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
        <header><span><MessageSquare size={14} />{title}</span><button type="button" className="icon-btn" aria-label="Close comment" onClick={onClose}><X size={14} /></button></header>
        {children}
      </section>
    </div>
  </ModalScope.Provider>, document.body);
}

function Thread({
  row,
  replies,
  orphan,
  pageKind,
  pageId,
  active,
  canComment,
  onOpen,
  onDeleted,
}: {
  row: PageComment;
  replies: PageComment[];
  orphan: boolean;
  pageKind: string;
  pageId: string;
  active: boolean;
  canComment: boolean;
  onOpen: () => void;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [text, setText] = useState(textOf(row.body));
  const [ask, setAsk] = useState("");
  const editMentions = useMentionMenu({ value: text, onValue: setText });
  const askMentions = useMentionMenu<HTMLInputElement>({ value: ask, onValue: setAsk });
  const editButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef<"edit" | "delete" | null>(null);
  const failed = (error: Error) => toast(error.message, { tone: "error" });
  useEffect(() => {
    if (editing) {
      const field = editMentions.ref.current;
      field?.focus();
      field?.setSelectionRange(field.value.length, field.value.length);
    } else if (refocus.current === "edit") editButton.current?.focus();
    if (confirming) confirmButton.current?.focus();
    else if (refocus.current === "delete") deleteButton.current?.focus();
    refocus.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, confirming]);
  const stopEditing = () => {
    refocus.current = "edit";
    setEditing(false);
  };
  const cancelEdit = () => {
    setText(textOf(row.body));
    stopEditing();
  };
  const save = useMutation({
    mutationFn: () => api.patchComment(row.id, { body: { text: text.trim() } }),
    onSuccess: () => {
      stopEditing();
      void client.invalidateQueries({ queryKey: ["comments", pageKind, pageId] });
    },
    onError: failed,
  });
  const resolve = useMutation({
    mutationFn: () => api.patchComment(row.id, { status: row.status === "resolved" ? "open" : "resolved" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["comments", pageKind, pageId] }),
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteComment(row.id),
    onSuccess: () => {
      onDeleted();
      void client.invalidateQueries({ queryKey: ["comments", pageKind, pageId] });
    },
    onError: (error: Error) => {
      setConfirming(false);
      failed(error);
    },
  });
  const empty = !text.trim();
  const editKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (editMentions.onKeyDown(event)) return;
    if (event.key === "Escape") {
      // Handled here so focus mode and the side peek do not also take this Esc.
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !empty) {
      event.preventDefault();
      save.mutate();
    }
  };
  return (
    <article className="comment-thread" data-active={active || undefined} onClick={onOpen}>
      {row.quote ? <blockquote className="comment-quote" title={row.quote}>{row.quote}</blockquote> : null}
      {orphan ? <div className="mb-2 text-[11px] text-warn">The highlighted text was removed.</div> : null}
      <div className="comment-byline"><span className="comment-avatar"><MessageSquare size={12} /></span><strong>{row.authorKind === "ensemble" ? "Ensemble" : "Comment"}</strong>{row.createdAt && <time dateTime={row.createdAt}>{relative(row.createdAt)}</time>}</div>
      {editing ? (
        <>
          <MentionPopover menu={editMentions} />
          <MentionTextarea menu={editMentions} aria-label="Edit comment" value={text} onKeyDown={editKey} className="field min-h-16 w-full" />
          {empty ? <p className="mt-1 text-[12px] text-muted">A comment can't be empty. To remove it, use Delete.</p> : null}
        </>
      ) : (
        <MarkdownText text={textOf(row.body)} mentions={row.authorKind === "human" ? row.mentions : null} />
      )}
      {canComment ? (
        confirming ? (
          <div className="mt-1 flex flex-wrap items-center gap-1" role="group" aria-label="Delete this comment?">
            <span className="mr-1 text-[12px] text-muted">Delete this comment?</span>
            <button ref={confirmButton} type="button" className="btn text-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Delete
            </button>
            <button type="button" className="btn" onClick={() => { refocus.current = "delete"; setConfirming(false); }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); refocus.current = "delete"; setConfirming(false); } }}>
              Keep
            </button>
          </div>
        ) : (
          <div className="comment-thread-actions">
            {editing ? (
              <>
                <button type="button" className="btn" disabled={empty || save.isPending} onClick={() => save.mutate()}>
                  Save
                </button>
                <button type="button" className="btn" onClick={cancelEdit}>
                  Cancel
                </button>
              </>
            ) : (
              <button ref={editButton} type="button" onClick={() => { setText(textOf(row.body)); setEditing(true); }}>
                Edit
              </button>
            )}
            <button type="button" disabled={resolve.isPending} onClick={() => resolve.mutate()}>
              {row.status === "resolved" ? "Reopen" : "Resolve"}
            </button>
            <button ref={deleteButton} type="button" onClick={() => setConfirming(true)}>
              Delete
            </button>
          </div>
        )
      ) : null}
      {replies.map((reply) => (
        <div key={reply.id} className="ensemble-reply mt-2">
          <div className="ensemble-reply-rule" />
          <div>
            <div className="text-[12px] font-medium">Ensemble {reply.tier ? `· ${reply.tier}` : ""}</div>
            <MarkdownText text={textOf(reply.body)} />
          </div>
        </div>
      ))}
      {canComment ? (
        <form
          className="comment-ask"
          onSubmit={(event) => {
            event.preventDefault();
            const prompt = String(new FormData(event.currentTarget).get("prompt") ?? ask).trim();
            if (!prompt) return;
            const threadId = crypto.randomUUID();
            const mentions = askMentions.takeMentions(prompt);
            askMentions.clear();
            setAsk("");
            void streamEnsemble({ pageKind, pageId, prompt, threadId, parentId: row.id, quote: row.quote, mentions }).then(() =>
              client.invalidateQueries({ queryKey: ["comments", pageKind, pageId] }),
            );
          }}
        >
          <MentionPopover menu={askMentions} />
          <input
            ref={askMentions.ref}
            name="prompt"
            value={ask}
            {...askMentions.inputProps}
            onKeyDown={askMentions.onKeyDown}
            aria-label="Ask Ensemble"
            placeholder="@ensemble…"
            className="field min-w-0 flex-1 py-2 text-[12.5px]"
          />
        </form>
      ) : null}
    </article>
  );
}
