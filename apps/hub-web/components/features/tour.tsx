"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { FEATURES } from "@ensemble/shared-types/features";
import { OPTIONAL_MODULES, hasModule, type OptionalModule } from "@ensemble/shared-types/modules";
import { isWidgetId, WIDGET_REGISTRY, type WidgetId } from "@ensemble/shared-types/widgets";
import { api } from "@/lib/api";
import { appendDeskTile } from "@/lib/desk-added";

type Step = { kind: "intro" } | { kind: "tile"; id: WidgetId } | { kind: "note" };

function stepsFor(id: OptionalModule): Step[] {
  const starters = FEATURES[id].starters.filter((item): item is WidgetId => isWidgetId(item));
  if (starters.length === 0) return [{ kind: "note" }];
  return [{ kind: "intro" }, ...starters.map((widgetId) => ({ kind: "tile" as const, id: widgetId }))];
}

export function FeatureTour() {
  const client = useQueryClient();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const [feature, setFeatureId] = useState<OptionalModule | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (!id || !(OPTIONAL_MODULES as readonly string[]).includes(id)) return;
      setFeatureId(id as OptionalModule);
      setStep(0);
      setError("");
      setBusy(false);
    };
    window.addEventListener("ensemble:feature-tour", open);
    return () => window.removeEventListener("ensemble:feature-tour", open);
  }, []);

  useEffect(() => {
    if (!feature || !shell.data) return;
    if (!hasModule(shell.data.modules, feature)) setFeatureId(null);
  }, [feature, shell.data]);

  const steps = feature ? stepsFor(feature) : [];
  const current = steps[step];

  const close = () => {
    setFeatureId(null);
    setStep(0);
    setBusy(false);
    setError("");
  };

  const advance = () => {
    setError("");
    if (step >= steps.length - 1) close();
    else setStep((index) => index + 1);
  };

  useEffect(() => {
    if (!feature) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [feature]);

  if (!feature || !current) return null;
  const copy = FEATURES[feature];
  const place = async (id: WidgetId) => {
    setBusy(true);
    setError("");
    try {
      await appendDeskTile(client, id);
      setBusy(false);
      advance();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const tile = current.kind === "tile" ? WIDGET_REGISTRY[current.id] : null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Starter tiles"
        data-feature-tour={feature}
        data-tour-step={current.kind === "tile" ? current.id : current.kind}
        className="relative w-[min(440px,calc(100%-1rem))] rounded-2xl border border-line-strong bg-panel p-6 shadow-pop"
        style={{ animation: "pop-in var(--m-dur-ui) var(--m-ease-enter) both", boxShadow: "var(--elev-2)" }}
      >
        <button type="button" className="icon-btn absolute right-3 top-3" aria-label="Close" onClick={close}>
          <X size={16} />
        </button>
        <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-faint">Starter tiles</p>
        {current.kind === "intro" ? (
          <>
            <h2 className="mt-2 text-[22px] font-semibold leading-tight">{copy.label} is on</h2>
            <p className="mt-2 text-[14px] leading-6 text-muted">{copy.line}</p>
            <p className="mt-2 text-[14px] leading-6 text-muted">
              A few tiles fit this: {copy.starters.filter(isWidgetId).map((id) => WIDGET_REGISTRY[id].label).join(", ")}. Show suggestions walks through placing each one. Not now leaves them off.
            </p>
          </>
        ) : null}
        {current.kind === "note" ? (
          <>
            <h2 className="mt-2 text-[22px] font-semibold leading-tight">{copy.label} is on</h2>
            <p className="mt-2 text-[14px] leading-6 text-muted">{copy.line}</p>
            <p className="mt-2 text-[14px] leading-6 text-muted">There&apos;s no starter tile for this. The tab is already in the sidebar.</p>
          </>
        ) : null}
        {current.kind === "tile" && tile ? (
          <>
            <h2 className="mt-2 text-[22px] font-semibold leading-tight">{tile.label}</h2>
            <p className="mt-2 text-[14px] leading-6 text-muted">{tile.blurb ?? tile.label}</p>
            <p className="mt-2 text-[13px] text-faint">
              Suggestion {step} of {steps.length - 1}. Place adds it to Today. Not now keeps what you already placed.
            </p>
          </>
        ) : null}
        {error ? <p className="mt-3 text-[13px] text-danger">{error}</p> : null}
        <div className="mt-5 flex flex-wrap gap-2">
          {current.kind === "intro" ? (
            <button type="button" className="btn-primary" disabled={busy} onClick={advance}>
              Show suggestions
            </button>
          ) : null}
          {current.kind === "tile" ? (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void place(current.id)}>
              {busy ? "Placing…" : "Place"}
            </button>
          ) : null}
          <button type="button" className="btn" disabled={busy} onClick={close}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
