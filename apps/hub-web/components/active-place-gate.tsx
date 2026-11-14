"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api, request, SIGNED_OUT_EVENT } from "@/lib/api";
import { acquirePlace, nextPlaceInput, PLACE_BLOCKED_EVENT, type OpenPlace, type PlaceAnswer } from "@/lib/active-place";
import { InfoTip, Skeleton } from "./ui";

export function ActivePlaceGate({ children, allowAnonymous = false }: { children: ReactNode; allowAnonymous?: boolean }) {
  const [entered, setEntered] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [places, setPlaces] = useState<OpenPlace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const join = useRef<(replace?: string) => Promise<void>>(async () => {});

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let joining = false;
    let surface: "hub" | "desktop" = "hub";
    const block = (answer: PlaceAnswer) => {
      if (!live) return;
      window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT));
      if (answer.code === "PLACE_ACCOUNT_CHANGED") { window.location.reload(); return; }
      setAllowed(false);
      setChoosing(true);
      setPlaces(answer.places ?? []);
      setError(null);
    };
    const heartbeat = async (replace?: string) => {
      if (!live || joining) return;
      joining = true;
      setBusy(true);
      try {
        const input = nextPlaceInput(surface);
        const answer = await request<PlaceAnswer>(replace ? "/api/auth/places/continue" : "/api/auth/places", {
          method: "POST", json: { ...input, ...(replace ? { replace } : {}) }, surviveNavigation: true,
        });
        if (!live) return;
        if (!answer.allowed) { block(answer); return; }
        setEntered(true);
        setAllowed(true);
        setError(null);
        setPlaces([]);
        setChoosing(false);
      } catch (cause) {
        if (!live) return;
        if (cause instanceof ApiError && (cause.status === 401 || (allowAnonymous && cause.status === 403))) {
          window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT));
          if (allowAnonymous) {
            clearInterval(timer);
            stop?.();
            stop = undefined;
            setEntered(true);
            setAllowed(true);
            setError(null);
          } else window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
        } else if (cause instanceof ApiError && cause.status === 409) block(cause.data as PlaceAnswer);
        else {
          setError(cause instanceof Error ? cause.message : "Could not check your open places.");
        }
      } finally {
        joining = false;
        if (live) setBusy(false);
      }
    };
    const release = () => {
      if (!stop) return;
      const body = new Blob([JSON.stringify(nextPlaceInput(surface))], { type: "application/json" });
      navigator.sendBeacon("/api/auth/places/release", body);
    };
    const onBlock = (event: Event) => block((event as CustomEvent<PlaceAnswer>).detail);
    const onReturn = () => { void heartbeat(); };
    const start = async () => {
      try {
        const me = await api.me();
        if (!live) return;
        if (me.localOnly || me.via !== "session") { setAllowed(true); setEntered(true); return; }
        const desktop = (window as Window & { __ENSEMBLE_DESKTOP__?: unknown }).__ENSEMBLE_DESKTOP__;
        surface = desktop ? "desktop" : "hub";
        const unlock = await acquirePlace(me.user?.id);
        if (!live) { unlock(); return; }
        stop = unlock;
        join.current = heartbeat;
        window.addEventListener("pagehide", release);
        window.addEventListener("pageshow", onReturn);
        window.addEventListener(PLACE_BLOCKED_EVENT, onBlock);
        await heartbeat();
        if (!live || !stop) return;
        timer = setInterval(() => void heartbeat(), 10_000);
      } catch (cause) {
        if (!live) return;
        if (cause instanceof ApiError && cause.status === 401) {
          if (allowAnonymous) { setEntered(true); setAllowed(true); }
          else window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
        } else {
          setError(cause instanceof Error ? cause.message : "Could not open Ensemble.");
          join.current = async () => { await start(); };
        }
      }
    };
    void start();
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("pagehide", release);
      window.removeEventListener("pageshow", onReturn);
      window.removeEventListener(PLACE_BLOCKED_EVENT, onBlock);
      release();
      stop?.();
    };
  }, [allowAnonymous]);

  return <>
    {entered ? <div className="contents" inert={!allowed} aria-hidden={!allowed || undefined}>{children}</div> : null}
    {allowed && error ? <div role="status" className="fixed bottom-4 left-1/2 z-[110] flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-panel p-3 text-sm text-muted shadow-pop">
      {error}
      <button type="button" className="btn" disabled={busy} onClick={() => void join.current()}>Retry</button>
    </div> : null}
    {!allowed ? (
      <main className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-bg p-4">
        <section className="w-full max-w-lg rounded-xl border border-line bg-panel p-6 shadow-pop" aria-label="Open places">
          {choosing ? <>
            <h1 className="flex items-center gap-2 text-lg font-semibold">Choose where to continue <InfoTip text="You can keep Ensemble open in three web or desktop places. Ensemble Node has its own separate three-place limit. Closing a place or one minute without a heartbeat frees its slot. Continue here replaces the least recently heard Ensemble place; a row's button replaces that place. Other tabs, Node and the CLI stay signed in." /></h1>
            <p className="mt-2 text-sm text-muted">{places.length ? "Continue here by signing out one open place." : "Continue here to reopen this place."}</p>
            <ul className="mt-4 divide-y divide-line">
              {places.map((place) => <li key={place.windowId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0"><p className="font-medium">{place.surface === "node" ? "Ensemble Node" : place.surface === "desktop" ? "Desktop app" : "Ensemble web"}</p><p className="text-sm text-muted">{place.label}</p></div>
                <button type="button" className="btn min-h-11" disabled={busy} onClick={() => void join.current(place.windowId)}>Sign out this place</button>
              </li>)}
            </ul>
            <button type="button" className="btn-primary mt-4 min-h-11" disabled={busy} onClick={() => void join.current("oldest")}>{busy ? "Checking…" : "Continue here"}</button>
          </> : error ? <h1 className="text-lg font-semibold">Could not open Ensemble</h1> : <Skeleton className="h-16 w-full" />}
          {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}
          {error || places.length ? <button type="button" className="btn-ghost mt-3 min-h-11" disabled={busy} onClick={() => void join.current()}>Check again</button> : null}
        </section>
      </main>
    ) : null}
  </>;
}
