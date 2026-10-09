import "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { StrictMode, act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Dialog, Popover, QueryError, Tabs } from "./ui.js";
import { CreateTaskDialog } from "./board/create-task-dialog.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function typeInto(input: HTMLInputElement) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter, "input value setter");
  return async (chars: string) => {
    let soFar = input.value;
    for (const char of chars) {
      soFar += char;
      await act(async () => {
        setter.call(input, soFar);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      assert.equal(document.activeElement, input, `focus stayed after typing "${soFar}"`);
      assert.equal(input.value, soFar);
    }
  };
}

async function render(node: React.ReactNode): Promise<{ root: Root; host: HTMLDivElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return { root, host };
}

async function unmount(mounted: { root: Root; host: HTMLDivElement }) {
  await act(async () => {
    mounted.root.unmount();
  });
  mounted.host.remove();
}

test("modal focus wraps, background is inert, Escape closes once, and opener is restored", async () => {
  let closed = 0;
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open modal</button><Dialog open={open} title="Modal" onClose={() => { closed++; setOpen(false); }}><input aria-label="Name" /><button>Last</button></Dialog></>;
  }
  const mounted = await render(<StrictMode><Harness /></StrictMode>);
  try {
    const opener = mounted.host.querySelector<HTMLButtonElement>("button")!;
    opener.focus();
    await act(async () => opener.click());
    assert.equal(mounted.host.inert, true);
    const dialog = document.querySelector('[role="dialog"]')!;
    const first = dialog.querySelector<HTMLButtonElement>("button")!;
    const last = [...dialog.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(document.activeElement, last);
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    assert.equal(document.activeElement, first);
    await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(closed, 1);
    assert.equal(mounted.host.inert, false);
    assert.equal(document.activeElement, opener);
  } finally { await unmount(mounted); }
});

test("a modal's portalled popover stays interactive and Escape dismisses it first", async () => {
  let closed = 0;
  const mounted = await render(<Dialog open title="Picker" onClose={() => { closed++; }}><Popover trigger={(_, toggle) => <button onClick={toggle}>Pick</button>}>{() => <button>Option</button>}</Popover></Dialog>);
  try {
    await act(async () => [...document.querySelectorAll("button")].find((node) => node.textContent === "Pick")!.click());
    const panel = document.querySelector<HTMLElement>("[data-popover]")!;
    assert.equal(panel.inert, undefined);
    const option = panel.querySelector<HTMLButtonElement>("button")!;
    option.focus();
    assert.equal(document.activeElement, option);
    await act(async () => option.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(document.querySelector("[data-popover]"), null);
    assert.equal(closed, 0);
  } finally { await unmount(mounted); }
});

test("tabs use one tab stop, wrap with arrows, and support Home and End", async () => {
  function Harness() {
    const [value, setValue] = useState("a");
    return <Tabs label="Context" panelId="panel" tabs={[{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }]} value={value} onChange={setValue} />;
  }
  const mounted = await render(<Harness />);
  try {
    const tabs = [...mounted.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    assert.deepEqual(tabs.map((tab) => tab.tabIndex), [0, -1, -1]);
    for (const [key, next] of [["ArrowLeft", 2], ["Home", 0], ["End", 2], ["ArrowRight", 0]] as const) {
      await act(async () => (document.activeElement?.closest('[role="tab"]') ?? tabs[0])!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
      assert.equal(document.activeElement, tabs[next]);
      assert.equal(tabs[next]!.getAttribute("aria-selected"), "true");
      assert.equal(tabs[next]!.getAttribute("aria-controls"), "panel");
    }
  } finally { await unmount(mounted); }
});

test("query failures expose their message and a working retry action", async () => {
  let retried = 0;
  const mounted = await render(<QueryError error={new Error("Access denied")} retry={() => { retried++; }} />);
  try {
    assert.match(mounted.host.querySelector('[role="alert"]')?.textContent ?? "", /Access denied/);
    await act(async () => mounted.host.querySelector<HTMLButtonElement>("button")!.click());
    assert.equal(retried, 1);
  } finally {
    await unmount(mounted);
  }
});

test("task creation retains input on failure and guards repeated submission", async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { gcTime: 0 } } });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let created = 0;
  let closed = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const data = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(calls === 1 ? { error: "Save failed" } : { task: { id: "new-task", ...data } }), { status: calls === 1 ? 500 : 201, headers: { "Content-Type": "application/json" } });
  };
  const mounted = await render(
    <QueryClientProvider client={client}>
      <CreateTaskDialog onCreated={() => { created++; }} onClose={() => { closed++; }} />
    </QueryClientProvider>,
  );
  try {
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    const input = dialog.querySelector<HTMLInputElement>("input")!;
    await typeInto(input)("Write the report");
    const form = dialog.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.equal(calls, 1);
    assert.equal(input.value, "Write the report");
    assert.match(dialog.querySelector('[role="alert"]')?.textContent ?? "", /Save failed/);
    assert.equal(closed, 0);
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.equal(calls, 2);
    assert.equal(created, 1);
    assert.equal(closed, 1);
  } finally {
    await unmount(mounted);
    client.clear();
    globalThis.fetch = originalFetch;
  }
});

