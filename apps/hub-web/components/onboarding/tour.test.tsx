/** @jsxRuntime automatic */
/** @jsxImportSource react */
import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { ONBOARDING_TOUR_KEY, READY_ONBOARDING_TOUR, readTourProgress } from "@ensemble/shared-types";
import { TEMPLATE_CARDS } from "@ensemble/shared-types/manifest";
import { api } from "@/lib/api";
import { OnboardingTour } from "./guided-tour";
import { buildTour, canAutoStartTour, tourProfile } from "./tour-plan";
import { demoBeat, SCENE_DURATION, CHAPTER_TRANSITION } from "./tour-playback";
import { demoCursor } from "./tour-scenes";

(globalThis as { React?: typeof React }).React = React;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
Object.defineProperty(globalThis, "CustomEvent", { configurable: true, value: window.CustomEvent });
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} disconnect() {} } });
Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
HTMLElement.prototype.scrollIntoView = () => {};

test("all 36 templates use their own role and enabled fictional scenes without live targets", () => {
  for (const template of TEMPLATE_CARDS) {
    const steps = buildTour(template.id, "code,diagrams");
    assert.equal(tourProfile(template.id).role, template.role);
    assert.equal(tourProfile(template.id).template?.tiles[0]?.[0], template.tiles[0]![0]);
    assert.ok(steps.every((step) => !["href", "target", "via"].some((key) => key in step)));
    assert.equal(steps.some((step) => step.id === "code"), template.role === "engineer" || template.role === "vibe");
    assert.equal(steps.some((step) => step.id === "meetings"), template.role === "manager");
    const restricted = buildTour(template.id, "diagrams");
    assert.ok(!restricted.some((step) => step.id === "code"));
    assert.equal(new Set(steps.map((step) => step.id)).size, steps.length);
  }
  assert.equal(tourProfile("removed-template").role, "general");
});

test("tour eligibility preserves established accounts and setup; progress rejects malformed values", () => {
  assert.equal(canAutoStartTour("/today", "ready"), true);
  assert.equal(canAutoStartTour("/board", "ready"), false);
  assert.equal(canAutoStartTour("/board", "active"), true);
  for (const path of ["/start", "/spaces/new", "/welcome"]) assert.equal(canAutoStartTour(path, "active"), false);
  for (const status of [undefined, "completed", "skipped"]) assert.equal(canAutoStartTour("/today", status), false);
  for (const value of [null, {}, { ...READY_ONBOARDING_TOUR, v: 2 }, { ...READY_ONBOARDING_TOUR, status: "unknown" }, { ...READY_ONBOARDING_TOUR, updatedAt: NaN }]) assert.equal(readTourProgress(value), null);
});

test("demonstrations are paced, eased, bounded and held at their final frame", () => {
  assert.equal(SCENE_DURATION, 12000);
  assert.ok(CHAPTER_TRANSITION >= 600);
  assert.equal(demoBeat(500, 1000, 3000), 0);
  assert.equal(demoBeat(2000, 1000, 3000), .5);
  assert.equal(demoBeat(14000, 1000, 3000), 1);
  for (const step of buildTour("branch-desk", "code")) {
    for (const ms of [0, 2000, 5000, 9000, 12000, 50000]) {
      const pointer = demoCursor(step.id, ms);
      assert.ok(pointer.x >= 0 && pointer.x <= 100 && pointer.y >= 0 && pointer.y <= 100);
    }
  }
});

const SHELL = {
  user: { id: "owner", name: "Mira Chen", email: "mira@fieldnote.example", emailVerified: true, hasPassword: true, profile: { gender: null, profession: "Engineer", organization: null, heardFrom: null } },
  via: "session", space: { id: "space", name: "Fieldnote", icon: null, primary: true },
  approvals: 0, decisions: 0, attention: 0, canUndo: false, canRedo: false,
  onboardingComplete: true, highlights: [], modules: "code,diagrams", onboardingTemplateId: "branch-desk",
} as Awaited<ReturnType<typeof api.shell>>;

