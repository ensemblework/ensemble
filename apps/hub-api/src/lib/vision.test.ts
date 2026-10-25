import assert from "node:assert/strict";
import test from "node:test";
import { imagesRefused, IMAGES_REFUSED_NOTE, modelReadsImages, withoutImages } from "./vision.js";

test("included models read images as their catalog says", () => {
  assert.equal(modelReadsImages("ensemble", "gpt-6.1-sol"), true);
  assert.equal(modelReadsImages("ensemble", "deepseek-v4-flash"), false);
  assert.equal(modelReadsImages("ensemble", "not-a-model"), false);
});

test("a person's own keys follow the model family; unknown is text only", () => {
  for (const [provider, model] of [["openai", "gpt-4o-mini"], ["openai", "gpt-5"], ["anthropic", "claude-haiku-4-5-20251001"], ["google", "gemini-3.5-flash-lite"], ["openrouter", "anthropic/claude-sonnet-4.5"], ["ollama", "llava:13b"], ["copilot", "gpt-4.1"], ["mistral", "pixtral-large-latest"]]) {
    assert.equal(modelReadsImages(provider, model), true, `${provider} ${model}`);
  }
  for (const [provider, model] of [["openai", "o3-mini"], ["openai", "gpt-3.5-turbo"], ["openai", "gpt-oss-120b"], ["kimi", "moonshot-v1-8k"], ["qwen", "qwen-flash"], ["ollama", "llama3.1"], ["openrouter", "openrouter/auto"], ["claude-code", "claude-sonnet-4-5"], ["cursor", "composer-2.5"], ["google", "gemini-embedding-001"]]) {
    assert.equal(modelReadsImages(provider, model), false, `${provider} ${model}`);
  }
});

test("a refused picture is replaced by a plain note", () => {
  assert.equal(imagesRefused(new Error("Invalid content type. image_url is only supported by certain models.")), true);
  assert.equal(imagesRefused(new Error("The model is overloaded.")), false);
  const messages = [{ role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }, { role: "user", content: "plain" }];
  assert.deepEqual(withoutImages(messages), [{ role: "user", content: [{ type: "text", text: "Look" }, { type: "text", text: IMAGES_REFUSED_NOTE }] }, messages[1]]);
});
