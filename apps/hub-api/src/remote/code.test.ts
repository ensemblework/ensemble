/**
 * The computer's side of the web's Code tab (protocol 4): which calls it answers, what never leaves
 * it, and the switches that stop it. The Code API itself is stood in for by a fake `inject`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const state = mkdtempSync(join(tmpdir(), "remote-code-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = state;
process.env.REDIS_URL ??= "memory://local";
const { codeAnswerFor } = await import("./code.js");
const { codeCall } = await import("./contract.js");

function settings(change: Record<string, unknown>): void {
  writeFileSync(join(state, "remote.json"), JSON.stringify({ version: 1, enabled: true, ...change }));
}

type Call = { method: string; url: string; headers: Record<string, string>; payload?: string };

function fakeApp(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  return {
    calls,
    app: {
      inject: async (options: Call) => {
        calls.push(options);
        const path = options.url.split("?")[0]!;
        const answer = answers[`${options.method} ${path}`] ?? { status: 404, body: { error: "not here" } };
        return { statusCode: answer.status ?? 200, body: JSON.stringify(answer.body) };
      },
    } as never,
  };
}

const request = (method: "GET" | "POST" | "PUT", path: string, query: Record<string, string> = {}, body?: unknown) => ({ id: "r1", method, path, query, body });

test("only the Code calls on the list, checked the same way on both ends", () => {
  assert.ok(codeCall("GET", "/api/code/reviews"));
  assert.ok(codeCall("PUT", "/api/code/file")?.write);
  assert.ok(codeCall("POST", "/api/code/reviews/0f0e2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f/accept")?.slow);
  assert.equal(codeCall("POST", "/api/code/folders/resolve"), null, "the folders Code may use are set on the computer");
  assert.equal(codeCall("GET", "/api/terminal/status"), null);
  assert.equal(codeCall("DELETE", "/api/code/file"), null);
  assert.equal(codeCall("GET", "/api/code/reviews/../../settings"), null);
});

test("a call goes to this computer's own Code API as its own user; anything else is refused", async () => {
  settings({});
  const { app, calls } = fakeApp({ "GET /api/code/reviews": { body: { reviews: [], ttlDays: 14 } } });
  const ok = await codeAnswerFor(app, request("GET", "/api/code/reviews", { filter: "all" }));
  assert.deepEqual(ok, { status: 200, body: { reviews: [], ttlDays: 14 } });
  assert.equal(calls[0]!.url, "/api/code/reviews?filter=all");
  assert.ok(calls[0]!.headers["x-ensemble-internal"], "the computer's own internal key, never the web's");
  const refused = await codeAnswerFor(app, request("POST", "/api/code/folders/resolve", {}, { path: "/" }));
  assert.equal(refused.status, 403);
  assert.equal(calls.length, 1, "a refused call never reaches the API");
});

test("git's own files and secrets files are refused by path, for reading and writing", async () => {
  settings({});
  const { app, calls } = fakeApp({});
  for (const [method, path, query, body] of [
    ["GET", "/api/code/file", { repo: "/r", path: ".env" }, undefined],
    ["GET", "/api/code/diff", { repo: "/r", path: "config/.GIT/config" }, undefined],
    ["PUT", "/api/code/file", {}, { repo: "/r", path: "deploy/id_rsa", content: "x" }],
    ["POST", "/api/code/scm/stage", {}, { repo: "/r", paths: ["src/a.ts", ".ssh/config"] }],
  ] as const) {
    const answer = await codeAnswerFor(app, request(method, path, query as Record<string, string>, body));
    assert.equal(answer.status, 403, `${method} ${path}`);
  }
  assert.equal(calls.length, 0);
});

test("the switches on this computer stop reading (browse) and changing (edit) code from the web", async () => {
  const { app } = fakeApp({ "GET /api/code/scm": { body: { branch: "main" } }, "POST /api/code/scm/commit": { body: { ok: true } } });
  settings({ browseFiles: false });
  assert.equal((await codeAnswerFor(app, request("GET", "/api/code/scm", { repo: "/r" }))).status, 409);
  settings({ webEdit: false });
  assert.equal((await codeAnswerFor(app, request("GET", "/api/code/scm", { repo: "/r" }))).status, 200, "reading still works");
  const commit = await codeAnswerFor(app, request("POST", "/api/code/scm/commit", {}, { repo: "/r", message: "m" }));
  assert.equal(commit.status, 409);
  assert.match(String((commit.body as { error: string }).error), /ensemble web edit on/);
  settings({});
  assert.equal((await codeAnswerFor(app, request("POST", "/api/code/scm/commit", {}, { repo: "/r", message: "m" }))).status, 200);
});

test("keys are hidden on the way out, and a file that holds one opens read-only and cannot be saved from the web", async () => {
  settings({});
  const key = "sk-abcdefghijklmnop1234567890";
  const { app, calls } = fakeApp({
    "GET /api/code/file": { body: { path: "src/config.ts", content: `export const key = "${key}";\nconst password: string = load();\n` } },
    "GET /api/code/diff": { body: { diff: { path: "src/config.ts", fileHeader: "", hunks: [{ key: "k", header: "@@", raw: `+${key}`, lines: [{ type: "add", text: key }] }] }, decisions: [] } },
    "PUT /api/code/file": { body: { ok: true } },
  });
  const file = await codeAnswerFor(app, request("GET", "/api/code/file", { repo: "/r", path: "src/config.ts" }));
  const body = file.body as { content: string; readOnly?: string };
  assert.doesNotMatch(body.content, /sk-abcdef/);
  assert.match(body.content, /password: string = load\(\)/, "ordinary code that mentions a password is not hidden");
  assert.match(body.readOnly ?? "", /key/);
  const diff = await codeAnswerFor(app, request("GET", "/api/code/diff", { repo: "/r", path: "src/config.ts" }));
  assert.doesNotMatch(JSON.stringify(diff.body), /sk-abcdef/);
  const save = await codeAnswerFor(app, request("PUT", "/api/code/file", {}, { repo: "/r", path: "src/config.ts", content: 'export const key = "[redacted]";\n' }));
  assert.equal(save.status, 403, "the mask is never written back");
  assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
});

test("binary and very large files, secrets files in a review, and answers too large for the web", async () => {
  settings({});
  const { app } = fakeApp({
    "GET /api/code/file": { body: { path: "logo.png", content: "PNG\u0000\u0001" } },
    "GET /api/code/source": { body: { files: [{ path: "src/a.ts" }, { path: ".env.production" }], unreviewable: [] } },
    "GET /api/code/scm": { body: { log: "x".repeat(3_200_000) } },
  });
  const binary = await codeAnswerFor(app, request("GET", "/api/code/file", { repo: "/r", path: "logo.png" }));
  assert.equal((binary.body as { binary?: boolean }).binary, true);
  const source = await codeAnswerFor(app, request("GET", "/api/code/source", { repo: "/r" }));
  const sourceBody = source.body as { files: Array<{ path: string }>; unreviewable: Array<{ path: string }> };
  assert.deepEqual(sourceBody.files.map((row) => row.path), ["src/a.ts"]);
  assert.deepEqual(sourceBody.unreviewable.map((row) => row.path), [".env.production"]);
  assert.equal((await codeAnswerFor(app, request("GET", "/api/code/scm", { repo: "/r" }))).status, 413);
  const big = await codeAnswerFor(app, request("PUT", "/api/code/file", {}, { repo: "/r", path: "a.txt", content: "x".repeat(1024 * 1024 + 1) }));
  assert.equal(big.status, 413);
});
