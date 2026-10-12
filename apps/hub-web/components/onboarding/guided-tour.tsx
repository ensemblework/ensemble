"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, CalendarDays, Check, CheckCheck, CircleCheck, Code2, Columns3, FolderOpen, MousePointer2, Plug, SlidersHorizontal, Sparkles, Users, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ONBOARDING_TOUR_KEY, readTourProgress, type OnboardingTourProgress } from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { useModalFocus } from "@/lib/modal-focus";
import { useToast } from "@/components/toast";
import { ROLES } from "./roles";
import { buildTour, canAutoStartTour, tourProfile, type TourStep } from "./tour-plan";
import { fitTourTarget, placeTourCard, type TourBox } from "./tour-position";

type Shell = Awaited<ReturnType<typeof api.shell>>;
const ICONS = { today: CalendarDays, arrange: SlidersHorizontal, board: Columns3, context: Users, files: FolderOpen, code: Code2, meetings: CalendarDays, connections: Plug, assistant: Sparkles, approvals: CircleCheck };

function findTarget(selector?: string): HTMLElement | null {
  if (!selector) return null;
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden";
  }) ?? null;
}

function localProgress(key: string) {
  try { return readTourProgress(JSON.parse(localStorage.getItem(key) ?? "null")); } catch { return null; }
}

/** Progress is only read for the signed-in owner's current space. */
export function OnboardingTour() {
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const path = usePathname();
  if (!shell.data?.onboardingComplete || shell.data.space?.shared || path === "/start" || path.startsWith("/spaces/new") || path === "/welcome") return null;
  const scope = `${shell.data.user.id}:${shell.data.space?.id ?? shell.data.user.id}`;
  return <TourSession key={scope} shell={shell.data} scope={scope} />;
}

