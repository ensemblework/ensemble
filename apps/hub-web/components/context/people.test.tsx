/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PersonRecord } from "@/lib/api";
import { emailProblem, findSamePerson } from "./person-match";
import { PeopleTab } from "./people";

(globalThis as { React?: typeof React }).React = React;

function person(id: string, name: string, email: string | null, derived = false): PersonRecord {
  return { id, name, email, role: null, team: null, lastInteraction: null, confidence: 1, projects: [], openTasks: 0, recentTitle: null, recentAt: null, derived };
}

const PEOPLE = [
  person("p1", "Arjun Rao", "Arjun.Rao@fieldnote.example"),
  person("p2", "Priya Shah", null),
  person("name:lena", "Lena", null, true),
];

test("an optional email is blank or a whole address", () => {
  assert.equal(emailProblem(""), null);
  assert.equal(emailProblem("  "), null);
  assert.equal(emailProblem("mira@fieldnote.example"), null);
  for (const bad of ["mira", "mira@", "@fieldnote.example", "mira@fieldnote", "mira @fieldnote.example", "mira@fieldnote.c"]) {
    assert.ok(emailProblem(bad), bad);
  }
});

test("the same person is found by email in any case, or by name when there is no email", () => {
  assert.equal(findSamePerson(PEOPLE, { name: "Someone else", email: " arjun.rao@FIELDNOTE.example " })?.id, "p1");
  assert.equal(findSamePerson(PEOPLE, { name: "Arjun Rao", email: "arjun@other.example" }), null, "a different address is someone else");
  assert.equal(findSamePerson(PEOPLE, { name: "  priya   shah ", email: "" })?.id, "p2");
  assert.equal(findSamePerson(PEOPLE, { name: "Lena", email: "" }), null, "a task assignee is not saved yet");
  assert.equal(findSamePerson(PEOPLE, { name: "", email: "" }), null);
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function mount(initialSearch: string) {
  const posts: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/people" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return json({ person: person("p9", "New", null) }, 201);
    }
    if (path === "/api/people") return json({ people: PEOPLE });
    return json({ error: "not mocked" }, 404);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PeopleTab initialSearch={initialSearch} />
      </QueryClientProvider>,
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return {
    host,
    posts,
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
      document.body.innerHTML = "";
    },
  };
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
  assert.ok(found, `button ${text}`);
  return found as HTMLButtonElement;
}

function dialogInputs() {
  const inputs = [...document.querySelectorAll<HTMLInputElement>("[role=dialog] input")];
  return { name: inputs[0]!, email: inputs[1]! };
}

test("a filter that matches no one says so and clears, instead of the first-run card", async () => {
  const view = await mount("zzz");
  assert.ok(view.host.querySelector("[data-people-no-match]"), "no-match state");
  assert.equal(view.host.querySelector("[data-people-empty]"), null, "not the first-run card");
  assert.match(view.host.textContent ?? "", /No people match “zzz”/);
  await act(async () => button("Clear filter").click());
  assert.equal(view.host.querySelectorAll("[data-person-card]").length, 3);
  await view.close();
});

test("Add person checks the email on the field and sends nothing until it is valid", async () => {
  const view = await mount("");
  await act(async () => button("Add person").click());
  const { name, email } = dialogInputs();
  await act(async () => {
    type(name, "Mira Chen");
    type(email, "mira@");
  });
  await act(async () => (document.querySelector("[role=dialog] form") as HTMLFormElement).requestSubmit());
  assert.equal(email.getAttribute("aria-invalid"), "true");
  const message = document.getElementById(email.getAttribute("aria-describedby") ?? "");
  assert.match(message?.textContent ?? "", /email address/);
  assert.equal(view.posts.length, 0);

  await act(async () => type(email, "mira@fieldnote.example"));
  assert.equal(email.getAttribute("aria-invalid"), null, "typing clears the error");
  await act(async () => (document.querySelector("[role=dialog] form") as HTMLFormElement).requestSubmit());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.deepEqual(view.posts, [{ name: "Mira Chen", email: "mira@fieldnote.example" }]);
  await view.close();
});

test("adding someone already there says so and offers to show them", async () => {
  const view = await mount("");
  await act(async () => button("Add person").click());
  const { name, email } = dialogInputs();
  await act(async () => {
    type(name, "A. Rao");
    type(email, "ARJUN.RAO@fieldnote.example");
  });
  await act(async () => (document.querySelector("[role=dialog] form") as HTMLFormElement).requestSubmit());
  const notice = document.querySelector("[data-person-duplicate]");
  assert.match(notice?.textContent ?? "", /Arjun Rao is already in your people/);
  assert.equal(view.posts.length, 0);
  await act(async () => button("Show Arjun Rao").click());
  assert.equal(document.querySelector("[role=dialog]"), null, "the dialog closes");
  const cards = [...view.host.querySelectorAll("[data-person-card]")];
  assert.deepEqual(cards.map((card) => card.getAttribute("data-person-card")), ["p1"]);
  assert.match(cards[0]!.className, /ring-accent/);
  await view.close();
});
