import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { api, setOpenLink } from "@/lib/api";
import { Dialog } from "../ui";
import { ContactLimitDialog, PublicLinkLimitDialog } from "./sharing-limits.js";
import { JoinInvitation, inviteForPublicAI } from "./join-invitation.js";
import { CommandPalette } from "../shell/command-palette.js";
import { DEFAULT_APPEARANCE, applyAppearance } from "@/lib/prefs";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: window.CustomEvent });
Object.defineProperty(globalThis, "self", { configurable: true, value: window });
window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
const settle = async (ms = 30) => act(async () => new Promise(resolve => setTimeout(resolve, ms)));
const click = async (node: Element) => act(async () => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
async function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)); await settle();
  return async () => { await act(async () => root.unmount()); client.clear(); host.remove(); };
}

test("text scaling keeps the root layout size stable", () => {
  document.documentElement.style.fontSize = "100%";
  applyAppearance({ ...DEFAULT_APPEARANCE, textScale: 125 });
  assert.equal(document.documentElement.style.fontSize, "");
  assert.equal(document.documentElement.style.getPropertyValue("--text-scale"), "1.25");
  applyAppearance(DEFAULT_APPEARANCE);
});

test("public AI attempts invite visitors to join and can return to writing", async () => {
  const done = await mount(<JoinInvitation />);
  try {
    assert.equal(inviteForPublicAI(), false);
    setOpenLink("fixture-public-token");
    await act(async () => { assert.equal(inviteForPublicAI(), true); });
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /Keep editing this shared page/);
    assert.equal(document.querySelector<HTMLAnchorElement>('a[href="/signup"]')!.textContent!.includes("Create your"), true);
    await click([...document.querySelectorAll("button")].find(button => button.textContent === "Keep writing")!);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { setOpenLink(null); await done(); }
});

test("public limit lists existing pages and revokes before continuing", async () => {
  const oldList = api.publicLinks, oldRemove = api.removePublicLink; const order: string[] = [];
  api.publicLinks = async () => ({ limit: 3, links: [{ id: "l1", title: "Field plan", kind: "page", role: "edit" }] }) as never;
  api.removePublicLink = async id => { order.push(`revoke:${id}`); return undefined as never; };
  function NestedShare() {
    const [open, setOpen] = React.useState(false);
    return <Dialog open onClose={() => {}} title="Share page"><button type="button" onClick={() => setOpen(true)}>Open public limit</button><PublicLinkLimitDialog open={open} onClose={() => setOpen(false)} onContinue={async () => { order.push("continue"); }} /></Dialog>;
  }
  const done = await mount(<NestedShare />);
  try {
    await click([...document.querySelectorAll("button")].find(button => button.textContent === "Open public limit")!);
    await settle();
    const top = [...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.textContent?.includes("Field plan"))!;
    assert.equal(top.closest("[inert]"), null, "the nested limit dialog owns the modal focus scope");
    assert.match(top.textContent!, /Field plan/);
    await click([...document.querySelectorAll("button")].find(button => button.textContent === "Revoke and continue")!); await settle();
    assert.deepEqual(order, ["revoke:l1", "continue"]);
  } finally { await done(); api.publicLinks = oldList; api.removePublicLink = oldRemove; }
});

test("accounts with older public links can revoke down to the new budget without losing the pending page", async () => {
  const oldList = api.publicLinks, oldRemove = api.removePublicLink;
  let rows = Array.from({ length: 5 }, (_, i) => ({ id: `l${i}`, title: `Old page ${i}`, kind: "page", role: "view" }));
  let continued = 0;
  api.publicLinks = async () => ({ limit: 3, links: rows }) as never;
  api.removePublicLink = async id => { rows = rows.filter(row => row.id !== id); return undefined as never; };
  const done = await mount(<PublicLinkLimitDialog open onClose={() => {}} onContinue={async () => { continued++; }} />);
  try {
    for (let i = 0; i < 3; i++) {
      await click([...document.querySelectorAll("button")].find(button => button.textContent === "Revoke and continue")!);
      await settle();
      assert.equal(continued, i === 2 ? 1 : 0);
    }
  } finally { await done(); api.publicLinks = oldList; api.removePublicLink = oldRemove; }
});

test("contact limit explains account-wide revocation and removes the chosen contact", async () => {
  const oldList = api.contacts, oldRemove = api.removeContact; let removed = "";
  api.contacts = async () => ({ limit: 5, contacts: [{ id: "c1", name: "Ben Ortiz" }] }) as never;
  api.removeContact = async id => { removed = id; return undefined as never; };
  const done = await mount(<ContactLimitDialog open onClose={() => {}} />);
  try {
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /all your Ensemble spaces and items/);
    await click([...document.querySelectorAll("button")].find(button => button.textContent === "Remove and revoke access")!); await settle();
    assert.equal(removed, "c1");
  } finally { await done(); api.contacts = oldList; api.removeContact = oldRemove; }
});

test("one search includes records and settings; an early Enter waits for the result", async () => {
  const originals = { shell: api.shell, spaces: api.spaces, searchWorkspace: api.searchWorkspace };
  api.shell = async () => ({ modules: "", space: null }) as never;
  api.spaces = async () => ({ spaces: [] }) as never;
  let complete: ((value: unknown) => void) | undefined;
  api.searchWorkspace = async () => new Promise(resolve => { complete = resolve as never; });
  const paths: string[] = [];
  const router = { push: (path: string) => paths.push(path), replace() {}, prefetch: async () => {}, back() {}, forward() {}, refresh() {} };
  const done = await mount(<AppRouterContext.Provider value={router}><CommandPalette open onClose={() => {}} /></AppRouterContext.Provider>);
  try {
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /Settings/);
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Search your work, views and settings"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "violetphrase"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await settle(200);
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    assert.deepEqual(paths, []);
    await act(async () => complete!({ results: [{ path: "/pages/p1", label: "Violetphrase plan", kind: "page", excerpt: "A violetphrase inside the note" }] })); await settle();
    assert.match(paths[0]!, /^\/pages\/p1\?/);
  } finally { await done(); Object.assign(api, originals); }
});