async function until(check: () => boolean) {
  for (let i = 0; i < 65; i++) {
    if (check()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  assert.fail("Tour did not reach the expected state");
}
const shown = () => document.querySelector<HTMLElement>("[data-onboarding-tour]");
async function click(selector: string) { await act(async () => (document.querySelector(selector) as HTMLButtonElement).click()); }

async function mount({ progress = READY_ONBOARDING_TOUR as unknown, shared = false, fail = false, clear = true, reduced = true } = {}) {
  if (clear) localStorage.clear();
  document.documentElement.dataset.reduceMotion = String(reduced);
  window.history.replaceState(null, "", "/today");
  const realFetch = globalThis.fetch;
  const calls: { url: string; value: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const value = init?.body ? JSON.parse(String(init.body)).value : null;
    calls.push({ url, value });
    if (url.includes("/api/preferences/") && init?.method === "PUT") {
      return new Response(JSON.stringify(fail ? { error: "Offline" } : { preference: { id: "tour-pref", key: ONBOARDING_TOUR_KEY, value, source: "me", confidence: 1 } }), { status: fail ? 503 : 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(["shell"], { ...SHELL, space: { ...SHELL.space, shared: shared ? { owner: { id: "another" }, role: "viewer" } : null } });
  client.setQueryData(["preferences"], { preferences: progress ? [{ key: ONBOARDING_TOUR_KEY, value: progress }] : [] });
  const host = document.createElement("div"); document.body.append(host);
  const opener = document.createElement("button"); opener.textContent = "Account"; document.body.append(opener); opener.focus();
  const root = createRoot(host);
  const paths: string[] = [];
  function Harness() {
    const [path, setPath] = useState("/today");
    const router = { push: (href: string) => { paths.push(href); window.history.pushState(null, "", href); setPath(href.split("?")[0]!); }, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };
    return <AppRouterContext.Provider value={router as never}><PathnameContext.Provider value={path}><QueryClientProvider client={client}><OnboardingTour /></QueryClientProvider></PathnameContext.Provider></AppRouterContext.Provider>;
  }
  await act(async () => root.render(<Harness />));
  return { calls, paths, opener, done: async () => { await act(async () => root.unmount()); client.clear(); host.remove(); opener.remove(); globalThis.fetch = realFetch; delete document.documentElement.dataset.reduceMotion; } };
}

test("new users can change scenes, resume and replay while the real app stays on the same page", async () => {
  let view = await mount();
  try {
    await until(() => shown()?.dataset.onboardingTour === "welcome");
    assert.match(document.getElementById("tour-title")!.textContent!, /Mira/);
    assert.equal(view.opener.inert, true);
    assert.ok(shown()!.contains(document.activeElement));
    assert.equal(document.querySelector(".film-pointer"), null, "reduced motion has no simulated cursor");
    const button = document.querySelector("[data-tour-next]");
    const frame = document.querySelector(".walkthrough-stage-frame");
    assert.ok(document.querySelector<HTMLElement>(".film-app")?.hasAttribute("inert"));
    assert.equal(document.querySelectorAll(".film-app button, .film-app a, .film-app input").length, 0);
    await click("[data-tour-next]");
    assert.equal(shown()?.dataset.onboardingTour, "today");
    assert.equal(document.querySelector("[data-tour-next]"), button);
    assert.equal(document.querySelector(".walkthrough-stage-frame"), frame);
    assert.equal(window.location.pathname, "/today");
    await click("[data-tour-next]"); await click("[data-tour-next]");
    assert.equal(shown()?.dataset.onboardingTour, "board");
    assert.equal(view.paths.length, 0);
    await click(".walkthrough-back");
    assert.equal(shown()?.dataset.onboardingTour, "arrange");
    assert.equal(view.paths.length, 0);
    await until(() => (view.calls.at(-1)?.value as { step?: string })?.step === "arrange");
    await view.done();
    view = await mount({ clear: false });
    await until(() => shown()?.dataset.onboardingTour === "arrange");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(shown()?.dataset.onboardingTour ?? null, null);
    assert.equal(view.opener.inert, false);
    assert.equal(document.activeElement, view.opener);
    await act(async () => window.dispatchEvent(new Event("ensemble:onboarding-tour")));
    assert.equal(shown()?.dataset.onboardingTour, "welcome");
    await click(".walkthrough-close");
  } finally { await view.done(); }
});

test("existing and shared accounts stay uninterrupted; manual replay works for existing owners", async () => {
  let view = await mount({ progress: null });
  try {
    await act(async () => window.dispatchEvent(new Event("ensemble:onboarding-tour")));
    assert.equal(shown()?.dataset.onboardingTour, "welcome");
    await click(".walkthrough-close");
  } finally { await view.done(); }
  view = await mount({ shared: true });
  try {
    await act(async () => window.dispatchEvent(new Event("ensemble:onboarding-tour")));
    assert.equal(shown()?.dataset.onboardingTour ?? null, null);
    assert.equal(view.calls.length, 0);
  } finally { await view.done(); }
});

test("appearance or another modal finishes before automatic onboarding opens", async () => {
  const modal = document.createElement("div"); modal.setAttribute("aria-modal", "true"); document.body.append(modal);
  const view = await mount();
  try {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 750)); });
    assert.equal(shown()?.dataset.onboardingTour ?? null, null);
    await act(async () => modal.remove());
    await until(() => Boolean(shown()));
    await click(".walkthrough-close");
  } finally { modal.remove(); await view.done(); }
  const blocker = document.createElement("div"); blocker.setAttribute("aria-modal", "true"); document.body.append(blocker);
  const deferred = await mount();
  try {
    await act(async () => {
      const key = "ensemble.tour:owner:space";
      localStorage.setItem(key, JSON.stringify({ ...READY_ONBOARDING_TOUR, status: "skipped", updatedAt: Date.now() }));
      window.dispatchEvent(new window.StorageEvent("storage", { key }));
      blocker.remove();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 750)); });
    assert.equal(shown()?.dataset.onboardingTour ?? null, null, "another tab's dismissal cancels a pending automatic start");
  } finally { blocker.remove(); await deferred.done(); }
});