test("a model key dialog keeps focus while a full key is typed", async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState("");
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Add key
        </button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Add a Google Gemini key">
          <input
            autoFocus
            type="password"
            aria-label="API key"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Paste the key"
          />
        </Dialog>
      </>
    );
  }

  const mounted = await render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  try {
    const opener = document.querySelector("button");
    assert.ok(opener instanceof HTMLButtonElement);
    await act(async () => {
      opener.focus();
      opener.click();
    });

    const input = document.querySelector("input");
    const close = document.querySelector("[aria-label='Close']");
    assert.ok(input instanceof HTMLInputElement);
    assert.ok(close instanceof HTMLButtonElement);
    assert.equal(document.activeElement, input);
    assert.notEqual(document.activeElement, close);

    const key = "sk-test-key-1234567890";
    await typeInto(input)(key);
    assert.equal(input.value, key);
    assert.equal(document.activeElement, input);

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(document.querySelector("[role='dialog']"), null);
    assert.equal(document.activeElement, opener);
  } finally {
    await unmount(mounted);
  }
});

test("a dialog without autofocus focuses the first text input and keeps a later field focused", async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const [clientId, setClientId] = useState("");
    const [secret, setSecret] = useState("");
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Set up once
        </button>
        <Dialog open={open} onClose={() => setOpen(false)} title="One-time Google setup">
          <button type="button">Copy redirect URI</button>
          <input aria-label="Client ID" value={clientId} onChange={(event) => setClientId(event.target.value)} />
          <input aria-label="Client secret" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} />
        </Dialog>
      </>
    );
  }

  const mounted = await render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  try {
    const opener = document.querySelector("button");
    assert.ok(opener instanceof HTMLButtonElement);
    await act(async () => {
      opener.focus();
      opener.click();
    });

    const clientId = document.querySelector("[aria-label='Client ID']");
    const secret = document.querySelector("[aria-label='Client secret']");
    assert.ok(clientId instanceof HTMLInputElement);
    assert.ok(secret instanceof HTMLInputElement);
    assert.equal(document.activeElement, clientId);

    secret.focus();
    await typeInto(secret)("super-secret");
    assert.equal(document.activeElement, secret);
    assert.equal(secret.value, "super-secret");
    assert.equal(clientId.value, "");
  } finally {
    await unmount(mounted);
  }
});

test("a dialog with no input focuses a button", async () => {
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <Dialog open={open} onClose={() => setOpen(false)} title="Note">
        <p>Nothing to type.</p>
      </Dialog>
    );
  }

  const mounted = await render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  try {
    const close = document.querySelector("[aria-label='Close']");
    assert.ok(close instanceof HTMLButtonElement);
    assert.equal(document.activeElement, close);
  } finally {
    await unmount(mounted);
  }
});
