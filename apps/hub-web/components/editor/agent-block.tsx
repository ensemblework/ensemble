"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { AgentIcon as Orbit } from "@/components/agent-icon";
import { ENGINE_LABELS, isCodeEngine } from "@ensemble/shared-types";
import { Check, ExternalLink, Trash2 } from "lucide-react";
import { relative } from "@/lib/format";

type AgentBlockAttrs = {
  model?: string;
  at?: string;
  title?: string;
  fingerprint?: string;
  /** What wrote it: `code-agent` for the Code tab's agent (hub-api pages/agent-output.ts). */
  source?: string;
  engine?: string;
  threadId?: string | null;
  folder?: string;
  computer?: string;
  runId?: string | null;
};

/** Where an agent's block came from, in one line: "Codex · gpt-6-luna · relay · Akash's MacBook". */
export function agentBlockSource(attrs: AgentBlockAttrs): string {
  const engine = attrs.engine && isCodeEngine(attrs.engine) ? ENGINE_LABELS[attrs.engine] : "";
  const folder = attrs.folder ? attrs.folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "" : "";
  return [engine, attrs.model, folder, attrs.computer].filter(Boolean).join(" · ");
}

/** Same fingerprint the server stamps on the block, so "edited" survives reloads without a write on open. */
export function fingerprint(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

function AgentBlockView({ node, editor, getPos, deleteNode }: NodeViewProps) {
  const attrs = node.attrs as AgentBlockAttrs;
  const edited = Boolean(attrs.fingerprint) && fingerprint(node.textContent) !== attrs.fingerprint;
  const fromCode = attrs.source === "code-agent";
  const source = fromCode ? agentBlockSource(attrs) : "";
  const thread = fromCode && attrs.threadId ? `/code?view=agent&thread=${encodeURIComponent(attrs.threadId)}` : null;
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
        <Orbit size={12} />
        <span className="min-w-0 truncate font-medium" title={source || undefined}>{fromCode ? "From the Code tab's agent" : attrs.title || "Written by the agent"}</span>
        {fromCode && source ? <span className="min-w-0 truncate max-sm:hidden" title={attrs.title || undefined}>· {source}</span> : null}
        {!fromCode && attrs.model ? <span>· {attrs.model}</span> : null}
        {attrs.at ? <span className="shrink-0">· {relative(attrs.at)}</span> : null}
        {thread ? (
          <a href={thread} className="agent-block-link" title="Open the thread this came from">
            <ExternalLink size={11} /> Thread
          </a>
        ) : null}
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
      source: { default: "" },
      engine: { default: "" },
      threadId: { default: null },
      folder: { default: "" },
      computer: { default: "" },
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
