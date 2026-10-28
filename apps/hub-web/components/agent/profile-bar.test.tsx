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
  const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "New profile")!;
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

/** The agent picker and its thinking panel, as a person uses them. */
function pickerDriver(settle: () => Promise<void>) {
  const click = async (node: HTMLElement | undefined | null, what: string) => {
    assert.ok(node, `no ${what}`);
    await act(async () => node.click());
    await settle();
  };
  const panel = () => document.querySelector<HTMLElement>("[data-agent-picker]");
  const options = () => [...(panel()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].map((node) => node.querySelector("span span")?.textContent?.trim() ?? node.textContent?.trim() ?? "");
  return {
    trigger: () => document.querySelector<HTMLButtonElement>('button[aria-label="Agent and model"]')!,
    open: async () => {
      if (!panel()) await click(document.querySelector<HTMLButtonElement>('button[aria-label="Agent and model"]'), "agent picker");
    },
    tab: async (name: string) => click([...(panel()?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])].find((node) => node.textContent?.trim() === name), `${name} tab`),
    chip: async (name: string) => click([...(panel()?.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]') ?? [])].find((node) => node.textContent?.trim() === name), `${name} chip`),
    options,
    note: () => panel()?.querySelector("span.text-warn, span.text-muted")?.textContent ?? "",
    pick: async (label: string) => click([...(panel()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find((node) => (node.querySelector("span span")?.textContent?.trim() ?? node.textContent?.trim()) === label), `${label} option`),
    tuning: async () => {
      if (!document.querySelector("[data-tuning-picker]")) await click(document.querySelector<HTMLButtonElement>('button[aria-label="Thinking and context"]'), "thinking button");
      return {
        levels: () => [...document.querySelectorAll<HTMLElement>('[aria-label="Thinking and context: thinking"] [role="radio"]')].map((node) => node.textContent?.trim()),
        windows: () => [...document.querySelectorAll<HTMLElement>('[aria-label="Thinking and context: context window"] [role="radio"]')].map((node) => node.textContent?.trim()),
        choose: async (group: "thinking" | "context window", text: string) => click([...document.querySelectorAll<HTMLElement>(`[aria-label="Thinking and context: ${group}"] [role="radio"]`)].find((node) => node.textContent?.trim() === text), `${text} level`),
      };
    },
    closeTuning: async () => {
      if (document.querySelector("[data-tuning-picker]")) await click(document.querySelector<HTMLButtonElement>('button[aria-label="Thinking and context"]'), "thinking button");
    },
  };
}

test("one picker: the person's own AI plans on a paired computer, each model with its own thinking levels and context windows; Assign sends them", async () => {
  const luna = { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", efforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contexts: [{ id: "default", label: "200K (standard)", tokens: 200000 }, { id: "long_context", label: "922K (long context)", tokens: 922000 }], vision: true, cost: "low cost", description: "OpenAI" };
  const haiku = { id: "claude-haiku-4.5", label: "Claude Haiku 4.5", contexts: [{ id: "default", label: "136K", tokens: 136000 }], cost: "0.33× premium requests", description: "Anthropic" };
  const copilot = { id: "copilot-cli", via: "cli", version: "1.0.40", signedIn: true, account: "mira-chen", models: [{ id: "auto", label: "Auto", isDefault: true }, luna, haiku], checkedAt: "2026-10-20T09:00:00.000Z" };
  const codex = { id: "codex", via: "cli", version: "0.163.0", signedIn: true, models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", isDefault: true, efforts: ["low", "high", "max", "ultra"], defaultEffort: "low", vision: true }], checkedAt: "2026-10-20T09:00:00.000Z", limits: [{ id: "week", label: "Weekly limit", usedPercent: 40 }] };
  const claude = { id: "claude-code", via: "cli", version: "2.1.304", signedIn: true, models: claudeCodeModels("2.1.304"), checkedAt: "2026-10-20T09:00:00.000Z" };
  const grok = { id: "grok-cli", via: "cli", version: "1.2.0", signedIn: true, models: [], typedModels: true, checkedAt: "2026-10-20T09:00:00.000Z" };
  const cursor = { id: "cursor-agent", via: "cli", version: "2026.10", signedIn: false, models: [{ id: "auto", label: "Auto", isDefault: true }], checkedAt: "2026-10-20T09:00:00.000Z" };
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
    if (path === "/api/subscriptions") return json({ preferred: null, computers: [{ id: "device-1", name: "Studio Mac", platform: "macos", local: false, online: true, lastSeenAt: null, appVersion: "cli-0.5.0", ready: true, agents: [copilot, codex, claude, grok, cursor] }] });
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
  const picker = pickerDriver(settle);
  const chips = () => [...document.querySelectorAll<HTMLElement>('[data-agent-picker] [role="radiogroup"] [role="radio"]')].map((node) => node.textContent?.trim());
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AssignDialog open onClose={() => {}} taskId="task-1" /></QueryClientProvider>));
    await settle();
    assert.equal(document.querySelector('[aria-label="Mode"] [aria-checked="true"]')?.textContent?.includes("Review only"), true, "Quick starts in Review only");
    assert.match(picker.trigger().textContent ?? "", /^Auto/, "the task's tier picks until the person chooses");
    assert.equal(document.querySelector("textarea"), null, "instructions wait under More options");
    assert.equal(document.querySelector('input[aria-label="Repository"]'), null, "its own checkout needs no repository");

    await picker.open();
    assert.match(picker.options()[0] ?? "", /Auto: match the task/);
    assert.equal(document.querySelector('[data-agent-picker] [role="tablist"]'), null, "no API keys and no included models: no tabs for them");
    assert.deepEqual(chips(), ["Claude Code", "Codex", "GitHub Copilot", "Grok Build"], "only agents signed in on the computer; Cursor is not");
    await picker.chip("Codex");
    assert.match(document.querySelector('[data-testid="agent-usage"]')?.textContent ?? "", /Weekly limit/, "the plan's usage shows beside its models");
    assert.deepEqual(picker.options().slice(1), ["GPT-6.1 Sol"], "the default model is listed once");
    await picker.pick("GPT-6.1 Sol");
    assert.match(picker.trigger().textContent ?? "", /Codex · GPT-6.1 Sol/);
    assert.deepEqual((await picker.tuning()).levels(), ["Auto (Low)", "Low", "High", "Max", "Ultra"]);
    await picker.closeTuning();

    await picker.open();
    await picker.chip("Claude Code");
    await picker.pick("Claude Sonnet 4.6");
    let tuning = await picker.tuning();
    assert.deepEqual(tuning.levels(), ["Auto (High)", "Low", "Medium", "High", "Max"]);
    assert.deepEqual(tuning.windows(), ["Standard · 200K", "Long context · 1M"]);
    assert.equal(document.querySelector('[data-testid="engine-fast"]'), null, "Sonnet 4.6 has no fast mode");
    await picker.closeTuning();
    await picker.open();
    await picker.pick("Claude Opus 5.5");
    tuning = await picker.tuning();
    assert.deepEqual(tuning.windows(), [], "Opus 5.5 has one 1M window");
    assert.ok(document.querySelector('[data-testid="engine-fast"]'), "Opus 5.5 has fast mode");
    await picker.closeTuning();
    assert.equal(document.querySelector('[data-testid="engine-no-sandbox"]'), null, "Claude Code has its own sandbox");

    await picker.open();
    await picker.chip("Grok Build");
    await picker.pick("Grok Build default");
    assert.match(document.querySelector('[data-testid="engine-no-sandbox"]')?.textContent ?? "", /Grok Build has no OS sandbox Ensemble can turn on there, so it runs directly/);

    await picker.open();
    await picker.chip("GitHub Copilot");
    assert.match(picker.note(), /mira-chen/);
    assert.deepEqual(picker.options().slice(1), ["Auto", "GPT-5.6 Luna", "Claude Haiku 4.5"], "Copilot's Auto is its default, listed once");
    await picker.pick("GPT-5.6 Luna");
    assert.match(picker.trigger().textContent ?? "", /GitHub Copilot · GPT-5\.6 Luna.*low cost/);
    assert.doesNotMatch(picker.trigger().textContent ?? "", /context|200K/, "context sizes are the thinking button's");
    tuning = await picker.tuning();
    assert.deepEqual(tuning.levels(), ["Auto (Medium)", "Off", "Low", "Medium", "High", "Extra high", "Max"]);
    assert.deepEqual(tuning.windows(), ["Standard · 200K (standard)", "Long context · 922K (long context)"]);
    await tuning.choose("thinking", "Extra high");
    await tuning.choose("context window", "Long context · 922K (long context)");
    await picker.closeTuning();

    await picker.open();
    await picker.pick("Claude Haiku 4.5");
    assert.equal(document.querySelector('button[aria-label="Thinking and context"]'), null, "one fixed size and no thinking setting: nothing to tune");
    await picker.open();
    await picker.pick("GPT-5.6 Luna");
    tuning = await picker.tuning();
    assert.equal(document.querySelector('[aria-label="Thinking and context: thinking"] [aria-checked="true"]')?.textContent?.trim(), "Auto (Medium)", "Haiku dropped the level it lacks");
    await tuning.choose("thinking", "High");
    await tuning.choose("context window", "Long context · 922K (long context)");
    await picker.closeTuning();

    const assign = [...document.querySelectorAll<HTMLButtonElement>("button.btn-primary")].find((node) => node.textContent?.includes("Assign"))!;
    await act(async () => assign.click());
    await settle();
    const body = sent.find((row) => row.path === "/api/agent/assign")?.body;
    assert.deepEqual([body?.engine, body?.model, body?.reasoningEffort, body?.contextTier, body?.deviceId, body?.provider, body?.kind, body?.mode], ["copilot-cli", "gpt-5.6-luna", "high", "long_context", "device-1", undefined, "code", "review"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = realFetch;
  }
});

test("an agent that is not signed in shows only when it is already the choice, with how to sign in", async () => {
  const copilot = { id: "copilot-cli", via: "cli", version: "1.0.40", signedIn: false, models: [{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }], checkedAt: "2026-10-20T09:00:00.000Z" };
  const claude = { id: "claude-code", via: "cli", version: "2.1.304", signedIn: true, models: claudeCodeModels("2.1.304"), checkedAt: "2026-10-20T09:00:00.000Z" };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/settings") return json({ settings: Settings.parse({ models: { medium: { provider: "copilot-cli", model: "gpt-5.6-luna", effort: "default" } } }) });
    if (path === "/api/tasks/task-1") return json({ task: { id: "task-1", title: "Fix the flaky test", status: "todo", complexity: "medium" } });
    if (path === "/api/devices") return json({ serverRunner: false, devices: [{ id: "device-1", name: "Studio Mac", platform: "macos", appVersion: "cli-0.5.0", capabilities: { engines: [...CODE_ENGINES] }, folders: [], lastSeenAt: null, createdAt: "2026-10-01T09:00:00.000Z" }] });
    if (path === "/api/subscriptions") return json({ preferred: null, computers: [{ id: "device-1", name: "Studio Mac", platform: "macos", local: false, online: true, lastSeenAt: null, appVersion: "cli-0.5.0", ready: true, agents: [copilot, claude] }] });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await act(async () => { await wait(15); });
  };
  const picker = pickerDriver(settle);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AssignDialog open onClose={() => {}} taskId="task-1" /></QueryClientProvider>));
    await settle();
    assert.match(picker.trigger().textContent ?? "", /Auto · Medium task → GitHub Copilot · GPT-5\.6 Luna/);
    assert.match(document.querySelector('[data-testid="engine-signed-out"]')?.textContent ?? "", /Copilot CLI is not signed in on Studio Mac: run copilot login there or press Sign in under Settings → Models\./);
    await picker.open();
    const chips = [...document.querySelectorAll<HTMLElement>('[data-agent-picker] [role="radiogroup"] [role="radio"]')].map((node) => node.textContent?.trim());
    assert.deepEqual(chips, ["Claude Code", "GitHub Copilot"], "the current choice stays listed; agents not on the computer do not");
    assert.match(picker.note(), /not signed in/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = realFetch;
  }
});

test("Git starts on No limits under More options; Pull request: any base typed (empty: the default branch), a too-old computer, a folder worked in place; Assign sends the plan and a new profile keeps it", async () => {
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
    await act(async () => root.render(<QueryClientProvider client={client}><AssignDialog open onClose={() => {}} taskId="task-1" /></QueryClientProvider>));
    await settle();
    assert.equal(document.querySelector('[data-testid="assign-more"]'), null, "git and branches wait under More options");
    await click(button("More options"));
    assert.ok([...document.querySelectorAll("button")].find(node => node.textContent === "No limits")?.className.includes("bg-panel"), "Git starts on No limits");
    assert.ok([...document.querySelectorAll("button")].find(node => node.textContent === "Agent decides")?.className.includes("bg-panel"), "the agent decides the branch");
    await click([...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "Pull request")!);
    assert.ok(field('[data-testid="assign-pull-request"]'), "the pull request panel opens");

    // The base is free text, empty for the default branch; any branch git accepts goes.
    const base = field<HTMLInputElement>('input[aria-label="Into branch"]');
    assert.deepEqual([base.tagName, base.value, base.placeholder], ["INPUT", "", "default branch"]);
    await type("Into branch", "bad..name");
    assert.ok(notices().includes("“bad..name” is not a branch name git accepts."));
    await type("Into branch", "main");
    assert.ok(!notices().some((text) => text?.includes("main")), "main is accepted");

    await click(button("Old Laptop"));
    assert.ok(notices().includes("Ensemble on Old Laptop is too old to open pull requests. Update it there (ensemble update), then assign."));

    await click(button("Studio Mac"));
    assert.deepEqual(notices(), ["A pull request needs a repository. Give its GitHub address, or pick a folder Studio Mac shares."]);
    assert.ok(field('input[aria-label="Repository"]'), "its own checkout takes the repository inside the pull request panel");

    await click(button("A folder on Studio Mac"));
    assert.equal(document.querySelector('input[aria-label="Repository"]'), null);
    assert.deepEqual([...field<HTMLSelectElement>('select[aria-label="Shared folder"]').options].map((option) => option.textContent), ["Choose a folder Studio Mac has shared…", "ensemble · repository", "notes"]);
    await choose("Shared folder", "notes");
    assert.deepEqual(notices(), [], "a folder worked in place can end in a pull request");
    await type("Branch name", "main");
    assert.equal(field('[data-testid="pull-request-branch-notice"]').textContent, "A pull request cannot come from main into itself. Name another branch for the run.");
    await type("Branch name", "live-test/pr-flow");
    assert.equal(document.querySelector('[data-testid="pull-request-branch-notice"]'), null);
    assert.deepEqual([...field<HTMLSelectElement>('select[aria-label="After opening"]').options].map((option) => option.textContent), ["Ask me before merging", "Merge when checks pass", "Leave it open"]);
    await choose("After opening", "auto");

    await click(button("New profile"));
    await type("Profile name", "PR to main");
    await act(async () => field<HTMLInputElement>('input[aria-label="Profile name"]').form!.requestSubmit());
    await settle();
    const saved = sent.find((row) => row.path === "/api/settings")?.body.runProfiles as Array<Record<string, unknown>> | undefined;
    assert.deepEqual(saved?.[0]?.pullRequest, { base: "main", merge: "auto" });
    assert.equal(saved?.[0]?.delivery, "commit");
    assert.equal(saved?.[0]?.mode, "review");

    assert.equal(assignButton().getAttribute("aria-disabled"), null);
    await click(assignButton());
    const body = sent.find((row) => row.path === "/api/agent/assign")?.body;
    assert.deepEqual(
      { pullRequest: body?.pullRequest, branch: body?.branch, branchMode: body?.branchMode, delivery: body?.delivery, network: body?.network, folderLabel: body?.folderLabel, deviceId: body?.deviceId, folder: body?.folder, trust: body?.trust },
      { pullRequest: { base: "main", merge: "auto" }, branch: "live-test/pr-flow", branchMode: "new", delivery: "commit", network: true, folderLabel: "notes", deviceId: "device-1", folder: undefined, trust: undefined },
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = realFetch;
  }
});
