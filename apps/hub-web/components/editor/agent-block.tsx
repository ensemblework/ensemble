"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Bot, Check, Trash2 } from "lucide-react";
import { relative } from "@/lib/format";

/** Same fingerprint the server stamps on the block, so "edited" survives reloads without a write on open. */
export function fingerprint(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

function AgentBlockView({ node, editor, getPos, deleteNode }: NodeViewProps) {
  const attrs = node.attrs as { model?: string; at?: string; title?: string; fingerprint?: string };
  const edited = Boolean(attrs.fingerprint) && fingerprint(node.textContent) !== attrs.fingerprint;
  const keep = () => {
    const pos = typeof getPos === "function" ? getPos() : null;
    if (pos == null) return;
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        const current = tr.doc.nodeAt(pos);
        if (!current) return false;
        tr.replaceWith(pos, pos + current.nodeSize, current.content);
        return true;
      })
      .run();
  };
  return (
    <NodeViewWrapper className="agent-block" data-edited={edited || undefined}>
      <div contentEditable={false} className="agent-block-bar">
        <Bot size={12} />
        <span className="font-medium">{attrs.title || "Written by the agent"}</span>
        {attrs.model ? <span>· {attrs.model}</span> : null}
        {attrs.at ? <span>· {relative(attrs.at)}</span> : null}
        {edited ? <span className="agent-block-edited">· edited by you</span> : null}
        <span className="flex-1" />
        {editor.isEditable ? (
          <>
            <button type="button" onClick={keep} title="Turn this into your own text (removes the agent marking)">
              <Check size={12} /> Keep as mine
            </button>
            <button type="button" onClick={() => deleteNode()} title="Remove this block">
              <Trash2 size={12} />
            </button>
          </>
        ) : null}
      </div>
      <NodeViewContent className="agent-block-body" />
    </NodeViewWrapper>
  );
}

export const AgentBlock = Node.create({
  name: "agentBlock",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      jobId: { default: null },
      runId: { default: null },
      model: { default: "" },
      title: { default: "" },
      at: { default: null },
      fingerprint: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-agent-block]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-agent-block": "" }), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AgentBlockView);
  },
});
