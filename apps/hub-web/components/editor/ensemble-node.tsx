import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useState, type ComponentType } from "react";

function LazyEnsemble(props: NodeViewProps) {
  const [View, setView] = useState<ComponentType<NodeViewProps> | null>(null);
  useEffect(() => {
    let live = true;
    void import("../comments/ensemble-view").then((mod) => {
      if (live) setView(() => mod.EnsembleView);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!View) {
    return (
      <NodeViewWrapper className="ensemble-reply">
        <div className="ensemble-reply-rule shimmer" />
      </NodeViewWrapper>
    );
  }
  return <View {...props} />;
}

export const EnsembleReply = Node.create({
  name: "ensembleReply",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      threadId: { default: null },
      prompt: { default: "" },
      pageKind: { default: "task" },
      pageId: { default: "" },
      attachedCalls: { default: [] },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-ensemble-reply]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-ensemble-reply": HTMLAttributes.threadId ?? "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LazyEnsemble);
  },
});
