import "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownText } from "./markdown-text.js";

// next/link schedules its prefetch with self.requestIdleCallback.
Object.defineProperty(globalThis, "self", { configurable: true, value: window });

async function render(text: string): Promise<{ root: Root; host: HTMLDivElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MarkdownText text={text} />);
  });
  return { root, host };
}

async function unmount(mounted: { root: Root; host: HTMLDivElement }) {
  await act(async () => mounted.root.unmount());
  mounted.host.remove();
}

test("saved stop notes render as italics, and snake_case stays literal", async () => {
  const saved = await render("The model paused.\n\n_Stopped before finishing._");
  const em = saved.host.querySelector("em");
  assert.equal(em?.textContent, "Stopped before finishing.");
  assert.equal(saved.host.textContent?.includes("_Stopped"), false);
  await unmount(saved);

  const stars = await render("*Stopped before finishing.*");
  assert.equal(stars.host.querySelector("em")?.textContent, "Stopped before finishing.");
  await unmount(stars);

  const code = await render("Call `hub_create_tasks` then hub_create_project.");
  assert.equal(code.host.querySelector("code")?.textContent, "hub_create_tasks");
  assert.equal(code.host.querySelector("em"), null);
  assert.match(code.host.textContent ?? "", /hub_create_project/);
  await unmount(code);

  const math = await render("2 * 3 = 6 and **bold** stays bold.");
  assert.equal(math.host.querySelector("em"), null);
  assert.equal(math.host.querySelector("strong")?.textContent, "bold");
  assert.match(math.host.textContent ?? "", /2 \* 3 = 6/);
  await unmount(math);
});

test("cut-off notices and the apply prompt have no stray markdown markers", async () => {
  for (const text of [
    "Stopped before finishing.",
    "The reply was cut off before the model finished.",
    "The reply hit the length limit.",
    "Nothing has changed yet — press Apply.",
  ]) {
    const mounted = await render(text);
    assert.equal(mounted.host.textContent?.includes(text.replace(/[.*]/g, "")), true);
    assert.equal(mounted.host.textContent?.includes("*"), false);
    assert.equal(mounted.host.textContent?.includes("_"), false);
    await unmount(mounted);
  }
});

