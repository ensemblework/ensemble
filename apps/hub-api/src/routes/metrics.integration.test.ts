import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";

const h = await createHttpHarness();
after(() => h.close());

test("provider and date filters apply to calls, models, daily totals and purposes, including unreported tokens", async () => {
  const user = await h.asUser();
  const other = await h.asUser();
  const ts = new Date();
  for (const [provider, model, input, output] of [["openai", "gpt-4.1-mini", 100, 20], ["codex", "gpt-4.1-mini", null, null], ["ollama", "llama3.2", 300, 50]] as const) {
    await h.prisma.metricEvent.create({ data: { userId: user.id, kind: "model.call", ts, payload: { provider, model, tokensIn: input, tokensOut: output, purpose: "Hub chat", title: `${provider} call`, estimatedUsd: provider === "codex" ? 0 : null } } });
  }
  await h.prisma.metricEvent.create({ data: { userId: other.id, kind: "model.call", payload: { provider: "google", model: "gemini", tokensIn: 500, title: "Keep private" } } });
  await h.prisma.metricEvent.create({ data: { userId: user.id, kind: "model.call", ts: new Date(Date.now() - 20 * 86_400_000), payload: { provider: "anthropic", model: "claude-old", tokensIn: 200, title: "Older call" } } });
  const all = (await user.inject({ method: "GET", url: "/api/metrics/summary" })).json();
  assert.equal(all.byModel.length, 3, "same model on two providers remains separate");
  assert.equal(all.recent.length, 3, "a plan call without counts is still a call");
  assert.equal(all.recent.find((call: { provider: string }) => call.provider === "codex").estimatedUsd, null);
  assert.equal(all.recent.find((call: { provider: string }) => call.provider === "ollama").estimatedUsd, null);
  assert.deepEqual(all.reporting, { calls: 3, withInput: 2, withOutput: 2 });
  assert.equal(JSON.stringify(all).includes("Keep private"), false);
  const local = (await user.inject({ method: "GET", url: "/api/metrics/summary?provider=ollama&days=30" })).json();
  assert.equal(local.days.length, 30);
  assert.equal(local.byModel.length, 1);
  assert.equal(local.byModel[0].provider, "ollama");
  assert.equal(local.byPurpose[0].calls, 1);
  assert.equal(local.byPurpose[0].tokensIn, 300);
  assert.equal(local.days.reduce((sum: number, day: { calls: number }) => sum + day.calls, 0), 1);
  assert.equal(local.recent.length, 1);
  assert.ok(local.providers.includes("anthropic"), "provider choices cover the entire selected window");
  const wider = (await user.inject({ method: "GET", url: "/api/metrics/summary?days=30" })).json();
  assert.equal(wider.recent.length, 4);
  assert.equal((await user.inject({ method: "GET", url: "/api/metrics/summary?days=9999" })).statusCode, 400);
});

test("context erasure handles linked files and people repeatedly and rejects email confirmation", async () => {
  const user = await h.asUser();
  const person = await h.prisma.person.create({ data: { userId: user.id, name: "Mira Chen" } });
  await h.prisma.personIdentity.create({ data: { userId: user.id, personId: person.id, kind: "email", value: "mira@fieldnote.example" } });
  const project = await h.prisma.project.create({ data: { userId: user.id, name: "Fieldnote" } });
  await h.prisma.projectPerson.create({ data: { projectId: project.id, personId: person.id } });
  const artifact = await h.prisma.artifact.create({ data: { userId: user.id, kind: "file", externalId: "saved", ts: new Date(), actorId: person.id } });
  await h.prisma.document.create({ data: { userId: user.id, filename: "plan.txt", mediaType: "text/plain", byteSize: 4, original: Buffer.from("plan"), format: "text", sha256: "test-hash", artifactId: artifact.id } });
  const wrong = await user.inject({ method: "POST", url: "/api/data/delete", payload: { scope: "context", confirm: user.email } });
  assert.equal(wrong.statusCode, 400);
  for (let i = 0; i < 2; i++) {
    const result = await user.inject({ method: "POST", url: "/api/data/delete", payload: { scope: "context", confirm: "delete people and app information" } });
    assert.equal(result.statusCode, 200, result.body);
  }
  assert.equal(await h.prisma.person.count({ where: { userId: user.id } }), 0);
  assert.equal(await h.prisma.document.count({ where: { userId: user.id } }), 0);
  assert.ok(await h.prisma.project.findUnique({ where: { id: project.id } }));
});
