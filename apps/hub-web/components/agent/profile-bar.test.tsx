import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { claudeCodeModels, CODE_ENGINES, RunProfile, Settings } from "@ensemble/shared-types";
import { AssignDialog, ProfileBar } from "./assign-dialog.js";

(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One key as a browser types it: it replaces whatever is selected. */
function press(input: HTMLInputElement, key: string) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, input.value.slice(0, start) + key + input.value.slice(end));
  input.setSelectionRange(start + 1, start + 1);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const careful = RunProfile.parse({ id: "careful", name: "Careful" });
const away = RunProfile.parse({ id: "away", name: "Away", mode: "unattended" });

function render(onSave: (value: { id?: string; name: string }) => void, onDefault: (id: string) => void = () => {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <ProfileBar profiles={[careful, away]} saved={[careful, away]} activeId="careful" defaultId="careful" modified={false} onPick={() => {}} onSave={onSave} onRemove={() => {}} onDefault={onDefault} busy={false} />,
    ),
  );
  return { host, root };
}

test("a new profile name keeps every letter typed, not only the last one", async () => {
  const saved: Array<{ id?: string; name: string }> = [];
  const { host, root } = render((value) => saved.push(value));
  const add = [...host.querySelectorAll("button")].find((button) => button.textContent === "Save as profile")!;
  act(() => add.click());
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Profile name"]')!;
  act(() => press(input, "X"));
  await act(async () => { await wait(40); });
  for (const key of "YZ team") {
    await act(async () => {
      press(input, key);
      await wait(40);
    });
  }
  assert.equal(input.value, "XYZ team");
  await act(async () => input.form!.requestSubmit());
  assert.deepEqual(saved, [{ id: undefined, name: "XYZ team" }]);
  act(() => root.unmount());
  host.remove();
});

test("renaming selects the old name once, then typing replaces it and continues", async () => {
  const saved: Array<{ id?: string; name: string }> = [];
  const { host, root } = render((value) => saved.push(value));
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-label="Rename profile"]')!.click();
    await wait(40);
  });
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Profile name"]')!;
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, "Careful".length);
  for (const key of "Gentle") {
    await act(async () => {
      press(input, key);
      await wait(40);
    });
  }
  assert.equal(input.value, "Gentle");
  act(() => root.unmount());
  host.remove();
});

