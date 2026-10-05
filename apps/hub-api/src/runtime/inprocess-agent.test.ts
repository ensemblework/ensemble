/**
 * Desktop agent turns stay in this process when ENSEMBLE_INPROCESS_RUNTIME is set.
 * The only model credential is a Gemini key saved the same way Settings stores it.
 * Gemini's HTTP API is stubbed. Nothing here starts Python, Docker, or the hosted runtime.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomBytes } from "node:crypto";
import "./test-env.js";
import { askRuntime, assistantEcho, toolResult, type ModelMessage } from "../lib/model-turn.js";
import { resetSecretKeyCacheForTests } from "../lib/secrets.js";
import { chatSpecs, responsesSpecs, runTool, toolSpecs, type JobContext } from "../workspace/tools.js";
import { saveCredential, setCredentialStoreForTests, type CredentialStore } from "./credentials.js";
import { setRuntimeFetchForTests } from "./models.js";
import { useInProcessRuntime } from "./mode.js";
import { resetBuckets, setRuntimeSleepForTests } from "./pace.js";
import { setPythonSpawnForTests } from "./python-spawn.js";

const USER = "desktop-user";
const KEY = "gemini-key-saved-in-settings";
const MODEL = "gemini-2.5-flash";

test("an in-process agent turn completes a task and a tool call with only a Gemini key", async () => {
  process.env.ENSEMBLE_INPROCESS_RUNTIME = "1";
  delete process.env.ENSEMBLE_DESKTOP;
  const previousKey = process.env.ENSEMBLE_SECRET_KEY;
  const previousGoogle = process.env.GOOGLE_API_KEY;
  const previousGemini = process.env.GEMINI_API_KEY;
  process.env.ENSEMBLE_SECRET_KEY = randomBytes(32).toString("base64");
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  resetSecretKeyCacheForTests();
  resetBuckets();
  setRuntimeSleepForTests(async () => undefined);

  const folder = mkdtempSync(join(tmpdir(), "ensemble-inprocess-agent-"));
  writeFileSync(join(folder, "notes.txt"), "hello from the work folder\n");
  const rows = new Map<string, { secret: string; baseUrl: string | null; hint: string; updatedAt: Date }>();
  const store: CredentialStore = {
    async read(userId, provider) {
      const row = rows.get(`${userId}\0${provider}`);
      return row ? { secret: row.secret, baseUrl: row.baseUrl } : null;
    },
    async list(userId) {
      return [...rows.entries()]
        .filter(([id]) => id.startsWith(`${userId}\0`))
        .map(([id, row]) => ({ provider: id.split("\0")[1] ?? "", hint: row.hint, updatedAt: row.updatedAt }));
    },
    async upsert(userId, provider, secret, hint, baseUrl) {
      rows.set(`${userId}\0${provider}`, { secret, baseUrl, hint, updatedAt: new Date() });
    },
    async remove(userId, provider) {
      rows.delete(`${userId}\0${provider}`);
    },
  };
  setCredentialStoreForTests(store);
  await saveCredential(USER, "google", KEY, null);
  assert.equal(rows.size, 1);

  const urls: string[] = [];
  let pythonSpawns = 0;
  const originalFetch = globalThis.fetch;
  setPythonSpawnForTests(async () => {
    pythonSpawns += 1;
    throw new Error("Python must not start for this agent task.");
  });
  globalThis.fetch = (async (input: string | URL) => {
    throw new Error(`Hosted fetch is not used on the desktop path: ${String(input)}`);
  }) as typeof fetch;
  setRuntimeFetchForTests(async (input, init) => {
    const url = String(input);
    urls.push(url);
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    const body = JSON.parse(String(init?.body)) as { model?: string; messages?: Array<{ role?: string; content?: string }> };
    assert.equal(body.model, MODEL);
    const turn = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    const call =
      turn === 0
        ? { id: "call_list", name: "list_dir", arguments: "{}" }
        : { id: "call_finish", name: "finish", arguments: JSON.stringify({ summary: "Listed the folder." }) };
    return new Response(
      JSON.stringify({
        model: MODEL,
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }],
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const ctx = {
    root: folder,
    finished: null,
    signal: new AbortController().signal,
  } as JobContext;
  const specs = toolSpecs("code", false);
  const messages: ModelMessage[] = [
    { role: "system", content: "You are Ensemble's desktop agent. Use tools, then finish." },
    { role: "user", content: "List this folder and finish." },
  ];
  const toolsUsed: string[] = [];
  try {
    assert.equal(useInProcessRuntime(), true);
    for (let turn = 0; turn < 4 && !ctx.finished; turn += 1) {
      const answer = await askRuntime({
        messages,
        model: MODEL,
        provider: "google",
        userId: USER,
        activityId: "job:inprocess",
        chatTools: chatSpecs(specs),
        responsesTools: responsesSpecs(specs),
      });
      messages.push(assistantEcho(answer));
      assert.ok(answer.toolCalls.length > 0, "the stubbed Gemini turn returns a tool call");
      for (const call of answer.toolCalls) {
        const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
        const result = await runTool(ctx, call.name, args);
        toolsUsed.push(call.name);
        assert.equal(result.ok, true, result.summary);
        if (call.name === "list_dir") {
          const listing = (result.result as { listing?: string }).listing ?? "";
          assert.match(listing, /notes\.txt/);
        }
        messages.push(toolResult(call.id, call.name, result.result));
      }
    }
    assert.deepEqual(toolsUsed, ["list_dir", "finish"]);
    assert.equal(ctx.finished, "Listed the folder.");
    assert.equal(urls.length, 2);
    assert.equal(pythonSpawns, 0);
    const sentBack = JSON.stringify(messages);
    assert.match(sentBack, /notes\.txt/);
    assert.equal(sentBack.includes("127.0.0.1:5055"), false);
  } finally {
    setRuntimeFetchForTests(null);
    setPythonSpawnForTests(null);
    setCredentialStoreForTests(null);
    setRuntimeSleepForTests(null);
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.ENSEMBLE_SECRET_KEY;
    else process.env.ENSEMBLE_SECRET_KEY = previousKey;
    if (previousGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = previousGoogle;
    if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGemini;
    resetSecretKeyCacheForTests();
  }
});
