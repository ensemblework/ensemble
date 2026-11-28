import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Settings } from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { Notifier } from "./notifier";

(globalThis as { React?: typeof React }).React = React;

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });

test("the account's time zone follows this computer's, even one picked by hand before", async () => {
  const zone = process.env.TZ;
  const original = { settings: api.settings, saveSettings: api.saveSettings, shell: api.shell, reminders: api.reminders };
  const saved: unknown[] = [];
  let stored = Settings.parse({ timezone: "Asia/Kolkata", timezoneMode: "manual" });
  process.env.TZ = "America/Los_Angeles";
  Object.assign(api, {
    settings: async () => ({ settings: stored }),
    saveSettings: async (data: unknown) => {
      saved.push(data);
      stored = { ...stored, ...(data as object) };
      return stored;
    },
    shell: async () => ({ space: null }),
    reminders: async () => ({ reminders: [] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Notifier /></QueryClientProvider>));
    await settle();
    assert.deepEqual(saved, [{ timezone: "America/Los_Angeles", timezoneMode: "auto" }]);
    await settle();
    assert.equal(saved.length, 1, "nothing more to save once the zones match");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    Object.assign(api, original);
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
