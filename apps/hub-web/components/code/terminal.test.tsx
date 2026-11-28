import { setTestUrl } from "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Terminal } from "./terminal.js";
import { terminalAccess } from "./terminal-address.js";
import { TERMINAL_DESKTOP_BODY, TERMINAL_DESKTOP_TITLE } from "./terminal-desktop-note.js";

// terminal-mark.tsx is compiled with the classic JSX runtime under tsx, so it needs React in scope here.
(globalThis as { React?: typeof React }).React = React;
if (typeof Element !== "undefined" && typeof Element.prototype.scrollTo !== "function") Element.prototype.scrollTo = () => undefined;

type DesktopWindow = Window & { __ENSEMBLE_DESKTOP__?: { apiBase?: string } };

const STATUS = { enabled: true, roots: ["/work"], home: "/work" };

async function mount(statusCode = 200, onClose: () => void = () => {}): Promise<{ host: HTMLDivElement; calls: string[]; done: () => Promise<void> }> {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (statusCode !== 200) return new Response(JSON.stringify({ error: "The host terminal is disabled." }), { status: statusCode, headers: { "Content-Type": "application/json" } });
    const body = url.endsWith("/api/terminal/cd") ? { cwd: "/work", scope: "/work" } : STATUS;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Terminal onClose={onClose} />
      </QueryClientProvider>,
    );
  });
  // Let the status query (if any) resolve and re-render.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  return {
    host,
    calls,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
    },
  };
}

/** The command line: there only once the terminal is open. */
const prompt = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[placeholder="git status"]');

test("a denied terminal status settles into an explicit error with recovery guidance", async () => {
  const view = await mount(403);
  try {
    assert.match(view.host.querySelector('[role="alert"]')?.textContent ?? "", /host terminal is disabled/);
    assert.equal(view.host.textContent?.includes("Opening the terminal"), false);
    assert.ok(view.host.querySelector('a[href="/settings#devices"]'));
  } finally {
    await view.done();
  }
});

test("inside the desktop app the terminal explains why it is not available", async () => {
  (window as DesktopWindow).__ENSEMBLE_DESKTOP__ = { apiBase: "http://127.0.0.1:1" };
  try {
    const view = await mount();
    try {
      const note = view.host.querySelector('[data-testid="terminal-desktop-note"]');
      assert.ok(note, "desktop note is shown");
      assert.equal(note.getAttribute("role"), "note");
      assert.ok(note.textContent?.includes(TERMINAL_DESKTOP_TITLE));
      assert.ok(note.textContent?.includes(TERMINAL_DESKTOP_BODY));
      // The panel is still there (not hidden), with its title and close button.
      assert.ok(view.host.textContent?.includes("Terminal"));
      assert.ok(view.host.querySelector('button[title^="Close"]'));
      // No prompt, and no terminal API calls.
      assert.equal(prompt(view.host), null);
      assert.deepEqual(view.calls, []);
    } finally {
      await view.done();
    }
  } finally {
    delete (window as DesktopWindow).__ENSEMBLE_DESKTOP__;
  }
});

test("in a normal browser the terminal opens at once: no passkey, no code, no unlock", async () => {
  assert.equal((window as DesktopWindow).__ENSEMBLE_DESKTOP__, undefined);
  let closed = 0;
  const view = await mount(200, () => (closed += 1));
  try {
    assert.equal(view.host.querySelector('[data-testid="terminal-desktop-note"]'), null);
    assert.equal(view.host.textContent?.includes(TERMINAL_DESKTOP_TITLE), false);
    assert.ok(view.calls.some((url) => url.endsWith("/api/terminal/status")), `status was fetched: ${view.calls.join(", ")}`);
    assert.ok(view.calls.some((url) => url.endsWith("/api/terminal/cd")), "it opens in its folder");
    const field = prompt(view.host);
    assert.ok(field, "the command line is there");
    assert.equal(view.host.querySelector('input[type="password"]'), null);
    assert.doesNotMatch(view.host.textContent ?? "", /passkey|Touch ID|unlock|Lock now/i);
    assert.equal(view.host.querySelector('button[title="Lock now"]'), null);
    // `exit` closes the panel.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(field, "exit");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.equal(closed, 1);
  } finally {
    await view.done();
  }
});

test("the note says what is true: the desktop app's token is its agents' too, and no browser fallback", () => {
  assert.match(TERMINAL_DESKTOP_BODY, /same token its agents use/);
  assert.match(TERMINAL_DESKTOP_BODY, /own terminal app/);
  assert.doesNotMatch(TERMINAL_DESKTOP_BODY, /browser|Touch ID|passkey/i);
});

async function atUrl(url: string, check: (view: Awaited<ReturnType<typeof mount>>) => void): Promise<void> {
  setTestUrl(url);
  try {
    const view = await mount();
    try {
      check(view);
    } finally {
      await view.done();
    }
  } finally {
    setTestUrl("http://localhost/");
  }
}

function addressNote(host: HTMLElement): Element | null {
  return host.querySelector('[data-testid="terminal-address-note"]');
}

test("on localhost (any port) the terminal opens", async () => {
  await atUrl("http://localhost:3100/code", (view) => {
    assert.equal(addressNote(view.host), null);
    assert.ok(prompt(view.host));
  });
});

test("on an https domain this server's own terminal says it is not available there, because it runs only from localhost", async () => {
  await atUrl("https://app.ensemblework.com/code", (view) => {
    const note = addressNote(view.host);
    assert.ok(note, "address note is shown");
    assert.equal(note.getAttribute("data-reason"), "named-host");
    assert.match(note.textContent ?? "", /not available at app\.ensemblework\.com\./);
    assert.doesNotMatch(note.textContent ?? "", /localhost:3000|IP address|passkey/i);
    assert.equal(prompt(view.host), null);
  });
});

