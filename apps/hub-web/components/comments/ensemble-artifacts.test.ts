import "../ui-test-dom";
import assert from "node:assert/strict";
import test from "node:test";
import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { attachEnsembleArtifacts, retargetEnsembleReply } from "./ensemble-artifacts";
import { ensembleNodeRequest } from "./ensemble-prompt";

const Mention = Node.create({
  name: "mention", group: "inline", inline: true, atom: true,
  addAttributes: () => ({ id: { default: "" }, label: { default: "" }, kind: { default: "dataset" } }),
  renderHTML: () => ["span", { "data-mention": "" }],
});
const Reply = Node.create({
  name: "ensembleReply", group: "block", atom: true,
  addAttributes: () => ({ threadId: { default: "" }, attachedCalls: { default: [] } }),
  renderHTML: () => ["div", { "data-reply": "" }],
});
function makeEditor() {
  return new Editor({ extensions: [StarterKit, Mention, Reply], content: { type: "doc", content: [{ type: "ensembleReply", attrs: { threadId: "thread" } }, { type: "paragraph" }] } });
}
test("inline prompts carry atomic dataset mentions and preserve document offsets and trailing text", () => {
  const editor = makeEditor();
  try {
    const prefix = "Keep this. @ensemble plot epoch vs accuracy from ";
    const tail = " Keep this too.";
    const block = editor.schema.nodes.paragraph!.create(null, [
      editor.schema.text(prefix),
      editor.schema.nodes.mention!.create({ id: "dataset-id", label: "epochs.csv", kind: "dataset" }),
      editor.schema.text(tail),
    ]);
    const request = ensembleNodeRequest(block, prefix.length + 1);
    assert.equal(request?.at, "Keep this. ".length);
    assert.equal(request?.caret, prefix.length + 1);
    assert.equal(request?.prompt, "plot epoch vs accuracy from @epochs.csv");
    assert.deepEqual(request?.mentions, [{ id: "dataset-id", label: "epochs.csv", kind: "dataset" }]);
    assert.equal(block.textBetween(request!.caret, block.content.size), tail);
    const notEnsemble = editor.schema.nodes.paragraph!.create(null, editor.schema.text("@ensemblework explain"));
    assert.equal(ensembleNodeRequest(notEnsemble, notEnsemble.content.size), null);
    const email = editor.schema.nodes.paragraph!.create(null, editor.schema.text("mail contact@ensemble.com for details"));
    assert.equal(ensembleNodeRequest(email, email.content.size), null);
  } finally { editor.destroy(); }
});
test("successful artifact calls attach once below the answer, and removal stays removed", () => {
  const editor = makeEditor();
  const calls = [
    { id: "plot-call", name: "hub_create_plot", state: "ok" as const, input: { title: "Accuracy" }, href: "/plots/11111111-1111-4111-8111-111111111111" },
    { id: "diagram-call", name: "hub_create_diagram", state: "ok" as const, input: { title: "Transformer" }, href: "/diagrams/22222222-2222-4222-8222-222222222222" },
    { id: "pending", name: "hub_create_plot", state: "awaiting_approval" as const, href: "/plots/33333333-3333-4333-8333-333333333333" },
  ];
  try {
    attachEnsembleArtifacts(editor, "thread", calls);
    const doc = editor.getJSON();
    assert.equal(doc.content?.[0]?.type, "ensembleReply");
    assert.equal(doc.content?.[1]?.content?.[0]?.attrs?.kind, "plot");
    assert.equal(doc.content?.[2]?.content?.[0]?.attrs?.kind, "diagram");
    attachEnsembleArtifacts(editor, "thread", calls);
    assert.equal(editor.getJSON().content?.length, 4);
    editor.commands.deleteRange({ from: 1, to: 4 });
    attachEnsembleArtifacts(editor, "thread", calls);
    assert.equal(editor.getJSON().content?.some((node) => node.content?.some((child) => child.attrs?.kind === "plot")), false);
  } finally { editor.destroy(); }
});

test("nested replies retain their server identity and attach artifacts inside their block", () => {
  const editor = makeEditor();
  try {
    editor.commands.setContent({ type: "doc", content: [{ type: "blockquote", content: [{ type: "ensembleReply", attrs: { threadId: "local" } }] }] });
    retargetEnsembleReply(editor, "local", "server");
    attachEnsembleArtifacts(editor, "server", [{ id: "nested-call", name: "hub_create_plot", state: "ok", input: { title: "Accuracy" }, href: "/plots/11111111-1111-4111-8111-111111111111" }]);
    const nested = editor.getJSON().content?.[0]?.content;
    assert.equal(nested?.[0]?.attrs?.threadId, "server");
    assert.equal(nested?.[1]?.content?.[0]?.attrs?.kind, "plot");
  } finally { editor.destroy(); }
});
