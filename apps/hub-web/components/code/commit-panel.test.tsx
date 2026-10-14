import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommitPanel, commitMessage, subjectTone } from "./commit-panel.js";

(globalThis as { React?: typeof React }).React = React;

const REVIEW = "5f1c2a7c-5b3c-4f4e-9a21-3d1c2b4a5e6f";

test("the 50/72 guide and the commit message with its co-author line", () => {
  assert.equal(subjectTone(50), "ok");
  assert.equal(subjectTone(60), "warn");
  assert.equal(subjectTone(73), "danger");
  assert.equal(commitMessage(" Fix it ", "", null), "Fix it");
  assert.equal(commitMessage("Fix it", "Because.", "Co-authored-by: A <a@b>"), "Fix it\n\nBecause.\n\nCo-authored-by: A <a@b>");
});

test("the run's files are ticked and your earlier work is not; the commit holds exactly the ticked files, with the agent as co-author", async () => {
  window.localStorage.clear();
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return json({ ok: true, commit: "abc1234def", branch: "ensemble/feature" });
    }
    if (url.includes("/api/code/commit-plan")) {
      return json({ branch: "ensemble/feature", defaultBranch: "main", github: { owner: "acme", repo: "app" }, run: ["a.txt", "b.txt"], before: ["notes.md"], model: "claude-sonnet", template: "## What\n", proposal: "The agent's report." });
    }
    return json({});
  }) as typeof fetch;
  // gcTime 0: a finished mutation leaves no five-minute timer holding the test process open.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <CommitPanel source={{ review: REVIEW }} draftKey={REVIEW} beforeCommit={async () => {}} />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 5; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 10))));
    const boxes = [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    const byName = (name: string) => boxes.find((box) => box.closest("label")?.textContent?.includes(name));
    assert.equal(byName("a.txt")?.checked, true);
    assert.equal(byName("b.txt")?.checked, true);
    assert.equal(byName("notes.md")?.checked, false, "work from before the run stays out unless you tick it");
    const subject = host.querySelector('input[aria-label="Commit subject"]') as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(subject, "Use the agent's change to a and b, with a subject past fifty");
      subject.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.match(host.querySelector('[data-testid="subject-count"]')?.className ?? "", /text-warn/, "past 50 the counter warns");
    const preview = [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Preview") as HTMLElement;
    await act(async () => preview.click());
    assert.ok(host.querySelector('[data-testid="commit-preview"]'));
    const commit = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Commit 2 files")) as HTMLButtonElement;
    assert.ok(commit, "commits the two ticked files");
    await act(async () => commit.click());
    for (let i = 0; i < 5; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 10))));
    const sent = posts.find((post) => post.url.endsWith("/api/code/commit-paths"));
    assert.ok(sent);
    assert.deepEqual(sent.body.paths, ["a.txt", "b.txt"]);
    assert.match(String(sent.body.message), /\n\nCo-authored-by: Ensemble agent \(claude-sonnet\) <agent@ensemble\.local>$/);
    assert.ok(host.querySelector('[data-testid="pr-section"]'), "a pull request section for a GitHub repository");
    assert.equal((host.querySelector('textarea[aria-label="Pull request description"]') as HTMLTextAreaElement).value, "## What\n", "it starts from the repository's template");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    globalThis.fetch = real;
  }
});
