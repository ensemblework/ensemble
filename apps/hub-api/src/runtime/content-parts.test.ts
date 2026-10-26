import assert from "node:assert/strict";
import test from "node:test";
import { anthropicPayload, buildChatPayload, toAnthropic } from "./payload.js";
import { cleanItems, itemsFromChat } from "./responses-api.js";
import { withVision } from "./models.js";
import { estimateInputTokens, FILE_INPUT_ALLOWANCE_MAX, IMAGE_INPUT_ALLOWANCE } from "./included.js";

const picture = { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } };
const asked = [{ type: "text", text: "What does this chart show?" }, picture];

test("chat providers get image_url parts unchanged", () => {
  const payload = buildChatPayload("gpt-4.1", "openai", [{ role: "user", content: asked }]);
  assert.deepEqual((payload.messages as Array<{ content: unknown }>)[0]!.content, asked);
});

test("Anthropic gets base64 image blocks, after the tool results of the same turn", () => {
  const { messages } = toAnthropic([
    { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "hub_view_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t1", content: "{\"ok\":true}" },
    { role: "user", content: asked },
  ]);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "{\"ok\":true}" },
      { type: "text", text: "What does this chart show?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ],
  });
  const plain = anthropicPayload({}, "claude-sonnet-4-5", [{ role: "user", content: "hi" }]);
  assert.deepEqual(plain.messages, [{ role: "user", content: "hi" }]);
});

test("Responses gets input_text and input_image parts, also from stored items", () => {
  assert.deepEqual(itemsFromChat([{ role: "user", content: asked }]), [
    { role: "user", content: [{ type: "input_text", text: "What does this chart show?" }, { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }] },
  ]);
  const stored = [{ role: "user", content: [{ type: "input_text", text: "x" }, { type: "input_image", image_url: "data:image/jpeg;base64,/9j/" }] }];
  assert.deepEqual(cleanItems(stored), stored);
  assert.deepEqual(itemsFromChat([{ role: "user", content: "plain" }]), [{ role: "user", content: "plain" }]);
});

test("Copilot requests that carry a picture say so", () => {
  const target: { base: string; headers: Record<string, string> } = { base: "https://api.githubcopilot.com", headers: { Authorization: "Bearer x" } };
  assert.equal(withVision("copilot", target, { messages: [{ role: "user", content: asked }] }).headers["Copilot-Vision-Request"], "true");
  assert.equal(withVision("copilot", target, { input: [{ role: "user", content: "hi" }] }).headers["Copilot-Vision-Request"], undefined);
  assert.equal(withVision("openai", target, { messages: [{ role: "user", content: asked }] }), target);
});

test("an included-model reservation counts a picture as a fixed allowance, not its base64 length", () => {
  const huge = `data:image/png;base64,${"A".repeat(3_000_000)}`;
  const responses = { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: huge }] }] };
  const claude = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(3_000_000) } }] }] };
  const plain = estimateInputTokens({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "" }] }] });
  assert.equal(estimateInputTokens(responses), plain + IMAGE_INPUT_ALLOWANCE);
  assert.ok(estimateInputTokens(claude) < 20_000);
});

test("a file goes whole: input_file for Responses, a document block for Anthropic, unchanged for chat", () => {
  const pdf = { type: "file", file: { filename: "memo.pdf", file_data: "data:application/pdf;base64,JVBERi0=" } };
  const notes = { type: "file", file: { filename: "notes.md", file_data: `data:text/markdown;base64,${Buffer.from("# Notes", "utf8").toString("base64")}` } };
  const asked = [{ type: "text", text: "Summarise" }, pdf, notes];
  assert.deepEqual(itemsFromChat([{ role: "user", content: asked }]), [
    { role: "user", content: [{ type: "input_text", text: "Summarise" }, { type: "input_file", filename: "memo.pdf", file_data: "data:application/pdf;base64,JVBERi0=" }, { type: "input_file", filename: "notes.md", file_data: notes.file.file_data }] },
  ]);
  assert.deepEqual(toAnthropic([{ role: "user", content: asked }]).messages[0], {
    role: "user",
    content: [
      { type: "text", text: "Summarise" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" }, title: "memo.pdf" },
      { type: "document", source: { type: "text", media_type: "text/plain", data: "# Notes" }, title: "notes.md" },
    ],
  });
  const chat = buildChatPayload("gpt-4.1", "openai", [{ role: "user", content: asked }]);
  assert.deepEqual((chat.messages as Array<{ content: unknown }>)[0]!.content, asked);
  assert.deepEqual(cleanItems([{ role: "user", content: [{ type: "input_file", filename: "memo.pdf", file_data: "data:application/pdf;base64,JVBERi0=" }] }])[0], {
    role: "user",
    content: [{ type: "input_file", filename: "memo.pdf", file_data: "data:application/pdf;base64,JVBERi0=" }],
  });
});

test("an included-model reservation counts a file as its bytes, capped, not its base64 length", () => {
  const data = "A".repeat(4_000_000);
  const sent = estimateInputTokens({ input: [{ role: "user", content: [{ type: "input_file", filename: "big.pdf", file_data: `data:application/pdf;base64,${data}` }] }] });
  const empty = estimateInputTokens({ input: [{ role: "user", content: [{ type: "input_file", filename: "big.pdf", file_data: "" }] }] });
  assert.equal(sent, empty + FILE_INPUT_ALLOWANCE_MAX + 3_000);
  const small = estimateInputTokens({ input: [{ role: "user", content: [{ type: "input_file", filename: "big.pdf", file_data: `data:text/csv;base64,${"A".repeat(400)}` }] }] });
  assert.equal(small, empty + 300 + 3_000);
});
