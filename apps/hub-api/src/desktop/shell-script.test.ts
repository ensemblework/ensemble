/**
 * The fetch wrapper in the desktop shell's init script (site.rs), run in a
 * plain VM context. Next's router calls fetch with a URL object for route
 * data, so the wrapper must not turn that into fetch("").
 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { desktopInitScript } from "./shell-script.js";

const API = "http://127.0.0.1:51234";
const TOKEN = "launch-token";
const PAGE = "ensemble://localhost/board/";

type Call = { input: unknown; init: RequestInit | undefined };

function load(api = API, token = TOKEN) {
  const calls: Call[] = [];
  const fetch = (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(new Response("ok"));
  };
  class FakeXhr {
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const window: Record<string, unknown> = { fetch };
  const context = vm.createContext({
    window,
    URL,
    Request,
    Headers,
    Response,
    XMLHttpRequest: FakeXhr,
    document: { addEventListener() {} },
    location: { href: PAGE },
  });
  vm.runInContext(desktopInitScript(api, token), context);
  const wrapped = window.fetch as (input: unknown, init?: RequestInit) => Promise<Response>;
  return { calls, fetch: wrapped };
}

const urlOf = (input: unknown) => (typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
const auth = (call: Call) => new Headers(call.init?.headers).get("Authorization");

test("a URL object for route data goes through unchanged, not as fetch(\"\")", async () => {
  const { calls, fetch } = load();
  const route = new URL("ensemble://localhost/board/index.txt?_rsc=abc");
  const init = { credentials: "same-origin" as const, headers: { RSC: "1" } };
  await fetch(route, init);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.input, route, "the same URL object reaches the real fetch");
  assert.equal(calls[0]!.init, init, "the caller's options are untouched");
  assert.equal(auth(calls[0]!), null, "the launch token never goes to a non-API address");
  const notePage = new URL("ensemble://localhost/pages/abc/index.txt?_rsc=def");
  await fetch(notePage, init);
  assert.equal(calls[1]!.input, notePage, "a deeper dynamic route's data goes through the same way");
});

test("a non-API string and a non-API Request keep their own input and options", async () => {
  const { calls, fetch } = load();
  await fetch("/_next/static/chunks/app.js");
  const posted = new Request("https://example.com/upload", { method: "POST", body: "payload" });
  await fetch(posted);
  assert.equal(calls[0]!.input, "/_next/static/chunks/app.js");
  assert.equal(calls[0]!.init, undefined);
  assert.equal(calls[1]!.input, posted, "a Request keeps its method and body");
  assert.equal((calls[1]!.input as Request).method, "POST");
});

test("API strings are pointed at the sidecar with the launch token", async () => {
  const { calls, fetch } = load();
  await fetch("/api/tasks");
  await fetch("http://127.0.0.1:4000/api/tasks/abc/page", { method: "PUT", body: "{}", headers: { "Content-Type": "application/json" } });
  await fetch(`${API}/api/shell`);
  await fetch("/health");
  assert.deepEqual(calls.map((call) => urlOf(call.input)), [`${API}/api/tasks`, `${API}/api/tasks/abc/page`, `${API}/api/shell`, `${API}/health`]);
  assert.ok(calls.every((call) => auth(call) === `Bearer ${TOKEN}`));
  assert.equal(calls[1]!.init?.method, "PUT");
  assert.equal(calls[1]!.init?.body, "{}");
  assert.equal(new Headers(calls[1]!.init?.headers).get("Content-Type"), "application/json");
});

test("an API URL object or Request is rewritten and keeps its method and body", async () => {
  const { calls, fetch } = load();
  await fetch(new URL("http://localhost:4000/api/tasks?take=5"));
  const request = new Request("http://127.0.0.1:4000/api/tasks", { method: "POST", body: JSON.stringify({ title: "x" }), headers: { "Content-Type": "application/json" } });
  await fetch(request);
  assert.equal(urlOf(calls[0]!.input), `${API}/api/tasks?take=5`);
  assert.equal(auth(calls[0]!), `Bearer ${TOKEN}`);
  const sent = calls[1]!.input as Request;
  assert.ok(sent instanceof Request);
  assert.equal(sent.url, `${API}/api/tasks`);
  assert.equal(sent.method, "POST");
  assert.equal(await sent.text(), JSON.stringify({ title: "x" }));
  const headers = new Headers(calls[1]!.init?.headers);
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("Authorization"), `Bearer ${TOKEN}`);
});

test("a caller's own Authorization header wins", async () => {
  const { calls, fetch } = load();
  await fetch("/api/devices", { headers: { Authorization: "Bearer device" } });
  assert.equal(auth(calls[0]!), "Bearer device");
});

test("with no sidecar, every fetch goes through as the caller wrote it", async () => {
  const { calls, fetch } = load("", "");
  const route = new URL("ensemble://localhost/tasks/abc/index.txt?_rsc=1");
  await fetch(route);
  await fetch("/api/tasks");
  assert.equal(calls[0]!.input, route);
  assert.equal(calls[1]!.input, "/api/tasks");
});