test("every saved profile has a star; the default's is pressed and another's makes it the default", () => {
  const picked: string[] = [];
  const { host, root } = render(() => {}, (id) => picked.push(id));
  const stars = [...host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
  assert.deepEqual(stars.map((star) => star.getAttribute("aria-pressed")), ["true", "false"]);
  assert.equal(stars[0]!.disabled, true);
  act(() => stars[1]!.click());
  assert.deepEqual(picked, ["away"]);
  act(() => root.unmount());
  host.remove();
});

test("GitHub Copilot on a paired computer offers its models, thinking levels and context windows, and Assign sends them", async () => {
  const luna = { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", efforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contexts: [{ id: "default", label: "200K (standard)", tokens: 200000 }, { id: "long_context", label: "922K (long context)", tokens: 922000 }], vision: true, cost: "low cost", description: "OpenAI" };
  const haiku = { id: "claude-haiku-4.5", label: "Claude Haiku 4.5", contexts: [{ id: "default", label: "136K", tokens: 136000 }], cost: "0.33× premium requests", description: "Anthropic" };
  const copilot = { id: "copilot-cli", via: "cli", version: "1.0.40", signedIn: false, account: null, models: [{ id: "auto", label: "Auto", isDefault: true }, luna, haiku], checkedAt: "2026-10-20T09:00:00.000Z" };
  const codex = { id: "codex", via: "cli", version: "0.163.0", signedIn: true, models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", isDefault: true, efforts: ["low", "high", "max", "ultra"], defaultEffort: "low", vision: true }], checkedAt: "2026-10-20T09:00:00.000Z" };
  const claude = { id: "claude-code", via: "cli", version: "2.1.304", signedIn: true, models: claudeCodeModels("2.1.304"), checkedAt: "2026-10-20T09:00:00.000Z" };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST") {
      sent.push({ path, body: JSON.parse(String(init.body)) });
      return json({ jobId: "job-1" });
    }
    if (path === "/api/settings") return json({ settings: Settings.parse({}) });
    if (path === "/api/tasks/task-1") return json({ task: { id: "task-1", title: "Fix the flaky test", status: "todo", complexity: "medium" } });
    if (path === "/api/devices") return json({ serverRunner: false, devices: [{ id: "device-1", name: "Studio Mac", platform: "macos", appVersion: "cli-0.5.0", capabilities: { engines: [...CODE_ENGINES] }, folders: [], lastSeenAt: null, createdAt: "2026-10-01T09:00:00.000Z" }] });
    if (path === "/api/subscriptions") return json({ preferred: null, computers: [{ id: "device-1", name: "Studio Mac", platform: "macos", local: false, online: true, lastSeenAt: null, appVersion: "cli-0.5.0", ready: true, agents: [copilot, codex, claude] }] });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  window.localStorage.clear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await act(async () => { await wait(15); });
  };
  const select = (label: string) => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  const choose = async (label: string, value: string) => {
    await act(async () => {
      const node = select(label);
      node.value = value;
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  };
  const options = (label: string) => [...select(label).options].map((option) => option.textContent);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AssignDialog open onClose={() => {}} taskId="task-1" defaultKind="code" /></QueryClientProvider>));
    await settle();
    assert.ok(options("Who does the work").includes("GitHub Copilot (your sign-in)"));
    // Every coding agent offers the models its computer listed, each with its own levels and windows.
    await choose("Who does the work", "codex");
    assert.deepEqual(options("Codex model"), ["Codex default (GPT-6.1 Sol)", "GPT-6.1 Sol"]);
    assert.deepEqual(options("Codex thinking"), ["Default (Low)", "Low", "High", "Max", "Ultra"]);
    await choose("Who does the work", "claude-code");
    await choose("Claude Code model", "claude-sonnet-4-6");
    assert.deepEqual(options("Claude Code thinking"), ["Default (High)", "Low", "Medium", "High", "Max"]);
    assert.deepEqual(options("Context window"), ["Standard · 200K", "Long context · 1M"]);
    await choose("Claude Code model", "claude-opus-5-5");
    assert.equal(select("Context window"), null, "Opus 5.5 has one 1M window");
    assert.equal(document.querySelector('[data-testid="engine-model-facts"]')?.textContent, "Anthropic · newest · 1M context");
    await choose("Who does the work", "copilot-cli");
    assert.deepEqual(options("Copilot model"), ["Copilot default (Auto)", "Auto", "GPT-5.6 Luna", "Claude Haiku 4.5"]);
    assert.equal(select("Copilot thinking"), null, "Auto has no thinking levels");
    assert.match(document.querySelector('[data-testid="engine-signed-out"]')?.textContent ?? "", /Copilot CLI is not signed in on Studio Mac: run copilot login there or press Sign in under Settings → Models\./);

    await choose("Copilot model", "gpt-5.6-luna");
    assert.deepEqual(options("Copilot thinking"), ["Default (Medium)", "Off", "Low", "Medium", "High", "Extra high", "Max"]);
    assert.deepEqual(options("Context window"), ["Standard · 200K (standard)", "Long context · 922K (long context)"]);
    assert.equal(document.querySelector('[data-testid="engine-model-facts"]')?.textContent, "OpenAI · low cost · 200K or 922K context");
    await choose("Copilot thinking", "xhigh");
    await choose("Context window", "long_context");

    await choose("Copilot model", "claude-haiku-4.5");
    assert.equal(select("Copilot thinking"), null);
    assert.equal(select("Context window"), null, "one fixed size: no choice");
    await choose("Copilot model", "gpt-5.6-luna");
    assert.equal(select("Copilot thinking").value, "default", "Haiku dropped the level it lacks");
    await choose("Copilot thinking", "high");
    await choose("Context window", "long_context");

    const assign = [...document.querySelectorAll<HTMLButtonElement>("button.btn-primary")].find((node) => node.textContent?.includes("Assign"))!;
    await act(async () => assign.click());
    await settle();
    const body = sent.find((row) => row.path === "/api/agent/assign")?.body;
    assert.deepEqual([body?.engine, body?.model, body?.reasoningEffort, body?.contextTier, body?.deviceId, body?.provider], ["copilot-cli", "gpt-5.6-luna", "high", "long_context", "device-1", undefined]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = realFetch;
  }
});

test("Git starts on No limits; Pull request: any base typed (empty: the default branch), a too-old computer, a folder worked in place; Assign sends the plan and saving keeps it", async () => {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const sent: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  const studio = {
    id: "device-1",
    name: "Studio Mac",
    platform: "macos",
    appVersion: "cli-0.6.0",
    capabilities: { engines: [...CODE_ENGINES], pullRequests: 2, folders: [{ label: "ensemble", kind: "repo", access: "read-write" }, { label: "notes", kind: "folder", access: "read-write" }] },
    folders: ["ensemble", "notes"],
    lastSeenAt: null,
    createdAt: "2026-10-01T09:00:00.000Z",
  };
  const laptop = { ...studio, id: "device-2", name: "Old Laptop", appVersion: "cli-0.5.0", capabilities: { engines: [...CODE_ENGINES], folders: [{ label: "ensemble", kind: "repo" }] } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method && init.method !== "GET") {
      const body = JSON.parse(String(init.body ?? "{}"));
      sent.push({ path, method: init.method, body });
      return path === "/api/settings" ? json({ settings: Settings.parse(body) }) : json({ jobId: "job-1" });
    }
    if (path === "/api/settings") return json({ settings: Settings.parse({}) });
    if (path === "/api/tasks/task-1") return json({ task: { id: "task-1", title: "Make branch A and open a PR", status: "todo", complexity: "medium" } });
    if (path === "/api/devices") return json({ serverRunner: true, devices: [studio, laptop] });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  window.localStorage.clear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await act(async () => { await wait(15); });
  };
  const field = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === text || node.textContent?.includes(text))!;
  const click = async (node: HTMLElement) => {
    await act(async () => node.click());
    await settle();
  };
  const choose = async (label: string, value: string) => {
    await act(async () => {
      const node = field<HTMLSelectElement>(`select[aria-label="${label}"]`);
      node.value = value;
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  };
  const type = async (label: string, value: string) => {
    await act(async () => {
      const node = field<HTMLInputElement>(`input[aria-label="${label}"]`);
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
  };
  const notices = () => [...document.querySelectorAll("[data-pull-request-notice]")].map((node) => node.textContent?.trim());
  const assignButton = () => [...document.querySelectorAll<HTMLButtonElement>("button.btn-primary")].find((node) => node.textContent?.includes("Assign"))!;
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AssignDialog open onClose={() => {}} taskId="task-1" defaultKind="code" /></QueryClientProvider>));
    await settle();
    assert.match(document.body.textContent ?? "", /· no git limits/, "Git starts on No limits");
    await click([...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "Pull request")!);
    assert.ok(field('[data-testid="assign-pull-request"]'), "the pull request panel opens");

    // The base is free text, empty for the default branch; any branch git accepts goes.
    const base = field<HTMLInputElement>('input[aria-label="Into branch"]');
    assert.deepEqual([base.tagName, base.value, base.placeholder], ["INPUT", "", "default branch"]);
    assert.equal(document.querySelector("[data-pull-request-bases]"), null, "no list of bases");
    await type("Into branch", "bad..name");
    assert.ok(notices().includes("“bad..name” is not a branch name git accepts."));
    await type("Into branch", "main");
    assert.ok(!notices().some((text) => text?.includes("main")), "main is accepted");

    await click(button("Old Laptop"));
    assert.ok(notices().includes("Ensemble on Old Laptop is too old to open pull requests. Update it there (ensemble update), then assign."));

    await click(button("Studio Mac"));
    assert.equal(document.querySelector('select[aria-label="Into branch"]'), null);
    assert.deepEqual(notices(), ["A pull request needs a repository. Give its GitHub address, or pick a folder Studio Mac shares."]);

    await click(button("A folder on Studio Mac"));
    assert.deepEqual([...field<HTMLSelectElement>('select[aria-label="Shared folder"]').options].map((option) => option.textContent), ["Choose a folder Studio Mac has shared…", "ensemble · repository", "notes"]);
    await choose("Shared folder", "notes");
    assert.deepEqual(notices(), [], "a folder worked in place can end in a pull request");
    await type("Branch name", "main");
    assert.equal(field('[data-testid="pull-request-branch-notice"]').textContent, "A pull request cannot come from main into itself. Name another branch for the run.");
    await type("Branch name", "live-test/pr-flow");
    assert.equal(document.querySelector('[data-testid="pull-request-branch-notice"]'), null);
    assert.deepEqual([...field<HTMLSelectElement>('select[aria-label="After opening"]').options].map((option) => option.textContent), ["Ask me before merging", "Merge when checks pass", "Leave it open"]);
    await choose("After opening", "auto");

    await click(button("Save as profile"));
    await type("Profile name", "PR to main");
    await act(async () => field<HTMLInputElement>('input[aria-label="Profile name"]').form!.requestSubmit());
    await settle();
    const saved = sent.find((row) => row.path === "/api/settings")?.body.runProfiles as Array<Record<string, unknown>> | undefined;
    assert.deepEqual(saved?.[0]?.pullRequest, { base: "main", merge: "auto" });
    assert.equal(saved?.[0]?.delivery, "commit");

    assert.equal(assignButton().getAttribute("aria-disabled"), null);
    await click(assignButton());
    const body = sent.find((row) => row.path === "/api/agent/assign")?.body;
    assert.deepEqual(
      { pullRequest: body?.pullRequest, branch: body?.branch, branchMode: body?.branchMode, delivery: body?.delivery, network: body?.network, folderLabel: body?.folderLabel, deviceId: body?.deviceId, folder: body?.folder },
      { pullRequest: { base: "main", merge: "auto" }, branch: "live-test/pr-flow", branchMode: "new", delivery: "commit", network: true, folderLabel: "notes", deviceId: "device-1", folder: undefined },
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = realFetch;
  }
});
