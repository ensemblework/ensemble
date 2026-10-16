/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import { setTestUrl } from "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { contextTabs } from "./context-tabs";
import { contextTabHref, useLensTab } from "./lens-tab";

test("each Context tab has its own address; Overview is plain /context", () => {
  assert.equal(contextTabHref("overview"), "/context");
  assert.equal(contextTabHref("deadlines"), "/context?tab=deadlines");
  assert.equal(contextTabHref("projects"), "/context?tab=projects");
});

function Harness({ fromUrl, onActive }: { fromUrl: string | null; onActive: (tab: string, choose: (label: string) => void) => void }) {
  const [active, choose] = useLensTab(contextTabs("semester"), fromUrl);
  onActive(active, choose);
  return <span data-active={active} />;
}

test("choosing a tab pushes that tab's address, so Back returns to the one before", async () => {
  setTestUrl("http://localhost/context?tab=projects");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let active = "";
  let choose: (label: string) => void = () => undefined;
  const render = (fromUrl: string | null) =>
    act(async () => {
      root.render(<Harness fromUrl={fromUrl} onActive={(tab, pick) => { active = tab; choose = pick; }} />);
    });
  await render("projects");
  assert.equal(active, "Projects");
  const before = window.history.length;

  await act(async () => choose("Deadlines"));
  assert.equal(active, "Deadlines");
  assert.equal(window.location.search, "?tab=deadlines", "the address names the tab just chosen, not the one before");
  assert.equal(window.history.length, before + 1, "a new history entry, not a replaced one");

  await act(async () => choose("Overview"));
  assert.equal(`${window.location.pathname}${window.location.search}`, "/context");
  assert.equal(window.history.length, before + 2);

  // Choosing the open tab again adds nothing.
  await act(async () => choose("Overview"));
  assert.equal(window.history.length, before + 2);

  // Back: the router reports ?tab= from the restored address and the lens follows it.
  await render("deadlines");
  assert.equal(active, "Deadlines");
  await render(null);
  assert.equal(active, "Overview");
  await act(async () => root.unmount());
  host.remove();
});

test("an unknown ?tab= opens Overview", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let active = "";
  await act(async () => {
    root.render(<Harness fromUrl="nope" onActive={(tab) => { active = tab; }} />);
  });
  assert.equal(active, "Overview");
  await act(async () => root.unmount());
  host.remove();
});
