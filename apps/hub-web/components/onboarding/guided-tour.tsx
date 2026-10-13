"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, Pause, Play, RotateCcw, Sparkles, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ONBOARDING_TOUR_KEY, readTourProgress, type OnboardingTourProgress } from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { useModalFocus } from "@/lib/modal-focus";
import { useToast } from "@/components/toast";
import { buildTour, canAutoStartTour, tourProfile, type TourStep } from "./tour-plan";
import { CHAPTER_TRANSITION, useScenePlayback } from "./tour-playback";
import { DemoApp, TourScene, FitPreview } from "./tour-scenes";

type Shell = Awaited<ReturnType<typeof api.shell>>;
function localProgress(key: string) {
  try { return readTourProgress(JSON.parse(localStorage.getItem(key) ?? "null")); } catch { return null; }
}

/** A private, self-contained demonstration for the signed-in owner's current space. */
export function OnboardingTour() {
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const path = usePathname();
  if (!shell.data?.onboardingComplete || shell.data.space?.shared || path === "/start" || path.startsWith("/spaces/new") || path === "/welcome") return null;
  const scope = `${shell.data.user.id}:${shell.data.space?.id ?? shell.data.user.id}`;
  return <TourSession key={scope} shell={shell.data} scope={scope} />;
}

export function TourSession({ shell, scope }: { shell: Shell; scope: string }) {
  const path = usePathname();
  const client = useQueryClient();
  const toast = useToast();
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences, staleTime: 30_000 });
  const steps = useMemo(() => buildTour(shell.onboardingTemplateId, shell.modules), [shell.onboardingTemplateId, shell.modules]);
  const profile = useMemo(() => tourProfile(shell.onboardingTemplateId, shell.modules), [shell.onboardingTemplateId, shell.modules]);
  const storageKey = `ensemble.tour:${scope}`;
  const [id, setId] = useState<string | null>(null);
  const [reduced, setReduced] = useState(false);
  const opened = useRef(false);
  const alive = useRef(true);
  const queue = useRef(Promise.resolve());
  const warned = useRef(false);
  const layer = useRef<HTMLDivElement>(null);
  const index = Math.max(0, steps.findIndex((step) => step.id === id));
  const current = steps[index]!;
  const open = id !== null;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches || document.documentElement.dataset.reduceMotion === "true");
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduce-motion"] });
    media.addEventListener("change", update);
    return () => { observer.disconnect(); media.removeEventListener("change", update); };
  }, []);

  const remember = useCallback((status: OnboardingTourProgress["status"], step: string) => {
    const progress: OnboardingTourProgress = { v: 1, status, step, updatedAt: Date.now() };
    try { localStorage.setItem(storageKey, JSON.stringify(progress)); } catch { /* The server also stores progress. */ }
    queue.current = queue.current.then(async () => {
      if (!alive.current) return;
      const latest = localProgress(storageKey);
      if (latest && latest.updatedAt > progress.updatedAt) return;
      try {
        const result = await api.putPreference(ONBOARDING_TOUR_KEY, progress);
        if (!alive.current) return;
        client.setQueryData<Awaited<ReturnType<typeof api.preferences>>>(["preferences"], (old) => old ? {
          preferences: [...old.preferences.filter((row) => row.key !== ONBOARDING_TOUR_KEY), result.preference],
        } : old);
      } catch {
        if (!warned.current && alive.current) {
          warned.current = true;
          toast("Tour progress couldn't sync. It's kept on this device when browser storage is available.");
        }
      }
    });
  }, [client, storageKey, toast]);

  useEffect(() => {
    if (opened.current || !prefs.isSuccess) return;
    const server = readTourProgress(prefs.data.preferences.find((row) => row.key === ONBOARDING_TOUR_KEY)?.value);
    const local = localProgress(storageKey);
    const saved = local && (!server || local.updatedAt > server.updatedAt) ? local : server;
    if (!canAutoStartTour(path, saved?.status)) return;
    const start = () => {
      if (opened.current || document.querySelector('[aria-modal="true"]')) return;
      opened.current = true;
      const step = steps.find((item) => item.id === saved?.step) ?? steps[0]!;
      setId(step.id);
      remember("active", step.id);
    };
    const timer = window.setTimeout(start, 700);
    const observer = new MutationObserver(() => { if (!opened.current) start(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [prefs.isSuccess, prefs.data, storageKey, path, steps, remember]);

  useEffect(() => {
    const replay = () => {
      if (document.querySelector('[aria-modal="true"]')) return;
      opened.current = true;
      warned.current = false;
      setId("welcome");
      remember("active", "welcome");
    };
    const sync = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      const saved = localProgress(storageKey);
      if (saved?.status === "completed" || saved?.status === "skipped") { opened.current = true; setId(null); }
    };
    window.addEventListener("ensemble:onboarding-tour", replay);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("ensemble:onboarding-tour", replay); window.removeEventListener("storage", sync); };
  }, [storageKey, remember]);

  const close = useCallback((status: "completed" | "skipped") => { remember(status, current.id); setId(null); }, [remember, current.id]);
  useModalFocus(layer, open, () => close("skipped"));
  const go = (next: number) => { const step = steps[next]; if (step) { setId(step.id); remember("active", step.id); } };
  const finish = (ask: boolean) => {
    close("completed");
    if (ask) window.setTimeout(() => window.dispatchEvent(new CustomEvent("ensemble:assistant-prefill", { detail: { text: profile.prompt } })), 100);
  };

  return open ? createPortal(<Walkthrough layer={layer} steps={steps} index={index} profile={profile} reduced={reduced}
    name={shell.user.name?.trim().split(/\s+/)[0] ?? ""} onSkip={() => close("skipped")} onGo={go} onFinish={finish} />, document.body) : null;
}

function Walkthrough({ layer, steps, index, profile, reduced, name, onSkip, onGo, onFinish }: {
  layer: React.RefObject<HTMLDivElement | null>; steps: TourStep[]; index: number; profile: ReturnType<typeof tourProfile>; reduced: boolean; name: string;
  onSkip: () => void; onGo: (index: number) => void; onFinish: (ask: boolean) => void;
}) {
  const current = steps[index]!;
  const [departing, setDeparting] = useState<{ step: TourStep; ms: number } | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playback = useScenePlayback(current.id, current.duration, reduced, transitioning);
  const next = useRef<HTMLButtonElement>(null);
  useEffect(() => { next.current?.focus({ preventScroll: true }); return () => { if (timer.current) clearTimeout(timer.current); }; }, []);
  const go = (to: number) => {
    if (transitioning || to === index) return;
    if (!reduced) {
      setDeparting({ step: current, ms: playback.ms });
      setTransitioning(true);
      timer.current = setTimeout(() => { setDeparting(null); setTransitioning(false); }, CHAPTER_TRANSITION);
    }
    onGo(to);
  };
  const final = current.id === "finish";
  const seconds = (ms: number) => `0:${String(Math.floor(ms / 1000)).padStart(2, "0")}`;
  return <div ref={layer} className="guided-tour" data-modal-layer="onboarding-tour" data-reduced={reduced || undefined} data-onboarding-tour={current.id} tabIndex={-1}
    onKeyDown={(event) => { if (event.key !== "Tab" && event.key !== "Escape") event.stopPropagation(); }}>
    <div className="walkthrough-scrim" aria-hidden />
    <div className="walkthrough" data-transitioning={transitioning || undefined} role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-description">
      <header className="walkthrough-header"><div><span className="walkthrough-dot" /><strong>Meet your Ensemble</strong><span className="walkthrough-preview-label">A guided preview</span></div><button type="button" className="walkthrough-close" aria-label="Skip tour" onClick={onSkip}><X size={17} /></button></header>
      <div className="walkthrough-stage" data-playback-ms={Math.round(playback.ms)}><div className="walkthrough-stage-frame"><FitPreview><DemoApp step={current} chapters={steps}>
        {departing && <div className="film-layer" data-phase="out"><TourScene step={departing.step} profile={profile} ms={departing.ms} reduced={reduced} /></div>}
        <div key={current.id} className="film-layer" data-phase={transitioning ? "in" : undefined}><TourScene step={current} profile={profile} ms={playback.ms} reduced={reduced} /></div>
      </DemoApp></FitPreview></div><span className="walkthrough-sample-label">Example workspace</span></div>
      <div className="walkthrough-caption">
        {departing && <div className="walkthrough-copy" data-phase="out" aria-hidden><span className="walkthrough-kicker">{departing.step.label}</span><h2>{departing.step.title}</h2><p>{departing.step.body}</p></div>}
        <div key={current.id} className="walkthrough-copy" data-phase={transitioning ? "in" : undefined}><span className="walkthrough-kicker">{current.label}</span><h2 id="tour-title">{current.id === "welcome" && name && !name.includes("@") && name !== "Local" ? `Welcome in, ${name}.` : current.title}</h2><p id="tour-description">{current.body}</p></div>
      </div>
      <footer className="walkthrough-footer"><div className="walkthrough-playback"><button type="button" className="walkthrough-player-button" aria-label={playback.ms >= current.duration ? "Replay scene" : playback.playing ? "Pause scene" : "Play scene"} disabled={reduced || transitioning} onClick={playback.toggle}>{playback.playing && playback.ms < current.duration ? <Pause size={15} /> : <Play size={15} />}</button><button type="button" className="walkthrough-player-button" aria-label="Restart scene" disabled={reduced || transitioning} onClick={playback.restart}><RotateCcw size={14} /></button><div className="walkthrough-player-status"><span>{reduced ? "Reduced motion" : `${seconds(playback.ms)} / ${seconds(current.duration)}`}</span><div className="walkthrough-scene-progress" role="progressbar" aria-label="Scene playback" aria-valuemin={0} aria-valuemax={current.duration / 1000} aria-valuenow={Math.floor(playback.ms / 1000)}><i style={{ width: `${playback.ms / current.duration * 100}%` }} /></div></div></div>
        <div className="walkthrough-chapters" aria-label="Tour chapters">{steps.map((step, i) => <button type="button" key={step.id} aria-label={`Chapter ${i + 1}: ${step.label}`} aria-current={i === index ? "step" : undefined} aria-disabled={transitioning || undefined} onClick={() => go(i)}><span data-complete={i < index || undefined} /></button>)}<small>{String(index + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}</small></div>
        <div className="walkthrough-navigation"><button type="button" className="walkthrough-back" disabled={index === 0} aria-disabled={transitioning || undefined} onClick={() => go(index - 1)}><ArrowLeft size={15} /><span>Back</span></button><button ref={next} type="button" className="walkthrough-next" data-tour-next aria-disabled={transitioning || undefined} onClick={() => { if (!transitioning) { if (final) onFinish(false); else go(index + 1); } }}>{final ? "Done" : "Next"}{final ? <Check size={15} /> : <ArrowRight size={15} />}</button></div>
      </footer>
      <span className="sr-only" aria-live="polite" aria-atomic="true">Chapter {index + 1} of {steps.length}. {current.title}. {current.body}</span>
      {final && <button type="button" className="walkthrough-ask" onClick={() => onFinish(true)}><Sparkles size={13} />Try my first question</button>}
    </div>
  </div>;
}
