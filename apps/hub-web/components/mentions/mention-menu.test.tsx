import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PageMention } from "@ensemble/shared-types";
import { MentionPopover, useMentionMenu } from "./mention-menu.js";

const ENTITIES = [
  { kind: "people", id: "p-alerts", label: "alerts", detail: "alerts@bank.example" },
  { kind: "people", id: "p-anu-bot", label: "anika.updates", detail: "updates@anika.example" },
  { kind: "people", id: "p-anika", label: "Anika Rao", detail: "anika@fieldnote.example" },
  { kind: "people", id: "p-mira", label: "Mira Chen", detail: "mira@fieldnote.example" },
  { kind: "diagram", id: "diagram-1", label: "Transformer", detail: "" },
  { kind: "task", id: "task-1", label: "Send notes to Anika", detail: "todo" },
];

type Sent = { text: string; mentions: PageMention[] };

function Host({ sent }: { sent: Sent[] }) {
  const [value, setValue] = useState("");
  const menu = useMentionMenu({ value, onValue: setValue });
  return (
    <div>
      <MentionPopover menu={menu} />
      <textarea
        ref={menu.ref}
        value={value}
        {...menu.inputProps}
        onKeyDown={(event) => {
          if (menu.onKeyDown(event)) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sent.push({ text: value, mentions: menu.takeMentions(value) });
            menu.clear();
            setValue("");
          }
        }}
      />
    </div>
  );
}

async function settle(ms = 15) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/api/entities")) return json({ entities: ENTITIES });
    if (url.includes("/api/shell")) return json({ modules: "diagrams,plots" });
    return json({});
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const sent: Sent[] = [];
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Host sent={sent} />
      </QueryClientProvider>,
    );
  });
  const box = host.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  const type = async (text: string) => {
    await act(async () => {
      box.focus();
      setter.call(box, box.value + text);
      box.setSelectionRange(box.value.length, box.value.length);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
  };
  const press = async (key: string) => {
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    await settle(5);
  };
  const options = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];
  const cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
    client.clear();
  };
  return { box, sent, type, press, options, cleanup };
}

test("@ alone lists the groups with their prefixes, above the box, as a listbox the box points at", async () => {
  const ui = await mount();
  try {
    await ui.type("@");
    const options = ui.options();
    assert.ok(options.length >= 8);
    assert.match(options[0]!.textContent ?? "", /People.*@people:/);
    assert.equal(options.some((option) => /Ask Ensemble/.test(option.textContent ?? "")), false);
    const list = document.querySelector("[role=listbox]")!;
    assert.equal(ui.box.getAttribute("aria-controls"), list.id);
    assert.equal(ui.box.getAttribute("aria-activedescendant"), options[0]!.id);
    assert.equal(options[0]!.getAttribute("aria-selected"), "true");
  } finally {
    await ui.cleanup();
  }
});

test("@anik ranks the person first; arrows move, Enter writes @people:Name and the next Enter sends with the id", async () => {
  const ui = await mount();
  try {
    await ui.type("Ping @anik");
    await ui.type("");
    const labels = ui.options().map((option) => option.textContent ?? "");
    assert.match(labels[0]!, /Anika Rao.*Person/);
    assert.match(labels[1]!, /anika\.updates/);
    await ui.press("ArrowDown");
    assert.equal(ui.options()[1]!.getAttribute("aria-selected"), "true");
    assert.equal(ui.box.getAttribute("aria-activedescendant"), ui.options()[1]!.id);
    await ui.press("ArrowUp");
    await ui.press("Enter");
    assert.equal(ui.box.value, "Ping @people:Anika Rao ");
    assert.equal(ui.options().length, 0);
    assert.equal(ui.sent.length, 0);
    await ui.type("about the deck");
    assert.equal(ui.options().length, 0);
    await ui.press("Enter");
    assert.deepEqual(ui.sent, [
      { text: "Ping @people:Anika Rao about the deck", mentions: [{ kind: "people", id: "p-anika", label: "Anika Rao" }] },
    ]);
  } finally {
    await ui.cleanup();
  }
});

test("picking a group writes its prefix and keeps the menu open; a scoped name may have spaces", async () => {
  const ui = await mount();
  try {
    await ui.type("@peop");
    await ui.type("");
    await ui.press("Tab");
    assert.equal(ui.box.value, "@people:");
    assert.ok(ui.options().length >= 4);
    assert.ok(ui.options().every((option) => !/Transformer/.test(option.textContent ?? "")));
    await ui.type("Anika");
    await ui.type(" R");
    assert.match(ui.options()[0]!.textContent ?? "", /Anika Rao/);
    await ui.press("Enter");
    assert.equal(ui.box.value, "@people:Anika Rao ");
    await ui.type("@diagram:trans");
    await ui.press("Enter");
    assert.equal(ui.box.value, "@people:Anika Rao @diagram:Transformer ");
    await ui.press("Enter");
    assert.deepEqual(ui.sent[0]?.mentions, [
      { kind: "people", id: "p-anika", label: "Anika Rao" },
      { kind: "diagram", id: "diagram-1", label: "Transformer" },
    ]);
  } finally {
    await ui.cleanup();
  }
});

test("Esc closes the menu so Enter sends; emails do not open it; a deleted mention is not sent", async () => {
  const ui = await mount();
  try {
    await ui.type("mira@fieldnote");
    assert.equal(ui.options().length, 0);
    await ui.type(" @mira");
    assert.ok(ui.options().length > 0);
    await ui.press("Escape");
    assert.equal(ui.options().length, 0);
    await ui.press("Enter");
    assert.deepEqual(ui.sent, [{ text: "mira@fieldnote @mira", mentions: [] }]);

    await ui.type("@mira");
    await ui.press("Enter");
    assert.equal(ui.box.value, "@people:Mira Chen ");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(ui.box, "never mind");
      ui.box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await ui.press("Enter");
    assert.deepEqual(ui.sent[1], { text: "never mind", mentions: [] });
  } finally {
    await ui.cleanup();
  }
});
