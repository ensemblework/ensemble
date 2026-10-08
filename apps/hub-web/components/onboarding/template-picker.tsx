"use client";

import { Check } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { OnboardingTemplateCard } from "@/lib/api";
import { TemplatePreview, type PreviewView } from "./template-preview";

/**
 * The template list and the live preview beside it. Signup (`/start`) and a new
 * Ensemble space (`/spaces/new`) both use these, so a template looks the same in both.
 */

const VIEWS: Array<[PreviewView, string]> = [
  ["today", "Today"],
  ["board", "Board"],
  ["context", "Context"],
];

function TemplateOption({ card, role, on, onPick }: { card: OnboardingTemplateCard; role: string; on: boolean; onPick: () => void }) {
  const thumb = useMemo(() => <TemplatePreview card={card} role={role} view="today" maxHeight={86} />, [card, role]);
  return (
    <button type="button" role="radio" aria-checked={on} data-template={card.id} className="onboard-template" onClick={onPick}>
      <span className="onboard-thumb">{thumb}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-ink">{card.name}</span>
        <span className="mt-0.5 block text-[12.5px] leading-[1.45] text-muted">{card.blurb}</span>
      </span>
    </button>
  );
}

export function TemplateList({
  cards,
  loading,
  role,
  selectedId,
  onPick,
}: {
  cards: OnboardingTemplateCard[];
  loading: boolean;
  role: string;
  selectedId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className="onboard-templates" role="radiogroup" aria-label="Templates">
      {loading ? Array.from({ length: 6 }, (_, index) => <div key={index} className="onboard-template skeleton" style={{ height: 76 }} />) : null}
      {cards.map((card) => (
        <TemplateOption key={card.id} card={card} role={role} on={selectedId === card.id} onPick={() => onPick(card.id)} />
      ))}
    </div>
  );
}

/** The right-hand pane: the selected template drawn live as Today, Board, or Context. */
export function TemplateStage({ card, role, kicker, empty }: { card: OnboardingTemplateCard | null; role: string; kicker: string; empty: ReactNode }) {
  const [view, setView] = useState<PreviewView>("today");
  return (
    <section className="onboard-stage" aria-label="Preview">
      {card ? (
        <div className="onboard-stage-inner">
          <div className="onboard-stage-head">
            <div className="min-w-0">
              <div className="text-[12px] text-faint">{kicker}</div>
              <div className="truncate text-[15px] font-medium text-ink">{card.name}</div>
            </div>
            <div className="onboard-views" role="tablist" aria-label="Preview view">
              {VIEWS.map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="onboard-canvas" key={`${card.id}-${view}`}>
            <TemplatePreview card={card} role={role} view={view} />
          </div>
          <ul className="onboard-features">
            {card.features.map((feature) => (
              <li key={feature}>
                <Check size={13} strokeWidth={2.4} />
                {feature}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="onboard-stage-empty">
          <div className="onboard-stage-ghost" aria-hidden="true">
            {Array.from({ length: 7 }, (_, index) => (
              <i key={index} />
            ))}
          </div>
          <p>{empty}</p>
        </div>
      )}
    </section>
  );
}
