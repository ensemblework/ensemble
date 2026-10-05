"use client";
/* Branded 404 / 500 / offline body. Import "./brand-pages.css" once (or paste it into globals.css). */
import Link from "next/link";
import { EnsembleMark } from "./Logo"; // copy logo/react/Logo.tsx to components/brand/Logo.tsx

const O = "M316 300 V540 A196 196 0 0 0 708 540 V300";
const I = "M426 300 V540 A86 86 0 0 0 598 540 V300";

export type BrandStatusKind = "404" | "500" | "offline";

const COPY: Record<BrandStatusKind, { code: string; h: string; p: string; art: string }> = {
  "404": {
    "code": "404",
    "h": "This thread doesn’t lead anywhere.",
    "p": "The page may have moved, or the link was cut short. Your work is where you left it.",
    "art": "The violet strand of the Ensemble mark, with the paper strand come loose beside it"
  },
  "500": {
    "code": "500 · error",
    "h": "We dropped a stitch.",
    "p": "Something broke on our side. Nothing you wrote is lost. Try again in a moment.",
    "art": "The Ensemble mark with its violet strand parted at the bottom"
  },
  "offline": {
    "code": "offline",
    "h": "You’re offline.",
    "p": "Ensemble will reconnect by itself as soon as the network is back. Anything you write now is kept on this device.",
    "art": "The Ensemble mark drawn in dots while waiting for the network"
  }
};

function Art({ kind }: { kind: BrandStatusKind }) {
  return (
    <svg className="ub-art" viewBox="196 208 820 608" role="img" aria-label={COPY[kind].art}>
      {kind === "404" ? (<><path className="ghost" d={I} /><path className="o" d={O} /><g className="loose"><path className="i" d={I} /></g></>) : null}
      {kind === "500" ? (<><g className="part-l"><path className="o" d="M316 300 V540 A196 196 0 0 0 464.6 730.2" /></g><g className="part-r"><path className="o" d="M559.4 730.2 A196 196 0 0 0 708 540 V300" /></g><path className="i" d={I} /></>) : null}
      {kind === "offline" ? (<><path className="ghost" d={O} /><path className="ghost" d={I} /><g className="dots"><path className="o" d={O} /><path className="i" d={I} /></g></>) : null}
    </svg>
  );
}

export function BrandStatus({ kind, reset, shell = false }: { kind: BrandStatusKind; reset?: () => void; shell?: boolean }) {
  const c = COPY[kind];
  const card = (
    <div className="ub-card">
      <Art kind={kind} />
      <p className="ub-code">{c.code}</p>
      <h1 className="ub-h">{c.h}</h1>
      <p className="ub-p">{c.p}</p>
      <div className="ub-act">
        {kind === "404" ? (<><Link className="ub-btn pri" href="/today">Go to Today</Link><button type="button" className="ub-btn" onClick={() => history.back()}>Go back</button></>) : null}
        {kind === "500" ? (<><button type="button" className="ub-btn pri" onClick={() => (reset ? reset() : location.reload())}>Try again</button><Link className="ub-btn" href="/today">Go to Today</Link></>) : null}
        {kind === "offline" ? <button type="button" className="ub-btn pri" onClick={() => location.reload()}>Try again</button> : null}
      </div>
    </div>
  );
  if (shell) {
    return (
      <div className="ub ub-shell">
        <div className="ub-main">{card}</div>
      </div>
    );
  }
  return (
    <div className="ub">
      <header className="ub-top">
        <Link className="ub-brand" href="/today" aria-label="Ensemble home"><EnsembleMark size={20} /><span>Ensemble</span></Link>
      </header>
      <main className="ub-main">{card}</main>
      <footer className="ub-foot">Ensemble · A shared workspace for you and your agent.</footer>
    </div>
  );
}
