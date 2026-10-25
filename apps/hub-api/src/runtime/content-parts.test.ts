import assert from "node:assert/strict";
import test from "node:test";
import { anthropicPayload, buildChatPayload, toAnthropic } from "./payload.js";
import { cleanItems, itemsFromChat } from "./responses-api.js";
import { withVision } from "./models.js";

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
  const target = { base: "https://api.githubcopilot.com", headers: { Authorization: "Bearer x" } };
  assert.equal(withVision("copilot", target, { messages: [{ role: "user", content: asked }] }).headers["Copilot-Vision-Request"], "true");
  assert.equal(withVision("copilot", target, { input: [{ role: "user", content: "hi" }] }).headers["Copilot-Vision-Request"], undefined);
  assert.equal(withVision("openai", target, { messages: [{ role: "user", content: asked }] }), target);
});
