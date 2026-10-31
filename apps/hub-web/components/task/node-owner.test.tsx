import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { NodeAssignable } from "@/lib/api";
import { nodeOwnerText } from "@/lib/node-owner";
import { NodeOwnerItems, type NodeOwnerPick } from "./node-owner.js";

(globalThis as { React?: typeof React }).React = React;

const mine: NodeAssignable = {
  nodes: [
    { id: "n-assistant", slug: "assistant", name: "Assistant", role: "assistant" },
    { id: "n-tester", slug: "tester", name: "Tester", role: "tester" },
  ],
  crews: [{ roomId: "r-team", title: "Software team", lead: { id: "n-manager", slug: "manager", name: "Manager" }, members: 3 }],
};

async function mount(element: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return { host, done: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test("the owner menu lists my nodes and crews in their own groups and gives the task to the one picked", async () => {
  const picks: NodeOwnerPick[] = [];
  const view = await mount(<NodeOwnerItems mine={mine} task={{ owner: "node", assigneeNodeId: "n-tester", assigneeRoomId: null }} onPick={(pick) => picks.push(pick)} />);
  try {
    const nodes = view.host.querySelector('[role="group"][aria-label="Nodes"]')!;
    const crews = view.host.querySelector('[role="group"][aria-label="Crews"]')!;
    assert.deepEqual([...nodes.querySelectorAll("button")].map((button) => button.textContent), ["Assistantassistant", "Testertester"]);
    assert.equal(crews.querySelector("button")!.textContent, "Software team@manager leads");
    assert.ok(nodes.querySelectorAll("button")[1]!.className.includes("bg-hover"), "the node that has it is marked");
    await act(async () => crews.querySelector("button")!.click());
    await act(async () => nodes.querySelector("button")!.click());
    assert.deepEqual(picks, [
      { owner: "node", assigneeNodeId: null, assigneeRoomId: "r-team" },
      { owner: "node", assigneeNodeId: "n-assistant", assigneeRoomId: null },
    ]);
  } finally {
    await view.done();
  }
  const none = await mount(<NodeOwnerItems mine={{ nodes: [], crews: [] }} task={{ owner: "me", assigneeNodeId: null, assigneeRoomId: null }} onPick={() => undefined} />);
  try {
    assert.equal(none.host.innerHTML, "", "nothing without nodes");
  } finally {
    await none.done();
  }
});

test("a task with a node or crew names it: my own by handle or title, another person's by what the server shows", () => {
  assert.equal(nodeOwnerText({ owner: "node", assigneeNodeId: "n-tester", assigneeRoomId: null }, mine), "@tester");
  assert.equal(nodeOwnerText({ owner: "node", assigneeNodeId: null, assigneeRoomId: "r-team" }, mine), "Software team");
  assert.equal(nodeOwnerText({ owner: "node", assigneeNodeId: "n-ben", assigneeRoomId: null, nodeAssignee: { kind: "node", id: "n-ben", name: "Scout", handle: "scout", accountId: "ben" } }), "@scout");
  assert.equal(nodeOwnerText({ owner: "node", assigneeNodeId: null, assigneeRoomId: "r-ben", nodeAssignee: { kind: "crew", id: "r-ben", name: "Crew", handle: null, accountId: "ben" } }), "Crew");
  assert.equal(nodeOwnerText({ owner: "node", assigneeNodeId: "n-new", assigneeRoomId: null, nodeAssignee: { kind: "node", id: "n-old", name: "Old", handle: "old", accountId: "me" } }), "A node", "never a stale name while a change saves");
});