test("offline dismissal is remembered locally and completion only prefills a question", async () => {
  let view = await mount({ fail: true });
  try {
    await until(() => Boolean(shown())); await click(".walkthrough-close");
    await view.done();
    view = await mount({ clear: false });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 750)); });
    assert.equal(shown()?.dataset.onboardingTour ?? null, null, "stale server ready marker cannot override the local dismissal");
  } finally { await view.done(); }
  view = await mount({ progress: { ...READY_ONBOARDING_TOUR, status: "active", step: "finish" } });
  const drafts: string[] = [];
  const onDraft = (event: Event) => drafts.push((event as CustomEvent<{ text: string }>).detail.text);
  window.addEventListener("ensemble:assistant-prefill", onDraft);
  try {
    await until(() => shown()?.dataset.onboardingTour === "finish");
    await click(".walkthrough-ask");
    await until(() => drafts.length > 0);
    assert.equal(shown()?.dataset.onboardingTour ?? null, null);
    assert.match(drafts[0]!, /feature/);
    assert.ok(view.calls.every((call) => call.url.includes("/api/preferences/")), "no task creation, approvals, connections or model calls");
    assert.equal((view.calls.at(-1)?.value as { status?: string })?.status, "completed");
  } finally { window.removeEventListener("ensemble:assistant-prefill", onDraft); await view.done(); }
});


test("pause freezes the preview and chapter transitions keep the same Next button", async () => {
  const view = await mount({ progress: { ...READY_ONBOARDING_TOUR, status: "active", step: "board" }, reduced: false });
  try {
    await until(() => shown()?.dataset.onboardingTour === "board");
    await until(() => Number(document.querySelector<HTMLElement>(".walkthrough-stage")?.dataset.playbackMs) > 100);
    await click('[aria-label="Pause scene"]');
    const paused = document.querySelector<HTMLElement>(".walkthrough-stage")!.dataset.playbackMs;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
    assert.equal(document.querySelector<HTMLElement>(".walkthrough-stage")!.dataset.playbackMs, paused);
    const next = document.querySelector<HTMLButtonElement>("[data-tour-next]")!;
    await click("[data-tour-next]");
    assert.equal(document.querySelector("[data-tour-next]"), next);
    assert.equal(next.textContent, "Next");
    assert.equal(next.getAttribute("aria-disabled"), "true");
    assert.equal(document.activeElement, next);
    assert.equal(document.querySelectorAll(".film-layer").length, 2);
    await until(() => !next.hasAttribute("aria-disabled"));
    assert.equal(shown()?.dataset.onboardingTour, "context");
    assert.equal(document.querySelectorAll(".film-layer").length, 1);
    assert.equal(view.paths.length, 0);
    assert.equal(window.location.pathname, "/today");
    await click('[aria-label="Restart scene"]');
    assert.ok(Number(document.querySelector<HTMLElement>(".walkthrough-stage")!.dataset.playbackMs) < 100);
  } finally { await view.done(); }
});
