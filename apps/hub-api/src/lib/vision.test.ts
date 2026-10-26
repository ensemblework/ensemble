import assert from "node:assert/strict";
import test from "node:test";
import { documentsFor, filesRefused, imagesRefused, IMAGES_REFUSED_NOTE, modelReadsImages, withoutFiles, withoutImages } from "./vision.js";

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
  assert.equal(imagesRefused(new Error("messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 5592408 bytes > 5242880 bytes")), true);
  const messages = [{ role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }, { role: "user", content: "plain" }];
  assert.deepEqual(withoutImages(messages), [{ role: "user", content: [{ type: "text", text: "Look" }, { type: "text", text: IMAGES_REFUSED_NOTE }] }, messages[1]]);
});

test("documents go whole to models that read them: every included model but DeepSeek, Claude's PDFs and text, OpenAI's PDFs", () => {
  const sol = documentsFor("ensemble", "gpt-6.1-sol");
  for (const name of ["memo.pdf", "brief.docx", "deck.pptx", "sales.xlsx", "data.csv", "notes.md", "info.json", "main.py"]) assert.equal(sol(name), true, name);
  for (const name of ["old.doc", "old.ppt", "old.xls", "plan.key", "chart.png", "call.mp3"]) assert.equal(sol(name), false, name);
  assert.equal(documentsFor("ensemble", "deepseek-v4-flash")("memo.pdf"), false);
  const claude = documentsFor("anthropic", "claude-sonnet-4-5");
  assert.deepEqual(["memo.pdf", "notes.md", "brief.docx"].map(claude), [true, true, false]);
  assert.equal(documentsFor("anthropic", "claude-3-haiku-20240307")("memo.pdf"), false);
  const openai = documentsFor("openai", "gpt-4.1");
  assert.deepEqual(["memo.pdf", "notes.md"].map(openai), [true, false]);
  for (const [provider, model] of [["copilot", "gpt-4.1"], ["google", "gemini-3.5-flash"], ["claude-code", "claude-sonnet-4-5"], [null, "gpt-6.1-sol"]]) assert.equal(documentsFor(provider, model)("memo.pdf"), false, `${provider} ${model}`);
});

test("a refused file becomes a note saying it was not given, with no text in its place", () => {
  assert.equal(filesRefused(new Error("Invalid file data: 'input[0].content[1].file_data'. Expected a base64-encoded data URL with a valid file MIME type")), true);
  assert.equal(filesRefused(new Error("The model is overloaded.")), false);
  const messages = [{ role: "user", content: [{ type: "text", text: "Read" }, { type: "file", file: { filename: "memo.pdf", file_data: "data:application/pdf;base64,AA" } }] }];
  assert.deepEqual(withoutFiles(messages)[0]!.content, [{ type: "text", text: "Read" }, { type: "text", text: "[The model's provider refused “memo.pdf” as a file, so it was not given. Say you could not open it rather than guess.]" }]);
});
