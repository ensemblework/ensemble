"use client";

import type { Editor } from "@tiptap/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { PageDocument } from "@ensemble/shared-types";
import { ENTITY_MENTION_KEY } from "../editor/extensions";
import { retargetEnsembleReply } from "./ensemble-artifacts";
import { ensembleNodeRequest } from "./ensemble-prompt";
import { streamEnsemble } from "./ensemble-view";

/**
 * `@ensemble …` then Enter in the page body: the line becomes an Ensemble answer block that
 * streams in place. Pages with comments get it through CommentLayer; meeting notes, which have
 * no comments, mount InlineEnsemble alone.
 */
export function useInlineEnsemble(editor: Editor | null, pageKind: string, pageId: string) {
  const client = useQueryClient();
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
}

export function InlineEnsemble({ editor, pageKind, pageId }: { editor: Editor | null; pageKind: string; pageId: string }) {
  useInlineEnsemble(editor, pageKind, pageId);
  return null;
}
