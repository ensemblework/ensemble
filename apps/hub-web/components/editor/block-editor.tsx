"use client";

import { useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useRef, type MutableRefObject } from "react";
import type { PageDocument, PageMention } from "@ensemble/shared-types";
import { api, currentLink, inItemView } from "@/lib/api";
import { diagramMentionIds, editorExtensions, type EntitySource } from "./extensions";
import { BlockControls } from "./block-controls";
import { LinkPopover } from "./link-popover";
import { PAGE_BODY_ATTRIBUTE } from "./page-body";
import { FileChooser } from "./file-chooser";
import { acceptsDocument, replaceDocument, type EditorControl } from "./replace-doc";
import { RemoteCarets } from "./remote-carets";
import { useModuleState } from "@/lib/use-module";
import { useToast } from "../toast";

const CommentLayer = dynamic(() => import("../comments/comment-layer").then((mod) => mod.CommentLayer), { ssr: false });
const InlineEnsemble = dynamic(() => import("../comments/inline-ensemble").then((mod) => mod.InlineEnsemble), { ssr: false });

/**
 * The Notion-style page body: `/` for blocks, `@` for linked mentions of
 * people, projects, repos, tasks, deliverables, skills, files and dates. Mentions
 * are real nodes with ids, so the Context graph can draw them as edges.
 * Files dropped or pasted in upload and land as file cards.
 */
export function BlockEditor({
  initial,
  entities,
  onChange,
  onMentionClick,
  placeholder = "Type / for blocks, @ to mention…",
  editable = true,
  page,
  comments = true,
  remote,
  control,
}: {
  initial: PageDocument;
  entities: EntitySource;
  onChange: (doc: PageDocument) => void;
  onMentionClick?: (mention: PageMention) => void;
  placeholder?: string;
  editable?: boolean;
  page?: { kind: string; id: string };
  /** False: no comments on this page, only inline `@ensemble` requests (meeting notes). */
  comments?: boolean;
  /** Someone else's saved version. Applied in place (your selection kept), never saved back. */
  remote?: { doc: PageDocument; stamp: number } | null;
  /** Set while the editor is up, for merging someone else's save into what you are typing. */
  control?: MutableRefObject<EditorControl | null>;
}) {
  const toast = useToast();
  const router = useRouter();
  const client = useQueryClient();
  const clientRef = useRef(client);
  clientRef.current = client;
  const [chooser, setChooser] = useState<number | null>(null);
  const closeChooser = useCallback(() => setChooser(null), []);
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
    extensions: editorExtensions(entities, placeholder, () => diagramsStateRef.current, () => plotsStateRef.current, {
      client: () => clientRef.current,
      choose: (_editor, pos) => setChooser(pos),
    }),
    content: initial as JSONContent,
    editorProps: {
      attributes: { class: "ProseMirror", spellcheck: "true", role: "textbox", "aria-multiline": "true", "aria-label": "Page content", [PAGE_BODY_ATTRIBUTE]: "" },
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
    if (!current || !diagramsRef.current || inItemView()) return;
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
    if (JSON.stringify(remote.doc) === baseline.current) return;
    if (replaceDocument(editor, remote.doc)) baseline.current = JSON.stringify(editor.getJSON());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, remote?.stamp]);

  useEffect(() => {
    if (!control || !editor) return;
    const handle: EditorControl = {
      read: () => editor.getJSON() as PageDocument,
      accepts: (doc) => acceptsDocument(editor, doc),
      replace: (doc) => {
        if (editor.isDestroyed || !replaceDocument(editor, doc)) return false;
        baseline.current = JSON.stringify(editor.getJSON());
        return true;
      },
    };
    control.current = handle;
    return () => {
      if (control.current === handle) control.current = null;
    };
  }, [editor, control]);

  useEffect(() => {
    // The shell can load after the editor. Reconcile links once the diagrams module is known to be on.
    if (diagramsOn && editor && baseline.current !== null) syncDiagramLinks(editor.getJSON() as PageDocument);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramsOn, editor]);

  return (
    <div className={page && comments ? "comment-host" : undefined}>
      <div className={page && comments ? "page-with-comments" : undefined}>
        <div className="block-editor-body">
          <EditorContent editor={editor} />
          {live && editable ? <BlockControls editor={live} comment={Boolean(page && comments && !currentLink())} /> : null}
        </div>
        {live && editable ? <LinkPopover editor={live} navigate={router.push} /> : null}
        {live && chooser !== null ? <FileChooser editor={live} pos={chooser} onClose={closeChooser} /> : null}
        {live && page ? <RemoteCarets editor={live} page={page} /> : null}
        {/* Comments name people: never on a public link. */}
        {page && live && !currentLink() ? (
          comments ? <CommentLayer editor={live} pageKind={page.kind} pageId={page.id} canComment={editable} /> : <InlineEnsemble editor={live} pageKind={page.kind} pageId={page.id} />
        ) : null}
      </div>
    </div>
  );
}