test("on 127.0.0.1 the terminal points at localhost on the same port", async () => {
  await atUrl("http://127.0.0.1:3100/code", (view) => {
    const note = addressNote(view.host);
    assert.ok(note);
    assert.equal(note.getAttribute("data-reason"), "loopback-ip");
    assert.match(note.textContent ?? "", /Open Ensemble at http:\/\/localhost:3100 to use the terminal/);
    assert.doesNotMatch(note.textContent ?? "", /localhost:3000|passkey/i);
    assert.equal(prompt(view.host), null);
  });
});

test("on a LAN IP the terminal says it opens only on the computer running Ensemble, without a localhost URL", async () => {
  await atUrl("http://192.168.1.20:3000/code", (view) => {
    const note = addressNote(view.host);
    assert.ok(note);
    assert.equal(note.getAttribute("data-reason"), "ip");
    assert.match(note.textContent ?? "", /only on the computer running Ensemble/);
    assert.doesNotMatch(note.textContent ?? "", /https?:\/\/localhost/);
    assert.equal(prompt(view.host), null);
  });
});

test("the desktop note still wins over any address message", async () => {
  (window as DesktopWindow).__ENSEMBLE_DESKTOP__ = { apiBase: "http://127.0.0.1:1" };
  try {
    await atUrl("http://127.0.0.1:1430/", (view) => {
      assert.ok(view.host.querySelector('[data-testid="terminal-desktop-note"]'));
      assert.equal(addressNote(view.host), null);
      assert.deepEqual(view.calls, []);
    });
  } finally {
    delete (window as DesktopWindow).__ENSEMBLE_DESKTOP__;
  }
});

test("terminalAccess: every address the server refuses gets a message, and none hard-codes port 3000", () => {
  const at = (url: string) => {
    const { protocol, hostname, port } = new URL(url);
    return terminalAccess({ protocol, hostname, port });
  };
  assert.deepEqual(at("http://localhost:3000/"), { ok: true });
  assert.deepEqual(at("http://localhost/"), { ok: true });
  const cases: Array<[string, string, RegExp | null]> = [
    ["http://127.0.0.1:4100/", "loopback-ip", /http:\/\/localhost:4100\b/],
    ["http://127.8.9.1/", "loopback-ip", /http:\/\/localhost to use/],
    ["http://[::1]:5173/", "loopback-ip", /http:\/\/localhost:5173\b/],
    ["https://127.0.0.1:8443/", "loopback-ip", /https:\/\/localhost:8443\b/],
    ["http://10.0.0.4:3000/", "ip", null],
    ["https://20.40.60.80/", "ip", null],
    ["http://[fe80::1]:3000/", "ip", null],
    ["https://app.ensemblework.com/", "named-host", /app\.ensemblework\.com/],
    ["http://ensemble.lan:3000/", "named-host", /ensemble\.lan/],
  ];
  for (const [url, reason, says] of cases) {
    const result = at(url);
    assert.equal(result.ok, false, url);
    if (result.ok) continue;
    assert.equal(result.reason, reason, url);
    if (says) assert.match(result.message, says, url);
    if (!url.includes(":3000")) assert.doesNotMatch(result.message, /3000/, url);
    if (reason === "ip") assert.doesNotMatch(result.message, /https?:\/\/localhost/, url);
  }
});

async function mountDevice(): Promise<{ host: HTMLDivElement; calls: Array<{ url: string; op?: string }>; done: () => Promise<void> }> {
  const calls: Array<{ url: string; op?: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const op = typeof init?.body === "string" ? (JSON.parse(init.body) as { op?: string }).op : undefined;
    calls.push({ url, op });
    const body = url.includes("/api/devices/d1/terminal")
      ? op === "cd" ? { cwd: "/work", scope: "/work" } : { roots: ["/work"], home: "/work" }
      : url.endsWith("/api/devices")
        ? { serverRunner: false, devices: [{ id: "d1", name: "Studio Mac", platform: "darwin", appVersion: "0.3.8", capabilities: { code: true }, folders: [], lastSeenAt: null, createdAt: "2026-10-14T00:00:00Z", online: true }] }
        : { error: "unexpected" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Terminal target={{ kind: "device", deviceId: "d1" }} onClose={() => {}} />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return {
    host,
    calls,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      globalThis.fetch = realFetch;
    },
  };
}

test("on Ensemble on the web, a paired computer's terminal opens at once for the signed-in browser, never through the localhost rule", async () => {
  setTestUrl("https://app.ensemblework.com/code");
  try {
    const view = await mountDevice();
    try {
      assert.equal(addressNote(view.host), null, "the web's own address is fine for a paired computer");
      assert.ok(view.calls.some((call) => call.url.includes("/api/devices/d1/terminal") && call.op === "status"));
      assert.ok(view.calls.some((call) => call.url.includes("/api/devices/d1/terminal") && call.op === "cd"));
      assert.equal(view.calls.some((call) => call.url.includes("/api/terminal/") || call.url.includes("/api/web-terminal/")), false, "no unlock, and never this server's own terminal");
      assert.ok(view.host.textContent?.includes("Studio Mac"));
      assert.ok(prompt(view.host), "the command line is there");
      assert.doesNotMatch(view.host.textContent ?? "", /passkey|Email me a code|unlock|30 minutes idle/i);
    } finally {
      await view.done();
    }
  } finally {
    setTestUrl("http://localhost/");
  }
});