export function TourSession({ shell, scope }: { shell: Shell; scope: string }) {
  const router = useRouter();
  const path = usePathname();
  const client = useQueryClient();
  const toast = useToast();
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences, staleTime: 30_000 });
  const steps = useMemo(() => buildTour(shell.onboardingTemplateId, shell.modules), [shell.onboardingTemplateId, shell.modules]);
  const profile = tourProfile(shell.onboardingTemplateId);
  const storageKey = `ensemble.tour:${scope}`;
  const [id, setId] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [cursor, setCursor] = useState<TourBox | null>(null);
  const [clicking, setClicking] = useState(false);
  const [reduce, setReduce] = useState(false);
  const opened = useRef(false);
  const alive = useRef(true);
  const queue = useRef(Promise.resolve());
  const delay = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const warned = useRef(false);
  const layer = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const currentIndex = Math.max(0, steps.findIndex((step) => step.id === id));
  const current = steps[currentIndex]!;
  const open = id !== null;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; if (delay.current) clearTimeout(delay.current); };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduce(media.matches || document.documentElement.dataset.reduceMotion === "true");
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduce-motion"] });
    media.addEventListener("change", update);
    return () => { observer.disconnect(); media.removeEventListener("change", update); };
  }, []);

  const remember = useCallback((status: OnboardingTourProgress["status"], step: string) => {
    const progress: OnboardingTourProgress = { v: 1, status, step, updatedAt: Date.now() };
    try { localStorage.setItem(storageKey, JSON.stringify(progress)); } catch { /* Server persistence works without browser storage. */ }
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

  const visit = useCallback((step: TourStep) => {
    if (step.href && `${window.location.pathname}${window.location.search}` !== step.href) router.push(step.href, { scroll: false });
    setId(step.id);
  }, [router]);

  useEffect(() => {
    if (opened.current || !prefs.isSuccess) return;
    const server = readTourProgress(prefs.data.preferences.find((row) => row.key === ONBOARDING_TOUR_KEY)?.value);
    const local = localProgress(storageKey);
    const saved = local && (!server || local.updatedAt > server.updatedAt) ? local : server;
    if (!canAutoStartTour(path, saved?.status)) return;
    // A different modal, including the first-device appearance picker, finishes first.
    const start = () => {
      if (opened.current || document.querySelector('[aria-modal="true"]')) return;
      opened.current = true;
      const step = steps.find((item) => item.id === saved?.step) ?? steps[0]!;
      visit(step);
      remember("active", step.id);
    };
    const timer = window.setTimeout(start, 700);
    const observer = new MutationObserver(() => { if (!opened.current) start(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [prefs.isSuccess, prefs.data, storageKey, path, steps, visit, remember]);

  useEffect(() => {
    const replay = () => {
      if (document.querySelector('[aria-modal="true"]')) return;
      opened.current = true;
      warned.current = false;
      visit(steps[0]!);
      remember("active", "welcome");
    };
    const sync = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      const saved = localProgress(storageKey);
      if (saved?.status === "completed" || saved?.status === "skipped") {
        opened.current = true;
        generation.current++;
        if (delay.current) clearTimeout(delay.current);
        setId(null);
        setMoving(false);
        setCursor(null);
        setClicking(false);
      }
    };
    window.addEventListener("ensemble:onboarding-tour", replay);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("ensemble:onboarding-tour", replay); window.removeEventListener("storage", sync); };
  }, [steps, storageKey, visit, remember]);

  const close = useCallback((status: "completed" | "skipped") => {
    generation.current++;
    if (delay.current) clearTimeout(delay.current);
    remember(status, current.id);
    setId(null);
    setMoving(false);
    setCursor(null);
    setClicking(false);
  }, [remember, current.id]);
  useModalFocus(layer, open, () => close("skipped"));

  const go = (index: number) => {
    const next = steps[index];
    if (!next || moving) return;
    const target = findTarget(next.via) ?? findTarget(current.target);
    const rect = target?.getBoundingClientRect();
    const thisGeneration = ++generation.current;
    const proceed = () => {
      if (!alive.current || generation.current !== thisGeneration) return;
      visit(next);
      remember("active", next.id);
      setMoving(false);
      setClicking(false);
      setCursor(null);
    };
    if (!reduce && rect && window.innerWidth >= 768) {
      setMoving(true);
      setCursor({ left: rect.left + Math.min(rect.width / 2, 110), top: rect.top + rect.height / 2, width: 0, height: 0 });
      delay.current = setTimeout(() => {
        if (!alive.current || generation.current !== thisGeneration) return;
        setClicking(true);
        delay.current = setTimeout(proceed, 220);
      }, 430);
    } else proceed();
  };

  const finish = (ask: boolean) => {
    close("completed");
    router.push("/today");
    if (ask) window.setTimeout(() => window.dispatchEvent(new CustomEvent("ensemble:assistant-prefill", { detail: { text: profile.prompt } })), 100);
    else toast("You're ready. Make this space your own.");
  };

  return open ? createPortal(
    <TourLayer layer={layer} card={card} step={current} index={currentIndex} total={steps.length} path={path} reduce={reduce} cursor={cursor} clicking={clicking} moving={moving}
      name={shell.user.name?.trim().split(/\s+/)[0] ?? ""} profile={profile} onSkip={() => close("skipped")} onBack={() => go(currentIndex - 1)} onNext={() => go(currentIndex + 1)} onFinish={finish} />,
    document.body,
  ) : null;
}

function TourLayer({ layer, card, step, index, total, path, reduce, cursor, clicking, moving, name, profile, onSkip, onBack, onNext, onFinish }: {
  layer: React.RefObject<HTMLDivElement | null>; card: React.RefObject<HTMLDivElement | null>; step: TourStep; index: number; total: number; path: string; reduce: boolean;
  cursor: TourBox | null; clicking: boolean; moving: boolean; name: string; profile: ReturnType<typeof tourProfile>;
  onSkip: () => void; onBack: () => void; onNext: () => void; onFinish: (ask: boolean) => void;
}) {
  const [geometry, setGeometry] = useState<{ target: TourBox | null; card: TourBox } | null>(null);
  const settled = !step.href || path === step.href.split("?")[0];
  useLayoutEffect(() => {
    let frame = 0;
    let scrolled: HTMLElement | null = null;
    const update = () => {
      frame = 0;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const node = settled ? findTarget(step.target) : null;
      if (node && node !== scrolled) { node.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); scrolled = node; }
      const rect = node?.getBoundingClientRect();
      const box = rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
      // Large page surfaces spotlight their opening content, leaving room for the guide.
      if (box && node?.dataset.tourAnchor === "workspace") { box.left += 16; box.top += 16; box.width = Math.min(box.width - 32, 640); box.height = Math.min(box.height - 32, 230); }
      let target = box ? fitTourTarget(box, viewport) : null;
      if (!target && settled && step.target) {
        const surface = findTarget("main[data-tour-anchor=workspace]");
        if (surface) {
          surface.scrollTop = 0;
          const rect = surface.getBoundingClientRect();
          target = fitTourTarget({ left: rect.left + 16, top: rect.top + 16, width: Math.min(rect.width - 32, 640), height: Math.min(rect.height - 32, 230) }, viewport);
        }
      }
      setGeometry({ target, card: placeTourCard(target, viewport, (card.current?.scrollHeight ?? 378) + 2) });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    const observer = new MutationObserver(schedule);
    observer.observe(document.querySelector("main") ?? document.body, { childList: true, subtree: true });
    const resize = new ResizeObserver(schedule);
    if (card.current) resize.observe(card.current);
    const target = findTarget(step.target);
    if (target) resize.observe(target);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    return () => { observer.disconnect(); resize.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("resize", schedule); document.removeEventListener("scroll", schedule, true); };
  }, [step, settled, card]);

  useEffect(() => { card.current?.querySelector<HTMLElement>("[data-tour-next]")?.focus({ preventScroll: true }); }, [step.id, card]);
  const target = geometry?.target;
  const position = geometry?.card;
  const point = cursor ?? (target ? { left: target.left + Math.min(target.width / 2, 130), top: target.top + Math.min(target.height / 2, 65) } : null);
  const welcome = step.id === "welcome";
  const done = step.id === "finish";
  const Icon = ICONS[step.icon];
  const role = ROLES.find((item) => item.id === profile.role);
  return <div ref={layer} className="guided-tour" data-modal-layer="onboarding-tour" data-reduced={reduce || undefined} data-onboarding-tour={step.id} tabIndex={-1}
    onKeyDown={(event) => { if (event.key !== "Tab" && event.key !== "Escape") event.stopPropagation(); }}>
    {target ? <div className="tour-spotlight" aria-hidden style={{ left: target.left, top: target.top, width: target.width, height: target.height }} /> : <div className="tour-scrim" aria-hidden />}
    {point && !reduce ? <div className="tour-cursor" data-clicking={clicking || undefined} aria-hidden style={{ left: point.left, top: point.top }}><span className="tour-click-ring" /><MousePointer2 size={29} strokeWidth={1.6} /><span className="tour-cursor-label">Your guide</span></div> : null}
    <div ref={card} className="tour-card" data-anchored={Boolean(target) || undefined} role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-description" style={position ? { left: position.left, top: position.top, width: position.width } : undefined}>
      <div className="tour-card-top"><span className="tour-eyebrow"><span className="tour-brand-dot" />Ensemble / a quick tour</span><button type="button" className="tour-close" aria-label="Skip tour" onClick={onSkip}><X size={16} /></button></div>
      {(welcome || done) && <div className="tour-map" aria-hidden>
        <div className="tour-map-line" /><span className="tour-map-node tour-map-one"><CalendarDays size={20} /></span><span className="tour-map-node tour-map-two"><Columns3 size={20} /></span><span className="tour-map-node tour-map-three"><Users size={20} /></span><span className="tour-map-center">{done ? <CheckCheck size={30} /> : <Sparkles size={28} />}</span>
        <span className="tour-map-caption">{done ? "A good place to begin" : "A space that works like you"}</span>
      </div>}
      <div className="tour-copy" key={step.id}>
        <div className="tour-section-label"><Icon size={14} />{welcome && role ? `For you, ${role.label.toLowerCase() === "builder" ? "builder" : role.label.toLowerCase()}` : step.label}</div>
        <h2 id="tour-title">{welcome && name && !name.includes("@") && name !== "Local" ? `Welcome in, ${name}.` : step.title}</h2>
        <p id="tour-description">{step.body}</p>
        {welcome ? <div className="tour-welcome-details"><span><Check size={13} />{profile.template?.name ?? "Your own starting point"}</span><span>About 2 minutes · Go at your pace</span></div> : step.tip ? <div className={step.id === "assistant" || done ? "tour-tip tour-prompt" : "tour-tip"}>{step.id === "assistant" || done ? <Sparkles size={15} /> : <span className="tour-tip-dot" />}{step.tip}</div> : null}
      </div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">{step.title}. {step.body}</span>
      <div className="tour-progress" aria-label={`Step ${index + 1} of ${total}`}><div className="tour-progress-track"><span style={{ width: `${((index + 1) / total) * 100}%` }} /></div><span aria-live="polite" aria-atomic="true">{String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}</span></div>
      <div className="tour-actions"><button type="button" className="tour-secondary" onClick={index === 0 ? onSkip : onBack} disabled={moving}>{index === 0 ? "Maybe later" : <><ArrowLeft size={14} />Back</>}</button>
        <button type="button" className="tour-primary" data-tour-next disabled={moving} onClick={done ? () => onFinish(false) : onNext}>{moving ? "Showing you…" : done ? "Start on Today" : welcome ? "Show me around" : "Next"}{done ? <Check size={15} /> : <ArrowRight size={15} />}</button></div>
      {done ? <button type="button" className="tour-try-prompt" onClick={() => onFinish(true)}>Try my first question <ArrowRight size={13} /></button> : <p className="tour-footnote">{welcome ? "We'll open views together. Your work stays as it is." : "Esc to skip · Replay from your account menu"}</p>}
    </div>
  </div>;
}
