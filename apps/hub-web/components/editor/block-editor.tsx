"use client";

import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import dynamic from "next/dynamic";
import { useEffect, useState, useRef } from "react";
import type { PageDocument, PageMention } from "@ensemble/shared-types";
import { api, currentShare } from "@/lib/api";
import { diagramMentionIds, editorExtensions, type EntitySource } from "./extensions";
import { useModuleState } from "@/lib/use-module";
import { useToast } from "../toast";

const CommentLayer = dynamic(() => import("../comments/comment-layer").then((mod) => mod.CommentLayer), { ssr: false });

/**
 * The Notion-style page body: `/` for blocks, `@` for linked mentions of
 * people, projects, repos, tasks, deliverables, skills and dates. Mentions
 * are real nodes with ids, so the Context graph can draw them as edges.
 */
export function BlockEditor({
  initial,
  entities,
  onChange,
  onMentionClick,
  placeholder = "Type / for blocks, @ to mention…",
  editable = true,
  page,
  remote,
}: {
  initial: PageDocument;
  entities: EntitySource;
  onChange: (doc: PageDocument) => void;
  onMentionClick?: (mention: PageMention) => void;
  placeholder?: string;
  editable?: boolean;
  page?: { kind: string; id: string };
  /** Someone else's saved version. Applied in place (your selection kept), never saved back. */
  remote?: { doc: PageDocument; stamp: number } | null;
}) {
  const toast = useToast();
  const changeRef = useRef(onChange);
  const clickRef = useRef(onMentionClick);
  const pageRef = useRef(page);
  const linked = useRef("");
  // Diagram links, @diagram cards, and the "New diagram" item follow the diagrams module.
  const diagramsState = useModuleState("diagrams");
  const diagramsOn = diagramsState === true;
  const diagramsRef = useRef(diagramsOn);
  diagramsRef.current = diagramsOn;
  const diagramsStateRef = useRef(diagramsState);
  diagramsStateRef.current = diagramsState;
  const plotsState = useModuleState("plots");
  const plotsStateRef = useRef(plotsState);
  plotsStateRef.current = plotsState;
  const baseline = useRef<string | null>(null);
  pageRef.current = page;
  const [live, setLive] = useState<Editor | null>(null);
  changeRef.current = onChange;
  clickRef.current = onMentionClick;

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: editorExtensions(entities, placeholder, () => diagramsStateRef.current, () => plotsStateRef.current),
    content: initial as JSONContent,
    editorProps: {
      attributes: { class: "ProseMirror", spellcheck: "true" },
      handleClick(_view, _pos, event) {
        const anchor = (event.target as HTMLElement).closest("a.mention") as HTMLAnchorElement | null;
        if (!anchor) return false;
        event.preventDefault();
        const kind = anchor.dataset.kind as PageMention["kind"] | undefined;
        const id = anchor.dataset.id;
        if (kind && id) clickRef.current?.({ kind, id, label: anchor.dataset.label ?? "" });
        return true;
      },
    },
    onCreate({ editor: instance }) {
      baseline.current = JSON.stringify(instance.getJSON());
      setLive(instance);
      syncDiagramLinks(instance.getJSON() as PageDocument);
    },
    onUpdate({ editor: instance }) {
      // onCreate records the normalised document. Updates that arrive before
      // that, or that only repeat it, are not edits and must not save.
      if (baseline.current === null) return;
      const doc = instance.getJSON() as PageDocument;
      const serialized = JSON.stringify(doc);
      if (serialized === baseline.current) return;
      baseline.current = serialized;
      changeRef.current(doc);
      syncDiagramLinks(doc);
    },
  });

  function syncDiagramLinks(doc: PageDocument) {
    const current = pageRef.current;
    // Diagram links are space-wide; one shared page cannot rewrite them.
    if (!current || !diagramsRef.current || currentShare()) return;
    const ids = diagramMentionIds(doc);
    const key = `${current.kind}:${current.id}:${ids.join(",")}`;
    if (linked.current === key) return;
    linked.current = key;
    const targetKind = current.kind;
    if (!["task", "deliverable", "project", "repo", "page"].includes(targetKind)) return;
    void api.syncDiagramLinks({ targetKind, targetId: current.id, diagramIds: ids }).catch((error: Error) => {
      linked.current = "";
      toast(error.message, { tone: "error" });
    });
  }

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor || !remote || editor.isDestroyed) return;
    const next = JSON.stringify(remote.doc);
    if (next === baseline.current) return;
    const { from, to } = editor.state.selection;
    editor.commands.setContent(remote.doc as JSONContent, false);
    baseline.current = JSON.stringify(editor.getJSON());
    const size = editor.state.doc.content.size;
    try {
      editor.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) });
    } catch {
      // The old position no longer exists; the cursor stays where setContent put it.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, remote?.stamp]);

  useEffect(() => {
    // The shell can load after the editor. Reconcile links once the diagrams module is known to be on.
    if (diagramsOn && editor && baseline.current !== null) syncDiagramLinks(editor.getJSON() as PageDocument);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramsOn, editor]);

  return (
    <div className={page ? "comment-host" : undefined}>
      <div className={page ? "page-with-comments" : undefined}>
        <EditorContent editor={editor} />
        {page && live ? <CommentLayer editor={live} pageKind={page.kind} pageId={page.id} /> : null}
      </div>
    </div>
  );
}
