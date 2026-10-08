"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DeskMini } from "@/components/desk/mini";
import { deskIdFromTemplate } from "@/components/desk/desks";
import { api } from "@/lib/api";
import type { GalleryCard } from "@/lib/market-cards";

const HEX: Record<string, string> = {
  indigo: "#7c6af7",
  tide: "#5dcec6",
  ember: "#f0a36a",
  rose: "#f0a0b8",
  brass: "#e4c56e",
  orchid: "#cf9cf2",
  moss: "#a9cc7e",
  sky: "#82b3f5",
};

function accentOf(card: GalleryCard): string {
  return HEX[card.accent ?? ""] ?? HEX.indigo!;
}

const PERSONAS = ["student", "researcher", "lawyer", "maker", "manager", "aspirant", "engineer", "teacher"] as const;

export function MarketplaceGallery({ cards, activeTemplateId }: { cards: GalleryCard[]; activeTemplateId: string | null }) {
  const router = useRouter();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const search = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [persona, setPersona] = useState<string | null>(null);
  const [codeOff, setCodeOff] = useState(false);
  const [cursor, setCursor] = useState(0);

  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    return cards.filter((card) => {
      if (persona && card.persona !== persona) return false;
      if (codeOff && !card.removes.includes("code")) return false;
      if (!query) return true;
      return `${card.name} ${card.blurb} ${card.persona}`.toLowerCase().includes(query);
    });
  }, [cards, q, persona, codeOff]);

  useEffect(() => {
    setCursor(0);
  }, [q, persona, codeOff]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (event.key === "/" && !typing) {
        event.preventDefault();
        search.current?.focus();
        return;
      }
      if (event.key === "Escape") {
        if (q || persona || codeOff) {
          setQ("");
          setPersona(null);
          setCodeOff(false);
          return;
        }
      }
      if (typing) return;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        setCursor((index) => Math.min(shown.length - 1, index + 1));
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((index) => Math.max(0, index - 1));
      }
      if (event.key === "Enter" && shown[cursor]) {
        event.preventDefault();
        router.push(`/marketplace/${shown[cursor].id}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [q, persona, codeOff, shown, cursor, router]);

  return (
    <div className="mx-auto min-w-0 max-w-[1180px] px-4 pb-24 pt-8 sm:px-10">
      <div className="text-[13px] text-muted">Templates</div>
      <h1 className="display mt-1 text-[32px] leading-none">A desk for the work you do</h1>
      <p className="mt-2 max-w-[42rem] text-[14px] text-muted">Eight desks, each built around the one thing its person watches. Your tasks, people and notes stay.</p>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <input
          ref={search}
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Search"
          aria-label="Search templates"
          className="field w-full sm:w-64"
        />
        <button type="button" className="btn" aria-pressed={codeOff} onClick={() => setCodeOff((on) => !on)}>
          Removes Code
        </button>
        {PERSONAS.map((id) => (
          <button key={id} type="button" className="btn" aria-pressed={persona === id} onClick={() => setPersona((current) => (current === id ? null : id))}>
            {id}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="mt-8 rounded-xl border border-line px-4 py-6">
          <p className="text-[15px]">Nothing matches.</p>
          <button type="button" className="btn mt-3" onClick={() => { setQ(""); setPersona(null); setCodeOff(false); }}>
            Clear
          </button>
        </div>
      ) : (
        <>
          {!q && !persona && !codeOff ? (
            <Hero cards={cards} activeId={shell.data?.activeTemplateId ?? activeTemplateId} />
          ) : null}
          <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {shown
              .filter((card) => q || persona || codeOff || !isHero(card.id, cards, shell.data?.activeTemplateId ?? activeTemplateId))
              .map((card, index) => (
                <CardLink key={card.id} card={card} current={index === cursor} onHover={() => setCursor(index)} />
              ))}
          </div>
        </>
      )}
    </div>
  );
}

function isHero(id: string, cards: GalleryCard[], activeId: string | null): boolean {
  const active = cards.find((card) => card.id === activeId) ?? null;
  const featuredId = active?.id === "mkt.chambers" ? "mkt.exam-season" : "mkt.chambers";
  return id === active?.id || id === featuredId;
}

function Hero({ cards, activeId }: { cards: GalleryCard[]; activeId: string | null }) {
  const active = cards.find((card) => card.id === activeId) ?? null;
  const featured = cards.find((card) => card.id === (active?.id === "mkt.chambers" ? "mkt.exam-season" : "mkt.chambers")) ?? cards[0];
  const pair = [active, featured].filter((card, index, list): card is GalleryCard => Boolean(card) && list.indexOf(card) === index);
  if (!pair.length) return null;
  return (
    <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
      {pair.map((card, index) => (
        <CardLink key={card.id} card={card} current={false} onHover={() => undefined} kicker={index === 0 && active ? "On now" : "Featured"} large />
      ))}
    </div>
  );
}

function CardLink({
  card,
  current,
  onHover,
  kicker,
  large = false,
}: {
  card: GalleryCard;
  current: boolean;
  onHover: () => void;
  kicker?: string;
  large?: boolean;
}) {
  const accent = accentOf(card);
  const titleId = `market-${card.id}`;
  return (
    <div
      data-market-card={card.id}
      className={`tile group relative block rounded-xl bg-panel p-3 motion-safe:transition motion-safe:duration-200 motion-safe:hover:-translate-y-0.5 ${current ? "ring-1 ring-accent" : ""}`}
      style={{ ["--card-accent" as string]: accent }}
      onMouseEnter={onHover}
    >
      <a
        href={`/marketplace/${card.id}`}
        aria-current={current ? "true" : undefined}
        aria-labelledby={titleId}
        className="absolute inset-0 z-0 rounded-xl"
      />
      <div className="pointer-events-none relative z-[1]">
        <DeskPreview card={card} accent={accent} large={large} />
        <div className="mt-3 flex items-baseline justify-between gap-2">
          <h2 id={titleId} className="text-[16px] font-medium">{card.name}</h2>
          <span className="text-[12px] capitalize text-muted">{kicker ?? card.persona}</span>
        </div>
        <p className="mt-1 text-[13px] leading-snug text-muted">{card.blurb}</p>
        {card.removes.length ? (
          <p className="mt-2 text-[12px] text-faint">Turns off {card.removes.join(", ")}</p>
        ) : (
          <p className="mt-2 text-[12px] text-faint">Every module stays on</p>
        )}
        {card.expiresInDays ? <p className="mt-1 text-[12px] text-faint">A {card.expiresInDays}-day season</p> : null}
      </div>
    </div>
  );
}

function DeskPreview({ card, accent, large }: { card: GalleryCard; accent: string; large?: boolean }) {
  const deskId = deskIdFromTemplate(card.id);
  if (deskId) {
    return (
      <div className="overflow-hidden rounded-lg" style={{ height: large ? 240 : 168 }}>
        <DeskMini deskId={deskId} width={large ? 640 : 420} height={large ? 240 : 168} head={Boolean(large)} />
      </div>
    );
  }
  return <DeskSketch card={card} accent={accent} large={large} />;
}

function DeskSketch({ card, accent, large }: { card: GalleryCard; accent: string; large?: boolean }) {
  const numeral = card.id.includes("prelims") ? "90" : card.id.includes("exam") ? "14" : card.id.includes("chambers") ? "10" : "";
  return (
    <div
      className={`relative overflow-hidden rounded-lg bg-bg ${large ? "aspect-[16/8]" : "aspect-[16/10]"}`}
      aria-hidden
      style={{ boxShadow: `inset 0 0 0 1px ${accent}33` }}
    >
      <div className="absolute inset-0 opacity-80 motion-safe:transition group-hover:opacity-100" style={{ background: `radial-gradient(120px 80px at 80% 20%, ${accent}33, transparent 70%)` }} />
      <div className="relative grid h-full grid-cols-12 gap-1 p-2">
        {card.preview.slice(0, 5).map((cell, index) => (
          <div
            key={index}
            className="flex flex-col justify-end overflow-hidden rounded-[5px] p-1"
            style={{
              gridColumn: `span ${Math.min(12, cell.w)}`,
              gridRow: `span ${Math.max(1, Math.round(cell.h / 2))}`,
              background: index === 0 ? `${accent}22` : "#00000033",
            }}
          >
            {index === 0 && numeral ? (
              <span className="text-[13px] font-medium leading-none" style={{ color: accent }}>
                {numeral}
              </span>
            ) : (
              <span className="h-1 w-2/3 rounded-full" style={{ background: `${accent}88` }} />
            )}
            <span className="mt-1 h-1 w-1/2 rounded-full bg-white/10" />
          </div>
        ))}
      </div>
      {card.id.includes("prelims") ? (
        <svg className="absolute right-2 top-2" width="36" height="36" viewBox="0 0 36 36" aria-hidden>
          <circle cx="18" cy="18" r="12" fill="none" stroke={accent} strokeOpacity="0.35" strokeWidth="3" />
          <circle cx="18" cy="18" r="12" fill="none" stroke={accent} strokeWidth="3" strokeDasharray="50 30" strokeLinecap="round" transform="rotate(-90 18 18)" />
        </svg>
      ) : null}
    </div>
  );
}