test("model output keeps its structure: fenced code, numbered and nested lists, tables, quotes and rules", async () => {
  const report = [
    "# Summary",
    "",
    "Cloned the repo.",
    "It has two parts:",
    "1. The tracer",
    "   - hooks `fetch`",
    "   - records timings",
    "2. The report",
    "",
    "3. A third item after a blank line",
    "",
    "```ts",
    "const a = 1;",
    "",
    "const b = 2;",
    "```",
    "",
    "| File | Lines |",
    "| --- | ---: |",
    "| a.ts | 12 |",
    "| b.ts | 3 |",
    "",
    "> Note: **public** repos only.",
    "",
    "---",
    "",
    "- [x] cloned",
    "- [ ] tested",
    "",
    "See [the review](/code/review?review=1) or [elsewhere](//evil.example) or [there](/\\evil.example/login).",
  ].join("\n");
  const mounted = await render(report);
  const host = mounted.host;
  assert.equal(host.querySelector("h2")?.textContent, "Summary");
  assert.equal(host.querySelector("p")?.querySelectorAll("br").length, 1, "a single newline stays a line break");
  const ordered = host.querySelector("ol");
  assert.ok(ordered, "numbered lists render as <ol>");
  assert.equal(ordered!.children.length, 3, "a blank line between items keeps one list");
  assert.equal(ordered!.querySelector("ul")?.children.length, 2, "indented items nest");
  const code = host.querySelector("pre code");
  assert.equal(code?.textContent, "const a = 1;\n\nconst b = 2;", "a blank line inside a fence stays in the code");
  assert.match(host.textContent ?? "", /ts/);
  assert.equal(host.querySelectorAll("table tbody tr").length, 2);
  assert.equal((host.querySelector("table tbody td:nth-child(2)") as HTMLElement | null)?.style.textAlign, "right");
  assert.equal(host.querySelector("blockquote strong")?.textContent, "public");
  assert.ok(host.querySelector("hr"));
  const boxes = [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
  assert.deepEqual(boxes.map((box) => box.checked), [true, false]);
  const links = [...host.querySelectorAll("a")].map((link) => link.getAttribute("href"));
  assert.deepEqual(links, ["/code/review?review=1"], "app links work; protocol-relative and backslash links stay text");
  assert.equal(host.textContent?.includes("```"), false);
  assert.equal(host.textContent?.includes("| ---"), false);
  await unmount(mounted);
});

test("a heading keeps a # that belongs to its text", async () => {
  const mounted = await render("## Notes on C#\n\n### Done ###");
  const headings = [...mounted.host.querySelectorAll("h3, h4")].map((node) => node.textContent);
  assert.deepEqual(headings, ["Notes on C#", "Done"]);
  await unmount(mounted);
});

test("bare addresses become links that open in a new tab; code and existing links stay as they are", async () => {
  const notion = "https://app.notion.com/p/Launch-plan-2f3c9a1b?pvs=204";
  const mounted = await render(
    [
      "Your pages:",
      `- Launch plan: ${notion}`,
      "- Wiki (https://en.wikipedia.org/wiki/Python_(programming_language)).",
      "- **Docs: www.example.com/docs** and _see https://example.com/a_b_c_",
      "- Mail mira@fieldnote.example or <https://example.com/angle>",
      "- Code `https://example.com/in-code` and [named](https://example.com/named) and [in app](/tasks/1)",
      "- javascript:alert(1) stays text",
    ].join("\n"),
  );
  const anchors = [...mounted.host.querySelectorAll("a")];
  const hrefs = anchors.map((anchor) => anchor.getAttribute("href"));
  assert.deepEqual(hrefs, [
    notion,
    "https://en.wikipedia.org/wiki/Python_(programming_language)",
    "https://www.example.com/docs",
    "https://example.com/a_b_c",
    "mailto:mira@fieldnote.example",
    "https://example.com/angle",
    "https://example.com/named",
    "/tasks/1",
  ]);
  for (const anchor of anchors.filter((item) => item.getAttribute("href")!.startsWith("https://"))) {
    assert.equal(anchor.getAttribute("target"), "_blank");
    assert.equal(anchor.getAttribute("rel"), "noopener noreferrer");
  }
  const inApp = anchors.find((anchor) => anchor.getAttribute("href") === "/tasks/1")!;
  assert.equal(inApp.getAttribute("target"), null, "an in-app link stays in this tab");
  assert.equal(anchors[0]!.textContent, notion);
  assert.match(anchors[0]!.className, /overflow-wrap:anywhere/, "a long address wraps");
  assert.equal(mounted.host.querySelector("code")?.textContent, "https://example.com/in-code");
  assert.equal(mounted.host.querySelector("code a"), null);
  assert.ok(mounted.host.textContent?.includes("language))."), "the closing bracket and full stop after an address stay text");
  assert.equal(mounted.host.textContent?.includes("<https://"), false, "angle brackets around an address are not shown");
  assert.equal(mounted.host.querySelector("strong a")?.getAttribute("href"), "https://www.example.com/docs");
  await unmount(mounted);
});

test("with saved mentions, their @kind:Label shows as a chip; without them it stays text", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MarkdownText text="Ask @people:Mira Chen about @task:Ship it, see https://example.com" mentions={[{ kind: "people", id: "p-mira", label: "Mira Chen" }]} />);
  });
  const chip = host.querySelector<HTMLAnchorElement>("a.mention");
  assert.ok(chip);
  assert.equal(chip.dataset.kind, "people");
  assert.equal(chip.getAttribute("href"), "/context?tab=people&search=Mira%20Chen");
  assert.equal(chip.textContent, "@Mira Chen");
  assert.equal(host.querySelectorAll(".mention").length, 1, "an unknown mention is not guessed");
  assert.match(host.textContent ?? "", /@task:Ship it/);
  assert.equal(host.querySelector('a[href="https://example.com"]')?.getAttribute("target"), "_blank");
  await act(async () => root.unmount());
  host.remove();
});
