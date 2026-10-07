import type { Editor } from "@tiptap/core";
import type { AssistantToolCallRecord } from "../../lib/api";

export function retargetEnsembleReply(editor: Editor, from: string, to: string): void {
  editor.commands.command(({ tr }) => {
    let changed = false;
    tr.doc.descendants((node, pos) => {
      if (changed) return false;
      if (node.type.name !== "ensembleReply" || node.attrs.threadId !== from) return true;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, threadId: to });
      changed = true;
      return false;
    });
    return changed;
  });
}

export function attachEnsembleArtifacts(editor: Editor, threadId: string, calls: AssistantToolCallRecord[]): void {
  if (!editor.isEditable) return;
  editor.commands.command(({ tr }) => {
    let changed = false;
    tr.doc.descendants((node, pos) => {
      if (changed) return false;
      if (node.type.name !== "ensembleReply" || node.attrs.threadId !== threadId) return true;
      const attached: string[] = Array.isArray(node.attrs.attachedCalls) ? node.attrs.attachedCalls.filter((id: unknown): id is string => typeof id === "string") : [];
      const artifacts = calls.flatMap((call) => {
        if (call.state !== "ok" || attached.includes(call.id)) return [];
        if (call.name !== "hub_create_diagram" && call.name !== "hub_create_plot") return [];
        const match = call.href?.match(/^\/(diagrams|plots)\/([0-9a-f-]{36})$/i);
        if (!match) return [];
        return [{ callId: call.id, kind: match[1] === "diagrams" ? "diagram" : "plot", id: match[2]!, label: typeof call.input?.title === "string" ? call.input.title : "Untitled" }];
      });
      if (!artifacts.length) return false;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, attachedCalls: [...attached, ...artifacts.map((artifact) => artifact.callId)] });
      tr.insert(pos + node.nodeSize, artifacts.map((artifact) => editor.schema.nodes.paragraph!.create(null, editor.schema.nodes.mention!.create({ kind: artifact.kind, id: artifact.id, label: artifact.label }))));
      changed = true;
      return false;
    });
    return changed;
  });
}
