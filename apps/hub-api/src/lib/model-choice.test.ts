import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "@ensemble/shared-types";
import { ModelChoiceError, providerForModel } from "./model-choice.js";
import { providerForCall } from "../runtime/payload.js";
import { ModelAuthError } from "../runtime/errors.js";

const settings = {
  models: {
    ...DEFAULT_SETTINGS.models,
    easy: { provider: "copilot" as const, model: "mai-code-1.1-flash", effort: "default" as const },
    medium: { provider: "copilot" as const, model: "gpt-5.4-mini", effort: "low" as const },
    high: { provider: "openrouter" as const, model: "gpt-5.4-mini", effort: "default" as const },
  },
};

test("a picked model keeps its provider, matches a tier, or is refused; it never borrows a tier's provider", () => {
  assert.equal(providerForModel(settings, "mai-code-1.1-flash", "copilot"), "copilot");
  assert.equal(providerForModel(settings, "mai-code-1.1-flash"), "copilot", "the tier that runs it says which provider");
  assert.equal(providerForModel(settings, "gemini-3.5-flash"), "google", "an id with a vendor prefix names it");
  assert.throws(() => providerForModel(settings, "gpt-5.4-mini"), (error: unknown) => error instanceof ModelChoiceError && /more than one provider/.test(error.message));
  assert.throws(() => providerForModel(settings, "grok-5-mini"), (error: unknown) => error instanceof ModelChoiceError && /Say which provider runs grok-5-mini/.test(error.message));
});

test("a model call without a provider is refused unless the id names its maker", () => {
  assert.equal(providerForCall("copilot", "mai-code-1.1-flash"), "copilot");
  assert.equal(providerForCall(undefined, "claude-opus-5-5"), "anthropic");
  assert.throws(() => providerForCall(undefined, "mai-code-1.1-flash"), (error: unknown) => error instanceof ModelAuthError && /No provider was named/.test(error.message));
});
