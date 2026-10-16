import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProviderPicker } from "./model-picker.js";
import { api } from "@/lib/api";
import { clientPlatform, modKey } from "@/lib/platform";
import { pickFolderNative } from "@/lib/desktop-dialog";
import { promptsForProfession } from "@/lib/connect/prompts";

const click = async (node: Element) =>
  act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

test("provider source tabs remember the account choice on a fresh mount", async () => {
  const oldRead = api.preferences,
    oldWrite = api.putPreference;
  let saved: unknown = "subscriptions";
  api.preferences = async () =>
    ({
      preferences: [{ key: "ui.model-picker-tab", value: saved }],
    }) as Awaited<ReturnType<typeof api.preferences>>;
  api.putPreference = async (key, value) => {
    assert.equal(key, "ui.model-picker-tab");
    saved = value;
    return {} as Awaited<ReturnType<typeof api.putPreference>>;
  };
  const mount = async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { gcTime: Infinity },
      },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ProviderPicker
            value="claude-code"
            label="Provider"
            choices={[
              { id: "claude-code", label: "Claude plan", status: "plan" },
              { id: "openai", label: "OpenAI key", status: "key" },
            ]}
            onPick={() => {}}
          />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await click(host.querySelector("button")!);
    return {
      done: async () => {
        await act(async () => root.unmount());
        client.clear();
        host.remove();
      },
    };
  };
  let view: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    view = await mount();
    assert.match(
      document.querySelector('[role="listbox"]')!.textContent!,
      /Claude plan/,
    );
    assert.doesNotMatch(
      document.querySelector('[role="listbox"]')!.textContent!,
      /OpenAI key/,
    );
    await click(
      [...document.querySelectorAll('[role="tab"]')].find(
        (node) => node.textContent === "API keys",
      )!,
    );
    assert.equal(saved, "api");
    assert.match(
      document.querySelector('[role="listbox"]')!.textContent!,
      /OpenAI key/,
    );
    await view.done();
    view = undefined;
    view = await mount();
    assert.equal(
      document.querySelector('[role="tab"][aria-selected="true"]')!.textContent,
      "API keys",
    );
  } finally {
    await view?.done();
    api.preferences = oldRead;
    api.putPreference = oldWrite;
  }
});

test("the native folder picker invokes Tauri's installed dialog plugin", async () => {
  const target = window as Window & { __TAURI__?: unknown };
  const saved = target.__TAURI__;
  let call: unknown;
  target.__TAURI__ = {
    core: {
      invoke: async (command: string, args: unknown) => {
        call = { command, args };
        return "/work/projects";
      },
    },
  };
  try {
    assert.equal(await pickFolderNative("Code folder"), "/work/projects");
    assert.deepEqual(call, {
      command: "plugin:dialog|open",
      args: {
        options: { directory: true, multiple: false, title: "Code folder" },
      },
    });
  } finally {
    target.__TAURI__ = saved;
  }
});

test("client platform distinguishes phones, touch iPads, desktop modifiers and native shell", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(
    navigator,
    "platform",
  );
  const originalAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  const originalTouch = Object.getOwnPropertyDescriptor(
    navigator,
    "maxTouchPoints",
  );
  const set = (platform: string, agent: string, touch = 0) => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: platform,
    });
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: agent,
    });
    Object.defineProperty(navigator, "maxTouchPoints", {
      configurable: true,
      value: touch,
    });
  };
  try {
    set("MacIntel", "Safari");
    assert.equal(clientPlatform().os, "mac");
    assert.equal(modKey(), "⌘");
    set("Win32", "Windows");
    assert.equal(clientPlatform().os, "windows");
    assert.equal(modKey(), "Ctrl");
    set("Linux x86_64", "Linux");
    assert.equal(clientPlatform().os, "linux");
    set("Linux arm", "Android");
    assert.equal(clientPlatform().mobile, true);
    assert.equal(clientPlatform().os, "android");
    set("iPhone", "iPhone");
    assert.equal(clientPlatform().os, "ios");
    set("MacIntel", "Safari", 5);
    assert.equal(clientPlatform().os, "ios");
    assert.equal(clientPlatform().mobile, true);
  } finally {
    for (const [key, descriptor] of [
      ["platform", originalPlatform],
      ["userAgent", originalAgent],
      ["maxTouchPoints", originalTouch],
    ] as const) {
      if (descriptor) Object.defineProperty(navigator, key, descriptor);
      else Reflect.deleteProperty(navigator, key);
    }
  }
});

test("connection examples follow only the person's profession", () => {
  assert.match(promptsForProfession("Lawyer").prompts.join(" "), /matter/);
  assert.doesNotMatch(
    promptsForProfession("Lawyer").prompts.join(" "),
    /study|branch/,
  );
  assert.match(
    promptsForProfession("Software engineer").prompts.join(" "),
    /branch/,
  );
  assert.doesNotMatch(
    promptsForProfession(null).prompts.join(" "),
    /filing|control group/,
  );
});
