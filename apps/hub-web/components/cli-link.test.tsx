import { setTestUrl } from "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { CliLink } from "./cli-link.js";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

const request = {
  clientName: "Mira MacBook",
  platform: "darwin-arm64",
  version: "0.1.0",
  scopes: ["mcp", "runner"],
  createdAt: "2026-10-06T00:00:00.000Z",
  expiresAt: "2026-10-06T00:10:00.000Z",
  status: "pending",
  requestedFrom: "203.0.113.7",
  sameNetwork: false,
};

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
}

async function render(initialCode: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<CliLink initialCode={initialCode} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { host, root };
}

function confirmCode(host: HTMLElement) {
  const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(box, "Missing confirmation checkbox");
  act(() => {
    box.click();
  });
}

function button(host: HTMLElement, label: RegExp): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find((item) => label.test(item.textContent ?? ""));
  assert.ok(found, `Missing button ${label}`);
  return found;
}

function click(host: HTMLElement, label: RegExp) {
  const button = Array.from(host.querySelectorAll("button")).find((item) => label.test(item.textContent ?? ""));
  assert.ok(button, `Missing button ${label}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

test("CLI link approves the loaded device request", async () => {
  setTestUrl("http://localhost/link?code=ABCD-EFGH");
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/cli/auth/request?code=ABCD-EFGH") return json(request);
    if (url === "/api/cli/auth/approve") return json({ ok: true, scopes: ["mcp", "runner"] });
    return json({ error: "not found" }, { status: 404 });
  };
  const { host, root } = await render("ABCD-EFGH");
  try {
    assert.match(host.textContent ?? "", /Ensemble CLI on Mira MacBook/);
    assert.match(host.textContent ?? "", /Never approve a\s+code someone sent you/);
    assert.match(host.textContent ?? "", /203\.0\.113\.7/);
    assert.match(host.textContent ?? "", /different network address than this browser/);
    assert.equal(button(host, /^Approve$/).disabled, true);
    confirmCode(host);
    assert.equal(button(host, /^Approve$/).disabled, false);
    click(host, /^Approve$/);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.deepEqual(calls.at(-1), {
      url: "/api/cli/auth/approve",
      body: { userCode: "ABCD-EFGH", scopes: ["mcp", "runner"], decision: "approve" },
    });
    assert.match(host.textContent ?? "", /Return to your terminal/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = realFetch;
    setTestUrl("http://localhost/");
  }
});

test("CLI link offers MCP-only approval when runner needs email verification", async () => {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url === "/api/cli/auth/request?code=WXYZ-1234") return json(request);
    if (url === "/api/cli/auth/approve" && body?.scopes?.includes("runner")) return json({ error: "EMAIL_UNVERIFIED" }, { status: 403 });
    if (url === "/api/cli/auth/approve") return json({ ok: true, scopes: ["mcp"] });
    return json({ error: "not found" }, { status: 404 });
  };
  const { host, root } = await render("WXYZ-1234");
  try {
    confirmCode(host);
    click(host, /^Approve$/);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.match(host.textContent ?? "", /Verify your email/);
    assert.match(host.textContent ?? "", /Approve MCP only/);
    click(host, /Approve MCP only/);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.deepEqual(calls.at(-1), {
      url: "/api/cli/auth/approve",
      body: { userCode: "WXYZ-1234", scopes: ["mcp"], decision: "approve" },
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = realFetch;
  }
});

test("CLI link explains expired codes", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => json({ error: "not found" }, { status: 404 });
  const { host, root } = await render("OLD-CODE");
  try {
    assert.match(host.textContent ?? "", /expired, was already used/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = realFetch;
  }
});

test("CLI link reads the code from the address when no code is passed", async () => {
  setTestUrl("http://localhost/link?code=QRST-VWXZ");
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return json(request);
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<CliLink />);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.ok(urls.includes("/api/cli/auth/request?code=QRST-VWXZ"), urls.join(", "));
    assert.match(host.textContent ?? "", /Ensemble CLI on Mira MacBook/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = realFetch;
    setTestUrl("http://localhost/");
  }
});
