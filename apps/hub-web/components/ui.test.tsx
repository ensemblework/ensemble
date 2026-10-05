import "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { StrictMode, act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Dialog } from "./ui.js";

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
