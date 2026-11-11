import "./ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { api, type AgentState } from "@/lib/api";
import { LiveProvider, useLive } from "./live";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: window.CustomEvent });

class TestEvents {
  static current: TestEvents;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Array<(event: { data: string }) => void>>();
  constructor() { TestEvents.current = this; }
  addEventListener(name: string, handler: (event: { data: string }) => void) {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], handler]);
  }
  emit(name: string, data: unknown) {
    for (const listener of this.listeners.get(name) ?? []) listener({ data: JSON.stringify(data) });
  }
  close() {}
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 90)); });

function Probe() {
  const { working, setWorking } = useLive();
  const state = useQuery({ queryKey: ["agent-state"], queryFn: api.agentState });
  return <><button onClick={() => setWorking("Reading this conversation")}>Local turn</button><output data-working>{working}</output><output data-calls>{state.data?.calls.map(row => row.id).join(",")}</output></>;
}

test("lifecycle events reconcile activity without replacing another conversation's local status", async () => {
  const oldEvents = globalThis.EventSource;
  Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: TestEvents });
  const oldTicket = api.eventsTicket;
  const oldState = api.agentState;
  let fetches = 0;
  let snapshot: AgentState = { paused: false, calls: [], running: [], waiting: [], queued: [] };
  api.eventsTicket = async () => ({ ticket: "test-ticket" });
  api.agentState = async () => { fetches++; return snapshot; };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><LiveProvider><Probe /></LiveProvider></QueryClientProvider>));
    await act(async () => TestEvents.current.onopen?.());
    await settle();
    assert.ok(fetches >= 2, "opening the stream reconciles any lifecycle change missed during connection");
    await act(async () => host.querySelector("button")!.click());
    await act(async () => TestEvents.current.emit("assistant.frame", { conversationId: "another-chat", frame: { type: "status", text: "Another conversation's tool" } }));
    assert.equal(host.querySelector("[data-working]")!.textContent, "Reading this conversation");
    const call = (id: string) => ({ id, kind: "assistant", label: "Working", startedAt: "2026-01-01T00:00:00Z" });
    snapshot = { ...snapshot, calls: [call("first"), call("second")] };
    const before = fetches;
    await act(async () => {
      TestEvents.current.emit("activity.changed", { id: "first", phase: "started" });
      TestEvents.current.emit("activity.changed", { id: "first", phase: "updated" });
      TestEvents.current.emit("activity.changed", { id: "second", phase: "started" });
    });
    await settle();
    assert.equal(fetches, before + 1, "nearby lifecycle events share one refetch");
    assert.equal(host.querySelector("[data-calls]")!.textContent, "first,second");
    snapshot = { ...snapshot, calls: [call("second")] };
    await act(async () => TestEvents.current.emit("activity.changed", { id: "first", phase: "ended" }));
    await settle();
    assert.equal(host.querySelector("[data-calls]")!.textContent, "second", "one ended turn cannot clear another active turn");
    assert.equal(host.querySelector("[data-working]")!.textContent, "Reading this conversation");
    snapshot = { ...snapshot, calls: [] };
    await act(async () => TestEvents.current.onopen?.());
    await settle();
    assert.equal(host.querySelector("[data-calls]")!.textContent, "", "reconnection repairs a missed terminal event");
  } finally {
    await act(async () => root.unmount());
    client.clear(); host.remove();
    api.eventsTicket = oldTicket;
    api.agentState = oldState;
    Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: oldEvents });
  }
});
