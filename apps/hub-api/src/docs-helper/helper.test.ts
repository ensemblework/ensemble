import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { type DocsIndex } from "@ensemble/docs/search";
import { answerQuestion, callIncludedDocs, helperPayload, MAX_OUTPUT_TOKENS } from "./answer.js";
import { documentationIndex, retrieve } from "./grounding.js";
import { docsHelperRoutes } from "./routes.js";
import { admitDocs, docsAddress } from "./limits.js";
import type { Redis } from "ioredis";

const index: DocsIndex = { version: 1, pages: [{ title: "Connected apps", path: "/31_connectors_in_use/", sections: [
  { heading: "Connect an app", url: "https://docs.ensemblework.com/31_connectors_in_use/#connect", text: "Open Settings → Connections and choose an app. Connecting an account imports nothing. Code: apps/hub-api/src/routes/connectors.ts" },
  { heading: "Permissions", url: "https://docs.ensemblework.com/31_connectors_in_use/#permissions", text: "A viewer cannot change a shared task." },
] }] };
const reply = JSON.stringify({ found: true, answer: "Open Settings → Connections and choose an app.", citations: [1] });

test("a natural-language hit receives only retrieved passages and returns their citations", async () => {
  let calls = 0;
  const answer = await answerQuestion("How do I connect an app?", index, async (payload) => {
    calls++;
    const input = JSON.parse(payload.input);
    assert.equal(input.question, "How do I connect an app?");
    assert.deepEqual(input.passages.map(({ citation, ...passage }: { citation: number }) => passage), retrieve(index, input.question));
    assert.doesNotMatch(payload.input, /cannot change a shared task/);
    assert.equal(payload.model, "gpt-5-mini");
    assert.deepEqual(payload.reasoning, { effort: "medium" });
    assert.equal(payload.store, false);
    assert.equal(payload.max_output_tokens, MAX_OUTPUT_TOKENS);
    assert.equal("tools" in payload, false);
    return reply;
  });
  assert.equal(calls, 1);
  assert.equal(answer.found, true);
  assert.equal(answer.sources[0]?.url, index.pages[0]!.sections[0]!.url);
});

test("a retrieval miss calls no model and supplies no code text", async () => {
  const answer = await answerQuestion("zzzzquasar teleportation", index, async () => { throw new Error("Must not call model"); });
  assert.equal(answer.found, false);
  assert.match(answer.answer, /not in the docs/);
  assert.equal(answer.sources[0]?.url, "https://docs.ensemblework.com/");
});

test("a related passage cannot justify an undocumented procedure or an invented citation", async () => {
  for (const response of [
    { found: false, answer: "Unsupported", citations: [] },
    { found: true, answer: "Run the secret procedure.", citations: [4] },
    { found: true, answer: "See https://github.com/private/source", citations: [1] },
  ]) {
    const answer = await answerQuestion("Connect an app to a flux capacitor", index, async () => JSON.stringify(response));
    assert.equal(answer.found, false);
    assert.match(answer.answer, /not in the docs/);
  }
});

test("index loading fetches only published pages, bounds and validates them, and caches", async () => {
  let count = 0;
  const load = documentationIndex(async (url, options) => {
    count++;
    assert.equal(url, "https://docs.ensemblework.com/search-index.json");
    assert.deepEqual(options?.headers, { accept: "application/json" });
    assert.equal(options?.redirect, "error");
    return Response.json(index);
  });
  await load(); await load();
  assert.equal(count, 1);
  for (const url of ["https://github.com/ensemblework/ensemble/blob/main/file", "https://docs.ensemblework.com.evil.test/a"]) {
    const changed = structuredClone(index);
    changed.pages[0]!.sections[0]!.url = url;
    await assert.rejects(documentationIndex(async () => Response.json(changed))());
  }
});

test("Azure transport reuses included configuration, sends medium and caps its one request", async () => {
  const names = ["AZURE_FOUNDRY_RESOURCE", "AZURE_FOUNDRY_API_KEY", "ENSEMBLE_INCLUDED_MODELS", "ENSEMBLE_DESKTOP"];
  const saved = names.map((name) => process.env[name]);
  Object.assign(process.env, { AZURE_FOUNDRY_RESOURCE: "docs-fixture", AZURE_FOUNDRY_API_KEY: "fixture-key", ENSEMBLE_INCLUDED_MODELS: "gpt-5-mini", ENSEMBLE_DESKTOP: "0" });
  try {
    const answer = await callIncludedDocs(helperPayload("connect app", retrieve(index, "connect app")), async (url, init) => {
      assert.equal(url, "https://docs-fixture.openai.azure.com/openai/v1/responses");
      assert.equal((init?.headers as Record<string, string>)["api-key"], "fixture-key");
      const payload = JSON.parse(String(init?.body));
      assert.deepEqual(payload.reasoning, { effort: "medium" });
      assert.equal(payload.model, "gpt-5-mini");
      assert.ok(payload.max_output_tokens <= 4096);
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: reply }] }] });
    });
    assert.equal(answer, reply);
  } finally { names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }); }
});

test("anonymous route validates input, enforces limits before retrieval, and fails closed", async () => {
  const app = Fastify();
  let wait = 0;
  let unavailable = false;
  let loads = 0;
  await app.register(docsHelperRoutes, { dependencies: { index: async () => { loads++; return index; }, call: async () => reply, admit: async () => { if (unavailable) throw Error("Redis offline"); return wait; } } });
  try {
    const request = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/docs/ask", payload });
    for (const payload of [{}, { question: " " }, { question: "a".repeat(501) }, { question: "connect app", context: "private code" }, { question: "connect app", model: "other" }]) assert.equal((await request(payload)).statusCode, 400);
    const hit = await request({ question: "How do I connect an app?" });
    assert.equal(hit.statusCode, 200);
    assert.equal(hit.json().found, true);
    assert.equal(hit.headers["cache-control"], "no-store");
    assert.equal(hit.headers["set-cookie"], undefined);
    wait = 60;
    const blocked = await request({ question: "connect app" });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.headers["retry-after"], "60");
    unavailable = true;
    assert.equal((await request({ question: "connect app" })).statusCode, 503);
    assert.equal(loads, 1);
  } finally { await app.close(); }
});

test("untrusted forwarding headers cannot rotate an address; IPv6 addresses share a /64", () => {
  const fake = (ip: string, headers = {}) => docsAddress({ ip, headers } as Parameters<typeof docsAddress>[0]);
  assert.equal(fake("203.0.113.7", { "x-forwarded-for": "1.1.1.1", "cf-connecting-ip": "1.1.1.1" }), "203.0.113.7");
  assert.equal(fake("127.0.0.1", { "cf-connecting-ip": "203.0.113.7" }), "203.0.113.7");
  assert.equal(fake("2001:db8:1:2::3"), fake("2001:0db8:0001:0002::4"));
});

test("limiter atomically admits all four durable windows without storing the raw address", async () => {
  const redis = { status: "ready", eval: async (script: string, count: number, ...args: (string | number)[]) => {
    assert.equal(count, 4);
    assert.doesNotMatch(args.join(" "), /203\.0\.113\.7/);
    assert.deepEqual(args.slice(4), [6, 60, 30, 86400, 100, 86400, 1000, 2678400]);
    assert.match(script, /INCR/);
    return 42;
  } } as unknown as Redis;
  assert.equal(await admitDocs(redis, "203.0.113.7"), 42);
});
